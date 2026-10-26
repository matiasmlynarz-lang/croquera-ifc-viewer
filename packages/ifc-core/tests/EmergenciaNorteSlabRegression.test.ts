import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';

describe('Regression: EmergenciaNorte_Base.ifc Foundation Slab #444 voids', () => {
  it('correctly preserves carved voids without adding spurious bottom faces', async () => {
    const filePath = 'C:/AI/10 CROQUERA/ModelosDePrueba/EmergenciaNorte_Base.ifc';
    if (!fs.existsSync(filePath)) {
      return;
    }

    const buf = fs.readFileSync(filePath);
    const scanner = new ChunkedStreamScanner(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    const spatial = importer.extractSpatialHierarchy();
    expect(spatial).toBeDefined();

    const chunks = importer.extractGeometryChunks(2000);
    const slabElements = [];
    for (const chunk of chunks) {
      for (const el of chunk.elements) {
        if (el.stepId === 444) {
          slabElements.push(el);
        }
      }
    }

    const geomEl = slabElements.find((e) => e.type === 'GEOMETRY_ENTITY');
    expect(geomEl).toBeDefined();

    // The Foundation Slab #444 has 4 rectangular cutout openings already subtracted by CSG.
    // Exact mathematical invariant: 140 triangles (34 faces). No spurious top/bottom filling faces.
    const triangleCount = geomEl!.indices.length / 3;
    expect(triangleCount).toBe(140);
  });
});


