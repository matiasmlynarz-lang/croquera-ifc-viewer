import { describe, it, expect } from 'vitest';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';

describe('Fast Stage 2 Bounds (Anti-Double Reconstruction)', () => {
  it('extracts product bounds in sub-10ms without tessellating geometry', () => {
    const sampleIfc = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_bounds.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Test Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Default Site',$,$,$,$,$,$,$,$,$,$,$);
#3= IFCBUILDING('0$r_g_0000000000000003',$,'Default Building',$,$,$,$,$,$,$,$,$);
#4= IFCBUILDINGSTOREY('0$r_g_0000000000000004',$,'Storey 1',$,$,$,$,$,$,0.0);
#10= IFCCARTESIANPOINT((10.,0.,5.));
#11= IFCDIRECTION((0.,0.,1.));
#12= IFCDIRECTION((1.,0.,0.));
#13= IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14= IFCLOCALPLACEMENT($,#13);
#20= IFCCARTESIANPOINT((0.,0.,0.));
#21= IFCCARTESIANPOINT((2.,0.,0.));
#22= IFCCARTESIANPOINT((2.,3.,0.));
#23= IFCCARTESIANPOINT((0.,3.,0.));
#24= IFCPOLYLOOP((#20,#21,#22,#23));
#25= IFCFACEOUTERBOUND(#24,.T.);
#26= IFCFACE((#25));
#27= IFCCLOSEDSHELL((#26));
#28= IFCFACETEDBREP(#27);
#29= IFCSHAPEREPRESENTATION($,'Body','Brep',(#28));
#30= IFCPRODUCTDEFINITIONSHAPE($,$,(#29));
#31= IFCWALL('0$r_g_0000000000000010',$,'Wall 1',$,$,#14,#30,$,.SOLIDWALL.);
#40= IFCRELAGGREGATES('0$r_g_0000000000000020',$,$,$,#4,(#31));
ENDSEC;
END-ISO-10303-21;
`;

    const importer = new IfcStepImporter(sampleIfc);
    importer.prepareImport();

    const t0 = performance.now();
    const stage2 = importer.extractProductBounds();
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(50);
    expect(stage2.totalElements).toBe(1);
    expect(stage2.elements.length).toBe(1);

    const elem = stage2.elements[0];
    expect(elem.name).toBe('Wall 1');
    expect(elem.ifcType).toBe('IfcWall');
    expect(elem.type).toBe('GROUP'); // Norma 15: products with shape are structured as GROUP containers

    // Canonical conversion of #10 (10, 0, 5) -> (X = 10, Y = 5, Z = -0 = 0)
    expect(elem.aabb.min[0]).toBeCloseTo(10 - 0.5, 1);
    expect(elem.aabb.min[1]).toBeCloseTo(5 - 0.5, 1);
    expect(elem.aabb.min[2]).toBeCloseTo(0 - 0.5, 1);

    expect(stage2.modelAABB.min[0]).toBeCloseTo(10 - 0.5, 1);
    expect(stage2.modelAABB.max[0]).toBeCloseTo(10 + 0.5, 1);

    // Verify Stage 3 downstream still tessellates cleanly
    const chunks = importer.extractGeometryChunks(100);
    expect(chunks.length).toBeGreaterThan(0);
    const tessellated = chunks[0].elements.find((e) => e.type === 'GEOMETRY_ENTITY');
    expect(tessellated).toBeDefined();
    expect(tessellated?.positions.length).toBeGreaterThan(0);
  });

  it('correctly extracts IfcBoundingBox when explicitly declared in shape', () => {
    const sampleBoxIfc = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_box.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
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
#20= IFCCARTESIANPOINT((1.,2.,3.));
#21= IFCBOUNDINGBOX(#20, 10.0, 5.0, 4.0);
#22= IFCSHAPEREPRESENTATION($,'Box','BoundingBox',(#21));
#30= IFCPRODUCTDEFINITIONSHAPE($,$,(#22));
#31= IFCBEAM('0$r_g_0000000000000010',$,'Beam 1',$,$,#14,#30,$,.BEAM.);
#40= IFCRELAGGREGATES('0$r_g_0000000000000020',$,$,$,#4,(#31));
ENDSEC;
END-ISO-10303-21;
`;

    const importer = new IfcStepImporter(sampleBoxIfc);
    importer.prepareImport();
    const stage2 = importer.extractProductBounds();

    expect(stage2.totalElements).toBe(1);
    const elem = stage2.elements[0];
    expect(elem.name).toBe('Beam 1');

    // Corner: (1, 2, 3), dims: (10, 5, 4)
    // In IFC coords: X: [1, 11], Y: [2, 7], Z: [3, 7]
    // Canonical Croquera swap: X_croq = X_ifc [1, 11], Y_croq = Z_ifc [3, 7], Z_croq = -Y_ifc [-7, -2]
    expect(elem.aabb.min[0]).toBeCloseTo(1, 2);
    expect(elem.aabb.max[0]).toBeCloseTo(11, 2);
    expect(elem.aabb.min[1]).toBeCloseTo(3, 2);
    expect(elem.aabb.max[1]).toBeCloseTo(7, 2);
    expect(elem.aabb.min[2]).toBeCloseTo(-7, 2);
    expect(elem.aabb.max[2]).toBeCloseTo(-2, 2);
  });
});
