/**
 * Plane — Immutable 3D plane for @croquera/ifc-core.
 * Defined by a unit normal and signed distance from origin: n·p + d = 0.
 */
import { Vec3 } from './Vec3';
import { GeometryTolerance } from './GeometryTolerance';

export class Plane {
  /** Unit normal pointing "outward". */
  public readonly normal: Vec3;
  /** Signed distance from origin (n·p + d = 0). */
  public readonly d: number;

  constructor(normal: Vec3, d: number) {
    const len = normal.length();
    if (len < GeometryTolerance.MATH_EPSILON) {
      this.normal = Vec3.Y;
      this.d = 0;
    } else {
      this.normal = normal.scale(1 / len);
      this.d = d / len;
    }
  }

  // ─── Factory Methods ────────────────────────────────────────
  /** Create a plane from a point on the plane and its normal. */
  static fromPointAndNormal(point: Vec3, normal: Vec3): Plane {
    const n = normal.normalize();
    return new Plane(n, -n.dot(point));
  }

  /** Create a plane from three non-collinear points (CCW winding). Returns null if points are collinear. */
  static fromThreePoints(a: Vec3, b: Vec3, c: Vec3): Plane | null {
    const cross = b.sub(a).cross(c.sub(a));
    const len = cross.length();
    if (len < GeometryTolerance.MATH_EPSILON) {
      return null;
    }
    const n = cross.scale(1 / len);
    return new Plane(n, -n.dot(a));
  }

  // ─── Standard Planes ───────────────────────────────────────
  /** XZ ground plane at Y=0 (normal pointing up). */
  static readonly XZ = new Plane(Vec3.Y, 0);
  /** XY plane at Z=0. */
  static readonly XY = new Plane(Vec3.Z, 0);
  /** YZ plane at X=0. */
  static readonly YZ = new Plane(Vec3.X, 0);

  // ─── Queries ────────────────────────────────────────────────
  /** Signed distance from point to plane (positive = same side as normal). */
  distanceToPoint(p: Vec3): number {
    return this.normal.dot(p) + this.d;
  }

  /** Orthogonal projection of a point onto the plane. */
  projectPoint(p: Vec3): Vec3 {
    return p.sub(this.normal.scale(this.distanceToPoint(p)));
  }

  /** Check if a point lies on the plane within tolerance. */
  containsPoint(p: Vec3, tolerance: number = GeometryTolerance.POINT_ON_PLANE): boolean {
    return Math.abs(this.distanceToPoint(p)) < tolerance;
  }

  /** Point on the plane closest to origin. */
  get origin(): Vec3 {
    return this.normal.scale(-this.d);
  }

  // ─── Intersections ──────────────────────────────────────────
  /**
   * Intersect a ray with this plane.
   * Returns null if the ray is parallel to the plane.
   */
  intersectRay(rayOrigin: Vec3, rayDirection: Vec3): Vec3 | null {
    const denom = this.normal.dot(rayDirection);
    if (Math.abs(denom) < GeometryTolerance.MATH_EPSILON) return null; // Parallel

    const t = -(this.normal.dot(rayOrigin) + this.d) / denom;
    if (t < -GeometryTolerance.MATH_EPSILON) return null; // Behind ray origin
    return rayOrigin.add(rayDirection.scale(t));
  }

  /**
   * Intersect a line (infinite, not clamped) with this plane.
   */
  intersectLine(lineOrigin: Vec3, lineDirection: Vec3): Vec3 | null {
    const denom = this.normal.dot(lineDirection);
    if (Math.abs(denom) < GeometryTolerance.MATH_EPSILON) return null;
    const t = -(this.normal.dot(lineOrigin) + this.d) / denom;
    return lineOrigin.add(lineDirection.scale(t));
  }
}
