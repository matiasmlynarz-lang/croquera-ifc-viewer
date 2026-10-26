import { describe, it, expect } from 'vitest';
import { PolyMesh } from '../src/topology/PolyMesh';
import { Vec3 } from '../src/math/Vec3';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';

describe('Single-Sided Geometry Optimization (Issue 1.2)', () => {
  it('generates single-sided geometry without duplicate back-faces when singleSided=true', () => {
    const mesh = new PolyMesh('test-single-sided');
    // Add a quad (2 triangles)
    const p0 = new Vec3(0, 0, 0);
    const p1 = new Vec3(2, 0, 0);
    const p2 = new Vec3(2, 2, 0);
    const p3 = new Vec3(0, 2, 0);

    mesh.addFace([p0, p1, p2, p3]);

    // 1. Double-sided (default for authoring/modeling tools)
    const doubleGeo = mesh.toThreeGeometry(undefined, false);
    const doublePos = doubleGeo.attributes.position;
    const doubleNorm = doubleGeo.attributes.normal;
    // Quad tessellates into 2 triangles -> 6 vertices front + 6 vertices back = 12 vertices
    expect(doublePos.count).toBe(12);
    expect(doubleNorm.count).toBe(12);
    expect(doubleGeo.groups.length).toBe(2);
    expect(doubleGeo.groups[0].materialIndex).toBe(0); // Front Clay
    expect(doubleGeo.groups[1].materialIndex).toBe(1); // Back Pink

    // 2. Single-sided (fast-path for GPU rendering with THREE.DoubleSide)
    const singleGeo = mesh.toThreeGeometry(undefined, true);
    const singlePos = singleGeo.attributes.position;
    const singleNorm = singleGeo.attributes.normal;

    // Single-sided skips back-faces: exactly 6 vertices (2 triangles)
    expect(singlePos.count).toBe(6);
    expect(singleNorm.count).toBe(6);
    expect(singleGeo.groups.length).toBe(1);
    expect(singleGeo.groups[0].materialIndex).toBe(0);

    // Vertex positions match exactly the front vertices
    for (let i = 0; i < 6 * 3; i++) {
      expect(singlePos.array[i]).toBeCloseTo(doublePos.array[i], 5);
      expect(singleNorm.array[i]).toBeCloseTo(doubleNorm.array[i], 5);
    }
  });

  it('correctly orients outward normals for IfcExtrudedAreaSolid with negative extrusion direction', () => {
    const stepText = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2026-10-23',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Site',$,$,$,$,$,$,$,$,$,$,$);
#3= IFCBUILDING('0$r_g_0000000000000003',$,'Building',$,$,$,$,$,$,$);
#4= IFCBUILDINGSTOREY('0$r_g_0000000000000004',$,'Storey',$,$,$,$,$,$,0.0);
#10= IFCCARTESIANPOINT((0.,0.,0.));
#11= IFCAXIS2PLACEMENT3D(#10,$,$);
#12= IFCLOCALPLACEMENT($,#11);
#20= IFCCARTESIANPOINT((0.,0.));
#21= IFCCARTESIANPOINT((2.,0.));
#22= IFCCARTESIANPOINT((2.,2.));
#23= IFCCARTESIANPOINT((0.,2.));
#24= IFCPOLYLINE((#20,#21,#22,#23,#20));
#25= IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#24);
#26= IFCDIRECTION((0.,0.,-1.));
#27= IFCEXTRUDEDAREASOLID(#25,#11,#26,0.15);
#28= IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#27));
#29= IFCPRODUCTDEFINITIONSHAPE($,$,(#28));
#30= IFCSLAB('0AnVn9XaPAu9sr$rtDgUEa',$,'Radier',$,$,#12,#29,$);
#40= IFCRELAGGREGATES('0$r_g_0000000000000010',$,$,$,#1,(#2));
#41= IFCRELAGGREGATES('0$r_g_0000000000000011',$,$,$,#2,(#3));
#42= IFCRELAGGREGATES('0$r_g_0000000000000012',$,$,$,#3,(#4));
#43= IFCRELCONTAINEDINSPATIALSTRUCTURE('0$r_g_0000000000000013',$,$,$,(#30),#4);
ENDSEC;
END-ISO-10303-21;
`.trim();

    const scanner = new ChunkedStreamScanner(new TextEncoder().encode(stepText));
    scanner.parseHeader();
    scanner.scanDataSection();
    const importer = IfcStepImporter.fromStreamingParser(scanner);
    importer.prepareImport();
    const chunks = importer.extractGeometryChunks(10);
    expect(chunks.length).toBeGreaterThan(0);
    const element = chunks[0].elements.find((el) => el.type === 'GEOMETRY_ENTITY' && el.positions.length > 0);
    expect(element).toBeDefined();

    // In Three.js / Croquera coordinates:
    // Local Z_ifc becomes Y_croq (upwards).
    // The top surface of the slab is at y ≈ 0 (since it was extruded downwards to y ≈ -0.15).
    // The normal on the top surface MUST point strictly UPWARDS (+Y, ny > 0.9), NOT downwards!
    let hasUpwardNormalOnTop = false;
    const pos = element.positions;
    const norm = element.normals;
    for (let i = 0; i < pos.length; i += 3) {
      const y = pos[i + 1];
      const ny = norm[i + 1];
      if (Math.abs(y) < 0.01 && ny > 0.9) {
        hasUpwardNormalOnTop = true;
      }
    }
    expect(hasUpwardNormalOnTop).toBe(true);
  });
});
