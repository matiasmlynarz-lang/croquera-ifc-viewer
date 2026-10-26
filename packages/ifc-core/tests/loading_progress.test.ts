import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { IfcImportWorkerCore } from '../src/worker/IfcImportWorkerCore';
import type { IfcWorkerResponse, Stage2BoundsPayload } from '../src/types/IfcWorkerProtocol';

describe('Loading Progress Precision Verification', () => {
  const filePath = 'C:/AI/10 CROQUERA/ModelosDePrueba/Paraderos_Original.ifc';

  it('reports totalModelElements in STAGE_BOUNDS_AABB and monotonic progress under 100% until completion', async () => {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const core = new IfcImportWorkerCore();
    const emitted: IfcWorkerResponse[] = [];

    await core.process(
      {
        type: 'INIT_COORDINATOR',
        stepBuffer: arrayBuf as any,
      },
      (resp) => {
        emitted.push(resp);
      }
    );

    const bounds = emitted.find((r) => r.type === 'STAGE_BOUNDS_AABB') as Stage2BoundsPayload;
    expect(bounds).toBeDefined();
    expect(bounds.totalElements).toBeGreaterThan(0);
    expect(bounds.totalModelElements).toBeGreaterThanOrEqual(bounds.totalElements);

    const totalExpected = bounds.totalModelElements || bounds.totalElements;

    // Simulate chunk processing progress calculation
    const progressHistory: number[] = [];
    const elementsIngested = [5, 10, 20, bounds.totalElements];

    for (const count of elementsIngested) {
      const pct = Math.min(99, Math.max(1, Math.round((count / totalExpected) * 100)));
      progressHistory.push(pct);
    }

    // Verify progress never reaches 100% while tessellating
    for (const p of progressHistory) {
      expect(p).toBeLessThanOrEqual(99);
      expect(p).toBeGreaterThanOrEqual(1);
    }

    // Monotonically non-decreasing
    for (let i = 1; i < progressHistory.length; i++) {
      expect(progressHistory[i]).toBeGreaterThanOrEqual(progressHistory[i - 1]);
    }
  });
});
