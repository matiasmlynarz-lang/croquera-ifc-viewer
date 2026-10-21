/**
 * HalfEdge — Polyhedral B-Rep data structures for @croquera/ifc-core.
 *
 * Provides a 2-manifold topological representation of vertices, edges,
 * and faces with bidirectional pointers for fast adjacency navigation,
 * boundary loops, and normal computation.
 */
import { Vec3 } from '../math/Vec3';
import { Plane } from '../math/Plane';
import { GeometryTolerance } from '../math/GeometryTolerance';

export class Vertex {
  public id: string;
  public position: Vec3;
  public halfEdge?: HalfEdge;

  constructor(id: string, position: Vec3) {
    this.id = id;
    this.position = position;
  }

  clone(): Vertex {
    return new Vertex(this.id, this.position);
  }
}

export class HalfEdge {
  public id: string;
  public origin: Vertex;
  public target: Vertex;
  public twin?: HalfEdge;
  public next?: HalfEdge;
  public prev?: HalfEdge;
  public face?: Face;
  public edge?: Edge;

  constructor(id: string, origin: Vertex, target: Vertex) {
    this.id = id;
    this.origin = origin;
    this.target = target;
  }

  get direction(): Vec3 {
    const delta = this.target.position.sub(this.origin.position);
    return delta.length() < GeometryTolerance.MIN_EDGE_LENGTH ? Vec3.ZERO : delta.normalize();
  }

  get length(): number {
    return this.origin.position.distanceTo(this.target.position);
  }
}

export class Edge {
  public id: string;
  public he1: HalfEdge;
  public he2?: HalfEdge;
  public hidden?: boolean;

  constructor(id: string, he1: HalfEdge, he2?: HalfEdge) {
    this.id = id;
    this.he1 = he1;
    this.he2 = he2;
  }

  get vA(): Vertex {
    return this.he1.origin;
  }

  get vB(): Vertex {
    return this.he1.target;
  }

  get midpoint(): Vec3 {
    return this.vA.position.lerp(this.vB.position, 0.5);
  }

  get length(): number {
    return this.he1.length;
  }
}

export class Face {
  public id: string;
  public halfEdge: HalfEdge;
  public holes: Vec3[][] = [];
  public holeOwners?: (string | null)[] = [];
  public hidden?: boolean;
  public materialId?: string | null;
  public openingId?: string | null;
  public hasPlanarReflector?: boolean;

  constructor(
    id: string,
    halfEdge: HalfEdge,
    _normal?: Vec3,
    holes?: Vec3[][],
    holeOwners?: (string | null)[]
  ) {
    this.id = id;
    this.halfEdge = halfEdge;
    if (holes) {
      for (let i = 0; i < holes.length; i++) {
        const owner = holeOwners && i < holeOwners.length ? holeOwners[i] : null;
        this.addHole(holes[i], owner);
      }
    }
  }

  get normal(): Vec3 {
    return this.computeNewellNormal();
  }

  get plane(): Plane {
    const origin = this.halfEdge?.origin?.position || Vec3.ZERO;
    return Plane.fromPointAndNormal(origin, this.normal);
  }

  get centroid(): Vec3 {
    return this.getCentroid();
  }

  addHole(holePositions: Vec3[], ownerId: string | null = null): boolean {
    if (holePositions.length < 3) return false;

    const isDuplicate = this.holes.some((existing) => {
      if (existing.length !== holePositions.length) return false;
      const n = existing.length;

      for (let offset = 0; offset < n; offset++) {
        let allMatch = true;
        for (let j = 0; j < n; j++) {
          if (holePositions[j].distanceTo(existing[(j + offset) % n]) > GeometryTolerance.COINCIDENT_POINT) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) return true;
      }

      for (let offset = 0; offset < n; offset++) {
        let allMatch = true;
        for (let j = 0; j < n; j++) {
          if (holePositions[j].distanceTo(existing[(offset - j + n) % n]) > GeometryTolerance.COINCIDENT_POINT) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) return true;
      }

      return false;
    });

    if (isDuplicate) return false;

    this.holes.push([...holePositions]);
    if (!this.holeOwners) this.holeOwners = [];
    this.holeOwners.push(ownerId);
    return true;
  }

  removeHolesByOwner(ownerId: string): number {
    if (!this.holes || !this.holeOwners) return 0;
    const initialCount = this.holes.length;
    const newHoles: Vec3[][] = [];
    const newOwners: (string | null)[] = [];
    for (let i = 0; i < this.holes.length; i++) {
      if (this.holeOwners[i] !== ownerId) {
        newHoles.push(this.holes[i]);
        newOwners.push(this.holeOwners[i]);
      }
    }
    this.holes = newHoles;
    this.holeOwners = newOwners;
    return initialCount - newHoles.length;
  }

  hasHoles(): boolean {
    return this.holes.length > 0;
  }

  getHalfEdges(): HalfEdge[] {
    const edges: HalfEdge[] = [];
    let curr: HalfEdge | undefined = this.halfEdge;
    const start = this.halfEdge;
    const visited = new Set<HalfEdge>();

    while (curr && !visited.has(curr)) {
      visited.add(curr);
      edges.push(curr);
      curr = curr.next;
      if (curr === start || !curr) break;
    }

    return edges;
  }

  getVertices(): Vertex[] {
    return this.getHalfEdges().map((he) => he.origin);
  }

  getPositions(): Vec3[] {
    return this.getVertices().map((v) => v.position);
  }

  getEdges(): Edge[] {
    const edgeSet = new Set<Edge>();
    for (const he of this.getHalfEdges()) {
      if (he.edge) {
        edgeSet.add(he.edge);
      }
    }
    return Array.from(edgeSet);
  }

  getCentroid(): Vec3 {
    const verts = this.getPositions();
    if (verts.length === 0) return Vec3.ZERO;
    let sum = Vec3.ZERO;
    for (const v of verts) {
      sum = sum.add(v);
    }
    return sum.scale(1 / verts.length);
  }

  computeNewellNormal(): Vec3 {
    const verts = this.getPositions();
    if (verts.length < 3) return Vec3.Y;

    let nx = 0, ny = 0, nz = 0;
    const n = verts.length;

    for (let i = 0; i < n; i++) {
      const curr = verts[i];
      const next = verts[(i + 1) % n];

      nx += (curr.y - next.y) * (curr.z + next.z);
      ny += (curr.z - next.z) * (curr.x + next.x);
      nz += (curr.x - next.x) * (curr.y + next.y);
    }

    const result = new Vec3(nx, ny, nz);
    return result.isZero() ? Vec3.Y : result.normalize();
  }

  getArea(): number {
    const verts = this.getPositions();
    if (verts.length < 3) return 0;

    let crossSum = Vec3.ZERO;
    const n = verts.length;
    for (let i = 0; i < n; i++) {
      const curr = verts[i];
      const next = verts[(i + 1) % n];
      crossSum = crossSum.add(curr.cross(next));
    }
    let outerArea = crossSum.length() * 0.5;

    for (const hole of this.holes) {
      if (hole.length < 3) continue;
      let hCrossSum = Vec3.ZERO;
      const m = hole.length;
      for (let i = 0; i < m; i++) {
        const curr = hole[i];
        const next = hole[(i + 1) % m];
        hCrossSum = hCrossSum.add(curr.cross(next));
      }
      const hArea = hCrossSum.length() * 0.5;
      outerArea = Math.max(0, outerArea - hArea);
    }

    return outerArea;
  }
}
