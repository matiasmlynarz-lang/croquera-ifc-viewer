import { describe, it, expect } from 'vitest';
import { Vec3, GuidUtils, GeometryTolerance, IfcStepParser } from '../src';

describe('@croquera/ifc-core Unit Tests', () => {
  it('correctly creates and validates IFC GUIDs', () => {
    const guid = GuidUtils.createIfcGuid();
    expect(guid).toHaveLength(22);
    expect(GuidUtils.isIfcGuid(guid)).toBe(true);

    const uuid = GuidUtils.ifcGuidToUuid(guid);
    expect(uuid).toHaveLength(36);
    expect(GuidUtils.uuidToIfcGuid(uuid)).toBe(guid);
  });

  it('performs vector math with GeometryTolerance', () => {
    const v1 = new Vec3(1, 2, 3);
    const v2 = new Vec3(4, 5, 6);
    const cross = v1.cross(v2);
    expect(cross.dot(v1)).toBeCloseTo(0, 5);
    expect(cross.dot(v2)).toBeCloseTo(0, 5);
    expect(GeometryTolerance.MATH_EPSILON).toBeLessThan(1e-4);
  });

  it('parses basic ISO-10303-21 STEP records', () => {
    const stepSample = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2026-10-21',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Test Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Default Site',$,$,$,$,$,$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
    `;

    const parser = new IfcStepParser(stepSample);
    parser.parse();

    const projectRec = parser.getRecord(1);
    expect(projectRec).toBeDefined();
    expect(projectRec?.type).toBe('IFCPROJECT');
    expect(projectRec?.params[0]).toBe('0$r_g_0000000000000001');

    const siteRec = parser.getRecord(2);
    expect(siteRec).toBeDefined();
    expect(siteRec?.type).toBe('IFCSITE');
  });
});
