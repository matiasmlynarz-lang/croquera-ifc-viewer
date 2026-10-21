/**
 * IfcStepLexer — Tokenizador de alta velocidad en memoria para archivos STEP ISO-10303-21.
 *
 * Implementa un escaneo lineal con puntero directo sobre el búfer de texto,
 * evitando expresiones regulares pesadas para procesar archivos grandes en milisegundos.
 */

export enum StepTokenType {
  REF = 'REF',           // #123
  WORD = 'WORD',         // IFCWALL, HEADER, ENDSEC, etc.
  STRING = 'STRING',     // 'texto' (con escape '')
  ENUM = 'ENUM',         // .TRUE., .ELEMENT., .T., etc.
  NUMBER = 'NUMBER',     // 123, -4.56, 1.E-05
  NULL = 'NULL',         // $
  ASTERISK = 'ASTERISK', // *
  LPAREN = 'LPAREN',     // (
  RPAREN = 'RPAREN',     // )
  COMMA = 'COMMA',       // ,
  SEMICOLON = 'SEMICOLON', // ;
  EQUALS = 'EQUALS',     // =
  EOF = 'EOF',
}

export interface StepToken {
  type: StepTokenType;
  value: any;
  start: number;
  end: number;
}

export class IfcStepLexer {
  private buffer: string;
  private length: number;
  private pos: number = 0;

  constructor(buffer: string) {
    this.buffer = buffer;
    this.length = buffer.length;
  }

  public getPos(): number {
    return this.pos;
  }

  public setPos(pos: number): void {
    this.pos = pos;
  }

  /**
   * Salta espacios en blanco y comentarios /* ... *\/
   */
  private skipWhitespaceAndComments(): void {
    while (this.pos < this.length) {
      const ch = this.buffer.charCodeAt(this.pos);

      // Espacios en blanco: ' ', '\t', '\r', '\n'
      if (ch === 32 || ch === 9 || ch === 13 || ch === 10) {
        this.pos++;
        continue;
      }

      // Comentarios STEP: /* ... */
      if (ch === 47 /* '/' */ && this.pos + 1 < this.length && this.buffer.charCodeAt(this.pos + 1) === 42 /* '*' */) {
        this.pos += 2;
        while (this.pos + 1 < this.length) {
          if (this.buffer.charCodeAt(this.pos) === 42 /* '*' */ && this.buffer.charCodeAt(this.pos + 1) === 47 /* '/' */) {
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
   * Lee y retorna el siguiente token del flujo.
   */
  public nextToken(): StepToken {
    this.skipWhitespaceAndComments();

    if (this.pos >= this.length) {
      return { type: StepTokenType.EOF, value: null, start: this.pos, end: this.pos };
    }

    const start = this.pos;
    const ch = this.buffer.charCodeAt(this.pos);

    // Delimitadores de un solo carácter
    if (ch === 40 /* '(' */) {
      this.pos++;
      return { type: StepTokenType.LPAREN, value: '(', start, end: this.pos };
    }
    if (ch === 41 /* ')' */) {
      this.pos++;
      return { type: StepTokenType.RPAREN, value: ')', start, end: this.pos };
    }
    if (ch === 44 /* ',' */) {
      this.pos++;
      return { type: StepTokenType.COMMA, value: ',', start, end: this.pos };
    }
    if (ch === 59 /* ';' */) {
      this.pos++;
      return { type: StepTokenType.SEMICOLON, value: ';', start, end: this.pos };
    }
    if (ch === 61 /* '=' */) {
      this.pos++;
      return { type: StepTokenType.EQUALS, value: '=', start, end: this.pos };
    }
    if (ch === 36 /* '$' */) {
      this.pos++;
      return { type: StepTokenType.NULL, value: null, start, end: this.pos };
    }
    if (ch === 42 /* '*' */) {
      this.pos++;
      return { type: StepTokenType.ASTERISK, value: '*', start, end: this.pos };
    }

    // Referencias de entidad: #123
    if (ch === 35 /* '#' */) {
      this.pos++;
      const numStart = this.pos;
      while (this.pos < this.length) {
        const c = this.buffer.charCodeAt(this.pos);
        if (c >= 48 && c <= 57 /* '0'-'9' */) {
          this.pos++;
        } else {
          break;
        }
      }
      const refNum = parseInt(this.buffer.slice(numStart, this.pos), 10);
      return { type: StepTokenType.REF, value: refNum, start, end: this.pos };
    }

    // Cadenas de texto: '...' (con escape '')
    if (ch === 39 /* '\'' */) {
      this.pos++;
      let str = '';
      while (this.pos < this.length) {
        const c = this.buffer.charCodeAt(this.pos);
        if (c === 39 /* '\'' */) {
          if (this.pos + 1 < this.length && this.buffer.charCodeAt(this.pos + 1) === 39 /* '\'' */) {
            str += "'";
            this.pos += 2;
          } else {
            this.pos++;
            break;
          }
        } else {
          str += this.buffer[this.pos];
          this.pos++;
        }
      }
      return { type: StepTokenType.STRING, value: IfcStepLexer.decodeIsoStepString(str), start, end: this.pos };
    }

    // Enumeraciones / Booleanos: .TRUE., .ELEMENT., .T.
    if (ch === 46 /* '.' */) {
      // Puede ser un número que empiece por punto (ej. .5) o un enum (ej. .T.)
      if (this.pos + 1 < this.length) {
        const nextC = this.buffer.charCodeAt(this.pos + 1);
        if (nextC >= 48 && nextC <= 57) {
          // Es un número
          return this.readNumber(start);
        }
      }
      this.pos++;
      const enumStart = this.pos;
      while (this.pos < this.length) {
        const c = this.buffer.charCodeAt(this.pos);
        if (c === 46 /* '.' */) {
          this.pos++;
          break;
        }
        this.pos++;
      }
      const enumVal = this.buffer.slice(enumStart, this.pos - 1).toUpperCase();
      return { type: StepTokenType.ENUM, value: enumVal, start, end: this.pos };
    }

    // Números (con signo opcional)
    if (
      (ch >= 48 && ch <= 57) || // '0'-'9'
      ((ch === 43 /* '+' */ || ch === 45 /* '-' */) && this.pos + 1 < this.length && (
        (this.buffer.charCodeAt(this.pos + 1) >= 48 && this.buffer.charCodeAt(this.pos + 1) <= 57) ||
        this.buffer.charCodeAt(this.pos + 1) === 46
      ))
    ) {
      return this.readNumber(start);
    }

    // Palabras / Identificadores (IFCWALL, HEADER, ISO-10303-21, etc.)
    if (
      (ch >= 65 && ch <= 90) || // 'A'-'Z'
      (ch >= 97 && ch <= 122) || // 'a'-'z'
      ch === 95 // '_'
    ) {
      while (this.pos < this.length) {
        const c = this.buffer.charCodeAt(this.pos);
        if (
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          (c >= 48 && c <= 57) ||
          c === 95 || // '_'
          c === 45 // '-' (para ISO-10303-21)
        ) {
          this.pos++;
        } else {
          break;
        }
      }
      const word = this.buffer.slice(start, this.pos);
      return { type: StepTokenType.WORD, value: word, start, end: this.pos };
    }

    // Carácter desconocido: avanzar
    this.pos++;
    return { type: StepTokenType.WORD, value: this.buffer[start], start, end: this.pos };
  }

  private readNumber(start: number): StepToken {
    let hasDot = false;
    let hasExp = false;

    if (this.buffer.charCodeAt(this.pos) === 43 || this.buffer.charCodeAt(this.pos) === 45) {
      this.pos++;
    }

    while (this.pos < this.length) {
      const c = this.buffer.charCodeAt(this.pos);
      if (c >= 48 && c <= 57) {
        this.pos++;
      } else if (c === 46 /* '.' */ && !hasDot && !hasExp) {
        hasDot = true;
        this.pos++;
      } else if ((c === 69 || c === 101 /* 'E', 'e' */) && !hasExp) {
        hasExp = true;
        this.pos++;
        if (this.pos < this.length && (this.buffer.charCodeAt(this.pos) === 43 || this.buffer.charCodeAt(this.pos) === 45)) {
          this.pos++;
        }
      } else {
        break;
      }
    }

    const numStr = this.buffer.slice(start, this.pos);
    const numVal = parseFloat(numStr);
    return { type: StepTokenType.NUMBER, value: numVal, start, end: this.pos };
  }

  /**
   * Decodifica secuencias de escape de texto ISO-10303-21 (\X2\...\X0\, \X4\...\X0\, \S\c, \\).
   */
  public static decodeIsoStepString(s: string): string {
    if (!s || !s.includes('\\')) return s;

    // 1. Decodificar \X2\HHHH...\X0\ (16-bit UCS-2 / UTF-16)
    let result = s.replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hexGroup) => {
      let decoded = '';
      for (let i = 0; i + 4 <= hexGroup.length; i += 4) {
        const code = parseInt(hexGroup.substring(i, i + 4), 16);
        decoded += String.fromCharCode(code);
      }
      return decoded;
    });

    // 2. Decodificar \X4\HHHHHHHH...\X0\ (32-bit UCS-4)
    result = result.replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, (_, hexGroup) => {
      let decoded = '';
      for (let i = 0; i + 8 <= hexGroup.length; i += 8) {
        const code = parseInt(hexGroup.substring(i, i + 8), 16);
        decoded += String.fromCodePoint(code);
      }
      return decoded;
    });

    // 3. Decodificar \S\c (carácter con bit alto 0x80)
    result = result.replace(/\\S\\(.)/g, (_, char) => {
      const code = char.charCodeAt(0) + 128;
      return String.fromCharCode(code);
    });

    // 4. Decodificar doble barra invertida \\ -> \
    result = result.replace(/\\\\/g, '\\');

    return result;
  }
}
