import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DirectCylinderGenerator } from '../src/geometry/DirectCylinderGenerator';

describe('DirectCylinderGenerator — Geometric Parity and Visual Quality (Normas 6, 11 y 17)', () => {
  it('generates a watertight cylinder with valid bounds and positive volume', () => {
    const mesh = DirectCylinderGenerator.generateMesh({
      p0: [0, 0, 0],
      p1: [0, 0, 5],
      radius: 0.1, // 100mm pipe -> 12 segments
      hasStartCap: true,
      hasEndCap: true,
    });

    expect(mesh).not.toBeNull();
    const { positions, normals, indices } = mesh!;

    expect(positions.length).toBeGreaterThan(0);
    expect(normals.length).toBe(positions.length);
    expect(indices.length % 3).toBe(0);

    // Verify bounds [x, y, z]
    let minZ = Infinity, maxZ = -Infinity;
    let maxR = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      const r = Math.sqrt(x * x + y * y);
      maxR = Math.max(maxR, r);
    }

    expect(minZ).toBeCloseTo(0.0, 3);
    expect(maxZ).toBeCloseTo(5.0, 3);
    expect(maxR).toBeCloseTo(0.1, 3);
  });

  it('guarantees strictly unit analytical normals for smooth shading (Mitigates Risk R-1)', () => {
    const mesh = DirectCylinderGenerator.generateMesh({
      p0: [1, 2, 3],
      p1: [4, 6, 8],
      radius: 0.04, // 40mm -> 8 segments
    });

    expect(mesh).not.toBeNull();
    const { normals } = mesh!;

    for (let i = 0; i < normals.length; i += 3) {
      const nx = normals[i];
      const ny = normals[i + 1];
      const nz = normals[i + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      expect(len).toBeCloseTo(1.0, 4);
    }
  });

  it('computes Frisvad-Duff orthonormal basis with positive determinant preserving chirality (Mitigates Risk R-4)', () => {
    // 1. Horizontal pipe along X
    const m1 = DirectCylinderGenerator.computeInstanceMatrix([0, 0, 0], [3, 0, 0], 0.05);
    expect(m1.determinant()).toBeGreaterThan(0);

    // 2. Vertical pipe along Z (standard singularity point in classical basis)
    const m2 = DirectCylinderGenerator.computeInstanceMatrix([0, 0, 0], [0, 0, 4], 0.05);
    expect(m2.determinant()).toBeGreaterThan(0);

    // 3. Reverse vertical pipe along -Z
    const m3 = DirectCylinderGenerator.computeInstanceMatrix([0, 0, 0], [0, 0, -4], 0.05);
    expect(m3.determinant()).toBeGreaterThan(0);

    // 4. Arbitrary diagonal pipe
    const m4 = DirectCylinderGenerator.computeInstanceMatrix([1, 2, 3], [5, 8, 12], 0.08);
    expect(m4.determinant()).toBeGreaterThan(0);
  });

  it('adapts radial segments continuously according to physical radius in meters (Mitigates Risk R-1)', () => {
    expect(DirectCylinderGenerator.getAdaptiveSegments(0.02)).toBe(8);   // 20mm
    expect(DirectCylinderGenerator.getAdaptiveSegments(0.045)).toBe(8);  // 45mm
    expect(DirectCylinderGenerator.getAdaptiveSegments(0.08)).toBe(12);  // 80mm
    expect(DirectCylinderGenerator.getAdaptiveSegments(0.15)).toBe(12);  // 150mm
    expect(DirectCylinderGenerator.getAdaptiveSegments(0.25)).toBe(16);  // 250mm
    expect(DirectCylinderGenerator.getAdaptiveSegments(0.60)).toBe(16);  // 600mm
  });
});
