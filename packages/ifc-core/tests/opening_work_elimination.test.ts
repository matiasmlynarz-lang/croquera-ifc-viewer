import { describe, it, expect, vi } from 'vitest';
import { IfcStepImporter } from '../src';

describe('Optimization 2.4: IfcOpeningElement Work and Transfer Elimination', () => {
  const stepWithOpeningAndWall = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_opening_elim.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
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

/* Wall geometry (Faceted Brep box 0..5, 0..0.2, 0..3) */
#20= IFCCARTESIANPOINT((0.,0.,0.));
#21= IFCCARTESIANPOINT((5.,0.,0.));
#22= IFCCARTESIANPOINT((5.,0.2,0.));
#23= IFCCARTESIANPOINT((0.,0.2,0.));
#24= IFCPOLYLOOP((#20,#21,#22,#23));
#25= IFCFACEOUTERBOUND(#24,.T.);
#26= IFCFACE((#25));
#27= IFCCLOSEDSHELL((#26));
#28= IFCFACETEDBREP(#27);
#29= IFCSHAPEREPRESENTATION($,'Body','Brep',(#28));
#30= IFCPRODUCTDEFINITIONSHAPE($,$,(#29));
#31= IFCWALL('0$r_g_0000000000000010',$,'Wall 1',$,$,#14,#30,$,.SOLIDWALL.);

/* Opening geometry (Faceted Brep box 1..2, -0.1..0.3, 0..2) */
#40= IFCCARTESIANPOINT((1.,-0.1,0.));
#41= IFCCARTESIANPOINT((2.,-0.1,0.));
#42= IFCCARTESIANPOINT((2.,0.3,0.));
#43= IFCCARTESIANPOINT((1.,0.3,0.));
#44= IFCPOLYLOOP((#40,#41,#42,#43));
#45= IFCFACEOUTERBOUND(#44,.T.);
#46= IFCFACE((#45));
#47= IFCCLOSEDSHELL((#46));
#48= IFCFACETEDBREP(#47);
#49= IFCSHAPEREPRESENTATION($,'Body','Brep',(#48));
#50= IFCPRODUCTDEFINITIONSHAPE($,$,(#49));
#51= IFCOPENINGELEMENT('0$r_g_0000000000000020',$,'Opening 1',$,$,#14,#50,$,.OPENING.);

/* Wall - Opening Void relationship */
#60= IFCRELVOIDSELEMENT('0$r_g_0000000000000030',$,$,$,#31,#51);
#70= IFCRELAGGREGATES('0$r_g_0000000000000040',$,$,$,#4,(#31,#51));
ENDSEC;
END-ISO-10303-21;
  `;

  it('suppresses GPU buffers, geometry cloning, and transferables for IfcOpeningElement in extractGeometryChunks', () => {
    const importer = new IfcStepImporter(stepWithOpeningAndWall);
    importer.prepareImport();

    const chunks: any[] = [];
    const allTransferables: ArrayBuffer[] = [];

    importer.extractGeometryChunks(100, (chunk, transferables) => {
      chunks.push(...chunk.elements);
      if (transferables) {
        allTransferables.push(...transferables);
      }
    });

    const openingElements = chunks.filter((el) => el.ifcType === 'IfcOpeningElement');
    expect(openingElements.length).toBe(1);

    const opening = openingElements[0];
    expect(opening.type).toBe('GROUP');
    expect(opening.hidden).toBe(true);
    expect(opening.positions.length).toBe(0);
    expect(opening.normals.length).toBe(0);
    expect(opening.indices.length).toBe(0);
    expect(opening.edgesBuffer.length).toBe(0);

    // No opening geometry element should be emitted
    const openingGeoElements = chunks.filter((el) => el.isOpeningGeometry === true);
    expect(openingGeoElements.length).toBe(0);

    // Pset_Opening VoidsElements relation should still be preserved
    expect(opening.psets?.Pset_Opening?.VoidsElements?.value).toBeDefined();
    expect(opening.psets.Pset_Opening.VoidsElements.value).toContain('0$r_g_0000000000000010');
  });

  it('memoizes opening PolyMesh in carveOpeningsIntoMesh avoiding repeated rebuilds', () => {
    const importer = new IfcStepImporter(stepWithOpeningAndWall);
    importer.prepareImport();

    const spyRebuild = vi.spyOn(importer as any, 'rebuildProductEntity');

    // Process geometry chunks
    importer.extractGeometryChunks(100);

    // Opening step ID is 51
    const openingCallsFirstRun = spyRebuild.mock.calls.filter((call) => call[0].id === 51);
    expect(openingCallsFirstRun.length).toBe(1);

    // Directly call carveOpeningsIntoMesh again on another mesh to verify cache hit
    const dummyMesh = {
      faces: new Map(),
      vertices: new Map(),
      edges: new Map(),
    } as any;

    (importer as any).carveOpeningsIntoMesh(31, dummyMesh);

    const openingCallsAfterSecondRun = spyRebuild.mock.calls.filter((call) => call[0].id === 51);
    // Call count must still be exactly 1 due to openingMeshCache memoization
    expect(openingCallsAfterSecondRun.length).toBe(1);

    // Verify cache is cleared on prepareImport()
    (importer as any).isPrepared = false;
    importer.prepareImport();
    expect((importer as any).openingMeshCache.size).toBe(0);
  });
});
