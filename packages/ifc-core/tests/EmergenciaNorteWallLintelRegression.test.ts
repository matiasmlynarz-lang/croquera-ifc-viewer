import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';

describe('Regression: EmergenciaNorte_Base.ifc Wall/Lintel #10813 void isolation', () => {
  it('does not carve disjoint door opening #79642 into lintel wall #10813', async () => {
    const filePath = 'C:/AI/10 CROQUERA/ModelosDePrueba/EmergenciaNorte_Base.ifc';
    if (!fs.existsSync(filePath)) return;

    const buf = fs.readFileSync(filePath);
    const scanner = new ChunkedStreamScanner(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    importer.extractSpatialHierarchy();

    const chunks = importer.extractGeometryChunks(2000);
    const wallElements = [];
    for (const chunk of chunks) {
      for (const el of chunk.elements) {
        if (el.stepId === 10813 && el.type === 'GEOMETRY_ENTITY') {
          wallElements.push(el);
        }
      }
    }

    expect(wallElements.length).toBe(1);
    const wallEl = wallElements[0];

    // Compute bounding box of extracted geometry for #10813
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < wallEl.positions.length; i += 3) {
      const y = wallEl.positions[i];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    // Exact mathematical invariant:
    // Lintel wall #10813 extruded height is 0.23m between Y=2.47m and Y=2.70m.
    // It must NOT be carved or extended downwards by disjoint door opening #79642 (Y=[0.00, 2.10]).
    expect(minY).toBeGreaterThanOrEqual(2.46);
    expect(maxY).toBeLessThanOrEqual(2.71);
    expect(wallEl.indices.length / 3).toBe(12); // Exactly 6 box faces = 12 triangles
  });
});



