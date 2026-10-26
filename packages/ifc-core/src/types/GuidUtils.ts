/**
 * GuidUtils — Generator and converter for IfcGloballyUniqueId (22 characters).
 *
 * Implements the official buildingSMART encoding and decoding algorithms to
 * convert between standard RFC 4122 UUIDs (128 bits / 36 characters) and IFC Base64 strings (22 characters).
 * IFC Base64 Alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"
 */

const IFC_BASE64_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

export class GuidUtils {
  /**
   * Generates a new valid 22-character IfcGloballyUniqueId for IFC 4.3.
   */
  static createIfcGuid(): string {
    const uuid = this.createUuidV4();
    return this.uuidToIfcGuid(uuid);
  }

  /**
   * Generates a standard RFC 4122 v4 UUID (36 characters with hyphens).
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
   * Converts an RFC 4122 UUID (hexadecimal 36 characters or unhyphenated) to an IFC GUID (22 characters).
   */
  static uuidToIfcGuid(uuid: string): string {
    const cleanUuid = uuid.replace(/-/g, '');
    if (cleanUuid.length !== 32) {
      throw new Error(`Invalid UUID for conversion to IFC GUID: ${uuid}`);
    }

    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      bytes[i] = parseInt(cleanUuid.substring(i * 2, i * 2 + 2), 16);
    }

    return this.encodeBytesToIfcGuid(bytes);
  }

  /**
   * Converts an IFC GUID (22 characters) to an RFC 4122 UUID (36 characters with hyphens).
   */
  static ifcGuidToUuid(ifcGuid: string): string {
    if (ifcGuid.length !== 22) {
      throw new Error(`Invalid IFC GUID (must have 22 characters): ${ifcGuid}`);
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
    // b[0] (1st byte / 8 bits) -> 2 IFC base64 characters
    // 5 chunks of 3 bytes (24 bits each) -> 4 IFC base64 characters each
    // Total: 2 + (5 * 4) = 22 characters
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
        throw new Error(`Invalid character in IFC GUID: ${str.charAt(i)}`);
      }
      res = (res << 6) | idx;
    }
    return res;
  }

  /**
   * Validates if a string conforms to the official IfcGloballyUniqueId format (22 characters in IFC alphabet).
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
   * Convenience alias for isValidIfcGuid.
   */
  public static isIfcGuid(guid: string): boolean {
    return this.isValidIfcGuid(guid);
  }
}
