/**
 * RevolveKernel — Computational geometry and topological builder for Solids of Revolution.
 *
 * Provides:
 * - Precise 3D profile rotation using Rodrigues' formula around an arbitrary 3D axis.
 * - Axial singularity handling (vertices on the axis automatically collapse quads into clean triangles at poles).
 * - Full 360° closed revolution (2-manifold watertight B-Rep with no internal caps).
 * - Partial revolution (< 360°) with proper capping faces at start and end sectors.
 * - Strict adherence to NORMAS_DESARROLLO_CROQUERA (tolerances from GeometryTolerance.ts, zero local EPSILON).
 */

import { Vec3 } from '../math/Vec3';
import { GeometryTolerance } from '../math/GeometryTolerance';
import { PolyMesh } from './PolyMesh';
import { rotatePointAroundAxis } from '../math/MathUtils';
import { GuidUtils } from '../types/GuidUtils';

export interface RevolveOptions {
  profileVertices: Vec3[];
  axisPoint: Vec3;
  axisDirection: Vec3;
  angleRadians: number;
  segmentsCount?: number;
  meshId?: string;
}

export class RevolveKernel {
  /**
   * Rotates a 3D point around a linear axis (axisPoint, axisDir) by a given angle theta (Rodrigues' formula).
   */
  public static rotatePointAroundAxis(point: Vec3, axisPoint: Vec3, axisDir: Vec3, theta: number): Vec3 {
    return rotatePointAroundAxis(point, axisPoint, axisDir, theta);
  }

  /**
   * Computes the minimum distance from a point to a linear axis (axisPoint, axisDir).
   */
  public static distanceToAxis(point: Vec3, axisPoint: Vec3, axisDir: Vec3): number {
    const p = point.sub(axisPoint);
    const d = axisDir.normalize();
    const proj = d.scale(p.dot(d));
    return p.sub(proj).length();
  }

  /**
   * Generates a B-Rep solid (PolyMesh) of revolution by revolving a planar profile around an axis.
   */
  public static revolveProfile(options: RevolveOptions): PolyMesh | null {
    const {
      profileVertices,
      axisPoint,
      axisDirection,
      angleRadians,
      segmentsCount,
      meshId = GuidUtils.createIfcGuid(),
    } = options;

    if (!profileVertices || profileVertices.length < 3) {
      return null;
    }

    const axisDir = axisDirection.normalize();
    if (axisDir.lengthSq() < GeometryTolerance.MATH_EPSILON) {
      return null;
    }

    // Normalize angle into (0, 2pi]
    let totalAngle = angleRadians;
    if (totalAngle <= GeometryTolerance.MATH_EPSILON) {
      return null;
    }
    if (totalAngle > 2 * Math.PI) {
      totalAngle = 2 * Math.PI;
    }

    const isFullRevolve = Math.abs(totalAngle - 2 * Math.PI) <= GeometryTolerance.COPLANAR_NORMAL;

    // Determine radial segment subdivisions
    let M = segmentsCount;
    if (!M || M < 3) {
      const fullSteps = 24;
      M = Math.max(4, Math.round(fullSteps * (totalAngle / (2 * Math.PI))));
    }

    const k = profileVertices.length;

    // Detect which profile vertices lie directly on the rotation axis
    const isOnAxis: boolean[] = profileVertices.map(
      (pv) => this.distanceToAxis(pv, axisPoint, axisDir) < GeometryTolerance.COINCIDENT_POINT
    );

    // 1. Generate all rotated vertex rings (rings: [M + 1][k])
    // If full 360 revolution, ring M is identical to ring 0
    const ringsCount = isFullRevolve ? M : M + 1;
    const rings: Vec3[][] = [];

    for (let i = 0; i < ringsCount; i++) {
      const theta_i = (i / M) * totalAngle;
      const ringVertices: Vec3[] = [];
      for (let j = 0; j < k; j++) {
        if (isOnAxis[j]) {
          // If on the axis, the point is rotationally invariant
          ringVertices.push(profileVertices[j]);
        } else {
          ringVertices.push(this.rotatePointAroundAxis(profileVertices[j], axisPoint, axisDir, theta_i));
        }
      }
      rings.push(ringVertices);
    }

    const polyMesh = new PolyMesh(meshId);

    // Profile normal and outward edge normals on the profile plane
    const nProfile = PolyMesh.computePolygonNormal(profileVertices);
    const edgeOutwardNormals: Vec3[] = [];
    for (let j = 0; j < k; j++) {
      const nextJ = (j + 1) % k;
      const edgeVec = profileVertices[nextJ].sub(profileVertices[j]);
      // In an oriented profile polygon, outward perpendicular vector is edgeVec x nProfile
      const outN = edgeVec.cross(nProfile);
      edgeOutwardNormals.push(outN.lengthSq() > GeometryTolerance.MATH_EPSILON ? outN.normalize() : Vec3.ZERO);
    }

    // Helper to add faces verifying non-zero area and proper outward orientation
    const tryAddFace = (verts: Vec3[], explicitNormal?: Vec3) => {
      // Filter out coincident consecutive vertices
      const cleaned: Vec3[] = [];
      const n = verts.length;
      for (let idx = 0; idx < n; idx++) {
        const cur = verts[idx];
        const next = verts[(idx + 1) % n];
        if (cur.distanceTo(next) >= GeometryTolerance.MIN_EDGE_LENGTH) {
          cleaned.push(cur);
        }
      }
      if (cleaned.length >= 3) {
        polyMesh.addFace(cleaned, explicitNormal);
      }
    };

    // 2. Stitch lateral quad/triangle faces between consecutive radial rings
    for (let i = 0; i < M; i++) {
      const ringA = rings[i];
      const ringB = isFullRevolve && i === M - 1 ? rings[0] : rings[i + 1];
      const midTheta = ((i + 0.5) / M) * totalAngle;

      for (let j = 0; j < k; j++) {
        const nextJ = (j + 1) % k;

        const vA1 = ringA[j];
        const vA2 = ringA[nextJ];
        const vB1 = ringB[j];
        const vB2 = ringB[nextJ];

        const jOnAxis = isOnAxis[j];
        const nextJOnAxis = isOnAxis[nextJ];

        if (jOnAxis && nextJOnAxis) {
          // Both vertices are on the axis: internal axial edge, skip degenerate face
          continue;
        }

        // Expected mathematical outward normal for this face at mid angular step
        const baseOutN = edgeOutwardNormals[j];
        const faceOutN = baseOutN.lengthSq() > 0.5
          ? this.rotatePointAroundAxis(baseOutN, Vec3.ZERO, axisDir, midTheta).normalize()
          : undefined;

        if (jOnAxis) {
          // Top/bottom pole: vA1 == vB1, collapses into triangle [vA1, vB2, vA2]
          tryAddFace([vA1, vB2, vA2], faceOutN);
        } else if (nextJOnAxis) {
          // Top/bottom pole: vA2 == vB2, collapses into triangle [vA1, vB1, vA2]
          tryAddFace([vA1, vB1, vA2], faceOutN);
        } else {
          // Regular swept quad
          tryAddFace([vA1, vB1, vB2, vA2], faceOutN);
        }
      }
    }

    // 3. If revolution is partial (< 360 degrees), add endcap faces at both ends
    if (!isFullRevolve) {
      const profileCenter = profileVertices.reduce((acc, v) => acc.add(v), Vec3.ZERO).scale(1 / k);
      const radVec = profileCenter.sub(axisPoint);
      const motionDir = axisDir.cross(radVec).normalize();

      // Start endcap at theta = 0: normal opposite to rotation direction
      const startCapNormal = motionDir.negate();
      tryAddFace(profileVertices, startCapNormal);

      // End endcap at theta = totalAngle: normal along rotation direction
      const endMotionDir = this.rotatePointAroundAxis(motionDir, Vec3.ZERO, axisDir, totalAngle).normalize();
      tryAddFace(rings[M], endMotionDir);
    }

    polyMesh.rebuildTopology();
    return polyMesh;
  }
}
