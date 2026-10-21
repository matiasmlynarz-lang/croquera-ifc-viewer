/**
 * RevolveKernel — Computational geometry and topological builder for Solids of Revolution.
 *
 * Provides:
 * - Precise 3D profile rotation using Rodrigues' formula around an arbitrary 3D axis.
 * - Axial singularity handling (vertices on the axis automatically collapse quads into clean triangles at poles).
 * - Full 360° closed revolution (2-manifold watertight B-Rep with no internal caps).
 * - Partial revolution (< 360°) with proper capping faces at start and end sectors.
 * - Strict adherence to NORMAS_DESARROLLO_CROQUERA (tolerances from GeometryTolerance.ts, zero local EPSILON).
 */

import { Vec3 } from '../math/Vec3';
import { GeometryTolerance } from '../math/GeometryTolerance';
import { PolyMesh } from './PolyMesh';
import { rotatePointAroundAxis } from '../math/MathUtils';
import { GuidUtils } from '../types/GuidUtils';

export interface RevolveOptions {
  profileVertices: Vec3[];
  axisPoint: Vec3;
  axisDirection: Vec3;
  angleRadians: number;
  segmentsCount?: number;
  meshId?: string;
}

export class RevolveKernel {
  /**
   * Rota un punto 3D alrededor de un eje lineal (A, D) un ángulo theta dado (Fórmula de Rodrigues).
   */
  public static rotatePointAroundAxis(point: Vec3, axisPoint: Vec3, axisDir: Vec3, theta: number): Vec3 {
    return rotatePointAroundAxis(point, axisPoint, axisDir, theta);
  }

  /**
   * Calcula la distancia mínima de un punto al eje lineal (A, D).
   */
  public static distanceToAxis(point: Vec3, axisPoint: Vec3, axisDir: Vec3): number {
    const p = point.sub(axisPoint);
    const d = axisDir.normalize();
    const proj = d.scale(p.dot(d));
    return p.sub(proj).length();
  }

  /**
   * Genera un sólido B-Rep (PolyMesh) de revolución haciendo girar un perfil planar alrededor de un eje.
   */
  public static revolveProfile(options: RevolveOptions): PolyMesh | null {
    const {
      profileVertices,
      axisPoint,
      axisDirection,
      angleRadians,
      segmentsCount,
      meshId = GuidUtils.createIfcGuid(),
    } = options;

    if (!profileVertices || profileVertices.length < 3) {
      return null;
    }

    const axisDir = axisDirection.normalize();
    if (axisDir.lengthSq() < GeometryTolerance.MATH_EPSILON) {
      return null;
    }

    // Normalizar ángulo en el rango (0, 2π]
    let totalAngle = angleRadians;
    if (totalAngle <= GeometryTolerance.MATH_EPSILON) {
      return null;
    }
    if (totalAngle > 2 * Math.PI) {
      totalAngle = 2 * Math.PI;
    }

    const isFullRevolve = Math.abs(totalAngle - 2 * Math.PI) <= GeometryTolerance.COPLANAR_NORMAL;

    // Determinar cantidad de subdivisiones radiales
    let M = segmentsCount;
    if (!M || M < 3) {
      const fullSteps = 24;
      M = Math.max(4, Math.round(fullSteps * (totalAngle / (2 * Math.PI))));
    }

    const k = profileVertices.length;

    // Detectar qué vértices del perfil yacen sobre el eje de revolución
    const isOnAxis: boolean[] = profileVertices.map(
      (pv) => this.distanceToAxis(pv, axisPoint, axisDir) < GeometryTolerance.COINCIDENT_POINT
    );

    // 1. Generar todos los anillos rotados de vértices (rings: [M + 1][k])
    // Si es revolución completa a 360°, el anillo M es idéntico al anillo 0
    const ringsCount = isFullRevolve ? M : M + 1;
    const rings: Vec3[][] = [];

    for (let i = 0; i < ringsCount; i++) {
      const theta_i = (i / M) * totalAngle;
      const ringVertices: Vec3[] = [];
      for (let j = 0; j < k; j++) {
        if (isOnAxis[j]) {
          // Si está en el eje, el punto es invariante a la rotación
          ringVertices.push(profileVertices[j]);
        } else {
          ringVertices.push(this.rotatePointAroundAxis(profileVertices[j], axisPoint, axisDir, theta_i));
        }
      }
      rings.push(ringVertices);
    }

    const polyMesh = new PolyMesh(meshId);

    // Normal del perfil y vector normal hacia afuera de cada arista en el plano del perfil
    const nProfile = PolyMesh.computePolygonNormal(profileVertices);
    const edgeOutwardNormals: Vec3[] = [];
    for (let j = 0; j < k; j++) {
      const nextJ = (j + 1) % k;
      const edgeVec = profileVertices[nextJ].sub(profileVertices[j]);
      // En un polígono orientado según nProfile, el vector perpendicular exterior es edgeVec x nProfile
      const outN = edgeVec.cross(nProfile);
      edgeOutwardNormals.push(outN.lengthSq() > GeometryTolerance.MATH_EPSILON ? outN.normalize() : Vec3.ZERO);
    }

    // Helper para añadir caras verificando área no nula y orientando según la normal exterior esperada
    const tryAddFace = (verts: Vec3[], explicitNormal?: Vec3) => {
      // Filtrar vértices consecutivos coincidentes
      const cleaned: Vec3[] = [];
      const n = verts.length;
      for (let idx = 0; idx < n; idx++) {
        const cur = verts[idx];
        const next = verts[(idx + 1) % n];
        if (cur.distanceTo(next) >= GeometryTolerance.MIN_EDGE_LENGTH) {
          cleaned.push(cur);
        }
      }
      if (cleaned.length >= 3) {
        polyMesh.addFace(cleaned, explicitNormal);
      }
    };

    // 2. Coser caras laterales entre anillos consecutivos
    for (let i = 0; i < M; i++) {
      const ringA = rings[i];
      const ringB = isFullRevolve && i === M - 1 ? rings[0] : rings[i + 1];
      const midTheta = ((i + 0.5) / M) * totalAngle;

      for (let j = 0; j < k; j++) {
        const nextJ = (j + 1) % k;

        const vA1 = ringA[j];
        const vA2 = ringA[nextJ];
        const vB1 = ringB[j];
        const vB2 = ringB[nextJ];

        const jOnAxis = isOnAxis[j];
        const nextJOnAxis = isOnAxis[nextJ];

        if (jOnAxis && nextJOnAxis) {
          // Ambos vértices están sobre el eje: arista axial interna, omitir cara degenerada
          continue;
        }

        // Normal exterior matemática esperada para esta cara en el paso angular medio
        const baseOutN = edgeOutwardNormals[j];
        const faceOutN = baseOutN.lengthSq() > 0.5
          ? this.rotatePointAroundAxis(baseOutN, Vec3.ZERO, axisDir, midTheta).normalize()
          : undefined;

        if (jOnAxis) {
          // Polo superior/inferior: vA1 == vB1, colapsa en triángulo [vA1, vB2, vA2]
          tryAddFace([vA1, vB2, vA2], faceOutN);
        } else if (nextJOnAxis) {
          // Polo superior/inferior: vA2 == vB2, colapsa en triángulo [vA1, vB1, vA2]
          tryAddFace([vA1, vB1, vA2], faceOutN);
        } else {
          // Cuadrilátero regular de barrido
          tryAddFace([vA1, vB1, vB2, vA2], faceOutN);
        }
      }
    }

    // 3. Si el giro es parcial (< 360°), añadir las caras tapas en los extremos (endcaps)
    if (!isFullRevolve) {
      const profileCenter = profileVertices.reduce((acc, v) => acc.add(v), Vec3.ZERO).scale(1 / k);
      const radVec = profileCenter.sub(axisPoint);
      const motionDir = axisDir.cross(radVec).normalize();

      // Tapa inicial en theta = 0: normal opuesta a la dirección de giro
      const startCapNormal = motionDir.negate();
      tryAddFace(profileVertices, startCapNormal);

      // Tapa final en theta = totalAngle: normal en la dirección de giro
      const endMotionDir = this.rotatePointAroundAxis(motionDir, Vec3.ZERO, axisDir, totalAngle).normalize();
      tryAddFace(rings[M], endMotionDir);
    }

    polyMesh.rebuildTopology();
    return polyMesh;
  }
}
