import { describe, it, expect } from 'vitest';
import { IfcTypeDictionary } from '../src/parser/IfcTypeDictionary';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';

describe('SoA Entity Index and IfcTypeDictionary Tests', () => {
  const encoder = new TextEncoder();

  describe('IfcTypeDictionary', () => {
    it('registers and resolves types bidirectionally', () => {
      const dict = new IfcTypeDictionary();
      const code1 = dict.registerType('IFCWALL');
      const code2 = dict.registerType('IFCSLAB');
      const code3 = dict.registerType('IFCWALL');

      expect(code1).toBeGreaterThan(0);
      expect(code2).toBeGreaterThan(0);
      expect(code1).toBe(code3); // idempotent
      expect(dict.getTypeName(code1)).toBe('IFCWALL');
      expect(dict.getTypeName(code2)).toBe('IFCSLAB');
      expect(dict.getTypeCode('ifcwall')).toBe(code1);
      expect(dict.getTypeCode('IFCSLAB')).toBe(code2);
      expect(dict.getTypeCode('NON_EXISTENT')).toBe(0);
    });

    it('extracts type codes directly from byte slices without string allocation', () => {
      const dict = new IfcTypeDictionary();
      const sample = encoder.encode('  IFCWALLSTANDARDCASE  ');
      // "IFCWALLSTANDARDCASE" starts at index 2, length 19
      const code = dict.getTypeCodeFromBytes(sample, 2, 19);
      expect(code).toBeGreaterThan(0);
      expect(dict.getTypeName(code)).toBe('IFCWALLSTANDARDCASE');

      // Second lookup should hit fast-path hash table with 0 allocations
      const codeRepeat = dict.getTypeCodeFromBytes(sample, 2, 19);
      expect(codeRepeat).toBe(code);
    });
  });

  describe('ChunkedStreamScanner SoA Integration', () => {
    const stepSample = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2026-10-22',('Croquera'),('Mic'),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Yv$81xhn1$x6W0$1$x$1$',#2,'Test Project',$,$,$,$,(#3),#4);
#10=IFCWALL('1010101010101010101010',$,'Wall 1',$,$,#11,#12,$,$);
#20=IFCSLAB('2020202020202020202020',$,'Slab 1',$,$,#21,#22,$,$);
#30=IFCWALL('3030303030303030303030',$,'Wall 2',$,$,#31,#32,$,$);
#40=IFCCARTESIANPOINT((100.5,200.25,0.));
#50=IFCWALL('5050505050505050505050',$,'Wall 3',$,$,#51,#52,$,$);
ENDSEC;
END-ISO-10303-21;
`;

    it('indexes entities in contiguous SoA columns and resolves O(1) type codes', () => {
      const bytes = encoder.encode(stepSample);
      const scanner = new ChunkedStreamScanner(bytes);
      scanner.parseHeader();
      scanner.scanDataSection();

      expect(scanner.totalEntities).toBe(6);
      expect(scanner.maxId).toBe(50);

      // Verify O(1) type retrieval via SoA column
      expect(scanner.getRecordType(1)).toBe('IFCPROJECT');
      expect(scanner.getRecordType(10)).toBe('IFCWALL');
      expect(scanner.getRecordType(20)).toBe('IFCSLAB');
      expect(scanner.getRecordType(30)).toBe('IFCWALL');
      expect(scanner.getRecordType(40)).toBe('IFCCARTESIANPOINT');
      expect(scanner.getRecordType(50)).toBe('IFCWALL');
      expect(scanner.getRecordType(999)).toBeUndefined();

      // Verify 16-bit type codes
      const wallCode = scanner.getRecordTypeCode(10);
      expect(wallCode).toBeGreaterThan(0);
      expect(scanner.getRecordTypeCode(30)).toBe(wallCode);
      expect(scanner.getRecordTypeCode(50)).toBe(wallCode);
      expect(scanner.getRecordTypeCode(20)).not.toBe(wallCode);
    });

    it('streams entities of a given type in exact ascending order via flat linked list', () => {
      const bytes = encoder.encode(stepSample);
      const scanner = new ChunkedStreamScanner(bytes);

      const walls: number[] = [];
      const { processed, errors } = scanner.getRecordsByTypeStreaming('IFCWALL', (rec) => {
        walls.push(rec.id);
        expect(rec.type).toBe('IFCWALL');
        expect(Array.isArray(rec.params)).toBe(true);
      });

      expect(processed).toBe(3);
      expect(errors).toBe(0);
      // Strictly ascending order: #10, #30, #50
      expect(walls).toEqual([10, 30, 50]);

      // Single entity type
      const slabs: number[] = [];
      scanner.getRecordsByTypeStreaming('IFCSLAB', (rec) => {
        slabs.push(rec.id);
        expect(rec.type).toBe('IFCSLAB');
      });
      expect(slabs).toEqual([20]);

      // Non-existent type returns 0 without errors
      const nonExistent = scanner.getRecordsByType('IFCDOOR');
      expect(nonExistent.length).toBe(0);
    });

    it('lazily builds legacy typeIndex with parity for backward compatibility', () => {
      const bytes = encoder.encode(stepSample);
      const scanner = new ChunkedStreamScanner(bytes);

      const legacyMap = scanner.typeIndex;
      expect(legacyMap instanceof Map).toBe(true);
      expect(legacyMap.get('IFCWALL')).toEqual([10, 30, 50]);
      expect(legacyMap.get('IFCSLAB')).toEqual([20]);
      expect(legacyMap.get('IFCPROJECT')).toEqual([1]);
    });
  });
});
