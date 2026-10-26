/**
 * IfcStepParser — STEP entity graph generator and original line indexer.
 *
 * Parses ISO-10303-21 files in memory and retains exact textual references
 * for each entity (rawLine), enabling differential export (delta patching)
 * without loss of precision or third-party schema data.
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
  | { type: string; params: StepParam[] } // Nested types such as IFCLABEL('foo')
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
   * Fully parses STEP content and constructs index lookup tables.
   */
  public parse(): void {
    let token = this.lexer.nextToken();

    // 1. Scan until HEADER or DATA section
    while (token.type !== StepTokenType.EOF) {
      if (token.type === StepTokenType.WORD) {
        const word = token.value.toUpperCase();
        if (word === 'HEADER') {
          // Consume ';'
          token = this.lexer.nextToken();
          this.parseHeader();
          const headerEnd = this.lexer.getPos();
          this.rawHeaderSection = this.buffer.slice(0, headerEnd).trim();
          break;
        } else if (word === 'DATA') {
          // File without HEADER, proceed directly to DATA
          const next = this.lexer.nextToken();
          if (next.type !== StepTokenType.SEMICOLON) {
            // Continue
          }
          this.parseData();
          return;
        }
      }
      token = this.lexer.nextToken();
    }

    // 2. Scan until DATA section if not yet parsed
    token = this.lexer.nextToken();
    while (token.type !== StepTokenType.EOF) {
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'DATA') {
        const next = this.lexer.nextToken();
        if (next.type !== StepTokenType.SEMICOLON) {
          // Continue
        }
        this.parseData();
        break;
      }
      token = this.lexer.nextToken();
    }
  }

  /**
   * Parses the HEADER section.
   */
  private parseHeader(): void {
    while (true) {
      const lineStart = this.lexer.getPos();
      const token = this.lexer.nextToken();

      if (token.type === StepTokenType.EOF) break;
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'ENDSEC') {
        // Consume ';'
        this.lexer.nextToken();
        break;
      }

      if (token.type === StepTokenType.WORD) {
        const typeName = token.value.toUpperCase();
        // Expect '('
        const lp = this.lexer.nextToken();
        if (lp.type === StepTokenType.LPAREN) {
          const params = this.parseParamList();
          // Expect ';'
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
   * Parses the DATA section (#id = TYPE(params);).
   */
  private parseData(): void {
    while (true) {
      const lineStart = this.lexer.getPos();
      const token = this.lexer.nextToken();

      if (token.type === StepTokenType.EOF) break;
      if (token.type === StepTokenType.WORD && token.value.toUpperCase() === 'ENDSEC') {
        // Consume ';'
        this.lexer.nextToken();
        break;
      }

      if (token.type === StepTokenType.REF) {
        const entityId = token.value as number;
        if (entityId > this.maxId) {
          this.maxId = entityId;
        }

        // Expect '='
        const eq = this.lexer.nextToken();
        if (eq.type !== StepTokenType.EQUALS) continue;

        // Expect type name (e.g. IFCWALL)
        const typeToken = this.lexer.nextToken();
        if (typeToken.type !== StepTokenType.WORD) continue;
        const typeName = typeToken.value.toUpperCase();

        // Expect '('
        const lp = this.lexer.nextToken();
        if (lp.type !== StepTokenType.LPAREN) continue;

        const params = this.parseParamList();

        // Expect ';'
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
   * Parses a comma-separated parameter list until matching ')'.
   */
  private parseParamList(depth: number = 0): StepParam[] {
    if (depth > IfcStepParser.MAX_PARAM_DEPTH) {
      console.warn(`[IfcStepParser] Parameter nesting limit exceeded (> ${IfcStepParser.MAX_PARAM_DEPTH}). Truncating list.`);
      // Consume until next RPAREN or EOF to balance
      while (true) {
        const next = this.lexer.nextToken();
        if (next.type === StepTokenType.RPAREN || next.type === StepTokenType.EOF) {
          break;
        }
      }
      return [];
    }

    const params: StepParam[] = [];

    // Check if list is immediately empty
    const peekToken = this.lexer.nextToken();
    if (peekToken.type === StepTokenType.RPAREN) {
      return params;
    }

    // If not empty, parse first parameter
    params.push(this.parseParamValue(peekToken, depth));

    while (true) {
      const next = this.lexer.nextToken();
      if (next.type === StepTokenType.RPAREN || next.type === StepTokenType.EOF) {
        break;
      }
      if (next.type === StepTokenType.COMMA) {
        const valToken = this.lexer.nextToken();
        if (valToken.type === StepTokenType.RPAREN) {
          // Trailing comma tuple
          break;
        }
        params.push(this.parseParamValue(valToken, depth));
      }
    }

    return params;
  }

  /**
   * Parses a single parameter value.
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
        // Could be a nested type like IFCLABEL('my text') or IFCBOOLEAN(.T.)
        const savedPos = this.lexer.getPos();
        const next = this.lexer.nextToken();
        if (next.type === StepTokenType.LPAREN) {
          const nestedParams = this.parseParamList(depth + 1);
          return { type: token.value.toUpperCase(), params: nestedParams };
        }
        // If not followed by '(', it is a standalone keyword
        this.lexer.setPos(savedPos);
        return token.value;
      }
      default:
        return token.value;
    }
  }

  /**
   * Retrieves a record by STEP ID.
   */
  public getRecord(id: number): StepRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Retrieves all records of a given IFC type (case-insensitive).
   */
  public getRecordsByType(type: string): StepRecord[] {
    return this.recordsByType.get(type.toUpperCase()) || [];
  }
}
