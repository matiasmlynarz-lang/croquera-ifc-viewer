/**
 * OpeningVoidSolver — Computational geometry B-Rep solver for IfcOpeningElement voids.
 *
 * Implements projected boundary loop piercing and jamba face insertion with
 * BooleanCSGKernel fallback for non-orthogonal shapes.
 */

import * as THREE from 'three';
import { Vec3 } from '../math/Vec3';
import { PolyMesh } from './PolyMesh';
import { Face } from './HalfEdge';
import { PolygonClipping, type LocalBasis, type Vec2D } from './PolygonClipping';
import { GeometryTolerance } from '../math/GeometryTolerance';
import { BooleanCSGKernel } from './BooleanCSGKernel';

export class OpeningVoidSolver {
  /**
   * Tags existing jamba faces in the host mesh that match opening side faces.
   */
  public static tagExistingJambas(
    hostMesh: PolyMesh,
    openingMesh: PolyMesh,
    openingGroupId: string,
    matrix: THREE.Matrix4 = new THREE.Matrix4(),
    isIdentity: boolean = true
  ): number {
    let taggedCount = 0;

    interface TransformedFace {
      positions: Vec3[];
      normal: Vec3;
      planeOrigin: Vec3;
    }

    const transformedOpFaces: TransformedFace[] = [];
    for (const f of openingMesh.faces.values()) {
      let pos = f.getPositions();
      let norm = f.normal;
      if (!isIdentity) {
        pos = pos.map((p) => {
          const v = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(matrix);
          return new Vec3(v.x, v.y, v.z);
        });
        const vn = new THREE.Vector3(norm.x, norm.y, norm.z).transformDirection(matrix);
        norm = new Vec3(vn.x, vn.y, vn.z).normalize();
      }
      const planeOrigin = pos[0] || Vec3.ZERO;
      transformedOpFaces.push({ positions: pos, normal: norm, planeOrigin });
    }

    for (const hostFace of hostMesh.faces.values()) {
      if (hostFace.openingId) continue;
      const hostPositions = hostFace.getPositions();
      const hostNormal = hostFace.normal;
      const hostCentroid = hostFace.centroid;

      for (const opFace of transformedOpFaces) {
        if (hostNormal.dot(opFace.normal) < -0.99) {
          const opCentroid = opFace.positions
            .reduce((acc, p) => acc.add(p), Vec3.ZERO)
            .scale(1 / Math.max(1, opFace.positions.length));

          if (hostCentroid.distanceTo(opCentroid) < 1e-3) {
            hostFace.openingId = openingGroupId;
            taggedCount++;
            break;
          }
        }
      }
    }

    return taggedCount;
  }

  /**
   * Carves a void directly into the host mesh.
   */
  public static carveVoidIntoHost(
    hostMesh: PolyMesh,
    openingMesh: PolyMesh,
    openingGroupId: string,
    matrix: THREE.Matrix4 = new THREE.Matrix4(),
    isIdentity: boolean = true,
    requireThrough: boolean = false
  ): boolean {
    interface OpFaceData {
      positions: Vec3[];
      normal: Vec3;
    }

    const transformedOpFaces: OpFaceData[] = [];
    for (const f of openingMesh.faces.values()) {
      let pos = f.getPositions();
      let norm = f.normal;
      if (!isIdentity) {
        pos = pos.map((p) => {
          const v = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(matrix);
          return new Vec3(v.x, v.y, v.z);
        });
        const vn = new THREE.Vector3(norm.x, norm.y, norm.z).transformDirection(matrix);
        norm = new Vec3(vn.x, vn.y, vn.z).normalize();
      }
      transformedOpFaces.push({ positions: pos, normal: norm });
    }

    if (transformedOpFaces.length === 0) return false;

    const allOpPoints: Vec3[] = [];
    for (const of of transformedOpFaces) {
      for (const pos of of.positions) {
        allOpPoints.push(pos);
      }
    }

    interface PiercedFace {
      face: Face;
      loop3D: Vec3[];
      cap: OpFaceData;
      basis: LocalBasis;
    }

    const piercedHostFaces: PiercedFace[] = [];

    for (const hf of hostMesh.faces.values()) {
      if (hf.openingId) continue;

      let dMin = Infinity;
      let dMax = -Infinity;
      for (const p of allOpPoints) {
        const d = hf.plane.distanceToPoint(p);
        if (d < dMin) dMin = d;
        if (d > dMax) dMax = d;
      }
      if (dMin > GeometryTolerance.COINCIDENT_POINT || dMax < -GeometryTolerance.COINCIDENT_POINT) {
        continue;
      }

      let candidateCaps = transformedOpFaces
        .map((of) => {
          const dot = Math.abs(hf.normal.dot(of.normal));
          const p0 = of.positions[0];
          const distToPlane = p0 ? Math.abs(hf.plane.distanceToPoint(p0)) : Infinity;
          return { cap: of, dot, distToPlane };
        })
        .filter((c) => c.dot > GeometryTolerance.OPENING_PARALLEL_CAP_DOT)
        .sort((a, b) => b.dot - a.dot || a.distToPlane - b.distToPlane);

      if (candidateCaps.length === 0) {
        candidateCaps = transformedOpFaces
          .map((of) => {
            const dot = Math.abs(hf.normal.dot(of.normal));
            const p0 = of.positions[0];
            const distToPlane = p0 ? Math.abs(hf.plane.distanceToPoint(p0)) : Infinity;
            return { cap: of, dot, distToPlane };
          })
          .filter((c) => c.dot > GeometryTolerance.OPENING_SLANTED_CAP_DOT)
          .sort((a, b) => b.dot - a.dot || a.distToPlane - b.distToPlane);
      }

      for (const { cap: of } of candidateCaps) {
        const basis = PolygonClipping.getLocalBasis(hf.plane.origin, hf.normal);
        const hf2D = hf.getPositions().map((p: Vec3) => PolygonClipping.projectTo2D(p, basis));
        const of2D = of.positions.map((p: Vec3) => PolygonClipping.projectTo2D(p, basis));
        const ofCenter2D = of2D.reduce((a, b) => ({ x: a.x + b.x, y: a.y + b.y }));
        ofCenter2D.x /= of2D.length;
        ofCenter2D.y /= of2D.length;

        const allVertsIn = of2D.every((p) => PolygonClipping.isPointInOrOnPolygon2D(p, hf2D, GeometryTolerance.COINCIDENT_VERTEX * 10));
        const centroidIn = PolygonClipping.isPointInOrOnPolygon2D(ofCenter2D, hf2D);
        const anyVertIn = of2D.some((p) => PolygonClipping.pointInPolygon2D(p, hf2D));
        const anyHfVertIn = !centroidIn && !anyVertIn && hf2D.some((p) => PolygonClipping.pointInPolygon2D(p, of2D));

        const isValidPiercing = requireThrough ? allVertsIn : (centroidIn || anyVertIn || anyHfVertIn);

        if (isValidPiercing) {
          if (!piercedHostFaces.some((p) => p.face.id === hf.id)) {
            const projectedLoop3D = of2D.map((p2d) => PolygonClipping.unprojectTo3D(p2d, basis));
            piercedHostFaces.push({ face: hf, cap: of, basis, loop3D: projectedLoop3D });
            break;
          }
        }
      }
    }

    let p1: PiercedFace | null = null;
    let p2: PiercedFace | null = null;

    if (piercedHostFaces.length >= 2) {
      let bestVerticalDist = Infinity;
      for (let i = 0; i < piercedHostFaces.length; i++) {
        for (let j = i + 1; j < piercedHostFaces.length; j++) {
          const fA = piercedHostFaces[i];
          const fB = piercedHostFaces[j];
          if (fA.face.normal.dot(fB.face.normal) < GeometryTolerance.OPENING_OPPOSITE_NORMAL_DOT) {
            const isVerticalPair =
              Math.abs(fA.face.normal.y) < GeometryTolerance.OPENING_VERTICAL_NORMAL_DOT &&
              Math.abs(fB.face.normal.y) < GeometryTolerance.OPENING_VERTICAL_NORMAL_DOT;
            const dist = Math.abs(fA.face.plane.distanceToPoint(fB.face.plane.origin));
            if (isVerticalPair) {
              if (dist < bestVerticalDist) {
                bestVerticalDist = dist;
                p1 = fA;
                p2 = fB;
              }
            } else if (!p1 && !p2) {
              p1 = fA;
              p2 = fB;
            }
          }
        }
      }
    }

    if (p1 && p2) {
      const frontFaces = piercedHostFaces.filter(
        (p) => p.face.normal.dot(p1!.face.normal) > GeometryTolerance.OPENING_DIRECTION_ALIGNMENT_DOT
      );
      const backFaces = piercedHostFaces.filter(
        (p) => p.face.normal.dot(p2!.face.normal) > GeometryTolerance.OPENING_DIRECTION_ALIGNMENT_DOT
      );

      for (const pf of frontFaces) {
        this.applyVoidCutToHostFace(hostMesh, pf.face, pf.loop3D, openingGroupId, pf.basis);
      }

      const l1 = p1.loop3D;
      const n = l1.length;
      const cap1 = p1.cap;
      const oppCap =
        transformedOpFaces.find(
          (f) => f.normal.dot(cap1.normal) < GeometryTolerance.OPENING_STRICT_OPPOSITE_DOT
        ) || p2.cap;
      const basis2 = p2.basis;
      const opp2D = oppCap.positions.map((p) => PolygonClipping.projectTo2D(p, basis2));
      const rawL2 = opp2D.map((p2d) => PolygonClipping.unprojectTo3D(p2d, basis2));

      let alignedL2: Vec3[] = [];
      if (rawL2.length === n) {
        const targets = l1.map((pt) => p2!.face.plane.projectPoint(pt));
        let bestScore = Infinity;
        let bestOffset = 0;
        let bestDir = 1;

        for (const dir of [1, -1]) {
          for (let s = 0; s < n; s++) {
            let score = 0;
            for (let i = 0; i < n; i++) {
              const idx = (s + dir * i + n * 10) % n;
              score += targets[i].distanceToSq(rawL2[idx]);
            }
            if (score < bestScore) {
              bestScore = score;
              bestOffset = s;
              bestDir = dir;
            }
          }
        }

        for (let i = 0; i < n; i++) {
          const idx = (bestOffset + bestDir * i + n * 10) % n;
          alignedL2.push(rawL2[idx]);
        }
      } else {
        alignedL2 = l1.map((pt) => p2!.face.plane.projectPoint(pt));
      }

      for (const pb of backFaces) {
        const pbLoop = alignedL2.map((pt) => pb.face.plane.projectPoint(pt));
        this.applyVoidCutToHostFace(hostMesh, pb.face, pbLoop, openingGroupId, pb.basis);
      }

      const c1 = l1.reduce((acc, p) => acc.add(p), Vec3.ZERO).scale(1 / n);
      const c2 = alignedL2.reduce((acc, p) => acc.add(p), Vec3.ZERO).scale(1 / n);
      const holeCenter = c1.add(c2).scale(0.5);

      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        let quad = [l1[i], l1[next], alignedL2[next], alignedL2[i]];
        const v1 = quad[1].sub(quad[0]);
        const v2 = quad[3].sub(quad[0]);
        let normal = v1.cross(v2).normalize();
        const quadCenter = quad.reduce((acc, p) => acc.add(p), Vec3.ZERO).scale(0.25);
        const toHole = holeCenter.sub(quadCenter);
        if (normal.dot(toHole) < 0) {
          quad.reverse();
          normal = normal.negate();
        }
        const jamba = hostMesh.addFace(quad, normal);
        jamba.openingId = openingGroupId;
      }

      hostMesh.rebuildTopology();
      return true;
    } else if (!requireThrough && piercedHostFaces.length >= 1) {
      const singleP = p1 || piercedHostFaces[0];
      this.applyVoidCutToHostFace(hostMesh, singleP.face, singleP.loop3D, openingGroupId, singleP.basis);

      const cap1 = singleP.cap;
      const oppCap = transformedOpFaces.find(
        (f) => f.normal.dot(cap1.normal) < GeometryTolerance.OPENING_STRICT_OPPOSITE_DOT
      );
      const depth = oppCap
        ? Math.abs(cap1.normal.dot(oppCap.positions[0].sub(cap1.positions[0])))
        : 0.2;

      const rayDir = singleP.face.normal.negate();
      const l1 = singleP.loop3D;
      const n = l1.length;
      const lBottom = l1.map((p) => p.add(rayDir.scale(depth)));

      const bottomFace = hostMesh.addFace([...lBottom].reverse(), rayDir.negate());
      bottomFace.openingId = openingGroupId;

      const holeCenter = l1.reduce((acc, p) => acc.add(p), Vec3.ZERO).scale(1 / n);

      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        let quad = [l1[i], l1[next], lBottom[next], lBottom[i]];
        const v1 = quad[1].sub(quad[0]);
        const v2 = quad[3].sub(quad[0]);
        let normal = v1.cross(v2).normalize();
        const quadCenter = quad.reduce((acc, p) => acc.add(p), Vec3.ZERO).scale(0.25);
        const toHole = holeCenter.sub(quadCenter);
        if (normal.dot(toHole) < 0) {
          quad.reverse();
          normal = normal.negate();
        }
        const jamba = hostMesh.addFace(quad, normal);
        jamba.openingId = openingGroupId;
      }

      hostMesh.rebuildTopology();
      return true;
    }

    // CSG Fallback
    try {
      const subtracted = BooleanCSGKernel.subtract(hostMesh, openingMesh, {
        openingGroupId,
        matrixB: isIdentity ? undefined : matrix,
      });
      const hasCarvedFaces = Array.from(subtracted.faces.values()).some(
        (f) => f.openingId === openingGroupId || (f.holes && f.holes.length > 0 && f.holeOwners?.includes(openingGroupId))
      );
      if (hasCarvedFaces) {
        hostMesh.faces.clear();
        hostMesh.vertices.clear();
        hostMesh.edges.clear();
        for (const f of subtracted.faces.values()) {
          const newF = hostMesh.addFace(f.getPositions(), f.normal);
          newF.materialId = f.materialId;
          newF.openingId = f.openingId;
          if (f.holes && f.holes.length > 0) {
            newF.holes = f.holes.map((h) => [...h]);
            newF.holeOwners = f.holeOwners ? [...f.holeOwners] : [];
          }
        }
        hostMesh.rebuildTopology();
        return true;
      }
    } catch {
      // Ignored
    }

    return false;
  }

  private static isOnPolygonBoundary2D(
    p: Vec2D | { x: number; y: number },
    poly: (Vec2D | { x: number; y: number })[],
    tol = GeometryTolerance.COINCIDENT_VERTEX
  ): boolean {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const l2 = abx * abx + aby * aby;
      if (l2 > GeometryTolerance.COINCIDENT_POINT_SQ) {
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2));
        const projX = a.x + abx * t;
        const projY = a.y + aby * t;
        if (Math.hypot(p.x - projX, p.y - projY) <= tol) {
          return true;
        }
      }
    }
    return false;
  }

  private static applyVoidCutToHostFace(
    hostMesh: PolyMesh,
    targetFace: Face,
    loop3D: Vec3[],
    openingGroupId: string,
    basis: LocalBasis
  ): void {
    const hfPositions = targetFace.getPositions();
    const hf2D = hfPositions.map((p) => PolygonClipping.projectTo2D(p, basis));
    const loop2D = loop3D.map((p) => PolygonClipping.projectTo2D(p, basis));

    const anyLoopVertIn = loop2D.some(
      (p) =>
        PolygonClipping.pointInPolygon2D(p, hf2D) ||
        OpeningVoidSolver.isOnPolygonBoundary2D(p, hf2D, GeometryTolerance.COINCIDENT_VERTEX)
    );
    const anyHfVertIn = hf2D.some(
      (p) =>
        PolygonClipping.pointInPolygon2D(p, loop2D) ||
        OpeningVoidSolver.isOnPolygonBoundary2D(p, loop2D, GeometryTolerance.COINCIDENT_VERTEX)
    );
    const loopCenter = loop2D.reduce((a, b) => ({ x: a.x + b.x, y: a.y + b.y }));
    loopCenter.x /= loop2D.length;
    loopCenter.y /= loop2D.length;
    const centerIn = PolygonClipping.pointInPolygon2D(loopCenter, hf2D);

    if (!anyLoopVertIn && !anyHfVertIn && !centerIn) {
      return;
    }

    const isStrictlyInside = loop2D.every((p) => {
      return (
        PolygonClipping.pointInPolygon2D(p, hf2D) &&
        !OpeningVoidSolver.isOnPolygonBoundary2D(p, hf2D, GeometryTolerance.COINCIDENT_VERTEX)
      );
    });

    if (isStrictlyInside) {
      targetFace.addHole(loop3D, openingGroupId);
      return;
    }

    const isFaceFullyInside = hf2D.every((p) => {
      return (
        PolygonClipping.pointInPolygon2D(p, loop2D) ||
        OpeningVoidSolver.isOnPolygonBoundary2D(p, loop2D, GeometryTolerance.COINCIDENT_VERTEX)
      );
    });

    if (isFaceFullyInside) {
      hostMesh.removeFace(targetFace.id);
      return;
    }

    const pieces2D = PolygonClipping.partitionPolygonWithCutout(hf2D, loop2D);
    const areaOrig = Math.abs(PolygonClipping.signedArea2D(hf2D));
    const totalPieceArea = pieces2D
      ? pieces2D.reduce((sum, p) => sum + Math.abs(PolygonClipping.signedArea2D(p)), 0)
      : 0;

    if (pieces2D && pieces2D.length === 0 && areaOrig > GeometryTolerance.COINCIDENT_AREA_MIN) {
      hostMesh.removeFace(targetFace.id);
      return;
    }

    const isCutoutValid =
      pieces2D &&
      (pieces2D.length >= 2 ||
        (pieces2D.length === 1 && areaOrig - totalPieceArea > GeometryTolerance.COINCIDENT_AREA_MIN));

    if (isCutoutValid) {
      const oldMatId = targetFace.materialId;
      const oldNormal = targetFace.normal;
      const preservedHoles = targetFace.holes ? [...targetFace.holes] : [];
      const preservedOwners = targetFace.holeOwners ? [...targetFace.holeOwners] : [];

      hostMesh.removeFace(targetFace.id);

      for (const piece of pieces2D) {
        const piece3D = piece.map((p2d) => PolygonClipping.unprojectTo3D(p2d, basis));
        const pieceHoles: Vec3[][] = [];
        const pieceOwners: (string | null)[] = [];
        for (let hIdx = 0; hIdx < preservedHoles.length; hIdx++) {
          const h = preservedHoles[hIdx];
          const hCenter = h.reduce((a, b) => a.add(b), Vec3.ZERO).scale(1 / h.length);
          const hCenter2D = PolygonClipping.projectTo2D(hCenter, basis);
          if (PolygonClipping.pointInPolygon2D(hCenter2D, piece)) {
            pieceHoles.push(h);
            pieceOwners.push(preservedOwners[hIdx] ?? null);
          }
        }
        const newFace = hostMesh.addFace(
          piece3D,
          oldNormal,
          pieceHoles.length > 0 ? pieceHoles : undefined,
          pieceOwners.length > 0 ? pieceOwners : undefined
        );
        if (oldMatId) newFace.materialId = oldMatId;
      }
    } else if (totalPieceArea < GeometryTolerance.COINCIDENT_AREA_MIN) {
      hostMesh.removeFace(targetFace.id);
    }
  }
}
