/**
 * ToroidTemplateCache — High-Performance Analytical Toroidal Elbow Generator and Quantized Cache.
 *
 * Implements Strategies 1.2 and 1.5 for pipe/duct fittings (IfcRevolvedAreaSolid & curved IfcSweptDiskSolid):
 * - Quantized 32-bit hash key (theta, rho) eliminates redundant tessellation of standardized elbows (90°, 45°).
 * - Exact continuous analytical surface normals: n = (cos(phi)*cos(theta), cos(phi)*sin(theta), sin(phi)).
 * - Watertight end caps and silhouette feature edges for Technical Sketch viewport.
 * - Single-pass SIMD-friendly scalar loops with zero intermediate PolyMesh/CSG allocations.
 */

import { GeometryTolerance } from '../math/GeometryTolerance';
import type { DirectMeshBuffers } from './DirectCylinderGenerator';

export interface ToroidElbowParams {
  pipeRadius: number;
  bendRadius: number; // Curvature radius R (distance from rotation center to tube center)
  sweepAngleRad: number; // Bend angle in radians (e.g. PI/2 for 90°, PI/4 for 45°)
  hasStartCap?: boolean;
  hasEndCap?: boolean;
}

export class ToroidTemplateCache {
  private static canonicalPrototypeCache: Map<number, DirectMeshBuffers | null> = new Map();

  /**
   * Computes a 32-bit integer quantization key for a toroidal elbow.
   *
   * @param sweepAngleRad Sweep angle in radians
   * @param bendRadius Major curvature radius
   * @param pipeRadius Minor tube radius
   */
  public static computeQuantizedKey(sweepAngleRad: number, bendRadius: number, pipeRadius: number): number {
    const angleDeg = Math.round((sweepAngleRad * 180.0) / Math.PI);
    const rho = pipeRadius > GeometryTolerance.MATH_EPSILON ? bendRadius / pipeRadius : 1.0;
    const rhoQuant = Math.round(rho * 100.0) & 0xffff;
    return ((angleDeg & 0xffff) << 16) | rhoQuant;
  }

  /**
   * Generates or retrieves from cache an analytical mesh for a toroidal elbow.
   */
  public static getOrCreateToroidMesh(params: ToroidElbowParams): DirectMeshBuffers | null {
    const { pipeRadius, bendRadius, sweepAngleRad } = params;
    if (
      pipeRadius <= GeometryTolerance.MATH_EPSILON ||
      bendRadius <= GeometryTolerance.MATH_EPSILON ||
      sweepAngleRad <= GeometryTolerance.MATH_EPSILON
    ) {
      return null;
    }

    const key = ToroidTemplateCache.computeQuantizedKey(sweepAngleRad, bendRadius, pipeRadius);
    let cachedProto = ToroidTemplateCache.canonicalPrototypeCache.get(key);

    if (!cachedProto) {
      // Determine adaptive radial & arc segments based on pipe radius (Norma 11/17 / Riesgo R-1)
      const numRadial = pipeRadius < 0.05 ? 8 : (pipeRadius < 0.20 ? 12 : 16);
      const angleDeg = (sweepAngleRad * 180.0) / Math.PI;
      const numArcSteps = Math.max(4, Math.round((angleDeg / 90.0) * (numRadial === 8 ? 8 : 12)));

      cachedProto = ToroidTemplateCache.generateToroidMeshInternal(
        pipeRadius,
        bendRadius,
        sweepAngleRad,
        numRadial,
        numArcSteps,
        params.hasStartCap ?? true,
        params.hasEndCap ?? true
      );
      if (cachedProto) {
        ToroidTemplateCache.canonicalPrototypeCache.set(key, cachedProto);
      }
    }

    if (!cachedProto) return null;

    // Fast clone into fresh typed buffers so caller can apply instance transforms
    return {
      positions: new Float32Array(cachedProto.positions),
      normals: new Float32Array(cachedProto.normals),
      indices: new Uint32Array(cachedProto.indices),
      edgesBuffer: cachedProto.edgesBuffer ? new Float32Array(cachedProto.edgesBuffer) : undefined,
    };
  }

  /**
   * Internal pure mathematical toroidal mesh generator.
   * Torus axis is in the Z plane, bending around the Z axis from (bendRadius, 0, 0) towards +Y.
   */
  private static generateToroidMeshInternal(
    r: number,
    R: number,
    sweepAngle: number,
    numRadial: number,
    numArc: number,
    hasStartCap: boolean,
    hasEndCap: boolean
  ): DirectMeshBuffers | null {
    // LUT for radial circle
    const cosPhi = new Float64Array(numRadial);
    const sinPhi = new Float64Array(numRadial);
    const radStep = (2.0 * Math.PI) / numRadial;
    for (let j = 0; j < numRadial; j++) {
      const phi = j * radStep;
      cosPhi[j] = Math.cos(phi);
      sinPhi[j] = Math.sin(phi);
    }

    // Number of rings = numArc + 1
    const numRings = numArc + 1;
    const bodyVertices = numRings * numRadial;
    const bodyQuads = numArc * numRadial;
    const bodyIndices = bodyQuads * 6;

    const capTris = numRadial - 2;
    const numCaps = (hasStartCap ? 1 : 0) + (hasEndCap ? 1 : 0);
    const capVertices = numCaps * numRadial;
    const capIndices = numCaps * capTris * 3;

    const totalVertices = bodyVertices + capVertices;
    const totalIndices = bodyIndices + capIndices;

    // Feature edges: 2 end rings + 2 silhouette longitudinal rails (outer equator, inner equator)
    const totalEdgePoints = (numCaps * numRadial * 2) + (numArc * 2 * 2);
    const edgesBuffer = new Float32Array(totalEdgePoints * 3);

    const positions = new Float32Array(totalVertices * 3);
    const normals = new Float32Array(totalVertices * 3);
    const indices = new Uint32Array(totalIndices);

    let vOff = 0;
    let iOff = 0;
    let eOff = 0;

    const arcStep = sweepAngle / numArc;

    // 1. Generate Torus Body Ring by Ring
    for (let i = 0; i <= numArc; i++) {
      const theta = i * arcStep;
      const cosTheta = Math.cos(theta);
      const sinTheta = Math.sin(theta);

      // Tube center for this ring
      const cx = R * cosTheta;
      const cy = R * sinTheta;

      for (let j = 0; j < numRadial; j++) {
        const cp = cosPhi[j];
        const sp = sinPhi[j];

        // Normal vector at surface
        const nx = cp * cosTheta;
        const ny = cp * sinTheta;
        const nz = sp;

        // Position at surface: C + r * normal
        const px = cx + r * nx;
        const py = cy + r * ny;
        const pz = r * nz;

        positions[vOff]     = px;
        positions[vOff + 1] = py;
        positions[vOff + 2] = pz;

        normals[vOff]       = nx;
        normals[vOff + 1]   = ny;
        normals[vOff + 2]   = nz;

        vOff += 3;
      }
    }

    // 2. Generate Body Triangle Indices
    for (let i = 0; i < numArc; i++) {
      const ring0 = i * numRadial;
      const ring1 = (i + 1) * numRadial;

      for (let j = 0; j < numRadial; j++) {
        const nextJ = (j + 1) % numRadial;

        const v0 = ring0 + j;
        const v1 = ring0 + nextJ;
        const v2 = ring1 + nextJ;
        const v3 = ring1 + j;

        // Quad triangles
        indices[iOff++] = v0;
        indices[iOff++] = v1;
        indices[iOff++] = v2;

        indices[iOff++] = v0;
        indices[iOff++] = v2;
        indices[iOff++] = v3;
      }
    }

    // 3. Start Cap (theta = 0)
    if (hasStartCap) {
      const capBase = vOff / 3;
      const nStart = [0, -1, 0]; // Outward normal along -Y at theta = 0

      for (let j = 0; j < numRadial; j++) {
        const cp = cosPhi[j];
        const sp = sinPhi[j];
        positions[vOff]     = R + r * cp;
        positions[vOff + 1] = 0;
        positions[vOff + 2] = r * sp;
        normals[vOff]       = nStart[0];
        normals[vOff + 1]   = nStart[1];
        normals[vOff + 2]   = nStart[2];
        vOff += 3;
      }

      // Fan triangulation for start cap
      for (let t = 0; t < capTris; t++) {
        indices[iOff++] = capBase;
        indices[iOff++] = capBase + t + 2;
        indices[iOff++] = capBase + t + 1;
      }

      // Start cap circular feature edges
      for (let j = 0; j < numRadial; j++) {
        const nextJ = (j + 1) % numRadial;
        edgesBuffer[eOff++] = R + r * cosPhi[j];
        edgesBuffer[eOff++] = 0;
        edgesBuffer[eOff++] = r * sinPhi[j];
        edgesBuffer[eOff++] = R + r * cosPhi[nextJ];
        edgesBuffer[eOff++] = 0;
        edgesBuffer[eOff++] = r * sinPhi[nextJ];
      }
    }

    // 4. End Cap (theta = sweepAngle)
    if (hasEndCap) {
      const capBase = vOff / 3;
      const cosT = Math.cos(sweepAngle);
      const sinT = Math.sin(sweepAngle);
      const cx = R * cosT;
      const cy = R * sinT;

      // Outward tangent normal at end of sweep: (-sin(theta), cos(theta), 0)
      const nEndX = -sinT;
      const nEndY = cosT;
      const nEndZ = 0;

      for (let j = 0; j < numRadial; j++) {
        const cp = cosPhi[j];
        const sp = sinPhi[j];
        const px = cx + r * (cp * cosT);
        const py = cy + r * (cp * sinT);
        const pz = r * sp;

        positions[vOff]     = px;
        positions[vOff + 1] = py;
        positions[vOff + 2] = pz;
        normals[vOff]       = nEndX;
        normals[vOff + 1]   = nEndY;
        normals[vOff + 2]   = nEndZ;
        vOff += 3;
      }

      // Fan triangulation for end cap
      for (let t = 0; t < capTris; t++) {
        indices[iOff++] = capBase;
        indices[iOff++] = capBase + t + 1;
        indices[iOff++] = capBase + t + 2;
      }

      // End cap circular feature edges
      for (let j = 0; j < numRadial; j++) {
        const nextJ = (j + 1) % numRadial;
        edgesBuffer[eOff++] = cx + r * (cosPhi[j] * cosT);
        edgesBuffer[eOff++] = cy + r * (cosPhi[j] * sinT);
        edgesBuffer[eOff++] = r * sinPhi[j];
        edgesBuffer[eOff++] = cx + r * (cosPhi[nextJ] * cosT);
        edgesBuffer[eOff++] = cy + r * (cosPhi[nextJ] * sinT);
        edgesBuffer[eOff++] = r * sinPhi[nextJ];
      }
    }

    // Outer & inner equator silhouette rails along the arc
    for (let i = 0; i < numArc; i++) {
      const t0 = i * arcStep;
      const t1 = (i + 1) * arcStep;

      // Outer rail (phi = 0 -> cp = 1, sp = 0)
      edgesBuffer[eOff++] = (R + r) * Math.cos(t0);
      edgesBuffer[eOff++] = (R + r) * Math.sin(t0);
      edgesBuffer[eOff++] = 0;
      edgesBuffer[eOff++] = (R + r) * Math.cos(t1);
      edgesBuffer[eOff++] = (R + r) * Math.sin(t1);
      edgesBuffer[eOff++] = 0;

      // Inner rail (phi = PI -> cp = -1, sp = 0)
      edgesBuffer[eOff++] = (R - r) * Math.cos(t0);
      edgesBuffer[eOff++] = (R - r) * Math.sin(t0);
      edgesBuffer[eOff++] = 0;
      edgesBuffer[eOff++] = (R - r) * Math.cos(t1);
      edgesBuffer[eOff++] = (R - r) * Math.sin(t1);
      edgesBuffer[eOff++] = 0;
    }

    return { positions, normals, indices, edgesBuffer };
  }

  /**
   * Clears the shared memory cache (for benchmark or memory reclamation).
   */
  public static clearCache(): void {
    ToroidTemplateCache.canonicalPrototypeCache.clear();
  }
}
