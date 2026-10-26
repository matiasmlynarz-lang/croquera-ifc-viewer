import { describe, it, expect } from 'vitest';
import {
  IfcStepImporter,
  IFC_PRIORITY_STRUCTURAL_TYPES,
} from '../src/importer/IfcStepImporter';
import { GeometryPrototypeDetector } from '../src/detector/GeometryPrototypeDetector';

describe('Issue 2.1: Complete Deferred Product Types Partition', () => {
  it('mathematically partitions ALL_PRODUCT_TYPES into Priority and Deferred subsets with zero omissions', () => {
    const allTypes = IfcStepImporter.ALL_PRODUCT_TYPES;
    const priorityTypes = IFC_PRIORITY_STRUCTURAL_TYPES;
    const deferredTypes = IfcStepImporter.DEFERRED_PRODUCT_TYPES;

    expect(allTypes.length).toBe(120);
    expect(priorityTypes.size).toBe(24);
    expect(deferredTypes.length).toBe(96);

    // 1. Zero intersection: Priority ∩ Deferred = ∅
    for (const dType of deferredTypes) {
      expect(priorityTypes.has(dType)).toBe(false);
    }

    // 2. Full coverage: Priority ∪ Deferred = ALL_PRODUCT_TYPES
    const combinedSet = new Set<string>([...priorityTypes, ...deferredTypes]);
    expect(combinedSet.size).toBe(120);
    for (const aType of allTypes) {
      expect(combinedSet.has(aType)).toBe(true);
    }

    // 3. Verify critical infrastructure earthworks, structures, terrain and signage are recognized in Priority
    expect(priorityTypes.has('IFCSITE')).toBe(true);
    expect(priorityTypes.has('IFCSPACE')).toBe(true);
    expect(priorityTypes.has('IFCOPENINGELEMENT')).toBe(true);
    expect(priorityTypes.has('IFCEARTHWORKSELEMENT')).toBe(true);
    expect(priorityTypes.has('IFCEARTHWORKSCUT')).toBe(true);
    expect(priorityTypes.has('IFCEARTHWORKSFILL')).toBe(true);
    expect(priorityTypes.has('IFCMEMBER')).toBe(true);
    expect(priorityTypes.has('IFCPLATE')).toBe(true);
    expect(priorityTypes.has('IFCSIGN')).toBe(true);
    expect(priorityTypes.has('IFCSIGNAL')).toBe(true);

    // 4. Verify critical previously omitted types exist in Deferred
    const criticalPreviouslyLost = [
      'IFCCIVILELEMENT',
      'IFCGEOGRAPHICELEMENT',
      'IFCPAVEMENT',
      'IFCKERB',
      'IFCPILE',
      'IFCDEEPFOUNDATION',
      'IFCREINFORCINGBAR',
      'IFCWALLELEMENTEDCASE',
      'IFCSLABELEMENTEDCASE',
      'IFCLIGHTFIXTURE',
      'IFCSANITARYTERMINAL',
      'IFCVALVE',
      'IFCPUMP',
      'IFCCABLESEGMENT',
    ];

    for (const expectedType of criticalPreviouslyLost) {
      expect(deferredTypes).toContain(expectedType);
    }
  });

  it('ingests civil infrastructure, foundations and MEP elements in Phase 2 during phased import (> 5 MB)', () => {
    const samplePhasedIfc = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_phased.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
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

#20= IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(2.,3.,0.)));
#21= IFCTRIANGULATEDFACESET(#20,$,.F.,((1,2,3)),$);
#22= IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#21));
#23= IFCPRODUCTDEFINITIONSHAPE($,$,(#22));

#31= IFCWALL('0$r_g_0000000000000010',$,'Structural Wall',$,$,#14,#23,$,.SOLIDWALL.);
#32= IFCCIVILELEMENT('0$r_g_0000000000000020',$,'Bridge Deck Civil',$,$,#14,#23,$);
#33= IFCPILE('0$r_g_0000000000000030',$,'Foundation Pile',$,$,#14,#23,$,$);
#34= IFCLIGHTFIXTURE('0$r_g_0000000000000040',$,'Tunnel Light Fixture',$,$,#14,#23,$,$);

#50= IFCRELAGGREGATES('0$r_g_0000000000000050',$,$,$,#4,(#31,#32,#33,#34));
ENDSEC;
END-ISO-10303-21;
`;

    const importer = new IfcStepImporter(samplePhasedIfc);
    // Simulate IfcImportWorkerCore behavior on files > 5 MB:
    importer.setProductTypesFilter(IFC_PRIORITY_STRUCTURAL_TYPES);
    importer.prepareImport();

    // Stage 1 & 2
    const stage1 = importer.extractSpatialHierarchy();
    expect(stage1).toBeDefined();

    const stage2 = importer.extractProductBounds();
    // Phase 1 only contains the structural wall
    expect(stage2.totalElements).toBe(1);
    expect(stage2.elements[0].name).toBe('Structural Wall');

    // Phase 1: Geometry chunks
    const phase1Chunks = importer.extractGeometryChunks(10);
    const phase1Elements = phase1Chunks.flatMap((c) => c.elements);
    const wallEntity = phase1Elements.find((e) => e.name === 'Structural Wall');
    expect(wallEntity).toBeDefined();

    // Phase 2: Deferred instances
    const detector = new GeometryPrototypeDetector();
    const emittedBatches: any[] = [];
    const emittedPrototypes: any[] = [];

    const counts = importer.extractDeferredInstances(
      detector,
      (batch) => emittedBatches.push(batch),
      (protoChunk) => emittedPrototypes.push(protoChunk)
    );

    // Phase 2 must ingest the 3 deferred elements (#32 IFCCIVILELEMENT, #33 IFCPILE, #34 IFCLIGHTFIXTURE)
    const totalDeferred = counts.totalPrototypes + counts.totalInstances;
    expect(totalDeferred).toBe(3);

    // Check all 3 deferred items were ingested
    const allDeferredNames = [
      ...emittedBatches.flatMap((b) => b.instances.map((i: any) => i.name)),
      ...emittedPrototypes.flatMap((p) => p.elements.map((e: any) => e.name)),
    ];

    expect(allDeferredNames).toContain('Bridge Deck Civil');
    expect(allDeferredNames).toContain('Foundation Pile');
    expect(allDeferredNames).toContain('Tunnel Light Fixture');
  });
});
