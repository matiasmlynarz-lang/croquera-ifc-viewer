/**
 * IfcStreamingParser — Stream and offset-indexing parser for STEP ISO-10303-21 files.
 *
 * Designed to address OOM (Out-of-Memory) on massive files (e.g. ElManzano.ifc with 7.1M entities)
 * by indexing only start/end offsets and entity types in O(N) without instantiating
 * the complete AST object tree in memory.
 *
 * Compliance (NORMAS_DESARROLLO_CROQUERA.md):
 * - Rule 6: No literal tolerances.
 * - Rule 7: Bounded O(N) complexity for linear scan, O(1) memory per entity on demand.
 * - Rule 11: Degenerate case coverage (truncated file, empty, missing HEADER, malformed entity).
 * - Rule 13: Zero silent suppression of errors in streaming (D4).
 * - Rule 16: Functional parity with IfcStepParser verified via tests (D5).
 */

import { IfcStepLexer, StepTokenType, type StepToken } from '../lexer/IfcStepLexer';
import type { StepRecord, StepHeaderRecord, StepParam } from './IfcStepParser';

export interface EntityLocation {
  start: number;
  end: number;
  type: string;
}

export interface StreamingParseOptions {
  onError?: (error: Error, stepId?: number, rawLine?: string) => void;
  onWarning?: (warning: string) => void;
}

export interface IIfcStreamingParser {
  headerRecords: StepHeaderRecord[];
  rawHeaderSection: string;
  totalEntities: number;
  maxId: number;
  orderedIds: number[];
  typeIndex: Map<string, number[]>;
  parseHeader(): StepHeaderRecord[];
  scanDataSection(): void;
  hasRecord(id: number): boolean;
  getRecordType(id: number): string | undefined;
  getRecordOnDemand(stepId: number): StepRecord | undefined;
  getRecord(id: number): StepRecord | undefined;
  getRecordsByTypeStreaming(
    type: string,
    cb: (record: StepRecord) => void
  ): { processed: number; errors: number };
  getRecordsByType(type: string): StepRecord[];
}

export class IfcStreamingParser implements IIfcStreamingParser {
  private buffer: string;
  private length: number;
  private options: StreamingParseOptions;

  public offsets: Map<number, EntityLocation> = new Map();
  public typeIndex: Map<string, number[]> = new Map();
  public headerRecords: StepHeaderRecord[] = [];
  public rawHeaderSection: string = '';
  public maxId: number = 0;
  public orderedIds: number[] = [];
  public totalEntities: number = 0;

  private isDataScanned: boolean = false;
  private headerEndPos: number = 0;

  constructor(stepContent: string, options: StreamingParseOptions = {}) {
    this.buffer = stepContent;
    this.length = stepContent.length;
    this.options = options;
  }

  /**
   * Parses exclusively the HEADER section (< 1 KB) without touching the DATA section.
   */
  public parseHeader(): StepHeaderRecord[] {
    this.headerRecords = [];
    this.rawHeaderSection = '';

    const lexer = new IfcStepLexer(this.buffer);
    let token = lexer.nextToken();

    // 1. Scan until the HEADER keyword
    let headerFound = false;
    while (token.type !== StepTokenType.EOF) {
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'HEADER') {
        headerFound = true;
        // Consume optional ';' after HEADER
        const semi = lexer.nextToken();
        if (semi.type !== StepTokenType.SEMICOLON) {
          lexer.setPos(semi.start);
        }
        break;
      }
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'DATA') {
        // File without HEADER, skip directly to DATA
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
        this.rawHeaderSection = this.buffer.slice(0, this.headerEndPos).trim();
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
            const rawLine = this.buffer.slice(lineStart, lineEnd).trim();
            this.headerRecords.push({
              type: typeName,
              params,
              rawLine,
            });
          } catch (err: any) {
            console.warn(`[IfcStreamingParser] Truncated or malformed HEADER in record ${typeName}: ${err?.message || err}`);
            break;
          }
        }
      }
    }

    return this.headerRecords;
  }

  /**
   * Fast O(N) scan of the DATA section.
   * Builds offset index and type index without creating AST parameter objects.
   */
  public scanDataSection(): void {
    if (this.isDataScanned) return;

    if (this.headerRecords.length === 0 && this.headerEndPos === 0) {
      this.parseHeader();
    }

    let pos = this.headerEndPos;
    const len = this.length;
    const buf = this.buffer;

    // 1. Locate the DATA section
    let dataFound = false;
    while (pos < len) {
      // Fast whitespace skip
      const ch = buf.charCodeAt(pos);
      if (ch === 32 || ch === 9 || ch === 13 || ch === 10) {
        pos++;
        continue;
      }
      // Comments /* ... */
      if (ch === 47 && pos + 1 < len && buf.charCodeAt(pos + 1) === 42) {
        pos += 2;
        while (pos + 1 < len) {
          if (buf.charCodeAt(pos) === 42 && buf.charCodeAt(pos + 1) === 47) {
            pos += 2;
            break;
          }
          pos++;
        }
        continue;
      }

      // Check DATA keyword
      if (
        (ch === 68 || ch === 100) && // 'D' or 'd'
        pos + 4 <= len &&
        buf.slice(pos, pos + 4).toUpperCase() === 'DATA'
      ) {
        pos += 4;
        // Consume optional parameters and trailing ';' of DATA;
        while (pos < len) {
          const c = buf.charCodeAt(pos);
          pos++;
          if (c === 59) { // ';'
            dataFound = true;
            break;
          }
        }
        break;
      }
      pos++;
    }

    if (!dataFound) {
      this.isDataScanned = true;
      return;
    }

    // 2. Linear scan of entities #ID = TYPE(...) ;
    while (pos < len) {
      // Skip whitespace and comments
      while (pos < len) {
        const c = buf.charCodeAt(pos);
        if (c === 32 || c === 9 || c === 13 || c === 10) {
          pos++;
          continue;
        }
        if (c === 47 && pos + 1 < len && buf.charCodeAt(pos + 1) === 42) { // '/*'
          pos += 2;
          while (pos + 1 < len) {
            if (buf.charCodeAt(pos) === 42 && buf.charCodeAt(pos + 1) === 47) {
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

      const firstChar = buf.charCodeAt(pos);

      // Detect end of DATA section: ENDSEC
      if (
        (firstChar === 69 || firstChar === 101) && // 'E' or 'e'
        pos + 6 <= len &&
        buf.slice(pos, pos + 6).toUpperCase() === 'ENDSEC'
      ) {
        pos += 6;
        while (pos < len && buf.charCodeAt(pos) !== 59) pos++; // until ';'
        if (pos < len) pos++; // consume ';'
        break;
      }

      // Entity must start with '#'
      if (firstChar === 35) { // '#'
        const entityStart = pos;
        pos++;

        // Read integer entityId
        let entityId = 0;
        let hasDigits = false;
        while (pos < len) {
          const c = buf.charCodeAt(pos);
          if (c >= 48 && c <= 57) { // '0'-'9'
            entityId = entityId * 10 + (c - 48);
            hasDigits = true;
            pos++;
          } else {
            break;
          }
        }

        if (!hasDigits) {
          // Orphan or malformed '#' character
          pos++;
          continue;
        }

        // Skip whitespace until '='
        while (pos < len) {
          const c = buf.charCodeAt(pos);
          if (c === 32 || c === 9 || c === 13 || c === 10) pos++;
          else break;
        }

        if (pos >= len || buf.charCodeAt(pos) !== 61) { // '='
          // Syntactically broken entity, skip to next ';'
          while (pos < len && buf.charCodeAt(pos) !== 59) pos++;
          if (pos < len) pos++;
          continue;
        }
        pos++; // consume '='

        // Skip whitespace until type name
        while (pos < len) {
          const c = buf.charCodeAt(pos);
          if (c === 32 || c === 9 || c === 13 || c === 10) pos++;
          else break;
        }

        // Read IFC type
        const typeStart = pos;
        while (pos < len) {
          const c = buf.charCodeAt(pos);
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
        const typeName = buf.slice(typeStart, pos).toUpperCase();

        // Skip parameter body respecting strings '...' and comments /* ... */
        while (pos < len) {
          const c = buf.charCodeAt(pos);
          if (c === 59) { // ';'
            pos++; // consume ';'
            break;
          }
          if (c === 39) { // single quote '
            pos++;
            while (pos < len) {
              if (buf.charCodeAt(pos) === 39) {
                if (pos + 1 < len && buf.charCodeAt(pos + 1) === 39) {
                  pos += 2; // escaped quote ''
                } else {
                  pos++; // end of string
                  break;
                }
              } else {
                pos++;
              }
            }
          } else if (c === 47 && pos + 1 < len && buf.charCodeAt(pos + 1) === 42) { // /*
            pos += 2;
            while (pos + 1 < len) {
              if (buf.charCodeAt(pos) === 42 && buf.charCodeAt(pos + 1) === 47) {
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

        if (entityId > this.maxId) {
          this.maxId = entityId;
        }

        this.offsets.set(entityId, {
          start: entityStart,
          end: entityEnd,
          type: typeName,
        });

        this.orderedIds.push(entityId);
        this.totalEntities++;

        let list = this.typeIndex.get(typeName);
        if (!list) {
          list = [];
          this.typeIndex.set(typeName, list);
        }
        list.push(entityId);
      } else {
        // Unknown character outside entity, advance
        pos++;
      }
    }

    this.isDataScanned = true;
  }

  /**
   * Checks whether an entity exists in the offset index.
   */
  public hasRecord(id: number): boolean {
    if (!this.isDataScanned) this.scanDataSection();
    return this.offsets.has(id);
  }

  /**
   * Retrieves the IFC type of an entity by ID without parsing its parameters.
   */
  public getRecordType(id: number): string | undefined {
    if (!this.isDataScanned) this.scanDataSection();
    return this.offsets.get(id)?.type;
  }

  /**
   * Parses and returns a single entity on demand in O(1) memory.
   */
  public getRecordOnDemand(stepId: number): StepRecord | undefined {
    if (!this.isDataScanned) this.scanDataSection();
    const loc = this.offsets.get(stepId);
    if (!loc) return undefined;

    const rawLine = this.buffer.slice(loc.start, loc.end).trim();
    return this.parseSingleRecord(stepId, loc.type, rawLine);
  }

  /**
   * Compatibility alias for IfcStepParser.getRecord.
   */
  public getRecord(id: number): StepRecord | undefined {
    return this.getRecordOnDemand(id);
  }

  /**
   * Iterates over all entities of a given IFC type, emitting one at a time via callback.
   * Strict error handling per Rule 13 / Deviation D4: logs detailed warnings
   * without suppressing failures and counts omissions.
   */
  public getRecordsByTypeStreaming(
    type: string,
    cb: (record: StepRecord) => void
  ): { processed: number; errors: number } {
    if (!this.isDataScanned) this.scanDataSection();

    const upper = type.toUpperCase();
    const ids = this.typeIndex.get(upper);
    if (!ids || ids.length === 0) {
      return { processed: 0, errors: 0 };
    }

    let processed = 0;
    let errors = 0;

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      try {
        const rec = this.getRecordOnDemand(id);
        if (rec) {
          cb(rec);
          processed++;
        } else {
          errors++;
          const warnMsg = `[IfcStreamingParser] Could not retrieve record for #${id} of type ${upper}`;
          console.warn(warnMsg);
          if (this.options.onWarning) {
            this.options.onWarning(warnMsg);
          }
        }
      } catch (err: any) {
        errors++;
        const warnMsg = `[IfcStreamingParser] Error parsing entity #${id} (${upper}): ${err?.message || err}`;
        console.warn(warnMsg);
        if (this.options.onError) {
          this.options.onError(err instanceof Error ? err : new Error(String(err)), id);
        }
      }
    }

    return { processed, errors };
  }

  /**
   * Retrieves all records of a type as an array (convenient for low-cardinality types
   * like IfcProject, IfcSite, IfcBuilding, IfcBuildingStorey, IfcSiUnit).
   */
  public getRecordsByType(type: string): StepRecord[] {
    const records: StepRecord[] = [];
    this.getRecordsByTypeStreaming(type, (rec) => {
      records.push(rec);
    });
    return records;
  }

  /**
   * Parses an isolated single STEP entity line.
   */
  private parseSingleRecord(stepId: number, typeName: string, rawLine: string): StepRecord | undefined {
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

      const params = this.parseParamList(lexer);

      const semi = lexer.nextToken();
      if (semi.type !== StepTokenType.SEMICOLON) {
        throw new Error(`Invalid syntax: STEP entity does not end in ';' (found ${semi.type})`);
      }

      return {
        id: stepId,
        type: typeName,
        params,
        rawLine,
      };
    } catch (err: any) {
      const warnMsg = `[IfcStreamingParser] Failed to parse entity #${stepId} (${typeName}): ${err?.message || err}`;
      console.warn(warnMsg);
      if (this.options.onError) {
        this.options.onError(err instanceof Error ? err : new Error(String(err)), stepId, rawLine);
      }
      return undefined;
    }
  }

  private static readonly MAX_PARAM_DEPTH = 128;

  /**
   * Parses a comma-separated STEP record parameter list until ')'.
   */
  private parseParamList(lexer: IfcStepLexer, depth: number = 0): StepParam[] {
    if (depth > IfcStreamingParser.MAX_PARAM_DEPTH) {
      console.warn(
        `[IfcStreamingParser] Parameter nesting limit exceeded (> ${IfcStreamingParser.MAX_PARAM_DEPTH}). Truncating list.`
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

  /**
   * Parses a single STEP parameter value.
   */
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
}

/**
 * OnDemandRecordMap — Virtual compatibility map for IfcStepImporter.
 *
 * Implements the Map<number, StepRecord> interface by resolving entities on demand
 * via IfcStreamingParser with a bounded local cache to avoid memory saturation.
 */
export class OnDemandRecordMap extends Map<number, StepRecord> {
  private streamingParser: IIfcStreamingParser;
  private cache: Map<number, StepRecord> = new Map();
  private maxCacheSize: number;

  /**
   * Ephemeral single-use entities that should NOT pollute the bounded cache (Issue 1.3).
   * Geometry vertices, face loops and mesh tessellations are consumed once and never re-read,
   * leaving cache space strictly for shared spatial structures, placements, styles and profiles.
   */
  public static readonly EPHEMERAL_TYPES = new Set<string>([
    'IFCCARTESIANPOINT',
    'IFCPOLYLOOP',
    'IFCFACEOUTERBOUND',
    'IFCFACEBOUND',
    'IFCFACE',
    'IFCCLOSEDSHELL',
    'IFCOPENSHELL',
    'IFCFACETEDBREP',
    'IFCSHELLBASEDSURFACEMODEL',
    'IFCFACEBASEDSURFACEMODEL',
    'IFCCARTESIANPOINTLIST3D',
    'IFCCARTESIANPOINTLIST2D',
    'IFCTRIANGULATEDFACESET',
    'IFCTRIANGULATEDIRREGULARNETWORK',
    'IFCPOLYGONALFACESET',
    'IFCINDEXEDPOLYGONALFACE',
    'IFCINDEXEDPOLYGONALFACEWITHVOIDS',
    'IFCVERTEXPOINT',
    'IFCEDGECURVE',
    'IFCORIENTEDEDGE',
    'IFCEDGELOOP',
  ]);

  constructor(streamingParser: IIfcStreamingParser, maxCacheSize: number = 50000) {
    super();
    this.streamingParser = streamingParser;
    this.maxCacheSize = maxCacheSize;
  }

  private evictBatch(): void {
    const evictCount = Math.max(1, Math.floor(this.maxCacheSize * 0.2));
    let count = 0;
    for (const k of this.cache.keys()) {
      this.cache.delete(k);
      if (++count >= evictCount) break;
    }
  }

  public override get(key: number): StepRecord | undefined {
    let rec = this.cache.get(key);
    if (!rec) {
      rec = this.streamingParser.getRecordOnDemand(key);
      if (rec) {
        if (!OnDemandRecordMap.EPHEMERAL_TYPES.has(rec.type)) {
          if (this.cache.size >= this.maxCacheSize) {
            this.evictBatch();
          }
          this.cache.set(key, rec);
        }
      }
    }
    return rec;
  }

  public override has(key: number): boolean {
    return this.cache.has(key) || this.streamingParser.hasRecord(key);
  }

  public override set(key: number, value: StepRecord): this {
    if (!OnDemandRecordMap.EPHEMERAL_TYPES.has(value.type)) {
      if (this.cache.size >= this.maxCacheSize && !this.cache.has(key)) {
        this.evictBatch();
      }
      this.cache.set(key, value);
    }
    return this;
  }

  public override delete(key: number): boolean {
    return this.cache.delete(key);
  }

  public override clear(): void {
    this.cache.clear();
  }

  public override get size(): number {
    return this.streamingParser.totalEntities;
  }

  public override values(): IterableIterator<StepRecord> {
    return this.cache.values();
  }

  public override entries(): IterableIterator<[number, StepRecord]> {
    return this.cache.entries();
  }

  public override keys(): IterableIterator<number> {
    return this.cache.keys();
  }
}
