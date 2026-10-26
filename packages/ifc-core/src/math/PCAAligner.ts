/**
 * PCAAligner — Principal Component Analysis and Canonical Orientation for 3D Meshes.
 *
 * Computes centroid, 3x3 covariance matrix, Jacobi eigendecomposition,
 * rotation-invariant principal moments, sign/handedness disambiguation,
 * and canonical alignment matrices to decouple baked rotations in IFC geometries.
 */

import * as THREE from 'three';
import { GeometryTolerance } from './GeometryTolerance';

export interface PCAResult {
  centroid: [number, number, number];
  eigenvalues: [number, number, number]; // Lambda0 >= Lambda1 >= Lambda2 >= 0
  extents: [number, number, number];     // L0, L1, L2 oriented bounding box extents
  rotationMatrix: THREE.Matrix4;          // R = [e0, e1, e2] in SO(3), det = +1
  sortedDistances: Float32Array;         // Sorted radial distances from centroid
  canonicalSample: Float32Array;         // Stratified canonical coordinates (up to 32 points, 96 floats)
}

export class PCAAligner {
  private static readonly MAX_JACOBI_SWEEPS = 10;
  private static readonly JACOBI_EPSILON = 1e-15;

  /**
   * Computes full PCA analysis on a flat positions buffer [x0, y0, z0, x1, y1, z1, ...].
   */
  public static computePCA(positions: Float32Array): PCAResult {
    const vertexCount = Math.floor(positions.length / 3);
    if (vertexCount === 0) {
      return {
        centroid: [0, 0, 0],
        eigenvalues: [0, 0, 0],
        extents: [0, 0, 0],
        rotationMatrix: new THREE.Matrix4().identity(),
        sortedDistances: new Float32Array(0),
        canonicalSample: new Float32Array(0),
      };
    }

    // 1. Centroid computation (mean of vertex positions)
    let sumX = 0, sumY = 0, sumZ = 0;
    for (let i = 0; i < vertexCount; i++) {
      sumX += positions[i * 3];
      sumY += positions[i * 3 + 1];
      sumZ += positions[i * 3 + 2];
    }
    const invN = 1.0 / vertexCount;
    const cx = sumX * invN;
    const cy = sumY * invN;
    const cz = sumZ * invN;

    // 2. Covariance matrix (3x3 symmetric) and radial distances
    let cxx = 0, cyy = 0, czz = 0;
    let cxy = 0, cxz = 0, cyz = 0;
    const distances = new Float32Array(vertexCount);

    for (let i = 0; i < vertexCount; i++) {
      const qx = positions[i * 3] - cx;
      const qy = positions[i * 3 + 1] - cy;
      const qz = positions[i * 3 + 2] - cz;

      cxx += qx * qx;
      cyy += qy * qy;
      czz += qz * qz;
      cxy += qx * qy;
      cxz += qx * qz;
      cyz += qy * qz;

      distances[i] = Math.hypot(qx, qy, qz);
    }

    distances.sort();

    cxx *= invN;
    cyy *= invN;
    czz *= invN;
    cxy *= invN;
    cxz *= invN;
    cyz *= invN;

    // 3. Jacobi Eigendecomposition of 3x3 symmetric matrix
    // Matrix A: [a00, a01, a02, a10, a11, a12, a20, a21, a22]
    const A = [
      cxx, cxy, cxz,
      cxy, cyy, cyz,
      cxz, cyz, czz,
    ];

    // Eigenvector matrix V initialized to Identity
    const V = [
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ];

    this.jacobiDiagonalize(A, V);

    // Eigenvalues are on the diagonal of A
    const rawEvals = [A[0], A[4], A[8]];
    const rawEvecs = [
      new THREE.Vector3(V[0], V[3], V[6]),
      new THREE.Vector3(V[1], V[4], V[7]),
      new THREE.Vector3(V[2], V[5], V[8]),
    ];

    // 4. Sort eigenvalues descending: lambda0 >= lambda1 >= lambda2
    const indices = [0, 1, 2];
    indices.sort((a, b) => rawEvals[b] - rawEvals[a]);

    const sortedEvals: [number, number, number] = [
      Math.max(0, rawEvals[indices[0]]),
      Math.max(0, rawEvals[indices[1]]),
      Math.max(0, rawEvals[indices[2]]),
    ];

    let e0 = rawEvecs[indices[0]].clone().normalize();
    let e1 = rawEvecs[indices[1]].clone().normalize();

    // 5. Sign disambiguation via 3rd central moment (skewness)
    // s_k = (1/N) * sum((q_i · e_k)^3)
    e0 = this.disambiguateAxisSign(positions, cx, cy, cz, vertexCount, e0);
    e1 = this.disambiguateAxisSign(positions, cx, cy, cz, vertexCount, e1);

    // Ensure e0 and e1 are strictly orthogonal
    e1.sub(e0.clone().multiplyScalar(e0.dot(e1))).normalize();

    // 6. Right-handed coordinate frame: e2 = e0 x e1 (det(R) = +1)
    const e2 = new THREE.Vector3().crossVectors(e0, e1).normalize();

    // 7. Principal extents (OBB dimensions along principal axes)
    let min0 = Infinity, max0 = -Infinity;
    let min1 = Infinity, max1 = -Infinity;
    let min2 = Infinity, max2 = -Infinity;

    for (let i = 0; i < vertexCount; i++) {
      const qx = positions[i * 3] - cx;
      const qy = positions[i * 3 + 1] - cy;
      const qz = positions[i * 3 + 2] - cz;

      const p0 = qx * e0.x + qy * e0.y + qz * e0.z;
      const p1 = qx * e1.x + qy * e1.y + qz * e1.z;
      const p2 = qx * e2.x + qy * e2.y + qz * e2.z;

      if (p0 < min0) min0 = p0;
      if (p0 > max0) max0 = p0;
      if (p1 < min1) min1 = p1;
      if (p1 > max1) max1 = p1;
      if (p2 < min2) min2 = p2;
      if (p2 > max2) max2 = p2;
    }

    const extents: [number, number, number] = [
      max0 - min0,
      max1 - min1,
      max2 - min2,
    ];

    // 8. 4x4 Orthogonal Rotation Matrix R = [e0, e1, e2]
    // In Three.js set(n11, n12, n13, n14, ...), columns are e0, e1, e2:
    const rotationMatrix = new THREE.Matrix4().set(
      e0.x, e1.x, e2.x, 0,
      e0.y, e1.y, e2.y, 0,
      e0.z, e1.z, e2.z, 0,
      0,    0,    0,    1
    );

    // 9. Stratified canonical sample (up to 32 points)
    const sampleCount = Math.min(vertexCount, 32);
    const sampleStep = Math.max(1, Math.floor(vertexCount / sampleCount));
    const canonicalSample = new Float32Array(sampleCount * 3);

    for (let i = 0; i < sampleCount; i++) {
      const vIdx = i * sampleStep;
      const qx = positions[vIdx * 3] - cx;
      const qy = positions[vIdx * 3 + 1] - cy;
      const qz = positions[vIdx * 3 + 2] - cz;

      // Canonical coordinates: p_can = R^T * q
      canonicalSample[i * 3]     = qx * e0.x + qy * e0.y + qz * e0.z;
      canonicalSample[i * 3 + 1] = qx * e1.x + qy * e1.y + qz * e1.z;
      canonicalSample[i * 3 + 2] = qx * e2.x + qy * e2.y + qz * e2.z;
    }

    return {
      centroid: [cx, cy, cz],
      eigenvalues: sortedEvals,
      extents,
      rotationMatrix,
      sortedDistances: distances,
      canonicalSample,
    };
  }

  /**
   * Tests congruence between candidate mesh and prototype, evaluating the 4
   * proper rotation configurations in SO(3) to resolve discrete 180° symmetries.
   * Returns the matching 4x4 rotation matrix for candidate, or null if not congruent.
   */
  public static testCongruence(
    cand: PCAResult,
    protoExtents: [number, number, number],
    protoSortedDistances: Float32Array,
    protoCanonicalSample: Float32Array,
    weld: number = GeometryTolerance.IMPORTED_VERTEX_WELD
  ): THREE.Matrix4 | null {
    // 1. Verify principal extents invariant
    if (Math.abs(cand.extents[0] - protoExtents[0]) > weld) return null;
    if (Math.abs(cand.extents[1] - protoExtents[1]) > weld) return null;
    if (Math.abs(cand.extents[2] - protoExtents[2]) > weld) return null;

    // 2. Verify radial distances distribution
    const numDists = cand.sortedDistances.length;
    if (numDists !== protoSortedDistances.length) return null;

    const step = Math.max(1, Math.floor(numDists / 32));
    for (let i = 0; i < numDists; i += step) {
      if (Math.abs(cand.sortedDistances[i] - protoSortedDistances[i]) > weld) {
        return null;
      }
    }

    // 3. Extract candidate axes from rotation matrix
    const e = cand.rotationMatrix.elements;
    const e0 = new THREE.Vector3(e[0], e[1], e[2]);
    const e1 = new THREE.Vector3(e[4], e[5], e[6]);
    const e2 = new THREE.Vector3(e[8], e[9], e[10]);

    // 4 proper rotation permutations in SO(3) [sign0, sign1, sign2]:
    // (+1, +1, +1), (+1, -1, -1), (-1, +1, -1), (-1, -1, +1)
    const signPermutations: [number, number, number][] = [
      [ 1,  1,  1],
      [ 1, -1, -1],
      [-1,  1, -1],
      [-1, -1,  1],
    ];

    const numSamples = Math.floor(protoCanonicalSample.length / 3);
    const candSampleCount = Math.floor(cand.canonicalSample.length / 3);
    if (numSamples === 0 || candSampleCount === 0) {
      return cand.rotationMatrix;
    }

    for (const [s0, s1, s2] of signPermutations) {
      const testE0 = e0.clone().multiplyScalar(s0);
      const testE1 = e1.clone().multiplyScalar(s1);
      const testE2 = e2.clone().multiplyScalar(s2);

      let matchedAll = true;

      // Verify each candidate sample point mapped under (s0, s1, s2)
      for (let i = 0; i < numSamples; i++) {
        const canX = cand.canonicalSample[i * 3] * s0;
        const canY = cand.canonicalSample[i * 3 + 1] * s1;
        const canZ = cand.canonicalSample[i * 3 + 2] * s2;

        // Check against prototype canonical sample (first check identical index, then nearest)
        const pX = protoCanonicalSample[i * 3];
        const pY = protoCanonicalSample[i * 3 + 1];
        const pZ = protoCanonicalSample[i * 3 + 2];

        const dDirect = Math.hypot(canX - pX, canY - pY, canZ - pZ);
        if (dDirect <= weld) {
          continue;
        }

        // If direct index mismatch, search if any prototype sample point matches
        let foundNearby = false;
        for (let j = 0; j < numSamples; j++) {
          const pjX = protoCanonicalSample[j * 3];
          const pjY = protoCanonicalSample[j * 3 + 1];
          const pjZ = protoCanonicalSample[j * 3 + 2];
          if (Math.hypot(canX - pjX, canY - pjY, canZ - pjZ) <= weld) {
            foundNearby = true;
            break;
          }
        }

        if (!foundNearby) {
          matchedAll = false;
          break;
        }
      }

      if (matchedAll) {
        // Winning rotation matrix
        return new THREE.Matrix4().set(
          testE0.x, testE1.x, testE2.x, 0,
          testE0.y, testE1.y, testE2.y, 0,
          testE0.z, testE1.z, testE2.z, 0,
          0,        0,        0,        1
        );
      }
    }

    return null;
  }

  /**
   * Disambiguates eigenvector sign using 3rd central moment (skewness).
   */
  private static disambiguateAxisSign(
    positions: Float32Array,
    cx: number,
    cy: number,
    cz: number,
    count: number,
    axis: THREE.Vector3
  ): THREE.Vector3 {
    let skew = 0;
    let minProj = Infinity;
    let maxProj = -Infinity;

    for (let i = 0; i < count; i++) {
      const qx = positions[i * 3] - cx;
      const qy = positions[i * 3 + 1] - cy;
      const qz = positions[i * 3 + 2] - cz;

      const proj = qx * axis.x + qy * axis.y + qz * axis.z;
      skew += proj * proj * proj;

      if (proj < minProj) minProj = proj;
      if (proj > maxProj) maxProj = proj;
    }

    if (Math.abs(skew) > 1e-6) {
      return skew < 0 ? axis.negate() : axis;
    }

    // Skewness is zero (symmetric). Disambiguate by projection extent:
    if (Math.abs(maxProj - Math.abs(minProj)) > 1e-4) {
      return maxProj < Math.abs(minProj) ? axis.negate() : axis;
    }

    return axis;
  }

  /**
   * Classical cyclic Jacobi diagonalizer for 3x3 symmetric matrix A.
   * Modifies A (diagonalized in-place) and V (eigenvectors as columns).
   */
  private static jacobiDiagonalize(A: number[], V: number[]): void {
    for (let sweep = 0; sweep < this.MAX_JACOBI_SWEEPS; sweep++) {
      // Check sum of off-diagonal elements
      const offDiag = Math.abs(A[1]) + Math.abs(A[2]) + Math.abs(A[5]);
      if (offDiag < this.JACOBI_EPSILON) {
        break;
      }

      // Sweep through pairs (0,1), (0,2), (1,2)
      this.jacobiRotate(A, V, 0, 1);
      this.jacobiRotate(A, V, 0, 2);
      this.jacobiRotate(A, V, 1, 2);
    }
  }

  private static jacobiRotate(A: number[], V: number[], p: number, q: number): void {
    const apq = A[p * 3 + q];
    if (Math.abs(apq) < this.JACOBI_EPSILON) return;

    const app = A[p * 3 + p];
    const aqq = A[q * 3 + q];
    const tau = (aqq - app) / (2.0 * apq);

    let t: number;
    if (tau >= 0) {
      t = 1.0 / (tau + Math.sqrt(1.0 + tau * tau));
    } else {
      t = -1.0 / (-tau + Math.sqrt(1.0 + tau * tau));
    }

    const c = 1.0 / Math.sqrt(1.0 + t * t);
    const s = t * c;

    // Update diagonal elements
    A[p * 3 + p] = app - t * apq;
    A[q * 3 + q] = aqq + t * apq;
    A[p * 3 + q] = 0;
    A[q * 3 + p] = 0;

    // Update remaining elements (r != p, q)
    const r = 3 - p - q;
    const arp = A[r * 3 + p];
    const arq = A[r * 3 + q];
    const newArp = c * arp - s * arq;
    const newArq = s * arp + c * arq;

    A[r * 3 + p] = newArp;
    A[p * 3 + r] = newArp;
    A[r * 3 + q] = newArq;
    A[q * 3 + r] = newArq;

    // Update eigenvector columns p and q of V
    for (let i = 0; i < 3; i++) {
      const vip = V[i * 3 + p];
      const viq = V[i * 3 + q];
      V[i * 3 + p] = c * vip - s * viq;
      V[i * 3 + q] = s * vip + c * viq;
    }
  }
}
