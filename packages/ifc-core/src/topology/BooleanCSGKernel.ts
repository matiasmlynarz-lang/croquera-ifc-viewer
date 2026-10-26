/**
 * BooleanCSGKernel — Exact Boundary Representation Constructive Solid Geometry (B-Rep CSG) Engine.
 *
 * Formally evaluates regularized difference, union, and intersection of
 * 2-manifold polyhedral solids (PolyMesh) in R^3:
 *   - Subtraction:   R = A \* B = clos(int(A) \ int(B))
 *   - Union:         R = A U* B = clos(int(A) U int(B))
 *   - Intersection:  R = A (* B = clos(int(A) ( int(B))
 *
 * Core Principles:
 * - Requicha-Voelcker boundary rules with On-Boundary support (COPLANAR_SAME, COPLANAR_OPPOSITE).
 * - Conformal face-to-face partitioning via PlanarGraph in local 2D orthonormal basis (u, v).
 * - Topological classification via dominant triangle interior point and robust 3D ray casting.
 * - Coplanar face post-coalescing to preserve N-gons and boundary loops.
 * - Deterministic openingId tagging on jamba faces originating from cutter geometries.
 */

import * as THREE from 'three';
import { Vec3 } from '../math/Vec3';
import { Plane } from '../math/Plane';
import { GeometryTolerance } from '../math/GeometryTolerance';
import { PolyMesh } from './PolyMesh';
import { Face } from './HalfEdge';
import { PlanarGraph } from './PlanarGraph';
import { PolygonClipping } from './PolygonClipping';

export type BooleanOperation = 'SUBTRACT' | 'UNION' | 'INTERSECT';

export interface CSGOptions {
  openingGroupId?: string;
  matrixB?: THREE.Matrix4;
  skipInstancePropagation?: boolean;
  tolerance?: number;
}

interface Triangle3D {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  normal: Vec3;
  box: THREE.Box3;
}

interface SubFaceData {
  positions: Vec3[];
  normal: Vec3;
  materialId?: string | null;
  openingId?: string | null;
  holes?: Vec3[][];
  holeOwners?: (string | null)[];
  originalFaceId?: string;
}

export class BooleanCSGKernel {
  /**
   * Evaluates regularized subtraction A \* B.
   */
  public static subtract(
    solidA: PolyMesh,
    solidB: PolyMesh,
    options: CSGOptions = {}
  ): PolyMesh {
    return this.executeOperation(solidA, solidB, 'SUBTRACT', options);
  }

  /**
   * Evaluates regularized union A U* B.
   */
  public static union(
    solidA: PolyMesh,
    solidB: PolyMesh,
    options: CSGOptions = {}
  ): PolyMesh {
    return this.executeOperation(solidA, solidB, 'UNION', options);
  }

  /**
   * Evaluates regularized intersection A (* B.
   */
  public static intersect(
    solidA: PolyMesh,
    solidB: PolyMesh,
    options: CSGOptions = {}
  ): PolyMesh {
    return this.executeOperation(solidA, solidB, 'INTERSECT', options);
  }

  /**
   * Unified execution core for CSG boolean operations.
   */
  private static executeOperation(
    solidA: PolyMesh,
    solidB: PolyMesh,
    operation: BooleanOperation,
    options: CSGOptions = {}
  ): PolyMesh {
    const tol = options.tolerance ?? GeometryTolerance.COINCIDENT_VERTEX;

    // 0. Prepare solid B (apply matrixB if provided and normalize volume orientation)
    let bMesh = solidB;
    if (options.matrixB) {
      bMesh = solidB.clone(`${solidB.id}_transformed`);
      bMesh.applyMatrix4(options.matrixB);
    }

    // Normalize solid B: if signed volume is negative, reverse its faces
    const volB = bMesh.computeSignedVolume();
    if (volB < -GeometryTolerance.COINCIDENT_POINT) {
      const invertedB = new PolyMesh(`${bMesh.id}_norm`);
      for (const f of bMesh.faces.values()) {
        const rev = [...f.getPositions()].reverse();
        invertedB.addFace(rev, f.normal.negate());
      }
      invertedB.rebuildTopology();
      bMesh = invertedB;
    }

    // 1. Broad-Phase: AABB bounding box collision test
    const boxA = this.computeMeshAABB(solidA);
    const boxB = this.computeMeshAABB(bMesh);

    const expandedBoxA = boxA.clone().expandByScalar(tol);
    if (!expandedBoxA.intersectsBox(boxB)) {
      // Disjoint cases without spatial intersection:
      if (operation === 'SUBTRACT') {
        return solidA.clone(`${solidA.id}_sub`);
      } else if (operation === 'INTERSECT') {
        return new PolyMesh(`${solidA.id}_empty`);
      } else {
        // Disjoint UNION: directly combine faces of A and B
        const unionMesh = solidA.clone(`${solidA.id}_union`);
        for (const f of bMesh.faces.values()) {
          unionMesh.addFace(f.getPositions(), f.normal);
        }
        unionMesh.rebuildTopology();
        return unionMesh;
      }
    }

    // 2. Extract faces and construct per-face AABBs
    interface FaceEntry {
      face: Face;
      positions: Vec3[];
      normal: Vec3;
      plane: Plane;
      box: THREE.Box3;
      cutSegments: [Vec3, Vec3][];
    }

    const facesA: FaceEntry[] = [];
    for (const f of solidA.faces.values()) {
      const pos = f.getPositions();
      if (pos.length < 3) continue;
      facesA.push({
        face: f,
        positions: pos,
        normal: f.normal,
        plane: f.plane,
        box: this.computePointsAABB(pos),
        cutSegments: [],
      });
    }

    const facesB: FaceEntry[] = [];
    for (const f of bMesh.faces.values()) {
      const pos = f.getPositions();
      if (pos.length < 3) continue;
      facesB.push({
        face: f,
        positions: pos,
        normal: f.normal,
        plane: f.plane,
        box: this.computePointsAABB(pos),
        cutSegments: [],
      });
    }

    // 3. Narrow-Phase: Spatial pruning via overlapBox
    const overlapBox = boxA.clone().intersect(boxB).expandByScalar(tol);
    const candidateFacesB = facesB.filter((fb) => fb.box.intersectsBox(overlapBox));

    for (let i = 0; i < facesA.length; i++) {
      const fa = facesA[i];
      if (!fa.box.intersectsBox(overlapBox)) continue;
      const boxAExp = fa.box.clone().expandByScalar(tol);

      for (let j = 0; j < candidateFacesB.length; j++) {
        const fb = candidateFacesB[j];
        if (!boxAExp.intersectsBox(fb.box)) continue;

        const cutSeg = this.intersectPolygonPolygon(fa, fb, tol);
        if (cutSeg) {
          fa.cutSegments.push(cutSeg);
          fb.cutSegments.push(cutSeg);
        }
      }
    }

    // 4. Conformal face subdivision with cut segments
    const subFacesA: SubFaceData[] = [];
    for (const fa of facesA) {
      if (fa.cutSegments.length === 0) {
        subFacesA.push({
          positions: fa.positions,
          normal: fa.normal,
          materialId: fa.face.materialId,
          openingId: fa.face.openingId,
          holes: fa.face.holes ? fa.face.holes.map((h) => [...h]) : undefined,
          holeOwners: fa.face.holeOwners ? [...fa.face.holeOwners] : undefined,
          originalFaceId: fa.face.id,
        });
      } else {
        const splitPieces = this.splitFaceWithCutSegments(fa.face, fa.cutSegments);
        for (const p of splitPieces) {
          subFacesA.push(p);
        }
      }
    }

    const subFacesB: SubFaceData[] = [];
    for (const fb of facesB) {
      if (fb.cutSegments.length === 0) {
        subFacesB.push({
          positions: fb.positions,
          normal: fb.normal,
          materialId: fb.face.materialId,
          openingId: fb.face.openingId,
          holes: fb.face.holes ? fb.face.holes.map((h) => [...h]) : undefined,
          holeOwners: fb.face.holeOwners ? [...fb.face.holeOwners] : undefined,
          originalFaceId: fb.face.id,
        });
      } else {
        const splitPieces = this.splitFaceWithCutSegments(fb.face, fb.cutSegments);
        for (const p of splitPieces) {
          subFacesB.push(p);
        }
      }
    }

    // 5. Solid triangulation for robust interior-point classification
    const trisA = this.triangulateMesh(solidA);
    const trisB = this.triangulateMesh(bMesh);

    // 6. Sub-face classification and selection per operation
    const resultMesh = new PolyMesh(solidA.id);

    // Classify sub-faces of A with respect to B
    for (const sfa of subFacesA) {
      const classification = this.classifySubFace(sfa, trisB, facesB, tol);

      let keep = false;
      if (operation === 'SUBTRACT') {
        // En A \* B: conservar OUTSIDE y COPLANAR_OPPOSITE. Descartar INSIDE y COPLANAR_SAME
        keep = classification === 'OUTSIDE' || classification === 'COPLANAR_OPP';
      } else if (operation === 'UNION') {
        keep = classification === 'OUTSIDE' || classification === 'COPLANAR_SAME';
      } else if (operation === 'INTERSECT') {
        keep = classification === 'INSIDE' || classification === 'COPLANAR_SAME';
      }

      if (keep) {
        const newFace = resultMesh.addFace(sfa.positions, sfa.normal);
        newFace.materialId = sfa.materialId;
        newFace.openingId = sfa.openingId;
        if (sfa.holes && sfa.holes.length > 0) {
          for (let hIdx = 0; hIdx < sfa.holes.length; hIdx++) {
            let hOwner = sfa.holeOwners && hIdx < sfa.holeOwners.length ? sfa.holeOwners[hIdx] : null;
            if (!hOwner && operation === 'SUBTRACT' && options.openingGroupId) {
              hOwner = options.openingGroupId;
            }
            newFace.addHole(sfa.holes[hIdx], hOwner);
          }
        }
      }
    }

    // Clasificar subcaras de B con respecto a A
    for (const sfb of subFacesB) {
      const classification = this.classifySubFace(sfb, trisA, facesA, tol);

      let keep = false;
      let invertNormal = false;

      if (operation === 'SUBTRACT') {
        // In A \ B: retain B subfaces INSIDE (with inverted normal to form void boundaries).
        // Discard OUTSIDE, COPLANAR_SAME and COPLANAR_OPP from B (entry/exit caps of B contribute no material).
        if (classification === 'INSIDE') {
          keep = true;
          invertNormal = true;
        }
      } else if (operation === 'UNION') {
        keep = classification === 'OUTSIDE';
      } else if (operation === 'INTERSECT') {
        keep = classification === 'INSIDE';
      }

      if (keep) {
        let finalPositions = sfb.positions;
        let finalNormal = sfb.normal;
        if (invertNormal) {
          finalPositions = [...sfb.positions].reverse();
          finalNormal = sfb.normal.negate();
        }

        const newFace = resultMesh.addFace(finalPositions, finalNormal);
        newFace.materialId = sfb.materialId;

        // If openingGroupId is specified, tag jamba faces accordingly
        if (options.openingGroupId) {
          newFace.openingId = options.openingGroupId;
        } else {
          newFace.openingId = sfb.openingId;
        }

        if (sfb.holes && sfb.holes.length > 0) {
          for (let hIdx = 0; hIdx < sfb.holes.length; hIdx++) {
            const hOwner = sfb.holeOwners && hIdx < sfb.holeOwners.length ? sfb.holeOwners[hIdx] : null;
            newFace.addHole(sfb.holes[hIdx], hOwner);
          }
        }
      }
    }

    // 7. Consolidate adjacent coplanar faces (N-gon preservation)
    try {
      resultMesh.coalesceCoplanarFaces();
    } catch {
      // If consolidation fails due to isolated non-manifold configurations, keep sub-faces intact
    }

    // 8. Deterministic topological reconstruction
    resultMesh.rebuildTopology();

    return resultMesh;
  }

  /**
   * Exact 3D transversal intersection between two planar polygons.
   * Returns mutual intersection segment [P1, P2] if intersecting, or null if disjoint/coplanar.
   */
  private static intersectPolygonPolygon(
    fa: { positions: Vec3[]; normal: Vec3; plane: Plane },
    fb: { positions: Vec3[]; normal: Vec3; plane: Plane },
    tol: number
  ): [Vec3, Vec3] | null {
    const dotNorm = fa.normal.dot(fb.normal);

    // If planes are quasi-parallel (|dot| > 1 - 1e-3), no transversal cutting intersection occurs
    if (Math.abs(dotNorm) > 1 - 1e-3) {
      return null;
    }

    // Direction vector of the line of intersection of both planes
    const lineDir = fa.normal.cross(fb.normal).normalize();
    if (lineDir.lengthSq() < 1e-6) return null;

    // Compute cutting segment of polygon fa against the plane of fb
    const segA = this.getPolygonPlaneIntersectionSegment(fa.positions, fb.plane, lineDir, tol);
    if (!segA) return null;

    // Compute cutting segment of polygon fb against the plane of fa
    const segB = this.getPolygonPlaneIntersectionSegment(fb.positions, fa.plane, lineDir, tol);
    if (!segB) return null;

    // Parameterize both segments along lineDir using a single shared origin (segA.p1)
    const origin = segA.p1;
    const tA1 = 0;
    const tA2 = segA.p2.sub(origin).dot(lineDir);
    const minA = Math.min(tA1, tA2);
    const maxA = Math.max(tA1, tA2);

    const tB1 = segB.p1.sub(origin).dot(lineDir);
    const tB2 = segB.p2.sub(origin).dot(lineDir);
    const minB = Math.min(tB1, tB2);
    const maxB = Math.max(tB1, tB2);

    // 1D interval overlap intersection
    const tStart = Math.max(minA, minB);
    const tEnd = Math.min(maxA, maxB);

    if (tEnd - tStart <= tol) {
      return null;
    }

    const pStart = origin.add(lineDir.scale(tStart));
    const pEnd = origin.add(lineDir.scale(tEnd));

    return [pStart, pEnd];
  }

  /**
   * Computes the 3D line segment [p1, p2] where a planar polygon intersects an infinite plane.
   */
  private static getPolygonPlaneIntersectionSegment(
    poly: Vec3[],
    plane: Plane,
    lineDir: Vec3,
    tol: number
  ): { p1: Vec3; p2: Vec3 } | null {
    const n = poly.length;
    const dists: number[] = new Array(n);
    let hasStrictPos = false;
    let hasStrictNeg = false;
    let onPlaneCount = 0;

    for (let i = 0; i < n; i++) {
      const d = plane.distanceToPoint(poly[i]);
      dists[i] = d;
      if (d > tol) hasStrictPos = true;
      else if (d < -tol) hasStrictNeg = true;
      else onPlaneCount++;
    }

    // If entire polygon is coplanar or falls strictly on one half-space without plane edges, no transversal intersection
    if (!hasStrictPos && !hasStrictNeg) return null; // Entirely coplanar
    if (!hasStrictPos && onPlaneCount < 2) return null; // Entirely negative without edge on plane
    if (!hasStrictNeg && onPlaneCount < 2) return null; // Entirely positive without edge on plane

    const cutPoints: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const di = dists[i];
      const dj = dists[j];
      const pi = poly[i];
      const pj = poly[j];

      if (Math.abs(di) <= tol) {
        cutPoints.push(pi);
      }

      if ((di > tol && dj < -tol) || (di < -tol && dj > tol)) {
        const t = di / (di - dj);
        const pt = pi.add(pj.sub(pi).scale(t));
        cutPoints.push(pt);
      }
    }

    if (cutPoints.length < 2) return null;

    // Find two extreme points along lineDir
    let minT = Infinity;
    let maxT = -Infinity;
    let pMin = cutPoints[0];
    let pMax = cutPoints[0];

    const ref = cutPoints[0];
    for (const pt of cutPoints) {
      const t = pt.sub(ref).dot(lineDir);
      if (t < minT) {
        minT = t;
        pMin = pt;
      }
      if (t > maxT) {
        maxT = t;
        pMax = pt;
      }
    }

    if (maxT - minT <= tol) return null;

    return { p1: pMin, p2: pMax };
  }

  /**
   * Subdivides a polygonal face with a list of cutting segments using PlanarGraph.
   */
  private static splitFaceWithCutSegments(
    face: Face,
    cutSegments: [Vec3, Vec3][]
  ): SubFaceData[] {
    const outerVerts = face.getPositions();
    if (outerVerts.length < 3) return [];

    const basis = PolygonClipping.getLocalBasis(face.plane.origin, face.normal);
    const pg = new PlanarGraph(face.plane.origin, face.normal);

    // 1. Insert outer loop into graph
    const outer2D = outerVerts.map((p) => PolygonClipping.projectTo2D(p, basis));
    for (let i = 0; i < outer2D.length; i++) {
      const next = (i + 1) % outer2D.length;
      pg.addSegment2D(outer2D[i], outer2D[next]);
    }

    // 2. Insert existing holes if any
    if (face.holes && face.holes.length > 0) {
      for (const hole of face.holes) {
        const hole2D = hole.map((p) => PolygonClipping.projectTo2D(p, basis));
        for (let i = 0; i < hole2D.length; i++) {
          const next = (i + 1) % hole2D.length;
          pg.addSegment2D(hole2D[i], hole2D[next]);
        }
      }
    }

    // 3. Insert cutting segments projected to 2D
    for (const [p1, p2] of cutSegments) {
      const s1 = PolygonClipping.projectTo2D(p1, basis);
      const s2 = PolygonClipping.projectTo2D(p2, basis);
      pg.addSegment2D(s1, s2);
    }

    // 4. Extract 2D sub-faces
    const extractedFaces = pg.extractFaces2D();
    if (extractedFaces.length === 0) {
      // Safe fallback: preserve original face
      return [
        {
          positions: outerVerts,
          normal: face.normal,
          materialId: face.materialId,
          openingId: face.openingId,
          holes: face.holes ? face.holes.map((h) => [...h]) : undefined,
          holeOwners: face.holeOwners ? [...face.holeOwners] : undefined,
          originalFaceId: face.id,
        },
      ];
    }

    const resultPieces: SubFaceData[] = [];
    const preHoles2D =
      face.holes && face.holes.length > 0
        ? face.holes.map((h) => h.map((p) => PolygonClipping.projectTo2D(p, basis)))
        : null;

    for (const pf of extractedFaces) {
      if (pf.outerLoop.length < 3) continue;

      // Desproyectar contorno exterior a 3D
      const poly3D = pf.outerLoop.map((p2d) => PolygonClipping.unprojectTo3D(p2d, basis));

      // Desproyectar agujeros a 3D si los tiene
      const holes3D = pf.holes ? pf.holes.map((h) => h.map((p2d) => PolygonClipping.unprojectTo3D(p2d, basis))) : undefined;

      // Filter out sub-faces whose interior falls inside a pre-existing hole of the face
      if (preHoles2D) {
        const testPt = this.getDominantInteriorPoint(poly3D, face.normal, holes3D);
        const testPt2D = PolygonClipping.projectTo2D(testPt, basis);
        let insidePreHole = false;
        for (const h2D of preHoles2D) {
          if (PolygonClipping.pointInPolygon2D(testPt2D, h2D)) {
            insidePreHole = true;
            break;
          }
        }
        if (insidePreHole) continue;
      }

      resultPieces.push({
        positions: poly3D,
        normal: face.normal,
        materialId: face.materialId,
        openingId: face.openingId,
        holes: holes3D,
        holeOwners: face.holeOwners,
        originalFaceId: face.id,
      });
    }

    return resultPieces.length > 0
      ? resultPieces
      : [
          {
            positions: outerVerts,
            normal: face.normal,
            materialId: face.materialId,
            openingId: face.openingId,
            holes: face.holes ? face.holes.map((h) => [...h]) : undefined,
            holeOwners: face.holeOwners ? [...face.holeOwners] : undefined,
            originalFaceId: face.id,
          },
        ];
  }

  /**
   * Classifies a sub-face as INSIDE, OUTSIDE, COPLANAR_SAME, or COPLANAR_OPP relative to another solid.
   */
  private static classifySubFace(
    subFace: SubFaceData,
    otherTriangles: Triangle3D[],
    otherFaces: { positions: Vec3[]; normal: Vec3; plane: Plane; box: THREE.Box3 }[],
    tol: number
  ): 'INSIDE' | 'OUTSIDE' | 'COPLANAR_SAME' | 'COPLANAR_OPP' {
    // 0. Extract guaranteed dominant interior point inside sub-face boundary and outside any holes
    const testPoint = this.getDominantInteriorPoint(subFace.positions, subFace.normal, subFace.holes);

    // 1. Evaluate whether testPoint lies on any coplanar face in otherFaces
    for (const of of otherFaces) {
      const dot = subFace.normal.dot(of.normal);
      if (Math.abs(Math.abs(dot) - 1.0) <= 1e-3) {
        // Parallel or antiparallel face normals
        const dist = Math.abs(of.plane.distanceToPoint(testPoint));
        if (dist <= tol) {
          // Check 2D projected overlap
          const basis = PolygonClipping.getLocalBasis(of.plane.origin, of.normal);
          const of2D = of.positions.map((p) => PolygonClipping.projectTo2D(p, basis));
          const testPoint2D = PolygonClipping.projectTo2D(testPoint, basis);

          if (PolygonClipping.isPointInOrOnPolygon2D(testPoint2D, of2D, tol * 5)) {
            return dot > 0 ? 'COPLANAR_SAME' : 'COPLANAR_OPP';
          }
        }
      }
    }

    // 2. General topological classification via 3D ray casting
    const isInside = this.isPointInsideMesh(testPoint, otherTriangles, tol);

    return isInside ? 'INSIDE' : 'OUTSIDE';
  }

  /**
   * Determines a guaranteed interior point inside a polygon (avoids centroids falling outside concave polygons or inside holes).
   * Computes the incenter/centroid of the maximum-area triangle resulting from triangulation (with holes if present).
   */
  private static getDominantInteriorPoint(positions: Vec3[], normal: Vec3, holes?: Vec3[][]): Vec3 {
    if (positions.length === 3 && (!holes || holes.length === 0)) {
      return positions[0].add(positions[1]).add(positions[2]).scale(1 / 3);
    }

    const tris = holes && holes.length > 0
      ? PolygonClipping.triangulateWithHoles(positions, holes, normal)
      : PolygonClipping.triangulate(positions, normal);

    if (tris.length < 3) {
      return this.computeCentroid(positions);
    }

    let maxArea = -1;
    let bestPoint = positions[0];

    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i];
      const b = tris[i + 1];
      const c = tris[i + 2];
      const ab = b.sub(a);
      const ac = c.sub(a);
      const area = ab.cross(ac).length() * 0.5;

      if (area > maxArea) {
        maxArea = area;
        bestPoint = a.add(b).add(c).scale(1 / 3);
      }
    }

    return bestPoint;
  }

  /**
   * Robust 3D ray casting with multi-axial perturbation to prevent edge and vertex degeneracies.
   */
  private static isPointInsideMesh(
    point: Vec3,
    triangles: Triangle3D[],
    tol: number
  ): boolean {
    if (triangles.length === 0) return false;

    // Candidate ray directions not aligned with standard canonical axes
    const rayDirections = [
      new Vec3(1, 0, 0),
      new Vec3(0.57735, 0.57735, 0.57735).normalize(),
      new Vec3(0.26726, 0.53452, 0.80178).normalize(),
      new Vec3(-0.35857, 0.71714, 0.59761).normalize(),
    ];

    for (const rayDir of rayDirections) {
      let hitCount = 0;
      let ambiguous = false;

      for (const tri of triangles) {
        const hit = this.rayTriangleIntersect(point, rayDir, tri.a, tri.b, tri.c, tol);
        if (hit === null) continue;

        if (hit.isBorder) {
          ambiguous = true;
          break; // Perturb and try next candidate ray direction
        }

        if (hit.t > tol) {
          hitCount++;
        }
      }

      if (!ambiguous) {
        return (hitCount % 2) === 1;
      }
    }

    // Fallback: return false if all ray attempts suffered grazing ambiguities
    return false;
  }

  /**
   * Ray-triangle intersection via Möller-Trumbore algorithm with boundary grazing detection.
   */
  private static rayTriangleIntersect(
    orig: Vec3,
    dir: Vec3,
    v0: Vec3,
    v1: Vec3,
    v2: Vec3,
    tol: number
  ): { t: number; isBorder: boolean } | null {
    const edge1 = v1.sub(v0);
    const edge2 = v2.sub(v0);
    const pvec = dir.cross(edge2);
    const det = edge1.dot(pvec);

    if (Math.abs(det) < GeometryTolerance.MATH_EPSILON) return null;

    const invDet = 1.0 / det;
    const tvec = orig.sub(v0);
    const u = tvec.dot(pvec) * invDet;

    if (u < -tol || u > 1.0 + tol) return null;

    const qvec = tvec.cross(edge1);
    const v = dir.dot(qvec) * invDet;

    if (v < -tol || u + v > 1.0 + tol) return null;

    const t = edge2.dot(qvec) * invDet;
    if (t < -tol) return null;

    // Boundary detection if (u, v) falls excessively close to triangle borders
    const borderTol = 1e-3;
    const isBorder =
      Math.abs(u) < borderTol ||
      Math.abs(v) < borderTol ||
      Math.abs(u + v - 1.0) < borderTol;

    return { t, isBorder };
  }

  /**
   * Triangulates a complete PolyMesh to accelerate narrow-phase queries.
   */
  private static triangulateMesh(mesh: PolyMesh): Triangle3D[] {
    const triangles: Triangle3D[] = [];

    for (const f of mesh.faces.values()) {
      if (f.hidden) continue;
      const pos = f.getPositions();
      if (pos.length < 3) continue;

      const tris = f.hasHoles()
        ? PolygonClipping.triangulateWithHoles(pos, f.holes, f.normal)
        : PolygonClipping.triangulate(pos, f.normal);

      for (let i = 0; i < tris.length; i += 3) {
        const a = tris[i];
        const b = tris[i + 1];
        const c = tris[i + 2];
        const box = new THREE.Box3();
        box.expandByPoint(new THREE.Vector3(a.x, a.y, a.z));
        box.expandByPoint(new THREE.Vector3(b.x, b.y, b.z));
        box.expandByPoint(new THREE.Vector3(c.x, c.y, c.z));

        triangles.push({
          a,
          b,
          c,
          normal: f.normal,
          box,
        });
      }
    }

    return triangles;
  }

  private static computeMeshAABB(mesh: PolyMesh): THREE.Box3 {
    const box = new THREE.Box3();
    for (const v of mesh.vertices.values()) {
      box.expandByPoint(new THREE.Vector3(v.position.x, v.position.y, v.position.z));
    }
    return box;
  }

  private static computePointsAABB(pts: Vec3[]): THREE.Box3 {
    const box = new THREE.Box3();
    for (const p of pts) {
      box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
    }
    return box;
  }

  private static computeCentroid(pts: Vec3[]): Vec3 {
    if (pts.length === 0) return Vec3.ZERO;
    let sum = Vec3.ZERO;
    for (const p of pts) {
      sum = sum.add(p);
    }
    return sum.scale(1 / pts.length);
  }
}
