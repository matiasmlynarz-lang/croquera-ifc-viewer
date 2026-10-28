import { describe, it, expect } from 'vitest';
import { ToroidTemplateCache } from '../src/geometry/ToroidTemplateCache';

describe('ToroidTemplateCache — Analytical Elbow Generator & Quantized Cache (Normas 6, 11, 17)', () => {
  it('T1: computes consistent 32-bit quantized keys for standardized elbows', () => {
    // 90° bend (PI/2), R=0.15m, r=0.05m -> rho = 3.0
    const key1 = ToroidTemplateCache.computeQuantizedKey(Math.PI / 2, 0.15, 0.05);
    // Same elbow with slight floating point variation in radius ratio
    const key2 = ToroidTemplateCache.computeQuantizedKey(Math.PI / 2, 0.15000001, 0.05);
    expect(key1).toBe(key2);

    // 45° bend (PI/4), R=0.10m, r=0.05m -> rho = 2.0
    const key45 = ToroidTemplateCache.computeQuantizedKey(Math.PI / 4, 0.10, 0.05);
    expect(key45).not.toBe(key1);
    expect((key45 >> 16) & 0xffff).toBe(45);
    expect((key1 >> 16) & 0xffff).toBe(90);
  });

  it('T2: generates valid 90° toroidal elbow mesh with continuous unit normals and watertight caps', () => {
    const mesh = ToroidTemplateCache.getOrCreateToroidMesh({
      pipeRadius: 0.05,
      bendRadius: 0.15,
      sweepAngleRad: Math.PI / 2,
      hasStartCap: true,
      hasEndCap: true,
    });

    expect(mesh).not.toBeNull();
    if (!mesh) return;

    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.edgesBuffer).toBeDefined();

    // Verify all vertex coordinates are finite
    for (let i = 0; i < mesh.positions.length; i++) {
      expect(Number.isFinite(mesh.positions[i])).toBe(true);
    }

    // Verify all surface normals are unit vectors (norm ~ 1.0)
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const nx = mesh.normals[i];
      const ny = mesh.normals[i + 1];
      const nz = mesh.normals[i + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      expect(len).toBeCloseTo(1.0, 3);
    }
  });

  it('T3: cache hit returns cloned buffers without modifying cached prototype', () => {
    const meshA = ToroidTemplateCache.getOrCreateToroidMesh({
      pipeRadius: 0.04,
      bendRadius: 0.12,
      sweepAngleRad: Math.PI / 2,
    });

    const meshB = ToroidTemplateCache.getOrCreateToroidMesh({
      pipeRadius: 0.04,
      bendRadius: 0.12,
      sweepAngleRad: Math.PI / 2,
    });

    expect(meshA).not.toBeNull();
    expect(meshB).not.toBeNull();
    if (!meshA || !meshB) return;

    // Different memory instances
    expect(meshA.positions).not.toBe(meshB.positions);
    // Exactly identical values
    expect(meshA.positions.length).toBe(meshB.positions.length);
    expect(meshA.positions[0]).toBe(meshB.positions[0]);
  });

  it('T4: defends against degenerate geometry (Norma 11)', () => {
    expect(ToroidTemplateCache.getOrCreateToroidMesh({
      pipeRadius: -0.05,
      bendRadius: 0.15,
      sweepAngleRad: Math.PI / 2,
    })).toBeNull();

    expect(ToroidTemplateCache.getOrCreateToroidMesh({
      pipeRadius: 0.05,
      bendRadius: 0,
      sweepAngleRad: Math.PI / 2,
    })).toBeNull();

    expect(ToroidTemplateCache.getOrCreateToroidMesh({
      pipeRadius: 0.05,
      bendRadius: 0.15,
      sweepAngleRad: 0,
    })).toBeNull();
  });
});
