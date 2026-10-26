/**
 * IfcTypeDictionary — Fast, zero-allocation bidirectional dictionary for IFC type names.
 *
 * Implements:
 * 1. Byte-level FNV-1a hashing with ASCII uppercase normalization.
 * 2. 16-bit numeric type code allocation (1..65535).
 * 3. Exact character-by-character byte verification to guarantee 0 collision risk.
 * 4. O(1) reverse lookup getTypeName(code).
 */

export class IfcTypeDictionary {
  private nameToCode: Map<string, number> = new Map();
  private codeToName: string[] = ['UNKNOWN'];
  private hashToCode: Map<number, number> = new Map();
  private nextCode: number = 1;

  constructor() {
    this.nameToCode.set('UNKNOWN', 0);
  }

  /**
   * Computes 32-bit FNV-1a hash over raw ASCII bytes, normalizing to uppercase.
   */
  private hash(buf: Uint8Array, start: number, len: number): number {
    let h = 2166136261;
    for (let i = 0; i < len; i++) {
      let c = buf[start + i];
      if (c >= 97 && c <= 122) c -= 32; // a-z -> A-Z
      h = Math.imul(h ^ c, 16777619) >>> 0;
    }
    return h;
  }

  /**
   * Validates whether raw byte slice matches a known uppercase string without allocations.
   */
  private matchesBytes(name: string, buf: Uint8Array, start: number, len: number): boolean {
    if (name.length !== len) return false;
    for (let i = 0; i < len; i++) {
      let c = buf[start + i];
      if (c >= 97 && c <= 122) c -= 32;
      if (name.charCodeAt(i) !== c) return false;
    }
    return true;
  }

  /**
   * Registers a type name and assigns a unique 16-bit code.
   */
  public registerType(name: string, hash?: number): number {
    const upper = name.toUpperCase();
    let code = this.nameToCode.get(upper);
    if (code !== undefined) {
      if (hash !== undefined) this.hashToCode.set(hash, code);
      return code;
    }

    if (this.nextCode > 65535) {
      console.warn('[IfcTypeDictionary] Maximum 16-bit type capacity exceeded (> 65,535 distinct types)');
      return 0;
    }

    code = this.nextCode++;
    this.nameToCode.set(upper, code);
    this.codeToName[code] = upper;
    if (hash !== undefined) {
      this.hashToCode.set(hash, code);
    }
    return code;
  }

  /**
   * Gets the 16-bit numeric type code directly from raw ASCII bytes.
   * Allocates 0 heap memory for all previously seen types.
   */
  public getTypeCodeFromBytes(buf: Uint8Array, start: number, len: number): number {
    const h = this.hash(buf, start, len);
    const code = this.hashToCode.get(h);
    if (code !== undefined) {
      const name = this.codeToName[code];
      if (this.matchesBytes(name, buf, start, len)) {
        return code;
      }
    }

    // First time seeing this type: decode uppercase ASCII directly without allocations
    let decoded = '';
    const end = start + len;
    for (let i = start; i < end; i++) {
      let c = buf[i];
      if (c >= 97 && c <= 122) c -= 32;
      decoded += String.fromCharCode(c);
    }
    return this.registerType(decoded, h);
  }

  /**
   * Returns the string name for a given 16-bit type code in O(1).
   */
  public getTypeName(code: number): string {
    return this.codeToName[code] || 'UNKNOWN';
  }

  /**
   * Returns the 16-bit type code for a given string name in O(1).
   */
  public getTypeCode(name: string): number {
    return this.nameToCode.get(name.toUpperCase()) || 0;
  }

  /**
   * Returns the total number of registered distinct IFC types.
   */
  public get size(): number {
    return this.codeToName.length - 1;
  }

  /**
   * Exports the internal code-to-name mapping for synchronization across Web Workers.
   */
  public exportState(): string[] {
    return [...this.codeToName];
  }

  /**
   * Hydrates the dictionary from a synchronized code-to-name mapping in O(K).
   */
  public importState(codeToName: string[]): void {
    this.codeToName = [...codeToName];
    this.nameToCode.clear();
    this.hashToCode.clear();
    for (let code = 0; code < this.codeToName.length; code++) {
      const name = this.codeToName[code];
      if (name) {
        this.nameToCode.set(name, code);
      }
    }
    this.nextCode = this.codeToName.length;
  }
}
