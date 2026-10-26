/**
 * CameraRig — Smooth architectural camera controller with orbit, pan, zoom, and auto-framing.
 *
 * Implements smooth spring-damped transitions and fitBounds for instant element/model framing.
 */

import * as THREE from 'three';

export interface CameraRigOptions {
  fov?: number;
  near?: number;
  far?: number;
  damping?: number;
}

export class CameraRig {
  public readonly camera: THREE.PerspectiveCamera;
  public target: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

  // Spherical coordinates for orbit
  private spherical: THREE.Spherical = new THREE.Spherical(50, Math.PI / 3, Math.PI / 4);
  private targetSpherical: THREE.Spherical = new THREE.Spherical(50, Math.PI / 3, Math.PI / 4);
  private desiredTarget: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

  private readonly damping: number;
  private domElement: HTMLElement | null = null;

  // Interaction state
  private isPointerDown: boolean = false;
  private pointerMode: 'ORBIT' | 'PAN' = 'ORBIT';
  private prevPointer: { x: number; y: number } = { x: 0, y: 0 };

  constructor(options: CameraRigOptions = {}) {
    const fov = options.fov || 45;
    const near = options.near || 0.5;
    const far = options.far || 1500;
    this.damping = options.damping || 0.12;

    this.camera = new THREE.PerspectiveCamera(fov, 1, near, far);
    this.updateCameraPosition();
  }

  public attach(domElement: HTMLElement): void {
    this.domElement = domElement;

    domElement.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    domElement.addEventListener('wheel', this.onWheel, { passive: false });
    domElement.addEventListener('contextmenu', this.onContextMenu);
  }

  public detach(): void {
    if (!this.domElement) return;

    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.domElement.removeEventListener('wheel', this.onWheel);
    this.domElement.removeEventListener('contextmenu', this.onContextMenu);
    this.domElement = null;
  }

  public resize(width: number, height: number): void {
    if (height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Smoothly animates camera to frame the given bounding box.
   */
  public fitBounds(box: THREE.Box3, paddingFactor = 1.3): void {
    if (box.isEmpty()) return;

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const distance = (maxDim / (2 * Math.tan(fovRad / 2))) * paddingFactor;

    this.desiredTarget.copy(center);
    this.targetSpherical.radius = Math.max(distance, 2.0);

    // Calibrate depth precision to model scale (near/far ratio <= 1000)
    this.camera.near = Math.max(0.1, distance * 0.01);
    this.camera.far = Math.max(500, distance * 10);
    this.camera.updateProjectionMatrix();
  }

  public update(): void {
    // Smooth damp towards desired spherical coordinates
    this.spherical.radius += (this.targetSpherical.radius - this.spherical.radius) * this.damping;
    this.spherical.theta += (this.targetSpherical.theta - this.spherical.theta) * this.damping;
    this.spherical.phi += (this.targetSpherical.phi - this.spherical.phi) * this.damping;

    // Clamp phi to prevent singularity at poles
    this.spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, this.spherical.phi));

    // Smooth damp towards desired target
    this.target.lerp(this.desiredTarget, this.damping);

    this.updateCameraPosition();
  }

  private updateCameraPosition(): void {
    const offset = new THREE.Vector3().setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.isPointerDown = true;
    this.prevPointer = { x: e.clientX, y: e.clientY };

    // Middle click or Right click or Shift+Left click = PAN
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
      this.pointerMode = 'PAN';
    } else {
      this.pointerMode = 'ORBIT';
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.isPointerDown) return;

    const dx = e.clientX - this.prevPointer.x;
    const dy = e.clientY - this.prevPointer.y;
    this.prevPointer = { x: e.clientX, y: e.clientY };

    if (this.pointerMode === 'ORBIT') {
      const rotSpeed = 0.005;
      this.targetSpherical.theta -= dx * rotSpeed;
      this.targetSpherical.phi -= dy * rotSpeed;
    } else if (this.pointerMode === 'PAN') {
      const panSpeed = this.targetSpherical.radius * 0.001;
      const right = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);

      this.camera.getWorldDirection(right);
      right.cross(up).normalize();

      const panDelta = new THREE.Vector3()
        .addScaledVector(right, -dx * panSpeed)
        .addScaledVector(up, dy * panSpeed);

      this.desiredTarget.add(panDelta);
      this.target.add(panDelta);
    }
  };

  private onPointerUp = (): void => {
    this.isPointerDown = false;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
    this.targetSpherical.radius = Math.max(1.0, this.targetSpherical.radius * zoomFactor);
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };
}
