/**
 * IfcStepByteLexer — Zero-allocation binary tokenizer for ISO-10303-21 STEP entities.
 *
 * Operates directly on a Uint8Array byte slice for a single STEP record:
 * - Zero token object allocations (updates mutable cursor fields in-place).
 * - Direct byte scanning of numbers via StepByteNumber.
 * - Fast integer accumulation for entity references (#123).
 * - Interning of repeated uppercase identifiers and enums (.TRUE., .T., IFCLABEL, etc.).
 */

import { StepTokenType } from './IfcStepLexer';
import { IfcStepLexer } from './IfcStepLexer';
import { StepByteNumber } from './StepByteNumber';

// Fast lookup cache for common STEP keywords and enum strings to avoid V8 string allocations
const STRING_INTERN_MAP = new Map<string, string>();

function internString(s: string): string {
  let existing = STRING_INTERN_MAP.get(s);
  if (!existing) {
    if (STRING_INTERN_MAP.size < 5000) {
      STRING_INTERN_MAP.set(s, s);
    }
    existing = s;
  }
  return existing;
}

// Pre-intern common STEP enums and keywords
[
  'T', 'TRUE', 'F', 'FALSE', 'U', 'UNKNOWN', 'NOTDEFINED', 'ELEMENT', 'USERDEFINED',
  'IFCLABEL', 'IFCTEXT', 'IFCIDENTIFIER', 'IFCBOOLEAN', 'IFCLOGICAL', 'IFCREAL', 'IFCINTEGER',
  'SOLIDWALL', 'STANDARD', 'FLOOR', 'ROOF', 'DOOR', 'WINDOW', 'BEAM', 'COLUMN', 'SLAB'
].forEach(internString);

const utf8Decoder = new TextDecoder('utf-8');

/**
 * Safely decodes a Uint8Array into a UTF-8 string, handling views backed by SharedArrayBuffer
 * in compliance with WHATWG Encoding Standard restrictions.
 */
export function safeDecodeUtf8(bytes: Uint8Array, decoder: TextDecoder = utf8Decoder): string {
  const isShared =
    (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer) ||
    Object.prototype.toString.call(bytes.buffer) === '[object SharedArrayBuffer]';

  if (isShared) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return decoder.decode(copy);
  }
  return decoder.decode(bytes);
}

/**
 * Fast zero-allocation ASCII decoder for alphanumeric tokens, numbers, and identifiers.
 * Operates natively and safely on both ArrayBuffer and SharedArrayBuffer views.
 */
export function decodeAscii(buf: Uint8Array, start: number, len: number): string {
  let str = '';
  const end = start + len;
  for (let i = start; i < end; i++) {
    str += String.fromCharCode(buf[i]);
  }
  return str;
}

export class IfcStepByteLexer {
  private buf: Uint8Array;
  private length: number;
  public pos: number;
  private end: number;

  // Mutable token result fields (read by parser without object allocations)
  public tokenType: StepTokenType = StepTokenType.EOF;
  public numValue: number = 0;
  public refValue: number = 0;
  public stringValue: string = '';
  public tokenStart: number = 0;
  public tokenEnd: number = 0;

  constructor(buf: Uint8Array, start: number = 0, length?: number) {
    this.buf = buf;
    this.pos = start;
    this.end = length !== undefined ? start + length : buf.length;
    this.length = this.end;
  }

  public reset(start: number, end: number): void {
    this.pos = start;
    this.end = end;
    this.length = end;
    this.tokenType = StepTokenType.EOF;
  }

  public getPos(): number {
    return this.pos;
  }

  public setPos(pos: number): void {
    this.pos = pos;
  }

  /**
   * Skips whitespace and STEP inline comments (/* ... *\/).
   */
  public skipWhitespaceAndComments(): void {
    const buf = this.buf;
    const end = this.end;

    while (this.pos < end) {
      const ch = buf[this.pos];

      // Whitespace: ' ', '\t', '\r', '\n'
      if (ch === 32 || ch === 9 || ch === 13 || ch === 10) {
        this.pos++;
        continue;
      }

      // Comments: /* ... */
      if (ch === 47 /* '/' */ && this.pos + 1 < end && buf[this.pos + 1] === 42 /* '*' */) {
        this.pos += 2;
        while (this.pos + 1 < end) {
          if (buf[this.pos] === 42 && buf[this.pos + 1] === 47) {
            this.pos += 2;
            break;
          }
          this.pos++;
        }
        continue;
      }

      break;
    }
  }

  /**
   * Advances the lexer to the next token, updating internal mutable fields.
   * Returns the token type code for fast branch dispatch.
   */
  public nextToken(): StepTokenType {
    this.skipWhitespaceAndComments();

    if (this.pos >= this.end) {
      this.tokenType = StepTokenType.EOF;
      this.tokenStart = this.pos;
      this.tokenEnd = this.pos;
      return StepTokenType.EOF;
    }

    const buf = this.buf;
    const start = this.pos;
    const ch = buf[start];

    // Single character delimiters
    if (ch === 40 /* '(' */) {
      this.pos++;
      this.tokenType = StepTokenType.LPAREN;
      this.tokenStart = start;
      this.tokenEnd = this.pos;
      return StepTokenType.LPAREN;
    }
    if (ch === 41 /* ')' */) {
      this.pos++;
      this.tokenType = StepTokenType.RPAREN;
      this.tokenStart = start;
      this.tokenEnd = this.pos;
      return StepTokenType.RPAREN;
    }
    if (ch === 44 /* ',' */) {
      this.pos++;
      this.tokenType = StepTokenType.COMMA;
      this.tokenStart = start;
      this.tokenEnd = this.pos;
      return StepTokenType.COMMA;
    }
    if (ch === 59 /* ';' */) {
      this.pos++;
      this.tokenType = StepTokenType.SEMICOLON;
      this.tokenStart = start;
      this.tokenEnd = this.pos;
      return StepTokenType.SEMICOLON;
    }
    if (ch === 61 /* '=' */) {
      this.pos++;
      this.tokenType = StepTokenType.EQUALS;
      this.tokenStart = start;
      this.tokenEnd = this.pos;
      return StepTokenType.EQUALS;
    }
    if (ch === 36 /* '$' */) {
      this.pos++;
      this.tokenType = StepTokenType.NULL;
      this.tokenStart = start;
      this.tokenEnd = this.pos;
      return StepTokenType.NULL;
    }
    if (ch === 42 /* '*' */) {
      this.pos++;
      this.tokenType = StepTokenType.ASTERISK;
      this.tokenStart = start;
      this.tokenEnd = this.pos;
      return StepTokenType.ASTERISK;
    }

    // Entity references: #1234
    if (ch === 35 /* '#' */) {
      this.pos++;
      const cursor = { pos: this.pos };
      this.refValue = StepByteNumber.parseInteger(buf, this.pos, this.end, cursor);
      this.pos = cursor.pos;
      this.tokenType = StepTokenType.REF;
      this.tokenStart = start;
      this.tokenEnd = this.pos;
      return StepTokenType.REF;
    }

    // Text strings: '...' (with '' escape)
    if (ch === 39 /* '\'' */) {
      this.pos++;
      const strStart = this.pos;
      let hasEscapedQuote = false;

      while (this.pos < this.end) {
        if (buf[this.pos] === 39 /* '\'' */) {
          if (this.pos + 1 < this.end && buf[this.pos + 1] === 39 /* '\'' */) {
            hasEscapedQuote = true;
            this.pos += 2;
          } else {
            break;
          }
        } else {
          this.pos++;
        }
      }

      const strBytes = buf.subarray(strStart, this.pos);
      if (this.pos < this.end) this.pos++; // consume closing quote

      let decoded = safeDecodeUtf8(strBytes, utf8Decoder);
      if (hasEscapedQuote) {
        decoded = decoded.replace(/''/g, "'");
      }
      this.stringValue = IfcStepLexer.decodeIsoStepString(decoded);
      this.tokenType = StepTokenType.STRING;
      this.tokenStart = start;
      this.tokenEnd = this.pos;
      return StepTokenType.STRING;
    }

    // Enumerations or dot-numbers: .TRUE., .ELEMENT., .5
    if (ch === 46 /* '.' */) {
      if (this.pos + 1 < this.end) {
        const nextC = buf[this.pos + 1];
        if (nextC >= 48 && nextC <= 57) { // number starting with '.' e.g. .5
          const cursor = { pos: start };
          this.numValue = StepByteNumber.parseNumber(buf, start, this.end, cursor);
          this.pos = cursor.pos;
          this.tokenType = StepTokenType.NUMBER;
          this.tokenStart = start;
          this.tokenEnd = this.pos;
          return StepTokenType.NUMBER;
        }
      }

      // Enumeration .NAME.
      this.pos++;
      const enumStart = this.pos;
      while (this.pos < this.end) {
        if (buf[this.pos] === 46 /* '.' */) {
          break;
        }
        this.pos++;
      }
      const enumLen = this.pos - enumStart;
      if (this.pos < this.end) this.pos++; // consume closing dot

      this.stringValue = internString(this.extractAsciiUpper(enumStart, enumLen));
      this.tokenType = StepTokenType.ENUM;
      this.tokenStart = start;
      this.tokenEnd = this.pos;
      return StepTokenType.ENUM;
    }

    // Numbers: 0-9, or + / - followed by digit or dot
    if (
      (ch >= 48 && ch <= 57) ||
      ((ch === 43 || ch === 45) && this.pos + 1 < this.end && (
        (buf[this.pos + 1] >= 48 && buf[this.pos + 1] <= 57) ||
        buf[this.pos + 1] === 46
      ))
    ) {
      const cursor = { pos: start };
      this.numValue = StepByteNumber.parseNumber(buf, start, this.end, cursor);
      this.pos = cursor.pos;
      this.tokenType = StepTokenType.NUMBER;
      this.tokenStart = start;
      this.tokenEnd = this.pos;
      return StepTokenType.NUMBER;
    }

    // Words / Identifiers (IFCWALL, IFCLABEL, etc.)
    if (
      (ch >= 65 && ch <= 90) || // A-Z
      (ch >= 97 && ch <= 122) || // a-z
      ch === 95 // _
    ) {
      const wordStart = this.pos;
      while (this.pos < this.end) {
        const c = buf[this.pos];
        if (
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          (c >= 48 && c <= 57) ||
          c === 95 ||
          c === 45 // '-' for ISO-10303-21
        ) {
          this.pos++;
        } else {
          break;
        }
      }
      const wordLen = this.pos - wordStart;
      this.stringValue = internString(this.extractAsciiUpper(wordStart, wordLen));
      this.tokenType = StepTokenType.WORD;
      this.tokenStart = start;
      this.tokenEnd = this.pos;
      return StepTokenType.WORD;
    }

    // Unknown character: consume single byte
    this.stringValue = String.fromCharCode(ch);
    this.pos++;
    this.tokenType = StepTokenType.WORD;
    this.tokenStart = start;
    this.tokenEnd = this.pos;
    return StepTokenType.WORD;
  }

  private extractAsciiUpper(start: number, length: number): string {
    let s = '';
    const buf = this.buf;
    for (let i = 0; i < length; i++) {
      let c = buf[start + i];
      if (c >= 97 && c <= 122) c -= 32; // a-z -> A-Z
      s += String.fromCharCode(c);
    }
    return s;
  }
}
