import { describe, it, expect } from 'vitest';
import { StaticProfileTemplates } from '../src/geometry/StaticProfileTemplates';

describe('StaticProfileTemplates — Analytical Steel Profiles (Normas 6, 11, 17)', () => {
  it('T1: generates valid I-Beam (IFCISHAPEPROFILEDEF) with correct vertex/index counts and hard normals', () => {
    // I-Beam: 0.2m width, 0.4m depth, 0.01m web, 0.02m flange, 3.0m length
    const mesh = StaticProfileTemplates.generateIShapeBeam(0.2, 0.4, 0.01, 0.02, 3.0);
    expect(mesh).not.toBeNull();
    if (!mesh) return;

    // 12 vertices * 6 = 72 vertices -> 216 floats
    expect(mesh.positions.length).toBe(72 * 3);
    expect(mesh.normals.length).toBe(72 * 3);

    // 10 bottom cap tris + 10 top cap tris + 12 faces * 2 tris = 44 tris -> 132 indices
    expect(mesh.indices.length).toBe(44 * 3);

    // 12 bottom + 12 top + 12 pillar edges = 36 edges -> 72 points -> 216 floats
    expect(mesh.edgesBuffer).toBeDefined();
    expect(mesh.edgesBuffer!.length).toBe(36 * 2 * 3);

    // Verify all positions are finite
    for (let i = 0; i < mesh.positions.length; i++) {
      expect(Number.isFinite(mesh.positions[i])).toBe(true);
    }

    // Verify normal vectors are unit length (norm ~ 1.0)
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const nx = mesh.normals[i];
      const ny = mesh.normals[i + 1];
      const nz = mesh.normals[i + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      expect(len).toBeCloseTo(1.0, 4);
    }
  });

  it('T2: generates valid L-Shape, T-Shape, and U-Shape beams', () => {
    const lMesh = StaticProfileTemplates.generateLShapeBeam(0.1, 0.1, 0.01, 2.0);
    expect(lMesh).not.toBeNull();
    if (lMesh) {
      // 6 * 6 = 36 vertices
      expect(lMesh.positions.length).toBe(36 * 3);
      // 4 + 4 + 12 = 20 tris -> 60 indices
      expect(lMesh.indices.length).toBe(20 * 3);
      expect(lMesh.edgesBuffer!.length).toBe(18 * 2 * 3);
    }

    const tMesh = StaticProfileTemplates.generateTShapeBeam(0.15, 0.2, 0.01, 0.015, 2.5);
    expect(tMesh).not.toBeNull();
    if (tMesh) {
      // 8 * 6 = 48 vertices
      expect(tMesh.positions.length).toBe(48 * 3);
      // 6 + 6 + 16 = 28 tris -> 84 indices
      expect(tMesh.indices.length).toBe(28 * 3);
      expect(tMesh.edgesBuffer!.length).toBe(24 * 2 * 3);
    }

    const uMesh = StaticProfileTemplates.generateUShapeBeam(0.1, 0.2, 0.01, 0.015, 2.5);
    expect(uMesh).not.toBeNull();
    if (uMesh) {
      // 8 * 6 = 48 vertices
      expect(uMesh.positions.length).toBe(48 * 3);
      // 6 + 6 + 16 = 28 tris -> 84 indices
      expect(uMesh.indices.length).toBe(28 * 3);
      expect(uMesh.edgesBuffer!.length).toBe(24 * 2 * 3);
    }
  });

  it('T3: defends against degenerate geometry (Norma 11)', () => {
    // Negative or zero dimensions
    expect(StaticProfileTemplates.generateIShapeBeam(-0.2, 0.4, 0.01, 0.02, 3.0)).toBeNull();
    expect(StaticProfileTemplates.generateIShapeBeam(0.2, 0.4, 0.01, 0.02, 0)).toBeNull();

    // Geometric impossibility: web thicker than width or flanges overlapping
    expect(StaticProfileTemplates.generateIShapeBeam(0.1, 0.4, 0.15, 0.02, 3.0)).toBeNull();
    expect(StaticProfileTemplates.generateIShapeBeam(0.2, 0.1, 0.01, 0.06, 3.0)).toBeNull();

    // L-beam thickness >= width or depth
    expect(StaticProfileTemplates.generateLShapeBeam(0.1, 0.1, 0.12, 2.0)).toBeNull();
  });
});
