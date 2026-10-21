/**
 * IfcStepParser — Generador de grafo de entidades STEP y mapa de líneas originales.
 *
 * Parsea archivos ISO-10303-21 en memoria y mantiene la referencia textual exacta
 * de cada entidad (rawLine), lo que permite la exportación diferencial (delta patching)
 * sin pérdida de precisión ni de datos de terceros.
 */

import { IfcStepLexer, StepTokenType, type StepToken } from '../lexer/IfcStepLexer';

export type StepParam =
  | string
  | number
  | boolean
  | null
  | { ref: number }
  | { enum: string }
  | { asterisk: true }
  | { type: string; params: StepParam[] } // Tipos anidados como IFCLABEL('foo')
  | StepParam[];

export interface StepRecord {
  id: number;
  type: string;
  params: StepParam[];
  rawLine: string;
}

export interface StepHeaderRecord {
  type: string;
  params: StepParam[];
  rawLine: string;
}

export class IfcStepParser {
  private lexer: IfcStepLexer;
  private buffer: string;

  public records: Map<number, StepRecord> = new Map();
  public recordsByType: Map<string, StepRecord[]> = new Map();
  public headerRecords: StepHeaderRecord[] = [];
  public orderedIds: number[] = [];
  public maxId: number = 0;
  public rawHeaderSection: string = '';

  constructor(stepContent: string) {
    this.buffer = stepContent;
    this.lexer = new IfcStepLexer(stepContent);
  }

  /**
   * Parsea completamente el contenido STEP y construye las tablas de índices.
   */
  public parse(): void {
    let token = this.lexer.nextToken();

    // 1. Escanear hasta la sección HEADER o DATA
    while (token.type !== StepTokenType.EOF) {
      if (token.type === StepTokenType.WORD) {
        const word = token.value.toUpperCase();
        if (word === 'HEADER') {
          // Consumir ';'
          token = this.lexer.nextToken();
          this.parseHeader();
          const headerEnd = this.lexer.getPos();
          this.rawHeaderSection = this.buffer.slice(0, headerEnd).trim();
          break;
        } else if (word === 'DATA') {
          // Archivo sin HEADER, entrar directamente a DATA
          const next = this.lexer.nextToken();
          if (next.type !== StepTokenType.SEMICOLON) {
            // Continuar
          }
          this.parseData();
          return;
        }
      }
      token = this.lexer.nextToken();
    }

    // 2. Escanear hasta la sección DATA si aún no se ha parseado
    token = this.lexer.nextToken();
    while (token.type !== StepTokenType.EOF) {
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'DATA') {
        const next = this.lexer.nextToken();
        if (next.type !== StepTokenType.SEMICOLON) {
          // Continuar
        }
        this.parseData();
        break;
      }
      token = this.lexer.nextToken();
    }
  }

  /**
   * Parsea la sección HEADER.
   */
  private parseHeader(): void {
    while (true) {
      const lineStart = this.lexer.getPos();
      const token = this.lexer.nextToken();

      if (token.type === StepTokenType.EOF) break;
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'ENDSEC') {
        // Consumir ';'
        this.lexer.nextToken();
        break;
      }

      if (token.type === StepTokenType.WORD) {
        const typeName = token.value.toUpperCase();
        // Esperar '('
        const lp = this.lexer.nextToken();
        if (lp.type === StepTokenType.LPAREN) {
          const params = this.parseParamList();
          // Esperar ';'
          const semi = this.lexer.nextToken();
          const lineEnd = semi.end;
          const rawLine = this.buffer.slice(lineStart, lineEnd).trim();
          this.headerRecords.push({
            type: typeName,
            params,
            rawLine,
          });
        }
      }
    }
  }

  /**
   * Parsea la sección DATA (#id = TYPE(params);).
   */
  private parseData(): void {
    while (true) {
      const lineStart = this.lexer.getPos();
      const token = this.lexer.nextToken();

      if (token.type === StepTokenType.EOF) break;
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'ENDSEC') {
        // Consumir ';'
        this.lexer.nextToken();
        break;
      }

      if (token.type === StepTokenType.REF) {
        const entityId = token.value as number;
        if (entityId > this.maxId) {
          this.maxId = entityId;
        }

        // Esperar '='
        const eq = this.lexer.nextToken();
        if (eq.type !== StepTokenType.EQUALS) continue;

        // Esperar nombre de tipo (ej. IFCWALL)
        const typeToken = this.lexer.nextToken();
        if (typeToken.type !== StepTokenType.WORD) continue;
        const typeName = typeToken.value.toUpperCase();

        // Esperar '('
        const lp = this.lexer.nextToken();
        if (lp.type !== StepTokenType.LPAREN) continue;

        const params = this.parseParamList();

        // Esperar ';'
        const semi = this.lexer.nextToken();
        const lineEnd = semi.type === StepTokenType.SEMICOLON ? semi.end : this.lexer.getPos();

        const rawLine = this.buffer.slice(lineStart, lineEnd).trim();

        const record: StepRecord = {
          id: entityId,
          type: typeName,
          params,
          rawLine,
        };

        this.records.set(entityId, record);
        this.orderedIds.push(entityId);

        let byType = this.recordsByType.get(typeName);
        if (!byType) {
          byType = [];
          this.recordsByType.set(typeName, byType);
        }
        byType.push(record);
      }
    }
  }

  private static readonly MAX_PARAM_DEPTH = 128;

  /**
   * Parsea una lista de parámetros delimitada por comas hasta encontrar ')'.
   */
  private parseParamList(depth: number = 0): StepParam[] {
    if (depth > IfcStepParser.MAX_PARAM_DEPTH) {
      console.warn(`[IfcStepParser] Límite de anidamiento de parámetros excedido (> ${IfcStepParser.MAX_PARAM_DEPTH}). Truncando lista.`);
      // Consumir hasta el siguiente RPAREN o EOF para equilibrar
      while (true) {
        const next = this.lexer.nextToken();
        if (next.type === StepTokenType.RPAREN || next.type === StepTokenType.EOF) {
          break;
        }
      }
      return [];
    }

    const params: StepParam[] = [];

    // Comprobar si la lista está vacía inmediatamente
    const peekToken = this.lexer.nextToken();
    if (peekToken.type === StepTokenType.RPAREN) {
      return params;
    }

    // Si no estaba vacía, parsear el primer parámetro
    params.push(this.parseParamValue(peekToken, depth));

    while (true) {
      const next = this.lexer.nextToken();
      if (next.type === StepTokenType.RPAREN || next.type === StepTokenType.EOF) {
        break;
      }
      if (next.type === StepTokenType.COMMA) {
        const valToken = this.lexer.nextToken();
        if (valToken.type === StepTokenType.RPAREN) {
          // Tupla terminada con coma colgante
          break;
        }
        params.push(this.parseParamValue(valToken, depth));
      }
    }

    return params;
  }

  /**
   * Parsea un único valor de parámetro.
   */
  private parseParamValue(token: StepToken, depth: number = 0): StepParam {
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
        return this.parseParamList(depth + 1);
      case StepTokenType.WORD: {
        // Podría ser un tipo anidado como IFCLABEL('mi texto') o IFCBOOLEAN(.T.)
        const savedPos = this.lexer.getPos();
        const next = this.lexer.nextToken();
        if (next.type === StepTokenType.LPAREN) {
          const nestedParams = this.parseParamList(depth + 1);
          return { type: token.value.toUpperCase(), params: nestedParams };
        }
        // Si no va seguido de '(', es una palabra clave suelta
        this.lexer.setPos(savedPos);
        return token.value;
      }
      default:
        return token.value;
    }
  }

  /**
   * Obtiene un registro por ID.
   */
  public getRecord(id: number): StepRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Obtiene todos los registros de un tipo IFC dado (case-insensitive).
   */
  public getRecordsByType(type: string): StepRecord[] {
    return this.recordsByType.get(type.toUpperCase()) || [];
  }
}
