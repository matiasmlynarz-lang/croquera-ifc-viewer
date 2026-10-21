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
import { rotatePointAroundAxis, mirrorPointAcrossPlane } from '../math/MathUtils';
import { Vertex, Edge, Face, HalfEdge } from './HalfEdge';
import { PolygonClipping, Vec2D } from './PolygonClipping';
import { PlanarGraph } from './PlanarGraph';

export interface PolyMeshEdgeData {
  a: Vec3;
  b: Vec3;
  hidden?: boolean;
}

export interface PolyMeshFaceData {
  id?: string;
  faceId?: string;
  polyMeshId?: string;
  vertices: Vec3[];
  holes?: Vec3[][];
  normal: Vec3;
  plane: any;
  edges: PolyMeshEdgeData[];
  hidden?: boolean;
  openingId?: string | null;
  materialId?: string;
}

export interface PolyMeshSceneData {
  id: string;
  type: 'GEOMETRY_ENTITY';
  name?: string;
  parentId?: string | null;
  hostFaceId?: string | null;
  storeyId?: string | null;
  matrixId?: string | null;
  faces: PolyMeshFaceData[];
  vertices: Vec3[];
  edges: PolyMeshEdgeData[];
  polyMesh?: any;
  threeGroup?: any;
  renderProxy?: any;
  inferenceData?: any;
  hidden?: boolean;
}

export interface ExtrudeResult {
  topFace?: Face;
  sideFaces: Face[];
  isOpening?: boolean;
}

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

    // Consultar celda y 26 vecinas adyacentes en O(1) con hash entero 32-bit
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

  /**
   * Reindexa todos los vértices en el spatial grid sin alterar la topología de semiaristas.
   * Complejidad O(V) estricta conforme a Norma 7 (TC-GRID-REINDEX-TRANSLATE, TC-GRID-REINDEX-TRANSLATE-VERTICES).
   */
  private reindexSpatialGrid(): void {
    this.vertexSpatialGrid.clear();
    const cellSize = GeometryTolerance.SPATIAL_GRID_CELL_SIZE;
    for (const v of this.vertices.values()) {
      const gx = Math.floor(v.position.x / cellSize);
      const gy = Math.floor(v.position.y / cellSize);
      const gz = Math.floor(v.position.z / cellSize);
      const centerKey = PolyMesh.getGridHash(gx, gy, gz);
      let cell = this.vertexSpatialGrid.get(centerKey);
      if (!cell) {
        cell = [];
        this.vertexSpatialGrid.set(centerKey, cell);
      }
      cell.push(v);
    }
  }

  removeFace(faceId: string): boolean {
    const face = this.faces.get(faceId);
    if (!face) return false;

    const faceVerts = face.getVertices();
    const halfEdges = face.getHalfEdges();

    // Registrar qué vértices están conectados a twins supervivientes de caras adyacentes
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

    // Para los vértices de la cara, verificar si quedaron huérfanos o si continúan en uso
    for (const v of faceVerts) {
      if (survivingVerts.has(v)) {
        // Asegurar que el vértice superviviente tenga un halfEdge válido asignado
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

      // Comprobar si v sigue referenciado en algún otro half-edge no emparejado de la malla
      let inUse = false;
      for (const uhe of this.unmatchedHalfEdges.values()) {
        if (uhe.origin === v || uhe.target === v) {
          inUse = true;
          if (uhe.origin === v) v.halfEdge = uhe;
          break;
        }
      }

      if (!inUse) {
        // Vértice completamente huérfano: eliminar de vertices y del Spatial Hash Grid
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
   * Simplifica vértices colineales redundantes en un bucle cerrado (perímetro o agujero).
   * Si tres vértices consecutivos A, B, C yacen sobre la misma línea recta con el mismo sentido,
   * el vértice intermedio B se elimina para obtener la frontera geométrica mínima.
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

      // Si los vectores son paralelos en el mismo sentido (dot > COLLINEAR_DOT_TOLERANCE y cross ~ 0)
      if (crossLen < GeometryTolerance.COPLANAR_NORMAL && dot > GeometryTolerance.COLLINEAR_DOT_TOLERANCE) {
        // Vértice colineal redundante, omitir
        continue;
      }
      result.push(curr);
    }
    return result.length >= 3 ? result : loop;
  }

  /**
   * Disuelve una arista interna que divide dos caras estrictamente coplanares.
   * Fusiona las dos caras en una sola cara continua y simplifica vértices colineales.
   * Si la arista no divide dos caras coplanares, retorna false sin alterar la malla.
   */
  public dissolveEdge(edgeA: Vec3, edgeB: Vec3): boolean {
    if (edgeA.distanceTo(edgeB) < GeometryTolerance.MIN_EDGE_LENGTH) {
      return false;
    }

    const isTargetSegment = (p1: Vec3, p2: Vec3): boolean => {
      return (
        (p1.distanceTo(edgeA) < GeometryTolerance.COINCIDENT_POINT && p2.distanceTo(edgeB) < GeometryTolerance.COINCIDENT_POINT) ||
        (p1.distanceTo(edgeB) < GeometryTolerance.COINCIDENT_POINT && p2.distanceTo(edgeA) < GeometryTolerance.COINCIDENT_POINT)
      );
    };

    // 1. Identificar todas las caras incidentes a la arista (edgeA, edgeB)
    const incidentFaces: Face[] = [];
    for (const face of this.faces.values()) {
      const verts = face.getPositions();
      const n = verts.length;
      let hasEdge = false;
      for (let i = 0; i < n; i++) {
        if (isTargetSegment(verts[i], verts[(i + 1) % n])) {
          hasEdge = true;
          break;
        }
      }
      if (!hasEdge && face.holes) {
        for (const hole of face.holes) {
          const hn = hole.length;
          for (let i = 0; i < hn; i++) {
            if (isTargetSegment(hole[i], hole[(i + 1) % hn])) {
              hasEdge = true;
              break;
            }
          }
          if (hasEdge) break;
        }
      }
      if (hasEdge) {
        incidentFaces.push(face);
      }
    }

    // Para poder disolver una arista coplanar debe haber exactamente 2 caras que la compartan
    if (incidentFaces.length !== 2) {
      return false;
    }

    const face1 = incidentFaces[0];
    const face2 = incidentFaces[1];

    // 2. Verificar coplanaridad estricta entre face1 y face2 (Regla 6: tolerancias centrales)
    const dotNormals = face1.normal.dot(face2.normal);
    if (Math.abs(dotNormals - 1) > GeometryTolerance.COPLANAR_NORMAL) {
      return false; // Caras angulares o en diedro no coplanar
    }

    const distToPlane = Math.abs(face1.plane.distanceToPoint(face2.plane.origin));
    if (distToPlane > GeometryTolerance.POINT_ON_PLANE) {
      return false; // Planos paralelos con desfase de altura
    }

    // 3. Reconstruir la geometría unificada en 2D mediante PlanarGraph omitiendo la arista a disolver en una sola pasada por lotes
    const graph = new PlanarGraph(face1.plane.origin, face1.normal);
    const segmentsToBatch: { a: Vec3; b: Vec3 }[] = [];

    // Añadir segmentos de face1 omitiendo la arista divisoria
    const verts1 = face1.getPositions();
    for (let i = 0; i < verts1.length; i++) {
      const p1 = verts1[i];
      const p2 = verts1[(i + 1) % verts1.length];
      if (!isTargetSegment(p1, p2)) {
        segmentsToBatch.push({ a: p1, b: p2 });
      }
    }
    if (face1.holes) {
      for (const hole of face1.holes) {
        for (let i = 0; i < hole.length; i++) {
          const p1 = hole[i];
          const p2 = hole[(i + 1) % hole.length];
          if (!isTargetSegment(p1, p2)) {
            segmentsToBatch.push({ a: p1, b: p2 });
          }
        }
      }
    }

    // Añadir segmentos de face2 omitiendo la arista divisoria
    const verts2 = face2.getPositions();
    for (let i = 0; i < verts2.length; i++) {
      const p1 = verts2[i];
      const p2 = verts2[(i + 1) % verts2.length];
      if (!isTargetSegment(p1, p2)) {
        segmentsToBatch.push({ a: p1, b: p2 });
      }
    }
    if (face2.holes) {
      for (const hole of face2.holes) {
        for (let i = 0; i < hole.length; i++) {
          const p1 = hole[i];
          const p2 = hole[(i + 1) % hole.length];
          if (!isTargetSegment(p1, p2)) {
            segmentsToBatch.push({ a: p1, b: p2 });
          }
        }
      }
    }

    graph.addSegments3D(segmentsToBatch);

    // 4. Extraer las caras 3D resultantes
    const extracted = graph.extractFaces3D();
    if (extracted.length === 0) {
      return false;
    }

    // 5. Sustituir las dos caras previas por la(s) cara(s) fusionada(s)
    this.removeFace(face1.id);
    this.removeFace(face2.id);

    for (const f of extracted) {
      const simplifiedOuter = PolyMesh.simplifyCollinearLoop(f.positions);
      const simplifiedHoles = f.holes.map((h) => PolyMesh.simplifyCollinearLoop(h));
      this.addFace(simplifiedOuter, face1.normal, simplifiedHoles);
    }

    this.rebuildTopology();
    return true;
  }

  /**
   * Particiona un conjunto de caras coplanares en componentes conexos por arista compartida (Normas 6, 7, 11).
   * Dos caras son adyacentes si y sólo si comparten una semi-arista interna en sentidos opuestos: (u -> v) y (v -> u).
   * Complejidad acotada O(E) = O(N) satisfaciendo Norma 7.
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
   * - Norma 6: Uses GeometryTolerance.IMPORTED_COPLANAR_NORMAL and POINT_ON_PLANE.
   * - Norma 7 & Norma 24: O(T) linear complexity via directed half-edge cancellation (verified by TC-COAL-PERF).
   * - Norma 11: Handles degenerate cases, multi-island disjoint boundaries, and hole containment via 2D point-in-polygon.
   * - Norma 13: Defensive fallback preserves original faces with structured warning if a bucket has broken topology.
   * - Norma 17: Preserves materialId and openingId by segregating coplanar buckets.
   */
  public coalesceCoplanarFaces(): void {
    if (this.faces.size < 2) return;

    // 1. Group coplanar faces into buckets using normal, plane distance, materialId, and openingId (Normas 6, 7, 17, 22)
    interface CoplanarBucket {
      normal: Vec3;
      planeD: number;
      refPoint: Vec3;
      materialId?: string | null;
      openingId?: string | null;
      faces: Face[];
    }

    // Centroide de referencia local para invarianza por traslación (Normas 6, 7 y 22)
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
                  // Verificación dual: distancia escalar relativa y distancia punto-plano directa (Normas 6, 22)
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

      // 2.a Deduplicar caras idénticas que compartan los mismos vértices
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

      // 2.b Particionar en componentes conexos por arista interna compartida (Normas 6, 7, 11)
      const components = PolyMesh.getEdgeConnectedComponents(uniqueFaces);

      for (const compFaces of components) {
        if (compFaces.length < 2) continue;

        // Cancel internal directed half-edges in O(E) (Norma 7)
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

        // Assign each inner hole to its containing outer loop via 2D Point-in-Polygon (Norma 11)
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
   * Translate all vertices of the PolyMesh by a delta vector.
   */
  translate(delta: Vec3): void {
    if (delta.isZero()) return;
    for (const v of this.vertices.values()) {
      v.position = v.position.add(delta);
    }
    // Also update hole coordinates
    for (const face of this.faces.values()) {
      face.holes = face.holes.map((hole) => hole.map((p) => p.add(delta)));
    }
    // Reindexación O(V) de celdas espaciales - Norma 6, 7 y 24 (TC-GRID-REINDEX-TRANSLATE)
    this.reindexSpatialGrid();
    this.bumpVersion();
  }

  /**
   * Translate specific vertices by delta vector.
   * Internal deduplication guarantees that shared vertices are translated exactly once,
   * preventing mesh tearing or duplicated displacement regardless of caller inputs.
   */
  translateVertices(vertexPositions: Vec3[], delta: Vec3): void {
    if (delta.isZero() || vertexPositions.length === 0) return;

    // 1. Deduplicate input target positions
    const uniqueTargets: Vec3[] = [];
    for (const pos of vertexPositions) {
      if (!uniqueTargets.some((up) => up.distanceTo(pos) < GeometryTolerance.COINCIDENT_POINT)) {
        uniqueTargets.push(pos);
      }
    }

    // 2. Identify unique vertices to displace
    const matchedVertices = new Set<Vertex>();
    for (const targetPos of uniqueTargets) {
      for (const v of this.vertices.values()) {
        if (v.position.distanceTo(targetPos) < GeometryTolerance.COINCIDENT_POINT) {
          matchedVertices.add(v);
        }
      }
    }

    // 3. Apply displacement exactly once per matched vertex
    for (const v of matchedVertices) {
      v.position = v.position.add(delta);
    }

    // Sincronización topológica de bucles interiores (face.holes) - Norma 6, 7 y 24 (TC-HOLE-SYNC-TRANSLATE)
    let holesDisplaced = false;
    for (const face of this.faces.values()) {
      if (!face.holes || face.holes.length === 0) continue;
      for (let h = 0; h < face.holes.length; h++) {
        const hole = face.holes[h];
        for (let i = 0; i < hole.length; i++) {
          const hp = hole[i];
          if (uniqueTargets.some((tp) => tp.distanceTo(hp) < GeometryTolerance.COINCIDENT_POINT)) {
            hole[i] = hp.add(delta);
            holesDisplaced = true;
          }
        }
      }
    }

    if (matchedVertices.size > 0 || holesDisplaced) {
      // Reindexación O(V) de celdas espaciales - Norma 6, 7 y 24 (TC-GRID-REINDEX-TRANSLATE-VERTICES)
      if (matchedVertices.size > 0) {
        this.reindexSpatialGrid();
      }
      this.bumpVersion();
    }
  }

  /**
   * Scale all vertices and holes of the PolyMesh around an origin point.
   */
  scale(factor: number | Vec3, origin: Vec3 = Vec3.ZERO): void {
    const scaleVec = typeof factor === 'number' ? new Vec3(factor, factor, factor) : factor;
    for (const v of this.vertices.values()) {
      const rel = v.position.sub(origin);
      v.position = origin.add(new Vec3(rel.x * scaleVec.x, rel.y * scaleVec.y, rel.z * scaleVec.z));
    }
    for (const face of this.faces.values()) {
      face.holes = face.holes.map((hole) =>
        hole.map((p) => {
          const rel = p.sub(origin);
          return origin.add(new Vec3(rel.x * scaleVec.x, rel.y * scaleVec.y, rel.z * scaleVec.z));
        })
      );
    }
    this.rebuildTopology();
  }

  /**
   * Scale specific vertices of the PolyMesh around an origin point.
   */
  scaleVertices(vertexPositions: Vec3[], factor: number | Vec3, origin: Vec3): void {
    if (vertexPositions.length === 0) return;
    const scaleVec = typeof factor === 'number' ? new Vec3(factor, factor, factor) : factor;

    // Deduplicate input target positions
    const uniqueTargets: Vec3[] = [];
    for (const pos of vertexPositions) {
      if (!uniqueTargets.some((up) => up.distanceTo(pos) < GeometryTolerance.COINCIDENT_POINT)) {
        uniqueTargets.push(pos);
      }
    }

    const matchedVertices = new Set<Vertex>();
    for (const targetPos of uniqueTargets) {
      for (const v of this.vertices.values()) {
        if (v.position.distanceTo(targetPos) < GeometryTolerance.COINCIDENT_POINT) {
          matchedVertices.add(v);
        }
      }
    }

    for (const v of matchedVertices) {
      const rel = v.position.sub(origin);
      v.position = origin.add(new Vec3(rel.x * scaleVec.x, rel.y * scaleVec.y, rel.z * scaleVec.z));
    }

    // Sincronización topológica de bucles interiores (face.holes) - Norma 6, 7 y 24 (TC-HOLE-SYNC-SCALE)
    for (const face of this.faces.values()) {
      if (!face.holes || face.holes.length === 0) continue;
      for (let h = 0; h < face.holes.length; h++) {
        const hole = face.holes[h];
        for (let i = 0; i < hole.length; i++) {
          const hp = hole[i];
          if (uniqueTargets.some((tp) => tp.distanceTo(hp) < GeometryTolerance.COINCIDENT_POINT)) {
            const rel = hp.sub(origin);
            hole[i] = origin.add(new Vec3(rel.x * scaleVec.x, rel.y * scaleVec.y, rel.z * scaleVec.z));
          }
        }
      }
    }

    this.rebuildTopology();
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
   * Rotate all vertices and holes of the PolyMesh around an axis line (axisPoint, axisDir) by angleRad radians.
   */
  rotate(axisPoint: Vec3, axisDir: Vec3, angleRad: number): void {
    if (Math.abs(angleRad) < GeometryTolerance.MATH_EPSILON) return;
    const normAxis = axisDir.normalize();
    for (const v of this.vertices.values()) {
      v.position = rotatePointAroundAxis(v.position, axisPoint, normAxis, angleRad);
    }
    for (const face of this.faces.values()) {
      face.holes = face.holes.map((hole) =>
        hole.map((p) => rotatePointAroundAxis(p, axisPoint, normAxis, angleRad))
      );
    }
    this.rebuildTopology();
  }

  /**
   * Rotate specific vertices of the PolyMesh around an axis line (axisPoint, axisDir) by angleRad radians.
   */
  rotateVertices(vertexPositions: Vec3[], axisPoint: Vec3, axisDir: Vec3, angleRad: number): void {
    if (Math.abs(angleRad) < GeometryTolerance.MATH_EPSILON || vertexPositions.length === 0) return;
    const normAxis = axisDir.normalize();

    // 1. Deduplicate input target positions
    const uniqueTargets: Vec3[] = [];
    for (const pos of vertexPositions) {
      if (!uniqueTargets.some((up) => up.distanceTo(pos) < GeometryTolerance.COINCIDENT_POINT)) {
        uniqueTargets.push(pos);
      }
    }

    // 2. Identify unique vertices to rotate
    const matchedVertices = new Set<Vertex>();
    for (const targetPos of uniqueTargets) {
      for (const v of this.vertices.values()) {
        if (v.position.distanceTo(targetPos) < GeometryTolerance.COINCIDENT_POINT) {
          matchedVertices.add(v);
        }
      }
    }

    // 3. Apply rotation exactly once per matched vertex
    for (const v of matchedVertices) {
      v.position = rotatePointAroundAxis(v.position, axisPoint, normAxis, angleRad);
    }

    // Sincronización topológica de bucles interiores (face.holes) - Norma 6, 7 y 24 (TC-HOLE-SYNC-ROTATE)
    for (const face of this.faces.values()) {
      if (!face.holes || face.holes.length === 0) continue;
      for (let h = 0; h < face.holes.length; h++) {
        const hole = face.holes[h];
        for (let i = 0; i < hole.length; i++) {
          const hp = hole[i];
          if (uniqueTargets.some((tp) => tp.distanceTo(hp) < GeometryTolerance.COINCIDENT_POINT)) {
            hole[i] = rotatePointAroundAxis(hp, axisPoint, normAxis, angleRad);
          }
        }
      }
    }

    this.rebuildTopology();
  }

  /**
   * Mirror all vertices, faces, and holes across a plane defined by (planePoint, planeNormal).
   * Inverts face vertex winding order so normals continue pointing outwards (preserves B-Rep manifoldness).
   */
  mirror(planePoint: Vec3, planeNormal: Vec3): void {
    const norm = planeNormal.normalize();

    // 1. Reflect all vertex positions
    for (const v of this.vertices.values()) {
      v.position = mirrorPointAcrossPlane(v.position, planePoint, norm);
    }

    // 2. Reflect all inner cutout holes
    for (const face of this.faces.values()) {
      face.holes = face.holes.map((hole) =>
        hole.map((p) => mirrorPointAcrossPlane(p, planePoint, norm))
      );
    }

    // 3. Reverse face winding of all faces because reflection inverts 3D chirality (det = -1)
    const faceIds = Array.from(this.faces.keys());
    for (const faceId of faceIds) {
      this.reverseFace(faceId);
    }

    this.rebuildTopology();
  }

  /**
   * Mirror specific vertices of the PolyMesh across a plane defined by (planePoint, planeNormal).
   */
  mirrorVertices(vertexPositions: Vec3[], planePoint: Vec3, planeNormal: Vec3): void {
    if (vertexPositions.length === 0) return;
    const norm = planeNormal.normalize();

    // 1. Deduplicate input target positions
    const uniqueTargets: Vec3[] = [];
    for (const pos of vertexPositions) {
      if (!uniqueTargets.some((up) => up.distanceTo(pos) < GeometryTolerance.COINCIDENT_POINT)) {
        uniqueTargets.push(pos);
      }
    }

    // 2. Identify unique vertices to mirror
    const matchedVertices = new Set<Vertex>();
    for (const targetPos of uniqueTargets) {
      for (const v of this.vertices.values()) {
        if (v.position.distanceTo(targetPos) < GeometryTolerance.COINCIDENT_POINT) {
          matchedVertices.add(v);
        }
      }
    }

    // 3. Apply mirror across plane
    for (const v of matchedVertices) {
      v.position = mirrorPointAcrossPlane(v.position, planePoint, norm);
    }

    // Sincronización topológica de bucles interiores (face.holes) - Norma 6, 7 y 24 (TC-HOLE-SYNC-MIRROR)
    for (const face of this.faces.values()) {
      if (!face.holes || face.holes.length === 0) continue;
      for (let h = 0; h < face.holes.length; h++) {
        const hole = face.holes[h];
        for (let i = 0; i < hole.length; i++) {
          const hp = hole[i];
          if (uniqueTargets.some((tp) => tp.distanceTo(hp) < GeometryTolerance.COINCIDENT_POINT)) {
            hole[i] = mirrorPointAcrossPlane(hp, planePoint, norm);
          }
        }
      }
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
        f.id
      );
      clonedFace.materialId = f.materialId;
      clonedFace.hidden = f.hidden;
      clonedFace.openingId = f.openingId;
    }
    cloned.rebuildTopology();
    return cloned;
  }

  /**
   * Splits a face in the PolyMesh by a 3D line segment coplanar with the face.
   * Returns the two newly created faces, or null if the segment does not split the face.
   */
  splitFaceWithLine(
    faceId: string,
    p1: Vec3,
    p2: Vec3
  ): { faceA: Face; faceB: Face } | null {
    const face = this.faces.get(faceId);
    if (!face) return null;

    const normal = face.normal;
    // Check if segment is coplanar with face
    const d1 = Math.abs(face.plane.distanceToPoint(p1));
    const d2 = Math.abs(face.plane.distanceToPoint(p2));
    if (d1 > 0.05 || d2 > 0.05) return null;

    const basis = PolygonClipping.getLocalBasis(p1, normal);
    const poly3D = face.getPositions();
    const poly2D = poly3D.map((p) => PolygonClipping.projectTo2D(p, basis));
    const s1_2D = PolygonClipping.projectTo2D(p1, basis);
    const s2_2D = PolygonClipping.projectTo2D(p2, basis);

    const split2D = PolygonClipping.splitPolygonWithSegment(poly2D, s1_2D, s2_2D);
    if (!split2D || split2D.length !== 2) return null;

    const polyA3D = split2D[0].map((p) => PolygonClipping.unprojectTo3D(p, basis));
    const polyB3D = split2D[1].map((p) => PolygonClipping.unprojectTo3D(p, basis));

    // Distribute existing holes if any
    const holesA: Vec3[][] = [];
    const holesB: Vec3[][] = [];
    for (const hole of face.holes) {
      const holeCenter = hole.reduce((acc, v) => acc.add(v), Vec3.ZERO).scale(1 / hole.length);
      const holeCenter2D = PolygonClipping.projectTo2D(holeCenter, basis);
      if (PolygonClipping.pointInPolygon2D(holeCenter2D, split2D[0])) {
        holesA.push(hole);
      } else {
        holesB.push(hole);
      }
    }

    this.faces.delete(faceId);

    const faceA = this.addFace(polyA3D, normal, holesA);
    const faceB = this.addFace(polyB3D, normal, holesB);

    this.rebuildTopology();

    return { faceA, faceB };
  }

  /**
   * Splits a host face by embedding a coplanar closed loop polygon (e.g. window/cutout/subsurface).
   * Returns the inner face and outer surrounding faces.
   */
  splitFaceWithCutout(
    faceId: string,
    innerLoop: Vec3[]
  ): { innerFace: Face; outerFaces: Face[] } | null {
    const face = this.faces.get(faceId);
    if (!face || innerLoop.length < 3) return null;

    const normal = face.normal;
    const basis = PolygonClipping.getLocalBasis(innerLoop[0], normal);

    const outer2D = face.getPositions().map((p) => PolygonClipping.projectTo2D(p, basis));
    const inner2D = innerLoop.map((p) => PolygonClipping.projectTo2D(p, basis));

    const pieces2D = PolygonClipping.partitionPolygonWithCutout(outer2D, inner2D);
    if (!pieces2D || pieces2D.length === 0) return null;

    this.faces.delete(faceId);

    // Inner face
    const innerFace = this.addFace(innerLoop, normal);

    // Outer faces
    const outerFaces: Face[] = [];
    for (const piece of pieces2D) {
      const piece3D = piece.map((p) => PolygonClipping.unprojectTo3D(p, basis));
      outerFaces.push(this.addFace(piece3D, normal));
    }

    this.rebuildTopology();

    return { innerFace, outerFaces };
  }

  /**
   * Applies an offset to a polygonal face:
   * - distance < 0 (inward / negativo): Splits the face into TWO faces:
   *   1. innerFace (positions: offsetPositions)
   *   2. annularFace (positions: origPositions, holes: [offsetPositions])
   * - distance > 0 (outward / positivo): Keeps the original face and creates a NEW annular face:
   *   1. original face (untouched)
   *   2. newFace (positions: offsetPositions, holes: [origPositions])
   */
  offsetFace(
    faceId: string,
    distance: number
  ): { innerFace?: Face; annularFace?: Face; newFace?: Face } | null {
    const face = this.faces.get(faceId);
    if (!face) return null;
    if (Math.abs(distance) < GeometryTolerance.MATH_EPSILON) return null;

    const normal = face.normal;
    const origPositions = face.getPositions();
    if (origPositions.length < 3) return null;

    // Compute 3D offset loop using PolygonClipping
    const offsetPositions = PolygonClipping.offsetPolygon3D(origPositions, normal, distance);
    if (!offsetPositions || offsetPositions.length < 3) return null;

    if (distance < 0) {
      // Inward offset: Divide face into TWO (inner face + annular frame face)
      const existingHoles = face.holes ? [...face.holes] : [];
      this.faces.delete(faceId);

      const innerFace = this.addFace(offsetPositions, normal);
      const annularFace = this.addFace(origPositions, normal, [offsetPositions, ...existingHoles]);

      this.rebuildTopology();
      return { innerFace, annularFace };
    } else {
      // Outward offset: Keep original face intact, add new surrounding annular face
      const newFace = this.addFace(offsetPositions, normal, [origPositions]);

      this.rebuildTopology();
      return { newFace };
    }
  }

  /**
   * If a point P lies on an edge between vertex A and vertex B of any face,
   * inserts the projected point into that edge for all sharing faces.
   */
  splitEdgeAtPoint(point: Vec3, tolerance: number = GeometryTolerance.COINCIDENT_VERTEX): boolean {
    let anySplit = false;
    const facesToRebuild: { id: string; positions: Vec3[]; normal: Vec3; holes: Vec3[][] }[] = [];

    for (const face of this.faces.values()) {
      const positions = face.getPositions();
      const n = positions.length;
      let splitThisFace = false;
      const newPositions: Vec3[] = [];

      for (let i = 0; i < n; i++) {
        const a = positions[i];
        const b = positions[(i + 1) % n];
        newPositions.push(a);

        if (a.distanceTo(point) <= tolerance || b.distanceTo(point) <= tolerance) {
          continue;
        }

        const ab = b.sub(a);
        const l2 = ab.lengthSq();
        if (l2 > GeometryTolerance.MATH_EPSILON) {
          const t = Math.max(0, Math.min(1, point.sub(a).dot(ab) / l2));
          const proj = a.add(ab.scale(t));
          if (proj.distanceTo(point) <= tolerance && t > 0.001 && t < 0.999) {
            newPositions.push(proj);
            splitThisFace = true;
          }
        }
      }

      // Check and split holes
      let splitHoles = false;
      const newHoles: Vec3[][] = [];
      for (const hole of face.holes) {
        const hn = hole.length;
        const newHole: Vec3[] = [];
        let holeChanged = false;
        for (let hi = 0; hi < hn; hi++) {
          const ha = hole[hi];
          const hb = hole[(hi + 1) % hn];
          newHole.push(ha);
          if (ha.distanceTo(point) <= tolerance || hb.distanceTo(point) <= tolerance) {
            continue;
          }
          const hab = hb.sub(ha);
          const hl2 = hab.lengthSq();
          if (hl2 > GeometryTolerance.MATH_EPSILON) {
            const ht = Math.max(0, Math.min(1, point.sub(ha).dot(hab) / hl2));
            const hproj = ha.add(hab.scale(ht));
            if (hproj.distanceTo(point) <= tolerance && ht > 0.001 && ht < 0.999) {
              newHole.push(hproj);
              holeChanged = true;
              splitHoles = true;
            }
          }
        }
        newHoles.push(holeChanged ? newHole : hole);
      }

      if (splitThisFace || splitHoles) {
        anySplit = true;
        facesToRebuild.push({
          id: face.id,
          positions: splitThisFace ? newPositions : positions,
          normal: face.normal,
          holes: splitHoles ? newHoles : face.holes,
        });
      }
    }

    if (anySplit) {
      for (const f of facesToRebuild) {
        this.faces.delete(f.id);
        this.addFace(f.positions, f.normal, f.holes);
      }
      this.rebuildTopology();
    }

    return anySplit;
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

  // ─── Sub-Face & Hole Embedding ─────────────────────────────
  embedSubFace(hostFaceId: string, cutoutPositions: Vec3[]): { subFace?: Face; remnantFaces: Face[] } {
    const hostFace = this.faces.get(hostFaceId);
    if (!hostFace || cutoutPositions.length < 3) {
      return { remnantFaces: [] };
    }

    hostFace.addHole(cutoutPositions);
    return { subFace: hostFace, remnantFaces: [hostFace] };
  }

  /**
   * Replicates or embeds a through-hole / cutout feature into this PolyMesh.
   * Identifies top and bottom bounding loops of translated tunnel faces, cuts host faces
   * via addHole, inserts tunnel wall faces, and rebuilds topology in a single atomic manifold solid.
   */
  embedHoleFeature(
    sourceFaces: { positions: Vec3[]; normal: Vec3 }[],
    delta: Vec3
  ): boolean {
    if (sourceFaces.length === 0) return false;

    // 1. Compute translated faces
    const translatedFaces = sourceFaces.map((f) => ({
      positions: f.positions.map((p) => p.add(delta)),
      normal: f.normal,
    }));

    // 2. Find boundary loops of the translated tunnel (edges that do not have twins within the set)
    const directedEdges: { a: Vec3; b: Vec3 }[] = [];
    for (const tf of translatedFaces) {
      const n = tf.positions.length;
      for (let i = 0; i < n; i++) {
        directedEdges.push({ a: tf.positions[i], b: tf.positions[(i + 1) % n] });
      }
    }

    const boundaryEdges = directedEdges.filter((e1) => {
      return !directedEdges.some((e2) =>
        e2.a.distanceTo(e1.b) < GeometryTolerance.COINCIDENT_POINT &&
        e2.b.distanceTo(e1.a) < GeometryTolerance.COINCIDENT_POINT
      );
    });

    if (boundaryEdges.length === 0) return false;

    // 3. Group boundary edges into closed loops
    const loops: Vec3[][] = [];
    const remainingEdges = [...boundaryEdges];

    while (remainingEdges.length > 0) {
      const currentLoop: Vec3[] = [];
      const startEdge = remainingEdges.shift()!;
      currentLoop.push(startEdge.a);
      let currentEnd = startEdge.b;

      let guard = 0;
      while (guard++ < 500) {
        if (currentEnd.distanceTo(currentLoop[0]) < GeometryTolerance.COINCIDENT_POINT) {
          break; // Loop closed
        }
        const nextIdx = remainingEdges.findIndex(
          (e) => e.a.distanceTo(currentEnd) < GeometryTolerance.COINCIDENT_POINT
        );
        if (nextIdx === -1) break;
        const nextEdge = remainingEdges.splice(nextIdx, 1)[0];
        currentLoop.push(nextEdge.a);
        currentEnd = nextEdge.b;
      }

      if (currentLoop.length >= 3) {
        loops.push(currentLoop);
      }
    }

    if (loops.length === 0) return false;

    // 4. For each loop, find the host face on this PolyMesh that contains the loop
    const loopToFaceMap: { loop: Vec3[]; hostFace: Face }[] = [];

    for (const loop of loops) {
      const loopCenter = loop.reduce((acc, v) => acc.add(v), Vec3.ZERO).scale(1 / loop.length);
      const loopNormal = PolyMesh.computePolygonNormal(loop);

      for (const f of this.faces.values()) {
        if (Math.abs(f.plane.distanceToPoint(loopCenter)) <= GeometryTolerance.POINT_ON_PLANE) {
          if (Math.abs(f.normal.dot(loopNormal)) > 0.8) {
            const basis = PolygonClipping.getLocalBasis(f.getPositions()[0], f.normal);
            const f2D = f.getPositions().map((p) => PolygonClipping.projectTo2D(p, basis));
            const loop2D = loop.map((p) => PolygonClipping.projectTo2D(p, basis));

            const allInOrOn = loop2D.every((lp) => PolygonClipping.isPointInOrOnPolygon2D(lp, f2D));
            if (allInOrOn) {
              loopToFaceMap.push({ loop, hostFace: f });
              break;
            }
          }
        }
      }
    }

    // If at least one boundary loop matched a host face on the solid (e.g. through hole matches 2 faces):
    if (loopToFaceMap.length > 0) {
      for (const match of loopToFaceMap) {
        match.hostFace.addHole(match.loop);
      }
      for (const tf of translatedFaces) {
        this.addFace(tf.positions, tf.normal);
      }
      this.rebuildTopology();
      return true;
    }

    return false;
  }

  // ─── 3-Way Push/Pull Extrusion Engine ───────────────────────
  /**
   * Extrude a planar face along its normal by a given distance.
   */
  extrudeFace(faceId: string, distance: number): ExtrudeResult {
    const originalFace = this.faces.get(faceId);
    if (!originalFace || Math.abs(distance) < 1e-5) {
      return { sideFaces: [] };
    }

    const originalNormal = originalFace.normal;
    const offsetVector = originalNormal.scale(distance);
    const basePositions = originalFace.getPositions();
    const n = basePositions.length;

    // 1. Check if this face is a sub-face on a larger surface (has coplanar neighbor faces)
    const coplanarNeighbors = Array.from(this.faces.values()).filter((f) => {
      return f.id !== faceId &&
        Math.abs(f.normal.dot(originalNormal)) > 0.95 &&
        Math.abs(f.plane.distanceToPoint(originalFace.plane.origin)) < GeometryTolerance.POINT_ON_PLANE;
    });
    const isSubFace = coplanarNeighbors.length > 0;

    // 2. Check if this face is connected to a 3D solid (shares vertices with faces of different/perpendicular normals)
    const faceVerts = originalFace.getVertices();
    const isSolid = Array.from(this.faces.values()).some((f) => {
      if (f.id === faceId) return false;
      const isPerpendicular = Math.abs(f.normal.dot(originalNormal)) < 0.8;
      if (!isPerpendicular) return false;
      return f.getVertices().some((v) => faceVerts.includes(v));
    });

    const isSheet = !isSolid && !isSubFace;

    if (isSheet) {
      const originalMaterialId = originalFace.materialId;
      const topPositions = basePositions.map((p) => p.add(offsetVector));
      const originalHoles = originalFace.holes || [];
      this.removeFace(faceId);

      const effectiveNormal = distance >= 0 ? originalNormal : originalNormal.negate();
      const bottomWinding = distance >= 0 ? [...basePositions].reverse() : basePositions;
      const topWinding = distance >= 0 ? topPositions : [...topPositions].reverse();

      const bottomHoles = originalHoles.map((hole) =>
        distance >= 0 ? [...hole].reverse() : [...hole]
      );
      const topHoles = originalHoles.map((hole) => {
        const shifted = hole.map((p) => p.add(offsetVector));
        return distance >= 0 ? shifted : [...shifted].reverse();
      });

      const bottomFace = this.addFace(bottomWinding, effectiveNormal.negate(), bottomHoles.length > 0 ? bottomHoles : undefined);
      const topFace = this.addFace(topWinding, effectiveNormal, topHoles.length > 0 ? topHoles : undefined);

      if (originalMaterialId) {
        bottomFace.materialId = originalMaterialId;
        topFace.materialId = originalMaterialId;
      }

      const sideFaces: Face[] = [];
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const quad = distance >= 0
          ? [basePositions[i], basePositions[next], topPositions[next], topPositions[i]]
          : [basePositions[next], basePositions[i], topPositions[i], topPositions[next]];

        const sf = this.addFace(quad);
        if (originalMaterialId) sf.materialId = originalMaterialId;
        sideFaces.push(sf);
      }

      // Paredes interiores para agujeros pasantes
      for (const hole of originalHoles) {
        const m = hole.length;
        const topHoleVerts = hole.map((p) => p.add(offsetVector));
        for (let j = 0; j < m; j++) {
          const next = (j + 1) % m;
          const quadHole = distance >= 0
            ? [hole[next], hole[j], topHoleVerts[j], topHoleVerts[next]]
            : [hole[j], hole[next], topHoleVerts[next], topHoleVerts[j]];
          const sfHole = this.addFace(quadHole);
          if (originalMaterialId) sfHole.materialId = originalMaterialId;
          sideFaces.push(sfHole);
        }
      }

      this.rebuildTopology();
      return { topFace, sideFaces };
    }

    if (isSubFace) {
      // ─── Direct Sub-Face Extrusion / Through-Cutout on a 3D Solid ───────────────
      const faceCenter = basePositions.reduce((acc, v) => acc.add(v), Vec3.ZERO).scale(1 / n);
      const rayDir = originalNormal.negate();
      let backFace: Face | null = null;
      let solidThickness = Infinity;

      for (const f of this.faces.values()) {
        if (f.id === faceId || coplanarNeighbors.some((c) => c.id === f.id)) continue;
        if (f.normal.dot(rayDir) > 0.8) {
          const hit = f.plane.intersectRay(faceCenter, rayDir);
          if (hit) {
            const d = faceCenter.distanceTo(hit);
            if (d < solidThickness && d > 1e-4) {
              solidThickness = d;
              backFace = f;
            }
          }
        }
      }

      // Classify edges into inner dividing edges (shared with coplanar faces) and outer perimeter edges
      const isInnerEdge = (vA: Vec3, vB: Vec3) => {
        const mid = vA.add(vB).scale(0.5);
        return coplanarNeighbors.some((c) => {
          const loops = [c.getPositions(), ...c.holes];
          for (const cVerts of loops) {
            const cN = cVerts.length;
            for (let k = 0; k < cN; k++) {
              const cA = cVerts[k];
              const cB = cVerts[(k + 1) % cN];
              const ab = cB.sub(cA);
              const l2 = ab.lengthSq();
              if (l2 > 1e-6) {
                const t = Math.max(0, Math.min(1, mid.sub(cA).dot(ab) / l2));
                const proj = cA.add(ab.scale(t));
                if (proj.distanceTo(mid) < GeometryTolerance.COINCIDENT_VERTEX) return true;
              }
            }
          }
          return false;
        });
      };

      const innerEdges: { a: Vec3; b: Vec3 }[] = [];
      const outerEdges: { a: Vec3; b: Vec3 }[] = [];

      for (let i = 0; i < n; i++) {
        const a = basePositions[i];
        const b = basePositions[(i + 1) % n];
        if (isInnerEdge(a, b)) {
          innerEdges.push({ a, b });
        } else {
          outerEdges.push({ a, b });
        }
      }

      if (originalFace.holes) {
        for (const hole of originalFace.holes) {
          const m = hole.length;
          for (let i = 0; i < m; i++) {
            const a = hole[i];
            const b = hole[(i + 1) % m];
            if (isInnerEdge(a, b)) {
              innerEdges.push({ a, b });
            } else {
              outerEdges.push({ a, b });
            }
          }
        }
      }

      const isThroughCut = distance < 0 && solidThickness < Infinity && Math.abs(distance) >= solidThickness - 0.05;

      if (isThroughCut && backFace) {
        const backOffset = rayDir.scale(solidThickness);
        const backPositions = basePositions.map((p) => p.add(backOffset));

        if (outerEdges.length === 0) {
          // ─── 1A. INTERIOR THROUGH-HOLE (Window / Door Opening) ──────────
          // Add hole to back face
          backFace.addHole(backPositions);

          // Add hole to front coplanar face
          if (coplanarNeighbors.length > 0) {
            coplanarNeighbors[0].addHole(basePositions);
          }

          // Add tunnel wall faces
          for (let i = 0; i < n; i++) {
            const next = (i + 1) % n;
            const tunnelQuad = [
              basePositions[i],
              basePositions[next],
              backPositions[next],
              backPositions[i],
            ];
            this.addFace(tunnelQuad);
          }

          // Remove the pushed front face
          this.removeFace(faceId);

          this.rebuildTopology();
          return { sideFaces: [] };
        } else {
          // ─── 1B. PERIMETER CORNER / NOTCH CUTOUT ────────────────────────
          const backFaceId = backFace.id;

          // 1. Cut the front coplanar neighbor faces using PlanarGraph
          for (const cFace of coplanarNeighbors) {
            const frontGraph = new PlanarGraph(cFace.plane.origin, cFace.normal);
            frontGraph.addPolygon3D(cFace.getPositions());
            for (const h of cFace.holes) frontGraph.addPolygon3D(h);
            frontGraph.addSegments3D(innerEdges);
            const extractedFront = frontGraph.extractFaces3D();
            if (extractedFront.length >= 1) {
              this.removeFace(cFace.id);
              for (const ef of extractedFront) {
                this.addFace(ef.positions, cFace.normal, ef.holes);
              }
            }
          }

          // 2. Cut the back face using PlanarGraph with all projected inner edges
          const backGraph = new PlanarGraph(backFace.plane.origin, backFace.normal);
          backGraph.addPolygon3D(backFace.getPositions());
          for (const hole of backFace.holes) {
            backGraph.addPolygon3D(hole);
          }
          const backSegs = innerEdges.map((inEdge) => ({
            a: inEdge.a.add(backOffset),
            b: inEdge.b.add(backOffset),
          }));
          backGraph.addSegments3D(backSegs);

          const extractedBack = backGraph.extractFaces3D();
          if (extractedBack.length >= 2) {
            this.removeFace(backFaceId);
            const projCenter = faceCenter.add(backOffset);
            let closestFaceIdx = 0;
            let closestDist = Infinity;

            for (let k = 0; k < extractedBack.length; k++) {
              const ef = extractedBack[k];
              const efCenter = ef.positions.reduce((acc, v) => acc.add(v), Vec3.ZERO).scale(1 / ef.positions.length);
              const d = efCenter.distanceTo(projCenter);
              if (d < closestDist) {
                closestDist = d;
                closestFaceIdx = k;
              }
            }

            // Add all extracted faces EXCEPT the discarded corner
            for (let k = 0; k < extractedBack.length; k++) {
              if (k !== closestFaceIdx) {
                this.addFace(extractedBack[k].positions, extractedBack[k].normal, extractedBack[k].holes);
              }
            }
          }

          // 3. Remove the top corner sub-face
          this.removeFace(faceId);

          // 4. Cut and remove all side wall sub-faces that belong to the removed corner
          const cornerVertices = [...basePositions, ...backPositions];
          const sidePlaneTol = GeometryTolerance.POINT_ON_PLANE;

          for (const [sId, sf] of Array.from(this.faces.entries())) {
            if (Math.abs(sf.normal.dot(originalNormal)) < GeometryTolerance.COPLANAR_NORMAL) {
              const incidentVerts: Vec3[] = [];
              for (const bp of basePositions) {
                if (Math.abs(sf.plane.distanceToPoint(bp)) <= sidePlaneTol) {
                  if (!incidentVerts.some((iv) => iv.distanceTo(bp) < GeometryTolerance.COINCIDENT_VERTEX)) {
                    incidentVerts.push(bp);
                  }
                }
              }

              if (incidentVerts.length >= 2) {
                const cutFootprint3D = [
                  ...incidentVerts,
                  ...[...incidentVerts].reverse().map((iv) => iv.add(backOffset)),
                ];
                const sfBasis = PolygonClipping.getLocalBasis(sf.plane.origin, sf.normal);
                const cutFootprint2D = cutFootprint3D.map((p) => PolygonClipping.projectTo2D(p, sfBasis));

                const sideGraph = new PlanarGraph(sf.plane.origin, sf.normal);
                sideGraph.addPolygon3D(sf.getPositions());
                for (const h of sf.holes) sideGraph.addPolygon3D(h);

                const sideSegs = incidentVerts.map((bp) => ({
                  a: bp,
                  b: bp.add(backOffset),
                }));
                sideGraph.addSegments3D(sideSegs);
                const extractedSide = sideGraph.extractFaces3D();

                if (extractedSide.length >= 2) {
                  this.removeFace(sId);
                  for (const ef of extractedSide) {
                    const efCenter = ef.positions.reduce((acc, v) => acc.add(v), Vec3.ZERO).scale(1 / ef.positions.length);
                    const efCenter2D = PolygonClipping.projectTo2D(efCenter, sfBasis);

                    const isInsideCut = PolygonClipping.pointInPolygon2D(efCenter2D, cutFootprint2D);
                    if (!isInsideCut) {
                      this.addFace(ef.positions, sf.normal, ef.holes);
                    }
                  }
                } else {
                  const fVerts = sf.getPositions();
                  const isCornerWall = fVerts.every((fv) =>
                    cornerVertices.some((cv) => cv.distanceTo(fv) < GeometryTolerance.COINCIDENT_VERTEX)
                  );
                  if (isCornerWall) {
                    this.removeFace(sId);
                  }
                }
              } else {
                const fVerts = sf.getPositions();
                const isCornerWall = fVerts.every((fv) =>
                  cornerVertices.some((cv) => cv.distanceTo(fv) < GeometryTolerance.COINCIDENT_VERTEX)
                );
                if (isCornerWall) {
                  this.removeFace(sId);
                }
              }
            }
          }

          // 5. Add the through-cut wall quads connecting front inner edges to back inner edges
          for (const inEdge of innerEdges) {
            const { quad, normal } = this.createRiserQuad(
              inEdge.a,
              inEdge.b,
              backOffset,
              basePositions,
              originalFace.holes,
              originalNormal
            );
            this.addFace(quad, normal);
          }

          this.coalesceCoplanarFaces();
          this.rebuildTopology();
          return { sideFaces: [] };
        }
      } else {
        // ─── 2. STEP UP OR PARTIAL STEP DOWN (Recess/Boss) ────────────────
        const topPositions = basePositions.map((p) => p.add(offsetVector));
        const newHoles = originalFace.holes.map((h) => h.map((p) => p.add(offsetVector)));

        // Add vertical riser walls for inner dividing edges
        const sideFaces: Face[] = [];
        for (const inEdge of innerEdges) {
          const { quad, normal } = this.createRiserQuad(
            inEdge.a,
            inEdge.b,
            offsetVector,
            basePositions,
            originalFace.holes,
            originalNormal
          );
          const sf = this.addFace(quad, normal);
          sideFaces.push(sf);
        }

        // Update outer side wall / adjacent perpendicular faces
        for (const outEdge of outerEdges) {
          for (const [fId, f] of this.faces) {
            if (fId === faceId || coplanarNeighbors.some((c) => c.id === fId)) continue;
            if (Math.abs(f.normal.dot(originalNormal)) < 0.2) {
              const fVerts = f.getPositions();
              const updatedVerts = this.updateAdjacentFaceLoop(fVerts, outEdge.a, outEdge.b, offsetVector, coplanarNeighbors);
              if (updatedVerts && updatedVerts.length >= 3) {
                this.removeFace(fId);
                this.addFace(updatedVerts, f.normal, f.holes);
              }
            }
          }
        }

        // Move sub-face to new height
        this.removeFace(faceId);
        const topFace = this.addFace(topPositions, originalNormal, newHoles);

        this.rebuildTopology();
        return { topFace, sideFaces };
      }
    }

    // Extruding a whole face on an existing 3D Solid (Standard Solid Push/Pull):
    const topPositions = basePositions.map((p) => p.add(offsetVector));
    const newHoles = originalFace.holes.map((h) => h.map((p) => p.add(offsetVector)));

    // Tolerancias geométricas adaptativas proporcionales a la escala y desplazamiento de extrusión
    const charScale = GeometryTolerance.computeCharacteristicScale(basePositions);
    const scaleTol = GeometryTolerance.getModelScaleTolerance(Math.min(charScale, Math.max(1e-4, Math.abs(distance))));
    const vertexTol = scaleTol.vertexTol;
    const planeTol = Math.max(1e-5, Math.min(GeometryTolerance.POINT_ON_PLANE, Math.abs(distance) * 0.05));

    // 1. Update all adjacent faces that share boundary or hole vertices with the moving face
    const facesToUpdate = new Map<string, { verts: Vec3[]; normal?: Vec3; holes?: Vec3[][] }>();

    for (const [fId, f] of this.faces) {
      if (fId === faceId) continue;
      const fVerts = f.getPositions();
      let modified = false;

      const updatedVerts = fVerts.map((p) => {
        // Match outer boundary vertices
        for (let i = 0; i < n; i++) {
          if (p.distanceTo(basePositions[i]) <= vertexTol) {
            modified = true;
            return topPositions[i];
          }
        }
        // Match hole vertices
        if (originalFace.hasHoles()) {
          for (let hIdx = 0; hIdx < originalFace.holes.length; hIdx++) {
            const oldH = originalFace.holes[hIdx];
            const newH = newHoles[hIdx];
            for (let k = 0; k < oldH.length; k++) {
              if (p.distanceTo(oldH[k]) <= vertexTol) {
                modified = true;
                return newH[k];
              }
            }
          }
        }
        return p;
      });

      // Also update f.holes if any vertex in f.holes matched moving basePositions
      let holesModified = false;
      const updatedHoles = f.holes.map((h) =>
        h.map((p) => {
          for (let i = 0; i < n; i++) {
            if (p.distanceTo(basePositions[i]) <= vertexTol) {
              holesModified = true;
              return topPositions[i];
            }
          }
          return p;
        })
      );

      if (modified || holesModified) {
        facesToUpdate.set(fId, {
          verts: updatedVerts,
          normal: f.normal,
          holes: updatedHoles,
        });
      }
    }

    // Apply vertex updates to all adjacent and tunnel faces (preserving face IDs)
    for (const [fId, data] of facesToUpdate) {
      this.removeFace(fId);
      const newF = this.addFace(data.verts, data.normal, data.holes);
      this.faces.delete(newF.id);
      newF.id = fId;
      this.faces.set(fId, newF);
    }

    // 2. Re-create the moving face at its new position with updated holes (preserving face ID)
    this.removeFace(faceId);
    let topFace: Face | undefined = this.addFace(topPositions, originalNormal, newHoles);
    this.faces.delete(topFace.id);
    topFace.id = faceId;
    this.faces.set(faceId, topFace);

    // 2.1 Coincident Face Annihilation & Notch Cutout
    // If topFace arrives at an existing boundary face of the solid sharing the same plane:
    if (topFace) {
      for (const [otherId, otherFace] of Array.from(this.faces.entries())) {
        if (otherId === faceId || !topFace) continue;

        const originDist = Math.abs(otherFace.plane.distanceToPoint(topPositions[0]));
        if (originDist <= planeTol) {
          const dotN = topFace.normal.dot(otherFace.normal);
          if (Math.abs(dotN) > 0.95) {
            // Coplanar faces
            const topVerts = topFace.getPositions();
            const otherVerts = otherFace.getPositions();

            if (PolygonClipping.polygonsOverlapOnPlane(otherVerts, topVerts, otherFace.holes, otherFace.normal)) {
              const otherBasis = PolygonClipping.getLocalBasis(otherVerts[0], otherFace.normal);
              const other2D = otherVerts.map((p) => PolygonClipping.projectTo2D(p, otherBasis));
              const top2D = topVerts.map((p) => PolygonClipping.projectTo2D(p, otherBasis));

              const otherFullyInTop = other2D.every((p) => PolygonClipping.isPointInOrOnPolygon2D(p, top2D));
              const topFullyInOther = top2D.every((p) => PolygonClipping.isPointInOrOnPolygon2D(p, other2D));

              if (otherFullyInTop && topFullyInOther) {
                // Total annihilation: both faces cancel each other out completely (muro/losa colapsada)
                this.removeFace(faceId);
                this.removeFace(otherId);
                topFace = undefined;
                break;
              } else if (topFullyInOther) {
                // Partial annihilation (Notch cutout): subtract topFace from otherFace
                const graph = new PlanarGraph(otherFace.plane.origin, otherFace.normal);
                graph.addPolygon3D(otherVerts);
                for (const h of otherFace.holes) graph.addPolygon3D(h);
                graph.addPolygon3D(topVerts);

                const extracted = graph.extractFaces3D();
                const topCenter = topVerts.reduce((acc, v) => acc.add(v), Vec3.ZERO).scale(1 / topVerts.length);
                const remaining = extracted.filter((ef) => {
                  const efCenter = ef.positions.reduce((acc, v) => acc.add(v), Vec3.ZERO).scale(1 / ef.positions.length);
                  return efCenter.distanceTo(topCenter) > vertexTol;
                });

                if (remaining.length > 0) {
                  this.removeFace(faceId);
                  this.removeFace(otherId);
                  for (const rem of remaining) {
                    this.addFace(rem.positions, otherFace.normal, rem.holes);
                  }
                  topFace = undefined;
                  break;
                }
              } else if (otherFullyInTop) {
                // otherFace is completely inside topFace
                this.removeFace(faceId);
                this.removeFace(otherId);
                topFace = undefined;
                break;
              }
            }
          }
        }
      }
    }

    // 2.2 PlanarGraph Boundary Hole Absorption
    // Only applies if a hole in face.holes actually touches or coincides with the outer perimeter:
    const isPointOnPolyBoundary = (pt: Vec3, poly: Vec3[]): boolean => {
      const pN = poly.length;
      for (let i = 0; i < pN; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % pN];
        const ab = b.sub(a);
        const l2 = ab.lengthSq();
        if (l2 > 1e-6) {
          const t = Math.max(0, Math.min(1, pt.sub(a).dot(ab) / l2));
          const proj = a.add(ab.scale(t));
          if (proj.distanceTo(pt) < GeometryTolerance.COINCIDENT_VERTEX) return true;
        }
      }
      return false;
    };

    for (const [fId, f] of Array.from(this.faces.entries())) {
      if (!f.hasHoles()) continue;
      const outerPoly = f.getPositions();
      const hasBoundaryHole = f.holes.some((h) => h.some((pt) => isPointOnPolyBoundary(pt, outerPoly)));
      if (!hasBoundaryHole) continue;

      const graph = new PlanarGraph(f.plane.origin, f.normal);
      graph.addPolygon3D(outerPoly);
      for (const h of f.holes) {
        graph.addPolygon3D(h);
      }
      const extracted = graph.extractFaces3D();
      // Find the extracted face that contains the original outer perimeter corners (not hole vertices)
      if (extracted.length >= 1) {
        const mainExtracted = extracted.find((ef) => {
          return outerPoly.some(
            (op) => !f.holes.some((h) => h.some((hp) => hp.distanceTo(op) < GeometryTolerance.COINCIDENT_VERTEX)) &&
                    ef.positions.some((ep) => ep.distanceTo(op) < GeometryTolerance.COINCIDENT_VERTEX)
          );
        }) || extracted[0];

        this.removeFace(fId);
        const newF = this.addFace(mainExtracted.positions, f.normal, mainExtracted.holes);
        this.faces.delete(newF.id);
        newF.id = fId;
        this.faces.set(fId, newF);
      }
    }

    // 3. Heal/close/simplify any hole and remove collapsed faces exclusively on affected faces
    const affectedFaceIds = new Set<string>();
    if (topFace) affectedFaceIds.add(topFace.id);
    for (const fId of facesToUpdate.keys()) {
      affectedFaceIds.add(fId);
    }

    const facesToDelete: string[] = [];
    for (const fId of affectedFaceIds) {
      const f = this.faces.get(fId);
      if (!f) continue;
      if (f.getArea() <= GeometryTolerance.MIN_FACE_AREA) {
        facesToDelete.push(fId);
        continue;
      }

      if (!f.hasHoles()) continue;
      const remainingHoles: Vec3[][] = [];
      for (const h of f.holes) {
        const cleaned = PolyMesh.cleanPolygon(h);
        if (cleaned.length >= 3) {
          const h0 = cleaned[0];
          let hArea = 0;
          for (let i = 1; i < cleaned.length - 1; i++) {
            hArea += cleaned[i].sub(h0).cross(cleaned[i + 1].sub(h0)).length() * 0.5;
          }
          if (hArea > GeometryTolerance.MIN_FACE_AREA) {
            remainingHoles.push(cleaned);
          }
        }
      }
      f.holes = remainingHoles;
    }

    for (const fId of facesToDelete) {
      this.removeFace(fId);
    }

    // 4. Rebuild full half-edge & edge topology to ensure 100% complete and connected edge graph
    this.rebuildTopology();

    return { topFace, sideFaces: [] };
  }

  /**
   * Generates a vertical quad face connecting a dividing edge [a, b] to [a + offsetVector, b + offsetVector].
   * Evaluates point-in-polygon with holes to ensure the quad normal points strictly outward from the face interior.
   */
  private createRiserQuad(
    a: Vec3,
    b: Vec3,
    offsetVector: Vec3,
    faceOuter: Vec3[],
    faceHoles: Vec3[][],
    faceNormal: Vec3
  ): { quad: Vec3[]; normal: Vec3 } {
    const ab = b.sub(a);
    if (ab.lengthSq() < GeometryTolerance.MATH_EPSILON || offsetVector.lengthSq() < GeometryTolerance.MATH_EPSILON) {
      return { quad: [a, b, b.add(offsetVector), a.add(offsetVector)], normal: faceNormal };
    }

    const mid = a.add(b).scale(0.5);
    const vPerp = faceNormal.cross(ab).normalize();
    const testDist = Math.min(0.005, ab.length() * 0.1);
    const testPoint = mid.add(vPerp.scale(testDist));

    const insideFace = PolygonClipping.pointInPolygonWithHoles(testPoint, faceOuter, faceHoles || [], faceNormal);
    const outwardDir = insideFace ? vPerp.negate() : vPerp;

    const isExtrudingOutward = offsetVector.dot(faceNormal) >= 0;
    const targetNormal = isExtrudingOutward ? outwardDir : outwardDir.negate();

    const b1 = a;
    const b2 = b;
    const b3 = b.add(offsetVector);
    const b4 = a.add(offsetVector);

    const normal1 = ab.cross(offsetVector);
    if (normal1.dot(targetNormal) > 0) {
      return { quad: [b1, b2, b3, b4], normal: targetNormal };
    } else {
      return { quad: [b2, b1, b4, b3], normal: targetNormal };
    }
  }

  /**
   * Update the boundary loop of an adjacent perpendicular face when one of its outer edges is displaced.
   * Transforms the edge into an orthogonal step (e.g. converting a rectangle into an L-shaped polygon).
   */
  private updateAdjacentFaceLoop(
    fVerts: Vec3[],
    a: Vec3,
    b: Vec3,
    offset: Vec3,
    coplanarNeighbors?: Face[]
  ): Vec3[] | null {
    const k = fVerts.length;
    if (k < 3) return null;

    const isPointSharedWithCoplanar = (pt: Vec3): boolean => {
      if (!coplanarNeighbors || coplanarNeighbors.length === 0) return false;
      return coplanarNeighbors.some((c) => {
        const loops = [c.getPositions(), ...c.holes];
        for (const cVerts of loops) {
          const cN = cVerts.length;
          for (let idx = 0; idx < cN; idx++) {
            const cA = cVerts[idx];
            const cB = cVerts[(idx + 1) % cN];
            const ab = cB.sub(cA);
            const l2 = ab.lengthSq();
            if (l2 < 1e-8) {
              if (pt.distanceTo(cA) <= GeometryTolerance.COINCIDENT_VERTEX) return true;
              continue;
            }
            const t = pt.sub(cA).dot(ab) / l2;
            if (t >= -0.01 && t <= 1.01) {
              const proj = cA.add(ab.scale(Math.max(0, Math.min(1, t))));
              if (proj.distanceTo(pt) <= GeometryTolerance.COINCIDENT_VERTEX) return true;
            }
          }
        }
        return false;
      });
    };

    const pointOnSegment = (p: Vec3, p1: Vec3, p2: Vec3): { onSeg: boolean; t: number } => {
      const d = p2.sub(p1);
      const l2 = d.lengthSq();
      if (l2 < 1e-8) return { onSeg: p.distanceTo(p1) < GeometryTolerance.COINCIDENT_VERTEX, t: 0 };
      const t = p.sub(p1).dot(d) / l2;
      if (t >= -0.01 && t <= 1.01) {
        const proj = p1.add(d.scale(Math.max(0, Math.min(1, t))));
        if (proj.distanceTo(p) < GeometryTolerance.COINCIDENT_VERTEX) {
          return { onSeg: true, t: Math.max(0, Math.min(1, t)) };
        }
      }
      return { onSeg: false, t: -1 };
    };

    for (let i = 0; i < k; i++) {
      const p1 = fVerts[i];
      const p2 = fVerts[(i + 1) % k];

      const resA = pointOnSegment(a, p1, p2);
      const resB = pointOnSegment(b, p1, p2);

      if (resA.onSeg && resB.onSeg) {
        const result: Vec3[] = [];

        for (let j = 0; j <= i; j++) {
          result.push(fVerts[j]);
        }

        const isABOrder = resA.t <= resB.t;
        const first = isABOrder ? a : b;
        const second = isABOrder ? b : a;
        const firstT = isABOrder ? resA.t : resB.t;
        const secondT = isABOrder ? resB.t : resA.t;

        const isFirstCorner = firstT < 0.02;
        const isSecondCorner = secondT > 0.98;

        const isFirstShared = isPointSharedWithCoplanar(first);
        const isSecondShared = isPointSharedWithCoplanar(second);

        // 1. Punto de inicio del escalón (first):
        // Si first coincide con la esquina (p1) pero está compartido con una cara coplanar vecina,
        // NO se debe descartar (no hacer pop), ya que representa la base del escalón ortogonal.
        if (isFirstCorner) {
          if (!isFirstShared) {
            result.pop();
          }
        } else {
          result.push(first);
        }

        // 2. Desplazamiento del escalón ortogonal a 90°
        result.push(first.add(offset), second.add(offset));

        // 3. Punto de fin del escalón (second):
        // Si second está compartido con una cara coplanar vecina o no coincide con la esquina (p2),
        // se debe registrar second para cerrar el escalón ortogonal en la base.
        if (isSecondCorner) {
          if (isSecondShared) {
            result.push(second);
          }
        } else {
          result.push(second);
        }

        // 4. Continuación del lazo poligonal
        const nextJ = isSecondCorner ? i + 2 : i + 1;
        for (let j = nextJ; j < k; j++) {
          result.push(fVerts[j]);
        }

        return PolyMesh.cleanPolygon(result);
      }
    }

    return null;
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

  // ─── Polygon Cleanup & Simplification ───────────────────────
  static cleanPolygon(pts: Vec3[]): Vec3[] {
    if (pts.length < 3) return pts;
    const n = pts.length;

    // 1. Remove duplicate consecutive vertices
    const deduped: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const prev = deduped[deduped.length - 1];
      if (!prev || prev.distanceTo(p) > GeometryTolerance.COINCIDENT_POINT) {
        deduped.push(p);
      }
    }
    if (deduped.length >= 3 && deduped[0].distanceTo(deduped[deduped.length - 1]) < GeometryTolerance.COINCIDENT_POINT) {
      deduped.pop();
    }
    if (deduped.length < 3) return deduped;

    // 2. Remove collinear intermediate vertices
    const result: Vec3[] = [];
    const m = deduped.length;
    for (let i = 0; i < m; i++) {
      const prev = deduped[(i - 1 + m) % m];
      const curr = deduped[i];
      const next = deduped[(i + 1) % m];

      const v1 = curr.sub(prev).normalize();
      const v2 = next.sub(curr).normalize();
      // If angle is near 0 or 180 degrees (collinear)
      if (Math.abs(v1.dot(v2)) > 1 - GeometryTolerance.MATH_EPSILON * 1e5) {
        continue; // Skip redundant collinear vertex
      }
      result.push(curr);
    }

    return result.length >= 3 ? result : [];
  }

  // ─── Factories ──────────────────────────────────────────────
  static createFromPolygon(id: string, vertices: Vec3[], explicitNormal?: Vec3): PolyMesh {
    const mesh = new PolyMesh(id);
    const cleaned = PolyMesh.cleanPolygon(vertices);
    mesh.addFace(cleaned.length >= 3 ? cleaned : vertices, explicitNormal);
    return mesh;
  }

  /**
   * Crea un prisma rectangular orientado en el espacio 3D (Oriented Bounding Box - OBB).
   * Respeta la matriz de rotación del sistema de coordenadas local del edificio (Norma 16).
   */
  static createOrientedBox(
    id: string,
    centerWorld: Vec3,
    sizeU: number,
    sizeY: number,
    sizeV: number,
    rotationMatrix: THREE.Matrix4
  ): PolyMesh {
    const mesh = new PolyMesh(id);
    const hu = sizeU / 2, hy = sizeY / 2, hv = sizeV / 2;

    const el = rotationMatrix.elements;
    // Elementos de Three.js Matrix4 son column-major:
    // col 0 = u-axis (local X en espacio universal)
    const u = new Vec3(el[0], el[1], el[2]).normalize();
    // col 1 = y-axis (local Y en espacio universal)
    const y = new Vec3(el[4], el[5], el[6]).normalize();
    // col 2 = v-axis (local Z en espacio universal)
    const v = new Vec3(el[8], el[9], el[10]).normalize();

    const cx = centerWorld.x, cy = centerWorld.y, cz = centerWorld.z;

    const getCorner = (du: number, dy: number, dv: number) => {
      return new Vec3(
        cx + du * u.x + dy * y.x + dv * v.x,
        cy + du * u.y + dy * y.y + dv * v.y,
        cz + du * u.z + dy * y.z + dv * v.z
      );
    };

    const verts = [
      getCorner(-hu, -hy, -hv), // 0: -u, -y, -v
      getCorner( hu, -hy, -hv), // 1: +u, -y, -v
      getCorner( hu,  hy, -hv), // 2: +u, +y, -v
      getCorner(-hu,  hy, -hv), // 3: -u, +y, -v
      getCorner(-hu, -hy,  hv), // 4: -u, -y, +v
      getCorner( hu, -hy,  hv), // 5: +u, -y, +v
      getCorner( hu,  hy,  hv), // 6: +u, +y, +v
      getCorner(-hu,  hy,  hv), // 7: -u, +y, +v
    ];

    mesh.addFace([verts[0], verts[1], verts[5], verts[4]], y.negate()); // Bottom
    mesh.addFace([verts[3], verts[7], verts[6], verts[2]], y);          // Top
    mesh.addFace([verts[0], verts[3], verts[2], verts[1]], v.negate()); // Back (-V)
    mesh.addFace([verts[4], verts[5], verts[6], verts[7]], v);          // Front (+V)
    mesh.addFace([verts[0], verts[4], verts[7], verts[3]], u.negate()); // Left (-U)
    mesh.addFace([verts[1], verts[2], verts[6], verts[5]], u);          // Right (+U)

    return mesh;
  }

  static createBox(
    id: string,
    centerX: number, centerY: number, centerZ: number,
    sizeX: number, sizeY: number, sizeZ: number,
  ): PolyMesh {
    return PolyMesh.createOrientedBox(
      id,
      new Vec3(centerX, centerY, centerZ),
      sizeX,
      sizeY,
      sizeZ,
      new THREE.Matrix4()
    );
  }

  // ─── Rendering & SceneGraph Conversion ──────────────────────
  toThreeGeometry(renderOffset?: Vec3): THREE.BufferGeometry {
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

    const customKeys = Array.from(customGroups.keys());
    let totalFloats = defaultGroup.positions.length + backPositions.length;
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

    const backCount = backPositions.length / 3;
    geo.addGroup(currentVertexOffset, backCount, 1); // Material index 1: Back Pink
    allPositions.set(backPositions, writeOffset);
    allNormals.set(backNormals, writeOffset);
    writeOffset += backPositions.length;

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
    for (const edge of this.edges.values()) {
      if (edge.hidden) continue;
      const a = edge.vA.position;
      const b = edge.vB.position;
      positions.push(a.x - ox, a.y - oy, a.z - oz, b.x - ox, b.y - oy, b.z - oz);
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

  toSceneEntity(): PolyMeshSceneData {
    const sceneFaces: PolyMeshFaceData[] = [];
    const allEdges: PolyMeshEdgeData[] = [];
    const allVertices: Vec3[] = [];

    for (const v of this.vertices.values()) {
      allVertices.push(v.position);
    }

    for (const edge of this.edges.values()) {
      allEdges.push({ a: edge.vA.position, b: edge.vB.position, hidden: edge.hidden });
    }

    for (const [faceId, face] of this.faces) {
      const faceVerts = face.getPositions();
      const faceEdges: PolyMeshEdgeData[] = [];
      const heList = face.getHalfEdges();
      for (const he of heList) {
        faceEdges.push({ a: he.origin.position, b: he.target.position });
      }

      sceneFaces.push({
        id: faceId,
        faceId,
        polyMeshId: this.id,
        vertices: faceVerts,
        holes: face.holes.map((h) => [...h]),
        normal: face.normal,
        plane: face.plane,
        edges: faceEdges,
        hidden: face.hidden,
        openingId: face.openingId,
        materialId: face.materialId ?? undefined,
      });
    }

    return {
      id: this.id,
      type: 'GEOMETRY_ENTITY',
      faces: sceneFaces,
      vertices: allVertices,
      edges: allEdges,
    };
  }

  transformByMatrix(matrix: THREE.Matrix4): void {
    this.applyMatrix4(matrix);
  }

  /**
   * Validador formal de invariantes topológicas y geométricas.
   * Certifica el cumplimiento estricto de las leyes de B-Rep 2-manifold (Half-Edge).
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

    // 1. Verificación de Vértices y Coordenadas Geométricas
    for (const [vId, v] of this.vertices) {
      if (!v || !v.position) {
        errors.push(`Vértice ${vId} no tiene posición definida.`);
        continue;
      }
      if (!Number.isFinite(v.position.x) || !Number.isFinite(v.position.y) || !Number.isFinite(v.position.z)) {
        errors.push(`Vértice ${vId} contiene coordenadas no finitas (NaN o Infinity): (${v.position.x}, ${v.position.y}, ${v.position.z}).`);
      }
    }

    // 2. Verificación de Half-Edges: Twin Symmetry, Next/Prev y Longitud
    let openHalfEdgesCount = 0;
    for (const [heId, he] of this.halfEdges) {
      if (!he.origin || !he.target) {
        errors.push(`Half-edge ${heId} tiene origen o destino indefinido.`);
        continue;
      }

      // Longitud mínima
      if (checkGeometry && he.length < GeometryTolerance.MIN_EDGE_LENGTH) {
        warnings.push(`Half-edge ${heId} tiene longitud colapsada (${he.length.toFixed(6)}m < ${GeometryTolerance.MIN_EDGE_LENGTH}m).`);
      }

      // Simetría de gemelos
      if (he.twin) {
        if (he.twin.twin !== he) {
          errors.push(`Asimetría de twin en ${heId}: he.twin.twin !== he.`);
        }
        const twinOriginMatches = he.twin.origin.position.equals(he.target.position, GeometryTolerance.COINCIDENT_POINT);
        const twinTargetMatches = he.twin.target.position.equals(he.origin.position, GeometryTolerance.COINCIDENT_POINT);
        if (!twinOriginMatches || !twinTargetMatches) {
          errors.push(`Incoherencia geométrica en twin de ${heId}: orientación de vértices no emparejada.`);
        }
      } else {
        openHalfEdgesCount++;
      }

      // Consistencia de ciclo Next / Prev
      if (he.next) {
        if (he.next.prev !== he) {
          errors.push(`Incoherencia next/prev en ${heId}: he.next.prev !== he.`);
        }
        if (!he.next.origin.position.equals(he.target.position, GeometryTolerance.COINCIDENT_POINT)) {
          errors.push(`Discontinuidad en ciclo: he.next.origin (${he.next.origin.id}) !== he.target (${he.target.id}) para ${heId}.`);
        }
      } else {
        errors.push(`Half-edge ${heId} no tiene puntero 'next' definido.`);
      }

      if (he.prev) {
        if (he.prev.next !== he) {
          errors.push(`Incoherencia prev/next en ${heId}: he.prev.next !== he.`);
        }
      } else {
        errors.push(`Half-edge ${heId} no tiene puntero 'prev' definido.`);
      }
    }

    const isClosed = openHalfEdgesCount === 0 && this.halfEdges.size > 0;
    if (!isClosed && !allowOpenBoundaries && this.faces.size > 0) {
      warnings.push(`La malla posee ${openHalfEdgesCount} semi-aristas frontera sin twin (malla abierta/superficie laminar).`);
    }

    // 3. Verificación de Caras: Cierre de bucle, orientación, área y normales
    for (const [faceId, face] of this.faces) {
      if (!face.halfEdge) {
        errors.push(`Cara ${faceId} no tiene semi-arista raíz (halfEdge).`);
        continue;
      }

      // Recorrido de bucle y detector de ciclos infinitos
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
            errors.push(`Bucle de cara ${faceId} contiene un lazo interno anómalo antes de cerrar en el inicio.`);
          }
          break;
        }
        visitedHe.add(curr.id);
        steps++;
        if (curr.face && curr.face.id !== faceId) {
          errors.push(`Half-edge ${curr.id} pertenece a la cara ${curr.face.id} pero está en el bucle de ${faceId}.`);
        }
        curr = curr.next;
        if (curr === face.halfEdge) {
          closedLoop = true;
          break;
        }
      }

      if (!closedLoop) {
        errors.push(`Bucle de cara ${faceId} no cierra o excede el límite de semi-aristas (posible ciclo infinito).`);
      }

      if (visitedHe.size < 3) {
        errors.push(`Cara ${faceId} tiene menos de 3 vértices (${visitedHe.size}).`);
      }

      // Área y normal geométrica
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
            errors.push(`Cara ${faceId} tiene área nula o degenerada (${area.toExponential(4)} < ${GeometryTolerance.MIN_FACE_AREA}).`);
          }

          const normal = face.normal;
          const normalLen = normal.length();
          if (!Number.isFinite(normalLen) || Math.abs(normalLen - 1.0) > 1e-3) {
            errors.push(`Cara ${faceId} tiene normal no unitaria o degenerada (longitud: ${normalLen}).`);
          }
        }
      }

      // Verificación exhaustiva de huecos (face.holes)
      if (face.holes && face.holes.length > 0) {
        for (let hIdx = 0; hIdx < face.holes.length; hIdx++) {
          const hole = face.holes[hIdx];
          if (!Array.isArray(hole) || hole.length < 3) {
            errors.push(`Hueco ${hIdx} en cara ${faceId} contiene menos de 3 vértices (${hole?.length ?? 0}).`);
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
            errors.push(`Hueco ${hIdx} en cara ${faceId} contiene coordenadas no finitas (NaN o Infinity).`);
          }
          if (checkGeometry) {
            const hArea = PolyMesh.computePolygonArea(hole);
            if (hArea < GeometryTolerance.MIN_FACE_AREA) {
              errors.push(`Hueco ${hIdx} en cara ${faceId} tiene área nula o colapsada (${hArea.toExponential(4)} < ${GeometryTolerance.MIN_FACE_AREA}).`);
            }
            const planeDist = face.plane.distanceToPoint(hole[0]);
            if (Math.abs(planeDist) > GeometryTolerance.POINT_ON_PLANE * 5) {
              warnings.push(`Hueco ${hIdx} en cara ${faceId} se desvía del plano anfitrión por ${Math.abs(planeDist).toFixed(6)}m.`);
            }
          }
        }
      }
    }

    // 4. Integridad 2-Manifold de Aristas
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
          errors.push(`No-variedad (Manifold violation): ${heList.length} semi-aristas comparten la misma dirección ${dirKey}.`);
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
          errors.push(`Arista no-variedad (Non-manifold edge): ${list.length} semi-aristas confluyen en ${edgeKey} (máximo permitido: 2).`);
        }
      }
    }

    // 5. Característica de Euler en Sólidos Cerrados
    let eulerCharacteristic: number | undefined = undefined;
    let genus: number | undefined = undefined;

    if (checkEuler && isClosed && this.faces.size > 0) {
      const V = this.vertices.size;
      const F = this.faces.size;
      const E = this.edges.size > 0 ? this.edges.size : Math.round(this.halfEdges.size / 2);

      eulerCharacteristic = V - E + F;
      genus = Math.round((2 - eulerCharacteristic) / 2);

      if (eulerCharacteristic > 2) {
        warnings.push(`Característica de Euler inesperada: χ = ${eulerCharacteristic} > 2 para sólido cerrado.`);
      }
      if (genus < 0) {
        warnings.push(`Género topológico negativo computado: g = ${genus}.`);
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
        // Regla de Requicha-Voelcker para caras coplanares:
        // Si la normal apunta en la dirección de cutNormal (hacia el semiespacio a descartar), se descarta.
        // Si apunta en la dirección opuesta, se conserva.
        if (face.normal.dot(cutNormal) < -tol) {
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

      // Cara cortada por el plano
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

        // Evaluar también cruces del plano con los bucles de los agujeros
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
          // Ordenar puntos a lo largo de la recta de intersección
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

            // Registrar aristas de corte sobre el plano para capping
            const efN = ef.positions.length;
            for (let i = 0; i < efN; i++) {
              const pA = ef.positions[i];
              const pB = ef.positions[(i + 1) % efN];
              if (Math.abs(dist(pA)) <= tol && Math.abs(dist(pB)) <= tol && pA.distanceTo(pB) > tol) {
                // Sentido en la tapa: inversa a la cara (pB -> pA)
                cutSegments.push({ a: pB, b: pA });
              }
            }
          }
        }
      } else {
        // Sutherland-Hodgman exacto en 3D
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
          // Dirección para la tapa: entryPt -> exitPt
          cutSegments.push({ a: entryPt, b: exitPt });
        }
      }
    }

    if (keptFaces.length === 0) {
      return false;
    }

    // Capping en el plano de corte
    if (cutSegments.length > 0) {
      const capNormal = cutNormal; // Apunta hacia afuera del sólido retenido
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

    // Reconstruir topología
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
