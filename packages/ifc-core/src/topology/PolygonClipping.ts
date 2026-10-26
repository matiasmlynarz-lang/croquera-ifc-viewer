/**
 * PolygonClipping — 2D computational geometry and polygon partitioning on face planes.
 *
 * Provides:
 * - Local 2D orthonormal basis creation from 3D plane normal (u, v).
 * - Ear Clipping triangulation for planar polygons (convex and concave).
 * - Point-in-polygon testing.
 * - General polygon partitioning when embedding a cutout polygon (door/window) into a host polygon.
 * - Splitting a polygon by a 2D line segment.
 */
import * as THREE from 'three';
import { Vec3 } from '../math/Vec3';
import { GeometryTolerance } from '../math/GeometryTolerance';

export interface LocalBasis {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  normal: Vec3;
}

export interface Vec2D {
  x: number;
  y: number;
}

export class PolygonClipping {
  /**
   * Build an orthonormal 2D basis (u, v) on the plane defined by `normal` and `origin`.
   */
  static getLocalBasis(origin: Vec3, normal: Vec3): LocalBasis {
    const n = normal.normalize();
    let u: Vec3;

    if (Math.abs(n.dot(Vec3.Y)) > 0.9) {
      // Near horizontal plane (floor/ceiling)
      u = Vec3.X.cross(n).normalize();
      if (u.isZero()) u = Vec3.Z.cross(n).normalize();
    } else {
      // Vertical or tilted plane (wall/roof)
      u = Vec3.Y.cross(n).normalize();
    }

    const v = n.cross(u).normalize();
    return { origin, u, v, normal: n };
  }

  /**
   * Project a 3D point onto the local 2D basis.
   */
  static projectTo2D(point: Vec3, basis: LocalBasis): Vec2D {
    const delta = point.sub(basis.origin);
    return {
      x: delta.dot(basis.u),
      y: delta.dot(basis.v),
    };
  }

  /**
   * Unproject a 2D point back to 3D world coordinates on the basis plane.
   */
  static unprojectTo3D(p2d: Vec2D, basis: LocalBasis): Vec3 {
    return basis.origin.add(basis.u.scale(p2d.x)).add(basis.v.scale(p2d.y));
  }

  /**
   * Calculate signed area of a 2D polygon (positive = CCW, negative = CW).
   */
  static signedArea2D(poly: Vec2D[]): number {
    let area = 0;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
    }
    return area * 0.5;
  }

  /**
   * Ensure polygon vertices are in Counter-Clockwise (CCW) winding order.
   */
  static ensureCCW(poly: Vec2D[]): Vec2D[] {
    if (this.signedArea2D(poly) < 0) {
      return [...poly].reverse();
    }
    return poly;
  }

  /**
   * Point in 2D polygon test (ray-casting winding number).
   */
  static pointInPolygon2D(p: Vec2D, poly: Vec2D[]): boolean {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;

      if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Point in or on 2D polygon boundary test.
   * Returns true if point is strictly inside OR lies on any boundary edge segment within tolerance.
   */
  static isPointInOrOnPolygon2D(
    p: Vec2D,
    poly: Vec2D[],
    tol: number = GeometryTolerance.COINCIDENT_VERTEX
  ): boolean {
    if (this.pointInPolygon2D(p, poly)) return true;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const l2 = abx * abx + aby * aby;
      if (l2 > GeometryTolerance.MATH_EPSILON) {
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

  /**
   * Test if a point is inside a 2D triangle.
   */
  private static isPointInTriangle(p: Vec2D, a: Vec2D, b: Vec2D, c: Vec2D): boolean {
    const v0x = c.x - a.x, v0y = c.y - a.y;
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = p.x - a.x, v2y = p.y - a.y;

    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;

    const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

    return (u >= -GeometryTolerance.MATH_EPSILON) && (v >= -GeometryTolerance.MATH_EPSILON) && (u + v <= 1 + GeometryTolerance.MATH_EPSILON);
  }

  /**
   * Triangulate a planar 3D polygon using Ear Clipping.
   * Returns an array of 3D triangle vertex triplets [t0_a, t0_b, t0_c, t1_a, ...].
   */
  static triangulate(vertices3D: Vec3[], normal: Vec3): Vec3[] {
    const n = vertices3D.length;
    if (n < 3) return [];

    const rawTriangles: Vec3[] = [];
    if (n === 3) {
      const v0 = vertices3D[0], v1 = vertices3D[1], v2 = vertices3D[2];
      const triN = v1.sub(v0).cross(v2.sub(v0));
      if (triN.dot(normal) >= 0) {
        rawTriangles.push(v0, v1, v2);
      } else {
        rawTriangles.push(v0, v2, v1);
      }
    } else if (n === 4) {
      const basis = this.getLocalBasis(vertices3D[0], normal);
      const poly2D = vertices3D.map((v) => this.projectTo2D(v, basis));
      const isCCW = this.signedArea2D(poly2D) > 0;
      const ccw2D = isCCW ? poly2D : [poly2D[0], poly2D[3], poly2D[2], poly2D[1]];
      const ccw3D = isCCW ? vertices3D : [vertices3D[0], vertices3D[3], vertices3D[2], vertices3D[1]];

      const cross2D = (p1: Vec2D, p2: Vec2D, p3: Vec2D) =>
        (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);

      const c012 = cross2D(ccw2D[0], ccw2D[1], ccw2D[2]);
      const c023 = cross2D(ccw2D[0], ccw2D[2], ccw2D[3]);

      if (c012 > GeometryTolerance.MATH_EPSILON && c023 > GeometryTolerance.MATH_EPSILON) {
        rawTriangles.push(ccw3D[0], ccw3D[1], ccw3D[2], ccw3D[0], ccw3D[2], ccw3D[3]);
      } else {
        rawTriangles.push(ccw3D[1], ccw3D[2], ccw3D[3], ccw3D[1], ccw3D[3], ccw3D[0]);
      }
    } else {
      const basis = this.getLocalBasis(vertices3D[0], normal);
      const poly2D = vertices3D.map((v) => this.projectTo2D(v, basis));

      const ccwIndices: number[] = [];
      const isCCW = this.signedArea2D(poly2D) > 0;
      for (let i = 0; i < n; i++) {
        ccwIndices.push(isCCW ? i : n - 1 - i);
      }

      const remaining = [...ccwIndices];
      let attempts = 0;
      const maxAttempts = remaining.length * 3;

      while (remaining.length > 2 && attempts++ < maxAttempts) {
        let earFound = false;
        const count = remaining.length;

        for (let i = 0; i < count; i++) {
          const prevIdx = remaining[(i - 1 + count) % count];
          const currIdx = remaining[i];
          const nextIdx = remaining[(i + 1) % count];

          const a = poly2D[prevIdx];
          const b = poly2D[currIdx];
          const c = poly2D[nextIdx];

          // Must be convex corner
          const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
          if (cross <= GeometryTolerance.MATH_EPSILON) continue;

          // No other vertex inside this triangle
          let hasInternal = false;
          for (let j = 0; j < count; j++) {
            const testIdx = remaining[j];
            if (testIdx === prevIdx || testIdx === currIdx || testIdx === nextIdx) continue;
            if (this.isPointInTriangle(poly2D[testIdx], a, b, c)) {
              hasInternal = true;
              break;
            }
          }

          if (!hasInternal) {
            rawTriangles.push(vertices3D[prevIdx], vertices3D[currIdx], vertices3D[nextIdx]);
            remaining.splice(i, 1);
            earFound = true;
            break;
          }
        }

        if (!earFound) {
          // Fallback: fan triangulation
          const v0 = vertices3D[remaining[0]];
          for (let k = 1; k < remaining.length - 1; k++) {
            rawTriangles.push(v0, vertices3D[remaining[k]], vertices3D[remaining[k + 1]]);
          }
          break;
        }
      }
    }

    return rawTriangles;
  }

  /**
   * Triangulate a planar polygon with arbitrary inner hole cutouts using Earcut.
   * Produces a clean triangle mesh covering the solid area around all openings without any seams.
   */
  static triangulateWithHoles(outer: Vec3[], holes: Vec3[][] = [], normal?: Vec3): Vec3[] {
    if (outer.length < 3) return [];
    const n = normal || (outer.length >= 3 ? outer[1].sub(outer[0]).cross(outer[2].sub(outer[0])).normalize() : Vec3.Y);
    if (!holes || holes.length === 0) {
      return this.triangulate(outer, n);
    }

    const basis = this.getLocalBasis(outer[0], n);

    const outer2D = outer.map((p) => {
      const p2 = this.projectTo2D(p, basis);
      return new THREE.Vector2(p2.x, p2.y);
    });

    const holes2D = holes
      .filter((h) => h.length >= 3)
      .map((h) =>
        h.map((p) => {
          const p2 = this.projectTo2D(p, basis);
          return new THREE.Vector2(p2.x, p2.y);
        })
      );

    // Ensure outer2D is CCW for ShapeUtils
    const ccwOuter2D = this.signedArea2D(outer2D) > 0 ? [...outer2D] : [...outer2D].reverse();

    // Ensure each hole is CW for ShapeUtils
    const cwHoles2D = holes2D.map((h) => (this.signedArea2D(h) > 0 ? [...h].reverse() : [...h]));

    const faces = THREE.ShapeUtils.triangulateShape(ccwOuter2D, cwHoles2D);
    const triangles: Vec3[] = [];

    // Flat list of 2D points: [outer..., hole0..., hole1...]
    const allPts2D: THREE.Vector2[] = [...ccwOuter2D];
    for (const h of cwHoles2D) {
      allPts2D.push(...h);
    }

    for (const tri of faces) {
      const p0 = this.unprojectTo3D({ x: allPts2D[tri[0]].x, y: allPts2D[tri[0]].y }, basis);
      const p1 = this.unprojectTo3D({ x: allPts2D[tri[1]].x, y: allPts2D[tri[1]].y }, basis);
      const p2 = this.unprojectTo3D({ x: allPts2D[tri[2]].x, y: allPts2D[tri[2]].y }, basis);

      const triN = p1.sub(p0).cross(p2.sub(p0));
      if (triN.dot(n) >= 0) {
        triangles.push(p0, p1, p2);
      } else {
        triangles.push(p0, p2, p1);
      }
    }

    return triangles;
  }

  /**
   * Test if a 3D point on the face plane is inside the solid face area (inside outer loop and outside all holes).
   */
  static pointInPolygonWithHoles(point: Vec3, outer: Vec3[], holes: Vec3[][] = [], normal?: Vec3): boolean {
    if (outer.length < 3) return false;
    const n = normal || Vec3.Y;
    const basis = this.getLocalBasis(outer[0], n);

    const p2D = this.projectTo2D(point, basis);
    const outer2D = outer.map((p) => this.projectTo2D(p, basis));

    if (!this.pointInPolygon2D(p2D, outer2D)) {
      return false;
    }

    for (const hole of holes) {
      if (hole.length < 3) continue;
      const hole2D = hole.map((p) => this.projectTo2D(p, basis));
      if (this.pointInPolygon2D(p2D, hole2D)) {
        return false; // Point is inside the cutout/hole!
      }
    }

    return true;
  }

  /**
   * Split a 2D polygon with a line segment [s1, s2] that intersects the boundary.
   */
  /**
   * Split a 2D polygon with a cutting line passing through [s1, s2].
   * Supports both convex and concave simple polygons with 2 or more intersections.
   */
  static splitPolygonWithLine(poly: Vec2D[], s1: Vec2D, s2: Vec2D): Vec2D[][] {
    const dx = s2.x - s1.x;
    const dy = s2.y - s1.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < GeometryTolerance.MATH_EPSILON) return [poly];

    const intersections: { edgeIndex: number; tEdge: number; tLine: number; point: Vec2D }[] = [];
    const n = poly.length;

    for (let i = 0; i < n; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % n];

      const ex = p2.x - p1.x;
      const ey = p2.y - p1.y;
      const denom = dx * ey - dy * ex;

      if (Math.abs(denom) > GeometryTolerance.MATH_EPSILON) {
        const tEdge = ((p1.x - s1.x) * dy - (p1.y - s1.y) * dx) / denom;

        if (tEdge >= -GeometryTolerance.MATH_EPSILON && tEdge <= 1 + GeometryTolerance.MATH_EPSILON) {
          const pt: Vec2D = {
            x: p1.x + tEdge * ex,
            y: p1.y + tEdge * ey,
          };
          const tLine = ((pt.x - s1.x) * dx + (pt.y - s1.y) * dy) / lenSq;
          intersections.push({ edgeIndex: i, tEdge, tLine, point: pt });
        }
      }
    }

    if (intersections.length < 2) {
      return [poly];
    }

    // Sort intersections along the cutting line direction
    intersections.sort((a, b) => a.tLine - b.tLine);

    // Deduplicate intersections that are extremely close along the cutting line
    const uniqueIntersections: typeof intersections = [];
    for (const it of intersections) {
      if (
        uniqueIntersections.length === 0 ||
        Math.hypot(
          it.point.x - uniqueIntersections[uniqueIntersections.length - 1].point.x,
          it.point.y - uniqueIntersections[uniqueIntersections.length - 1].point.y
        ) > GeometryTolerance.COINCIDENT_VERTEX
      ) {
        uniqueIntersections.push(it);
      }
    }

    if (uniqueIntersections.length < 2) {
      return [poly];
    }

    // Extract interior segments (internal cutting chords)
    const chords: { p1: Vec2D; p2: Vec2D }[] = [];
    for (let i = 0; i < uniqueIntersections.length - 1; i++) {
      const pA = uniqueIntersections[i].point;
      const pB = uniqueIntersections[i + 1].point;
      const mid: Vec2D = {
        x: (pA.x + pB.x) * 0.5,
        y: (pA.y + pB.y) * 0.5,
      };
      if (
        this.pointInPolygon2D(mid, poly) ||
        this.isPointInOrOnPolygon2D(mid, poly, GeometryTolerance.COINCIDENT_VERTEX)
      ) {
        chords.push({ p1: pA, p2: pB });
      }
    }

    if (chords.length === 0) {
      return [poly];
    }

    // Sequentially partition polygon pieces using each valid interior chord
    let pieces: Vec2D[][] = [this.ensureCCW(poly)];

    for (const chord of chords) {
      const nextPieces: Vec2D[][] = [];
      let chordApplied = false;

      for (const piece of pieces) {
        if (!chordApplied) {
          const splitRes = this.splitPolygonWithSingleChord(piece, chord.p1, chord.p2);
          if (splitRes && splitRes.length === 2) {
            nextPieces.push(...splitRes);
            chordApplied = true;
            continue;
          }
        }
        nextPieces.push(piece);
      }
      pieces = nextPieces;
    }

    // Filter out degenerate or zero-area pieces
    const validPieces = pieces.filter(
      (p) => p.length >= 3 && Math.abs(this.signedArea2D(p)) > GeometryTolerance.MIN_FACE_AREA
    );

    return validPieces.length > 0 ? validPieces.map((p) => this.ensureCCW(p)) : [poly];
  }

  /**
   * Splits a CCW polygon in two using an interior chord [p1, p2] whose endpoints lie on its boundary.
   */
  static splitPolygonWithSingleChord(
    poly: Vec2D[],
    p1: Vec2D,
    p2: Vec2D,
    tol: number = GeometryTolerance.COINCIDENT_VERTEX
  ): Vec2D[][] | null {
    if (poly.length < 3) return null;
    const ccw = this.ensureCCW(poly);

    // Helper to project/insert a point onto the polygon boundary
    const insertOnBoundary = (pts: Vec2D[], target: Vec2D): { pts: Vec2D[]; index: number } | null => {
      for (let i = 0; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - target.x, pts[i].y - target.y) <= tol) {
          return { pts, index: i };
        }
      }
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        const l2 = dx * dx + dy * dy;
        if (l2 > 1e-8) {
          const t = ((target.x - a.x) * dx + (target.y - a.y) * dy) / l2;
          if (t >= 0 && t <= 1) {
            const projX = a.x + t * dx;
            const projY = a.y + t * dy;
            if (Math.hypot(target.x - projX, target.y - projY) <= tol) {
              const newPts = [...pts.slice(0, i + 1), { x: target.x, y: target.y }, ...pts.slice(i + 1)];
              return { pts: newPts, index: i + 1 };
            }
          }
        }
      }
      return null;
    };

    const res1 = insertOnBoundary(ccw, p1);
    if (!res1) return null;
    const res2 = insertOnBoundary(res1.pts, p2);
    if (!res2) return null;

    let idx1 = res2.pts.findIndex((p) => Math.hypot(p.x - p1.x, p.y - p1.y) <= tol);
    let idx2 = res2.index;
    if (idx1 === -1 || idx2 === -1 || idx1 === idx2) return null;

    if (idx1 > idx2) {
      const tmp = idx1;
      idx1 = idx2;
      idx2 = tmp;
    }

    const working = res2.pts;
    const polyA: Vec2D[] = [];
    for (let i = idx1; i <= idx2; i++) {
      polyA.push(working[i]);
    }

    const polyB: Vec2D[] = [];
    for (let i = idx2; i < working.length; i++) {
      polyB.push(working[i]);
    }
    for (let i = 0; i <= idx1; i++) {
      polyB.push(working[i]);
    }

    if (polyA.length < 3 || polyB.length < 3) return null;
    const areaA = Math.abs(this.signedArea2D(polyA));
    const areaB = Math.abs(this.signedArea2D(polyB));
    if (areaA <= GeometryTolerance.MIN_FACE_AREA || areaB <= GeometryTolerance.MIN_FACE_AREA) {
      return null;
    }

    return [this.ensureCCW(polyA), this.ensureCCW(polyB)];
  }



  /**
   * Check if a 4-vertex 2D polygon is strictly an axis-aligned rectangle.
   */
  static isAxisAlignedRectangle(poly: Vec2D[], tol: number = 1e-4): boolean {
    if (poly.length !== 4) return false;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (maxX - minX < tol || maxY - minY < tol) return false;
    for (const p of poly) {
      const onLeftOrRight = Math.abs(p.x - minX) < tol || Math.abs(p.x - maxX) < tol;
      const onBottomOrTop = Math.abs(p.y - minY) < tol || Math.abs(p.y - maxY) < tol;
      if (!onLeftOrRight || !onBottomOrTop) return false;
    }
    return true;
  }

  /**
   * General Polygon Subtraction: partitions the outer polygon around an inner cutout.
   * Produces clean 4-quad framing for rectangular cutouts (Bottom, Top, Left, Right)
   * with zero seam lines extending across the host surface.
   */
  static partitionPolygonWithCutout(outerPoly: Vec2D[], innerPoly: Vec2D[]): Vec2D[][] {
    // 1. Fast path strictly for verified axis-aligned rectangular framing
    if (this.isAxisAlignedRectangle(outerPoly) && this.isAxisAlignedRectangle(innerPoly)) {
      let minOu = Infinity, maxOu = -Infinity, minOv = Infinity, maxOv = -Infinity;
      for (const p of outerPoly) {
        if (p.x < minOu) minOu = p.x;
        if (p.x > maxOu) maxOu = p.x;
        if (p.y < minOv) minOv = p.y;
        if (p.y > maxOv) maxOv = p.y;
      }

      let minIu = Infinity, maxIu = -Infinity, minIv = Infinity, maxIv = -Infinity;
      for (const p of innerPoly) {
        if (p.x < minIu) minIu = p.x;
        if (p.x > maxIu) maxIu = p.x;
        if (p.y < minIv) minIv = p.y;
        if (p.y > maxIv) maxIv = p.y;
      }

      // Clamp inner bounds to outer bounds
      const cuMin = Math.max(minOu, minIu);
      const cuMax = Math.min(maxOu, maxIu);
      const cvMin = Math.max(minOv, minIv);
      const cvMax = Math.min(maxOv, maxIv);

      const pieces: Vec2D[][] = [];

      // Bottom Piece (below cutout, includes intermediate cutout points for exact half-edge twinning)
      if (cvMin - minOv > 1e-4) {
        const bottomPoly: Vec2D[] = [
          { x: minOu, y: minOv },
          { x: maxOu, y: minOv },
          { x: maxOu, y: cvMin },
        ];
        if (maxOu - cuMax > 1e-4) {
          bottomPoly.push({ x: cuMax, y: cvMin });
        }
        if (cuMin - minOu > 1e-4) {
          bottomPoly.push({ x: cuMin, y: cvMin });
        }
        bottomPoly.push({ x: minOu, y: cvMin });
        pieces.push(this.ensureCCW(bottomPoly));
      }

      // Top Piece (above cutout, includes intermediate cutout points for exact half-edge twinning)
      if (maxOv - cvMax > 1e-4) {
        const topPoly: Vec2D[] = [
          { x: minOu, y: cvMax },
        ];
        if (cuMin - minOu > 1e-4) {
          topPoly.push({ x: cuMin, y: cvMax });
        }
        if (maxOu - cuMax > 1e-4) {
          topPoly.push({ x: cuMax, y: cvMax });
        }
        topPoly.push(
          { x: maxOu, y: cvMax },
          { x: maxOu, y: maxOv },
          { x: minOu, y: maxOv },
        );
        pieces.push(this.ensureCCW(topPoly));
      }

      // Left Piece (beside cutout)
      if (cuMin - minOu > 1e-4 && cvMax - cvMin > 1e-4) {
        pieces.push(this.ensureCCW([
          { x: minOu, y: cvMin },
          { x: cuMin, y: cvMin },
          { x: cuMin, y: cvMax },
          { x: minOu, y: cvMax },
        ]));
      }

      // Right Piece (beside cutout)
      if (maxOu - cuMax > 1e-4 && cvMax - cvMin > 1e-4) {
        pieces.push(this.ensureCCW([
          { x: cuMax, y: cvMin },
          { x: maxOu, y: cvMin },
          { x: maxOu, y: cvMax },
          { x: cuMax, y: cvMax },
        ]));
      }

      if (pieces.length > 0) {
        return pieces;
      }
    }

    // 2. General slicing fallback for arbitrary complex polygons
    let workingPieces: Vec2D[][] = [this.ensureCCW(outerPoly)];
    const m = innerPoly.length;

    for (let i = 0; i < m; i++) {
      const p1 = innerPoly[i];
      const p2 = innerPoly[(i + 1) % m];

      const newPieces: Vec2D[][] = [];
      for (const piece of workingPieces) {
        const splits = this.splitPolygonWithLine(piece, p1, p2);
        for (const sp of splits) {
          if (Math.abs(this.signedArea2D(sp)) > 1e-4) {
            newPieces.push(sp);
          }
        }
      }
      workingPieces = newPieces;
    }

    const remnantPieces = workingPieces.filter((piece) => {
      let cx = 0, cy = 0;
      for (const pt of piece) {
        cx += pt.x;
        cy += pt.y;
      }
      cx /= piece.length;
      cy /= piece.length;

      return !this.pointInPolygon2D({ x: cx, y: cy }, innerPoly);
    });

    return remnantPieces.map((p) => this.ensureCCW(p));
  }
}
