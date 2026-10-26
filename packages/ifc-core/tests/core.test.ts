import { describe, it, expect } from 'vitest';
import { Vec3, GuidUtils, GeometryTolerance, IfcStepParser, IfcStepImporter, IfcWorkerClient } from '../src';

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

  it('correctly marks IfcOpeningElement chunks as hidden: true', () => {
    const stepWithOpening = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_opening.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Test Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Default Site',$,$,$,$,$,$,$,$,$,$,$);
#3= IFCBUILDING('0$r_g_0000000000000003',$,'Default Building',$,$,$,$,$,$,$,$,$);
#4= IFCBUILDINGSTOREY('0$r_g_0000000000000004',$,'Storey 1',$,$,$,$,$,$,0.0);
#10= IFCCARTESIANPOINT((0.,0.,0.));
#11= IFCDIRECTION((0.,0.,1.));
#12= IFCDIRECTION((1.,0.,0.));
#13= IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14= IFCLOCALPLACEMENT($,#13);
#20= IFCCARTESIANPOINT((0.,0.,0.));
#21= IFCCARTESIANPOINT((1.,0.,0.));
#22= IFCCARTESIANPOINT((1.,1.,0.));
#23= IFCCARTESIANPOINT((0.,1.,0.));
#24= IFCPOLYLOOP((#20,#21,#22,#23));
#25= IFCFACEOUTERBOUND(#24,.T.);
#26= IFCFACE((#25));
#27= IFCCLOSEDSHELL((#26));
#28= IFCFACETEDBREP(#27);
#29= IFCSHAPEREPRESENTATION($,'Body','Brep',(#28));
#30= IFCPRODUCTDEFINITIONSHAPE($,$,(#29));
#31= IFCOPENINGELEMENT('0$r_g_0000000000000010',$,'Opening 1',$,$,#14,#30,$,.OPENING.);
#40= IFCRELAGGREGATES('0$r_g_0000000000000020',$,$,$,#4,(#31));
ENDSEC;
END-ISO-10303-21;
    `;

    const importer = new IfcStepImporter(stepWithOpening);
    importer.prepareImport();
    const chunks: any[] = [];
    importer.extractGeometryChunks(100, (chunk) => {
      chunks.push(...chunk.elements);
    });

    const openingElements = chunks.filter((el) => el.ifcType === 'IfcOpeningElement');
    expect(openingElements.length).toBeGreaterThan(0);
    for (const el of openingElements) {
      expect(el.hidden).toBe(true);
    }
  });

  it('resolves element property sets on-demand via IfcWorkerClient IPC', async () => {
    const stepWithPsets = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_psets.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Test Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Default Site',$,$,$,$,$,$,$,$,$,$,$);
#3= IFCBUILDING('0$r_g_0000000000000003',$,'Default Building',$,$,$,$,$,$,$,$,$);
#4= IFCBUILDINGSTOREY('0$r_g_0000000000000004',$,'Storey 1',$,$,$,$,$,$,0.0);
#10= IFCCARTESIANPOINT((0.,0.,0.));
#11= IFCDIRECTION((0.,0.,1.));
#12= IFCDIRECTION((1.,0.,0.));
#13= IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14= IFCLOCALPLACEMENT($,#13);
#20= IFCWALL('0$r_g_0000000000000010',$,'Wall 100',$,$,#14,$,$,.SOLIDWALL.);
#21= IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.T.),$);
#22= IFCPROPERTYSINGLEVALUE('AcousticRating',$,IFCLABEL('STC 50'),$);
#23= IFCPROPERTYSET('0$r_g_0000000000000020',$,'Pset_WallCommon',$,(#21,#22));
#24= IFCRELDEFINESBYPROPERTIES('0$r_g_0000000000000030',$,$,$,(#20),#23);
ENDSEC;
END-ISO-10303-21;
    `;

    const buffer = new TextEncoder().encode(stepWithPsets).buffer;
    const client = new IfcWorkerClient();
    await client.parseFile(buffer, 100, () => {});

    // Request Psets for wall (#20)
    const psets = await client.resolveProperties(20);
    expect(psets).toBeDefined();
    expect(psets.Pset_WallCommon).toBeDefined();
    expect(psets.Pset_WallCommon.LoadBearing).toEqual({ type: 'IfcBoolean', value: true });
    expect(psets.Pset_WallCommon.AcousticRating).toEqual({ type: 'IfcLabel', value: 'STC 50' });
  });
});

