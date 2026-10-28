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
      centroid: Vec3;
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
      let cx = 0, cy = 0, cz = 0;
      const nPos = pos.length;
      for (let i = 0; i < nPos; i++) {
        cx += pos[i].x; cy += pos[i].y; cz += pos[i].z;
      }
      const invN = 1 / Math.max(1, nPos);
      const centroid = new Vec3(cx * invN, cy * invN, cz * invN);
      transformedOpFaces.push({ positions: pos, normal: norm, planeOrigin, centroid });
    }

    for (const hostFace of hostMesh.faces.values()) {
      if (hostFace.openingId && hostFace.openingId === openingGroupId) continue;
      const hostNormal = hostFace.normal;
      const hostCentroid = hostFace.centroid;

      for (const opFace of transformedOpFaces) {
        if (hostNormal.dot(opFace.normal) < -0.99) {
          if (hostCentroid.distanceTo(opFace.centroid) < 1e-3) {
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
    requireThrough: boolean = false,
    deferRebuildTopology: boolean = false
  ): boolean {
    interface OpFaceData {
      positions: Vec3[];
      normal: Vec3;
      centroid: Vec3;
    }

    const transformedOpFaces: OpFaceData[] = [];
    let minBx = Infinity, maxBx = -Infinity, minBy = Infinity, maxBy = -Infinity, minBz = Infinity, maxBz = -Infinity;

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
      let cx = 0, cy = 0, cz = 0;
      const nPos = pos.length;
      for (let i = 0; i < nPos; i++) {
        const p = pos[i];
        cx += p.x; cy += p.y; cz += p.z;
        if (p.x < minBx) minBx = p.x; if (p.x > maxBx) maxBx = p.x;
        if (p.y < minBy) minBy = p.y; if (p.y > maxBy) maxBy = p.y;
        if (p.z < minBz) minBz = p.z; if (p.z > maxBz) maxBz = p.z;
      }
      const invN = 1 / Math.max(1, nPos);
      transformedOpFaces.push({
        positions: pos,
        normal: norm,
        centroid: new Vec3(cx * invN, cy * invN, cz * invN),
      });
    }

    if (transformedOpFaces.length === 0) return false;

    // Strict 3D Bounding Box (AABB) intersection check first:
    // A void volume can only cut the host solid if they overlap in 3D space with non-zero volume.
    let minAx = Infinity, maxAx = -Infinity, minAy = Infinity, maxAy = -Infinity, minAz = Infinity, maxAz = -Infinity;
    for (const v of hostMesh.vertices.values()) {
      const p = v.position;
      if (p.x < minAx) minAx = p.x; if (p.x > maxAx) maxAx = p.x;
      if (p.y < minAy) minAy = p.y; if (p.y > maxAy) maxAy = p.y;
      if (p.z < minAz) minAz = p.z; if (p.z > maxAz) maxAz = p.z;
    }

    const minTol = GeometryTolerance.COINCIDENT_VERTEX;
    const overlapX = Math.min(maxAx, maxBx) - Math.max(minAx, minBx);
    const overlapY = Math.min(maxAy, maxBy) - Math.max(minAy, minBy);
    const overlapZ = Math.min(maxAz, maxBz) - Math.max(minAz, minBz);

    if (overlapY <= minTol) {
      return false;
    }
    if (overlapX < -minTol && overlapZ < -minTol) {
      return false;
    }

    // Early exit if the opening void is already fully carved into the host solid topology
    let alreadyTagged = 0;
    for (const hostFace of hostMesh.faces.values()) {
      if (hostFace.openingId && hostFace.openingId === openingGroupId) continue;
      const hostNormal = hostFace.normal;
      const hostCentroid = hostFace.centroid;

      for (const opFace of transformedOpFaces) {
        if (hostNormal.dot(opFace.normal) < -0.99) {
          if (hostCentroid.distanceTo(opFace.centroid) < 1e-3) {
            hostFace.openingId = openingGroupId;
            alreadyTagged++;
            break;
          }
        }
      }
    }
    if (alreadyTagged >= 2) {
      return true;
    }

    // Boundary roof trim & top cut detection on walls:
    // If the host solid is a vertical element (e.g. wall where largest faces are vertical),
    // and the opening reaches or exceeds the highest elevation of the host solid,
    // a 2D interior face-loop cannot remove the top cap of the wall.
    // Dispatch immediately to exact 3D B-Rep BooleanCSGKernel.subtract.
    // For horizontal elements (slabs, foundations), vertical penetration along Y is normal through-hole.
    let maxFaceArea = 0;
    let isVerticalHostSolid = true;
    for (const f of hostMesh.faces.values()) {
      if (f.openingId) continue;
      const basis = PolygonClipping.getLocalBasis(f.plane.origin, f.normal);
      const pts2D = f.getPositions().map((p: Vec3) => PolygonClipping.projectTo2D(p, basis));
      const area = Math.abs(PolygonClipping.signedArea2D(pts2D));
      if (area > maxFaceArea) {
        maxFaceArea = area;
        isVerticalHostSolid = Math.abs(f.normal.y) < 0.5;
      }
    }

    const hostMaxY = maxAy;
    const opMaxY = maxBy;

    const isTopBoundaryCut = isVerticalHostSolid && (opMaxY >= hostMaxY - GeometryTolerance.COINCIDENT_VERTEX * 10);

    if (isTopBoundaryCut) {
      try {
        const subtracted = BooleanCSGKernel.subtract(hostMesh, openingMesh, {
          openingGroupId,
          matrixB: isIdentity ? undefined : matrix,
        });
        const hasCarvedFaces = Array.from(subtracted.faces.values()).some(
          (f) => f.openingId === openingGroupId || (f.holes && f.holes.length > 0 && f.holeOwners?.includes(openingGroupId))
        );
        if (hasCarvedFaces || (subtracted.faces.size > 0 && subtracted.faces.size !== hostMesh.faces.size)) {
          this.applySubtractedMeshToHost(hostMesh, subtracted);
          return true;
        }
      } catch {
        // Fall back to piercing if CSG encounters an unhandled topological condition
      }
    }

    const allOpPoints: Vec3[] = [];
    for (const of of transformedOpFaces) {
      let hMaxProj = -Infinity;
      for (const v of hostMesh.vertices.values()) {
        const proj = v.position.dot(of.normal);
        if (proj > hMaxProj) hMaxProj = proj;
      }
      for (const pos of of.positions) {
        allOpPoints.push(pos);
        // Extend along face normal through host thickness to account for coplanar / multi-layer wall bounds
        const forwardDist = Math.max(
          GeometryTolerance.OPENING_PIERCING_EXTENSION_MARGIN,
          (hMaxProj - pos.dot(of.normal)) + GeometryTolerance.OPENING_PIERCING_EXTENSION_MARGIN
        );
        allOpPoints.push(pos.add(of.normal.scale(forwardDist)));
      }
    }

    interface PiercedFace {
      face: Face;
      loop3D: Vec3[];
      cap: OpFaceData;
      basis: LocalBasis;
      allVertsIn: boolean;
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

        const insideOuter = of2D.every((p) =>
          PolygonClipping.isPointInOrOnPolygon2D(p, hf2D, GeometryTolerance.COINCIDENT_VERTEX * 10)
        );
        const overlapsExistingHole =
          hf.hasHoles() &&
          hf.holes.some((h) => {
            const h2D = h.map((hp) => PolygonClipping.projectTo2D(hp, basis));
            return of2D.some((p) => PolygonClipping.pointInPolygon2D(p, h2D));
          });
        const allVertsIn = insideOuter && !overlapsExistingHole;

        const centroidIn = PolygonClipping.isPointInOrOnPolygon2D(ofCenter2D, hf2D);
        const anyVertIn = of2D.some((p) => PolygonClipping.pointInPolygon2D(p, hf2D));
        const anyHfVertIn = !centroidIn && !anyVertIn && hf2D.some((p) => PolygonClipping.pointInPolygon2D(p, of2D));

        const isValidPiercing = requireThrough ? allVertsIn : (centroidIn || anyVertIn || anyHfVertIn);

        if (isValidPiercing) {
          if (!piercedHostFaces.some((p) => p.face.id === hf.id)) {
            const projectedLoop3D = of2D.map((p2d) => PolygonClipping.unprojectTo3D(p2d, basis));
            piercedHostFaces.push({ face: hf, cap: of, basis, loop3D: projectedLoop3D, allVertsIn });
            break;
          }
        }
      }
    }

    let p1: PiercedFace | null = null;
    let p2: PiercedFace | null = null;

    if (piercedHostFaces.length >= 2) {
      let bestDist = Infinity;
      let bestIsContained = false;
      let bestIsVertical = false;

      for (let i = 0; i < piercedHostFaces.length; i++) {
        for (let j = i + 1; j < piercedHostFaces.length; j++) {
          const fA = piercedHostFaces[i];
          const fB = piercedHostFaces[j];
          if (fA.face.normal.dot(fB.face.normal) < GeometryTolerance.OPENING_OPPOSITE_NORMAL_DOT) {
            const isContained = fA.allVertsIn && fB.allVertsIn;
            const isVertical =
              Math.abs(fA.face.normal.y) < GeometryTolerance.OPENING_VERTICAL_NORMAL_DOT &&
              Math.abs(fB.face.normal.y) < GeometryTolerance.OPENING_VERTICAL_NORMAL_DOT;
            const dist = Math.abs(fA.face.plane.distanceToPoint(fB.face.plane.origin));

            let isBetter = false;
            if (dist < bestDist - GeometryTolerance.COINCIDENT_VERTEX) {
              isBetter = true;
            } else if (Math.abs(dist - bestDist) <= GeometryTolerance.COINCIDENT_VERTEX) {
              if (isContained && !bestIsContained) {
                isBetter = true;
              } else if (isContained === bestIsContained) {
                if (isVertical && !bestIsVertical) {
                  isBetter = true;
                }
              }
            }

            if (isBetter) {
              bestIsContained = isContained;
              bestIsVertical = isVertical;
              bestDist = dist;
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

      const isFullyContainedThroughHole = p1.allVertsIn && p2.allVertsIn;

      if (isFullyContainedThroughHole) {
        const validFrontFaces = frontFaces.filter((pf) => pf.allVertsIn);
        for (const pf of validFrontFaces) {
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

        const validBackFaces = backFaces.filter((pb) => pb.allVertsIn);
        for (const pb of validBackFaces) {
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

        if (!deferRebuildTopology) {
          hostMesh.rebuildTopology();
        }
        return true;
      }
    } else if (!requireThrough && piercedHostFaces.length >= 1) {
      const singleP = p1 || piercedHostFaces[0];
      if (singleP.allVertsIn) {
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

        if (!deferRebuildTopology) {
          hostMesh.rebuildTopology();
        }
        return true;
      }
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
      if (hasCarvedFaces || (subtracted.faces.size > 0 && subtracted.faces.size !== hostMesh.faces.size)) {
        this.applySubtractedMeshToHost(hostMesh, subtracted);
        return true;
      }
    } catch {
      // Ignored
    }

    return false;
  }

  private static applySubtractedMeshToHost(hostMesh: PolyMesh, subtracted: PolyMesh): void {
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

      interface FinalPiece {
        poly: Vec2D[];
        holes: Vec3[][];
        owners: (string | null)[];
      }

      let finalPieces: FinalPiece[] = pieces2D.map((p) => ({ poly: p, holes: [], owners: [] }));

      for (let hIdx = 0; hIdx < preservedHoles.length; hIdx++) {
        const h3D = preservedHoles[hIdx];
        const hOwner = preservedOwners[hIdx] ?? null;
        const h2D = h3D.map((p) => PolygonClipping.projectTo2D(p, basis));
        const hCenter = h3D.reduce((a, b) => a.add(b), Vec3.ZERO).scale(1 / h3D.length);
        const hCenter2D = PolygonClipping.projectTo2D(hCenter, basis);

        const nextFinalPieces: FinalPiece[] = [];

        for (const fp of finalPieces) {
          const piece = fp.poly;
          const anyVertIn = h2D.some(
            (p) =>
              PolygonClipping.pointInPolygon2D(p, piece) ||
              OpeningVoidSolver.isOnPolygonBoundary2D(p, piece, GeometryTolerance.COINCIDENT_VERTEX)
          );
          const centerIn = PolygonClipping.pointInPolygon2D(hCenter2D, piece);

          if (!anyVertIn && !centerIn) {
            nextFinalPieces.push(fp);
            continue;
          }

          const isStrict = h2D.every(
            (p) =>
              PolygonClipping.pointInPolygon2D(p, piece) &&
              !OpeningVoidSolver.isOnPolygonBoundary2D(p, piece, GeometryTolerance.COINCIDENT_VERTEX)
          );

          if (isStrict) {
            fp.holes.push(h3D);
            fp.owners.push(hOwner);
            nextFinalPieces.push(fp);
          } else {
            const subCutouts = PolygonClipping.partitionPolygonWithCutout(piece, h2D);
            if (subCutouts && subCutouts.length > 0) {
              for (const sub of subCutouts) {
                nextFinalPieces.push({
                  poly: sub,
                  holes: [...fp.holes],
                  owners: [...fp.owners],
                });
              }
            } else {
              nextFinalPieces.push(fp);
            }
          }
        }

        finalPieces = nextFinalPieces;
      }

      for (const fp of finalPieces) {
        const piece3D = fp.poly.map((p2d) => PolygonClipping.unprojectTo3D(p2d, basis));
        const newFace = hostMesh.addFace(
          piece3D,
          oldNormal,
          fp.holes.length > 0 ? fp.holes : undefined,
          fp.owners.length > 0 ? fp.owners : undefined
        );
        if (oldMatId) newFace.materialId = oldMatId;
      }
    } else if (totalPieceArea < GeometryTolerance.COINCIDENT_AREA_MIN) {
      hostMesh.removeFace(targetFace.id);
    }
  }
}
