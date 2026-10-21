/**
 * IfcStreamingParser — Parser de flujo e indexación por offsets para archivos STEP ISO-10303-21.
 *
 * Diseñado para resolver OOM (Out-of-Memory) en archivos masivos (e.g. ElManzano.ifc con 7.1M entidades)
 * indexando únicamente los offsets de inicio/fin y tipo de cada entidad en O(N) sin instanciar
 * el árbol completo de objetos AST en memoria.
 *
 * Cumplimiento normativo (NORMAS_DESARROLLO_CROQUERA.md):
 * - Norma 6: Sin tolerancias literales.
 * - Norma 7: Complejidad acotada O(N) en escaneo lineal, O(1) de memoria por entidad bajo demanda.
 * - Norma 11: Cobertura de casos degenerados (archivo truncado, vacío, sin HEADER, entidad malformada).
 * - Norma 13: Cero supresión silenciosa de errores en streaming (D4).
 * - Norma 16: Paridad funcional con IfcStepParser verificada mediante tests (D5).
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
   * Parsea exclusivamente la sección HEADER (< 1 KB) sin tocar la sección DATA.
   */
  public parseHeader(): StepHeaderRecord[] {
    this.headerRecords = [];
    this.rawHeaderSection = '';

    const lexer = new IfcStepLexer(this.buffer);
    let token = lexer.nextToken();

    // 1. Escanear hasta la palabra HEADER
    let headerFound = false;
    while (token.type !== StepTokenType.EOF) {
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'HEADER') {
        headerFound = true;
        // Consumir ';' opcional tras HEADER
        const semi = lexer.nextToken();
        if (semi.type !== StepTokenType.SEMICOLON) {
          lexer.setPos(semi.start);
        }
        break;
      }
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'DATA') {
        // Archivo sin HEADER, saltar directo a DATA
        this.headerEndPos = token.start;
        return this.headerRecords;
      }
      token = lexer.nextToken();
    }

    if (!headerFound) {
      this.headerEndPos = 0;
      return this.headerRecords;
    }

    // 2. Parsear registros del HEADER hasta ENDSEC;
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
            console.warn(`[IfcStreamingParser] Cabecera HEADER truncada o malformada en registro ${typeName}: ${err?.message || err}`);
            break;
          }
        }
      }
    }

    return this.headerRecords;
  }

  /**
   * Escaneo rápido O(N) de la sección DATA.
   * Construye el índice de offsets y el índice por tipo sin crear objetos AST para los parámetros.
   */
  public scanDataSection(): void {
    if (this.isDataScanned) return;

    if (this.headerRecords.length === 0 && this.headerEndPos === 0) {
      this.parseHeader();
    }

    let pos = this.headerEndPos;
    const len = this.length;
    const buf = this.buffer;

    // 1. Localizar la sección DATA
    let dataFound = false;
    while (pos < len) {
      // Salto rápido de espacios
      const ch = buf.charCodeAt(pos);
      if (ch === 32 || ch === 9 || ch === 13 || ch === 10) {
        pos++;
        continue;
      }
      // Comentarios /* ... */
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

      // Comprobar palabra DATA
      if (
        (ch === 68 || ch === 100) && // 'D' o 'd'
        pos + 4 <= len &&
        buf.slice(pos, pos + 4).toUpperCase() === 'DATA'
      ) {
        pos += 4;
        // Consumir parámetros opcionales y el ';' final de DATA;
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

    // 2. Escaneo lineal de entidades #ID = TYPE(...) ;
    while (pos < len) {
      // Saltar espacios en blanco y comentarios
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

      // Detectar fin de sección DATA: ENDSEC
      if (
        (firstChar === 69 || firstChar === 101) && // 'E' o 'e'
        pos + 6 <= len &&
        buf.slice(pos, pos + 6).toUpperCase() === 'ENDSEC'
      ) {
        pos += 6;
        while (pos < len && buf.charCodeAt(pos) !== 59) pos++; // hasta ';'
        if (pos < len) pos++; // consumir ';'
        break;
      }

      // La entidad debe iniciar con '#'
      if (firstChar === 35) { // '#'
        const entityStart = pos;
        pos++;

        // Leer entityId entero
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
          // Carácter '#' huérfano o malformado
          pos++;
          continue;
        }

        // Saltar espacios hasta '='
        while (pos < len) {
          const c = buf.charCodeAt(pos);
          if (c === 32 || c === 9 || c === 13 || c === 10) pos++;
          else break;
        }

        if (pos >= len || buf.charCodeAt(pos) !== 61) { // '='
          // Entidad sintácticamente rota, saltar hasta el siguiente ';'
          while (pos < len && buf.charCodeAt(pos) !== 59) pos++;
          if (pos < len) pos++;
          continue;
        }
        pos++; // consumir '='

        // Saltar espacios hasta nombre del tipo
        while (pos < len) {
          const c = buf.charCodeAt(pos);
          if (c === 32 || c === 9 || c === 13 || c === 10) pos++;
          else break;
        }

        // Leer tipo IFC
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

        // Saltar cuerpo de parámetros respetando cadenas '...' y comentarios /* ... */
        while (pos < len) {
          const c = buf.charCodeAt(pos);
          if (c === 59) { // ';'
            pos++; // consumir ';'
            break;
          }
          if (c === 39) { // comilla simple '
            pos++;
            while (pos < len) {
              if (buf.charCodeAt(pos) === 39) {
                if (pos + 1 < len && buf.charCodeAt(pos + 1) === 39) {
                  pos += 2; // comilla escapada ''
                } else {
                  pos++; // fin de cadena
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
        // Carácter desconocido fuera de entidad, avanzar
        pos++;
      }
    }

    this.isDataScanned = true;
  }

  /**
   * Comprueba si una entidad existe en el índice de offsets.
   */
  public hasRecord(id: number): boolean {
    if (!this.isDataScanned) this.scanDataSection();
    return this.offsets.has(id);
  }

  /**
   * Obtiene el tipo IFC de una entidad por ID sin parsear sus parámetros.
   */
  public getRecordType(id: number): string | undefined {
    if (!this.isDataScanned) this.scanDataSection();
    return this.offsets.get(id)?.type;
  }

  /**
   * Parsea y devuelve una única entidad bajo demanda en O(1) de memoria.
   */
  public getRecordOnDemand(stepId: number): StepRecord | undefined {
    if (!this.isDataScanned) this.scanDataSection();
    const loc = this.offsets.get(stepId);
    if (!loc) return undefined;

    const rawLine = this.buffer.slice(loc.start, loc.end).trim();
    return this.parseSingleRecord(stepId, loc.type, rawLine);
  }

  /**
   * Alias de compatibilidad con IfcStepParser.getRecord.
   */
  public getRecord(id: number): StepRecord | undefined {
    return this.getRecordOnDemand(id);
  }

  /**
   * Itera sobre todas las entidades de un tipo IFC dado, emitiendo una a la vez vía callback.
   * Manejo estricto de errores según Norma 13 / Desviación D4: registra advertencias
   * detalladas sin suprimir fallos y contabiliza omisiones.
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
          const warnMsg = `[IfcStreamingParser] No se pudo recuperar el registro para #${id} de tipo ${upper}`;
          console.warn(warnMsg);
          if (this.options.onWarning) {
            this.options.onWarning(warnMsg);
          }
        }
      } catch (err: any) {
        errors++;
        const warnMsg = `[IfcStreamingParser] Error parseando entidad #${id} (${upper}): ${err?.message || err}`;
        console.warn(warnMsg);
        if (this.options.onError) {
          this.options.onError(err instanceof Error ? err : new Error(String(err)), id);
        }
      }
    }

    return { processed, errors };
  }

  /**
   * Obtiene todos los registros de un tipo como array (conveniente para tipos de baja cardinalidad
   * como IfcProject, IfcSite, IfcBuilding, IfcBuildingStorey, IfcSiUnit).
   */
  public getRecordsByType(type: string): StepRecord[] {
    const records: StepRecord[] = [];
    this.getRecordsByTypeStreaming(type, (rec) => {
      records.push(rec);
    });
    return records;
  }

  /**
   * Parsea una única línea de entidad STEP aislada.
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
        throw new Error(`Sintaxis inválida: entidad STEP no finaliza en ';' (se encontró ${semi.type})`);
      }

      return {
        id: stepId,
        type: typeName,
        params,
        rawLine,
      };
    } catch (err: any) {
      const warnMsg = `[IfcStreamingParser] Falló el parseo de entidad #${stepId} (${typeName}): ${err?.message || err}`;
      console.warn(warnMsg);
      if (this.options.onError) {
        this.options.onError(err instanceof Error ? err : new Error(String(err)), stepId, rawLine);
      }
      return undefined;
    }
  }

  private static readonly MAX_PARAM_DEPTH = 128;

  /**
   * Parsea una lista de parámetros de un registro STEP delimitada por comas hasta ')'.
   */
  private parseParamList(lexer: IfcStepLexer, depth: number = 0): StepParam[] {
    if (depth > IfcStreamingParser.MAX_PARAM_DEPTH) {
      console.warn(
        `[IfcStreamingParser] Límite de anidamiento de parámetros excedido (> ${IfcStreamingParser.MAX_PARAM_DEPTH}). Truncando lista.`
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
        throw new Error(`Sintaxis inválida en parámetros de entidad: token inesperado ${next.type}`);
      }
    }

    return params;
  }

  /**
   * Parsea un único valor de parámetro STEP.
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
 * OnDemandRecordMap — Mapa virtual de compatibilidad para IfcStepImporter.
 *
 * Implementa la interfaz Map<number, StepRecord> resolviendo entidades sobre demanda
 * a través de IfcStreamingParser con una caché local acotada para evitar saturación de memoria.
 */
export class OnDemandRecordMap extends Map<number, StepRecord> {
  private streamingParser: IIfcStreamingParser;
  private cache: Map<number, StepRecord> = new Map();
  private maxCacheSize: number;

  constructor(streamingParser: IIfcStreamingParser, maxCacheSize: number = 10000) {
    super();
    this.streamingParser = streamingParser;
    this.maxCacheSize = maxCacheSize;
  }

  public override get(key: number): StepRecord | undefined {
    let rec = this.cache.get(key);
    if (!rec) {
      rec = this.streamingParser.getRecordOnDemand(key);
      if (rec) {
        if (this.cache.size >= this.maxCacheSize) {
          const firstKey = this.cache.keys().next().value;
          if (firstKey !== undefined) {
            this.cache.delete(firstKey);
          }
        }
        this.cache.set(key, rec);
      }
    }
    return rec;
  }

  public override has(key: number): boolean {
    return this.cache.has(key) || this.streamingParser.hasRecord(key);
  }

  public override set(key: number, value: StepRecord): this {
    if (this.cache.size >= this.maxCacheSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
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
