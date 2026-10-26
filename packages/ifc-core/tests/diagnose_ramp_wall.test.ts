import { describe, it, expect } from 'vitest';
import { IfcStepImporter } from '../src';
import fs from 'fs';
import path from 'path';

describe('Ramp and Wall Clipping Verification (9001-ING-04-2BT01)', () => {
  it('correctly clips wall under roof and reconstructs 3D ramp solids without deleting them', () => {
    const ifcPath = path.resolve(__dirname, './fixtures/test_ramp_wall.ifc');
    const ifcText = fs.readFileSync(ifcPath, 'utf8');
    const importer = new IfcStepImporter(ifcText);
    importer.prepareImport();
    const elements: any[] = [];
    importer.extractGeometryChunks(100, (chunk) => {
      elements.push(...chunk.elements);
    });

    expect(elements.length).toBeGreaterThanOrEqual(6);

    // 1. Wall 3QxxJP6$P1uuhhq_hRhp2K (retains sloped portion under the roof reaching 485.33m)
    const wallGeom = elements.find((e) => e.parentId === '3QxxJP6$P1uuhhq_hRhp2K' && e.positions?.length > 0);
    expect(wallGeom).toBeDefined();
    {
      const pos = wallGeom.positions;
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < pos.length; i += 3) {
        minY = Math.min(minY, pos[i + 1]);
        maxY = Math.max(maxY, pos[i + 1]);
      }
      expect(minY).toBeCloseTo(482.91, 1);
      expect(maxY).toBeCloseTo(485.33, 1); // Sloped top follows roof up to 485.33m
      expect(maxY - minY).toBeGreaterThan(2.4); // Full wall height with slope preserved (~2.43m)
    }

    // 1b. Wall 3QxxJP6$P1uuhhq_hRhp_W (height 1.975m from 482.91m to 484.88m as exported from Revit)
    const wall2Geom = elements.find((e) => e.parentId === '3QxxJP6$P1uuhhq_hRhp_W' && e.positions?.length > 0);
    expect(wall2Geom).toBeDefined();
    {
      const pos = wall2Geom.positions;
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < pos.length; i += 3) {
        minY = Math.min(minY, pos[i + 1]);
        maxY = Math.max(maxY, pos[i + 1]);
      }
      expect(minY).toBeCloseTo(482.91, 1);
      expect(maxY).toBeCloseTo(484.88, 1);
      expect(maxY - minY).toBeCloseTo(1.975, 2);
    }

    // 2. Ramp 0V1$85Bwn3nQVdfizzjzW5 (complete 3D slab with both top and bottom caps: 12 triangles)
    const ramp1Geom = elements.find((e) => e.parentId === '0V1$85Bwn3nQVdfizzjzW5' && e.positions?.length > 0);
    expect(ramp1Geom).toBeDefined();
    expect(ramp1Geom.indices.length / 3).toBe(12);
    {
      const pos = ramp1Geom.positions;
      const idx = ramp1Geom.indices;
      const nrm = ramp1Geom.normals;
      let hasTopCap = false;
      let hasBottomCap = false;
      for (let i = 0; i < idx.length; i += 3) {
        const ia = idx[i];
        const ny = nrm[ia * 3 + 1];
        if (ny > 0.9) hasTopCap = true;
        if (ny < -0.9) hasBottomCap = true;
      }
      expect(hasTopCap).toBe(true);
      expect(hasBottomCap).toBe(true);
    }

    // 3. Ramp 0V1$85Bwn3nQVdfizzjzWS (intermediate flight: 12 triangles with top and bottom caps)
    const rampWsGeom = elements.find((e) => e.parentId === '0V1$85Bwn3nQVdfizzjzWS' && e.positions?.length > 0);
    expect(rampWsGeom).toBeDefined();
    expect(rampWsGeom.indices.length / 3).toBe(12);
    {
      const idx = rampWsGeom.indices;
      const nrm = rampWsGeom.normals;
      let hasTopCap = false;
      let hasBottomCap = false;
      for (let i = 0; i < idx.length; i += 3) {
        const ia = idx[i];
        const ny = nrm[ia * 3 + 1];
        if (ny > 0.9) hasTopCap = true;
        if (ny < -0.9) hasBottomCap = true;
      }
      expect(hasTopCap).toBe(true);
      expect(hasBottomCap).toBe(true);
    }

    // 4. Ramp 0V1$85Bwn3nQVdfizzjzd1 (upper flight: 12 triangles with top and bottom caps)
    const ramp2Geom = elements.find((e) => e.parentId === '0V1$85Bwn3nQVdfizzjzd1' && e.positions?.length > 0);
    expect(ramp2Geom).toBeDefined();
    expect(ramp2Geom.indices.length / 3).toBe(12);
    {
      const idx = ramp2Geom.indices;
      const nrm = ramp2Geom.normals;
      let hasTopCap = false;
      let hasBottomCap = false;
      for (let i = 0; i < idx.length; i += 3) {
        const ia = idx[i];
        const ny = nrm[ia * 3 + 1];
        if (ny > 0.9) hasTopCap = true;
        if (ny < -0.9) hasBottomCap = true;
      }
      expect(hasTopCap).toBe(true);
      expect(hasBottomCap).toBe(true);
    }
  });
});
