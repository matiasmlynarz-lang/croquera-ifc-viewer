import { describe, it } from 'vitest';
import fs from 'fs';
import { ChunkedStreamScanner } from '../../ifc-core/src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../../ifc-core/src/importer/IfcStepImporter';

describe('Triangle winding and normals of Paraderos_Original.ifc', () => {
  const filePath = 'C:/AI/10 CROQUERA/ModelosDePrueba/Paraderos_Original.ifc';

  it('checks face orientations and normals', () => {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    importer.extractSpatialHierarchy();
    importer.extractProductBounds();

    const chunks = Array.from(importer.extractGeometryChunks(100));
    const el = chunks[0].elements.find(e => e.type === 'GEOMETRY_ENTITY')!;

    const positions = el.positions;
    const indices = el.indices!;
    const normals = el.normals!;

    console.log(`Total triangles: ${indices.length / 3}`);
    for (let t = 0; t < indices.length / 3; t++) {
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];

      const p0 = [positions[i0*3], positions[i0*3+1], positions[i0*3+2]];
      const p1 = [positions[i1*3], positions[i1*3+1], positions[i1*3+2]];
      const p2 = [positions[i2*3], positions[i2*3+1], positions[i2*3+2]];

      const v01 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const v02 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];

      // Cross product
      const nx = v01[1] * v02[2] - v01[2] * v02[1];
      const ny = v01[2] * v02[0] - v01[0] * v02[2];
      const nz = v01[0] * v02[1] - v01[1] * v02[0];
      const len = Math.hypot(nx, ny, nz);

      console.log(`Tri #${t}: [${i0}, ${i1}, ${i2}] Normal: [${(nx/len).toFixed(3)}, ${(ny/len).toFixed(3)}, ${(nz/len).toFixed(3)}]`);
    }
  });
});
