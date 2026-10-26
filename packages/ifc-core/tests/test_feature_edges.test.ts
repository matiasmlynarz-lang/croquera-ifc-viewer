import { describe, it } from 'vitest';
import fs from 'fs';
import { ChunkedStreamScanner } from '../../ifc-core/src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../../ifc-core/src/importer/IfcStepImporter';

describe('Feature Edge Extraction for IFCTRIANGULATEDFACESET', () => {
  const filePath = 'C:/AI/10 CROQUERA/ModelosDePrueba/Paraderos_Original.ifc';

  it('computes feature edges from triangles and normals', () => {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    const chunks = Array.from(importer.extractGeometryChunks(100));
    const el = chunks[0].elements.find(e => e.type === 'GEOMETRY_ENTITY')!;

    console.log('Element vertices count:', el.positions.length / 3);
    console.log('Element triangles count:', el.indices.length / 3);
    console.log('Current edgesBuffer length:', el.edgesBuffer ? el.edgesBuffer.length : 0);

    const positions = el.positions;
    const indices = el.indices;
    const numTris = indices.length / 3;

    // 1. Calculate per-triangle normal
    const triNormals: { x: number; y: number; z: number }[] = [];
    for (let t = 0; t < numTris; t++) {
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];

      const p0x = positions[i0 * 3], p0y = positions[i0 * 3 + 1], p0z = positions[i0 * 3 + 2];
      const p1x = positions[i1 * 3], p1y = positions[i1 * 3 + 1], p1z = positions[i1 * 3 + 2];
      const p2x = positions[i2 * 3], p2y = positions[i2 * 3 + 1], p2z = positions[i2 * 3 + 2];

      const v01x = p1x - p0x, v01y = p1y - p0y, v01z = p1z - p0z;
      const v02x = p2x - p0x, v02y = p2y - p0y, v02z = p2z - p0z;

      let nx = v01y * v02z - v01z * v02y;
      let ny = v01z * v02x - v01x * v02z;
      let nz = v01x * v02y - v01y * v02x;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 1e-8) {
        nx /= len; ny /= len; nz /= len;
      }
      triNormals.push({ x: nx, y: ny, z: nz });
    }

    // 2. Build edge map: edgeKey -> list of triangle indices
    const edgeMap = new Map<bigint, { v0: number; v1: number; tris: number[] }>();

    for (let t = 0; t < numTris; t++) {
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];

      const triEdges = [
        [i0, i1],
        [i1, i2],
        [i2, i0],
      ];

      for (const [a, b] of triEdges) {
        const minV = Math.min(a, b);
        const maxV = Math.max(a, b);
        const key = (BigInt(minV) << 32n) | BigInt(maxV);

        let entry = edgeMap.get(key);
        if (!entry) {
          entry = { v0: minV, v1: maxV, tris: [] };
          edgeMap.set(key, entry);
        }
        entry.tris.push(t);
      }
    }

    console.log('Total unique edges in mesh:', edgeMap.size);

    // 3. Filter feature edges:
    // - Boundary edge (tris.length === 1): Always a feature edge (contour of the sheet/surface).
    // - Non-manifold edge (tris.length > 2): Always a feature edge.
    // - Shared edge (tris.length === 2): Feature edge if dihedral angle between triangles > threshold (e.g. > 5 degrees)
    //   cos(5 deg) ~ 0.99619. For sheet geometry where normals may have flipped winding, use |dot| < 0.996
    const featureEdges: { v0: number; v1: number }[] = [];
    const COS_THRESHOLD = Math.cos((5 * Math.PI) / 180); // ~0.9962

    for (const edge of edgeMap.values()) {
      if (edge.tris.length === 1 || edge.tris.length > 2) {
        featureEdges.push({ v0: edge.v0, v1: edge.v1 });
      } else if (edge.tris.length === 2) {
        const n0 = triNormals[edge.tris[0]];
        const n1 = triNormals[edge.tris[1]];
        const dot = Math.abs(n0.x * n1.x + n0.y * n1.y + n0.z * n1.z);
        if (dot < COS_THRESHOLD) {
          featureEdges.push({ v0: edge.v0, v1: edge.v1 });
        }
      }
    }

    console.log('Feature edges count:', featureEdges.length);
    console.log('Suppressed coplanar diagonals count:', edgeMap.size - featureEdges.length);
  });
});
