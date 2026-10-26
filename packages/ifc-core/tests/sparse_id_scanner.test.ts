import { describe, it, expect } from 'vitest';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';

describe('ChunkedStreamScanner Sparse IDs and OOM Prevention Tests', () => {
  const encoder = new TextEncoder();

  it('scans and parses massive sparse IDs without OOM or large heap allocations', () => {
    const stepWithSparseIds = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('sparse_test.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Test Project',$,$,$,$,$,$);
#25= IFCSITE('0$r_g_0000000000000002',$,'Site 25',$,$,$,$,$,$,$,$,$,$,$);
#100000000= IFCBUILDING('0$r_g_0000000000000003',$,'Building 100M',$,$,$,$,$,$,$);
#500000000= IFCWALL('0$r_g_0000000000000004',$,'Wall 500M',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
    `;

    const bytes = encoder.encode(stepWithSparseIds);
    const startTime = performance.now();
    const scanner = new ChunkedStreamScanner(bytes);
    scanner.parseHeader();
    scanner.scanDataSection();
    const duration = performance.now() - startTime;

    expect(duration).toBeLessThan(50); // Must scan in < 50ms without allocating 7 GB
    expect(scanner.totalEntities).toBe(4);
    expect(scanner.maxId).toBe(500000000);

    // Verify existence checks in O(1)
    expect(scanner.hasRecord(1)).toBe(true);
    expect(scanner.hasRecord(25)).toBe(true);
    expect(scanner.hasRecord(100000000)).toBe(true);
    expect(scanner.hasRecord(500000000)).toBe(true);
    expect(scanner.hasRecord(2)).toBe(false);
    expect(scanner.hasRecord(999999)).toBe(false);
    expect(scanner.hasRecord(600000000)).toBe(false);

    // Verify type retrieval
    expect(scanner.getRecordType(1)).toBe('IFCPROJECT');
    expect(scanner.getRecordType(25)).toBe('IFCSITE');
    expect(scanner.getRecordType(100000000)).toBe('IFCBUILDING');
    expect(scanner.getRecordType(500000000)).toBe('IFCWALL');
    expect(scanner.getRecordType(2)).toBeUndefined();

    // Verify on-demand parsing of sparse entities
    const wall500M = scanner.getRecordOnDemand(500000000);
    expect(wall500M).toBeDefined();
    expect(wall500M?.id).toBe(500000000);
    expect(wall500M?.type).toBe('IFCWALL');
    expect(wall500M?.params[2]).toBe('Wall 500M');

    const bldg100M = scanner.getRecordOnDemand(100000000);
    expect(bldg100M).toBeDefined();
    expect(bldg100M?.id).toBe(100000000);
    expect(bldg100M?.type).toBe('IFCBUILDING');
    expect(bldg100M?.params[2]).toBe('Building 100M');
  });

  it('traverses type linked list seamlessly across dense and sparse boundaries', () => {
    const stepWithMixedWalls = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('mixed_test.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10= IFCWALL('0$r_g_0000000000000010',$,'Wall 10',$,$,$,$,$,$);
#20= IFCWALL('0$r_g_0000000000000020',$,'Wall 20',$,$,$,$,$,$);
#100000000= IFCWALL('0$r_g_0000000000100000',$,'Wall 100M',$,$,$,$,$,$);
#100000005= IFCWALL('0$r_g_0000000000100005',$,'Wall 100M + 5',$,$,$,$,$,$);
#500000000= IFCWALL('0$r_g_0000000000500000',$,'Wall 500M',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
    `;

    const bytes = encoder.encode(stepWithMixedWalls);
    const scanner = new ChunkedStreamScanner(bytes);

    const visitedWallIds: number[] = [];
    const { processed, errors } = scanner.getRecordsByTypeStreaming('IFCWALL', (rec) => {
      visitedWallIds.push(rec.id);
    });

    expect(errors).toBe(0);
    expect(processed).toBe(5);
    // Strict ascending order across dense storage and multiple sparse pages
    expect(visitedWallIds).toEqual([10, 20, 100000000, 100000005, 500000000]);
  });

  it('preserves segmented fill initialization in dense capacity resizing', () => {
    // Generate a sequence that forces dense resizing past the initial 100,000 capacity
    const header = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Test'),'2;1');\nFILE_NAME('t.ifc','2026-10-22',('U'),('O'),'C','C','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n`;
    const lines: string[] = [header];

    // Create 105 entities distributed up to #105000
    for (let i = 1; i <= 105000; i += 1000) {
      lines.push(`#${i}= IFCWALL('guid${i}',$,'Wall ${i}',$,$,$,$,$,$);\n`);
    }
    lines.push('ENDSEC;\nEND-ISO-10303-21;\n');

    const bytes = encoder.encode(lines.join(''));
    const scanner = new ChunkedStreamScanner(bytes);
    scanner.parseHeader();
    scanner.scanDataSection();

    expect(scanner.totalEntities).toBe(105);
    expect(scanner.hasRecord(1)).toBe(true);
    expect(scanner.hasRecord(100001)).toBe(true);
    expect(scanner.hasRecord(105001)).toBe(false);

    const rec = scanner.getRecordOnDemand(100001);
    expect(rec).toBeDefined();
    expect(rec?.id).toBe(100001);
    expect(rec?.type).toBe('IFCWALL');
  });
});
