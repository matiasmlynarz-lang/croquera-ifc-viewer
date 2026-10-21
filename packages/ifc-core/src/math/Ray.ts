/**
 * Ray — 3D ray for raycasting and snapping in @croquera/ifc-core.
 */
import * as THREE from 'three';
import { Vec3 } from './Vec3';
import { Plane } from './Plane';
import { GeometryTolerance } from './GeometryTolerance';

export interface ClosestPointResult {
  point: Vec3;   // Closest point on the segment
  t: number;     // Parametric value along segment [0,1]
  distance: number;
}

export class Ray {
  public readonly origin: Vec3;
  public readonly direction: Vec3; // Normalized

  constructor(origin: Vec3, direction: Vec3) {
    this.origin = origin;
    this.direction = direction.normalize();
  }

  // ─── Point on ray ───────────────────────────────────────────
  pointAt(t: number): Vec3 {
    return this.origin.add(this.direction.scale(t));
  }

  // ─── Intersections ──────────────────────────────────────────
  intersectPlane(plane: Plane): Vec3 | null {
    return plane.intersectRay(this.origin, this.direction);
  }

  // ─── Closest point on a segment ─────────────────────────────
  closestPointToSegment(a: Vec3, b: Vec3): ClosestPointResult {
    const ab = b.sub(a);
    const abLen = ab.length();
    if (abLen < GeometryTolerance.MATH_EPSILON) {
      return { point: a, t: 0, distance: this.distanceToPoint(a) };
    }

    const abDir = ab.scale(1 / abLen);
    const ao = a.sub(this.origin);

    const d_dot_ab = this.direction.dot(abDir);
    const ao_dot_d = ao.dot(this.direction);
    const ao_dot_ab = ao.dot(abDir);

    const denom = 1 - d_dot_ab * d_dot_ab;

    let tN: number;

    if (Math.abs(denom) < GeometryTolerance.MATH_EPSILON) {
      tN = -ao_dot_ab;
    } else {
      tN = (d_dot_ab * ao_dot_d - ao_dot_ab) / denom;
    }

    const tClamped = Math.max(0, Math.min(abLen, tN));
    const closestOnSeg = a.add(abDir.scale(tClamped));

    const sForClosest = this.direction.dot(closestOnSeg.sub(this.origin));
    const closestOnRay = this.pointAt(Math.max(0, sForClosest));

    return {
      point: closestOnSeg,
      t: abLen > GeometryTolerance.MATH_EPSILON ? tClamped / abLen : 0,
      distance: closestOnSeg.distanceTo(closestOnRay),
    };
  }

  // ─── Closest point on an infinite 3D line ───────────────────
  closestPointToLine(pointOnLine: Vec3, lineDir: Vec3): { point: Vec3; t: number; distance: number } {
    const a = lineDir.normalize();
    const w0 = pointOnLine.sub(this.origin);

    const b = a.dot(this.direction);
    const d = a.dot(w0);
    const e = this.direction.dot(w0);

    const denom = 1 - b * b;

    let t: number;
    if (Math.abs(denom) < GeometryTolerance.MATH_EPSILON) {
      t = -d;
    } else {
      t = (b * e - d) / denom;
    }

    const linePoint = pointOnLine.add(a.scale(t));
    const s = Math.max(0, this.direction.dot(linePoint.sub(this.origin)));
    const rayPoint = this.pointAt(s);

    return {
      point: linePoint,
      t,
      distance: linePoint.distanceTo(rayPoint),
    };
  }

  // ─── Distance to a point ────────────────────────────────────
  distanceToPoint(p: Vec3): number {
    const ap = p.sub(this.origin);
    const proj = ap.dot(this.direction);
    const closestOnRay = this.pointAt(Math.max(0, proj));
    return p.distanceTo(closestOnRay);
  }

  // ─── Factory: from screen coordinates ───────────────────────
  static fromScreenCoords(
    screenX: number,
    screenY: number,
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    width: number,
    height: number,
    originOffset?: Vec3,
  ): Ray {
    const ndcX = (screenX / width) * 2 - 1;
    const ndcY = -(screenY / height) * 2 + 1;
    return Ray.fromNDC(ndcX, ndcY, camera, originOffset);
  }

  static fromNDC(
    ndcX: number,
    ndcY: number,
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    originOffset?: Vec3,
  ): Ray {
    if ('isPerspectiveCamera' in camera && camera.isPerspectiveCamera === true) {
      const ndc = new THREE.Vector3(ndcX, ndcY, 0.5);
      ndc.unproject(camera);

      const origin = Vec3.fromThree(camera.position);
      const direction = Vec3.fromThree(ndc.sub(camera.position).normalize());

      return new Ray(originOffset ? origin.add(originOffset) : origin, direction);
    } else {
      const nearPoint = new THREE.Vector3(ndcX, ndcY, -1).unproject(camera);
      const farPoint = new THREE.Vector3(ndcX, ndcY, 1).unproject(camera);

      const origin = Vec3.fromThree(nearPoint);
      const direction = Vec3.fromThree(farPoint.sub(nearPoint).normalize());

      return new Ray(originOffset ? origin.add(originOffset) : origin, direction);
    }
  }
}
