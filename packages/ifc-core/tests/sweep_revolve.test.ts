import { describe, it, expect } from 'vitest';
import { SweepKernel, RevolveKernel, Vec3 } from '../src';

describe('SweepKernel & RevolveKernel Unit Tests', () => {
  it('computes correct Newell normal for planar polygons', () => {
    const squareVertices = [
      new Vec3(0, 0, 0),
      new Vec3(2, 0, 0),
      new Vec3(2, 0, 2),
      new Vec3(0, 0, 2),
    ];

    const normal = SweepKernel.computePolygonNormal(squareVertices);
    expect(normal.x).toBeCloseTo(0, 4);
    expect(normal.y).toBeCloseTo(-1, 4); // Clockwise in X-Z gives -Y
    expect(normal.z).toBeCloseTo(0, 4);
  });

  it('chains unordered edges into continuous path segments', () => {
    const edges = [
      { a: new Vec3(2, 0, 0), b: new Vec3(4, 0, 0) },
      { a: new Vec3(0, 0, 0), b: new Vec3(2, 0, 0) },
      { a: new Vec3(4, 0, 0), b: new Vec3(4, 2, 0) },
    ];

    const chained = SweepKernel.chainPathSegments(edges);
    expect(chained).not.toBeNull();
    expect(chained?.points).toHaveLength(4);
    expect(chained?.isClosed).toBe(false);
    expect(chained?.totalLength).toBeCloseTo(6.0, 4);
  });

  it('generates a solid of revolution around vertical axis', () => {
    // 2D profile offset from axis (x = 2 to 3, y = 0 to 1)
    const profile = [
      new Vec3(2, 0, 0),
      new Vec3(3, 0, 0),
      new Vec3(3, 1, 0),
      new Vec3(2, 1, 0),
    ];

    const mesh = RevolveKernel.revolveProfile({
      profileVertices: profile,
      axisPoint: new Vec3(0, 0, 0),
      axisDirection: new Vec3(0, 1, 0), // Vertical Y axis
      angleRadians: Math.PI * 2, // Full revolution
      segmentsCount: 8,
    });

    expect(mesh).not.toBeNull();
    expect(mesh?.faces.size).toBeGreaterThan(0);
    expect(mesh?.vertices.size).toBeGreaterThan(0);
  });
});
