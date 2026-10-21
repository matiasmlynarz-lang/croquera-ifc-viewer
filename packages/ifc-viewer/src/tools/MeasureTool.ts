/**
 * MeasureTool — Interactive 3D point-to-point measurement tool with vertex snapping.
 *
 * Provides real-time distance and orthogonal delta readout in metric meters.
 */

import * as THREE from 'three';
import type { Viewer3D } from '../viewport/Viewer3D';

export interface MeasurementResult {
  start: THREE.Vector3;
  end: THREE.Vector3;
  distance: number;
  deltaX: number;
  deltaY: number;
  deltaZ: number;
}

export class MeasureTool {
  private readonly viewer: Viewer3D;
  private isActive: boolean = false;

  private startPoint: THREE.Vector3 | null = null;
  private currentPoint: THREE.Vector3 | null = null;

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

  private snapToIntersection(e: PointerEvent): THREE.Vector3 | null {
    const rect = this.viewer.container.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(x, y), this.viewer.cameraRig.camera);

    const hits = raycaster.intersectObjects(this.viewer.meshPool.rootGroup.children, true);
    if (hits.length === 0) return null;

    const hit = hits[0];
    const point = hit.point.clone();

    // Try snapping to nearest triangle vertex if within snap distance
    if (hit.face && hit.object instanceof THREE.Mesh) {
      const geo = hit.object.geometry as THREE.BufferGeometry;
      const posAttr = geo.getAttribute('position');
      if (posAttr && hit.face.a !== undefined) {
        const matrixWorld = hit.object.matrixWorld;
        const vA = new THREE.Vector3().fromBufferAttribute(posAttr, hit.face.a).applyMatrix4(matrixWorld);
        const vB = new THREE.Vector3().fromBufferAttribute(posAttr, hit.face.b).applyMatrix4(matrixWorld);
        const vC = new THREE.Vector3().fromBufferAttribute(posAttr, hit.face.c).applyMatrix4(matrixWorld);

        const snapDist = 0.25; // 25 cm threshold
        if (point.distanceTo(vA) < snapDist) return vA;
        if (point.distanceTo(vB) < snapDist) return vB;
        if (point.distanceTo(vC) < snapDist) return vC;
      }
    }

    return point;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.isActive || e.button !== 0) return;

    const point = this.snapToIntersection(e);
    if (!point) return;

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
      this.updateVisuals(this.startPoint, this.currentPoint);
      e.stopPropagation();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.isActive || !this.startPoint || this.endMarker.visible) return;

    const point = this.snapToIntersection(e);
    if (!point) return;

    this.currentPoint = point;
    this.updateVisuals(this.startPoint, this.currentPoint);
  };

  private updateVisuals(start: THREE.Vector3, end: THREE.Vector3): void {
    const positions = new Float32Array([
      start.x, start.y, start.z,
      end.x, end.y, end.z,
    ]);
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.lineGeometry.attributes.position.needsUpdate = true;

    const distance = start.distanceTo(end);
    const deltaX = Math.abs(end.x - start.x);
    const deltaY = Math.abs(end.y - start.y);
    const deltaZ = Math.abs(end.z - start.z);

    if (this.onMeasureUpdate) {
      this.onMeasureUpdate({
        start,
        end,
        distance,
        deltaX,
        deltaY,
        deltaZ,
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
  }
}
