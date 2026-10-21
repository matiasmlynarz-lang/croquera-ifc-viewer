/**
 * GuidUtils — Generador y conversor de identificadores IfcGloballyUniqueId (22 caracteres).
 *
 * Implementa la codificación y decodificación oficial de buildingSMART para
 * convertir entre UUIDs RFC 4122 (128 bits / 36 caracteres) y cadenas IFC Base64 (22 caracteres).
 * Alfabeto IFC: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"
 */

const IFC_BASE64_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

export class GuidUtils {
  /**
   * Genera un nuevo IfcGloballyUniqueId de 22 caracteres válido para IFC 4.3.
   */
  static createIfcGuid(): string {
    const uuid = this.createUuidV4();
    return this.uuidToIfcGuid(uuid);
  }

  /**
   * Genera un UUID estándar v4 (36 caracteres con guiones).
   */
  static createUuidV4(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Convierte un UUID RFC 4122 (hexadecimal de 36 caracteres o sin guiones) a un IFC GUID (22 caracteres).
   */
  static uuidToIfcGuid(uuid: string): string {
    const cleanUuid = uuid.replace(/-/g, '');
    if (cleanUuid.length !== 32) {
      throw new Error(`UUID inválido para conversión a IFC GUID: ${uuid}`);
    }

    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      bytes[i] = parseInt(cleanUuid.substring(i * 2, i * 2 + 2), 16);
    }

    return this.encodeBytesToIfcGuid(bytes);
  }

  /**
   * Convierte un IFC GUID (22 caracteres) a un UUID RFC 4122 (36 caracteres con guiones).
   */
  static ifcGuidToUuid(ifcGuid: string): string {
    if (ifcGuid.length !== 22) {
      throw new Error(`IFC GUID inválido (debe tener 22 caracteres): ${ifcGuid}`);
    }

    const bytes = this.decodeIfcGuidToBytes(ifcGuid);
    let hex = '';
    for (let i = 0; i < 16; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  private static encodeBytesToIfcGuid(b: Uint8Array): string {
    // buildingSMART standard conversion:
    // b[0] (1er byte / 8 bits) -> 2 caracteres base64 IFC
    // 5 bloques de 3 bytes (24 bits c/u) -> 4 caracteres base64 IFC cada uno
    // Total: 2 + (5 * 4) = 22 caracteres
    let result = this.cv_to_64(b[0], 2);

    for (let i = 0; i < 5; i++) {
      const idx = 1 + i * 3;
      const val = (b[idx] << 16) | (b[idx + 1] << 8) | b[idx + 2];
      result += this.cv_to_64(val, 4);
    }

    return result;
  }

  private static decodeIfcGuidToBytes(str: string): Uint8Array {
    const b0 = this.cv_from_64(str.substring(0, 2));

    const b = new Uint8Array(16);
    b[0] = b0 & 0xff;

    for (let i = 0; i < 5; i++) {
      const val = this.cv_from_64(str.substring(2 + i * 4, 6 + i * 4));
      const idx = 1 + i * 3;
      b[idx] = (val >> 16) & 0xff;
      b[idx + 1] = (val >> 8) & 0xff;
      b[idx + 2] = val & 0xff;
    }

    return b;
  }

  private static cv_to_64(val: number, len: number): string {
    let result = '';
    let cur = val;
    for (let i = 0; i < len; i++) {
      result = IFC_BASE64_CHARS.charAt(cur & 0x3f) + result;
      cur = cur >> 6;
    }
    return result;
  }

  private static cv_from_64(str: string): number {
    let res = 0;
    for (let i = 0; i < str.length; i++) {
      const idx = IFC_BASE64_CHARS.indexOf(str.charAt(i));
      if (idx === -1) {
        throw new Error(`Carácter inválido en IFC GUID: ${str.charAt(i)}`);
      }
      res = (res << 6) | idx;
    }
    return res;
  }

  /**
   * Valida si una cadena cumple con el formato oficial de IfcGloballyUniqueId (22 caracteres en alfabeto IFC).
   */
  public static isValidIfcGuid(guid: string): boolean {
    if (!guid || typeof guid !== 'string' || guid.length !== 22) {
      return false;
    }
    for (let i = 0; i < 22; i++) {
      if (IFC_BASE64_CHARS.indexOf(guid[i]) === -1) {
        return false;
      }
    }
    return true;
  }

  /**
   * Alias de conveniencia para isValidIfcGuid.
   */
  public static isIfcGuid(guid: string): boolean {
    return this.isValidIfcGuid(guid);
  }
}
