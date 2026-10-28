/**
 * StaticProfileTemplates — Fast-Path Analytical Mesh Generators for Parametric Profiles.
 *
 * Implements hard-normal faceted solids for architectural beams, columns, and rectangular ducts:
 * - Direct TypedArray generation with zero PolyMesh / BRep / half-edge allocations.
 * - Exact hard face normals (prevents Gouraud/Phong normal bleeding across 90-degree creases).
 * - Exact perimeter feature edges for clean technical sketch outlines.
 * - Single-pass SIMD-friendly scalar loops with V8 mechanical sympathy.
 */

import { GeometryTolerance } from '../math/GeometryTolerance';
import type { DirectMeshBuffers } from './DirectCylinderGenerator';

export class StaticProfileTemplates {
  /**
   * Generates a 6-sided solid rectangular box with hard face normals and 12 feature edges.
   *
   * @param xDim Width (meters)
   * @param yDim Height (meters)
   * @param depth Extrusion length along Z (meters)
   * @param origin2D Optional 2D center offset [x, y]
   * @param dir Extrusion direction vector [dx, dy, dz] (default: [0, 0, 1])
   */
  public static generateBox(
    xDim: number,
    yDim: number,
    depth: number,
    origin2D?: [number, number],
    dir?: [number, number, number]
  ): DirectMeshBuffers | null {
    if (xDim <= GeometryTolerance.MATH_EPSILON || yDim <= GeometryTolerance.MATH_EPSILON || depth <= GeometryTolerance.MIN_EDGE_LENGTH) {
      return null;
    }

    const ox = origin2D ? origin2D[0] : 0;
    const oy = origin2D ? origin2D[1] : 0;

    const hx = xDim * 0.5;
    const hy = yDim * 0.5;

    const x0 = ox - hx;
    const x1 = ox + hx;
    const y0 = oy - hy;
    const y1 = oy + hy;

    let dx = 0, dy = 0, dz = 1;
    if (dir) {
      const lenSq = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
      if (lenSq > 1e-12) {
        const invLen = 1.0 / Math.sqrt(lenSq);
        dx = dir[0] * invLen;
        dy = dir[1] * invLen;
        dz = dir[2] * invLen;
      }
    }

    const ex = dx * depth;
    const ey = dy * depth;
    const ez = dz * depth;
    const isNegZ = dz < 0;
    const signZ = isNegZ ? -1 : 1;

    // 6 faces * 4 vertices = 24 vertices
    // 6 faces * 2 triangles * 3 = 36 indices
    // 12 edges * 2 * 3 = 72 floats
    const positions = new Float32Array(24 * 3);
    const normals = new Float32Array(24 * 3);
    const indices = new Uint32Array(36);
    const edgesBuffer = new Float32Array(72);

    let vOff = 0;
    let iOff = 0;
    let eOff = 0;

    const addQuad = (
      p0x: number, p0y: number, p0z: number,
      p1x: number, p1y: number, p1z: number,
      p2x: number, p2y: number, p2z: number,
      p3x: number, p3y: number, p3z: number,
      nx: number, ny: number, nz: number,
      flipWinding: boolean
    ) => {
      const baseV = vOff / 3;

      positions[vOff] = p0x;     positions[vOff + 1] = p0y;     positions[vOff + 2] = p0z;
      normals[vOff] = nx;        normals[vOff + 1] = ny;        normals[vOff + 2] = nz;
      vOff += 3;

      positions[vOff] = p1x;     positions[vOff + 1] = p1y;     positions[vOff + 2] = p1z;
      normals[vOff] = nx;        normals[vOff + 1] = ny;        normals[vOff + 2] = nz;
      vOff += 3;

      positions[vOff] = p2x;     positions[vOff + 1] = p2y;     positions[vOff + 2] = p2z;
      normals[vOff] = nx;        normals[vOff + 1] = ny;        normals[vOff + 2] = nz;
      vOff += 3;

      positions[vOff] = p3x;     positions[vOff + 1] = p3y;     positions[vOff + 2] = p3z;
      normals[vOff] = nx;        normals[vOff + 1] = ny;        normals[vOff + 2] = nz;
      vOff += 3;

      if (!flipWinding) {
        // CCW Triangle 1: 0, 1, 2
        indices[iOff++] = baseV;
        indices[iOff++] = baseV + 1;
        indices[iOff++] = baseV + 2;

        // CCW Triangle 2: 0, 2, 3
        indices[iOff++] = baseV;
        indices[iOff++] = baseV + 2;
        indices[iOff++] = baseV + 3;
      } else {
        // Flipped Triangle 1: 0, 2, 1
        indices[iOff++] = baseV;
        indices[iOff++] = baseV + 2;
        indices[iOff++] = baseV + 1;

        // Flipped Triangle 2: 0, 3, 2
        indices[iOff++] = baseV;
        indices[iOff++] = baseV + 3;
        indices[iOff++] = baseV + 2;
      }
    };

    const tx0 = x0 + ex;
    const tx1 = x1 + ex;
    const ty0 = y0 + ey;
    const ty1 = y1 + ey;

    // 1. Bottom Face (z = 0, outward normal: (0, 0, -signZ))
    // (x0,y0,0)->(x0,y1,0)->(x1,y1,0)->(x1,y0,0) has cross product (0, 0, -Area)
    addQuad(x0, y0, 0,  x0, y1, 0,  x1, y1, 0,  x1, y0, 0,  0, 0, -signZ, isNegZ);

    // 2. Top Face (z = ez, outward normal: (0, 0, +signZ))
    // (tx0,ty0,ez)->(tx1,ty0,ez)->(tx1,ty1,ez)->(tx0,ty1,ez) has cross product (0, 0, +Area)
    addQuad(tx0, ty0, ez,  tx1, ty0, ez,  tx1, ty1, ez,  tx0, ty1, ez,  0, 0, signZ, isNegZ);

    // 3. Front Face (y = y0, outward normal: -Y)
    // (x0,y0,0)->(x1,y0,0)->(tx1,ty0,ez)->(tx0,ty0,ez) has cross product (0, -dx*ez, ...)
    addQuad(x0, y0, 0,  x1, y0, 0,  tx1, ty0, ez,  tx0, ty0, ez,  0, -1, 0, isNegZ);

    // 4. Back Face (y = y1, outward normal: +Y)
    addQuad(x1, y1, 0,  x0, y1, 0,  tx0, ty1, ez,  tx1, ty1, ez,  0, 1, 0, isNegZ);

    // 5. Left Face (x = x0, outward normal: -X)
    addQuad(x0, y1, 0,  x0, y0, 0,  tx0, ty0, ez,  tx0, ty1, ez,  -1, 0, 0, isNegZ);

    // 6. Right Face (x = x1, outward normal: +X)
    addQuad(x1, y0, 0,  x1, y1, 0,  tx1, ty1, ez,  tx1, ty0, ez,  1, 0, 0, isNegZ);

    // 12 Feature Edges (Architectural Silhouette)
    const addEdge = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      edgesBuffer[eOff++] = ax; edgesBuffer[eOff++] = ay; edgesBuffer[eOff++] = az;
      edgesBuffer[eOff++] = bx; edgesBuffer[eOff++] = by; edgesBuffer[eOff++] = bz;
    };

    // Bottom loop
    addEdge(x0, y0, 0,  x1, y0, 0);
    addEdge(x1, y0, 0,  x1, y1, 0);
    addEdge(x1, y1, 0,  x0, y1, 0);
    addEdge(x0, y1, 0,  x0, y0, 0);

    // Top loop
    addEdge(tx0, ty0, ez,  tx1, ty0, ez);
    addEdge(tx1, ty0, ez,  tx1, ty1, ez);
    addEdge(tx1, ty1, ez,  tx0, ty1, ez);
    addEdge(tx0, ty1, ez,  tx0, ty0, ez);

    // 4 Vertical pillars
    addEdge(x0, y0, 0,  tx0, ty0, ez);
    addEdge(x1, y0, 0,  tx1, ty0, ez);
    addEdge(x1, y1, 0,  tx1, ty1, ez);
    addEdge(x0, y1, 0,  tx0, ty1, ez);

    return { positions, normals, indices, edgesBuffer };
  }

  /**
   * Generates a 3D extruded prism with hard face normals and feature edges from a CCW 2D polygon.
   *
   * @param loop2D Closed 2D perimeter points in CCW order [[x0, y0], [x1, y1], ...]
   * @param capTriangles CCW triangulation index triplets [[i0, i1, i2], ...] covering loop2D
   * @param depth Extrusion length along Z (meters)
   * @param origin2D Optional 2D center offset [ox, oy]
   * @param dir Extrusion direction vector [dx, dy, dz] (default: [0, 0, 1])
   */
  public static generatePrismFromPolygon2D(
    loop2D: [number, number][],
    capTriangles: [number, number, number][],
    depth: number,
    origin2D?: [number, number],
    dir?: [number, number, number]
  ): DirectMeshBuffers | null {
    const N = loop2D.length;
    const numCapTris = capTriangles.length;
    if (N < 3 || numCapTris < 1 || depth <= GeometryTolerance.MIN_EDGE_LENGTH) {
      return null;
    }

    const ox = origin2D ? origin2D[0] : 0;
    const oy = origin2D ? origin2D[1] : 0;

    let dx = 0, dy = 0, dz = 1;
    if (dir) {
      const lenSq = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
      if (lenSq > 1e-12) {
        const invLen = 1.0 / Math.sqrt(lenSq);
        dx = dir[0] * invLen;
        dy = dir[1] * invLen;
        dz = dir[2] * invLen;
      }
    }

    const ex = dx * depth;
    const ey = dy * depth;
    const ez = dz * depth;
    const isNegZ = dz < 0;
    const signZ = isNegZ ? -1 : 1;

    // Memory sizing:
    // Bottom cap: N vertices, numCapTris * 3 indices
    // Top cap: N vertices, numCapTris * 3 indices
    // Lateral quads: N faces * 4 vertices = 4N vertices, N faces * 2 tris * 3 = 6N indices
    // Total vertices: N + N + 4N = 6N vertices
    // Total indices: 2 * numCapTris * 3 + 6N = 6 * numCapTris + 6N
    // Total silhouette edges: N (bottom) + N (top) + N (longitudinal) = 3N edges (6N points = 18N floats)
    const totalVertices = 6 * N;
    const totalIndices = 6 * numCapTris + 6 * N;
    const totalEdgeFloats = 18 * N;

    const positions = new Float32Array(totalVertices * 3);
    const normals = new Float32Array(totalVertices * 3);
    const indices = new Uint32Array(totalIndices);
    const edgesBuffer = new Float32Array(totalEdgeFloats);

    let vOff = 0;
    let iOff = 0;
    let eOff = 0;

    // --- 1. Bottom Cap (z = 0, outward normal = [0, 0, -signZ]) ---
    const botBaseVertex = vOff / 3;
    const nBotZ = -signZ;
    for (let k = 0; k < N; k++) {
      const px = loop2D[k][0] + ox;
      const py = loop2D[k][1] + oy;
      positions[vOff]     = px;
      positions[vOff + 1] = py;
      positions[vOff + 2] = 0;
      normals[vOff]       = 0;
      normals[vOff + 1]   = 0;
      normals[vOff + 2]   = nBotZ;
      vOff += 3;
    }
    // Bottom cap triangles
    for (let t = 0; t < numCapTris; t++) {
      const tri = capTriangles[t];
      if (!isNegZ) {
        indices[iOff++] = botBaseVertex + tri[0];
        indices[iOff++] = botBaseVertex + tri[2];
        indices[iOff++] = botBaseVertex + tri[1];
      } else {
        indices[iOff++] = botBaseVertex + tri[0];
        indices[iOff++] = botBaseVertex + tri[1];
        indices[iOff++] = botBaseVertex + tri[2];
      }
    }

    // --- 2. Top Cap (z = ez, outward normal = [0, 0, +signZ]) ---
    const topBaseVertex = vOff / 3;
    const nTopZ = signZ;
    for (let k = 0; k < N; k++) {
      const px = loop2D[k][0] + ox + ex;
      const py = loop2D[k][1] + oy + ey;
      positions[vOff]     = px;
      positions[vOff + 1] = py;
      positions[vOff + 2] = ez;
      normals[vOff]       = 0;
      normals[vOff + 1]   = 0;
      normals[vOff + 2]   = nTopZ;
      vOff += 3;
    }
    // Top cap triangles
    for (let t = 0; t < numCapTris; t++) {
      const tri = capTriangles[t];
      if (!isNegZ) {
        indices[iOff++] = topBaseVertex + tri[0];
        indices[iOff++] = topBaseVertex + tri[1];
        indices[iOff++] = topBaseVertex + tri[2];
      } else {
        indices[iOff++] = topBaseVertex + tri[0];
        indices[iOff++] = topBaseVertex + tri[2];
        indices[iOff++] = topBaseVertex + tri[1];
      }
    }

    // --- 3. Lateral Faces (Hard normals per planar face) ---
    for (let k = 0; k < N; k++) {
      const nextK = (k + 1) % N;
      const p0x = loop2D[k][0] + ox;
      const p0y = loop2D[k][1] + oy;
      const p1x = loop2D[nextK][0] + ox;
      const p1y = loop2D[nextK][1] + oy;

      // 2D outward normal for CCW polygon: (deltaY, -deltaX)
      const dEdgeX = p1x - p0x;
      const dEdgeY = p1y - p0y;
      const edgeLen = Math.sqrt(dEdgeX * dEdgeX + dEdgeY * dEdgeY);
      let nx = 0, ny = 0;
      if (edgeLen > 1e-12) {
        nx = dEdgeY / edgeLen;
        ny = -dEdgeX / edgeLen;
      }

      // If extrusion has non-Z tilt, cross product signZ * ((P1 - P0) x (ex, ey, ez))
      let faceNx = nx;
      let faceNy = ny;
      let faceNz = 0;
      if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
        const cx = dEdgeY * ez * signZ;
        const cy = -dEdgeX * ez * signZ;
        const cz = (dEdgeX * ey - dEdgeY * ex) * signZ;
        const cLen = Math.sqrt(cx * cx + cy * cy + cz * cz);
        if (cLen > 1e-12) {
          faceNx = cx / cLen;
          faceNy = cy / cLen;
          faceNz = cz / cLen;
        }
      }

      const baseV = vOff / 3;

      // V0: P0 at z=0
      positions[vOff]     = p0x;
      positions[vOff + 1] = p0y;
      positions[vOff + 2] = 0;
      normals[vOff]       = faceNx;
      normals[vOff + 1]   = faceNy;
      normals[vOff + 2]   = faceNz;
      vOff += 3;

      // V1: P1 at z=0
      positions[vOff]     = p1x;
      positions[vOff + 1] = p1y;
      positions[vOff + 2] = 0;
      normals[vOff]       = faceNx;
      normals[vOff + 1]   = faceNy;
      normals[vOff + 2]   = faceNz;
      vOff += 3;

      // V2: P1 at z=depth
      positions[vOff]     = p1x + ex;
      positions[vOff + 1] = p1y + ey;
      positions[vOff + 2] = ez;
      normals[vOff]       = faceNx;
      normals[vOff + 1]   = faceNy;
      normals[vOff + 2]   = faceNz;
      vOff += 3;

      // V3: P0 at z=depth
      positions[vOff]     = p0x + ex;
      positions[vOff + 1] = p0y + ey;
      positions[vOff + 2] = ez;
      normals[vOff]       = faceNx;
      normals[vOff + 1]   = faceNy;
      normals[vOff + 2]   = faceNz;
      vOff += 3;

      if (!isNegZ) {
        // Triangle 1: V0, V1, V2
        indices[iOff++] = baseV;
        indices[iOff++] = baseV + 1;
        indices[iOff++] = baseV + 2;

        // Triangle 2: V0, V2, V3
        indices[iOff++] = baseV;
        indices[iOff++] = baseV + 2;
        indices[iOff++] = baseV + 3;
      } else {
        // Flipped Triangle 1: V0, V2, V1
        indices[iOff++] = baseV;
        indices[iOff++] = baseV + 2;
        indices[iOff++] = baseV + 1;

        // Flipped Triangle 2: V0, V3, V2
        indices[iOff++] = baseV;
        indices[iOff++] = baseV + 3;
        indices[iOff++] = baseV + 2;
      }
    }

    // --- 4. Architectural Silhouette Feature Edges ---
    // Bottom perimeter edges
    for (let k = 0; k < N; k++) {
      const nextK = (k + 1) % N;
      edgesBuffer[eOff++] = loop2D[k][0] + ox;
      edgesBuffer[eOff++] = loop2D[k][1] + oy;
      edgesBuffer[eOff++] = 0;
      edgesBuffer[eOff++] = loop2D[nextK][0] + ox;
      edgesBuffer[eOff++] = loop2D[nextK][1] + oy;
      edgesBuffer[eOff++] = 0;
    }
    // Top perimeter edges
    for (let k = 0; k < N; k++) {
      const nextK = (k + 1) % N;
      edgesBuffer[eOff++] = loop2D[k][0] + ox + ex;
      edgesBuffer[eOff++] = loop2D[k][1] + oy + ey;
      edgesBuffer[eOff++] = ez;
      edgesBuffer[eOff++] = loop2D[nextK][0] + ox + ex;
      edgesBuffer[eOff++] = loop2D[nextK][1] + oy + ey;
      edgesBuffer[eOff++] = ez;
    }
    // Longitudinal pillar edges (filtered by dihedral crease threshold)
    const latVertexStart = 2 * N;
    for (let k = 0; k < N; k++) {
      const prevK = (k - 1 + N) % N;
      const nPrevOff = (latVertexStart + prevK * 4) * 3;
      const nCurrOff = (latVertexStart + k * 4) * 3;
      const dot =
        normals[nPrevOff] * normals[nCurrOff] +
        normals[nPrevOff + 1] * normals[nCurrOff + 1] +
        normals[nPrevOff + 2] * normals[nCurrOff + 2];
      if (dot < GeometryTolerance.COS_CREASE_THRESHOLD) {
        edgesBuffer[eOff++] = loop2D[k][0] + ox;
        edgesBuffer[eOff++] = loop2D[k][1] + oy;
        edgesBuffer[eOff++] = 0;
        edgesBuffer[eOff++] = loop2D[k][0] + ox + ex;
        edgesBuffer[eOff++] = loop2D[k][1] + oy + ey;
        edgesBuffer[eOff++] = ez;
      }
    }

    return {
      positions,
      normals,
      indices,
      edgesBuffer: eOff === edgesBuffer.length ? edgesBuffer : edgesBuffer.subarray(0, eOff),
    };
  }

  /**
   * Generates an I-Beam (IFCISHAPEPROFILEDEF) solid with exact hard normals and silhouette edges.
   */
  public static generateIShapeBeam(
    overallWidth: number,
    overallDepth: number,
    webThickness: number,
    flangeThickness: number,
    depth: number,
    origin2D?: [number, number],
    dir?: [number, number, number]
  ): DirectMeshBuffers | null {
    if (
      overallWidth <= GeometryTolerance.MATH_EPSILON ||
      overallDepth <= GeometryTolerance.MATH_EPSILON ||
      webThickness <= GeometryTolerance.MATH_EPSILON ||
      flangeThickness <= GeometryTolerance.MATH_EPSILON ||
      depth <= GeometryTolerance.MIN_EDGE_LENGTH ||
      webThickness >= overallWidth ||
      flangeThickness * 2 >= overallDepth
    ) {
      return null;
    }

    const w2 = overallWidth * 0.5;
    const d2 = overallDepth * 0.5;
    const tw2 = webThickness * 0.5;
    const yFb = -d2 + flangeThickness;
    const yFt = d2 - flangeThickness;

    // 12 CCW perimeter vertices
    const loop2D: [number, number][] = [
      [-w2, -d2],   // 0
      [w2, -d2],    // 1
      [w2, yFb],    // 2
      [tw2, yFb],   // 3
      [tw2, yFt],   // 4
      [w2, yFt],    // 5
      [w2, d2],     // 6
      [-w2, d2],    // 7
      [-w2, yFt],   // 8
      [-tw2, yFt],  // 9
      [-tw2, yFb],  // 10
      [-w2, yFb],   // 11
    ];

    // Canonical 10 CCW cap triangles
    const capTriangles: [number, number, number][] = [
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 10],
      [0, 10, 11],
      [10, 3, 4],
      [10, 4, 9],
      [7, 8, 9],
      [7, 9, 4],
      [7, 4, 5],
      [7, 5, 6],
    ];

    return StaticProfileTemplates.generatePrismFromPolygon2D(loop2D, capTriangles, depth, origin2D, dir);
  }

  /**
   * Generates an L-Shape angle profile (IFCLSHAPEPROFILEDEF) solid.
   */
  public static generateLShapeBeam(
    width: number,
    overallDepth: number,
    thickness: number,
    depth: number,
    origin2D?: [number, number],
    dir?: [number, number, number]
  ): DirectMeshBuffers | null {
    if (
      width <= GeometryTolerance.MATH_EPSILON ||
      overallDepth <= GeometryTolerance.MATH_EPSILON ||
      thickness <= GeometryTolerance.MATH_EPSILON ||
      depth <= GeometryTolerance.MIN_EDGE_LENGTH ||
      thickness >= width ||
      thickness >= overallDepth
    ) {
      return null;
    }

    const b2 = width * 0.5;
    const h2 = overallDepth * 0.5;

    // 6 CCW perimeter vertices
    const loop2D: [number, number][] = [
      [-b2, -h2],             // 0
      [b2, -h2],              // 1
      [b2, -h2 + thickness],  // 2
      [-b2 + thickness, -h2 + thickness], // 3
      [-b2 + thickness, h2],  // 4
      [-b2, h2],              // 5
    ];

    // 4 CCW cap triangles
    const capTriangles: [number, number, number][] = [
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 4],
      [0, 4, 5],
    ];

    return StaticProfileTemplates.generatePrismFromPolygon2D(loop2D, capTriangles, depth, origin2D, dir);
  }

  /**
   * Generates a T-Shape tee profile (IFCTSHAPEPROFILEDEF) solid.
   */
  public static generateTShapeBeam(
    flangeWidth: number,
    overallDepth: number,
    webThickness: number,
    flangeThickness: number,
    depth: number,
    origin2D?: [number, number],
    dir?: [number, number, number]
  ): DirectMeshBuffers | null {
    if (
      flangeWidth <= GeometryTolerance.MATH_EPSILON ||
      overallDepth <= GeometryTolerance.MATH_EPSILON ||
      webThickness <= GeometryTolerance.MATH_EPSILON ||
      flangeThickness <= GeometryTolerance.MATH_EPSILON ||
      depth <= GeometryTolerance.MIN_EDGE_LENGTH ||
      webThickness >= flangeWidth ||
      flangeThickness >= overallDepth
    ) {
      return null;
    }

    const b2 = flangeWidth * 0.5;
    const h2 = overallDepth * 0.5;
    const w2 = webThickness * 0.5;
    const yFt = h2 - flangeThickness;

    // 8 CCW perimeter vertices
    const loop2D: [number, number][] = [
      [-w2, -h2], // 0
      [w2, -h2],  // 1
      [w2, yFt],  // 2
      [b2, yFt],  // 3
      [b2, h2],   // 4
      [-b2, h2],  // 5
      [-b2, yFt], // 6
      [-w2, yFt], // 7
    ];

    // 6 CCW cap triangles
    const capTriangles: [number, number, number][] = [
      [0, 1, 2],
      [0, 2, 7],
      [7, 2, 4],
      [2, 3, 4],
      [7, 4, 5],
      [7, 5, 6],
    ];

    return StaticProfileTemplates.generatePrismFromPolygon2D(loop2D, capTriangles, depth, origin2D, dir);
  }

  /**
   * Generates a U-Shape channel profile (IFCUSHAPEPROFILEDEF / IFCCSHAPEPROFILEDEF) solid.
   */
  public static generateUShapeBeam(
    flangeWidth: number,
    overallDepth: number,
    webThickness: number,
    flangeThickness: number,
    depth: number,
    origin2D?: [number, number],
    dir?: [number, number, number]
  ): DirectMeshBuffers | null {
    if (
      flangeWidth <= GeometryTolerance.MATH_EPSILON ||
      overallDepth <= GeometryTolerance.MATH_EPSILON ||
      webThickness <= GeometryTolerance.MATH_EPSILON ||
      flangeThickness <= GeometryTolerance.MATH_EPSILON ||
      depth <= GeometryTolerance.MIN_EDGE_LENGTH ||
      webThickness >= flangeWidth ||
      flangeThickness * 2 >= overallDepth
    ) {
      return null;
    }

    const b2 = flangeWidth * 0.5;
    const h2 = overallDepth * 0.5;

    // 8 CCW perimeter vertices
    const loop2D: [number, number][] = [
      [-b2, -h2],                 // 0
      [b2, -h2],                  // 1
      [b2, -h2 + flangeThickness],// 2
      [-b2 + webThickness, -h2 + flangeThickness], // 3
      [-b2 + webThickness, h2 - flangeThickness],  // 4
      [b2, h2 - flangeThickness], // 5
      [b2, h2],                   // 6
      [-b2, h2],                  // 7
    ];

    // 6 CCW cap triangles
    const capTriangles: [number, number, number][] = [
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 4],
      [0, 4, 7],
      [7, 4, 5],
      [7, 5, 6],
    ];

    return StaticProfileTemplates.generatePrismFromPolygon2D(loop2D, capTriangles, depth, origin2D, dir);
  }
}
