/**
 * DirectCylinderGenerator — High-Performance Analytical Cylinder and Pipe Generator.
 *
 * Implements mechanical sympathy with V8 (Turboshaft):
 * - Scalar 64-bit local variable arithmetic (zero intermediate object allocations).
 * - Analytical orthonormal basis by Frisvad and Duff (zero branch singularities, zero trigonometry).
 * - Static precalculated sin/cos LUT in Float64Array.
 * - Dynamic continuous LOD by physical world radius (prevents polygon faceting on zoom).
 * - Continuous analytical normals (perfect Phong/Blinn smooth shading).
 * - Strict angular safety guard for half-space plane clippings (returns fallback on near-parallel planes).
 * - Canonical Croquera Y-up basis transformation (det = +1, strictly preserving face winding).
 */

import * as THREE from 'three';
import { GeometryTolerance } from '../math/GeometryTolerance';

export interface CylinderSpec {
  p0: [number, number, number]; // Start point in solid local coordinates (or world if untransformed)
  p1: [number, number, number]; // End point
  radius: number;               // Outer radius (meters)
  innerRadius?: number;         // Optional inner radius
  hasStartCap?: boolean;        // Whether start face (z=0) is capped (default: true)
  hasEndCap?: boolean;          // Whether end face (z=L) is capped (default: true)
  clippingPlane?: {
    point: [number, number, number];  // Anchor point on clipping plane
    normal: [number, number, number]; // Normal pointing towards discarded half-space
  };
}

export interface DirectMeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edgesBuffer?: Float32Array;
}

// 1. Static trigonometric lookup tables (Float64Array for FLOAT64_ELEMENTS in V8)
const COS_LUT_8 = new Float64Array(8);
const SIN_LUT_8 = new Float64Array(8);
const COS_LUT_12 = new Float64Array(12);
const SIN_LUT_12 = new Float64Array(12);
const COS_LUT_16 = new Float64Array(16);
const SIN_LUT_16 = new Float64Array(16);

for (let i = 0; i < 8; i++) {
  const theta = (i * 2.0 * Math.PI) / 8.0;
  COS_LUT_8[i] = Math.cos(theta);
  SIN_LUT_8[i] = Math.sin(theta);
}
for (let i = 0; i < 12; i++) {
  const theta = (i * 2.0 * Math.PI) / 12.0;
  COS_LUT_12[i] = Math.cos(theta);
  SIN_LUT_12[i] = Math.sin(theta);
}
for (let i = 0; i < 16; i++) {
  const theta = (i * 2.0 * Math.PI) / 16.0;
  COS_LUT_16[i] = Math.cos(theta);
  SIN_LUT_16[i] = Math.sin(theta);
}

// Angular safety threshold: cos(10 deg) ~ 0.1736. Near-parallel clips fallback to CSG.
const MIN_CLIP_COS = 0.15;

export class DirectCylinderGenerator {
  /**
   * Evaluates the optimal radial segment count based on physical radius in meters.
   * Mitigates Risk R-1 (Faceting / Loss of visual curvature on zoom-in).
   */
  public static getAdaptiveSegments(radius: number): 8 | 12 | 16 {
    if (radius < 0.05) return 8;       // Small pipes (< 50mm): 8 segments (efficient, sharp)
    if (radius < 0.20) return 12;      // Standard pipes/ducts (50mm - 200mm): 12 segments
    return 16;                         // Large mains, headers, tanks (> 200mm): 16 segments
  }

  /**
   * Computes an affine 4x4 matrix mapping a unit canonical cylinder (r=1, h=1, Z in [0, 1])
   * to a cylinder from p0 to p1 with radius r, applying Frisvad-Duff orthonormal basis.
   *
   * @param p0 Start point [x, y, z]
   * @param p1 End point [x, y, z]
   * @param radius Outer radius in meters
   * @param target Optional target Float32Array (length >= 16) or THREE.Matrix4
   */
  public static computeInstanceMatrix(
    p0: [number, number, number],
    p1: [number, number, number],
    radius: number,
    target?: THREE.Matrix4 | Float32Array
  ): THREE.Matrix4 {
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const dz = p1[2] - p0[2];
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const m = target instanceof THREE.Matrix4 ? target : new THREE.Matrix4();
    if (length <= GeometryTolerance.MIN_EDGE_LENGTH || radius <= GeometryTolerance.MATH_EPSILON) {
      m.identity();
      return m;
    }

    const invL = 1.0 / length;
    const wx = dx * invL;
    const wy = dy * invL;
    const wz = dz * invL;

    // Frisvad and Duff branchless orthonormal basis
    let ux: number, uy: number, uz: number;
    let vx: number, vy: number, vz: number;

    if (wz < -0.9999999) {
      ux = 0.0;
      uy = -1.0;
      uz = 0.0;
      vx = -1.0;
      vy = 0.0;
      vz = 0.0;
    } else {
      const a = 1.0 / (1.0 + wz);
      const b = -wx * wy * a;
      ux = 1.0 - wx * wx * a;
      uy = b;
      uz = -wx;
      vx = b;
      vy = 1.0 - wy * wy * a;
      vz = -wy;
    }

    // Basis matrix scaled by radius (u, v) and length (w), translated to p0
    // [ ux*r, vx*r, wx*L, p0x ]
    // [ uy*r, vy*r, wy*L, p0y ]
    // [ uz*r, vz*r, wz*L, p0z ]
    // [ 0,    0,    0,    1   ]
    m.set(
      ux * radius, vx * radius, wx * length, p0[0],
      uy * radius, vy * radius, wy * length, p0[1],
      uz * radius, vz * radius, wz * length, p0[2],
      0.0,         0.0,         0.0,         1.0
    );

    if (target && !(target instanceof THREE.Matrix4)) {
      m.toArray(target);
    }
    return m;
  }

  /**
   * Generates direct TypedArrays for a cylinder, with continuous smooth normals,
   * adaptive segments, analytical half-space clipping and watertight end caps.
   */
  public static generateMesh(spec: CylinderSpec): DirectMeshBuffers | null {
    const { p0, p1, radius } = spec;
    if (radius <= GeometryTolerance.MATH_EPSILON) return null;

    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const dz = p1[2] - p0[2];
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length <= GeometryTolerance.MIN_EDGE_LENGTH) return null;

    const invL = 1.0 / length;
    const wx = dx * invL;
    const wy = dy * invL;
    const wz = dz * invL;

    // Frisvad-Duff orthonormal basis
    let ux: number, uy: number, uz: number;
    let vx: number, vy: number, vz: number;

    if (wz < -0.9999999) {
      ux = 0.0;
      uy = -1.0;
      uz = 0.0;
      vx = -1.0;
      vy = 0.0;
      vz = 0.0;
    } else {
      const a = 1.0 / (1.0 + wz);
      const b = -wx * wy * a;
      ux = 1.0 - wx * wx * a;
      uy = b;
      uz = -wx;
      vx = b;
      vy = 1.0 - wy * wy * a;
      vz = -wy;
    }

    const segments = this.getAdaptiveSegments(radius);
    const cosLut = segments === 8 ? COS_LUT_8 : segments === 12 ? COS_LUT_12 : COS_LUT_16;
    const sinLut = segments === 8 ? SIN_LUT_8 : segments === 12 ? SIN_LUT_12 : SIN_LUT_16;

    // Check analytical clipping plane if provided (Mitigates Risk R-3)
    let clipZ: Float64Array | null = null;
    if (spec.clippingPlane) {
      const { point: cp, normal: cn } = spec.clippingPlane;
      const cnLength = Math.sqrt(cn[0] * cn[0] + cn[1] * cn[1] + cn[2] * cn[2]);
      if (cnLength > 1e-6) {
        const nx = cn[0] / cnLength;
        const ny = cn[1] / cnLength;
        const nz = cn[2] / cnLength;
        const wDotN = wx * nx + wy * ny + wz * nz;

        // If plane is near-parallel to cylinder axis (|w . n| < 0.15), fallback is required
        if (Math.abs(wDotN) < MIN_CLIP_COS) {
          return null; // Fallback signal to full CSG
        }

        const invWDotN = 1.0 / wDotN;
        clipZ = new Float64Array(segments);

        for (let i = 0; i < segments; i++) {
          const c = cosLut[i] * radius;
          const s = sinLut[i] * radius;
          const px = p0[0] + ux * c + vx * s;
          const py = p0[1] + uy * c + vy * s;
          const pz = p0[2] + uz * c + vz * s;

          const toPlaneX = cp[0] - px;
          const toPlaneY = cp[1] - py;
          const toPlaneZ = cp[2] - pz;
          const dist = toPlaneX * nx + toPlaneY * ny + toPlaneZ * nz;
          const zIntercept = dist * invWDotN;

          // If intercept is too wildly out of bounds, fallback to full CSG
          if (zIntercept < -0.2 * length || zIntercept > 1.2 * length) {
            return null;
          }
          clipZ[i] = zIntercept;
        }
      }
    }

    const hasStartCap = spec.hasStartCap !== false;
    const hasEndCap = spec.hasEndCap !== false;

    // Budget vertex and triangle counts
    // Lateral: 2 * segments vertices, segments * 2 triangles
    // Start cap: (segments + 1) vertices or fan from base, (segments - 2) triangles
    // End cap: (segments + 1) vertices, (segments - 2) triangles
    const numSideVerts = segments * 2;
    const numCapVerts = (hasStartCap ? segments : 0) + (hasEndCap ? segments : 0);
    const totalVerts = numSideVerts + numCapVerts;

    const numSideTris = segments * 2;
    const numCapTris = (hasStartCap ? segments - 2 : 0) + (hasEndCap ? segments - 2 : 0);
    const totalIndices = (numSideTris + numCapTris) * 3;

    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    const indices = new Uint32Array(totalIndices);

    // 1. Generate Lateral Surface (with continuous analytical normals — Mitigates Risk R-1)
    let vOffset = 0;
    for (let i = 0; i < segments; i++) {
      const c = cosLut[i];
      const s = sinLut[i];

      // Unit normal in radial direction
      const nx = ux * c + vx * s;
      const ny = uy * c + vy * s;
      const nz = uz * c + vz * s;

      const radX = nx * radius;
      const radY = ny * radius;
      const radZ = nz * radius;

      const zTop = clipZ ? clipZ[i] : length;

      // Bottom vertex (index 2*i)
      const bIdx = (vOffset + i * 2) * 3;
      positions[bIdx] = p0[0] + radX;
      positions[bIdx + 1] = p0[1] + radY;
      positions[bIdx + 2] = p0[2] + radZ;
      normals[bIdx] = nx;
      normals[bIdx + 1] = ny;
      normals[bIdx + 2] = nz;

      // Top vertex (index 2*i + 1)
      const tIdx = bIdx + 3;
      positions[tIdx] = p0[0] + radX + wx * zTop;
      positions[tIdx + 1] = p0[1] + radY + wy * zTop;
      positions[tIdx + 2] = p0[2] + radZ + wz * zTop;
      normals[tIdx] = nx;
      normals[tIdx + 1] = ny;
      normals[tIdx + 2] = nz;
    }

    // Lateral Triangles
    let iOffset = 0;
    const segMask = segments === 8 ? 7 : segments === 12 ? 11 : 15;
    const useBitmask = segments === 8 || segments === 16;

    for (let i = 0; i < segments; i++) {
      const next = useBitmask ? (i + 1) & segMask : (i + 1) % segments;
      const b0 = i * 2;
      const t0 = b0 + 1;
      const b1 = next * 2;
      const t1 = b1 + 1;

      // Triangle 1: b0, b1, t0
      indices[iOffset++] = b0;
      indices[iOffset++] = b1;
      indices[iOffset++] = t0;

      // Triangle 2: b1, t1, t0
      indices[iOffset++] = b1;
      indices[iOffset++] = t1;
      indices[iOffset++] = t0;
    }

    vOffset += numSideVerts;

    // 2. Start Cap (z = 0, normal points along -w — Mitigates Risk R-2)
    if (hasStartCap) {
      const capStartV = vOffset;
      for (let i = 0; i < segments; i++) {
        const c = cosLut[i] * radius;
        const s = sinLut[i] * radius;
        const idx = (vOffset + i) * 3;
        positions[idx] = p0[0] + ux * c + vx * s;
        positions[idx + 1] = p0[1] + uy * c + vy * s;
        positions[idx + 2] = p0[2] + uz * c + vz * s;
        normals[idx] = -wx;
        normals[idx + 1] = -wy;
        normals[idx + 2] = -wz;
      }

      // Fan triangulation from vertex 0 (oriented clockwise for -w)
      for (let i = 1; i < segments - 1; i++) {
        indices[iOffset++] = capStartV;
        indices[iOffset++] = capStartV + i + 1;
        indices[iOffset++] = capStartV + i;
      }
      vOffset += segments;
    }

    // 3. End Cap (z = L or clipZ, normal points along +w — Mitigates Risk R-2)
    if (hasEndCap) {
      const capEndV = vOffset;
      for (let i = 0; i < segments; i++) {
        const c = cosLut[i] * radius;
        const s = sinLut[i] * radius;
        const zTop = clipZ ? clipZ[i] : length;
        const idx = (vOffset + i) * 3;
        positions[idx] = p0[0] + ux * c + vx * s + wx * zTop;
        positions[idx + 1] = p0[1] + uy * c + vy * s + wy * zTop;
        positions[idx + 2] = p0[2] + uz * c + vz * s + wz * zTop;
        normals[idx] = wx;
        normals[idx + 1] = wy;
        normals[idx + 2] = wz;
      }

      // Fan triangulation from vertex 0 (oriented counter-clockwise for +w)
      for (let i = 1; i < segments - 1; i++) {
        indices[iOffset++] = capEndV;
        indices[iOffset++] = capEndV + i;
        indices[iOffset++] = capEndV + i + 1;
      }
    }

    // 4. Feature edge extraction for architectural outlines & circle silhouettes
    const numEdgeRings = (hasStartCap ? segments : 0) + (hasEndCap ? segments : 0);
    const edgesBuffer = new Float32Array(numEdgeRings * 6);
    let eOffset = 0;

    if (hasStartCap) {
      for (let i = 0; i < segments; i++) {
        const next = useBitmask ? (i + 1) & segMask : (i + 1) % segments;
        const b0 = (i * 2) * 3;
        const b1 = (next * 2) * 3;
        edgesBuffer[eOffset++] = positions[b0];
        edgesBuffer[eOffset++] = positions[b0 + 1];
        edgesBuffer[eOffset++] = positions[b0 + 2];
        edgesBuffer[eOffset++] = positions[b1];
        edgesBuffer[eOffset++] = positions[b1 + 1];
        edgesBuffer[eOffset++] = positions[b1 + 2];
      }
    }

    if (hasEndCap) {
      for (let i = 0; i < segments; i++) {
        const next = useBitmask ? (i + 1) & segMask : (i + 1) % segments;
        const t0 = (i * 2 + 1) * 3;
        const t1 = (next * 2 + 1) * 3;
        edgesBuffer[eOffset++] = positions[t0];
        edgesBuffer[eOffset++] = positions[t0 + 1];
        edgesBuffer[eOffset++] = positions[t0 + 2];
        edgesBuffer[eOffset++] = positions[t1];
        edgesBuffer[eOffset++] = positions[t1 + 1];
        edgesBuffer[eOffset++] = positions[t1 + 2];
      }
    }

    return { positions, normals, indices, edgesBuffer };
  }

  /**
   * Transforms raw mesh buffers by an affine matrix and applies Croquera's
   * canonical Z-up to Y-up coordinate swap: (X_croq = px, Y_croq = pz, Z_croq = -py).
   * Operates completely in-place on Float32Array / Uint32Array with zero GC allocations.
   *
   * @param buffers The DirectMeshBuffers to transform in-place.
   * @param matrix Affine 4x4 transformation matrix.
   */
  public static applyTransformAndCanonicalSwap(buffers: DirectMeshBuffers, matrix: THREE.Matrix4): void {
    const el = matrix.elements;
    const det = matrix.determinant();
    const isFlipped = det < 0;

    const positions = buffers.positions;
    const normals = buffers.normals;
    const indices = buffers.indices;
    const edges = buffers.edgesBuffer;

    const numVerts = positions.length / 3;

    // 1. Transform positions & apply canonical Croquera swap
    for (let i = 0; i < numVerts; i++) {
      const idx = i * 3;
      const x = positions[idx];
      const y = positions[idx + 1];
      const z = positions[idx + 2];

      const px = el[0] * x + el[4] * y + el[8] * z + el[12];
      const py = el[1] * x + el[5] * y + el[9] * z + el[13];
      const pz = el[2] * x + el[6] * y + el[10] * z + el[14];

      positions[idx] = px;
      positions[idx + 1] = pz;
      positions[idx + 2] = -py;
    }

    // 2. Transform normals (linear upper 3x3), normalize & apply canonical swap
    for (let i = 0; i < numVerts; i++) {
      const idx = i * 3;
      const nx = normals[idx];
      const ny = normals[idx + 1];
      const nz = normals[idx + 2];

      let pnx = el[0] * nx + el[4] * ny + el[8] * nz;
      let pny = el[1] * nx + el[5] * ny + el[9] * nz;
      let pnz = el[2] * nx + el[6] * ny + el[10] * nz;

      const lenSq = pnx * pnx + pny * pny + pnz * pnz;
      if (lenSq > 1e-12) {
        const invLen = 1.0 / Math.sqrt(lenSq);
        pnx *= invLen;
        pny *= invLen;
        pnz *= invLen;
      }

      normals[idx] = pnx;
      normals[idx + 1] = pnz;
      normals[idx + 2] = -pny;
    }

    // 3. Invert triangle winding if matrix has negative determinant (reflection)
    if (isFlipped) {
      const numTris = indices.length / 3;
      for (let t = 0; t < numTris; t++) {
        const tIdx = t * 3;
        const tmp = indices[tIdx + 1];
        indices[tIdx + 1] = indices[tIdx + 2];
        indices[tIdx + 2] = tmp;
      }
    }

    // 4. Transform edgesBuffer in-place if present
    if (edges && edges.length > 0) {
      const numEdgePts = edges.length / 3;
      for (let i = 0; i < numEdgePts; i++) {
        const idx = i * 3;
        const ex = edges[idx];
        const ey = edges[idx + 1];
        const ez = edges[idx + 2];

        const px = el[0] * ex + el[4] * ey + el[8] * ez + el[12];
        const py = el[1] * ex + el[5] * ey + el[9] * ez + el[13];
        const pz = el[2] * ex + el[6] * ey + el[10] * ez + el[14];

        edges[idx] = px;
        edges[idx + 1] = pz;
        edges[idx + 2] = -py;
      }
    }
  }

  /**
   * Merges multiple DirectMeshBuffers into a single contiguous DirectMeshBuffers structure.
   * Eliminates fragment explosion and draw call overhead.
   */
  public static mergeDirectBuffers(buffersList: DirectMeshBuffers[]): DirectMeshBuffers | null {
    if (buffersList.length === 0) return null;
    if (buffersList.length === 1) return buffersList[0];

    let totalPosFloats = 0;
    let totalIndices = 0;
    let totalEdgeFloats = 0;

    for (let i = 0; i < buffersList.length; i++) {
      const b = buffersList[i];
      totalPosFloats += b.positions.length;
      totalIndices += b.indices.length;
      if (b.edgesBuffer) totalEdgeFloats += b.edgesBuffer.length;
    }

    const positions = new Float32Array(totalPosFloats);
    const normals = new Float32Array(totalPosFloats);
    const indices = new Uint32Array(totalIndices);
    const edgesBuffer = totalEdgeFloats > 0 ? new Float32Array(totalEdgeFloats) : undefined;

    let posOffset = 0;
    let idxOffset = 0;
    let edgeOffset = 0;
    let vertIndexBase = 0;

    for (let i = 0; i < buffersList.length; i++) {
      const b = buffersList[i];
      const pLen = b.positions.length;
      positions.set(b.positions, posOffset);
      normals.set(b.normals, posOffset);

      const iLen = b.indices.length;
      const bIndices = b.indices;
      for (let j = 0; j < iLen; j++) {
        indices[idxOffset + j] = bIndices[j] + vertIndexBase;
      }

      if (edgesBuffer && b.edgesBuffer) {
        edgesBuffer.set(b.edgesBuffer, edgeOffset);
        edgeOffset += b.edgesBuffer.length;
      }

      posOffset += pLen;
      idxOffset += iLen;
      vertIndexBase += pLen / 3;
    }

    return { positions, normals, indices, edgesBuffer };
  }
}

