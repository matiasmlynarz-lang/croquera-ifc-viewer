/**
 * MeasureTool — Interactive 3D point-to-point measurement tool with vertex & edge snapping.
 *
 * Accelerated by three-mesh-bvh for high-performance spatial queries on dense BIM models.
 * Provides real-time distance and orthogonal delta readout in metric meters.
 */

import * as THREE from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import type { Viewer3D } from '../viewport/Viewer3D';

// Apply BVH accelerated raycasting to THREE.Mesh if not already installed
if ((THREE.Mesh.prototype as any).raycast !== acceleratedRaycast) {
  (THREE.Mesh.prototype as any).raycast = acceleratedRaycast;
}

export interface MeasurementResult {
  start: THREE.Vector3;
  end: THREE.Vector3;
  distance: number;
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  snapType?: 'VERTEX' | 'EDGE' | 'FACE';
}

function closestPointOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  const ab = new THREE.Vector3().subVectors(b, a);
  const ap = new THREE.Vector3().subVectors(p, a);
  const abLenSq = ab.lengthSq();
  if (abLenSq < 1e-8) return a.clone();
  const t = Math.max(0, Math.min(1, ap.dot(ab) / abLenSq));
  return new THREE.Vector3().copy(a).addScaledVector(ab, t);
}

export class MeasureTool {
  private readonly viewer: Viewer3D;
  private isActive: boolean = false;

  private startPoint: THREE.Vector3 | null = null;
  private currentPoint: THREE.Vector3 | null = null;

  // Reusable raycasting and transformation objects (Rule 7: zero allocations in hot loop)
  private readonly raycaster: THREE.Raycaster = new THREE.Raycaster();
  private readonly pointer: THREE.Vector2 = new THREE.Vector2();
  private readonly effectiveMatrix: THREE.Matrix4 = new THREE.Matrix4();
  private readonly instanceMatrix: THREE.Matrix4 = new THREE.Matrix4();
  private readonly vA: THREE.Vector3 = new THREE.Vector3();
  private readonly vB: THREE.Vector3 = new THREE.Vector3();
  private readonly vC: THREE.Vector3 = new THREE.Vector3();

  // Visuals
  private readonly measureGroup: THREE.Group = new THREE.Group();
  private readonly lineMesh: THREE.Line;
  private readonly lineGeometry: THREE.BufferGeometry;
  private readonly startMarker: THREE.Mesh;
  private readonly endMarker: THREE.Mesh;

  private onMeasureUpdate?: (result: MeasurementResult | null) => void;

  constructor(viewer: Viewer3D, onMeasureUpdate?: (result: MeasurementResult | null) => void) {
    this.viewer = viewer;
    this.onMeasureUpdate = onMeasureUpdate;

    // Enable firstHitOnly for optimal three-mesh-bvh early exit
    (this.raycaster as any).firstHitOnly = true;

    this.measureGroup.name = 'MeasurementToolGroup';

    // Dimension line
    this.lineGeometry = new THREE.BufferGeometry();
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xef4444, // Technical measurement red
      linewidth: 2,
      depthTest: false,
    });
    this.lineMesh = new THREE.Line(this.lineGeometry, lineMat);
    this.lineMesh.renderOrder = 999;
    this.measureGroup.add(this.lineMesh);

    // Markers
    const markerGeo = new THREE.SphereGeometry(0.06, 16, 16);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0xef4444, depthTest: false });

    this.startMarker = new THREE.Mesh(markerGeo, markerMat);
    this.startMarker.renderOrder = 1000;
    this.startMarker.visible = false;
    this.measureGroup.add(this.startMarker);

    this.endMarker = new THREE.Mesh(markerGeo, markerMat);
    this.endMarker.renderOrder = 1000;
    this.endMarker.visible = false;
    this.measureGroup.add(this.endMarker);

    this.viewer.scene.add(this.measureGroup);
  }

  public activate(): void {
    if (this.isActive) return;
    this.isActive = true;
    this.reset();

    const dom = this.viewer.container;
    dom.addEventListener('pointerdown', this.onPointerDown, true);
    dom.addEventListener('pointermove', this.onPointerMove, true);
    window.addEventListener('keydown', this.onKeyDown);
  }

  public deactivate(): void {
    if (!this.isActive) return;
    this.isActive = false;
    this.reset();

    const dom = this.viewer.container;
    dom.removeEventListener('pointerdown', this.onPointerDown, true);
    dom.removeEventListener('pointermove', this.onPointerMove, true);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  public reset(): void {
    this.startPoint = null;
    this.currentPoint = null;
    this.startMarker.visible = false;
    this.endMarker.visible = false;
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(), 3));
    if (this.onMeasureUpdate) {
      this.onMeasureUpdate(null);
    }
  }

  private snapToIntersection(e: PointerEvent): { point: THREE.Vector3; snapType: 'VERTEX' | 'EDGE' | 'FACE' } | null {
    const rect = this.viewer.container.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.viewer.cameraRig.camera);

    const hits = this.raycaster.intersectObjects(this.viewer.meshPool.rootGroup.children, true);
    if (hits.length === 0) return null;

    const hit = hits[0];
    const point = hit.point.clone();

    // High-precision Vertex and Edge snapping on triangle mesh
    if (hit.face && hit.object instanceof THREE.Mesh) {
      const geo = hit.object.geometry as THREE.BufferGeometry;
      const posAttr = geo.getAttribute('position');
      if (posAttr && hit.face.a !== undefined) {
        // Resolve compound transformation matrix: M_world = object.matrixWorld * M_instance
        this.effectiveMatrix.copy(hit.object.matrixWorld);

        if ((hit.object as any).isBatchedMesh && typeof (hit as any).batchId === 'number') {
          (hit.object as THREE.BatchedMesh).getMatrixAt((hit as any).batchId, this.instanceMatrix);
          this.effectiveMatrix.multiply(this.instanceMatrix);
        } else if ((hit.object as any).isInstancedMesh && typeof hit.instanceId === 'number') {
          (hit.object as THREE.InstancedMesh).getMatrixAt(hit.instanceId, this.instanceMatrix);
          this.effectiveMatrix.multiply(this.instanceMatrix);
        }

        this.vA.fromBufferAttribute(posAttr, hit.face.a).applyMatrix4(this.effectiveMatrix);
        this.vB.fromBufferAttribute(posAttr, hit.face.b).applyMatrix4(this.effectiveMatrix);
        this.vC.fromBufferAttribute(posAttr, hit.face.c).applyMatrix4(this.effectiveMatrix);

        const vertexSnapDist = 0.20; // 20 cm vertex threshold
        const edgeSnapDist = 0.15;   // 15 cm edge threshold

        const dA = point.distanceTo(this.vA);
        const dB = point.distanceTo(this.vB);
        const dC = point.distanceTo(this.vC);

        if (dA < vertexSnapDist && dA <= dB && dA <= dC) return { point: this.vA.clone(), snapType: 'VERTEX' };
        if (dB < vertexSnapDist && dB <= dA && dB <= dC) return { point: this.vB.clone(), snapType: 'VERTEX' };
        if (dC < vertexSnapDist) return { point: this.vC.clone(), snapType: 'VERTEX' };

        // Edge snap test against triangle segments AB, BC, CA
        const ptAB = closestPointOnSegment(point, this.vA, this.vB);
        const ptBC = closestPointOnSegment(point, this.vB, this.vC);
        const ptCA = closestPointOnSegment(point, this.vC, this.vA);

        const distAB = point.distanceTo(ptAB);
        const distBC = point.distanceTo(ptBC);
        const distCA = point.distanceTo(ptCA);

        if (distAB < edgeSnapDist && distAB <= distBC && distAB <= distCA) {
          return { point: ptAB, snapType: 'EDGE' };
        }
        if (distBC < edgeSnapDist && distBC <= distAB && distBC <= distCA) {
          return { point: ptBC, snapType: 'EDGE' };
        }
        if (distCA < edgeSnapDist) {
          return { point: ptCA, snapType: 'EDGE' };
        }
      }
    }

    return { point, snapType: 'FACE' };
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.isActive || e.button !== 0) return;

    const snapResult = this.snapToIntersection(e);
    if (!snapResult) return;
    const { point, snapType } = snapResult;

    if (!this.startPoint) {
      // First point selected
      this.startPoint = point;
      this.startMarker.position.copy(point);
      this.startMarker.visible = true;
      e.stopPropagation();
    } else {
      // Second point locked
      this.currentPoint = point;
      this.endMarker.position.copy(point);
      this.endMarker.visible = true;
      this.updateMeasurement(point, snapType);
      this.startPoint = null; // Ready for next measurement
      e.stopPropagation();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.isActive || !this.startPoint) return;

    const snapResult = this.snapToIntersection(e);
    if (!snapResult) return;
    const { point, snapType } = snapResult;

    this.endMarker.position.copy(point);
    this.endMarker.visible = true;
    this.updateMeasurement(point, snapType);
  };

  private updateMeasurement(endPt: THREE.Vector3, snapType?: 'VERTEX' | 'EDGE' | 'FACE'): void {
    if (!this.startPoint) return;

    const start = this.startPoint;
    const positions = new Float32Array([
      start.x, start.y, start.z,
      endPt.x, endPt.y, endPt.z,
    ]);

    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.lineGeometry.computeBoundingSphere();

    const distance = start.distanceTo(endPt);
    const deltaX = Math.abs(endPt.x - start.x);
    const deltaY = Math.abs(endPt.y - start.y);
    const deltaZ = Math.abs(endPt.z - start.z);

    if (this.onMeasureUpdate) {
      this.onMeasureUpdate({
        start,
        end: endPt,
        distance,
        deltaX,
        deltaY,
        deltaZ,
        snapType,
      });
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.reset();
    }
  };

  public dispose(): void {
    this.deactivate();
    this.viewer.scene.remove(this.measureGroup);
    this.lineGeometry.dispose();
    this.startMarker.geometry.dispose();
    this.endMarker.geometry.dispose();
  }
}
