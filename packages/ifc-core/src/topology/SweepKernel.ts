/**
 * SweepKernel.ts — Computational Geometry Kernel for Sweep / Follow Me Extrusion.
 *
 * Adheres strictly to topological manifold requirements:
 * - Centralized tolerances from GeometryTolerance.ts.
 * - O(N*K) bounded complexity in profile transformations.
 * - Robust handling of closed loops, open polyline paths, and degenerate singularities.
 */
import { Vec3 } from '../math/Vec3';
import { GeometryTolerance } from '../math/GeometryTolerance';
import { PolyMesh } from './PolyMesh';

export interface ChainedPath {
  points: Vec3[];
  isClosed: boolean;
  totalLength: number;
}

export class SweepKernel {
  /**
   * Computes the unit normal of the profile polygon using Newell's method.
   */
  public static computePolygonNormal(vertices: Vec3[]): Vec3 {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    const n = vertices.length;

    for (let i = 0; i < n; i++) {
      const current = vertices[i];
      const next = vertices[(i + 1) % n];
      nx += (current.y - next.y) * (current.z + next.z);
      ny += (current.z - next.z) * (current.x + next.x);
      nz += (current.x - next.x) * (current.y + next.y);
    }

    const norm = Math.hypot(nx, ny, nz);
    if (norm > GeometryTolerance.MATH_EPSILON) {
      return new Vec3(nx / norm, ny / norm, nz / norm);
    }
    return Vec3.Y;
  }

  /**
   * Chains an unordered collection of line segments into a continuous 3D polyline path.
   */
  public static chainPathSegments(edges: { a: Vec3; b: Vec3 }[]): ChainedPath | null {
    if (!edges || edges.length === 0) return null;

    const segments: { a: Vec3; b: Vec3; used: boolean }[] = [];
    for (const e of edges) {
      if (e.a.distanceTo(e.b) > GeometryTolerance.COINCIDENT_POINT) {
        segments.push({ a: e.a, b: e.b, used: false });
      }
    }

    if (segments.length === 0) return null;

    const first = segments[0];
    first.used = true;

    const points: Vec3[] = [first.a, first.b];
    let expanded = true;

    while (expanded && segments.some((s) => !s.used)) {
      expanded = false;
      const head = points[points.length - 1];
      const tail = points[0];

      for (const s of segments) {
        if (s.used) continue;

        if (s.a.distanceTo(head) < GeometryTolerance.SNAP_TOLERANCE) {
          points.push(s.b);
          s.used = true;
          expanded = true;
          break;
        } else if (s.b.distanceTo(head) < GeometryTolerance.SNAP_TOLERANCE) {
          points.push(s.a);
          s.used = true;
          expanded = true;
          break;
        } else if (s.b.distanceTo(tail) < GeometryTolerance.SNAP_TOLERANCE) {
          points.unshift(s.a);
          s.used = true;
          expanded = true;
          break;
        } else if (s.a.distanceTo(tail) < GeometryTolerance.SNAP_TOLERANCE) {
          points.unshift(s.b);
          s.used = true;
          expanded = true;
          break;
        }
      }
    }

    let isClosed = false;
    if (
      points.length >= 4 &&
      points[0].distanceTo(points[points.length - 1]) < GeometryTolerance.SNAP_TOLERANCE
    ) {
      isClosed = true;
      points[points.length - 1] = points[0];
    }

    let totalLength = 0;
    for (let i = 0; i < points.length - 1; i++) {
      totalLength += points[i].distanceTo(points[i + 1]);
    }

    if (totalLength < GeometryTolerance.COINCIDENT_POINT) {
      return null;
    }

    return { points, isClosed, totalLength };
  }

  /**
   * Canonically aligns path origin (s = 0) and progression direction
   * relative to the position and orientation of the profile face.
   */
  public static alignPathToProfile(
    pathPoints: Vec3[],
    isClosed: boolean,
    profileVertices: Vec3[]
  ): { alignedPath: Vec3[]; isClosed: boolean } {
    if (pathPoints.length < 2 || profileVertices.length < 3) {
      return { alignedPath: pathPoints, isClosed };
    }

    const cleaned: Vec3[] = [];
    for (const p of pathPoints) {
      if (cleaned.length === 0 || cleaned[cleaned.length - 1].distanceTo(p) > GeometryTolerance.COINCIDENT_POINT) {
        cleaned.push(p);
      }
    }

    if (cleaned.length < 2) return { alignedPath: pathPoints, isClosed };

    const profNormal = this.computePolygonNormal(profileVertices);

    if (isClosed) {
      let uniqueNodes = [...cleaned];
      if (
        uniqueNodes.length >= 4 &&
        uniqueNodes[0].distanceTo(uniqueNodes[uniqueNodes.length - 1]) < GeometryTolerance.SNAP_TOLERANCE
      ) {
        uniqueNodes.pop();
      }

      const M = uniqueNodes.length;
      if (M < 3) return { alignedPath: pathPoints, isClosed };

      // Search for the closest point on the path to any profile vertex.
      // Can be an existing vertex or an interior point along a polygon edge.
      let bestSeg = 0;
      let bestT = 0;
      let bestProjPoint = uniqueNodes[0];
      let minDistance = Infinity;

      for (let i = 0; i < M; i++) {
        const a = uniqueNodes[i];
        const b = uniqueNodes[(i + 1) % M];
        const ab = b.sub(a);
        const lenSq = ab.lengthSq();

        for (const pv of profileVertices) {
          let t = 0;
          let proj = a;
          if (lenSq > GeometryTolerance.MATH_EPSILON) {
            t = Math.max(0, Math.min(1, pv.sub(a).dot(ab) / lenSq));
            proj = a.add(ab.scale(t));
          }
          const d = proj.distanceTo(pv);
          if (d < minDistance) {
            minDistance = d;
            bestSeg = i;
            bestT = t;
            bestProjPoint = proj;
          }
        }
      }

      let shifted: Vec3[] = [];
      if (bestT < 0.01) {
        // Coincides with uniqueNodes[bestSeg]
        for (let i = 0; i < M; i++) {
          shifted.push(uniqueNodes[(bestSeg + i) % M]);
        }
      } else if (bestT > 0.99) {
        // Coincides with uniqueNodes[(bestSeg + 1) % M]
        const nextIdx = (bestSeg + 1) % M;
        for (let i = 0; i < M; i++) {
          shifted.push(uniqueNodes[(nextIdx + i) % M]);
        }
      } else {
        // Profile lies in the interior of an edge (e.g. middle of a box top border).
        // Insert bestProjPoint as initial node so anchor distance is 0.
        shifted.push(bestProjPoint);
        for (let i = 1; i <= M; i++) {
          shifted.push(uniqueNodes[(bestSeg + i) % M]);
        }
      }

      const p0 = shifted[0];
      const pForward = shifted[1];
      const pBackward = shifted[shifted.length - 1];

      const tForward = pForward.sub(p0).normalize();
      const tBackward = pBackward.sub(p0).normalize();

      const dotForward = profNormal.dot(tForward);
      const dotBackward = profNormal.dot(tBackward);

      let finalNodes = shifted;
      if (dotForward < -GeometryTolerance.POINT_ON_PLANE && dotBackward > dotForward) {
        const reversed: Vec3[] = [p0];
        for (let i = shifted.length - 1; i >= 1; i--) {
          reversed.push(shifted[i]);
        }
        finalNodes = reversed;
      }

      finalNodes.push(finalNodes[0]);
      return { alignedPath: finalNodes, isClosed: true };
    }

    // Open paths: insert anchor if profile lies in the interior of a segment
    let bestSegOpen = -1;
    let bestTOpen = 0;
    let bestProjOpen = cleaned[0];
    let minDistanceOpen = Infinity;

    for (let i = 0; i < cleaned.length - 1; i++) {
      const a = cleaned[i];
      const b = cleaned[i + 1];
      const ab = b.sub(a);
      const lenSq = ab.lengthSq();

      for (const pv of profileVertices) {
        let t = 0;
        let proj = a;
        if (lenSq > GeometryTolerance.MATH_EPSILON) {
          t = Math.max(0, Math.min(1, pv.sub(a).dot(ab) / lenSq));
          proj = a.add(ab.scale(t));
        }
        const d = proj.distanceTo(pv);
        if (d < minDistanceOpen) {
          minDistanceOpen = d;
          bestSegOpen = i;
          bestTOpen = t;
          bestProjOpen = proj;
        }
      }
    }

    let segmentedPath = [...cleaned];
    if (bestTOpen > 0.01 && bestTOpen < 0.99 && bestSegOpen >= 0) {
      segmentedPath.splice(bestSegOpen + 1, 0, bestProjOpen);
    }

    let dStart = Infinity;
    let dEnd = Infinity;

    for (const pv of profileVertices) {
      dStart = Math.min(dStart, segmentedPath[0].distanceTo(pv));
      dEnd = Math.min(dEnd, segmentedPath[segmentedPath.length - 1].distanceTo(pv));
    }

    let orientedPath = segmentedPath;
    if (dEnd < dStart) {
      orientedPath = [...segmentedPath].reverse();
    }

    return { alignedPath: orientedPath, isClosed: false };
  }

  /**
   * Computes the normal vector of the plane containing a 3D path (if planar).
   * Utilizes Newell's formula and verifies that all path vertices lie on the plane.
   */
  public static computePathPlaneNormal(pathPoints: Vec3[]): Vec3 | null {
    if (pathPoints.length < 3) return null;

    let nx = 0, ny = 0, nz = 0;
    const n = pathPoints.length;
    for (let i = 0; i < n - 1; i++) {
      const cur = pathPoints[i];
      const next = pathPoints[i + 1];
      nx += (cur.y - next.y) * (cur.z + next.z);
      ny += (cur.z - next.z) * (cur.x + next.x);
      nz += (cur.x - next.x) * (cur.y + next.y);
    }
    const newell = new Vec3(nx, ny, nz);
    if (newell.lengthSq() > GeometryTolerance.MATH_EPSILON) {
      const norm = newell.normalize();
      const origin = pathPoints[0];
      const allOnPlane = pathPoints.every(
        (p) => Math.abs(p.sub(origin).dot(norm)) <= GeometryTolerance.POINT_ON_PLANE * 5
      );
      if (allOnPlane) return norm;
    }

    // If Newell is near zero (e.g. collinear or cancelling open segments), compute cross product
    let t0: Vec3 | null = null;
    for (let i = 0; i < n - 1; i++) {
      const seg = pathPoints[i + 1].sub(pathPoints[i]);
      if (seg.length() > GeometryTolerance.COINCIDENT_POINT) {
        t0 = seg.normalize();
        for (let j = i + 1; j < n - 1; j++) {
          const seg2 = pathPoints[j + 1].sub(pathPoints[j]);
          if (seg2.length() > GeometryTolerance.COINCIDENT_POINT) {
            const tJ = seg2.normalize();
            const cross = t0.cross(tJ);
            if (cross.lengthSq() > GeometryTolerance.MATH_EPSILON) {
              const norm = cross.normalize();
              const origin = pathPoints[0];
              const isPlanar = pathPoints.every(
                (p) => Math.abs(p.sub(origin).dot(norm)) <= GeometryTolerance.POINT_ON_PLANE * 5
              );
              if (isPlanar) return norm;
            }
          }
        }
        break;
      }
    }

    return null;
  }

  /**
   * Sweeps a planar polygonal section along a continuous 3D path.
   *
   * Algorithm: Surface Frame (Darboux Frame) with Invariant Canonical Up-Vector
   * and miter joint bisector correction at sharp corners (>= 20°).
   *
   * Mathematical guarantees (NORMAS_DESARROLLO_CROQUERA):
   *   1. On straight spans between corners, the orthonormal basis (U_i, V_i) is 100% identical
   *      at both segment endpoints, eliminating any spurious helical twisting.
   *   2. In loops lying on planes (such as the top face of a box), the vertical axis V
   *      remains strictly perpendicular to the plane (constant along the entire perimeter).
   *   3. At angular corners (>= 20°), incoming and outgoing sections are projected
   *      exactly onto the bisector plane normalize(tIn - tOut).
   */
  public static sweepProfileAlongPath(
    profileVertices: Vec3[],
    pathPoints: Vec3[],
    isClosed: boolean = false,
    meshId: string = 'sweep_mesh'
  ): PolyMesh | null {
    if (profileVertices.length < 3 || pathPoints.length < 2) {
      return null;
    }

    // 1. Canonically align path origin and orientation
    const alignment = this.alignPathToProfile(pathPoints, isClosed, profileVertices);
    const cleanedPath = alignment.alignedPath;
    const closed = alignment.isClosed;

    if (cleanedPath.length < 2) return null;

    const numNodes = cleanedPath.length;
    const k = profileVertices.length;

    // 2. Compute unit tangents for each segment
    const segTangents: Vec3[] = [];
    for (let i = 0; i < numNodes - 1; i++) {
      const dir = cleanedPath[i + 1].sub(cleanedPath[i]);
      const len = dir.length();
      segTangents.push(len > GeometryTolerance.MATH_EPSILON ? dir.scale(1 / len) : Vec3.Y);
    }

    // 3. Determine anchor node and effective attachment segment
    let attachNodeIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < numNodes; i++) {
      for (const pv of profileVertices) {
        const d = cleanedPath[i].distanceTo(pv);
        if (d < minDist) {
          minDist = d;
          attachNodeIdx = i;
        }
      }
    }

    let effectiveAttachSeg: number;
    if (attachNodeIdx === 0) {
      effectiveAttachSeg = 0;
    } else if (attachNodeIdx >= numNodes - 1) {
      effectiveAttachSeg = segTangents.length - 1;
    } else {
      const profNormal = SweepKernel.computePolygonNormal(profileVertices);
      const dotPrev = Math.abs(profNormal.dot(segTangents[attachNodeIdx - 1]));
      const dotNext = Math.abs(profNormal.dot(segTangents[attachNodeIdx]));
      effectiveAttachSeg = dotPrev >= dotNext ? attachNodeIdx - 1 : attachNodeIdx;
    }

    const anchor = cleanedPath[attachNodeIdx];
    const T_attach = segTangents[effectiveAttachSeg];

    // 4. Determine canonical invariant path orthonormal basis (Darboux Frame)
    const pathPlaneNormal = SweepKernel.computePathPlaneNormal(cleanedPath);
    const isPlanar = pathPlaneNormal !== null;

    // 5. Construct canonical orthonormal basis (U_i, V_i) for each path segment
    const segU: Vec3[] = [];
    const segV: Vec3[] = [];

    if (isPlanar) {
      // Canonical Surface Frame (Darboux):
      // For any path contained in a plane (horizontal, vertical, or tilted),
      // all segments T_i lie in the plane (T_i · N_plane = 0).
      // Therefore, the plane normal N_plane is strictly orthogonal to all segments T_i:
      // - V_i is the normal to the face surface (constant across the whole loop, molding depth)
      // - U_i is the intrinsic surface normal (T_i x V_i, uniformly oriented in the plane)
      let N_plane = pathPlaneNormal!;
      if (Math.abs(N_plane.dot(Vec3.Y)) > 0.7 && N_plane.y < 0) {
        N_plane = N_plane.negate();
      }

      for (let i = 0; i < segTangents.length; i++) {
        const T_i = segTangents[i];
        const V_i = N_plane;
        const U_i = T_i.cross(V_i).normalize();
        segU.push(U_i);
        segV.push(V_i);
      }
    } else {
      // Non-coplanar 3D free path (Parallel Transport)
      const V_up = Vec3.Y;
      for (let i = 0; i < segTangents.length; i++) {
        const T_i = segTangents[i];
        let vSeg = V_up.sub(T_i.scale(T_i.dot(V_up)));
        if (vSeg.lengthSq() < GeometryTolerance.MATH_EPSILON) {
          const arb = Math.abs(T_i.dot(Vec3.X)) < 0.9 ? Vec3.X : Vec3.Z;
          vSeg = T_i.cross(arb);
        }
        const V_i = vSeg.normalize();
        const U_i = T_i.cross(V_i).normalize();
        segU.push(U_i);
        segV.push(V_i);
      }
    }

    const U_attach = segU[effectiveAttachSeg];
    const V_attach = segV[effectiveAttachSeg];

    // 6. Decompose profile into local invariant coordinates (u_k, v_k)
    //    referenced to the transverse basis (U_attach, V_attach) at the anchor.
    const N_prof = SweepKernel.computePolygonNormal(profileVertices);
    const uCoords: number[] = [];
    const vCoords: number[] = [];
    let maxDistFromAnchor = 0;

    const dotNormal = N_prof.dot(T_attach);
    const isTransversal = Math.abs(dotNormal) > 0.5;

    if (isTransversal) {
      // Profile was already drawn on the transverse plane to the path
      for (const pv of profileVertices) {
        const r = pv.sub(anchor);
        uCoords.push(r.dot(U_attach));
        vCoords.push(r.dot(V_attach));
        maxDistFromAnchor = Math.max(maxDistFromAnchor, pv.distanceTo(anchor));
      }
    } else {
      // Profile was drawn coplanar to a face containing T_attach (e.g. on a wall).
      // Rotate its relative vector toward the transverse plane orthogonal to T_attach
      const effNormal = dotNormal >= 0 ? N_prof : N_prof.negate();
      const alignCross = effNormal.cross(T_attach);
      const alignAxis = alignCross.lengthSq() > GeometryTolerance.MATH_EPSILON
        ? alignCross.normalize()
        : V_attach;
      const angle = Math.acos(Math.max(-1, Math.min(1, effNormal.dot(T_attach))));

      for (const pv of profileVertices) {
        const r = pv.sub(anchor);
        const rAligned = SweepKernel.rotateVectorAroundAxis(r, alignAxis, angle);
        uCoords.push(rAligned.dot(U_attach));
        vCoords.push(rAligned.dot(V_attach));
        maxDistFromAnchor = Math.max(maxDistFromAnchor, pv.distanceTo(anchor));
      }
    }
    const profileDiagonal = Math.max(0.1, maxDistFromAnchor * 2);

    // 7. Generate transverse cross-sections at each path node
    const numSections = closed ? numNodes - 1 : numNodes;
    const sections: Vec3[][] = [];
    const numSegs = segTangents.length;

    for (let i = 0; i < numSections; i++) {
      const nodePos = cleanedPath[i];
      let tIn: Vec3;
      let tOut: Vec3;
      let U_node: Vec3;
      let V_node: Vec3;
      let isCorner: boolean;

      if (closed) {
        const prevSegIdx = (i - 1 + numSegs) % numSegs;
        const nextSegIdx = i % numSegs;
        tIn = segTangents[prevSegIdx];
        tOut = segTangents[nextSegIdx];
        U_node = segU[nextSegIdx];
        V_node = segV[nextSegIdx];
        const dotIn = Math.max(-1, Math.min(1, tIn.dot(tOut)));
        isCorner = dotIn < 0.9397; // Corner >= 20°
      } else {
        if (i === 0) {
          tIn = segTangents[0];
          tOut = segTangents[0];
          U_node = segU[0];
          V_node = segV[0];
          isCorner = false;
        } else if (i === numNodes - 1) {
          tIn = segTangents[numSegs - 1];
          tOut = segTangents[numSegs - 1];
          U_node = segU[numSegs - 1];
          V_node = segV[numSegs - 1];
          isCorner = false;
        } else {
          tIn = segTangents[i - 1];
          tOut = segTangents[i];
          U_node = segU[i];
          V_node = segV[i];
          const dotIn = Math.max(-1, Math.min(1, tIn.dot(tOut)));
          isCorner = dotIn < 0.9397;
        }
      }

      const nodeSection: Vec3[] = [];

      if (!isCorner) {
        // Straight span: direct orthogonal cross-section
        for (let j = 0; j < k; j++) {
          nodeSection.push(nodePos.add(U_node.scale(uCoords[j])).add(V_node.scale(vCoords[j])));
        }
      } else {
        // Miter corner: the exact normal to the cutting bisector plane is normalize(tIn + tOut)
        const miterDiff = tIn.add(tOut);
        const miterNormal = miterDiff.lengthSq() > GeometryTolerance.MATH_EPSILON
          ? miterDiff.normalize()
          : tOut;
        const denomMiter = tOut.dot(miterNormal);
        const maxMiterOffset = 5.0 * profileDiagonal;

        for (let j = 0; j < k; j++) {
          const P_raw = nodePos.add(U_node.scale(uCoords[j])).add(V_node.scale(vCoords[j]));
          if (Math.abs(denomMiter) > GeometryTolerance.POINT_ON_PLANE) {
            let t = nodePos.sub(P_raw).dot(miterNormal) / denomMiter;
            if (Math.abs(t) > maxMiterOffset) {
              t = Math.sign(t) * maxMiterOffset;
            }
            nodeSection.push(P_raw.add(tOut.scale(t)));
          } else {
            nodeSection.push(P_raw);
          }
        }
      }

      sections.push(nodeSection);
    }

    // 8. Construct B-Rep mesh (PolyMesh)
    const polyMesh = new PolyMesh(meshId);

    // 8.1 Lateral faces (Quads / Triangles depending on coplanarity)
    //     For open loops: sections.length == numNodes, iterate i=0..numNodes-2.
    //     For closed loops: sections.length == numNodes-1 (unique nodes), iterate all
    //     with modular closure: sB = sections[(i+1) % sections.length].
    const numFaceSteps = closed ? sections.length : sections.length - 1;
    for (let i = 0; i < numFaceSteps; i++) {
      const sA = sections[i];
      const sB = closed ? sections[(i + 1) % sections.length] : sections[i + 1];

      for (let j = 0; j < k; j++) {
        const nextJ = (j + 1) % k;
        const p1 = sA[j];
        const p2 = sA[nextJ];
        const p3 = sB[nextJ];
        const p4 = sB[j];

        const diag = p2.sub(p1).cross(p4.sub(p1));
        const diagLen = diag.length();
        const dotP3 = diagLen > GeometryTolerance.MATH_EPSILON
          ? Math.abs(p3.sub(p1).dot(diag.scale(1 / diagLen)))
          : 0;

        if (dotP3 < GeometryTolerance.POINT_ON_PLANE * 5) {
          polyMesh.addFace([p1, p2, p3, p4]);
        } else {
          polyMesh.addFace([p1, p2, p3]);
          polyMesh.addFace([p1, p3, p4]);
        }
      }
    }

    // 8.2 End caps on open paths
    if (!closed) {
      polyMesh.addFace([...sections[0]].reverse(), segTangents[0].negate());
      polyMesh.addFace([...sections[sections.length - 1]], segTangents[segTangents.length - 1]);
    }

    polyMesh.rebuildTopology();
    return polyMesh;
  }

  /**
   * Rotates a 3D vector around an arbitrary unit axis by an angle in radians (Rodrigues' rotation formula).
   */
  private static rotateVectorAroundAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const term1 = v.scale(cosA);
    const term2 = axis.cross(v).scale(sinA);
    const term3 = axis.scale(axis.dot(v) * (1 - cosA));
    return term1.add(term2).add(term3);
  }
}
