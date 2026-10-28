import { describe, it, expect } from 'vitest';
import {
  IfcStepImporter,
  IFC_PRIORITY_STRUCTURAL_TYPES,
} from '../src/importer/IfcStepImporter';
import { GeometryPrototypeDetector } from '../src/detector/GeometryPrototypeDetector';

describe('Issue 2.3: Preservation of Sub-Meshes & Non-Faceted Assemblies in extractDeferredInstances', () => {
  it('preserves all sub-meshes of a multi-component mapped item (e.g. furniture with multiple parts)', () => {
    // IFC with an IFCFURNISHINGELEMENT whose shape representation has 1 IFCMAPPEDITEM
    // pointing to an IFCSHAPEREPRESENTATION with 2 distinct geometric items (e.g. Seat + Frame)
    const ifcContent = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_furniture.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Site',$,$,$,$,$,$,$,$,$,$,$);
#3= IFCBUILDING('0$r_g_0000000000000003',$,'Building',$,$,$,$,$,$,$,$,$);
#4= IFCBUILDINGSTOREY('0$r_g_0000000000000004',$,'Storey 1',$,$,$,$,$,$,0.0);

#10= IFCCARTESIANPOINT((0.,0.,0.));
#11= IFCDIRECTION((0.,0.,1.));
#12= IFCDIRECTION((1.,0.,0.));
#13= IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14= IFCLOCALPLACEMENT($,#13);

/* Sub-Mesh 1 (Seat / Plate) */
#20= IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.)));
#21= IFCTRIANGULATEDFACESET(#20,$,.F.,((1,2,3)),$);

/* Sub-Mesh 2 (Legs / Frame with distinct dimensions) */
#30= IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(3.,0.,0.),(3.,4.,0.)));
#31= IFCTRIANGULATEDFACESET(#30,$,.F.,((1,2,3)),$);

/* Master Shape Representation containing both parts */
#40= IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#21,#31));
#41= IFCREPRESENTATIONMAP(#13,#40);

/* Mapped item referencing the map */
#42= IFCMAPPEDITEM(#41,#13);
#43= IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#42));
#44= IFCPRODUCTDEFINITIONSHAPE($,$,(#43));

/* Deferred element: IFCFURNISHINGELEMENT */
#50= IFCFURNISHINGELEMENT('0$r_g_0000000000000050',$,'Executive Office Chair',$,$,#14,#44,$,$);
#60= IFCRELAGGREGATES('0$r_g_0000000000000060',$,$,$,#4,(#50));

ENDSEC;
END-ISO-10303-21;
`;

    const importer = new IfcStepImporter(ifcContent);
    importer.setProductTypesFilter(IFC_PRIORITY_STRUCTURAL_TYPES);
    importer.prepareImport();

    const detector = new GeometryPrototypeDetector();
    const emittedBatches: any[] = [];
    const emittedPrototypes: any[] = [];

    const counts = importer.extractDeferredInstances(
      detector,
      (batch) => emittedBatches.push(batch),
      (protoChunk) => emittedPrototypes.push(protoChunk)
    );

    // 1. Prototype chunks must include the container GROUP for the product
    const allPrototypeElements = emittedPrototypes.flatMap((p) => p.elements);
    const containerGroup = allPrototypeElements.find((e) => e.type === 'GROUP' && e.name === 'Executive Office Chair');
    expect(containerGroup).toBeDefined();
    expect(containerGroup.id).toBe('0$r_g_0000000000000050');

    // 2. Both sub-meshes must be registered as prototypes
    const partPrototypes = allPrototypeElements.filter((e) => e.name && e.name.includes('(Part'));
    expect(partPrototypes.length).toBe(2);

    // 3. Both parts must be emitted as instances under the GROUP container
    const allInstances = emittedBatches.flatMap((b) => b.instances);
    expect(allInstances.length).toBe(2);
    for (const inst of allInstances) {
      expect(inst.parentId).toBe('0$r_g_0000000000000050');
      expect(inst.name).toMatch(/Executive Office Chair \(Part [12]\)/);
    }
  });

  it('correctly processes and extracts non-faceted items in Case 2 assemblies without dropping them', () => {
    // IFC with an assembly having allGeomRefs.length > 1, where items are IFCTRIANGULATEDFACESET
    // (which cannot be extracted via extractRawPositionsFromItem BRep shells, requiring single rebuildMeshFromItem fallback)
    const ifcAssembly = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_assembly.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Site',$,$,$,$,$,$,$,$,$,$,$);
#3= IFCBUILDING('0$r_g_0000000000000003',$,'Building',$,$,$,$,$,$,$,$,$);
#4= IFCBUILDINGSTOREY('0$r_g_0000000000000004',$,'Storey 1',$,$,$,$,$,$,0.0);

#10= IFCCARTESIANPOINT((0.,0.,0.));
#11= IFCDIRECTION((0.,0.,1.));
#12= IFCDIRECTION((1.,0.,0.));
#13= IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14= IFCLOCALPLACEMENT($,#13);

/* Discrete Item 1 */
#20= IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(2.,2.,0.)));
#21= IFCTRIANGULATEDFACESET(#20,$,.F.,((1,2,3)),$);

/* Discrete Item 2 (distinct dimensions) */
#30= IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(5.,0.,0.),(5.,8.,0.)));
#31= IFCTRIANGULATEDFACESET(#30,$,.F.,((1,2,3)),$);

/* Shape representation containing multiple geometric items directly -> allGeomRefs.length === 2 (Case 2) */
#40= IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#21,#31));
#41= IFCPRODUCTDEFINITIONSHAPE($,$,(#40));

/* Deferred assembly: IFCRAILING */
#50= IFCRAILING('0$r_g_0000000000000055',$,'Modular Guard Railing',$,$,#14,#41,$,.HANDRAIL.);
#60= IFCRELAGGREGATES('0$r_g_0000000000000065',$,$,$,#4,(#50));

ENDSEC;
END-ISO-10303-21;
`;

    const importer = new IfcStepImporter(ifcAssembly);
    importer.setProductTypesFilter(IFC_PRIORITY_STRUCTURAL_TYPES);
    importer.prepareImport();

    const detector = new GeometryPrototypeDetector();
    const emittedBatches: any[] = [];
    const emittedPrototypes: any[] = [];

    const counts = importer.extractDeferredInstances(
      detector,
      (batch) => emittedBatches.push(batch),
      (protoChunk) => emittedPrototypes.push(protoChunk)
    );

    // 1. Must emit GROUP container for the railing assembly
    const allPrototypeElements = emittedPrototypes.flatMap((p) => p.elements);
    const containerGroup = allPrototypeElements.find((e) => e.type === 'GROUP' && e.name === 'Modular Guard Railing');
    expect(containerGroup).toBeDefined();

    // 2. Both discrete parts must be extracted without being dropped
    const partPrototypes = allPrototypeElements.filter((e) => e.name && e.name.includes('(Part)'));
    expect(partPrototypes.length).toBe(2);

    // 3. Both parts must be emitted as instances
    const allInstances = emittedBatches.flatMap((b) => b.instances);
    expect(allInstances.length).toBe(2);
    for (const inst of allInstances) {
      expect(inst.parentId).toBe('0$r_g_0000000000000055');
      expect(inst.name).toBe('Modular Guard Railing (Part)');
    }
  });

  it('collapses congruent repetitive items in an assembly into a single prototype with full instance count', () => {
    // IFC with an assembly having 3 identical baluster items translated in space
    const ifcCongruentAssembly = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_balusters.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Site',$,$,$,$,$,$,$,$,$,$,$);
#3= IFCBUILDING('0$r_g_0000000000000003',$,'Building',$,$,$,$,$,$,$,$,$);
#4= IFCBUILDINGSTOREY('0$r_g_0000000000000004',$,'Storey 1',$,$,$,$,$,$,0.0);

#10= IFCCARTESIANPOINT((0.,0.,0.));
#11= IFCDIRECTION((0.,0.,1.));
#12= IFCDIRECTION((1.,0.,0.));
#13= IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14= IFCLOCALPLACEMENT($,#13);

/* 3 Congruent Baluster items (identical geometry, shifted in X) */
#20= IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(0.1,0.,0.),(0.1,0.1,0.)));
#21= IFCTRIANGULATEDFACESET(#20,$,.F.,((1,2,3)),$);

#30= IFCCARTESIANPOINTLIST3D(((1.,0.,0.),(1.1,0.,0.),(1.1,0.1,0.)));
#31= IFCTRIANGULATEDFACESET(#30,$,.F.,((1,2,3)),$);

#40= IFCCARTESIANPOINTLIST3D(((2.,0.,0.),(2.1,0.,0.),(2.1,0.1,0.)));
#41= IFCTRIANGULATEDFACESET(#40,$,.F.,((1,2,3)),$);

#50= IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#21,#31,#41));
#51= IFCPRODUCTDEFINITIONSHAPE($,$,(#50));

#60= IFCRAILING('0$r_g_0000000000000077',$,'Baluster Array',$,$,#14,#51,$,.BALUSTER.);
#70= IFCRELAGGREGATES('0$r_g_0000000000000088',$,$,$,#4,(#60));

ENDSEC;
END-ISO-10303-21;
`;

    const importer = new IfcStepImporter(ifcCongruentAssembly);
    importer.setProductTypesFilter(IFC_PRIORITY_STRUCTURAL_TYPES);
    importer.prepareImport();

    const detector = new GeometryPrototypeDetector();
    const emittedBatches: any[] = [];
    const emittedPrototypes: any[] = [];

    importer.extractDeferredInstances(
      detector,
      (batch) => emittedBatches.push(batch),
      (protoChunk) => emittedPrototypes.push(protoChunk)
    );

    const allPrototypeElements = emittedPrototypes.flatMap((p) => p.elements);
    // 1 container GROUP
    const containerGroup = allPrototypeElements.find((e) => e.type === 'GROUP' && e.name === 'Baluster Array');
    expect(containerGroup).toBeDefined();

    // Exactly 1 prototype for all 3 congruent balusters!
    const partPrototypes = allPrototypeElements.filter((e) => e.name && e.name.includes('(Part)'));
    expect(partPrototypes.length).toBe(1);

    // Exactly 3 instances emitted under the Baluster Array container GROUP
    const allInstances = emittedBatches.flatMap((b) => b.instances);
    expect(allInstances.length).toBe(3);
    for (const inst of allInstances) {
      expect(inst.parentId).toBe('0$r_g_0000000000000077');
      expect(inst.name).toBe('Baluster Array (Part)');
    }
  });

  it('preserves all sub-meshes of 1U2OcJIA1DzBQam5oqO5Op and 0X7uCi5JnAz9SlhGkXe58J when paired with Box/BoundingBox shape representations (model_3_arc.ifc)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const modelPath = path.resolve(process.cwd(), 'ModelosBenchmark/model_3_arc.ifc');
    if (!fs.existsSync(modelPath)) return;

    const ifcContent = fs.readFileSync(modelPath, 'utf8');
    const importer = new IfcStepImporter(ifcContent);
    importer.setProductTypesFilter(IFC_PRIORITY_STRUCTURAL_TYPES);
    importer.prepareImport();

    // 1. Verify hydrateBrepMesh merges all sub-meshes of IfcMappedItem (#129722 and #63870)
    const hydratedTable = importer.hydrateBrepMesh(129722, false);
    expect(hydratedTable).not.toBeNull();
    // #129648 has 45 IFCFACETEDBREP items (~15,000 faces total, far above the 18 faces of subMeshes[0])
    expect(hydratedTable!.polyMesh.faces.size).toBeGreaterThan(1000);

    const hydratedAwning = importer.hydrateBrepMesh(63870, false);
    expect(hydratedAwning).not.toBeNull();
    // #61459 has 13 IFCFACETEDBREP items (~5,500 faces total, far above the 6 faces of subMeshes[0])
    expect(hydratedAwning!.polyMesh.faces.size).toBeGreaterThan(500);

    // 2. Verify extractDeferredInstances emits all parts and caches shared IfcRepresentationMaps
    const detector = new GeometryPrototypeDetector();
    const emittedBatches: any[] = [];
    const emittedPrototypes: any[] = [];

    importer.extractDeferredInstances(
      detector,
      (batch) => emittedBatches.push(batch),
      (protoChunk) => emittedPrototypes.push(protoChunk),
      ['IFCFURNISHINGELEMENT', 'IFCBUILDINGELEMENTPROXY']
    );

    const allPrototypeElements = emittedPrototypes.flatMap((p) => p.elements);
    const allInstances = emittedBatches.flatMap((b) => b.instances);

    // Check 1U2OcJIA1DzBQam5oqO5Op (Table + 6 chairs)
    const tableGroup = allPrototypeElements.find((e) => e.id === '1U2OcJIA1DzBQam5oqO5Op' && e.type === 'GROUP');
    const tableDirectInst = allInstances.find((i) => i.id === '1U2OcJIA1DzBQam5oqO5Op');
    const tableChildren = allInstances.filter((i) => i.parentId === '1U2OcJIA1DzBQam5oqO5Op');
    expect(Boolean(tableGroup && tableChildren.length >= 2) || Boolean(tableDirectInst)).toBe(true);

    // Check 0X7uCi5JnAz9SlhGkXe58J (Awning with 13 B-Rep solids)
    const awningGroup = allPrototypeElements.find((e) => e.id === '0X7uCi5JnAz9SlhGkXe58J' && e.type === 'GROUP');
    expect(awningGroup).toBeDefined();
    const awningChildren = allInstances.filter((i) => i.parentId === '0X7uCi5JnAz9SlhGkXe58J');
    expect(awningChildren.length).toBe(13);
  }, 60000);
});
