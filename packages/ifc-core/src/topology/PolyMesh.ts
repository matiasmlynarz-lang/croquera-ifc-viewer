/**
 * PolyMesh — Topological Mesh & Solid Engine for CROQUERA.
 *
 * Implements Half-Edge based representations for 2D polygonal faces and
 * 3D closed manifold solids. Supports:
 * - Embedding sub-faces (doors, windows, cutouts) into existing solid faces.
 * - 3-Way Push/Pull Extrusion (extension, feature offset, and through-hole opening creation).
 * - Proper normal orientation for both positive and negative extrusions.
 * - Viewport BufferGeometry and EdgesGeometry generation.
 */
import * as THREE from 'three';
import { Vec3 } from '../math/Vec3';
import { Plane } from '../math/Plane';
import { GeometryTolerance } from '../math/GeometryTolerance';
import { Vertex, Edge, Face, HalfEdge } from './HalfEdge';
import { PolygonClipping, Vec2D } from './PolygonClipping';
import { PlanarGraph } from './PlanarGraph';

export interface TopologyValidationOptions {
  checkManifold?: boolean;
  checkEuler?: boolean;
  checkGeometry?: boolean;
  allowOpenBoundaries?: boolean;
}

export interface TopologyValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  eulerCharacteristic?: number;
  genus?: number;
  isClosed: boolean;
}

export class PolyMesh {
  public static DEBUG_VALIDATE: boolean = false;
  public readonly id: string;
  public vertices: Map<string, Vertex> = new Map();
  public edges: Map<string, Edge> = new Map();
  public faces: Map<string, Face> = new Map();
  public halfEdges: Map<string, HalfEdge> = new Map();

  private vertexSpatialGrid: Map<number, Vertex[]> = new Map();
  private unmatchedHalfEdges: Map<string, HalfEdge> = new Map();

  public version: number = 0;

  public bumpVersion(): void {
    this.version++;
  }

  public resetVersion(): void {
    this.version = 0;
  }

  public isDirty(): boolean {
    return this.version > 0;
  }

  private static getGridHash(gx: number, gy: number, gz: number): number {
    return (((gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791)) | 0);
  }

  private nextVertexId = 0;
  private nextEdgeId = 0;
  private nextFaceId = 0;
  private nextHalfEdgeId = 0;

  constructor(id: string) {
    this.id = id;
  }

  // ─── ID Generators ──────────────────────────────────────────
  private genVertexId(): string { return `v_${this.id}_${++this.nextVertexId}`; }
  private genEdgeId(): string { return `e_${this.id}_${++this.nextEdgeId}`; }
  private genFaceId(): string { return `f_${this.id}_${++this.nextFaceId}`; }
  private genHalfEdgeId(): string { return `he_${this.id}_${++this.nextHalfEdgeId}`; }

  // ─── Vertex Management ──────────────────────────────────────
  addVertex(position: Vec3): Vertex {
    const cellSize = GeometryTolerance.SPATIAL_GRID_CELL_SIZE;
    const tolSq = GeometryTolerance.COINCIDENT_POINT_SQ;
    const gx = Math.floor(position.x / cellSize);
    const gy = Math.floor(position.y / cellSize);
    const gz = Math.floor(position.z / cellSize);

    // Query cell and 26 adjacent neighbors in O(1) with 32-bit integer hash
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = PolyMesh.getGridHash(gx + dx, gy + dy, gz + dz);
          const bucket = this.vertexSpatialGrid.get(key);
          if (!bucket) continue;
          for (const v of bucket) {
            const diffX = v.position.x - position.x;
            const diffY = v.position.y - position.y;
            const diffZ = v.position.z - position.z;
            if (diffX * diffX + diffY * diffY + diffZ * diffZ < tolSq) {
              return v;
            }
          }
        }
      }
    }

    const id = this.genVertexId();
    const v = new Vertex(id, position);
    this.vertices.set(id, v);

    const centerKey = PolyMesh.getGridHash(gx, gy, gz);
    let cell = this.vertexSpatialGrid.get(centerKey);
    if (!cell) {
      cell = [];
      this.vertexSpatialGrid.set(centerKey, cell);
    }
    cell.push(v);
    return v;
  }

  getVertex(id: string): Vertex | undefined {
    return this.vertices.get(id);
  }

  // ─── Face & HalfEdge Construction ───────────────────────────
  static computePolygonNormal(pts: Vec3[]): Vec3 {
    if (pts.length < 3) return Vec3.Y;
    let nx = 0, ny = 0, nz = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const curr = pts[i];
      const next = pts[(i + 1) % n];
      nx += (curr.y - next.y) * (curr.z + next.z);
      ny += (curr.z - next.z) * (curr.x + next.x);
      nz += (curr.x - next.x) * (curr.y + next.y);
    }
    const result = new Vec3(nx, ny, nz);
    return result.isZero() ? Vec3.Y : result.normalize();
  }

  addFace(
    positions: Vec3[],
    explicitNormal?: Vec3,
    holes?: Vec3[][],
    holeOwners?: (string | null)[],
    explicitFaceId?: string
  ): Face {
    if (positions.length < 3) {
      throw new Error('Face must have at least 3 vertices.');
    }

    let orderedPositions = [...positions];
    if (explicitNormal) {
      const computedN = PolyMesh.computePolygonNormal(orderedPositions);
      if (computedN.dot(explicitNormal) < 0) {
        orderedPositions.reverse();
      }
    }

    const verts = orderedPositions.map((p) => this.addVertex(p));
    const n = verts.length;
    const faceHalfEdges: HalfEdge[] = [];

    // Create half-edges for outer perimeter
    for (let i = 0; i < n; i++) {
      const origin = verts[i];
      const target = verts[(i + 1) % n];
      const he = new HalfEdge(this.genHalfEdgeId(), origin, target);
      this.halfEdges.set(he.id, he);
      faceHalfEdges.push(he);

      if (!origin.halfEdge) {
        origin.halfEdge = he;
      }
    }

    // Link next/prev pointers
    for (let i = 0; i < n; i++) {
      faceHalfEdges[i].next = faceHalfEdges[(i + 1) % n];
      faceHalfEdges[i].prev = faceHalfEdges[(i - 1 + n) % n];
    }

    // Create Face with holes and holeOwners
    if (explicitFaceId) {
      const match = explicitFaceId.match(/_(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > this.nextFaceId) {
          this.nextFaceId = num;
        }
      }
    }
    const faceId = explicitFaceId || this.genFaceId();
    const face = new Face(faceId, faceHalfEdges[0], explicitNormal, holes, holeOwners);
    for (const he of faceHalfEdges) {
      he.face = face;
    }
    this.faces.set(faceId, face);

    // Create / link Edges & Twins with existing half-edges
    for (const he of faceHalfEdges) {
      this.matchOrRegisterEdge(he);
    }

    this.bumpVersion();
    return face;
  }

  private matchOrRegisterEdge(he: HalfEdge): void {
    const twinKey = `${he.target.id}:${he.origin.id}`;
    const otherHe = this.unmatchedHalfEdges.get(twinKey);
    if (otherHe && !otherHe.twin && otherHe !== he) {
      he.twin = otherHe;
      otherHe.twin = he;

      if (otherHe.edge) {
        he.edge = otherHe.edge;
        otherHe.edge.he2 = he;
      }
      this.unmatchedHalfEdges.delete(twinKey);
      return;
    }

    const edgeId = this.genEdgeId();
    const edge = new Edge(edgeId, he);
    he.edge = edge;
    this.edges.set(edgeId, edge);
    this.unmatchedHalfEdges.set(`${he.origin.id}:${he.target.id}`, he);
  }

  private removeVertexFromGrid(v: Vertex): void {
    const cellSize = GeometryTolerance.SPATIAL_GRID_CELL_SIZE;
    const gx = Math.floor(v.position.x / cellSize);
    const gy = Math.floor(v.position.y / cellSize);
    const gz = Math.floor(v.position.z / cellSize);
    const centerKey = PolyMesh.getGridHash(gx, gy, gz);
    const cell = this.vertexSpatialGrid.get(centerKey);
    if (cell) {
      const idx = cell.indexOf(v);
      if (idx !== -1) {
        cell.splice(idx, 1);
        if (cell.length === 0) {
          this.vertexSpatialGrid.delete(centerKey);
        }
      }
    }
  }

  removeFace(faceId: string): boolean {
    const face = this.faces.get(faceId);
    if (!face) return false;

    const faceVerts = face.getVertices();
    const halfEdges = face.getHalfEdges();

    // Register which vertices are connected to surviving twins from adjacent faces
    const survivingVerts = new Set<Vertex>();

    for (const he of halfEdges) {
      if (he.twin) {
        const twin = he.twin;
        twin.twin = undefined;
        if (he.edge) {
          he.edge.he2 = undefined;
        }
        this.unmatchedHalfEdges.set(`${twin.origin.id}:${twin.target.id}`, twin);
        survivingVerts.add(twin.origin);
        survivingVerts.add(twin.target);
      } else {
        if (he.edge) {
          this.edges.delete(he.edge.id);
        }
        this.unmatchedHalfEdges.delete(`${he.origin.id}:${he.target.id}`);
      }
      this.halfEdges.delete(he.id);
    }

    this.faces.delete(faceId);

    // For face vertices, verify whether they became orphaned or remain in use
    for (const v of faceVerts) {
      if (survivingVerts.has(v)) {
        // Ensure surviving vertex has a valid halfEdge assigned
        if (!v.halfEdge || !this.halfEdges.has(v.halfEdge.id)) {
          for (const remainingHe of this.halfEdges.values()) {
            if (remainingHe.origin === v) {
              v.halfEdge = remainingHe;
              break;
            }
          }
        }
        continue;
      }

      // Check whether v remains referenced in any other unmatched half-edge of the mesh
      let inUse = false;
      for (const uhe of this.unmatchedHalfEdges.values()) {
        if (uhe.origin === v || uhe.target === v) {
          inUse = true;
          if (uhe.origin === v) v.halfEdge = uhe;
          break;
        }
      }

      if (!inUse) {
        // Completely orphaned vertex: remove from vertices and from Spatial Hash Grid
        this.vertices.delete(v.id);
        this.removeVertexFromGrid(v);
      }
    }

    this.bumpVersion();
    return true;
  }

  reverseFace(faceId: string): boolean {
    const face = this.faces.get(faceId);
    if (!face) return false;

    const prevMaterialId = face.materialId;
    const prevHoles = face.holes.map((h) => [...h].reverse());
    const prevHoleOwners = face.holeOwners ? [...face.holeOwners] : undefined;
    const prevHidden = face.hidden;
    const prevOpeningId = face.openingId;
    const prevPlanarReflector = face.hasPlanarReflector;

    const verts = face.getPositions();
    verts.reverse();
    const normal = face.normal.negate();

    this.removeFace(faceId);
    const newFace = this.addFace(verts, normal, prevHoles, prevHoleOwners);
    this.faces.delete(newFace.id);
    newFace.id = faceId;
    this.faces.set(faceId, newFace);

    newFace.materialId = prevMaterialId;
    newFace.hidden = prevHidden;
    newFace.openingId = prevOpeningId;
    newFace.hasPlanarReflector = prevPlanarReflector;

    this.rebuildTopology();
    return true;
  }

  /**
   * Simplifies redundant collinear vertices in a closed loop (boundary or hole).
   * If three consecutive vertices A, B, C lie on the same straight line with the same direction,
   * intermediate vertex B is removed to yield the minimal geometric boundary.
   */
  public static simplifyCollinearLoop(loop: Vec3[]): Vec3[] {
    if (loop.length < 3) return loop;
    const result: Vec3[] = [];
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const prev = loop[(i - 1 + n) % n];
      const curr = loop[i];
      const next = loop[(i + 1) % n];

      const e1 = curr.sub(prev);
      const e2 = next.sub(curr);
      const l1 = e1.length();
      const l2 = e2.length();

      if (l1 < GeometryTolerance.MIN_EDGE_LENGTH || l2 < GeometryTolerance.MIN_EDGE_LENGTH) {
        continue;
      }

      const d1 = e1.scale(1 / l1);
      const d2 = e2.scale(1 / l2);
      const crossLen = d1.cross(d2).length();
      const dot = d1.dot(d2);

      // If vectors are parallel in the same direction (dot > COLLINEAR_DOT_TOLERANCE and cross ~ 0)
      if (crossLen < GeometryTolerance.COPLANAR_NORMAL && dot > GeometryTolerance.COLLINEAR_DOT_TOLERANCE) {
        // Redundant collinear vertex, skip
        continue;
      }
      result.push(curr);
    }
    return result.length >= 3 ? result : loop;
  }

  /**
   * Partitions a set of coplanar faces into connected components by shared edge (Rules 6, 7, 11).
   * Two faces are adjacent if and only if they share an internal half-edge in opposite directions: (u -> v) and (v -> u).
   * Bounded complexity O(E) = O(N) satisfying Rule 7.
   */
  private static getEdgeConnectedComponents(faces: Face[]): Face[][] {
    const N = faces.length;
    if (N <= 1) return [faces];

    const edgeToFace = new Map<string, number>();
    const adj = new Map<number, number[]>();
    for (let i = 0; i < N; i++) {
      adj.set(i, []);
    }

    for (let i = 0; i < N; i++) {
      const halfEdges = faces[i].getHalfEdges();
      for (const he of halfEdges) {
        const u = he.origin.id;
        const v = he.target.id;
        const fwd = `${u}:${v}`;
        const rev = `${v}:${u}`;
        const neighbor = edgeToFace.get(rev);
        if (neighbor !== undefined) {
          adj.get(i)!.push(neighbor);
          adj.get(neighbor)!.push(i);
        }
        edgeToFace.set(fwd, i);
      }
    }

    const visited = new Set<number>();
    const components: Face[][] = [];

    for (let i = 0; i < N; i++) {
      if (visited.has(i)) continue;
      const comp: Face[] = [];
      const queue: number[] = [i];
      visited.add(i);

      let head = 0;
      while (head < queue.length) {
        const curr = queue[head++];
        comp.push(faces[curr]);
        const neighbors = adj.get(curr);
        if (neighbors) {
          for (const next of neighbors) {
            if (!visited.has(next)) {
              visited.add(next);
              queue.push(next);
            }
          }
        }
      }
      components.push(comp);
    }

    return components;
  }

  /**
   * Coalesce coplanar faces into minimal polygonal faces (quads and n-gons with holes).
   *
   * Designed for imported tessellated meshes (e.g. IFCTRIANGULATEDFACESET) to eliminate
   * internal diagonal edges in viewport rendering and restore direct face selection/modeling.
   *
   * Rules Compliance:
   * - Rule 6: Uses GeometryTolerance.IMPORTED_COPLANAR_NORMAL and POINT_ON_PLANE.
   * - Rule 7 & Rule 24: O(T) linear complexity via directed half-edge cancellation (verified by TC-COAL-PERF).
   * - Rule 11: Handles degenerate cases, multi-island disjoint boundaries, and hole containment via 2D point-in-polygon.
   * - Rule 13: Defensive fallback preserves original faces with structured warning if a bucket has broken topology.
   * - Rule 17: Preserves materialId and openingId by segregating coplanar buckets.
   */
  public coalesceCoplanarFaces(): void {
    if (this.faces.size < 2) return;

    // 1. Group coplanar faces into buckets using normal, plane distance, materialId, and openingId (Rules 6, 7, 17, 22)
    interface CoplanarBucket {
      normal: Vec3;
      planeD: number;
      refPoint: Vec3;
      materialId?: string | null;
      openingId?: string | null;
      faces: Face[];
    }

    // Local reference centroid for translational invariance (Rules 6, 7 and 22)
    let sumX = 0, sumY = 0, sumZ = 0;
    let vCount = 0;
    for (const v of this.vertices.values()) {
      sumX += v.position.x;
      sumY += v.position.y;
      sumZ += v.position.z;
      vCount++;
    }
    const refCenter = vCount > 0 ? new Vec3(sumX / vCount, sumY / vCount, sumZ / vCount) : new Vec3(0, 0, 0);

    const allBuckets: CoplanarBucket[] = [];
    const bucketGrid = new Map<string, CoplanarBucket[]>();
    const normStep = GeometryTolerance.IMPORTED_COPLANAR_NORMAL * 2;
    const distStep = GeometryTolerance.POINT_ON_PLANE * 2;

    for (const face of this.faces.values()) {
      if (face.hidden) continue;
      const positions = face.getPositions();
      if (positions.length < 3) continue;

      const faceNormal = face.normal;
      const p0 = positions[0];
      const relP0 = p0.sub(refCenter);
      const d = faceNormal.dot(relP0);
      const mat = face.materialId || '';
      const op = face.openingId || '';

      const gx = Math.round(faceNormal.x / normStep);
      const gy = Math.round(faceNormal.y / normStep);
      const gz = Math.round(faceNormal.z / normStep);
      const gd = Math.round(d / distStep);

      let matchedBucket: CoplanarBucket | null = null;

      // Check current cell and neighboring cells for robust boundary handling
      neighborLoop: for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (let dd = -1; dd <= 1; dd++) {
              const key = `${gx + dx}:${gy + dy}:${gz + dz}:${gd + dd}:${mat}:${op}`;
              const candidateList = bucketGrid.get(key);
              if (!candidateList) continue;

              for (const cand of candidateList) {
                if (cand.materialId !== face.materialId) continue;
                if (cand.openingId !== face.openingId) continue;

                const dotNorm = faceNormal.dot(cand.normal);
                if (Math.abs(dotNorm - 1) <= GeometryTolerance.IMPORTED_COPLANAR_NORMAL) {
                  // Dual verification: relative scalar distance and direct point-plane distance (Rules 6, 22)
                  const planeDDiff = Math.abs(d - cand.planeD);
                  const directDist = Math.abs(cand.normal.dot(p0.sub(cand.refPoint)));
                  if (
                    planeDDiff <= GeometryTolerance.POINT_ON_PLANE ||
                    directDist <= GeometryTolerance.POINT_ON_PLANE
                  ) {
                    matchedBucket = cand;
                    break neighborLoop;
                  }
                }
              }
            }
          }
        }
      }

      if (matchedBucket) {
        matchedBucket.faces.push(face);
      } else {
        const newBucket: CoplanarBucket = {
          normal: faceNormal,
          planeD: d,
          refPoint: p0,
          materialId: face.materialId,
          openingId: face.openingId,
          faces: [face],
        };
        allBuckets.push(newBucket);
        const centerKey = `${gx}:${gy}:${gz}:${gd}:${mat}:${op}`;
        let list = bucketGrid.get(centerKey);
        if (!list) {
          list = [];
          bucketGrid.set(centerKey, list);
        }
        list.push(newBucket);
      }
    }

    let meshChanged = false;

    // 2. Process each bucket that has at least 2 coplanar faces
    for (const bucket of allBuckets) {
      if (bucket.faces.length < 2) continue;

      // 2.a Deduplicate identical faces sharing the same vertices
      const uniqueFaces: Face[] = [];
      const seenFaceSigs = new Set<string>();
      for (const face of bucket.faces) {
        const vIds = face.getHalfEdges().map((he) => he.origin.id).sort().join(':');
        if (!seenFaceSigs.has(vIds)) {
          seenFaceSigs.add(vIds);
          uniqueFaces.push(face);
        } else {
          this.removeFace(face.id);
          meshChanged = true;
        }
      }

      if (uniqueFaces.length < 2) continue;

      // 2.b Partition into connected components by shared internal edge (Rules 6, 7, 11)
      const components = PolyMesh.getEdgeConnectedComponents(uniqueFaces);

      for (const compFaces of components) {
        if (compFaces.length < 2) continue;

        // Cancel internal directed half-edges in O(E) (Rule 7)
        const directedEdgeMap = new Map<string, { origin: Vertex; target: Vertex }>();
        let hasDegenerateOrNonManifold = false;

        for (const face of compFaces) {
          const halfEdges = face.getHalfEdges();
          if (halfEdges.length < 3) {
            hasDegenerateOrNonManifold = true;
            break;
          }

          for (const he of halfEdges) {
            const u = he.origin;
            const v = he.target;
            if (u === v || u.position.distanceTo(v.position) < GeometryTolerance.MIN_EDGE_LENGTH) {
              continue;
            }

            const forwardKey = `${u.id}:${v.id}`;
            const reverseKey = `${v.id}:${u.id}`;

            if (directedEdgeMap.has(forwardKey)) {
              hasDegenerateOrNonManifold = true;
              break;
            }

            if (directedEdgeMap.has(reverseKey)) {
              directedEdgeMap.delete(reverseKey);
            } else {
              directedEdgeMap.set(forwardKey, { origin: u, target: v });
            }
          }
          if (hasDegenerateOrNonManifold) break;
        }

        if (hasDegenerateOrNonManifold || directedEdgeMap.size < 3) {
          if (hasDegenerateOrNonManifold) {
            console.warn(`[PolyMesh.coalesceCoplanarFaces] Geometria no-manifold o degenerada detectada en plano coplanar. Conservando caras originales.`);
          }
          continue;
        }

        // Build outgoing map for loop chaining
        const outgoingMap = new Map<string, { origin: Vertex; target: Vertex }>();
        for (const edge of directedEdgeMap.values()) {
          if (outgoingMap.has(edge.origin.id)) {
            hasDegenerateOrNonManifold = true;
            break;
          }
          outgoingMap.set(edge.origin.id, edge);
        }

        if (hasDegenerateOrNonManifold) {
          console.warn(`[PolyMesh.coalesceCoplanarFaces] Limite no-manifold con multiples aristas de salida. Conservando caras originales.`);
          continue;
        }

        // Chain directed edges into closed loops
        const loops: Vec3[][] = [];
        const visitedOrigins = new Set<string>();

        for (const startEdge of directedEdgeMap.values()) {
          if (visitedOrigins.has(startEdge.origin.id)) continue;

          const loop: Vec3[] = [];
          let currVertex = startEdge.origin;
          let closed = false;
          let steps = 0;
          const maxSteps = directedEdgeMap.size + 1;

          while (steps < maxSteps) {
            loop.push(currVertex.position);
            visitedOrigins.add(currVertex.id);

            const nextEdge = outgoingMap.get(currVertex.id);
            if (!nextEdge) break;

            currVertex = nextEdge.target;
            steps++;

            if (currVertex.id === startEdge.origin.id) {
              closed = true;
              break;
            }
            if (visitedOrigins.has(currVertex.id)) break;
          }

          if (!closed || loop.length < 3) {
            hasDegenerateOrNonManifold = true;
            break;
          }

          const simplified = PolyMesh.simplifyCollinearLoop(loop);
          if (simplified.length >= 3) {
            loops.push(simplified);
          }
        }

        if (hasDegenerateOrNonManifold || loops.length === 0) {
          console.warn(`[PolyMesh.coalesceCoplanarFaces] Falla al cerrar bucles perimetrales. Conservando caras originales.`);
          continue;
        }

        // Project loops to 2D local basis and classify outer vs inner holes
        const basis = PolygonClipping.getLocalBasis(loops[0][0], bucket.normal);

        interface ClassifiedLoop {
          loop3D: Vec3[];
          loop2D: Vec2D[];
          area: number;
          isOuter: boolean;
          holes: Vec3[][];
        }

        const classifiedLoops: ClassifiedLoop[] = [];

        for (const loop3D of loops) {
          const loop2D = loop3D.map((p) => PolygonClipping.projectTo2D(p, basis));
          const area2D = PolygonClipping.signedArea2D(loop2D);

          if (Math.abs(area2D) <= GeometryTolerance.MIN_FACE_AREA) continue;

          classifiedLoops.push({
            loop3D,
            loop2D,
            area: area2D,
            isOuter: area2D > 0,
            holes: [],
          });
        }

        const outerLoops = classifiedLoops.filter((l) => l.isOuter);
        const innerHoles = classifiedLoops.filter((l) => !l.isOuter);

        if (outerLoops.length === 0) {
          for (const l of innerHoles) {
            l.isOuter = true;
            l.area = -l.area;
            l.loop3D.reverse();
            l.loop2D.reverse();
            outerLoops.push(l);
          }
          innerHoles.length = 0;
        }

        // Assign each inner hole to its containing outer loop via 2D Point-in-Polygon (Rule 11)
        for (const hole of innerHoles) {
          const testPt = hole.loop2D[0];
          let assignedOuter: ClassifiedLoop | null = null;

          for (const outer of outerLoops) {
            if (PolygonClipping.pointInPolygon2D(testPt, outer.loop2D)) {
              assignedOuter = outer;
              break;
            }
          }

          if (assignedOuter) {
            assignedOuter.holes.push(hole.loop3D);
          } else {
            hole.isOuter = true;
            hole.loop3D.reverse();
            outerLoops.push(hole);
          }
        }

        // Replace original component faces with consolidated clean polygonal faces
        for (const face of compFaces) {
          this.removeFace(face.id);
        }

        for (const outer of outerLoops) {
          const computedN = PolyMesh.computePolygonNormal(outer.loop3D);
          if (computedN.dot(bucket.normal) < 0) {
            outer.loop3D.reverse();
          }

          const newFace = this.addFace(
            outer.loop3D,
            bucket.normal,
            outer.holes.length > 0 ? outer.holes : undefined
          );
          newFace.materialId = bucket.materialId;
          newFace.openingId = bucket.openingId;
        }

        meshChanged = true;
      }
    }

    if (meshChanged) {
      this.rebuildTopology();
      this.resetVersion();
    }
  }


  /**
   * Transforms all vertices and holes of the PolyMesh using a 4x4 matrix.
   * Normals and planes are automatically dynamic via live vertex getters.
   */
  applyMatrix4(matrix: THREE.Matrix4): void {
    for (const v of this.vertices.values()) {
      const p = new THREE.Vector3(v.position.x, v.position.y, v.position.z).applyMatrix4(matrix);
      v.position = new Vec3(p.x, p.y, p.z);
    }
    for (const face of this.faces.values()) {
      face.holes = face.holes.map((hole) =>
        hole.map((p) => {
          const tp = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(matrix);
          return new Vec3(tp.x, tp.y, tp.z);
        })
      );
    }
    this.rebuildTopology();
  }

  /**
   * Clone this PolyMesh into a new independent PolyMesh.
   */
  clone(newId?: string): PolyMesh {
    const cloned = new PolyMesh(newId || `${this.id}_clone`);
    for (const f of this.faces.values()) {
      const clonedFace = cloned.addFace(
        f.getPositions(),
        f.normal,
        f.holes.map((h) => [...h]),
        f.holeOwners ? [...f.holeOwners] : undefined,
        newId ? undefined : f.id
      );
      clonedFace.materialId = f.materialId;
      clonedFace.hidden = f.hidden;
      clonedFace.openingId = f.openingId;
    }
    cloned.rebuildTopology();
    return cloned;
  }

  rebuildTopology(): void {
    const facesSnapshot = Array.from(this.faces.values()).map((f) => ({
      id: f.id,
      positions: f.getPositions(),
      normal: f.normal,
      holes: f.holes.map((h) => [...h]),
      holeOwners: f.holeOwners ? [...f.holeOwners] : undefined,
      hidden: f.hidden,
      materialId: f.materialId,
      openingId: f.openingId,
      hasPlanarReflector: f.hasPlanarReflector,
    }));

    this.faces.clear();
    this.vertices.clear();
    this.halfEdges.clear();
    this.edges.clear();
    this.vertexSpatialGrid.clear();
    this.unmatchedHalfEdges.clear();

    for (const f of facesSnapshot) {
      const deduped: Vec3[] = [];
      for (const p of f.positions) {
        if (deduped.length === 0 || deduped[deduped.length - 1].distanceTo(p) > GeometryTolerance.COINCIDENT_POINT) {
          deduped.push(p);
        }
      }
      if (deduped.length >= 3 && deduped[0].distanceTo(deduped[deduped.length - 1]) < GeometryTolerance.COINCIDENT_POINT) {
        deduped.pop();
      }
      if (deduped.length < 3) continue;
      const verts = deduped.map((p) => this.addVertex(p));
      const n = verts.length;
      const faceHalfEdges: HalfEdge[] = [];

      for (let i = 0; i < n; i++) {
        const origin = verts[i];
        const target = verts[(i + 1) % n];
        const he = new HalfEdge(this.genHalfEdgeId(), origin, target);
        this.halfEdges.set(he.id, he);
        faceHalfEdges.push(he);
        if (!origin.halfEdge) origin.halfEdge = he;
      }

      for (let i = 0; i < n; i++) {
        faceHalfEdges[i].next = faceHalfEdges[(i + 1) % n];
        faceHalfEdges[i].prev = faceHalfEdges[(i - 1 + n) % n];
      }

      const face = new Face(f.id, faceHalfEdges[0], f.normal, f.holes);
      if (f.holeOwners) face.holeOwners = [...f.holeOwners];
      if (f.hidden) face.hidden = true;
      if (f.materialId) face.materialId = f.materialId;
      if (f.openingId) face.openingId = f.openingId;
      if (f.hasPlanarReflector) face.hasPlanarReflector = f.hasPlanarReflector;
      for (const he of faceHalfEdges) {
        he.face = face;
      }
      this.faces.set(f.id, face);

      for (const he of faceHalfEdges) {
        this.matchOrRegisterEdge(he);
      }
    }

    if (PolyMesh.DEBUG_VALIDATE) {
      const validation = this.validate({ allowOpenBoundaries: true });
      if (!validation.valid) {
        console.warn(`[PolyMesh.rebuildTopology] Inconsistencia topológica detectada en ${this.id}:`, validation.errors);
      }
    }
    this.bumpVersion();
  }

  // ─── Polygon Geometry Calculations ──────────────────────────
  static computePolygonArea(pts: Vec3[]): number {
    if (pts.length < 3) return 0;
    const p0 = pts[0];
    let totalCross = Vec3.ZERO;
    const n = pts.length;
    for (let i = 1; i < n - 1; i++) {
      totalCross = totalCross.add(pts[i].sub(p0).cross(pts[i + 1].sub(p0)));
    }
    return totalCross.length() * 0.5;
  }

  // ─── Rendering & SceneGraph Conversion ──────────────────────
  toThreeGeometry(renderOffset?: Vec3, singleSided = false): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const backPositions: number[] = [];
    const backNormals: number[] = [];

    const ox = renderOffset ? renderOffset.x : 0;
    const oy = renderOffset ? renderOffset.y : 0;
    const oz = renderOffset ? renderOffset.z : 0;

    // Grouping by material: default clay group vs custom material groups
    const defaultGroup = { positions: [] as number[], normals: [] as number[] };
    const customGroups = new Map<string, { positions: number[]; normals: number[] }>();

    for (const face of this.faces.values()) {
      if (face.hidden) continue;
      const verts = face.getPositions();
      const n = face.normal;
      const tris = face.hasHoles()
        ? PolygonClipping.triangulateWithHoles(verts, face.holes, n)
        : PolygonClipping.triangulate(verts, n);

      const DEFAULT_CLAY_MATERIAL_ID = 'mat_default_clay';
      const mId = face.materialId && face.materialId !== DEFAULT_CLAY_MATERIAL_ID ? face.materialId : null;
      let targetGroup = defaultGroup;
      if (mId) {
        if (!customGroups.has(mId)) {
          customGroups.set(mId, { positions: [], normals: [] });
        }
        targetGroup = customGroups.get(mId)!;
      }

      // Front Triangles (CCW, normal +n)
      for (const pt of tris) {
        targetGroup.positions.push(pt.x - ox, pt.y - oy, pt.z - oz);
        targetGroup.normals.push(n.x, n.y, n.z);
      }

      // Back Triangles (Inverted winding CW, normal -n)
      if (!singleSided) {
        const isTransparent = false;
        const keepBackMaterial = isTransparent;
        const numTris = tris.length / 3;
        for (let t = 0; t < numTris; t++) {
          const p0 = tris[t * 3];
          const p1 = tris[t * 3 + 1];
          const p2 = tris[t * 3 + 2];
          if (keepBackMaterial) {
            // Transparent surfaces / glass do not show back material
            targetGroup.positions.push(p0.x - ox, p0.y - oy, p0.z - oz, p2.x - ox, p2.y - oy, p2.z - oz, p1.x - ox, p1.y - oy, p1.z - oz);
            targetGroup.normals.push(-n.x, -n.y, -n.z, -n.x, -n.y, -n.z, -n.x, -n.y, -n.z);
          } else {
            backPositions.push(p0.x - ox, p0.y - oy, p0.z - oz, p2.x - ox, p2.y - oy, p2.z - oz, p1.x - ox, p1.y - oy, p1.z - oz);
            backNormals.push(-n.x, -n.y, -n.z, -n.x, -n.y, -n.z, -n.x, -n.y, -n.z);
          }
        }
      }
    }

    const customKeys = Array.from(customGroups.keys());
    let totalFloats = defaultGroup.positions.length + (singleSided ? 0 : backPositions.length);
    for (let i = 0; i < customKeys.length; i++) {
      totalFloats += customGroups.get(customKeys[i])!.positions.length;
    }

    const allPositions = new Float32Array(totalFloats);
    const allNormals = new Float32Array(totalFloats);

    let currentVertexOffset = 0;
    let writeOffset = 0;

    const defaultCount = defaultGroup.positions.length / 3;
    if (defaultCount > 0 || customKeys.length === 0) {
      geo.addGroup(currentVertexOffset, defaultCount, 0); // Material index 0: Front Clay
      currentVertexOffset += defaultCount;
    }
    allPositions.set(defaultGroup.positions, writeOffset);
    allNormals.set(defaultGroup.normals, writeOffset);
    writeOffset += defaultGroup.positions.length;

    for (let i = 0; i < customKeys.length; i++) {
      const cGroup = customGroups.get(customKeys[i])!;
      const count = cGroup.positions.length / 3;
      geo.addGroup(currentVertexOffset, count, 2 + i); // Material index 2+i: Custom PBR Material
      currentVertexOffset += count;

      allPositions.set(cGroup.positions, writeOffset);
      allNormals.set(cGroup.normals, writeOffset);
      writeOffset += cGroup.positions.length;
    }

    if (!singleSided && backPositions.length > 0) {
      const backCount = backPositions.length / 3;
      geo.addGroup(currentVertexOffset, backCount, 1); // Material index 1: Back Pink
      allPositions.set(backPositions, writeOffset);
      allNormals.set(backNormals, writeOffset);
      writeOffset += backPositions.length;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(allPositions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(allNormals, 3));

    // Calculate procedural metric planar UVs
    const uvs = new Float32Array(allPositions.length / 3 * 2);
    for (let i = 0; i < allPositions.length / 3; i++) {
      uvs[i * 2] = allPositions[i * 3];
      uvs[i * 2 + 1] = allPositions[i * 3 + 1];
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

    geo.userData = {
      ...(geo.userData || {}),
      customMaterialIds: customKeys,
    };

    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * Generates edge lines for Technical Sketch rendering.
   * Includes boundary/crease edges and all inner hole loops.
   */
  toEdgeGeometry(renderOffset?: Vec3): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const positions: number[] = [];

    const ox = renderOffset ? renderOffset.x : 0;
    const oy = renderOffset ? renderOffset.y : 0;
    const oz = renderOffset ? renderOffset.z : 0;

    // 1. Boundary, Crease, and Partitioning Edges from topological Edge graph
    const faceNormals = new Map<string, Vec3>();
    const getNormal = (f: Face): Vec3 => {
      let n = faceNormals.get(f.id);
      if (!n) {
        n = f.normal;
        faceNormals.set(f.id, n);
      }
      return n;
    };

    for (const edge of this.edges.values()) {
      if (edge.hidden) continue;

      const f1 = edge.he1.face;
      const f2 = edge.he2?.face || edge.he1.twin?.face;

      // Both faces hidden -> suppress edge
      if (f1?.hidden && f2?.hidden) continue;

      // Open boundary (single incident face or one hidden face) -> feature outline
      if (!f1 || !f2 || f1.hidden || f2.hidden) {
        const a = edge.vA.position;
        const b = edge.vB.position;
        positions.push(a.x - ox, a.y - oy, a.z - oz, b.x - ox, b.y - oy, b.z - oz);
        continue;
      }

      // Material or opening boundary -> feature edge
      if (f1.materialId !== f2.materialId || f1.openingId !== f2.openingId) {
        const a = edge.vA.position;
        const b = edge.vB.position;
        positions.push(a.x - ox, a.y - oy, a.z - oz, b.x - ox, b.y - oy, b.z - oz);
        continue;
      }

      // Degenerate same face -> suppress
      if (f1.id === f2.id) continue;

      // Dihedral angle check: suppress coplanar diagonals (dot >= COS_CREASE_THRESHOLD)
      const n1 = getNormal(f1);
      const n2 = getNormal(f2);
      const dot = n1.dot(n2);
      if (dot < GeometryTolerance.COS_CREASE_THRESHOLD) {
        const a = edge.vA.position;
        const b = edge.vB.position;
        positions.push(a.x - ox, a.y - oy, a.z - oz, b.x - ox, b.y - oy, b.z - oz);
      }
    }

    // 2. All hole outline perimeters
    for (const face of this.faces.values()) {
      if (face.hidden) continue;
      for (const hole of face.holes) {
        const m = hole.length;
        for (let i = 0; i < m; i++) {
          const a = hole[i];
          const b = hole[(i + 1) % m];
          positions.push(a.x - ox, a.y - oy, a.z - oz, b.x - ox, b.y - oy, b.z - oz);
        }
      }
    }

    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }

  /**
   * Formal validator of topological and geometric invariants.
   * Certifies strict compliance with 2-manifold B-Rep laws (Half-Edge).
   */
  validate(options: TopologyValidationOptions = {}): TopologyValidationResult {
    const {
      checkManifold = true,
      checkEuler = true,
      checkGeometry = true,
      allowOpenBoundaries = false,
    } = options;

    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Vertex & Geometric Coordinate Verification
    for (const [vId, v] of this.vertices) {
      if (!v || !v.position) {
        errors.push(`Vertex ${vId} has no defined position.`);
        continue;
      }
      if (!Number.isFinite(v.position.x) || !Number.isFinite(v.position.y) || !Number.isFinite(v.position.z)) {
        errors.push(`Vertex ${vId} contains non-finite coordinates (NaN or Infinity): (${v.position.x}, ${v.position.y}, ${v.position.z}).`);
      }
    }

    // 2. Half-Edge Verification: Twin Symmetry, Next/Prev and Length
    let openHalfEdgesCount = 0;
    for (const [heId, he] of this.halfEdges) {
      if (!he.origin || !he.target) {
        errors.push(`Half-edge ${heId} has undefined origin or target.`);
        continue;
      }

      // Minimum length
      if (checkGeometry && he.length < GeometryTolerance.MIN_EDGE_LENGTH) {
        warnings.push(`Half-edge ${heId} has collapsed length (${he.length.toFixed(6)}m < ${GeometryTolerance.MIN_EDGE_LENGTH}m).`);
      }

      // Twin symmetry
      if (he.twin) {
        if (he.twin.twin !== he) {
          errors.push(`Twin asymmetry at ${heId}: he.twin.twin !== he.`);
        }
        const twinOriginMatches = he.twin.origin.position.equals(he.target.position, GeometryTolerance.COINCIDENT_POINT);
        const twinTargetMatches = he.twin.target.position.equals(he.origin.position, GeometryTolerance.COINCIDENT_POINT);
        if (!twinOriginMatches || !twinTargetMatches) {
          errors.push(`Geometric incoherence in twin of ${heId}: vertex orientation mismatch.`);
        }
      } else {
        openHalfEdgesCount++;
      }

      // Next / Prev cycle consistency
      if (he.next) {
        if (he.next.prev !== he) {
          errors.push(`Next/prev incoherence at ${heId}: he.next.prev !== he.`);
        }
        if (!he.next.origin.position.equals(he.target.position, GeometryTolerance.COINCIDENT_POINT)) {
          errors.push(`Cycle discontinuity: he.next.origin (${he.next.origin.id}) !== he.target (${he.target.id}) for ${heId}.`);
        }
      } else {
        errors.push(`Half-edge ${heId} has no defined 'next' pointer.`);
      }

      if (he.prev) {
        if (he.prev.next !== he) {
          errors.push(`Prev/next incoherence at ${heId}: he.prev.next !== he.`);
        }
      } else {
        errors.push(`Half-edge ${heId} has no defined 'prev' pointer.`);
      }
    }

    const isClosed = openHalfEdgesCount === 0 && this.halfEdges.size > 0;
    if (!isClosed && !allowOpenBoundaries && this.faces.size > 0) {
      warnings.push(`Mesh has ${openHalfEdgesCount} boundary half-edges without twin (open mesh / laminar surface).`);
    }

    // 3. Face Verification: Loop Closure, Orientation, Area, and Normals
    for (const [faceId, face] of this.faces) {
      if (!face.halfEdge) {
        errors.push(`Face ${faceId} has no root half-edge (halfEdge).`);
        continue;
      }

      // Loop traversal and infinite cycle detector
      const visitedHe = new Set<string>();
      let curr: HalfEdge | undefined = face.halfEdge;
      let steps = 0;
      const maxSteps = this.halfEdges.size + 1;
      let closedLoop = false;

      while (curr && steps < maxSteps) {
        if (visitedHe.has(curr.id)) {
          if (curr === face.halfEdge) {
            closedLoop = true;
          } else {
            errors.push(`Face ${faceId} loop contains an anomalous internal loop before closing at start.`);
          }
          break;
        }
        visitedHe.add(curr.id);
        steps++;
        if (curr.face && curr.face.id !== faceId) {
          errors.push(`Half-edge ${curr.id} belongs to face ${curr.face.id} but is in loop of ${faceId}.`);
        }
        curr = curr.next;
        if (curr === face.halfEdge) {
          closedLoop = true;
          break;
        }
      }

      if (!closedLoop) {
        errors.push(`Face ${faceId} loop does not close or exceeds half-edge limit (possible infinite loop).`);
      }

      if (visitedHe.size < 3) {
        errors.push(`Face ${faceId} has fewer than 3 vertices (${visitedHe.size}).`);
      }

      // Area and geometric normal
      if (checkGeometry) {
        const positions = face.getPositions();
        if (positions.length >= 3) {
          let ax = 0, ay = 0, az = 0;
          const n = positions.length;
          for (let i = 0; i < n; i++) {
            const c = positions[i];
            const next = positions[(i + 1) % n];
            ax += (c.y - next.y) * (c.z + next.z);
            ay += (c.z - next.z) * (c.x + next.x);
            az += (c.x - next.x) * (c.y + next.y);
          }
          const area = 0.5 * Math.sqrt(ax * ax + ay * ay + az * az);
          if (area < GeometryTolerance.MIN_FACE_AREA) {
            errors.push(`Face ${faceId} has zero or degenerate area (${area.toExponential(4)} < ${GeometryTolerance.MIN_FACE_AREA}).`);
          }

          const normal = face.normal;
          const normalLen = normal.length();
          if (!Number.isFinite(normalLen) || Math.abs(normalLen - 1.0) > 1e-3) {
            errors.push(`Face ${faceId} has non-unit or degenerate normal (length: ${normalLen}).`);
          }
        }
      }

      // Exhaustive hole verification (face.holes)
      if (face.holes && face.holes.length > 0) {
        for (let hIdx = 0; hIdx < face.holes.length; hIdx++) {
          const hole = face.holes[hIdx];
          if (!Array.isArray(hole) || hole.length < 3) {
            errors.push(`Hole ${hIdx} in face ${faceId} contains fewer than 3 vertices (${hole?.length ?? 0}).`);
            continue;
          }
          let hasNonFinite = false;
          for (const hp of hole) {
            if (!Number.isFinite(hp.x) || !Number.isFinite(hp.y) || !Number.isFinite(hp.z)) {
              hasNonFinite = true;
              break;
            }
          }
          if (hasNonFinite) {
            errors.push(`Hole ${hIdx} in face ${faceId} contains non-finite coordinates (NaN or Infinity).`);
          }
          if (checkGeometry) {
            const hArea = PolyMesh.computePolygonArea(hole);
            if (hArea < GeometryTolerance.MIN_FACE_AREA) {
              errors.push(`Hole ${hIdx} in face ${faceId} has zero or collapsed area (${hArea.toExponential(4)} < ${GeometryTolerance.MIN_FACE_AREA}).`);
            }
            const planeDist = face.plane.distanceToPoint(hole[0]);
            if (Math.abs(planeDist) > GeometryTolerance.POINT_ON_PLANE * 5) {
              warnings.push(`Hole ${hIdx} in face ${faceId} deviates from host plane by ${Math.abs(planeDist).toFixed(6)}m.`);
            }
          }
        }
      }
    }

    // 4. Edge 2-Manifold Integrity
    if (checkManifold) {
      const edgeDirectionMap = new Map<string, HalfEdge[]>();
      for (const he of this.halfEdges.values()) {
        const keyAB = `${he.origin.position.x.toFixed(5)},${he.origin.position.y.toFixed(5)},${he.origin.position.z.toFixed(5)}->${he.target.position.x.toFixed(5)},${he.target.position.y.toFixed(5)},${he.target.position.z.toFixed(5)}`;
        const list = edgeDirectionMap.get(keyAB) || [];
        list.push(he);
        edgeDirectionMap.set(keyAB, list);
      }

      for (const [dirKey, heList] of edgeDirectionMap) {
        if (heList.length > 1) {
          errors.push(`Manifold violation: ${heList.length} half-edges share identical direction ${dirKey}.`);
        }
      }

      const undirectedEdgeMap = new Map<string, HalfEdge[]>();
      for (const he of this.halfEdges.values()) {
        const p1 = `${he.origin.position.x.toFixed(5)},${he.origin.position.y.toFixed(5)},${he.origin.position.z.toFixed(5)}`;
        const p2 = `${he.target.position.x.toFixed(5)},${he.target.position.y.toFixed(5)},${he.target.position.z.toFixed(5)}`;
        const key = p1 < p2 ? `${p1}<->${p2}` : `${p2}<->${p1}`;
        const list = undirectedEdgeMap.get(key) || [];
        list.push(he);
        undirectedEdgeMap.set(key, list);
      }

      for (const [edgeKey, list] of undirectedEdgeMap) {
        if (list.length > 2) {
          errors.push(`Non-manifold edge: ${list.length} half-edges converge at ${edgeKey} (maximum permitted: 2).`);
        }
      }
    }

    // 5. Euler Characteristic for Closed Solids
    let eulerCharacteristic: number | undefined = undefined;
    let genus: number | undefined = undefined;

    if (checkEuler && isClosed && this.faces.size > 0) {
      const V = this.vertices.size;
      const F = this.faces.size;
      const E = this.edges.size > 0 ? this.edges.size : Math.round(this.halfEdges.size / 2);

      eulerCharacteristic = V - E + F;
      genus = Math.round((2 - eulerCharacteristic) / 2);

      if (eulerCharacteristic > 2) {
        warnings.push(`Unexpected Euler characteristic: χ = ${eulerCharacteristic} > 2 for closed solid.`);
      }
      if (genus < 0) {
        warnings.push(`Negative topological genus computed: g = ${genus}.`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      eulerCharacteristic,
      genus,
      isClosed,
    };
  }

  /**
   * Computes the signed volume of the PolyMesh solid using divergence theorem (tetrahedral summation from origin).
   * Positive for CCW outward-oriented closed solids.
   */
  public computeSignedVolume(): number {
    let totalVol = 0;
    for (const face of this.faces.values()) {
      const pts = face.getPositions();
      if (pts.length < 3) continue;
      const tris = face.hasHoles()
        ? PolygonClipping.triangulateWithHoles(pts, face.holes, face.normal)
        : PolygonClipping.triangulate(pts, face.normal);

      for (let i = 0; i < tris.length; i += 3) {
        const v0 = tris[i];
        const v1 = tris[i + 1];
        const v2 = tris[i + 2];
        const cross = v1.cross(v2);
        totalVol += v0.dot(cross);
      }
    }
    return totalVol / 6;
  }

  /**
   * Clips the PolyMesh solid against an infinite 3D plane (Half-Space clipping).
   * 
   * @param plane - Analytical clipping plane.
   * @param keepBelow - If true, retains the half-space where plane.distanceToPoint(p) <= tol (opposite to normal).
   *                    If false, retains where plane.distanceToPoint(p) >= -tol (in direction of normal).
   * @returns true if the mesh was modified and has remaining geometry; false if completely discarded.
   */
  public clipByPlane(plane: Plane, keepBelow: boolean = true): boolean {
    const cutNormal = keepBelow ? plane.normal.normalize() : plane.normal.negate().normalize();
    const origin = plane.origin;
    const tol = GeometryTolerance.COINCIDENT_VERTEX;

    const dist = (p: Vec3): number => (p.sub(origin)).dot(cutNormal);

    const cutSegments: { a: Vec3; b: Vec3 }[] = [];
    const keptFaces: {
      positions: Vec3[];
      normal: Vec3;
      holes?: Vec3[][];
      materialId?: string | null;
      openingId?: string | null;
    }[] = [];

    for (const face of this.faces.values()) {
      const pts = face.getPositions();
      const n = pts.length;
      if (n < 3) continue;

      const d = pts.map((p) => dist(p));
      const allKept = d.every((val) => val <= tol);
      const allDiscarded = d.every((val) => val > tol);
      const isCoplanar = d.every((val) => Math.abs(val) <= tol);

      if (isCoplanar) {
        // Requicha-Voelcker rule for coplanar faces:
        // When clipping with halfspace { x : (x - origin) . cutNormal <= 0 },
        // the retained solid lies on the negative side of the cut plane (dist <= 0).
        // The boundary face of the retained solid on this cutting plane must have its
        // exterior normal pointing OUTWARDS from the retained solid, i.e. in the direction of +cutNormal.
        if (face.normal.dot(cutNormal) > tol) {
          keptFaces.push({
            positions: pts,
            normal: face.normal,
            holes: face.holes && face.holes.length > 0 ? face.holes.map((h) => [...h]) : undefined,
            materialId: face.materialId,
            openingId: face.openingId,
          });
        }
        continue;
      }

      if (allDiscarded) {
        continue;
      }

      if (allKept) {
        keptFaces.push({
          positions: pts,
          normal: face.normal,
          holes: face.holes && face.holes.length > 0 ? face.holes.map((h) => [...h]) : undefined,
          materialId: face.materialId,
          openingId: face.openingId,
        });
        continue;
      }

      // Face cut by plane
      if (face.hasHoles()) {
        const faceGraph = new PlanarGraph(face.plane.origin, face.normal);
        faceGraph.addPolygon3D(pts);
        for (const h of face.holes) {
          faceGraph.addPolygon3D(h);
        }

        const chordPts: Vec3[] = [];
        for (let i = 0; i < n; i++) {
          const p1 = pts[i];
          const p2 = pts[(i + 1) % n];
          const d1 = d[i];
          const d2 = d[(i + 1) % n];
          if ((d1 > tol && d2 <= tol) || (d1 <= tol && d2 > tol)) {
            const t = d1 / (d1 - d2);
            const intPt = plane.projectPoint(p1.add((p2.sub(p1)).scale(t)));
            chordPts.push(intPt);
          }
        }

        // Also evaluate plane crossings with hole loops
        for (const h of face.holes) {
          const hn = h.length;
          for (let i = 0; i < hn; i++) {
            const hp1 = h[i];
            const hp2 = h[(i + 1) % hn];
            const hd1 = dist(hp1);
            const hd2 = dist(hp2);
            if ((hd1 > tol && hd2 <= tol) || (hd1 <= tol && hd2 > tol)) {
              const t = hd1 / (hd1 - hd2);
              const intPt = plane.projectPoint(hp1.add((hp2.sub(hp1)).scale(t)));
              chordPts.push(intPt);
            }
          }
        }

        if (chordPts.length >= 2) {
          // Sort points along intersection line
          const lineDir = face.normal.cross(cutNormal).normalize();
          const refPt = chordPts[0];
          chordPts.sort((a, b) => a.sub(refPt).dot(lineDir) - b.sub(refPt).dot(lineDir));
          for (let k = 0; k < chordPts.length - 1; k += 2) {
            faceGraph.addSegment3D(chordPts[k], chordPts[k + 1]);
          }
        }

        const extracted = faceGraph.extractFaces3D();
        for (const ef of extracted) {
          const center = ef.positions.reduce((acc, p) => acc.add(p), Vec3.ZERO).scale(1 / ef.positions.length);
          if (dist(center) <= tol) {
            keptFaces.push({
              positions: ef.positions,
              normal: face.normal,
              holes: ef.holes && ef.holes.length > 0 ? ef.holes : undefined,
              materialId: face.materialId,
              openingId: face.openingId,
            });

            // Record cutting edges on plane for capping
            const efN = ef.positions.length;
            for (let i = 0; i < efN; i++) {
              const pA = ef.positions[i];
              const pB = ef.positions[(i + 1) % efN];
              if (Math.abs(dist(pA)) <= tol && Math.abs(dist(pB)) <= tol && pA.distanceTo(pB) > tol) {
                // Direction on cap: reverse of face (pB -> pA)
                cutSegments.push({ a: pB, b: pA });
              }
            }
          }
        }
      } else {
        // Exact 3D Sutherland-Hodgman
        const newPoly: Vec3[] = [];
        let exitPt: Vec3 | null = null;
        let entryPt: Vec3 | null = null;

        for (let i = 0; i < n; i++) {
          const curr = pts[i];
          const next = pts[(i + 1) % n];
          const dCurr = d[i];
          const dNext = d[(i + 1) % n];

          const currIn = dCurr <= tol;
          const nextIn = dNext <= tol;

          if (currIn && nextIn) {
            newPoly.push(next);
          } else if (currIn && !nextIn) {
            const t = dCurr / (dCurr - dNext);
            const onPlane = plane.projectPoint(curr.add((next.sub(curr)).scale(t)));
            newPoly.push(onPlane);
            exitPt = onPlane;
          } else if (!currIn && nextIn) {
            const t = dCurr / (dCurr - dNext);
            const onPlane = plane.projectPoint(curr.add((next.sub(curr)).scale(t)));
            newPoly.push(onPlane);
            newPoly.push(next);
            entryPt = onPlane;
          }
        }

        if (newPoly.length >= 3) {
          const dedup: Vec3[] = [];
          for (let i = 0; i < newPoly.length; i++) {
            const p1 = newPoly[i];
            const p2 = newPoly[(i + 1) % newPoly.length];
            if (p1.distanceTo(p2) > tol) {
              dedup.push(p1);
            }
          }
          if (dedup.length >= 3) {
            keptFaces.push({
              positions: dedup,
              normal: face.normal,
              materialId: face.materialId,
              openingId: face.openingId,
            });
          }
        }

        if (exitPt && entryPt && exitPt.distanceTo(entryPt) > tol) {
          // Direction for cap: entryPt -> exitPt
          cutSegments.push({ a: entryPt, b: exitPt });
        }
      }
    }

    if (keptFaces.length === 0) {
      return false;
    }

    // Capping on the cutting plane
    if (cutSegments.length > 0) {
      const capNormal = cutNormal; // Points outwards from retained solid
      const basis = PolygonClipping.getLocalBasis(origin, capNormal);

      interface DirSeg { start: Vec3; end: Vec3 }
      const remaining: DirSeg[] = cutSegments.map((s) => ({ start: s.a, end: s.b }));
      const loops: Vec3[][] = [];

      while (remaining.length > 0) {
        const first = remaining.shift()!;
        const loop: Vec3[] = [first.start, first.end];

        let extended = true;
        while (extended && remaining.length > 0) {
          extended = false;
          const lastPt = loop[loop.length - 1];

          if (lastPt.distanceTo(loop[0]) <= tol && loop.length > 2) {
            break;
          }

          let foundIdx = -1;
          for (let i = 0; i < remaining.length; i++) {
            if (remaining[i].start.distanceTo(lastPt) <= tol) {
              foundIdx = i;
              break;
            }
          }

          if (foundIdx !== -1) {
            loop.push(remaining[foundIdx].end);
            remaining.splice(foundIdx, 1);
            extended = true;
          } else {
            let bestIdx = -1;
            let bestDist = Infinity;
            for (let i = 0; i < remaining.length; i++) {
              const d = remaining[i].start.distanceTo(lastPt);
              if (d < bestDist && d < tol * 10) {
                bestDist = d;
                bestIdx = i;
              }
            }
            if (bestIdx !== -1) {
              loop.push(remaining[bestIdx].end);
              remaining.splice(bestIdx, 1);
              extended = true;
            }
          }
        }

        if (loop.length > 2 && loop[loop.length - 1].distanceTo(loop[0]) <= tol) {
          loop.pop();
        }

        if (loop.length >= 3) {
          loops.push(loop);
        }
      }

      const outerLoops: { pts3D: Vec3[]; poly2D: Vec2D[]; area: number; holes: Vec3[][] }[] = [];
      const holeLoops: { pts3D: Vec3[]; poly2D: Vec2D[]; area: number }[] = [];

      for (const loop of loops) {
        const poly2D = loop.map((p) => PolygonClipping.projectTo2D(p, basis));
        const area = PolygonClipping.signedArea2D(poly2D);
        if (Math.abs(area) <= GeometryTolerance.MIN_FACE_AREA) continue;

        if (area > 0) {
          outerLoops.push({ pts3D: loop, poly2D, area, holes: [] });
        } else {
          holeLoops.push({ pts3D: loop, poly2D, area: Math.abs(area) });
        }
      }

      for (const hole of holeLoops) {
        let bestOuter: (typeof outerLoops)[0] | null = null;
        let minOuterArea = Infinity;

        for (const outer of outerLoops) {
          if (outer.area > hole.area) {
            if (PolygonClipping.pointInPolygon2D(hole.poly2D[0], outer.poly2D)) {
              if (outer.area < minOuterArea) {
                minOuterArea = outer.area;
                bestOuter = outer;
              }
            }
          }
        }

        if (bestOuter) {
          bestOuter.holes.push(hole.pts3D);
        } else {
          outerLoops.push({
            pts3D: [...hole.pts3D].reverse(),
            poly2D: [...hole.poly2D].reverse(),
            area: hole.area,
            holes: [],
          });
        }
      }

      for (const outer of outerLoops) {
        keptFaces.push({
          positions: outer.pts3D,
          normal: capNormal,
          holes: outer.holes.length > 0 ? outer.holes : undefined,
        });
      }
    }

    // Rebuild topology
    this.faces.clear();
    this.vertices.clear();
    this.halfEdges.clear();
    this.edges.clear();

    for (const kf of keptFaces) {
      const f = this.addFace(kf.positions, kf.normal, kf.holes);
      if (kf.materialId) {
        f.materialId = kf.materialId;
      }
      if (kf.openingId) {
        f.openingId = kf.openingId;
      }
    }

    this.rebuildTopology();
    return true;
  }
}


