import { describe, it, expect } from 'vitest';
import { PolygonClipping, Vec3, GeometryTolerance } from '../src';

describe('PolygonClipping Unit Tests', () => {
  it('builds valid orthonormal local basis for horizontal and vertical planes', () => {
    const origin = new Vec3(0, 0, 0);

    // Horizontal plane (normal along Y)
    const horizBasis = PolygonClipping.getLocalBasis(origin, Vec3.Y);
    expect(horizBasis.normal.dot(horizBasis.u)).toBeCloseTo(0, 5);
    expect(horizBasis.normal.dot(horizBasis.v)).toBeCloseTo(0, 5);
    expect(horizBasis.u.dot(horizBasis.v)).toBeCloseTo(0, 5);
    expect(horizBasis.u.length()).toBeCloseTo(1, 5);
    expect(horizBasis.v.length()).toBeCloseTo(1, 5);

    // Vertical plane (normal along Z)
    const vertBasis = PolygonClipping.getLocalBasis(origin, Vec3.Z);
    expect(vertBasis.normal.dot(vertBasis.u)).toBeCloseTo(0, 5);
    expect(vertBasis.normal.dot(vertBasis.v)).toBeCloseTo(0, 5);
    expect(vertBasis.u.dot(vertBasis.v)).toBeCloseTo(0, 5);
  });

  it('projects and unprojects 3D points onto plane losslessly', () => {
    const origin = new Vec3(10, 5, 2);
    const normal = new Vec3(0, 1, 0);
    const basis = PolygonClipping.getLocalBasis(origin, normal);

    const testPoint = new Vec3(14, 5, 8); // On the plane y = 5
    const p2D = PolygonClipping.projectTo2D(testPoint, basis);
    const restored3D = PolygonClipping.unprojectTo3D(p2D, basis);

    expect(restored3D.distanceTo(testPoint)).toBeLessThan(GeometryTolerance.COINCIDENT_VERTEX);
  });

  it('tests point inclusion in 2D convex polygons and computes signed area', () => {
    // 2D Square [0,0] to [4,4]
    const square = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];

    expect(PolygonClipping.pointInPolygon2D({ x: 2, y: 2 }, square)).toBe(true);
    expect(PolygonClipping.pointInPolygon2D({ x: 5, y: 2 }, square)).toBe(false);
    expect(PolygonClipping.pointInPolygon2D({ x: -1, y: 2 }, square)).toBe(false);

    const area = PolygonClipping.signedArea2D(square);
    expect(area).toBeCloseTo(16, 4);
  });
});
