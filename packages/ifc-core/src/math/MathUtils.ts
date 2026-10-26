/**
 * MathUtils — Geometric helper functions for @croquera/ifc-core.
 */
import * as THREE from 'three';
import { Vec3 } from './Vec3';
import { GeometryTolerance } from './GeometryTolerance';

// ─── Point-on-Segment ─────────────────────────────────────────
export interface ClosestPointOnSegmentResult {
  point: Vec3;
  t: number; // Parametric [0, 1]
}

/**
 * Find the closest point on segment [a, b] to point p.
 */
export function closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): ClosestPointOnSegmentResult {
  const ab = b.sub(a);
  const abLenSq = ab.lengthSq();

  if (abLenSq < GeometryTolerance.MATH_EPSILON) {
    return { point: a, t: 0 };
  }

  let t = p.sub(a).dot(ab) / abLenSq;
  t = Math.max(0, Math.min(1, t));

  return {
    point: a.add(ab.scale(t)),
    t,
  };
}

// ─── Segment-Segment Closest Points ──────────────────────────
export interface SegmentSegmentResult {
  pointA: Vec3;
  pointB: Vec3;
  distance: number;
  tA: number; // Parametric on segment A [0, 1]
  tB: number; // Parametric on segment B [0, 1]
}

/**
 * Find the closest points between two segments [a1, a2] and [b1, b2].
 */
export function segmentSegmentClosestPoints(
  a1: Vec3, a2: Vec3,
  b1: Vec3, b2: Vec3,
): SegmentSegmentResult {
  const d1 = a2.sub(a1); // Direction of segment A
  const d2 = b2.sub(b1); // Direction of segment B
  const r = a1.sub(b1);

  const a = d1.dot(d1); // |d1|^2
  const e = d2.dot(d2); // |d2|^2
  const f = d2.dot(r);

  if (a < GeometryTolerance.MATH_EPSILON && e < GeometryTolerance.MATH_EPSILON) {
    return { pointA: a1, pointB: b1, distance: a1.distanceTo(b1), tA: 0, tB: 0 };
  }

  let sN: number, tN: number;

  if (a < GeometryTolerance.MATH_EPSILON) {
    sN = 0;
    tN = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1.dot(r);
    if (e < GeometryTolerance.MATH_EPSILON) {
      tN = 0;
      sN = Math.max(0, Math.min(1, -c / a));
    } else {
      const b_val = d1.dot(d2);
      const denom = a * e - b_val * b_val;

      if (Math.abs(denom) > GeometryTolerance.MATH_EPSILON) {
        sN = Math.max(0, Math.min(1, (b_val * f - c * e) / denom));
      } else {
        sN = 0;
      }

      tN = (b_val * sN + f) / e;

      if (tN < 0) {
        tN = 0;
        sN = Math.max(0, Math.min(1, -c / a));
      } else if (tN > 1) {
        tN = 1;
        sN = Math.max(0, Math.min(1, (b_val - c) / a));
      }
    }
  }

  const pointA = a1.add(d1.scale(sN));
  const pointB = b1.add(d2.scale(tN));

  return {
    pointA,
    pointB,
    distance: pointA.distanceTo(pointB),
    tA: sN,
    tB: tN,
  };
}

// ─── World-to-Screen Projection ───────────────────────────────
export function worldToScreen(
  worldPoint: Vec3,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  width: number,
  height: number,
  renderOffset?: Vec3,
): { x: number; y: number; behindCamera: boolean } {
  const p = renderOffset ? worldPoint.sub(renderOffset) : worldPoint;
  const v = p.toThree();
  v.project(camera);

  return {
    x: (v.x * 0.5 + 0.5) * width,
    y: (-v.y * 0.5 + 0.5) * height,
    behindCamera: v.z > 1,
  };
}

export function screenDistancePx(
  worldPoint: Vec3,
  cursorScreenX: number,
  cursorScreenY: number,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  width: number,
  height: number,
  renderOffset?: Vec3,
): number {
  const projected = worldToScreen(worldPoint, camera, width, height, renderOffset);
  if (projected.behindCamera) return Infinity;
  const dx = projected.x - cursorScreenX;
  const dy = projected.y - cursorScreenY;
  return Math.sqrt(dx * dx + dy * dy);
}

// ─── Point-in-Polygon (2D projected) ─────────────────────────
export function pointInPolygon3D(point: Vec3, polygon: Vec3[], normal: Vec3): boolean {
  const absN = new Vec3(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z));
  let u: 'x' | 'y' | 'z';
  let v: 'x' | 'y' | 'z';

  if (absN.x >= absN.y && absN.x >= absN.z) {
    u = 'y'; v = 'z';
  } else if (absN.y >= absN.x && absN.y >= absN.z) {
    u = 'x'; v = 'z';
  } else {
    u = 'x'; v = 'y';
  }

  const px = point[u];
  const py = point[v];

  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i][u], yi = polygon[i][v];
    const xj = polygon[j][u], yj = polygon[j][v];

    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }

  return inside;
}

// ─── Angle helpers ────────────────────────────────────────────
export function areParallel(a: Vec3, b: Vec3, toleranceRad: number = 0.087): boolean {
  const angle = a.normalize().angleTo(b.normalize());
  return angle < toleranceRad || Math.abs(angle - Math.PI) < toleranceRad;
}

export function arePerpendicular(a: Vec3, b: Vec3, toleranceRad: number = 0.087): boolean {
  const angle = a.normalize().angleTo(b.normalize());
  return Math.abs(angle - Math.PI / 2) < toleranceRad;
}

// ─── Intersections ───────────────────────────────────────────
export function segmentSegmentIntersection3D(
  a1: Vec3, a2: Vec3,
  b1: Vec3, b2: Vec3,
  tolerance3D: number = 0.005,
): { point: Vec3; tA: number; tB: number } | null {
  const res = segmentSegmentClosestPoints(a1, a2, b1, b2);
  const lenA = a2.sub(a1).length();
  const lenB = b2.sub(b1).length();
  const minOffsetA = lenA > 0 ? GeometryTolerance.MIN_EDGE_LENGTH / lenA : 0.001;
  const minOffsetB = lenB > 0 ? GeometryTolerance.MIN_EDGE_LENGTH / lenB : 0.001;

  if (
    res.distance <= tolerance3D &&
    res.tA > minOffsetA && res.tA < (1 - minOffsetA) &&
    res.tB > minOffsetB && res.tB < (1 - minOffsetB)
  ) {
    return {
      point: res.pointA.lerp(res.pointB, 0.5),
      tA: res.tA,
      tB: res.tB,
    };
  }
  return null;
}

export function segmentFaceIntersection3D(
  segA: Vec3,
  segB: Vec3,
  faceVertices: Vec3[],
  faceNormal: Vec3,
): Vec3 | null {
  const dir = segB.sub(segA);
  const len = dir.length();
  if (len < GeometryTolerance.MIN_EDGE_LENGTH) return null;

  const denom = faceNormal.dot(dir);
  if (Math.abs(denom) < GeometryTolerance.COPLANAR_NORMAL) return null;

  const v0 = faceVertices[0];
  if (!v0) return null;

  const t = faceNormal.dot(v0.sub(segA)) / denom;
  const minOffset = GeometryTolerance.MIN_EDGE_LENGTH / len;
  if (t <= minOffset || t >= (1 - minOffset)) return null;

  const hit = segA.add(dir.scale(t));
  if (pointInPolygon3D(hit, faceVertices, faceNormal)) {
    return hit;
  }
  return null;
}

export function rotatePointAroundAxis(point: Vec3, axisPoint: Vec3, axisDir: Vec3, theta: number): Vec3 {
  if (Math.abs(theta) < GeometryTolerance.MATH_EPSILON) return point;
  const p = point.sub(axisPoint);
  const d = axisDir.normalize();

  const parallel = d.scale(p.dot(d));
  const u = p.sub(parallel);

  if (u.lengthSq() < GeometryTolerance.COINCIDENT_POINT_SQ) {
    return point;
  }

  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const rotatedPerp = u.scale(cosT).add(d.cross(u).scale(sinT));

  return axisPoint.add(parallel).add(rotatedPerp);
}
