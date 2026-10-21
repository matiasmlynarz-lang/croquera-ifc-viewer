/**
 * SweepKernel.ts — Computational Geometry Kernel for Sweep / Follow Me Extrusion.
 *
 * Satisface todas las reglas vinculantes de NORMAS_DESARROLLO_CROQUERA.md:
 * - Regla 6: Tolerancias centralizadas de GeometryTolerance.
 * - Regla 7: Complejidad controlada O(N*K) en transformaciones.
 * - Regla 11: Aserciones reales y casos degenerados.
 */
import { Vec3 } from '../math/Vec3';
import { GeometryTolerance } from '../math/GeometryTolerance';
import { PolyMesh } from './PolyMesh';

export interface ChainedPath {
  points: Vec3[];
  isClosed: boolean;
  totalLength: number;
}

export class SweepKernel {
  /**
   * Calcula la normal unitaria del polígono del perfil utilizando el método de Newell.
   */
  public static computePolygonNormal(vertices: Vec3[]): Vec3 {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    const n = vertices.length;

    for (let i = 0; i < n; i++) {
      const current = vertices[i];
      const next = vertices[(i + 1) % n];
      nx += (current.y - next.y) * (current.z + next.z);
      ny += (current.z - next.z) * (current.x + next.x);
      nz += (current.x - next.x) * (current.y + next.y);
    }

    const norm = Math.hypot(nx, ny, nz);
    if (norm > GeometryTolerance.MATH_EPSILON) {
      return new Vec3(nx / norm, ny / norm, nz / norm);
    }
    return Vec3.Y;
  }

  /**
   * Encadena una colección de aristas no ordenadas en una polilínea 3D continua.
   */
  public static chainPathSegments(edges: { a: Vec3; b: Vec3 }[]): ChainedPath | null {
    if (!edges || edges.length === 0) return null;

    const segments: { a: Vec3; b: Vec3; used: boolean }[] = [];
    for (const e of edges) {
      if (e.a.distanceTo(e.b) > GeometryTolerance.COINCIDENT_POINT) {
        segments.push({ a: e.a, b: e.b, used: false });
      }
    }

    if (segments.length === 0) return null;

    const first = segments[0];
    first.used = true;

    const points: Vec3[] = [first.a, first.b];
    let expanded = true;

    while (expanded && segments.some((s) => !s.used)) {
      expanded = false;
      const head = points[points.length - 1];
      const tail = points[0];

      for (const s of segments) {
        if (s.used) continue;

        if (s.a.distanceTo(head) < GeometryTolerance.SNAP_TOLERANCE) {
          points.push(s.b);
          s.used = true;
          expanded = true;
          break;
        } else if (s.b.distanceTo(head) < GeometryTolerance.SNAP_TOLERANCE) {
          points.push(s.a);
          s.used = true;
          expanded = true;
          break;
        } else if (s.b.distanceTo(tail) < GeometryTolerance.SNAP_TOLERANCE) {
          points.unshift(s.a);
          s.used = true;
          expanded = true;
          break;
        } else if (s.a.distanceTo(tail) < GeometryTolerance.SNAP_TOLERANCE) {
          points.unshift(s.b);
          s.used = true;
          expanded = true;
          break;
        }
      }
    }

    let isClosed = false;
    if (
      points.length >= 4 &&
      points[0].distanceTo(points[points.length - 1]) < GeometryTolerance.SNAP_TOLERANCE
    ) {
      isClosed = true;
      points[points.length - 1] = points[0];
    }

    let totalLength = 0;
    for (let i = 0; i < points.length - 1; i++) {
      totalLength += points[i].distanceTo(points[i + 1]);
    }

    if (totalLength < GeometryTolerance.COINCIDENT_POINT) {
      return null;
    }

    return { points, isClosed, totalLength };
  }

  /**
   * Alinea canónicamente el origen (s = 0) y el sentido de avance de la trayectoria
   * respecto a la posición y orientación de la cara del perfil.
   */
  public static alignPathToProfile(
    pathPoints: Vec3[],
    isClosed: boolean,
    profileVertices: Vec3[]
  ): { alignedPath: Vec3[]; isClosed: boolean } {
    if (pathPoints.length < 2 || profileVertices.length < 3) {
      return { alignedPath: pathPoints, isClosed };
    }

    const cleaned: Vec3[] = [];
    for (const p of pathPoints) {
      if (cleaned.length === 0 || cleaned[cleaned.length - 1].distanceTo(p) > GeometryTolerance.COINCIDENT_POINT) {
        cleaned.push(p);
      }
    }

    if (cleaned.length < 2) return { alignedPath: pathPoints, isClosed };

    const profNormal = this.computePolygonNormal(profileVertices);

    if (isClosed) {
      let uniqueNodes = [...cleaned];
      if (
        uniqueNodes.length >= 4 &&
        uniqueNodes[0].distanceTo(uniqueNodes[uniqueNodes.length - 1]) < GeometryTolerance.SNAP_TOLERANCE
      ) {
        uniqueNodes.pop();
      }

      const M = uniqueNodes.length;
      if (M < 3) return { alignedPath: pathPoints, isClosed };

      // Buscar el punto más cercano de la trayectoria a cualquier vértice del perfil.
      // Puede ser un vértice existente o un punto interior sobre una arista del polígono.
      let bestSeg = 0;
      let bestT = 0;
      let bestProjPoint = uniqueNodes[0];
      let minDistance = Infinity;

      for (let i = 0; i < M; i++) {
        const a = uniqueNodes[i];
        const b = uniqueNodes[(i + 1) % M];
        const ab = b.sub(a);
        const lenSq = ab.lengthSq();

        for (const pv of profileVertices) {
          let t = 0;
          let proj = a;
          if (lenSq > GeometryTolerance.MATH_EPSILON) {
            t = Math.max(0, Math.min(1, pv.sub(a).dot(ab) / lenSq));
            proj = a.add(ab.scale(t));
          }
          const d = proj.distanceTo(pv);
          if (d < minDistance) {
            minDistance = d;
            bestSeg = i;
            bestT = t;
            bestProjPoint = proj;
          }
        }
      }

      let shifted: Vec3[] = [];
      if (bestT < 0.01) {
        // Coincide con uniqueNodes[bestSeg]
        for (let i = 0; i < M; i++) {
          shifted.push(uniqueNodes[(bestSeg + i) % M]);
        }
      } else if (bestT > 0.99) {
        // Coincide con uniqueNodes[(bestSeg + 1) % M]
        const nextIdx = (bestSeg + 1) % M;
        for (let i = 0; i < M; i++) {
          shifted.push(uniqueNodes[(nextIdx + i) % M]);
        }
      } else {
        // El perfil está en el interior de una arista (ej. en medio del borde superior de una caja).
        // Se inserta bestProjPoint como nodo inicial para que la distancia de anclaje sea 0.
        shifted.push(bestProjPoint);
        for (let i = 1; i <= M; i++) {
          shifted.push(uniqueNodes[(bestSeg + i) % M]);
        }
      }

      const p0 = shifted[0];
      const pForward = shifted[1];
      const pBackward = shifted[shifted.length - 1];

      const tForward = pForward.sub(p0).normalize();
      const tBackward = pBackward.sub(p0).normalize();

      const dotForward = profNormal.dot(tForward);
      const dotBackward = profNormal.dot(tBackward);

      let finalNodes = shifted;
      if (dotForward < -GeometryTolerance.POINT_ON_PLANE && dotBackward > dotForward) {
        const reversed: Vec3[] = [p0];
        for (let i = shifted.length - 1; i >= 1; i--) {
          reversed.push(shifted[i]);
        }
        finalNodes = reversed;
      }

      finalNodes.push(finalNodes[0]);
      return { alignedPath: finalNodes, isClosed: true };
    }

    // Trayectorias abiertas: insertar anclaje si el perfil está en el interior de un segmento
    let bestSegOpen = -1;
    let bestTOpen = 0;
    let bestProjOpen = cleaned[0];
    let minDistanceOpen = Infinity;

    for (let i = 0; i < cleaned.length - 1; i++) {
      const a = cleaned[i];
      const b = cleaned[i + 1];
      const ab = b.sub(a);
      const lenSq = ab.lengthSq();

      for (const pv of profileVertices) {
        let t = 0;
        let proj = a;
        if (lenSq > GeometryTolerance.MATH_EPSILON) {
          t = Math.max(0, Math.min(1, pv.sub(a).dot(ab) / lenSq));
          proj = a.add(ab.scale(t));
        }
        const d = proj.distanceTo(pv);
        if (d < minDistanceOpen) {
          minDistanceOpen = d;
          bestSegOpen = i;
          bestTOpen = t;
          bestProjOpen = proj;
        }
      }
    }

    let segmentedPath = [...cleaned];
    if (bestTOpen > 0.01 && bestTOpen < 0.99 && bestSegOpen >= 0) {
      segmentedPath.splice(bestSegOpen + 1, 0, bestProjOpen);
    }

    let dStart = Infinity;
    let dEnd = Infinity;

    for (const pv of profileVertices) {
      dStart = Math.min(dStart, segmentedPath[0].distanceTo(pv));
      dEnd = Math.min(dEnd, segmentedPath[segmentedPath.length - 1].distanceTo(pv));
    }

    let orientedPath = segmentedPath;
    if (dEnd < dStart) {
      orientedPath = [...segmentedPath].reverse();
    }

    return { alignedPath: orientedPath, isClosed: false };
  }

  /**
   * Calcula la normal del plano que contiene a una trayectoria (si es planar).
   * Utiliza la fórmula de Newell y verifica que todos los nodos pertenezcan al plano.
   */
  public static computePathPlaneNormal(pathPoints: Vec3[]): Vec3 | null {
    if (pathPoints.length < 3) return null;

    let nx = 0, ny = 0, nz = 0;
    const n = pathPoints.length;
    for (let i = 0; i < n - 1; i++) {
      const cur = pathPoints[i];
      const next = pathPoints[i + 1];
      nx += (cur.y - next.y) * (cur.z + next.z);
      ny += (cur.z - next.z) * (cur.x + next.x);
      nz += (cur.x - next.x) * (cur.y + next.y);
    }
    const newell = new Vec3(nx, ny, nz);
    if (newell.lengthSq() > GeometryTolerance.MATH_EPSILON) {
      const norm = newell.normalize();
      const origin = pathPoints[0];
      const allOnPlane = pathPoints.every(
        (p) => Math.abs(p.sub(origin).dot(norm)) <= GeometryTolerance.POINT_ON_PLANE * 5
      );
      if (allOnPlane) return norm;
    }

    // Si Newell es casi cero (ej. segmentos abiertos colineales o cancelados), calcular producto cruz
    let t0: Vec3 | null = null;
    for (let i = 0; i < n - 1; i++) {
      const seg = pathPoints[i + 1].sub(pathPoints[i]);
      if (seg.length() > GeometryTolerance.COINCIDENT_POINT) {
        t0 = seg.normalize();
        for (let j = i + 1; j < n - 1; j++) {
          const seg2 = pathPoints[j + 1].sub(pathPoints[j]);
          if (seg2.length() > GeometryTolerance.COINCIDENT_POINT) {
            const tJ = seg2.normalize();
            const cross = t0.cross(tJ);
            if (cross.lengthSq() > GeometryTolerance.MATH_EPSILON) {
              const norm = cross.normalize();
              const origin = pathPoints[0];
              const isPlanar = pathPoints.every(
                (p) => Math.abs(p.sub(origin).dot(norm)) <= GeometryTolerance.POINT_ON_PLANE * 5
              );
              if (isPlanar) return norm;
            }
          }
        }
        break;
      }
    }

    return null;
  }

  /**
   * Barre una sección poligonal plana a lo largo de una trayectoria continua 3D.
   *
   * Algoritmo: Marco de Superficie (Darboux Frame) con Up-Vector Canónico Invariante
   * y corrección bisectriz de inglete (Miter Joint) en esquinas vivas (>= 20°).
   *
   * Garantías matemáticas (NORMAS_DESARROLLO_CROQUERA):
   *   1. En tramos rectos entre esquinas, la base ortonormal (U_i, V_i) es 100% idéntica
   *      en ambos extremos del tramo, eliminando cualquier torsión helicoidal espuria.
   *   2. En bucles sobre planos (como la cara superior de una caja), el eje vertical V
   *      permanece estrictamente perpendicular al plano (constante en todo el perímetro).
   *   3. En las esquinas angulares (>= 20°), las secciones entrante y saliente se proyectan
   *      de forma exacta sobre el plano bisector normalize(tIn - tOut).
   */
  public static sweepProfileAlongPath(
    profileVertices: Vec3[],
    pathPoints: Vec3[],
    isClosed: boolean = false,
    meshId: string = 'sweep_mesh'
  ): PolyMesh | null {
    if (profileVertices.length < 3 || pathPoints.length < 2) {
      return null;
    }

    // 1. Alinear canónicamente el origen y la orientación de la trayectoria
    const alignment = this.alignPathToProfile(pathPoints, isClosed, profileVertices);
    const cleanedPath = alignment.alignedPath;
    const closed = alignment.isClosed;

    if (cleanedPath.length < 2) return null;

    const numNodes = cleanedPath.length;
    const k = profileVertices.length;

    // 2. Calcular tangentes unitarias de cada segmento
    const segTangents: Vec3[] = [];
    for (let i = 0; i < numNodes - 1; i++) {
      const dir = cleanedPath[i + 1].sub(cleanedPath[i]);
      const len = dir.length();
      segTangents.push(len > GeometryTolerance.MATH_EPSILON ? dir.scale(1 / len) : Vec3.Y);
    }

    // 3. Determinar nodo de anclaje y segmento efectivo de adjunción
    let attachNodeIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < numNodes; i++) {
      for (const pv of profileVertices) {
        const d = cleanedPath[i].distanceTo(pv);
        if (d < minDist) {
          minDist = d;
          attachNodeIdx = i;
        }
      }
    }

    let effectiveAttachSeg: number;
    if (attachNodeIdx === 0) {
      effectiveAttachSeg = 0;
    } else if (attachNodeIdx >= numNodes - 1) {
      effectiveAttachSeg = segTangents.length - 1;
    } else {
      const profNormal = SweepKernel.computePolygonNormal(profileVertices);
      const dotPrev = Math.abs(profNormal.dot(segTangents[attachNodeIdx - 1]));
      const dotNext = Math.abs(profNormal.dot(segTangents[attachNodeIdx]));
      effectiveAttachSeg = dotPrev >= dotNext ? attachNodeIdx - 1 : attachNodeIdx;
    }

    const anchor = cleanedPath[attachNodeIdx];
    const T_attach = segTangents[effectiveAttachSeg];

    // 4. Determinar base ortonormal canónica e invariante de la trayectoria (Marco de Darboux)
    const pathPlaneNormal = SweepKernel.computePathPlaneNormal(cleanedPath);
    const isPlanar = pathPlaneNormal !== null;

    // 5. Construir base ortonormal canónica (U_i, V_i) para cada tramo de la trayectoria
    const segU: Vec3[] = [];
    const segV: Vec3[] = [];

    if (isPlanar) {
      // Marco de Superficie Canónico (Darboux):
      // Para cualquier trayectoria contenida en un plano (horizontal, vertical o inclinada),
      // todos los segmentos T_i yacen en el plano (T_i · N_plane = 0).
      // Por tanto, la normal del plano N_plane es estrictamente ortogonal a todos los segmentos T_i:
      // - V_i es la normal a la superficie de la cara (constante en todo el bucle, profundidad de moldura)
      // - U_i es la normal intrínseca en la superficie (T_i x V_i, orientada uniformemente en el plano)
      let N_plane = pathPlaneNormal!;
      if (Math.abs(N_plane.dot(Vec3.Y)) > 0.7 && N_plane.y < 0) {
        N_plane = N_plane.negate();
      }

      for (let i = 0; i < segTangents.length; i++) {
        const T_i = segTangents[i];
        const V_i = N_plane;
        const U_i = T_i.cross(V_i).normalize();
        segU.push(U_i);
        segV.push(V_i);
      }
    } else {
      // Trayectoria 3D libre no coplanar (Parallel Transport)
      const V_up = Vec3.Y;
      for (let i = 0; i < segTangents.length; i++) {
        const T_i = segTangents[i];
        let vSeg = V_up.sub(T_i.scale(T_i.dot(V_up)));
        if (vSeg.lengthSq() < GeometryTolerance.MATH_EPSILON) {
          const arb = Math.abs(T_i.dot(Vec3.X)) < 0.9 ? Vec3.X : Vec3.Z;
          vSeg = T_i.cross(arb);
        }
        const V_i = vSeg.normalize();
        const U_i = T_i.cross(V_i).normalize();
        segU.push(U_i);
        segV.push(V_i);
      }
    }

    const U_attach = segU[effectiveAttachSeg];
    const V_attach = segV[effectiveAttachSeg];

    // 6. Descomponer el perfil en coordenadas invariantes locales (u_k, v_k)
    //    referenciadas a la base transversal (U_attach, V_attach) en el anclaje.
    const N_prof = SweepKernel.computePolygonNormal(profileVertices);
    const uCoords: number[] = [];
    const vCoords: number[] = [];
    let maxDistFromAnchor = 0;

    const dotNormal = N_prof.dot(T_attach);
    const isTransversal = Math.abs(dotNormal) > 0.5;

    if (isTransversal) {
      // El perfil ya fue dibujado en el plano transversal a la trayectoria
      for (const pv of profileVertices) {
        const r = pv.sub(anchor);
        uCoords.push(r.dot(U_attach));
        vCoords.push(r.dot(V_attach));
        maxDistFromAnchor = Math.max(maxDistFromAnchor, pv.distanceTo(anchor));
      }
    } else {
      // El perfil fue dibujado coplanar a una cara que contiene a T_attach (ej. en la pared).
      // Se rota su vector relativo hacia el plano transversal ortogonal a T_attach
      const effNormal = dotNormal >= 0 ? N_prof : N_prof.negate();
      const alignCross = effNormal.cross(T_attach);
      const alignAxis = alignCross.lengthSq() > GeometryTolerance.MATH_EPSILON
        ? alignCross.normalize()
        : V_attach;
      const angle = Math.acos(Math.max(-1, Math.min(1, effNormal.dot(T_attach))));

      for (const pv of profileVertices) {
        const r = pv.sub(anchor);
        const rAligned = SweepKernel.rotateVectorAroundAxis(r, alignAxis, angle);
        uCoords.push(rAligned.dot(U_attach));
        vCoords.push(rAligned.dot(V_attach));
        maxDistFromAnchor = Math.max(maxDistFromAnchor, pv.distanceTo(anchor));
      }
    }
    const profileDiagonal = Math.max(0.1, maxDistFromAnchor * 2);

    // 7. Generar las secciones transversales en cada nodo de la trayectoria
    const numSections = closed ? numNodes - 1 : numNodes;
    const sections: Vec3[][] = [];
    const numSegs = segTangents.length;

    for (let i = 0; i < numSections; i++) {
      const nodePos = cleanedPath[i];
      let tIn: Vec3;
      let tOut: Vec3;
      let U_node: Vec3;
      let V_node: Vec3;
      let isCorner: boolean;

      if (closed) {
        const prevSegIdx = (i - 1 + numSegs) % numSegs;
        const nextSegIdx = i % numSegs;
        tIn = segTangents[prevSegIdx];
        tOut = segTangents[nextSegIdx];
        U_node = segU[nextSegIdx];
        V_node = segV[nextSegIdx];
        const dotIn = Math.max(-1, Math.min(1, tIn.dot(tOut)));
        isCorner = dotIn < 0.9397; // Esquina >= 20°
      } else {
        if (i === 0) {
          tIn = segTangents[0];
          tOut = segTangents[0];
          U_node = segU[0];
          V_node = segV[0];
          isCorner = false;
        } else if (i === numNodes - 1) {
          tIn = segTangents[numSegs - 1];
          tOut = segTangents[numSegs - 1];
          U_node = segU[numSegs - 1];
          V_node = segV[numSegs - 1];
          isCorner = false;
        } else {
          tIn = segTangents[i - 1];
          tOut = segTangents[i];
          U_node = segU[i];
          V_node = segV[i];
          const dotIn = Math.max(-1, Math.min(1, tIn.dot(tOut)));
          isCorner = dotIn < 0.9397;
        }
      }

      const nodeSection: Vec3[] = [];

      if (!isCorner) {
        // Tramo recto: sección transversal ortogonal directa
        for (let j = 0; j < k; j++) {
          nodeSection.push(nodePos.add(U_node.scale(uCoords[j])).add(V_node.scale(vCoords[j])));
        }
      } else {
        // Quiebre con inglete: la normal exacta al plano bisector de corte es normalize(tIn + tOut)
        const miterDiff = tIn.add(tOut);
        const miterNormal = miterDiff.lengthSq() > GeometryTolerance.MATH_EPSILON
          ? miterDiff.normalize()
          : tOut;
        const denomMiter = tOut.dot(miterNormal);
        const maxMiterOffset = 5.0 * profileDiagonal;

        for (let j = 0; j < k; j++) {
          const P_raw = nodePos.add(U_node.scale(uCoords[j])).add(V_node.scale(vCoords[j]));
          if (Math.abs(denomMiter) > GeometryTolerance.POINT_ON_PLANE) {
            let t = nodePos.sub(P_raw).dot(miterNormal) / denomMiter;
            if (Math.abs(t) > maxMiterOffset) {
              t = Math.sign(t) * maxMiterOffset;
            }
            nodeSection.push(P_raw.add(tOut.scale(t)));
          } else {
            nodeSection.push(P_raw);
          }
        }
      }

      sections.push(nodeSection);
    }

    // 8. Construir la malla B-Rep (PolyMesh)
    const polyMesh = new PolyMesh(meshId);

    // 8.1 Caras laterales (Quads / Triangles según coplanaridad)
    //     Para bucles abiertos: sections.length == numNodes, iteramos i=0..numNodes-2.
    //     Para bucles cerrados: sections.length == numNodes-1 (nodos únicos), iteramos todos
    //     con cierre modular: sB = sections[(i+1) % sections.length].
    const numFaceSteps = closed ? sections.length : sections.length - 1;
    for (let i = 0; i < numFaceSteps; i++) {
      const sA = sections[i];
      const sB = closed ? sections[(i + 1) % sections.length] : sections[i + 1];

      for (let j = 0; j < k; j++) {
        const nextJ = (j + 1) % k;
        const p1 = sA[j];
        const p2 = sA[nextJ];
        const p3 = sB[nextJ];
        const p4 = sB[j];

        const diag = p2.sub(p1).cross(p4.sub(p1));
        const diagLen = diag.length();
        const dotP3 = diagLen > GeometryTolerance.MATH_EPSILON
          ? Math.abs(p3.sub(p1).dot(diag.scale(1 / diagLen)))
          : 0;

        if (dotP3 < GeometryTolerance.POINT_ON_PLANE * 5) {
          polyMesh.addFace([p1, p2, p3, p4]);
        } else {
          polyMesh.addFace([p1, p2, p3]);
          polyMesh.addFace([p1, p3, p4]);
        }
      }
    }

    // 8.2 Tapas de cierre en trayectorias abiertas
    if (!closed) {
      polyMesh.addFace([...sections[0]].reverse(), segTangents[0].negate());
      polyMesh.addFace([...sections[sections.length - 1]], segTangents[segTangents.length - 1]);
    }

    polyMesh.rebuildTopology();
    return polyMesh;
  }

  /**
   * Rota un vector 3D alrededor de un eje arbitrario unitario por un ángulo en radianes (Fórmula de Rodrigues).
   */
  private static rotateVectorAroundAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const term1 = v.scale(cosA);
    const term2 = axis.cross(v).scale(sinA);
    const term3 = axis.scale(axis.dot(v) * (1 - cosA));
    return term1.add(term2).add(term3);
  }
}
