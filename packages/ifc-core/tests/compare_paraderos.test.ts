import { describe, it } from 'vitest';
import fs from 'fs';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';

describe('Test Paraderos_Original.ifc in croquera-ifc-viewer', () => {
  const filePath = 'C:/AI/10 CROQUERA/ModelosDePrueba/Paraderos_Original.ifc';

  it('inspects extraction of Paraderos_Original.ifc', () => {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    console.log('--- TESTING CROQUERA-IFC-VIEWER ---');
    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    const spatial = importer.extractSpatialHierarchy();
    console.log('Spatial elements count:', spatial.spatialNodes.length);
    console.log('spatial.materials:', spatial.materials);
    for (const n of spatial.spatialNodes) {
      console.log(` Spatial node: ${n.ifcType} id=${n.id} name=${n.name} parentId=${n.parentId}`);
    }

    const bounds = importer.extractProductBounds();
    console.log('Product bounds count:', bounds.elements.length);
    for (const b of bounds.elements) {
      console.log(` Bound element: type=${b.type} ifcType=${b.ifcType} stepId=${b.stepId} aabb=`, b.aabb);
    }

    const chunks = Array.from(importer.extractGeometryChunks(100));
    console.log('Chunks extracted:', chunks.length);
    for (const c of chunks) {
      console.log(` Chunk: ${c.elements.length} elements`);
      for (const el of c.elements) {
        console.log(`  Element: type=${el.type} ifcType=${el.ifcType} stepId=${el.stepId} id=${el.id} parentId=${el.parentId}`);
        console.log(`   materialId:`, el.materialId);
        if (el.positions) {
          console.log(`   positions length:`, el.positions.length, `(num verts = ${el.positions.length / 3})`);
          let minX = Infinity, maxX = -Infinity;
          let minY = Infinity, maxY = -Infinity;
          let minZ = Infinity, maxZ = -Infinity;
          for (let i = 0; i < el.positions.length; i += 3) {
            const x = el.positions[i], y = el.positions[i+1], z = el.positions[i+2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          }
          console.log(`   positions bounds: X=[${minX.toFixed(3)}, ${maxX.toFixed(3)}], Y=[${minY.toFixed(3)}, ${maxY.toFixed(3)}], Z=[${minZ.toFixed(3)}, ${maxZ.toFixed(3)}]`);
        }
        if (el.indices) {
          console.log(`   indices length:`, el.indices.length, `(num triangles = ${el.indices.length / 3})`);
          console.log(`   indices first 30:`, Array.from(el.indices.slice(0, 30)));
        }
        if (el.normals) {
          console.log(`   normals length:`, el.normals.length);
          console.log(`   normals first 9:`, Array.from(el.normals.slice(0, 9)));
        }
      }
    }
  });
});
