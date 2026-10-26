import { describe, it, expect } from 'vitest';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';

describe('Fast-Path Triangulated Face Set (Issue 1.2)', () => {
  const sampleTriangulatedIfc = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_triangulated.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
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
#20= IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(2.,3.,0.),(0.,3.,0.)));
#21= IFCTRIANGULATEDFACESET(#20,$,.F.,((1,2,3),(1,3,4)),$);
#22= IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#21));
#23= IFCPRODUCTDEFINITIONSHAPE($,$,(#22));
#24= IFCWALL('0$r_g_0000000000000010',$,'Triangulated Wall',$,$,#14,#23,$,.SOLIDWALL.);
#30= IFCRELAGGREGATES('0$r_g_0000000000000020',$,$,$,#4,(#24));
ENDSEC;
END-ISO-10303-21;
`;

  it('directly extracts Float32Array and Uint32Array without instantiating PolyMesh', () => {
    const importer = new IfcStepImporter(sampleTriangulatedIfc);
    importer.prepareImport();

    const chunks = importer.extractGeometryChunks(10);

    expect(chunks.length).toBeGreaterThan(0);
    const allElements = chunks.flatMap((c) => c.elements);

    // Should contain GROUP container and child GEOMETRY_ENTITY
    const group = allElements.find((el) => el.type === 'GROUP');
    expect(group).toBeDefined();
    expect(group.name).toBe('Triangulated Wall');

    const geomEntity = allElements.find((el) => el.type === 'GEOMETRY_ENTITY');
    expect(geomEntity).toBeDefined();
    expect(geomEntity.parentId).toBe(group.id);

    // Positions: 4 vertices * 3 floats = 12 floats
    expect(geomEntity.positions).toBeInstanceOf(Float32Array);
    expect(geomEntity.positions.length).toBe(4 * 3);

    // Indices: 2 triangles * 3 indices = 6 indices
    expect(geomEntity.indices).toBeInstanceOf(Uint32Array);
    expect(geomEntity.indices.length).toBe(6);
    expect(Array.from(geomEntity.indices)).toEqual([0, 1, 2, 0, 2, 3]);

    // Normals: 4 vertex normals * 3 floats = 12 floats
    expect(geomEntity.normals).toBeInstanceOf(Float32Array);
    expect(geomEntity.normals.length).toBe(4 * 3);

    // Check normal unit length
    for (let i = 0; i < 4; i++) {
      const nx = geomEntity.normals[i * 3];
      const ny = geomEntity.normals[i * 3 + 1];
      const nz = geomEntity.normals[i * 3 + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      expect(len).toBeCloseTo(1.0, 3);
    }
  });
});
