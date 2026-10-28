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
   * Test if two coplanar 3D polygons overlap, intersect, or contain each other.
   */
  static polygonsOverlapOnPlane(polyA: Vec3[], polyB: Vec3[], holesA: Vec3[][] = [], normal?: Vec3): boolean {
    if (polyA.length < 3 || polyB.length < 3) return false;
    const n = normal || Vec3.Y;
    const basis = this.getLocalBasis(polyA[0], n);
    const a2D = polyA.map((p) => this.projectTo2D(p, basis));
    const b2D = polyB.map((p) => this.projectTo2D(p, basis));

    // 1. Check if any vertex of B is inside solid area of A
    for (const p of b2D) {
      if (this.pointInPolygon2D(p, a2D)) {
        let inHole = false;
        for (const h of holesA) {
          const h2D = h.map((hp) => this.projectTo2D(hp, basis));
          if (this.pointInPolygon2D(p, h2D)) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
    }

    // 2. Check if any vertex of A is inside B
    for (const p of a2D) {
      if (this.pointInPolygon2D(p, b2D)) return true;
    }

    // 3. Check if centroid of B is inside solid area of A
    const centerB = b2D.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    centerB.x /= b2D.length;
    centerB.y /= b2D.length;
    if (this.pointInPolygon2D(centerB, a2D)) {
      let inHole = false;
      for (const h of holesA) {
        const h2D = h.map((hp) => this.projectTo2D(hp, basis));
        if (this.pointInPolygon2D(centerB, h2D)) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return true;
    }

    // 4. Check if any edge of A intersects any edge of B
    const nA = a2D.length;
    const nB = b2D.length;
    for (let i = 0; i < nA; i++) {
      const a1 = a2D[i];
      const a2 = a2D[(i + 1) % nA];
      for (let j = 0; j < nB; j++) {
        const b1 = b2D[j];
        const b2 = b2D[(j + 1) % nB];
        const det = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
        if (Math.abs(det) > 1e-6) {
          const tA = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / det;
          const tB = ((b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x)) / det;
          if (tA > 1e-4 && tA < 1 - 1e-4 && tB > 1e-4 && tB < 1 - 1e-4) {
            return true;
          }
        }
      }
    }

    return false;
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

    // Extraer segmentos interiores (cuerdas de corte interiores)
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

    // Particionar sucesivamente las piezas con cada cuerda interior válida
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

    // Filtrar piezas degeneradas o con área nula
    const validPieces = pieces.filter(
      (p) => p.length >= 3 && Math.abs(this.signedArea2D(p)) > GeometryTolerance.MIN_FACE_AREA
    );

    return validPieces.length > 0 ? validPieces.map((p) => this.ensureCCW(p)) : [poly];
  }

  /**
   * Divide un polígono CCW en dos usando una cuerda interior [p1, p2] cuyos extremos yacen en su frontera.
   */
  static splitPolygonWithSingleChord(
    poly: Vec2D[],
    p1: Vec2D,
    p2: Vec2D,
    tol: number = GeometryTolerance.COINCIDENT_VERTEX
  ): Vec2D[][] | null {
    if (poly.length < 3) return null;
    const ccw = this.ensureCCW(poly);

    // Helper para proyectar/insertar un punto en la frontera del polígono
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
   * Splits a 2D CCW polygon with a cutting segment [s1, s2].
   * Returns [polyA, polyB] if the segment cuts the polygon from boundary to boundary.
   */
  static splitPolygonWithSegment(
    poly: Vec2D[],
    s1: Vec2D,
    s2: Vec2D,
    tolerance = 0.02
  ): Vec2D[][] | null {
    if (poly.length < 3) return null;
    const ccwPoly = this.ensureCCW(poly);

    // Validar si el segmento cortante toca o cruza el polígono antes de proceder
    const midSeg: Vec2D = { x: (s1.x + s2.x) * 0.5, y: (s1.y + s2.y) * 0.5 };
    const segIntersects =
      this.pointInPolygon2D(s1, ccwPoly) ||
      this.pointInPolygon2D(s2, ccwPoly) ||
      this.pointInPolygon2D(midSeg, ccwPoly) ||
      this.isPointInOrOnPolygon2D(s1, ccwPoly, tolerance) ||
      this.isPointInOrOnPolygon2D(s2, ccwPoly, tolerance);

    let crossesBoundary = false;
    const n = ccwPoly.length;
    for (let i = 0; i < n; i++) {
      const p1 = ccwPoly[i];
      const p2 = ccwPoly[(i + 1) % n];
      const d1x = s2.x - s1.x, d1y = s2.y - s1.y;
      const d2x = p2.x - p1.x, d2y = p2.y - p1.y;
      const det = d1x * d2y - d1y * d2x;
      if (Math.abs(det) > 1e-8) {
        const t1 = ((p1.x - s1.x) * d2y - (p1.y - s1.y) * d2x) / det;
        const t2 = ((p1.x - s1.x) * d1y - (p1.y - s1.y) * d1x) / det;
        if (t1 >= -1e-4 && t1 <= 1 + 1e-4 && t2 >= -1e-4 && t2 <= 1 + 1e-4) {
          crossesBoundary = true;
          break;
        }
      }
    }

    if (!segIntersects && !crossesBoundary) {
      return null;
    }

    // Helper: distance from point to 2D line segment
    const distToSeg = (p: Vec2D, a: Vec2D, b: Vec2D) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-8) return Math.hypot(p.x - a.x, p.y - a.y);
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    };

    // Helper: find or insert point on polygon boundary
    const insertPointOnBoundary = (pts: Vec2D[], target: Vec2D): { pts: Vec2D[]; index: number } | null => {
      // 1. Check existing vertex
      for (let i = 0; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - target.x, pts[i].y - target.y) <= tolerance) {
          return { pts, index: i };
        }
      }
      // 2. Check edges
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if (distToSeg(target, a, b) <= tolerance) {
          const newPts = [...pts.slice(0, i + 1), { x: target.x, y: target.y }, ...pts.slice(i + 1)];
          return { pts: newPts, index: i + 1 };
        }
      }
      return null;
    };

    let workingPoly = [...ccwPoly];
    const res1 = insertPointOnBoundary(workingPoly, s1);
    if (!res1) {
      const resLine = this.splitPolygonWithLine(ccwPoly, s1, s2);
      if (resLine.length >= 2) {
        return resLine;
      }
      return null;
    }
    workingPoly = res1.pts;

    const res2 = insertPointOnBoundary(workingPoly, s2);
    if (!res2) {
      const resLine = this.splitPolygonWithLine(ccwPoly, s1, s2);
      if (resLine.length >= 2) {
        return resLine;
      }
      return null;
    }
    workingPoly = res2.pts;

    let idx1 = workingPoly.findIndex((p) => Math.hypot(p.x - s1.x, p.y - s1.y) <= tolerance);
    let idx2 = res2.index;

    if (idx1 === -1 || idx2 === -1 || idx1 === idx2) {
      const resLine = this.splitPolygonWithLine(ccwPoly, s1, s2);
      if (resLine.length >= 2) {
        return resLine;
      }
      return null;
    }

    if (idx1 > idx2) {
      const tmp = idx1;
      idx1 = idx2;
      idx2 = tmp;
    }

    const polyA: Vec2D[] = [];
    for (let i = idx1; i <= idx2; i++) {
      polyA.push(workingPoly[i]);
    }

    const polyB: Vec2D[] = [];
    for (let i = idx2; i < workingPoly.length; i++) {
      polyB.push(workingPoly[i]);
    }
    for (let i = 0; i <= idx1; i++) {
      polyB.push(workingPoly[i]);
    }

    if (polyA.length < 3 || polyB.length < 3) {
      return null;
    }

    const areaA = Math.abs(this.signedArea2D(polyA));
    const areaB = Math.abs(this.signedArea2D(polyB));

    if (areaA < 1e-4 || areaB < 1e-4) {
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

  /**
   * Generates a 2D offset polygon.
   * - distance < 0: inward offset (contracción hacia el interior).
   * - distance > 0: outward offset (expansión hacia el exterior).
   * Returns the offset polygon vertices, or null if the polygon collapses.
   */
  static offsetPolygon2D(polygon: Vec2D[], distance: number): Vec2D[] | null {
    const n = polygon.length;
    if (n < 3) return null;
    if (Math.abs(distance) < GeometryTolerance.MATH_EPSILON) {
      return polygon.map((p) => ({ ...p }));
    }

    const ccw = this.ensureCCW(polygon);
    const origArea = this.signedArea2D(ccw);
    if (origArea <= GeometryTolerance.MATH_EPSILON) return null;

    // For CCW polygon, inward normal is (-t_y, t_x).
    // If distance < 0 (inward): we shift along inward normal by |distance| = -distance.
    // If distance > 0 (outward): we shift opposite to inward normal by distance.
    const shiftInward = -distance;

    const shiftedLines: { p: Vec2D; d: Vec2D; n: Vec2D }[] = [];
    for (let i = 0; i < n; i++) {
      const pA = ccw[i];
      const pB = ccw[(i + 1) % n];
      const dx = pB.x - pA.x;
      const dy = pB.y - pA.y;
      const len = Math.hypot(dx, dy);
      if (len < GeometryTolerance.MATH_EPSILON) continue;

      const tx = dx / len;
      const ty = dy / len;
      // Inward normal (pointing inside CCW polygon): (-ty, tx)
      const nx = -ty;
      const ny = tx;

      const pShifted = {
        x: pA.x + shiftInward * nx,
        y: pA.y + shiftInward * ny,
      };
      shiftedLines.push({ p: pShifted, d: { x: tx, y: ty }, n: { x: nx, y: ny } });
    }

    const m = shiftedLines.length;
    if (m < 3) return null;

    const offsetVerts: Vec2D[] = [];
    for (let i = 0; i < m; i++) {
      const l1 = shiftedLines[(i - 1 + m) % m];
      const l2 = shiftedLines[i];

      // Intersect line 1 (p1 + s*d1) with line 2 (p2 + t*d2)
      const det = l1.d.y * l2.d.x - l1.d.x * l2.d.y;
      if (Math.abs(det) < GeometryTolerance.MATH_EPSILON) {
        // Parallel or collinear edges: fallback to vertex shift
        offsetVerts.push({ x: l2.p.x, y: l2.p.y });
      } else {
        const dx = l2.p.x - l1.p.x;
        const dy = l2.p.y - l1.p.y;
        const detS = dy * l2.d.x - dx * l2.d.y;
        const s = detS / det;
        offsetVerts.push({
          x: l1.p.x + s * l1.d.x,
          y: l1.p.y + s * l1.d.y,
        });
      }
    }

    // Validation:
    const newArea = this.signedArea2D(offsetVerts);
    if (distance < 0) {
      if (newArea <= GeometryTolerance.MATH_EPSILON || newArea >= origArea) {
        return null; // Collapsed or inverted
      }
      // For inward offset, each vertex must lie on the inward side of all shifted edge lines
      for (const q of offsetVerts) {
        for (const line of shiftedLines) {
          const dot = (q.x - line.p.x) * line.n.x + (q.y - line.p.y) * line.n.y;
          if (dot < -GeometryTolerance.COINCIDENT_VERTEX) {
            return null; // Edges crossed; polygon collapsed
          }
        }
      }
    } else {
      if (newArea <= origArea) {
        return null;
      }
    }

    return offsetVerts;
  }

  /**
   * Generates a 3D offset polygon on the plane defined by `normal`.
   * - distance < 0: inward offset (contracción hacia el interior).
   * - distance > 0: outward offset (expansión hacia el exterior).
   */
  static offsetPolygon3D(positions: Vec3[], normal: Vec3, distance: number): Vec3[] | null {
    if (positions.length < 3) return null;
    const basis = this.getLocalBasis(positions[0], normal);
    const poly2D = positions.map((p) => this.projectTo2D(p, basis));

    const offset2D = this.offsetPolygon2D(poly2D, distance);
    if (!offset2D) return null;

    return offset2D.map((p) => this.unprojectTo3D(p, basis));
  }
}
