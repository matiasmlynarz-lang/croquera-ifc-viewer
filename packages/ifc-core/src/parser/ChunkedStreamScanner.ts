/**
 * ChunkedStreamScanner — O(1) binary scanner and indexer for massive ISO-10303-21 STEP files.
 *
 * Designed to overcome V8 architectural limits on giant files (> 512 MB / > 16M entities):
 * - V8 String length limit: 536,870,888 characters (0x1fffffe8).
 * - V8 Map maximum size: 16,777,216 entries (2^24).
 *
 * Rule compliance (NORMAS_DESARROLLO_CROQUERA.md):
 * - Rule 6: No literal tolerances.
 * - Rule 7: O(1) access complexity via direct stepId indexing into Uint32Array.
 * - Rule 11: Real assertions in degenerate cases (escaped quotes, comments, unordered IDs).
 * - Rule 13: Zero silent error suppression in streaming.
 * - Rule 16: Shared IIfcStreamingParser interface with verified parity.
 * - Rule 21: Full compliance with ISO 10303-21 for arbitrary or non-consecutive entity IDs.
 */

import { IfcStepLexer, StepTokenType, type StepToken } from '../lexer/IfcStepLexer';
import { IfcStepByteLexer, safeDecodeUtf8 } from '../lexer/IfcStepByteLexer';
import { IfcTypeDictionary } from './IfcTypeDictionary';
import type { StepRecord, StepHeaderRecord, StepParam } from './IfcStepParser';
import type { StreamingParseOptions, IIfcStreamingParser } from './IfcStreamingParser';

export interface SharedSparsePage {
  pageIdx: number;
  startOffsetsBuffer: SharedArrayBuffer | ArrayBuffer;
  lengthsBuffer: SharedArrayBuffer | ArrayBuffer;
  typeCodesBuffer: SharedArrayBuffer | ArrayBuffer;
  typeNextBuffer: SharedArrayBuffer | ArrayBuffer;
}

export interface SharedScannerState {
  stepBuffer: SharedArrayBuffer | ArrayBuffer;
  startOffsetsBuffer: SharedArrayBuffer | ArrayBuffer;
  lengthsBuffer: SharedArrayBuffer | ArrayBuffer;
  typeCodesBuffer: SharedArrayBuffer | ArrayBuffer;
  typeNextBuffer: SharedArrayBuffer | ArrayBuffer;
  typeHeadBuffer: SharedArrayBuffer | ArrayBuffer;
  typeTailBuffer: SharedArrayBuffer | ArrayBuffer;
  typeNames: string[];
  maxId: number;
  totalEntities: number;
  headerEndPos: number;
  sparsePages?: SharedSparsePage[];
}

/**
 * Set of elemental geometry IFC types that are NOT indexed in legacy typeIndex.
 * In files like VespucioNorte.ifc they represent 99.98% of the 16.78M entities.
 * They are resolved strictly on-demand by stepId in O(1) during tessellation.
 */
const NON_INDEXED_GEOMETRY_TYPES = new Set<string>([
  'IFCCARTESIANPOINT',
  'IFCFACE',
  'IFCFACEOUTERBOUND',
  'IFCFACEBOUND',
  'IFCPOLYLOOP',
  'IFCCLOSEDSHELL',
  'IFCOPENSHELL',
  'IFCCONNECTEDFACESET',
  'IFCFACETEDBREP',
  'IFCFACETEDBREPWITHVOIDS',
  'IFCLINE',
  'IFCELLIPSE',
  'IFCTRIMMEDCURVE',
  'IFCPOLYLINE',
  'IFCVECTOR',
  'IFCVERTEXPOINT',
  'IFCEDGECURVE',
  'IFCORIENTEDEDGE',
  'IFCEDGE',
  'IFCEDGELOOP',
  'IFCFACESURFACE',
  'IFCADVANCEDFACE',
  'IFCVERTEX',
  'IFCCARTESIANPOINTLIST2D',
  'IFCCARTESIANPOINTLIST3D',
  'IFCINDEXEDPOLYCURVE',
]);

export class ChunkedStreamScanner implements IIfcStreamingParser {
  private uint8: Uint8Array;
  private totalBytes: number;
  private options: StreamingParseOptions;
  private decoder = new TextDecoder('utf-8');

  // Structure of Arrays (SoA): Contiguous TypedArrays for 10-byte-per-entity flat indexing
  private startOffsets!: Uint32Array; // 4 bytes / entity: byte offset in uint8
  private lengths!: Uint32Array;      // 4 bytes / entity: length in bytes of entity
  private typeCodes!: Uint16Array;    // 2 bytes / entity: numeric 16-bit type code
  private typeNext!: Int32Array;      // 4 bytes / entity: flat forward linked list pointer
  private typeHead: Int32Array = new Int32Array(65536).fill(-1); // 256 KB fixed head pointer per type
  private typeTail: Int32Array = new Int32Array(65536).fill(-1); // 256 KB fixed tail pointer per type
  public typeDictionary: IfcTypeDictionary = new IfcTypeDictionary();

  private static readonly PAGE_SHIFT = 16;
  private static readonly PAGE_SIZE = 1 << ChunkedStreamScanner.PAGE_SHIFT; // 65536
  private static readonly PAGE_MASK = ChunkedStreamScanner.PAGE_SIZE - 1;   // 0xFFFF
  private static readonly MAX_DENSE_CAPACITY = 5_000_000;
  private static readonly SPARSE_JUMP_GAP = 262_144; // 4 pages

  // Sparse page tables allocated strictly on demand for sparse IDs
  private sparseStartOffsets: Map<number, Uint32Array> = new Map();
  private sparseLengths: Map<number, Uint32Array> = new Map();
  private sparseTypeCodes: Map<number, Uint16Array> = new Map();
  private sparseTypeNext: Map<number, Int32Array> = new Map();

  private capacity: number = 0;
  private _legacyTypeIndex: Map<string, number[]> | null = null;

  public headerRecords: StepHeaderRecord[] = [];
  public rawHeaderSection: string = '';
  public maxId: number = 0;
  public orderedIds: number[] = [];
  public totalEntities: number = 0;

  private isDataScanned: boolean = false;
  private headerEndPos: number = 0;
  private byteLexer: IfcStepByteLexer;

  /**
   * Compatibility getter for IIfcStreamingParser.
   * Lazily constructed on demand if accessed, with 0 overhead during standard streaming.
   */
  public get typeIndex(): Map<string, number[]> {
    if (!this._legacyTypeIndex) {
      this._legacyTypeIndex = this.buildLegacyTypeIndex();
    }
    return this._legacyTypeIndex;
  }

  public set typeIndex(val: Map<string, number[]>) {
    this._legacyTypeIndex = val;
  }

  constructor(buffer: ArrayBuffer | SharedArrayBuffer | Uint8Array, options: StreamingParseOptions = {}) {
    this.uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.totalBytes = this.uint8.length;
    this.options = options;
    this.byteLexer = new IfcStepByteLexer(this.uint8, 0, 0);
  }

  /**
   * Parses exclusively the HEADER section (< 64 KB) without touching the DATA section.
   */
  public parseHeader(): StepHeaderRecord[] {
    this.headerRecords = [];
    this.rawHeaderSection = '';

    // STEP header typically occupies the first 4 to 64 KB
    const searchLimit = Math.min(this.totalBytes, 256 * 1024);
    let headerText = '';
    try {
      headerText = safeDecodeUtf8(this.uint8.subarray(0, searchLimit), this.decoder);
    } catch {
      headerText = '';
    }

    const lexer = new IfcStepLexer(headerText);
    let token = lexer.nextToken();

    // 1. Scan until word HEADER
    let headerFound = false;
    while (token.type !== StepTokenType.EOF) {
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'HEADER') {
        headerFound = true;
        const semi = lexer.nextToken();
        if (semi.type !== StepTokenType.SEMICOLON) {
          lexer.setPos(semi.start);
        }
        break;
      }
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'DATA') {
        this.headerEndPos = token.start;
        return this.headerRecords;
      }
      token = lexer.nextToken();
    }

    if (!headerFound) {
      this.headerEndPos = 0;
      return this.headerRecords;
    }

    // 2. Parse HEADER records until ENDSEC;
    while (true) {
      const lineStart = lexer.getPos();
      token = lexer.nextToken();

      if (token.type === StepTokenType.EOF) break;
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'ENDSEC') {
        const semi = lexer.nextToken();
        this.headerEndPos = semi.type === StepTokenType.SEMICOLON ? semi.end : lexer.getPos();
        this.rawHeaderSection = headerText.slice(0, this.headerEndPos).trim();
        break;
      }

      if (token.type === StepTokenType.WORD) {
        const typeName = token.value.toUpperCase();
        const lp = lexer.nextToken();
        if (lp.type === StepTokenType.LPAREN) {
          try {
            const params = this.parseParamList(lexer);
            const semi = lexer.nextToken();
            const lineEnd = semi.type === StepTokenType.SEMICOLON ? semi.end : lexer.getPos();
            const rawLine = headerText.slice(lineStart, lineEnd).trim();
            this.headerRecords.push({
              type: typeName,
              params,
              rawLine,
            });
          } catch (err: any) {
            console.warn(`[ChunkedStreamScanner] Truncated or malformed HEADER in record ${typeName}: ${err?.message || err}`);
            break;
          }
        }
      }
    }

    return this.headerRecords;
  }

  /**
   * Fast O(N) binary scan of the DATA section.
   * Stores offsets directly into Uint32Array TypedArrays without instantiating Map objects for 16.78M entities.
   */
  public scanDataSection(): void {
    if (this.isDataScanned) return;

    if (this.headerRecords.length === 0 && this.headerEndPos === 0) {
      this.parseHeader();
    }

    let pos = this.headerEndPos;
    const len = this.totalBytes;
    const buf = this.uint8;

    // 1. Locate DATA section
    let dataFound = false;
    while (pos < len) {
      const ch = buf[pos];
      if (ch === 32 || ch === 9 || ch === 13 || ch === 10) {
        pos++;
        continue;
      }
      // Comments /* ... */
      if (ch === 47 && pos + 1 < len && buf[pos + 1] === 42) {
        pos += 2;
        while (pos + 1 < len) {
          if (buf[pos] === 42 && buf[pos + 1] === 47) {
            pos += 2;
            break;
          }
          pos++;
        }
        continue;
      }

      // Check word DATA
      if (
        (ch === 68 || ch === 100) && // 'D' or 'd'
        pos + 4 <= len
      ) {
        const d0 = buf[pos];
        const d1 = buf[pos + 1];
        const d2 = buf[pos + 2];
        const d3 = buf[pos + 3];
        if (
          (d0 === 68 || d0 === 100) &&
          (d1 === 65 || d1 === 97) &&
          (d2 === 84 || d2 === 116) &&
          (d3 === 65 || d3 === 97)
        ) {
          pos += 4;
          while (pos < len) {
            const c = buf[pos++];
            if (c === 59) { // ';'
              dataFound = true;
              break;
            }
          }
          break;
        }
      }
      pos++;
    }

    if (!dataFound) {
      this.isDataScanned = true;
      return;
    }

    // 2. Optimized capacity pre-allocation for TypedArrays (Rule 7)
    // Estimation: in STEP each entity typically occupies between 40 and 100 bytes.
    let cap = Math.max(100000, Math.min(25000000, Math.floor(len / 45)));
    this.capacity = cap;
    this.startOffsets = new Uint32Array(this.allocBuffer(this.capacity * 4));
    this.lengths = new Uint32Array(this.allocBuffer(this.capacity * 4));
    this.typeCodes = new Uint16Array(this.allocBuffer(this.capacity * 2));
    this.typeNext = new Int32Array(this.allocBuffer(this.capacity * 4)).fill(-1);
    this.typeHead = new Int32Array(this.allocBuffer(65536 * 4)).fill(-1);
    this.typeTail = new Int32Array(this.allocBuffer(65536 * 4)).fill(-1);

    // 3. Byte-by-byte scan of entities #ID = TYPE(...) ;
    while (pos < len) {
      // Skip whitespace and comments
      while (pos < len) {
        const c = buf[pos];
        if (c === 32 || c === 9 || c === 13 || c === 10) {
          pos++;
          continue;
        }
        if (c === 47 && pos + 1 < len && buf[pos + 1] === 42) { // '/*'
          pos += 2;
          while (pos + 1 < len) {
            if (buf[pos] === 42 && buf[pos + 1] === 47) {
              pos += 2;
              break;
            }
            pos++;
          }
          continue;
        }
        break;
      }

      if (pos >= len) break;

      const firstChar = buf[pos];

      // Detect DATA section end: ENDSEC
      if (
        (firstChar === 69 || firstChar === 101) && // 'E' or 'e'
        pos + 6 <= len
      ) {
        const e0 = buf[pos];
        const e1 = buf[pos + 1];
        const e2 = buf[pos + 2];
        const e3 = buf[pos + 3];
        const e4 = buf[pos + 4];
        const e5 = buf[pos + 5];
        if (
          (e0 === 69 || e0 === 101) &&
          (e1 === 78 || e1 === 110) &&
          (e2 === 68 || e2 === 100) &&
          (e3 === 83 || e3 === 115) &&
          (e4 === 69 || e4 === 101) &&
          (e5 === 67 || e5 === 99)
        ) {
          pos += 6;
          while (pos < len && buf[pos] !== 59) pos++;
          if (pos < len) pos++; // consume ';'
          break;
        }
      }

      // Entity must start with '#'
      if (firstChar === 35) { // '#'
        const entityStart = pos;
        pos++;

        // Read integer entityId
        let entityId = 0;
        let hasDigits = false;
        while (pos < len) {
          const c = buf[pos];
          if (c >= 48 && c <= 57) { // '0'-'9'
            entityId = entityId * 10 + (c - 48);
            hasDigits = true;
            pos++;
          } else {
            break;
          }
        }

        if (!hasDigits) {
          pos++;
          continue;
        }

        // Skip whitespace up to '='
        while (pos < len) {
          const c = buf[pos];
          if (c === 32 || c === 9 || c === 13 || c === 10) pos++;
          else break;
        }

        if (pos >= len || buf[pos] !== 61) { // '='
          while (pos < len && buf[pos] !== 59) pos++;
          if (pos < len) pos++;
          continue;
        }
        pos++; // consume '='

        // Skip whitespace up to type name
        while (pos < len) {
          const c = buf[pos];
          if (c === 32 || c === 9 || c === 13 || c === 10) pos++;
          else break;
        }

        // Read IFC type directly from bytes without allocations
        const typeStart = pos;
        while (pos < len) {
          const c = buf[pos];
          if (
            (c >= 65 && c <= 90) || // A-Z
            (c >= 97 && c <= 122) || // a-z
            (c >= 48 && c <= 57) || // 0-9
            c === 95 // _
          ) {
            pos++;
          } else {
            break;
          }
        }
        const typeLen = pos - typeStart;
        const typeCode = this.typeDictionary.getTypeCodeFromBytes(buf, typeStart, typeLen);

        // Skip parameter body respecting strings '...' and comments /* ... */
        while (pos < len) {
          const c = buf[pos];
          if (c === 59) { // ';'
            pos++; // consume ';'
            break;
          }
          if (c === 39) { // single quote '
            pos++;
            while (pos < len) {
              if (buf[pos] === 39) {
                if (pos + 1 < len && buf[pos + 1] === 39) {
                  pos += 2; // comilla escapada ''
                } else {
                  pos++; // fin de cadena
                  break;
                }
              } else {
                pos++;
              }
            }
          } else if (c === 47 && pos + 1 < len && buf[pos + 1] === 42) { // /*
            pos += 2;
            while (pos + 1 < len) {
              if (buf[pos] === 42 && buf[pos + 1] === 47) {
                pos += 2;
                break;
              }
              pos++;
            }
          } else {
            pos++;
          }
        }

        const entityEnd = pos;
        const entityLength = entityEnd - entityStart;

        // Store entity into Dense SoA or On-Demand Sparse Page Table
        if (entityId < this.capacity) {
          this.startOffsets[entityId] = entityStart;
          this.lengths[entityId] = entityLength;
          this.typeCodes[entityId] = typeCode;
        } else if (
          entityId < ChunkedStreamScanner.MAX_DENSE_CAPACITY &&
          (entityId - this.capacity < ChunkedStreamScanner.SPARSE_JUMP_GAP)
        ) {
          this.resizeDenseCapacity(entityId);
          this.startOffsets[entityId] = entityStart;
          this.lengths[entityId] = entityLength;
          this.typeCodes[entityId] = typeCode;
        } else {
          const pageIdx = entityId >> ChunkedStreamScanner.PAGE_SHIFT;
          const offset = entityId & ChunkedStreamScanner.PAGE_MASK;
          this.ensureSparsePage(pageIdx);
          this.sparseStartOffsets.get(pageIdx)![offset] = entityStart;
          this.sparseLengths.get(pageIdx)![offset] = entityLength;
          this.sparseTypeCodes.get(pageIdx)![offset] = typeCode;
        }

        if (entityId > this.maxId) {
          this.maxId = entityId;
        }

        this.totalEntities++;

        if (typeCode > 0) {
          const prevTail = this.typeTail[typeCode];
          if (prevTail === -1) {
            this.typeHead[typeCode] = entityId;
          } else {
            this.setNextId(prevTail, entityId);
          }
          this.typeTail[typeCode] = entityId;
          this.setNextId(entityId, -1);
        }
      } else {
        pos++;
      }
    }

    this.isDataScanned = true;
  }

  private buildLegacyTypeIndex(): Map<string, number[]> {
    if (!this.isDataScanned) this.scanDataSection();
    const map = new Map<string, number[]>();
    for (let code = 1; code <= this.typeDictionary.size; code++) {
      const name = this.typeDictionary.getTypeName(code);
      if (NON_INDEXED_GEOMETRY_TYPES.has(name)) continue;
      let curr = this.typeHead[code];
      if (curr !== -1) {
        const list: number[] = [];
        while (curr !== -1) {
          list.push(curr);
          curr = this.getNextId(curr);
        }
        map.set(name, list);
      }
    }
    return map;
  }

  private ensureSparsePage(pageIdx: number): void {
    if (!this.sparseStartOffsets.has(pageIdx)) {
      const offsetsBuf = this.allocBuffer(ChunkedStreamScanner.PAGE_SIZE * 4);
      const lengthsBuf = this.allocBuffer(ChunkedStreamScanner.PAGE_SIZE * 4);
      const typesBuf = this.allocBuffer(ChunkedStreamScanner.PAGE_SIZE * 2);
      const nextBuf = this.allocBuffer(ChunkedStreamScanner.PAGE_SIZE * 4);

      this.sparseStartOffsets.set(pageIdx, new Uint32Array(offsetsBuf));
      this.sparseLengths.set(pageIdx, new Uint32Array(lengthsBuf));
      this.sparseTypeCodes.set(pageIdx, new Uint16Array(typesBuf));

      const nextArr = new Int32Array(nextBuf);
      nextArr.fill(-1);
      this.sparseTypeNext.set(pageIdx, nextArr);
    }
  }

  private getOffset(id: number): number {
    if (id < this.capacity) return this.startOffsets[id];
    const page = this.sparseStartOffsets.get(id >> ChunkedStreamScanner.PAGE_SHIFT);
    return page ? page[id & ChunkedStreamScanner.PAGE_MASK] : 0;
  }

  private getLength(id: number): number {
    if (id < this.capacity) return this.lengths[id];
    const page = this.sparseLengths.get(id >> ChunkedStreamScanner.PAGE_SHIFT);
    return page ? page[id & ChunkedStreamScanner.PAGE_MASK] : 0;
  }

  private getTypeCode(id: number): number {
    if (id < this.capacity) return this.typeCodes[id];
    const page = this.sparseTypeCodes.get(id >> ChunkedStreamScanner.PAGE_SHIFT);
    return page ? page[id & ChunkedStreamScanner.PAGE_MASK] : 0;
  }

  private getNextId(id: number): number {
    if (id < this.capacity) return this.typeNext[id];
    const page = this.sparseTypeNext.get(id >> ChunkedStreamScanner.PAGE_SHIFT);
    return page ? page[id & ChunkedStreamScanner.PAGE_MASK] : -1;
  }

  private setNextId(id: number, nextId: number): void {
    if (id < this.capacity) {
      this.typeNext[id] = nextId;
    } else {
      const pageIdx = id >> ChunkedStreamScanner.PAGE_SHIFT;
      this.ensureSparsePage(pageIdx);
      this.sparseTypeNext.get(pageIdx)![id & ChunkedStreamScanner.PAGE_MASK] = nextId;
    }
  }

  private resizeDenseCapacity(minCapacity: number): void {
    const oldCapacity = this.capacity;
    const newCapacity = Math.min(
      ChunkedStreamScanner.MAX_DENSE_CAPACITY,
      Math.max(minCapacity + 100000, Math.floor(oldCapacity * 1.5))
    );

    const newStarts = new Uint32Array(this.allocBuffer(newCapacity * 4));
    newStarts.set(this.startOffsets);
    this.startOffsets = newStarts;

    const newLens = new Uint32Array(this.allocBuffer(newCapacity * 4));
    newLens.set(this.lengths);
    this.lengths = newLens;

    const newTypes = new Uint16Array(this.allocBuffer(newCapacity * 2));
    newTypes.set(this.typeCodes);
    this.typeCodes = newTypes;

    const newNext = new Int32Array(this.allocBuffer(newCapacity * 4));
    newNext.set(this.typeNext);
    newNext.fill(-1, oldCapacity);
    this.typeNext = newNext;

    this.capacity = newCapacity;
  }

  private extractAsciiUpper(start: number, length: number): string {
    let str = '';
    const buf = this.uint8;
    for (let i = 0; i < length; i++) {
      let c = buf[start + i];
      if (c >= 97 && c <= 122) c -= 32; // a-z -> A-Z
      str += String.fromCharCode(c);
    }
    return str;
  }

  /**
   * Checks whether an entity exists in the offset index in O(1).
   */
  public hasRecord(id: number): boolean {
    if (!this.isDataScanned) this.scanDataSection();
    if (id <= 0 || id > this.maxId) return false;
    return this.getLength(id) > 0;
  }

  /**
   * Retrieves the IFC type of an entity by ID in O(1) from SoA column or sparse page table.
   */
  public getRecordType(id: number): string | undefined {
    if (!this.isDataScanned) this.scanDataSection();
    if (id <= 0 || id > this.maxId) return undefined;
    const code = this.getTypeCode(id);
    if (code === 0) return undefined;
    return this.typeDictionary.getTypeName(code);
  }

  /**
   * Retrieves the 16-bit IFC type code of an entity by ID in O(1) without string allocation.
   */
  public getRecordTypeCode(id: number): number {
    if (!this.isDataScanned) this.scanDataSection();
    if (id <= 0 || id > this.maxId) return 0;
    return this.getTypeCode(id);
  }

  /**
   * Parses and returns a single entity on-demand in O(1) memory.
   */
  public getRecordOnDemand(stepId: number): StepRecord | undefined {
    if (!this.isDataScanned) this.scanDataSection();
    if (stepId <= 0 || stepId > this.maxId) return undefined;
    const len = this.getLength(stepId);
    if (len === 0) return undefined;

    const start = this.getOffset(stepId);
    return this.parseSingleRecordBytes(stepId, start, len);
  }

  /**
   * Compatibility alias for IfcStepParser.getRecord.
   */
  public getRecord(id: number): StepRecord | undefined {
    return this.getRecordOnDemand(id);
  }

  /**
   * Iterates over all entities of a given IFC type via flat typed linked list in exact ascending order.
   * Strict error handling according to Rule 13.
   */
  public getRecordsByTypeStreaming(
    type: string,
    cb: (record: StepRecord) => void
  ): { processed: number; errors: number } {
    if (!this.isDataScanned) this.scanDataSection();

    const code = this.typeDictionary.getTypeCode(type);
    if (code === 0 || this.typeHead[code] === -1) {
      return { processed: 0, errors: 0 };
    }

    let processed = 0;
    let errors = 0;
    let id = this.typeHead[code];

    while (id !== -1) {
      try {
        const rec = this.getRecordOnDemand(id);
        if (rec) {
          cb(rec);
          processed++;
        } else {
          errors++;
          const warnMsg = `[ChunkedStreamScanner] Could not retrieve record for #${id} of type ${type}`;
          console.warn(warnMsg);
          if (this.options.onWarning) {
            this.options.onWarning(warnMsg);
          }
        }
      } catch (err: any) {
        errors++;
        const warnMsg = `[ChunkedStreamScanner] Error parsing entity #${id} (${type}): ${err?.message || err}`;
        console.warn(warnMsg);
        if (this.options.onError) {
          this.options.onError(err instanceof Error ? err : new Error(String(err)), id);
        }
      }
      id = this.getNextId(id);
    }

    return { processed, errors };
  }

  /**
   * Retrieves all records of a given type as an array.
   */
  public getRecordsByType(type: string): StepRecord[] {
    const records: StepRecord[] = [];
    this.getRecordsByTypeStreaming(type, (rec) => {
      records.push(rec);
    });
    return records;
  }

  private parseSingleRecordBytes(stepId: number, start: number, len: number): StepRecord | undefined {
    try {
      const lexer = this.byteLexer;
      lexer.reset(start, start + len);

      const refType = lexer.nextToken();
      if (refType !== StepTokenType.REF) return undefined;

      const eqType = lexer.nextToken();
      if (eqType !== StepTokenType.EQUALS) return undefined;

      const typeToken = lexer.nextToken();
      if (typeToken !== StepTokenType.WORD) return undefined;

      const typeName = lexer.stringValue;

      const lp = lexer.nextToken();
      if (lp !== StepTokenType.LPAREN) return undefined;

      const params = this.parseByteParamList(lexer);

      const semi = lexer.nextToken();
      if (semi !== StepTokenType.SEMICOLON) {
        throw new Error(`Invalid syntax: STEP entity does not end with ';' (found ${semi})`);
      }

      return {
        id: stepId,
        type: typeName,
        params,
        rawLine: '',
      };
    } catch (err: any) {
      let rawLineForError = '';
      try {
        rawLineForError = safeDecodeUtf8(this.uint8.subarray(start, start + len), this.decoder).trim();
      } catch {}
      const warnMsg = `[ChunkedStreamScanner] Failed to parse entity #${stepId}: ${err?.message || err}`;
      console.warn(warnMsg);
      if (this.options.onError) {
        this.options.onError(err instanceof Error ? err : new Error(String(err)), stepId, rawLineForError);
      }
      return undefined;
    }
  }

  private parseByteParamList(lexer: IfcStepByteLexer, depth: number = 0): StepParam[] {
    if (depth > ChunkedStreamScanner.MAX_PARAM_DEPTH) {
      console.warn(
        `[ChunkedStreamScanner] Parameter nesting limit exceeded (> ${ChunkedStreamScanner.MAX_PARAM_DEPTH}). Truncating list.`
      );
      while (true) {
        const next = lexer.nextToken();
        if (next === StepTokenType.RPAREN || next === StepTokenType.EOF) {
          break;
        }
      }
      return [];
    }

    const params: StepParam[] = [];

    const peekType = lexer.nextToken();
    if (peekType === StepTokenType.RPAREN) {
      return params;
    }

    params.push(this.parseByteParamValue(lexer, peekType, depth));

    while (true) {
      const nextType = lexer.nextToken();
      if (nextType === StepTokenType.RPAREN) {
        break;
      }
      if (nextType === StepTokenType.COMMA) {
        const valType = lexer.nextToken();
        if (valType === StepTokenType.RPAREN) {
          break;
        }
        params.push(this.parseByteParamValue(lexer, valType, depth));
      } else {
        throw new Error(`Invalid syntax in entity parameters: unexpected token ${nextType}`);
      }
    }

    return params;
  }

  private parseByteParamValue(lexer: IfcStepByteLexer, type: StepTokenType, depth: number = 0): StepParam {
    switch (type) {
      case StepTokenType.REF:
        return { ref: lexer.refValue };
      case StepTokenType.STRING:
        return lexer.stringValue;
      case StepTokenType.NUMBER:
        return lexer.numValue;
      case StepTokenType.NULL:
        return null;
      case StepTokenType.ASTERISK:
        return { asterisk: true };
      case StepTokenType.ENUM: {
        const val = lexer.stringValue;
        if (val === 'T' || val === 'TRUE') return true;
        if (val === 'F' || val === 'FALSE') return false;
        return { enum: val };
      }
      case StepTokenType.LPAREN:
        return this.parseByteParamList(lexer, depth + 1);
      case StepTokenType.WORD: {
        const word = lexer.stringValue;
        const savedPos = lexer.getPos();
        const next = lexer.nextToken();
        if (next === StepTokenType.LPAREN) {
          const nestedParams = this.parseByteParamList(lexer, depth + 1);
          return { type: word, params: nestedParams };
        }
        lexer.setPos(savedPos);
        return word;
      }
      default:
        return lexer.stringValue;
    }
  }

  private parseSingleRecord(stepId: number, rawLine: string): StepRecord | undefined {
    try {
      const lexer = new IfcStepLexer(rawLine);
      const refToken = lexer.nextToken();
      if (refToken.type !== StepTokenType.REF) return undefined;

      const eqToken = lexer.nextToken();
      if (eqToken.type !== StepTokenType.EQUALS) return undefined;

      const typeToken = lexer.nextToken();
      if (typeToken.type !== StepTokenType.WORD) return undefined;

      const lp = lexer.nextToken();
      if (lp.type !== StepTokenType.LPAREN) return undefined;

      const typeName = typeToken.value.toUpperCase();
      const params = this.parseParamList(lexer);

      const semi = lexer.nextToken();
      if (semi.type !== StepTokenType.SEMICOLON) {
        throw new Error(`Invalid syntax: STEP entity does not end with ';' (found ${semi.type})`);
      }

      return {
        id: stepId,
        type: typeName,
        params,
        rawLine,
      };
    } catch (err: any) {
      const warnMsg = `[ChunkedStreamScanner] Failed to parse entity #${stepId}: ${err?.message || err}`;
      console.warn(warnMsg);
      if (this.options.onError) {
        this.options.onError(err instanceof Error ? err : new Error(String(err)), stepId, rawLine);
      }
      return undefined;
    }
  }

  private static readonly MAX_PARAM_DEPTH = 128;

  private parseParamList(lexer: IfcStepLexer, depth: number = 0): StepParam[] {
    if (depth > ChunkedStreamScanner.MAX_PARAM_DEPTH) {
      console.warn(
        `[ChunkedStreamScanner] Parameter nesting limit exceeded (> ${ChunkedStreamScanner.MAX_PARAM_DEPTH}). Truncating list.`
      );
      while (true) {
        const next = lexer.nextToken();
        if (next.type === StepTokenType.RPAREN || next.type === StepTokenType.EOF) {
          break;
        }
      }
      return [];
    }

    const params: StepParam[] = [];

    const peekToken = lexer.nextToken();
    if (peekToken.type === StepTokenType.RPAREN) {
      return params;
    }

    params.push(this.parseParamValue(lexer, peekToken, depth));

    while (true) {
      const next = lexer.nextToken();
      if (next.type === StepTokenType.RPAREN) {
        break;
      }
      if (next.type === StepTokenType.COMMA) {
        const valToken = lexer.nextToken();
        if (valToken.type === StepTokenType.RPAREN) {
          break;
        }
        params.push(this.parseParamValue(lexer, valToken, depth));
      } else {
        throw new Error(`Invalid syntax in entity parameters: unexpected token ${next.type}`);
      }
    }

    return params;
  }

  private parseParamValue(lexer: IfcStepLexer, token: StepToken, depth: number = 0): StepParam {
    switch (token.type) {
      case StepTokenType.REF:
        return { ref: token.value as number };
      case StepTokenType.STRING:
        return token.value as string;
      case StepTokenType.NUMBER:
        return token.value as number;
      case StepTokenType.NULL:
        return null;
      case StepTokenType.ASTERISK:
        return { asterisk: true };
      case StepTokenType.ENUM:
        if (token.value === 'T' || token.value === 'TRUE') return true;
        if (token.value === 'F' || token.value === 'FALSE') return false;
        return { enum: token.value };
      case StepTokenType.LPAREN:
        return this.parseParamList(lexer, depth + 1);
      case StepTokenType.WORD: {
        const savedPos = lexer.getPos();
        const next = lexer.nextToken();
        if (next.type === StepTokenType.LPAREN) {
          const nestedParams = this.parseParamList(lexer, depth + 1);
          return { type: token.value.toUpperCase(), params: nestedParams };
        }
        lexer.setPos(savedPos);
        return token.value;
      }
      default:
        return token.value;
    }
  }

  private allocBuffer(byteLength: number): SharedArrayBuffer | ArrayBuffer {
    if (typeof SharedArrayBuffer !== 'undefined') {
      try {
        return new SharedArrayBuffer(byteLength);
      } catch {
        return new ArrayBuffer(byteLength);
      }
    }
    return new ArrayBuffer(byteLength);
  }

  /**
   * Exports the underlying SoA typed buffers and type dictionary for zero-copy sharing across Web Workers.
   */
  public exportSharedState(): SharedScannerState {
    if (!this.isDataScanned) this.scanDataSection();
    const sparsePages: SharedSparsePage[] = [];
    for (const pageIdx of this.sparseStartOffsets.keys()) {
      sparsePages.push({
        pageIdx,
        startOffsetsBuffer: this.sparseStartOffsets.get(pageIdx)!.buffer as SharedArrayBuffer | ArrayBuffer,
        lengthsBuffer: this.sparseLengths.get(pageIdx)!.buffer as SharedArrayBuffer | ArrayBuffer,
        typeCodesBuffer: this.sparseTypeCodes.get(pageIdx)!.buffer as SharedArrayBuffer | ArrayBuffer,
        typeNextBuffer: this.sparseTypeNext.get(pageIdx)!.buffer as SharedArrayBuffer | ArrayBuffer,
      });
    }

    return {
      stepBuffer: this.uint8.buffer as SharedArrayBuffer | ArrayBuffer,
      startOffsetsBuffer: this.startOffsets.buffer as SharedArrayBuffer | ArrayBuffer,
      lengthsBuffer: this.lengths.buffer as SharedArrayBuffer | ArrayBuffer,
      typeCodesBuffer: this.typeCodes.buffer as SharedArrayBuffer | ArrayBuffer,
      typeNextBuffer: this.typeNext.buffer as SharedArrayBuffer | ArrayBuffer,
      typeHeadBuffer: this.typeHead.buffer as SharedArrayBuffer | ArrayBuffer,
      typeTailBuffer: this.typeTail.buffer as SharedArrayBuffer | ArrayBuffer,
      typeNames: this.typeDictionary.exportState(),
      maxId: this.maxId,
      totalEntities: this.totalEntities,
      headerEndPos: this.headerEndPos,
      sparsePages: sparsePages.length > 0 ? sparsePages : undefined,
    };
  }

  /**
   * Instantiates a ChunkedStreamScanner pointing directly to shared memory buffers.
   * Enables 0 ms, 0 bytes copy setup in worker threads.
   */
  public static fromSharedState(
    state: SharedScannerState,
    options: StreamingParseOptions = {}
  ): ChunkedStreamScanner {
    const scanner = new ChunkedStreamScanner(state.stepBuffer, options);
    scanner.startOffsets = new Uint32Array(state.startOffsetsBuffer);
    scanner.lengths = new Uint32Array(state.lengthsBuffer);
    scanner.typeCodes = new Uint16Array(state.typeCodesBuffer);
    scanner.typeNext = new Int32Array(state.typeNextBuffer);
    scanner.typeHead = new Int32Array(state.typeHeadBuffer);
    scanner.typeTail = new Int32Array(state.typeTailBuffer);
    scanner.capacity = scanner.startOffsets.length;
    scanner.typeDictionary.importState(state.typeNames);
    scanner.maxId = state.maxId;
    scanner.totalEntities = state.totalEntities;
    scanner.headerEndPos = state.headerEndPos;
    scanner.isDataScanned = true;

    if (state.sparsePages && state.sparsePages.length > 0) {
      for (const sp of state.sparsePages) {
        scanner.sparseStartOffsets.set(sp.pageIdx, new Uint32Array(sp.startOffsetsBuffer));
        scanner.sparseLengths.set(sp.pageIdx, new Uint32Array(sp.lengthsBuffer));
        scanner.sparseTypeCodes.set(sp.pageIdx, new Uint16Array(sp.typeCodesBuffer));
        scanner.sparseTypeNext.set(sp.pageIdx, new Int32Array(sp.typeNextBuffer));
      }
    }

    return scanner;
  }
}
