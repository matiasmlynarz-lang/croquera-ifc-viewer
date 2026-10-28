import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';

describe('Emerg.ifc Site Furniture Coordinate Invariants', () => {
  const filePath = 'C:/AI/10 CROQUERA/ModelosBenchmark/Emerg.ifc';
  const fileExists = fs.existsSync(filePath);

  it.skipIf(!fileExists)('preserves true local coordinates for IfcSite furniture #73187 instead of collapsing to (0,0,0)', () => {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    const bounds = importer.extractProductBounds();

    // Verify trash can #73187
    const trashCan = bounds.elements.find((e) => e.stepId === 73187);
    expect(trashCan).toBeDefined();
    expect(trashCan!.ifcType).toBe('IfcSite');

    // Point #73184 is (6.74609, 3.16415, 0.0) in local storey space.
    // Under building rotation #45 (dir X = [-0.8734, -0.4870, 0]),
    // world Croquera coordinates are: X = -4.351, Y = 0.0, Z = 6.049.
    const aabb = trashCan!.aabb;
    expect(aabb).toBeDefined();

    const centerX = (aabb.min[0] + aabb.max[0]) / 2;
    const centerY = (aabb.min[1] + aabb.max[1]) / 2;
    const centerZ = (aabb.min[2] + aabb.max[2]) / 2;

    // Must NOT be collapsed to (0, 0, 0)
    expect(Math.abs(centerX)).toBeGreaterThan(4.0);
    expect(centerX).toBeCloseTo(-4.351, 0.01);
    expect(centerZ).toBeCloseTo(6.049, 0.01);

    // Verify second trash can #73226
    const trashCan2 = bounds.elements.find((e) => e.stepId === 73226);
    expect(trashCan2).toBeDefined();
    const aabb2 = trashCan2!.aabb;
    const center2X = (aabb2.min[0] + aabb2.max[0]) / 2;
    const center2Z = (aabb2.min[2] + aabb2.max[2]) / 2;

    // World Croquera coordinates: X = -3.964, Y = 0.0, Z = 6.744
    expect(center2X).toBeCloseTo(-3.964, 0.01);
    expect(center2Z).toBeCloseTo(6.744, 0.01);
  });
});
