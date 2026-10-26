import { describe, it, expect } from 'vitest';
import { ChunkedStreamScanner, IfcStreamingParser } from '../src';

describe('ChunkedStreamScanner & IfcStreamingParser Unit Tests', () => {
  const stepSample = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('scanner_test.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Test Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Default Site',$,$,$,$,$,$,$,$,$,$,$);
#3= IFCBUILDING('0$r_g_0000000000000003',$,'Default Building',$,$,$,$,$,$,$,$);
#4= IFCWALL('0$r_g_0000000000000004',$,'Wall 1',$,$,$,$,$,$);
#5= IFCWALL('0$r_g_0000000000000005',$,'Wall 2',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
  `;

  it('scans and parses STEP stream with ChunkedStreamScanner', () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(stepSample);

    const scanner = new ChunkedStreamScanner(bytes, { maxMapSize: 1000 });
    scanner.parseHeader();
    scanner.scanDataSection();

    const project = scanner.getRecord(1);
    expect(project).toBeDefined();
    expect(project?.type).toBe('IFCPROJECT');

    const wall1 = scanner.getRecord(4);
    expect(wall1).toBeDefined();
    expect(wall1?.type).toBe('IFCWALL');

    const walls = scanner.getRecordsByType('IFCWALL');
    expect(walls).toHaveLength(2);
  });

  it('indexes on-demand records with IfcStreamingParser', () => {
    const parser = new IfcStreamingParser(stepSample);
    parser.parseHeader();
    parser.scanDataSection();

    const bldg = parser.getRecord(3);
    expect(bldg).toBeDefined();
    expect(bldg?.type).toBe('IFCBUILDING');
    expect(parser.hasRecord(2)).toBe(true);
    expect(parser.hasRecord(999)).toBe(false);
  });
});
