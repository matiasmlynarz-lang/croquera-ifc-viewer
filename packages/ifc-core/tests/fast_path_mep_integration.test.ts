import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';
import { DirectCylinderGenerator } from '../src/geometry/DirectCylinderGenerator';

describe('Fast-Path MEP End-to-End Integration', () => {
  it('extracts direct IfcExtrudedAreaSolid with IfcCircleProfileDef via fast-path', () => {
    const stepContent = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('pipe_test.ifc','2026-10-27',('Croquera'),('Croquera'),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#10=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);

#40=IFCCIRCLEPROFILEDEF(.AREA.,'PipeProfile',$,0.1);
#41=IFCEXTRUDEDAREASOLID(#40,#4,#2,2.5);
#42=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#41));
#43=IFCPRODUCTDEFINITIONSHAPE($,$,(#42));
#50=IFCPIPESEGMENT('0000000000000000000010',$,'ColdWaterPipe',$,$,#5,#43,$);
ENDSEC;
END-ISO-10303-21;
    `;

    const importer = new IfcStepImporter(stepContent);
    importer.prepareImport();
    const pipeRec = (importer as any).records.get(50);
    expect(pipeRec).toBeDefined();

    const result = importer.rebuildProductEntities(pipeRec, null);
    expect(result).not.toBeNull();
    expect(result!.rootEntity.type).toBe('GROUP');
    expect(result!.rootEntity.name).toBe('ColdWaterPipe');
    expect(result!.children.length).toBe(1);

    const child = result!.children[0];
    expect(child.type).toBe('GEOMETRY_ENTITY');
    expect(child.rawGeometry).toBeDefined();

    const raw = child.rawGeometry!;
    expect(raw.positions.length).toBeGreaterThan(0);
    expect(raw.normals.length).toBe(raw.positions.length);
    expect(raw.indices.length).toBeGreaterThan(0);
    expect(raw.edgesBuffer).toBeDefined();
    expect(raw.edgesBuffer!.length).toBeGreaterThan(0);

    // Height of extrusion along Z in IFC is 2.5m.
    // In canonical Croquera basis: Y_croq = Z_ifc, so Y bounds should be [0, 2.5]
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < raw.positions.length; i += 3) {
      const y = raw.positions[i];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    expect(minY).toBeCloseTo(0, 3);
    expect(maxY).toBeCloseTo(2.5, 3);
  });

  it('extracts MappedItem IfcFlowSegment with IfcCircleHollowProfileDef and applies transforms', () => {
    const stepContent = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('mapped_pipe.ifc','2026-10-27',('Croquera'),('Croquera'),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#10=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);

#40=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,'HollowPipe',$,0.15,0.01);
#41=IFCEXTRUDEDAREASOLID(#40,#4,#2,4.0);
#42=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#41));
#43=IFCREPRESENTATIONMAP(#4,#42);
#44=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);
#45=IFCMAPPEDITEM(#43,#44);
#46=IFCSHAPEREPRESENTATION(#20,'Body','MappedRepresentation',(#45));
#47=IFCPRODUCTDEFINITIONSHAPE($,$,(#46));
#60=IFCFLOWSEGMENT('0000000000000000000020',$,'DuctSegment',$,$,#5,#47,$);
ENDSEC;
END-ISO-10303-21;
    `;

    const importer = new IfcStepImporter(stepContent);
    importer.prepareImport();
    const ductRec = (importer as any).records.get(60);
    expect(ductRec).toBeDefined();

    const result = importer.rebuildProductEntities(ductRec, null);
    expect(result).not.toBeNull();
    expect(result!.rootEntity.type).toBe('GROUP');
    expect(result!.children.length).toBe(1);

    const raw = result!.children[0].rawGeometry!;
    // Y bounds should span [0, 4.0] in Croquera canonical space
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < raw.positions.length; i += 3) {
      const y = raw.positions[i];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    expect(minY).toBeCloseTo(0, 3);
    expect(maxY).toBeCloseTo(4.0, 3);
  });

  it('safely skips fast-path when product has boolean openings', () => {
    const stepContent = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('pipe_opening.ifc','2026-10-27',('Croquera'),('Croquera'),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#10=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);

#40=IFCCIRCLEPROFILEDEF(.AREA.,'PipeProfile',$,0.1);
#41=IFCEXTRUDEDAREASOLID(#40,#4,#2,2.5);
#42=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#41));
#43=IFCPRODUCTDEFINITIONSHAPE($,$,(#42));
#50=IFCPIPESEGMENT('0000000000000000000010',$,'PerforatedPipe',$,$,#5,#43,$);
#70=IFCOPENINGELEMENT('0000000000000000000099',$,'Opening',$,$,#5,#43,$);
#80=IFCRELVOIDSELEMENT('0000000000000000000098',$,$,$,#50,#70);
ENDSEC;
END-ISO-10303-21;
    `;

    const importer = new IfcStepImporter(stepContent);
    importer.prepareImport();
    const pipeRec = (importer as any).records.get(50);
    expect(pipeRec).toBeDefined();

    // Verify hostToOpeningsStepMap is populated
    expect((importer as any).hostToOpeningsStepMap.has(50)).toBe(true);

    // Fast MEP method should return null to allow CSG opening cutter to take over
    const fastMep = (importer as any).tryBuildFastMepEntities(pipeRec, null);
    expect(fastMep).toBeNull();
  });
});
