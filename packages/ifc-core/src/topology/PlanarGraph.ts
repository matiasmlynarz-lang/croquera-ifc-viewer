/**
 * PlanarGraph — Planar Straight-Line Graph (PSLG) & Face Extraction Engine.
 *
 * Implements formal 2D computational geometry for planar face decomposition:
 * 1. Planar arrangement of line segments with automatic 2D intersection splitting.
 * 2. Radial sorting of incident half-edges around vertices.
 * 3. Deterministic Minimum Bounded Cycle extraction (Leftmost Turn Traversal).
 * 4. Hole and containment classification by 2D Point-in-Polygon testing.
 * 5. Orthonormal 3D <-> 2D basis projections.
 */
import { Vec3 } from '../math/Vec3';
import { PolygonClipping, LocalBasis, Vec2D } from './PolygonClipping';
import { GeometryTolerance } from '../math/GeometryTolerance';

export interface PlanarFace2D {
  outerLoop: Vec2D[];
  holes: Vec2D[][];
  area: number;
}

export class PlanarGraph {
  public basis: LocalBasis;
  private vertices: Vec2D[] = [];
  private edges: [number, number][] = []; // [v1Index, v2Index]
  private vertexGrid2D: Map<number, number[]> = new Map();

  private static getGridHash2D(gx: number, gy: number): number {
    return (((gx * 73856093) ^ (gy * 19349663)) | 0);
  }

  constructor(origin: Vec3, normal: Vec3) {
    this.basis = PolygonClipping.getLocalBasis(origin, normal);
  }

  // ─── Vertex Management ────────────────────────────────────────
  private addVertex2D(p: Vec2D): number {
    const cellSize = GeometryTolerance.COINCIDENT_POINT * 2;
    const tolSq = GeometryTolerance.COINCIDENT_POINT_SQ;
    const gx = Math.floor(p.x / cellSize);
    const gy = Math.floor(p.y / cellSize);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = PlanarGraph.getGridHash2D(gx + dx, gy + dy);
        const bucket = this.vertexGrid2D.get(key);
        if (!bucket) continue;
        for (const idx of bucket) {
          const v = this.vertices[idx];
          const diffX = v.x - p.x;
          const diffY = v.y - p.y;
          if (diffX * diffX + diffY * diffY < tolSq) {
            return idx;
          }
        }
      }
    }

    const idx = this.vertices.length;
    this.vertices.push({ x: p.x, y: p.y });
    const centerKey = PlanarGraph.getGridHash2D(gx, gy);
    let cell = this.vertexGrid2D.get(centerKey);
    if (!cell) {
      cell = [];
      this.vertexGrid2D.set(centerKey, cell);
    }
    cell.push(idx);
    return idx;
  }

  public addVertex3D(p: Vec3): number {
    const p2d = PolygonClipping.projectTo2D(p, this.basis);
    return this.addVertex2D(p2d);
  }

  // ─── Segment Insertion with Auto-Intersection ─────────────────
  /**
   * Insert a 2D line segment [p1, p2].
   * Automatically calculates all intersections with existing edges and splits all crossing edges.
   */
  public addSegment2D(p1: Vec2D, p2: Vec2D): void {
    if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < GeometryTolerance.COINCIDENT_POINT) return;

    // Collect all existing segments
    const allSegments: { a: Vec2D; b: Vec2D }[] = this.edges.map(([i, j]) => ({
      a: this.vertices[i],
      b: this.vertices[j],
    }));

    allSegments.push({ a: p1, b: p2 });

    // Rebuild graph with all intersections resolved
    this.rebuildFromSegments(allSegments);
  }

  /**
   * Batch insertion of multiple 2D segments resolving the planar arrangement in a single O(n^2) pass.
   */
  public addSegments2D(newSegments: { a: Vec2D; b: Vec2D }[]): void {
    const validSegments: { a: Vec2D; b: Vec2D }[] = [];
    for (const s of newSegments) {
      if (Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) >= GeometryTolerance.COINCIDENT_POINT) {
        validSegments.push(s);
      }
    }
    if (validSegments.length === 0) return;

    const allSegments: { a: Vec2D; b: Vec2D }[] = this.edges.map(([i, j]) => ({
      a: this.vertices[i],
      b: this.vertices[j],
    }));

    allSegments.push(...validSegments);
    this.rebuildFromSegments(allSegments);
  }

  public addSegment3D(p1: Vec3, p2: Vec3): void {
    const s1 = PolygonClipping.projectTo2D(p1, this.basis);
    const s2 = PolygonClipping.projectTo2D(p2, this.basis);
    this.addSegment2D(s1, s2);
  }

  /**
   * Batch insertion of multiple 3D segments in a single pass.
   */
  public addSegments3D(segments: { a: Vec3; b: Vec3 }[]): void {
    if (segments.length === 0) return;
    const segments2D: { a: Vec2D; b: Vec2D }[] = [];
    for (const s of segments) {
      const s1 = PolygonClipping.projectTo2D(s.a, this.basis);
      const s2 = PolygonClipping.projectTo2D(s.b, this.basis);
      segments2D.push({ a: s1, b: s2 });
    }
    this.addSegments2D(segments2D);
  }

  /**
   * Insert a closed 3D polygon loop (boundary or cutout) in batch.
   */
  public addPolygon3D(positions: Vec3[]): void {
    const n = positions.length;
    if (n < 2) return;
    const segments2D: { a: Vec2D; b: Vec2D }[] = [];
    for (let i = 0; i < n; i++) {
      const s1 = PolygonClipping.projectTo2D(positions[i], this.basis);
      const s2 = PolygonClipping.projectTo2D(positions[(i + 1) % n], this.basis);
      segments2D.push({ a: s1, b: s2 });
    }
    this.addSegments2D(segments2D);
  }

  /**
   * Insert multiple closed 3D polygon loops in a single unified arrangement.
   */
  public addPolygons3D(polygons: Vec3[][]): void {
    const segments2D: { a: Vec2D; b: Vec2D }[] = [];
    for (const poly of polygons) {
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const s1 = PolygonClipping.projectTo2D(poly[i], this.basis);
        const s2 = PolygonClipping.projectTo2D(poly[(i + 1) % n], this.basis);
        segments2D.push({ a: s1, b: s2 });
      }
    }
    this.addSegments2D(segments2D);
  }

  // ─── 2D Line-Line Intersection & Network Partitioning ─────────
  private rebuildFromSegments(segments: { a: Vec2D; b: Vec2D }[]): void {
    // 1. Find all pairwise intersection points
    const splitPointsMap: Map<number, { pt: Vec2D; t: number }[]> = new Map();
    for (let i = 0; i < segments.length; i++) {
      splitPointsMap.set(i, [
        { pt: segments[i].a, t: 0 },
        { pt: segments[i].b, t: 1 },
      ]);
    }

    // Precompute 2D AABB for each segment for preliminary O(1) broad-phase rejection
    const aabbs = segments.map((s) => ({
      minX: Math.min(s.a.x, s.b.x) - GeometryTolerance.COINCIDENT_POINT,
      maxX: Math.max(s.a.x, s.b.x) + GeometryTolerance.COINCIDENT_POINT,
      minY: Math.min(s.a.y, s.b.y) - GeometryTolerance.COINCIDENT_POINT,
      maxY: Math.max(s.a.y, s.b.y) + GeometryTolerance.COINCIDENT_POINT,
    }));

    const n = segments.length;
    for (let i = 0; i < n; i++) {
      const bb1 = aabbs[i];
      for (let j = i + 1; j < n; j++) {
        const bb2 = aabbs[j];
        // Descarte preliminar si las cajas envolventes no se solapan
        if (
          bb1.minX > bb2.maxX ||
          bb1.maxX < bb2.minX ||
          bb1.minY > bb2.maxY ||
          bb1.maxY < bb2.minY
        ) {
          continue;
        }

        const s1 = segments[i];
        const s2 = segments[j];

        const x1 = s1.a.x, y1 = s1.a.y;
        const x2 = s1.b.x, y2 = s1.b.y;
        const x3 = s2.a.x, y3 = s2.a.y;
        const x4 = s2.b.x, y4 = s2.b.y;

        const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
        if (Math.abs(denom) < GeometryTolerance.MATH_EPSILON) {
          // Parallel or collinear: check point-on-segment
          this.checkPointOnSegment(s1.a, s2, splitPointsMap.get(j)!);
          this.checkPointOnSegment(s1.b, s2, splitPointsMap.get(j)!);
          this.checkPointOnSegment(s2.a, s1, splitPointsMap.get(i)!);
          this.checkPointOnSegment(s2.b, s1, splitPointsMap.get(i)!);
          continue;
        }

        const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
        const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;

        if (
          ua >= -GeometryTolerance.COINCIDENT_POINT &&
          ua <= 1 + GeometryTolerance.COINCIDENT_POINT &&
          ub >= -GeometryTolerance.COINCIDENT_POINT &&
          ub <= 1 + GeometryTolerance.COINCIDENT_POINT
        ) {
          const clampedUa = Math.max(0, Math.min(1, ua));
          const clampedUb = Math.max(0, Math.min(1, ub));

          const ix = x1 + clampedUa * (x2 - x1);
          const iy = y1 + clampedUa * (y2 - y1);
          const pt: Vec2D = { x: ix, y: iy };

          splitPointsMap.get(i)!.push({ pt, t: clampedUa });
          splitPointsMap.get(j)!.push({ pt, t: clampedUb });
        }
      }
    }

    // 2. Re-create vertices and edge pairs from sub-segments
    this.vertices = [];
    this.edges = [];
    this.vertexGrid2D.clear();

    const edgeSignatures = new Set<string>();

    for (let i = 0; i < n; i++) {
      const splits = splitPointsMap.get(i)!;
      splits.sort((p1, p2) => p1.t - p2.t);

      // Deduplicate points along this segment
      const uniqueSplits: Vec2D[] = [];
      for (const sp of splits) {
        if (
          uniqueSplits.length === 0 ||
          Math.hypot(uniqueSplits[uniqueSplits.length - 1].x - sp.pt.x, uniqueSplits[uniqueSplits.length - 1].y - sp.pt.y) > GeometryTolerance.COINCIDENT_POINT
        ) {
          uniqueSplits.push(sp.pt);
        }
      }

      for (let k = 0; k < uniqueSplits.length - 1; k++) {
        const u = this.addVertex2D(uniqueSplits[k]);
        const v = this.addVertex2D(uniqueSplits[k + 1]);
        if (u === v) continue;

        const minIdx = Math.min(u, v);
        const maxIdx = Math.max(u, v);
        const sig = `${minIdx}_${maxIdx}`;

        if (!edgeSignatures.has(sig)) {
          edgeSignatures.add(sig);
          this.edges.push([minIdx, maxIdx]);
        }
      }
    }
  }

  private checkPointOnSegment(p: Vec2D, seg: { a: Vec2D; b: Vec2D }, targetList: { pt: Vec2D; t: number }[]): void {
    const dx = seg.b.x - seg.a.x;
    const dy = seg.b.y - seg.a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < GeometryTolerance.MATH_EPSILON) return;

    const t = ((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / l2;
    if (t >= -GeometryTolerance.COINCIDENT_POINT && t <= 1 + GeometryTolerance.COINCIDENT_POINT) {
      const projX = seg.a.x + t * dx;
      const projY = seg.a.y + t * dy;
      if (Math.hypot(p.x - projX, p.y - projY) < GeometryTolerance.COINCIDENT_POINT) {
        targetList.push({ pt: { x: p.x, y: p.y }, t: Math.max(0, Math.min(1, t)) });
      }
    }
  }

  // ─── Deterministic Face Extraction (Leftmost Turn Traversal) ─
  /**
   * Extracts all planar bounded 2D faces from the current edge network.
   * Follows Euler's planar graph face formula.
   * Complexity: O(V + E) with iterative degree-1 filament pruning and radial sorting.
   */
  public extractFaces2D(): PlanarFace2D[] {
    if (this.edges.length < 3 || this.vertices.length < 3) {
      return [];
    }

    // 0. Topological Pruning of Dangling Edges (Antennas / degree-1 filaments)
    // Filaments cannot bound a 2D face and would otherwise create degenerate 0-width slit loops.
    const degreeMap = new Map<number, number>();
    for (const [u, v] of this.edges) {
      degreeMap.set(u, (degreeMap.get(u) || 0) + 1);
      degreeMap.set(v, (degreeMap.get(v) || 0) + 1);
    }

    const activeEdges = new Set<number>(this.edges.map((_, i) => i));
    let pruned = true;
    while (pruned) {
      pruned = false;
      for (const [edgeIdx, [u, v]] of this.edges.entries()) {
        if (!activeEdges.has(edgeIdx)) continue;
        if ((degreeMap.get(u) || 0) <= 1 || (degreeMap.get(v) || 0) <= 1) {
          activeEdges.delete(edgeIdx);
          degreeMap.set(u, (degreeMap.get(u) || 0) - 1);
          degreeMap.set(v, (degreeMap.get(v) || 0) - 1);
          pruned = true;
        }
      }
    }

    if (activeEdges.size < 3) {
      return [];
    }

    // 1. Build directed half-edges only from active (non-dangling) edges
    interface DirectedHalfEdge {
      origin: number;
      target: number;
      angle: number; // Angle from origin to target in (-PI, PI]
      visited: boolean;
    }

    const halfEdges: DirectedHalfEdge[] = [];
    const outgoing: Map<number, DirectedHalfEdge[]> = new Map();

    for (let i = 0; i < this.vertices.length; i++) {
      outgoing.set(i, []);
    }

    for (const edgeIdx of activeEdges) {
      const [u, v] = this.edges[edgeIdx];
      const pu = this.vertices[u];
      const pv = this.vertices[v];

      const angleUV = Math.atan2(pv.y - pu.y, pv.x - pu.x);
      const angleVU = Math.atan2(pu.y - pv.y, pu.x - pv.x);

      const heUV: DirectedHalfEdge = { origin: u, target: v, angle: angleUV, visited: false };
      const heVU: DirectedHalfEdge = { origin: v, target: u, angle: angleVU, visited: false };

      halfEdges.push(heUV, heVU);
      outgoing.get(u)!.push(heUV);
      outgoing.get(v)!.push(heVU);
    }

    // 2. Sort outgoing half-edges radially counter-clockwise around each vertex
    for (const edgesAtVertex of outgoing.values()) {
      edgesAtVertex.sort((a, b) => a.angle - b.angle);
    }

    // 3. Helper to find the leftmost (CCW next) half-edge at target vertex
    const getLeftmostNext = (currentHe: DirectedHalfEdge): DirectedHalfEdge | null => {
      const atTarget = outgoing.get(currentHe.target);
      if (!atTarget || atTarget.length === 0) return null;

      // The reverse of currentHe has angle:
      const reverseAngle = Math.atan2(
        this.vertices[currentHe.origin].y - this.vertices[currentHe.target].y,
        this.vertices[currentHe.origin].x - this.vertices[currentHe.target].x
      );

      // Find the edge in atTarget that represents the sharpest left turn forward
      // (minimal clockwise angular displacement from reverseAngle)
      let bestIdx = 0;
      let minAngleDiff = Infinity;

      for (let i = 0; i < atTarget.length; i++) {
        let diff = reverseAngle - atTarget[i].angle;
        while (diff <= GeometryTolerance.MATH_EPSILON) diff += 2 * Math.PI;
        if (diff < minAngleDiff) {
          minAngleDiff = diff;
          bestIdx = i;
        }
      }

      return atTarget[bestIdx];
    };

    // 4. Trace all minimal cycles with explicit safety guard
    const rawCycles: Vec2D[][] = [];

    for (const he of halfEdges) {
      if (he.visited) continue;

      const cycleIndices: number[] = [];
      let curr: DirectedHalfEdge | null = he;
      let guard = 0;

      while (curr && !curr.visited && guard++ < 2000) {
        curr.visited = true;
        cycleIndices.push(curr.origin);
        curr = getLeftmostNext(curr);

        if (curr && curr.origin === he.origin && curr.target === he.target) {
          break; // Closed loop
        }
      }

      if (cycleIndices.length >= 3) {
        const poly = cycleIndices.map((idx) => this.vertices[idx]);
        rawCycles.push(poly);
      }
    }

    // 5. Separate positive area (CCW = bounded faces) from negative area (CW = outer unbounded boundary / holes)
    const positiveFaces: { poly: Vec2D[]; area: number }[] = [];
    const negativeHoles: { poly: Vec2D[]; area: number }[] = [];

    for (const poly of rawCycles) {
      const area = PolygonClipping.signedArea2D(poly);
      if (Math.abs(area) > GeometryTolerance.COINCIDENT_POINT) {
        if (area > 0) {
          positiveFaces.push({ poly, area });
        } else {
          // Negative area: can be an inner hole cutout
          negativeHoles.push({ poly: [...poly].reverse(), area: Math.abs(area) });
        }
      }
    }

    // 6. Nest holes into corresponding positive outer faces
    const result: PlanarFace2D[] = [];

    for (const pFace of positiveFaces) {
      const matchingHoles: Vec2D[][] = [];

      for (let hIdx = negativeHoles.length - 1; hIdx >= 0; hIdx--) {
        const hole = negativeHoles[hIdx];
        // Test if hole center is inside pFace
        const hCenter = hole.poly.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
        hCenter.x /= hole.poly.length;
        hCenter.y /= hole.poly.length;

        if (pFace.area > hole.area + GeometryTolerance.COINCIDENT_POINT && PolygonClipping.pointInPolygon2D(hCenter, pFace.poly)) {
          matchingHoles.push(hole.poly);
        }
      }

      result.push({
        outerLoop: pFace.poly,
        holes: matchingHoles,
        area: pFace.area,
      });
    }

    return result;
  }

  /**
   * Extract and unproject all 3D faces from this planar graph.
   */
  public extractFaces3D(): { positions: Vec3[]; holes: Vec3[][]; normal: Vec3 }[] {
    const faces2D = this.extractFaces2D();
    return faces2D.map((f) => ({
      positions: f.outerLoop.map((p) => PolygonClipping.unprojectTo3D(p, this.basis)),
      holes: f.holes.map((h) => h.map((p) => PolygonClipping.unprojectTo3D(p, this.basis))),
      normal: this.basis.normal,
    }));
  }
}
