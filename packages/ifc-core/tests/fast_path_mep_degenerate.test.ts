import { describe, it, expect } from 'vitest';
import { DirectCylinderGenerator } from '../src/geometry/DirectCylinderGenerator';

describe('DirectCylinderGenerator — Degenerate Cases and Risk Mitigations (Normas 6 y 11)', () => {
  it('safely rejects zero or negative radius without throwing exceptions', () => {
    const meshZero = DirectCylinderGenerator.generateMesh({
      p0: [0, 0, 0],
      p1: [0, 0, 1],
      radius: 0.0,
    });
    expect(meshZero).toBeNull();

    const meshNeg = DirectCylinderGenerator.generateMesh({
      p0: [0, 0, 0],
      p1: [0, 0, 1],
      radius: -0.05,
    });
    expect(meshNeg).toBeNull();
  });

  it('safely rejects coincident points / zero length pipes', () => {
    const meshZeroLen = DirectCylinderGenerator.generateMesh({
      p0: [1, 2, 3],
      p1: [1, 2, 3],
      radius: 0.05,
    });
    expect(meshZeroLen).toBeNull();

    const m = DirectCylinderGenerator.computeInstanceMatrix([2, 2, 2], [2, 2, 2], 0.05);
    expect(m.elements).toBeDefined();
  });

  it('triggers safe fallback (returns null) on near-parallel clipping planes (Mitigates Risk R-3)', () => {
    // Pipe along Z axis: [0,0,0] to [0,0,10]
    // Plane almost parallel to Z axis: normal [1, 0, 0.05] -> |w . n| = 0.05 < 0.15 threshold
    const meshParallelClip = DirectCylinderGenerator.generateMesh({
      p0: [0, 0, 0],
      p1: [0, 0, 10],
      radius: 0.1,
      clippingPlane: {
        point: [0.05, 0, 5],
        normal: [1, 0, 0.05], // near-parallel grazing cut
      },
    });

    // Must return null to trigger safe fallback to exact CSG (prevents wild/infinite coordinate spikes)
    expect(meshParallelClip).toBeNull();
  });

  it('successfully computes analytical clipping when plane cleanly intersects cylinder', () => {
    // Pipe along Z axis from z=0 to z=10
    // Clipping plane at z=8 with normal [0, 0, 1] (perpendicular bevel cut)
    const meshValidClip = DirectCylinderGenerator.generateMesh({
      p0: [0, 0, 0],
      p1: [0, 0, 10],
      radius: 0.1,
      clippingPlane: {
        point: [0, 0, 8],
        normal: [0, 0, 1],
      },
    });

    expect(meshValidClip).not.toBeNull();
    const { positions } = meshValidClip!;

    // Max Z coordinate should be capped at around z=8.0
    let maxZ = -Infinity;
    for (let i = 2; i < positions.length; i += 3) {
      maxZ = Math.max(maxZ, positions[i]);
    }
    expect(maxZ).toBeCloseTo(8.0, 2);
  });
});
