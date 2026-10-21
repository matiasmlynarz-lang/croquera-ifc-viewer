/**
 * GeometryPrototypeDetector — Detector de congruencia geométrica y prototipos para IFC (Etapa B).
 *
 * Analiza mallas y sólidos B-Rep en segundo plano para identificar geometrías idénticas
 * o congruentes (e.g. 96k barandas o placas en ElManzano.ifc) y colapsarlas en prototipos
 * maestros y matrices de instancia en GPU (Norma 4: matrixId / InstancedMesh).
 *
 * Cumplimiento normativo (NORMAS_DESARROLLO_CROQUERA.md):
 * - Norma 6: Uso exclusivo de GeometryTolerance.IMPORTED_VERTEX_WELD para tolerancia de congruencia (D1).
 * - Norma 7: Complejidad O(V) por malla, amortizado O(N) para la escena.
 * - Norma 11: Manejo robusto de casos degenerados (malla vacía, 1 vértice, colisión de hash forzada).
 * - Norma 17: Fidelidad de matrices 4x4 en frontera (Float32Array 16 floats).
 */

import * as THREE from 'three';
import { GeometryTolerance } from '../math/GeometryTolerance';
import type { PolyMesh } from '../topology/PolyMesh';

const FNV_PRIME = 1099511628211n;
const FNV_OFFSET_BASIS = 14695981039346656037n;

/**
 * Cambio de base canónico IFC Z-up -> Croquera Y-up.
 * X_croq = X_ifc,  Y_croq = Z_ifc,  Z_croq = -Y_ifc  (det = +1)
 *
 * Para cualquier matrix M en espacio IFC:
 *   M_croq = M_CANONICAL · M · M_CANONICAL_INV
 */
const M_CANONICAL = new THREE.Matrix4().set(
  1,  0,  0, 0,
  0,  0,  1, 0,
  0, -1,  0, 0,
  0,  0,  0, 1
);
const M_CANONICAL_INV = new THREE.Matrix4().set(
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
  dx: number;
  dy: number;
  dz: number;
  centroid: [number, number, number];
  placementMatrix: THREE.Matrix4;
  instanceCount: number;
  sortedDistances: Float32Array;
}

export interface PrototypeMatchResult {
  isInstance: boolean;
  prototypeId: string;
  prototypeStepId: number;
  transform: Float32Array; // 16 floats
  /** Centroide del prototipo en IFC local space (AABB midpoint) — usar para centrar la geometría emitida */
  centroid_ifc: [number, number, number];
}

export class GeometryPrototypeDetector {
  private prototypesByHash: Map<bigint, PrototypeRecord[]> = new Map();
  private prototypesById: Map<string, PrototypeRecord> = new Map();

  public totalPrototypes: number = 0;
  public totalInstancesDetected: number = 0;

  /**
   * Limpia el registro de prototipos.
   */
  public clear(): void {
    this.prototypesByHash.clear();
    this.prototypesById.clear();
    this.totalPrototypes = 0;
    this.totalInstancesDetected = 0;
  }

  /**
   * Evalúa una geometría. Si es congruente con un prototipo existente, devuelve isInstance = true
   * con la referencia al prototipo y la matriz 4x4. Si es nueva, la registra como prototipo.
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

    // Caso degenerado: Malla vacía o sin vértices (Norma 11)
    if (vertexCount === 0) {
      const M_croq_degen = M_CANONICAL.clone().multiply(placementMatrix).multiply(M_CANONICAL_INV);
      return {
        isInstance: false,
        prototypeId: entityId,
        prototypeStepId: stepId,
        transform: new Float32Array(M_croq_degen.elements),
        centroid_ifc: [0, 0, 0],
      };
    }

    const signature = this.computeSignature(positions, faceCount);
    const weld = GeometryTolerance.IMPORTED_VERTEX_WELD;

    // Buscar en el bucket de hash
    const bucket = this.prototypesByHash.get(signature.hash);
    if (bucket) {
      for (const candidate of bucket) {
        if (this.areCongruent(signature, candidate, weld)) {
          // Coincidencia confirmada: Es una instancia del prototipo existente
          candidate.instanceCount++;
          this.totalInstancesDetected++;

          // M_ifc = mProduct (placementMatrix) · T(centroid_ifc de esta ocurrencia)
          // El centroid de la signatura está en espacio IFC local (coordenadas crudas de los vértices del ítem).
          // mProduct lleva ese centroid local al espacio mundo IFC.
          // M_croq = M_CANONICAL · M_ifc · M_CANONICAL_INV
          // (Norma 17: transform en Croquera Y-up space para InstancedMesh GPU)
          const [cx, cy, cz] = signature.centroid;
          const M_ifc = placementMatrix.clone().multiply(
            new THREE.Matrix4().makeTranslation(cx, cy, cz)
          );
          const M_croq = M_CANONICAL.clone().multiply(M_ifc).multiply(M_CANONICAL_INV);

          return {
            isInstance: true,
            prototypeId: candidate.prototypeId,
            prototypeStepId: candidate.stepId,
            transform: new Float32Array(M_croq.elements),
            centroid_ifc: signature.centroid,
          };
        }
      }
    }

    // No se encontró coincidencia: Registrar como nuevo prototipo
    const newProto: PrototypeRecord = {
      prototypeId: entityId,
      stepId,
      hash: signature.hash,
      vertexCount: signature.vertexCount,
      faceCount: signature.faceCount,
      dx: signature.dx,
      dy: signature.dy,
      dz: signature.dz,
      centroid: signature.centroid,
      placementMatrix: placementMatrix.clone(),
      instanceCount: 1,
      sortedDistances: signature.sortedDistances,
    };

    if (!bucket) {
      this.prototypesByHash.set(signature.hash, [newProto]);
    } else {
      bucket.push(newProto);
    }
    this.prototypesById.set(entityId, newProto);
    this.totalPrototypes++;

    // Prototipo nuevo: la geometría será centrada en Croquera space (x-cx, z-cz, -(y-cy))
    // por IfcStepImporter antes de emitirla. Aquí devolvemos la M_croq del prototipo mismo
    // para que la primera ocurrencia también se renderice en su posición correcta.
    const [pcx, pcy, pcz] = signature.centroid;
    const M_ifc_proto = placementMatrix.clone().multiply(
      new THREE.Matrix4().makeTranslation(pcx, pcy, pcz)
    );
    const M_croq_proto = M_CANONICAL.clone().multiply(M_ifc_proto).multiply(M_CANONICAL_INV);

    return {
      isInstance: false,
      prototypeId: entityId,
      prototypeStepId: stepId,
      transform: new Float32Array(M_croq_proto.elements),
      centroid_ifc: [pcx, pcy, pcz],
    };
  }

  /**
   * Obtiene un prototipo registrado por su entityId.
   */
  public getPrototype(prototypeId: string): PrototypeRecord | undefined {
    return this.prototypesById.get(prototypeId);
  }

  /**
   * Calcula la firma geométrica invariante a la traslación.
   */
  public computeSignature(
    positions: Float32Array,
    faceCount: number
  ): {
    hash: bigint;
    vertexCount: number;
    faceCount: number;
    dx: number;
    dy: number;
    dz: number;
    centroid: [number, number, number];
    sortedDistances: Float32Array;
  } {
    const vertexCount = Math.floor(positions.length / 3);
    if (vertexCount === 0) {
      return {
        hash: 0n,
        vertexCount: 0,
        faceCount: 0,
        dx: 0,
        dy: 0,
        dz: 0,
        centroid: [0, 0, 0],
        sortedDistances: new Float32Array(0),
      };
    }

    let minX = positions[0], maxX = positions[0];
    let minY = positions[1], maxY = positions[1];
    let minZ = positions[2], maxZ = positions[2];

    for (let i = 1; i < vertexCount; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;

    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;

    const distances = new Float32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      const px = positions[i * 3] - cx;
      const py = positions[i * 3 + 1] - cy;
      const pz = positions[i * 3 + 2] - cz;
      distances[i] = Math.hypot(px, py, pz);
    }

    distances.sort();

    // Hash FNV-1a sobre los invariantes
    const weld = GeometryTolerance.IMPORTED_VERTEX_WELD;
    const qDx = Math.round(dx / weld);
    const qDy = Math.round(dy / weld);
    const qDz = Math.round(dz / weld);

    let h = FNV_OFFSET_BASIS;
    h = this.fnvMixInt(h, vertexCount);
    h = this.fnvMixInt(h, faceCount);
    h = this.fnvMixInt(h, qDx);
    h = this.fnvMixInt(h, qDy);
    h = this.fnvMixInt(h, qDz);

    // Muestreo estratificado de distancias radiales (hasta 64 muestras)
    const step = Math.max(1, Math.floor(vertexCount / 64));
    for (let i = 0; i < vertexCount; i += step) {
      const qDist = Math.round(distances[i] / weld);
      h = this.fnvMixInt(h, qDist);
    }

    return {
      hash: h,
      vertexCount,
      faceCount,
      dx,
      dy,
      dz,
      centroid: [cx, cy, cz],
      sortedDistances: distances,
    };
  }

  /**
   * Verificación secundaria estricta de congruencia geométrica (Mitigación de colisiones).
   */
  private areCongruent(
    sigA: {
      vertexCount: number;
      faceCount: number;
      dx: number;
      dy: number;
      dz: number;
      sortedDistances: Float32Array;
    },
    cand: PrototypeRecord,
    weld: number
  ): boolean {
    if (sigA.vertexCount !== cand.vertexCount) return false;
    if (sigA.faceCount !== cand.faceCount) return false;
    if (Math.abs(sigA.dx - cand.dx) > weld) return false;
    if (Math.abs(sigA.dy - cand.dy) > weld) return false;
    if (Math.abs(sigA.dz - cand.dz) > weld) return false;

    // Comparar distancias radiales ordenadas
    const v = sigA.vertexCount;
    const step = Math.max(1, Math.floor(v / 32));
    for (let i = 0; i < v; i += step) {
      if (Math.abs(sigA.sortedDistances[i] - cand.sortedDistances[i]) > weld) {
        return false;
      }
    }

    return true;
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
