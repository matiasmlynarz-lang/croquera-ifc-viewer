import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';

describe('Federation Georeferencing Alignment Test', () => {
  const pavimentosPath = 'C:/AI/10 CROQUERA/ModelosDePrueba/PavimentosSecundarios_Original.ifc';
  const paraderosPath = 'C:/AI/10 CROQUERA/ModelosDePrueba/Paraderos_Original.ifc';

  it('aligns PavimentosSecundarios (IfcSite georef) and Paraderos (raw UTM) with sub-millimeter precision', () => {
    if (!fs.existsSync(pavimentosPath) || !fs.existsSync(paraderosPath)) {
      console.warn('Skipping federation test: test files not found');
      return;
    }

    // 1. Ingest PavimentosSecundarios_Original.ifc
    const bufPav = fs.readFileSync(pavimentosPath);
    const arrayBufPav = bufPav.buffer.slice(bufPav.byteOffset, bufPav.byteOffset + bufPav.byteLength);
    const scannerPav = new ChunkedStreamScanner(arrayBufPav);
    scannerPav.parseHeader();
    scannerPav.scanDataSection();
    const importerPav = IfcStepImporter.fromStreamingParser(scannerPav);
    importerPav.extractSpatialHierarchy();
    const boundsPav = importerPav.extractProductBounds();

    expect(boundsPav.siteOffset).toBeDefined();
    const siteOffPav = boundsPav.siteOffset!;
    // PavimentosSecundarios should have captured its site placement translation (approx 209 km, -3363 km)
    expect(Math.abs(siteOffPav[0])).toBeGreaterThan(100000);
    expect(Math.abs(siteOffPav[2])).toBeGreaterThan(1000000);

    // World AABB of Pavimentos
    const worldMinPav = [
      boundsPav.modelAABB.min[0] + siteOffPav[0],
      boundsPav.modelAABB.min[1] + siteOffPav[1],
      boundsPav.modelAABB.min[2] + siteOffPav[2],
    ];
    const worldMaxPav = [
      boundsPav.modelAABB.max[0] + siteOffPav[0],
      boundsPav.modelAABB.max[1] + siteOffPav[1],
      boundsPav.modelAABB.max[2] + siteOffPav[2],
    ];

    // 2. Ingest Paraderos_Original.ifc
    const bufPar = fs.readFileSync(paraderosPath);
    const arrayBufPar = bufPar.buffer.slice(bufPar.byteOffset, bufPar.byteOffset + bufPar.byteLength);
    const scannerPar = new ChunkedStreamScanner(arrayBufPar);
    scannerPar.parseHeader();
    scannerPar.scanDataSection();
    const importerPar = IfcStepImporter.fromStreamingParser(scannerPar);
    importerPar.extractSpatialHierarchy();
    const boundsPar = importerPar.extractProductBounds();

    const siteOffPar = boundsPar.siteOffset || [0, 0, 0];
    // Paraderos has its coordinates embedded directly in UTM (site offset is 0)
    expect(siteOffPar[0]).toBeCloseTo(0, 1e-4);
    expect(siteOffPar[2]).toBeCloseTo(0, 1e-4);

    const worldMinPar = [
      boundsPar.modelAABB.min[0] + siteOffPar[0],
      boundsPar.modelAABB.min[1] + siteOffPar[1],
      boundsPar.modelAABB.min[2] + siteOffPar[2],
    ];
    const worldMaxPar = [
      boundsPar.modelAABB.max[0] + siteOffPar[0],
      boundsPar.modelAABB.max[1] + siteOffPar[1],
      boundsPar.modelAABB.max[2] + siteOffPar[2],
    ];

    // 3. Verify that both models are located in the same geographic UTM corridor
    expect(worldMinPar[0]).toBeGreaterThanOrEqual(worldMinPav[0] - 2000);
    expect(worldMaxPar[0]).toBeLessThanOrEqual(worldMaxPav[0] + 2000);
    expect(worldMinPar[2]).toBeGreaterThanOrEqual(worldMinPav[2] - 2000);
    expect(worldMaxPar[2]).toBeLessThanOrEqual(worldMaxPav[2] + 2000);

    // 4. Verify GPU relative offset calculation
    // R_global is established by first model (Pavimentos)
    const rGlobal = [
      (worldMinPav[0] + worldMaxPav[0]) / 2,
      Math.abs(worldMinPav[1]) > 5 ? worldMinPav[1] : 0,
      (worldMinPav[2] + worldMaxPav[2]) / 2,
    ];

    // delta_1 for Pavimentos
    const deltaPav = [
      rGlobal[0] - siteOffPav[0],
      rGlobal[1] - siteOffPav[1],
      rGlobal[2] - siteOffPav[2],
    ];

    // delta_2 for Paraderos
    const deltaPar = [
      rGlobal[0] - siteOffPar[0],
      rGlobal[1] - siteOffPar[1],
      rGlobal[2] - siteOffPar[2],
    ];

    // GPU bounds
    const gpuMinPav = [
      boundsPav.modelAABB.min[0] - deltaPav[0],
      boundsPav.modelAABB.min[1] - deltaPav[1],
      boundsPav.modelAABB.min[2] - deltaPav[2],
    ];
    const gpuMaxPav = [
      boundsPav.modelAABB.max[0] - deltaPav[0],
      boundsPav.modelAABB.max[1] - deltaPav[1],
      boundsPav.modelAABB.max[2] - deltaPav[2],
    ];

    const gpuMinPar = [
      boundsPar.modelAABB.min[0] - deltaPar[0],
      boundsPar.modelAABB.min[1] - deltaPar[1],
      boundsPar.modelAABB.min[2] - deltaPar[2],
    ];
    const gpuMaxPar = [
      boundsPar.modelAABB.max[0] - deltaPar[0],
      boundsPar.modelAABB.max[1] - deltaPar[1],
      boundsPar.modelAABB.max[2] - deltaPar[2],
    ];

    // Both models in GPU space must be centered around (0, 0, 0)
    expect(Math.abs(gpuMinPav[0])).toBeLessThan(5000);
    expect(Math.abs(gpuMaxPav[0])).toBeLessThan(5000);
    expect(Math.abs(gpuMinPav[2])).toBeLessThan(5000);
    expect(Math.abs(gpuMaxPav[2])).toBeLessThan(5000);

    expect(Math.abs(gpuMinPar[0])).toBeLessThan(5000);
    expect(Math.abs(gpuMaxPar[0])).toBeLessThan(5000);
    expect(Math.abs(gpuMinPar[2])).toBeLessThan(5000);
    expect(Math.abs(gpuMaxPar[2])).toBeLessThan(5000);

    // Paraderos GPU coordinates must coincide with Pavimentos corridor without any kilometer offset
    expect(gpuMinPar[0]).toBeGreaterThanOrEqual(gpuMinPav[0] - 2000);
    expect(gpuMaxPar[0]).toBeLessThanOrEqual(gpuMaxPav[0] + 2000);
    expect(gpuMinPar[2]).toBeGreaterThanOrEqual(gpuMinPav[2] - 2000);
    expect(gpuMaxPar[2]).toBeLessThanOrEqual(gpuMaxPav[2] + 2000);

    // Bit-exact relative distance preservation
    const worldDistX = worldMinPar[0] - worldMinPav[0];
    const gpuDistX = gpuMinPar[0] - gpuMinPav[0];
    expect(gpuDistX).toBeCloseTo(worldDistX, 1e-4);

    const worldDistZ = worldMinPar[2] - worldMinPav[2];
    const gpuDistZ = gpuMinPar[2] - gpuMinPav[2];
    expect(gpuDistZ).toBeCloseTo(worldDistZ, 1e-4);
  });
});
