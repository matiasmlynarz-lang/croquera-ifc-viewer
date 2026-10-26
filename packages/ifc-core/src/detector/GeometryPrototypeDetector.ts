/**
 * GeometryPrototypeDetector — Geometric congruence and prototype detector for IFC components.
 *
 * Analyzes meshes and B-Rep solids in background threads to identify identical
 * or congruent geometries (e.g. repetitive railings, columns, or panel instances)
 * and collapses them into master prototypes and GPU instanced matrices.
 *
 * Uses Principal Component Analysis (PCA) to derive canonical orientation and
 * decouple baked rotations (e.g. 90°, 180°, or arbitrary rotations).
 */

import * as THREE from 'three';
import { GeometryTolerance } from '../math/GeometryTolerance';
import { PCAAligner, type PCAResult } from '../math/PCAAligner';
import type { PolyMesh } from '../topology/PolyMesh';

const FNV_PRIME = 1099511628211n;
const FNV_OFFSET_BASIS = 14695981039346656037n;

/**
 * Canonical basis transformation IFC Z-up -> Croquera Y-up.
 * X_croq = X_ifc,  Y_croq = Z_ifc,  Z_croq = -Y_ifc  (det = +1)
 *
 * For any matrix M in IFC space:
 *   M_croq = M_CANONICAL · M · M_CANONICAL_INV
 */
export const M_CANONICAL = new THREE.Matrix4().set(
  1,  0,  0, 0,
  0,  0,  1, 0,
  0, -1,  0, 0,
  0,  0,  0, 1
);
export const M_CANONICAL_INV = new THREE.Matrix4().set(
  1,  0,  0, 0,
  0,  0, -1, 0,
  0,  1,  0, 0,
  0,  0,  0, 1
);

export interface PrototypeRecord {
  prototypeId: string;
  stepId: number;
  hash: bigint;
  vertexCount: number;
  faceCount: number;
  extents: [number, number, number];
  dx: number;
  dy: number;
  dz: number;
  centroid: [number, number, number];
  placementMatrix: THREE.Matrix4;
  instanceCount: number;
  sortedDistances: Float32Array;
  canonicalSample: Float32Array;
  pcaRotation: THREE.Matrix4;
}

export interface PrototypeMatchResult {
  isInstance: boolean;
  prototypeId: string;
  prototypeStepId: number;
  transform: Float32Array; // 16 floats (M_croq)
  /** Prototype centroid in local IFC space */
  centroid_ifc: [number, number, number];
  /**
   * 4x4 matrix transforming local IFC geometry to Croquera canonical space:
   * M_to_proto_croq = M_CANONICAL · R^T · T(-c)
   */
  toCanonicalCroqueraMatrix: THREE.Matrix4;
}

export class GeometryPrototypeDetector {
  private prototypesByHash: Map<bigint, PrototypeRecord[]> = new Map();
  private prototypesById: Map<string, PrototypeRecord> = new Map();

  public totalPrototypes: number = 0;
  public totalInstancesDetected: number = 0;

  /**
   * Clears the prototype registry.
   */
  public clear(): void {
    this.prototypesByHash.clear();
    this.prototypesById.clear();
    this.totalPrototypes = 0;
    this.totalInstancesDetected = 0;
  }

  /**
   * Evaluates a geometry. If congruent with an existing prototype, returns isInstance = true
   * with the prototype reference and 4x4 matrix. If novel, registers it as a prototype.
   */
  public checkOrRegister(
    entityId: string,
    stepId: number,
    meshOrPositions: PolyMesh | Float32Array,
    placementMatrix: THREE.Matrix4,
    indices?: Uint32Array
  ): PrototypeMatchResult {
    let positions: Float32Array;
    let faceCount: number;

    if (meshOrPositions instanceof Float32Array) {
      positions = meshOrPositions;
      faceCount = indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);
    } else {
      // PolyMesh
      const mesh = meshOrPositions;
      faceCount = mesh.faces.size;
      const vArray = Array.from(mesh.vertices.values());
      positions = new Float32Array(vArray.length * 3);
      for (let i = 0; i < vArray.length; i++) {
        positions[i * 3] = vArray[i].position.x;
        positions[i * 3 + 1] = vArray[i].position.y;
        positions[i * 3 + 2] = vArray[i].position.z;
      }
    }

    const vertexCount = Math.floor(positions.length / 3);

    // Degenerate case: Empty mesh or mesh without vertices (Rule 11)
    if (vertexCount === 0) {
      const M_croq_degen = M_CANONICAL.clone().multiply(placementMatrix).multiply(M_CANONICAL_INV);
      return {
        isInstance: false,
        prototypeId: entityId,
        prototypeStepId: stepId,
        transform: new Float32Array(M_croq_degen.elements),
        centroid_ifc: [0, 0, 0],
        toCanonicalCroqueraMatrix: new THREE.Matrix4().identity(),
      };
    }

    const signature = this.computeSignature(positions, faceCount);
    const weld = GeometryTolerance.IMPORTED_VERTEX_WELD;

    // Look up in hash bucket
    const bucket = this.prototypesByHash.get(signature.hash);
    if (bucket) {
      for (const candidate of bucket) {
        const matchingRotation = this.areCongruent(signature, candidate, weld);
        if (matchingRotation) {
          // Match confirmed: It is an instance of an existing prototype
          candidate.instanceCount++;
          this.totalInstancesDetected++;

          // M_ifc = mProduct (placementMatrix) · T(occurrence centroid_ifc) · R_instance
          // The signature centroid is in local IFC space.
          // matchingRotation rotates canonical coordinates into this occurrence's local space.
          // M_croq = M_CANONICAL · M_ifc · M_CANONICAL_INV
          const [cx, cy, cz] = signature.centroid;
          const M_ifc = placementMatrix.clone()
            .multiply(new THREE.Matrix4().makeTranslation(cx, cy, cz))
            .multiply(matchingRotation);
          const M_croq = M_CANONICAL.clone().multiply(M_ifc).multiply(M_CANONICAL_INV);

          return {
            isInstance: true,
            prototypeId: candidate.prototypeId,
            prototypeStepId: candidate.stepId,
            transform: new Float32Array(M_croq.elements),
            centroid_ifc: signature.centroid,
            toCanonicalCroqueraMatrix: new THREE.Matrix4().identity(),
          };
        }
      }
    }

    // No match found: Register as new prototype
    const newProto: PrototypeRecord = {
      prototypeId: entityId,
      stepId,
      hash: signature.hash,
      vertexCount: signature.vertexCount,
      faceCount: signature.faceCount,
      extents: signature.extents,
      dx: signature.extents[0],
      dy: signature.extents[1],
      dz: signature.extents[2],
      centroid: signature.centroid,
      placementMatrix: placementMatrix.clone(),
      instanceCount: 1,
      sortedDistances: signature.sortedDistances,
      canonicalSample: signature.canonicalSample,
      pcaRotation: signature.rotationMatrix,
    };

    if (!bucket) {
      this.prototypesByHash.set(signature.hash, [newProto]);
    } else {
      bucket.push(newProto);
    }
    this.prototypesById.set(entityId, newProto);
    this.totalPrototypes++;

    // New prototype:
    // 1. Transform to canonical Croquera space:
    //    M_to_proto_croq = M_CANONICAL · R^T · T(-c)
    const [pcx, pcy, pcz] = signature.centroid;
    const T_minus_c = new THREE.Matrix4().makeTranslation(-pcx, -pcy, -pcz);
    const R_inv = signature.rotationMatrix.clone().transpose();
    const M_to_proto_croq = M_CANONICAL.clone().multiply(R_inv).multiply(T_minus_c);

    // 2. Instance transform for the first occurrence:
    //    M_ifc_proto = placementMatrix · T(c) · R
    //    M_croq_proto = M_CANONICAL · M_ifc_proto · M_CANONICAL_INV
    const M_ifc_proto = placementMatrix.clone()
      .multiply(new THREE.Matrix4().makeTranslation(pcx, pcy, pcz))
      .multiply(signature.rotationMatrix);
    const M_croq_proto = M_CANONICAL.clone().multiply(M_ifc_proto).multiply(M_CANONICAL_INV);

    return {
      isInstance: false,
      prototypeId: entityId,
      prototypeStepId: stepId,
      transform: new Float32Array(M_croq_proto.elements),
      centroid_ifc: [pcx, pcy, pcz],
      toCanonicalCroqueraMatrix: M_to_proto_croq,
    };
  }

  /**
   * Retrieves a registered prototype by its entityId.
   */
  public getPrototype(prototypeId: string): PrototypeRecord | undefined {
    return this.prototypesById.get(prototypeId);
  }

  /**
   * Computes rotation-invariant geometric signature via PCA.
   */
  public computeSignature(
    positions: Float32Array,
    faceCount: number
  ): PCAResult & {
    hash: bigint;
    vertexCount: number;
    faceCount: number;
    dx: number;
    dy: number;
    dz: number;
  } {
    const vertexCount = Math.floor(positions.length / 3);
    if (vertexCount === 0) {
      return {
        hash: 0n,
        vertexCount: 0,
        faceCount: 0,
        centroid: [0, 0, 0],
        eigenvalues: [0, 0, 0],
        extents: [0, 0, 0],
        dx: 0,
        dy: 0,
        dz: 0,
        rotationMatrix: new THREE.Matrix4().identity(),
        sortedDistances: new Float32Array(0),
        canonicalSample: new Float32Array(0),
      };
    }

    const pca = PCAAligner.computePCA(positions);

    // FNV-1a hash over geometric invariants (vertexCount, faceCount, principal extents, radial distances)
    const weld = GeometryTolerance.IMPORTED_VERTEX_WELD;
    const qL0 = Math.round(pca.extents[0] / weld);
    const qL1 = Math.round(pca.extents[1] / weld);
    const qL2 = Math.round(pca.extents[2] / weld);

    let h = FNV_OFFSET_BASIS;
    h = this.fnvMixInt(h, vertexCount);
    h = this.fnvMixInt(h, faceCount);
    h = this.fnvMixInt(h, qL0);
    h = this.fnvMixInt(h, qL1);
    h = this.fnvMixInt(h, qL2);

    // Stratified sampling of radial distances (up to 64 samples)
    const step = Math.max(1, Math.floor(vertexCount / 64));
    for (let i = 0; i < vertexCount; i += step) {
      const qDist = Math.round(pca.sortedDistances[i] / weld);
      h = this.fnvMixInt(h, qDist);
    }

    return {
      hash: h,
      vertexCount,
      faceCount,
      dx: pca.extents[0],
      dy: pca.extents[1],
      dz: pca.extents[2],
      ...pca,
    };
  }

  /**
   * Strict secondary geometric congruence verification (Collision mitigation).
   * Returns the matching 4x4 rotation matrix if congruent, or null if not congruent.
   */
  private areCongruent(
    sigA: PCAResult & { vertexCount: number; faceCount: number },
    cand: PrototypeRecord,
    weld: number
  ): THREE.Matrix4 | null {
    if (sigA.vertexCount !== cand.vertexCount) return null;
    if (sigA.faceCount !== cand.faceCount) return null;

    return PCAAligner.testCongruence(
      sigA,
      cand.extents,
      cand.sortedDistances,
      cand.canonicalSample,
      weld
    );
  }

  private fnvMixInt(h: bigint, val: number): bigint {
    let n = BigInt(Math.trunc(val));
    for (let i = 0; i < 4; i++) {
      const byte = Number(n & 0xffn);
      h ^= BigInt(byte);
      h = (h * FNV_PRIME) & 0xffffffffffffffffn;
      n >>= 8n;
    }
    return h;
  }
}
