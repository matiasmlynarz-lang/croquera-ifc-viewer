/**
 * Viewer3D — High-performance Three.js architectural viewport for IFC models.
 *
 * Provides:
 * - 60-120 FPS WebGL rendering with clay architectural shading.
 * - Progressive streaming integration with BatchedMeshPool.
 * - Selection raycasting and hover feedback.
 */

import * as THREE from 'three';
import { CameraRig } from './CameraRig';
import { BatchedMeshPool, type RenderedElementRecord } from '../renderer/BatchedMeshPool';
import { MaterialManager } from '../renderer/MaterialManager';

export interface ViewerOptions {
  container: HTMLElement;
  backgroundColor?: number;
  onElementSelected?: (element: RenderedElementRecord | null) => void;
}

export class Viewer3D {
  public readonly container: HTMLElement;
  public readonly scene: THREE.Scene;
  public readonly cameraRig: CameraRig;
  public readonly renderer: THREE.WebGLRenderer;
  public readonly meshPool: BatchedMeshPool;

  private isRunning: boolean = false;
  private animationFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Raycasting & Interaction
  private readonly raycaster: THREE.Raycaster = new THREE.Raycaster();
  private readonly pointer: THREE.Vector2 = new THREE.Vector2();
  private selectedElement: RenderedElementRecord | null = null;
  private hoveredElement: RenderedElementRecord | null = null;
  private originalHoverMaterial: THREE.Material | THREE.Material[] | null = null;
  private originalSelectMaterial: THREE.Material | THREE.Material[] | null = null;

  private readonly onElementSelected?: (element: RenderedElementRecord | null) => void;

  constructor(options: ViewerOptions) {
    this.container = options.container;
    this.onElementSelected = options.onElementSelected;

    // 1. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(options.backgroundColor ?? 0xf0f1f5);

    // 2. Camera Rig
    this.cameraRig = new CameraRig();
    this.cameraRig.attach(this.container);

    // 3. Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';

    // 4. Lights
    this.setupLighting();

    // 5. Mesh Pool
    this.meshPool = new BatchedMeshPool(this.scene);

    // 6. Resize Observer
    this.handleResize();
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);

    // 7. Event listeners
    this.container.addEventListener('pointerdown', this.onPointerDown);
    this.container.addEventListener('pointermove', this.onPointerMove);

    // 8. Start loop
    this.start();
  }

  private setupLighting(): void {
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    this.scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0xffffff, 0xe2e8f0, 0.6);
    hemi.position.set(0, 100, 0);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(60, 120, 80);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 1000;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0xb0c4de, 0.4);
    fill.position.set(-60, 40, -80);
    this.scene.add(fill);
  }

  private handleResize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    this.renderer.setSize(width, height, false);
    this.cameraRig.resize(width, height);
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const animate = (): void => {
      if (!this.isRunning) return;
      this.cameraRig.update();
      this.renderer.render(this.scene, this.cameraRig.camera);
      this.animationFrameId = requestAnimationFrame(animate);
    };

    this.animationFrameId = requestAnimationFrame(animate);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Fits camera to entire model bounding box.
   */
  public fitModel(paddingFactor = 1.3): void {
    this.cameraRig.fitBounds(this.meshPool.modelBoundingBox, paddingFactor);
  }

  /**
   * Selects an element by its ID or GUID and frames it.
   */
  public selectElement(idOrGuid: string, autoFrame = true): RenderedElementRecord | null {
    const el = this.meshPool.getElement(idOrGuid);
    this.clearSelection();

    if (el) {
      this.selectedElement = el;
      this.originalSelectMaterial = el.mesh.material;
      el.mesh.material = MaterialManager.getInstance().getSelectionMaterial();

      if (autoFrame && !el.box.isEmpty()) {
        this.cameraRig.fitBounds(el.box, 1.5);
      }

      if (this.onElementSelected) {
        this.onElementSelected(el);
      }
      return el;
    }

    if (this.onElementSelected) {
      this.onElementSelected(null);
    }
    return null;
  }

  public clearSelection(): void {
    if (this.selectedElement && this.originalSelectMaterial) {
      this.selectedElement.mesh.material = this.originalSelectMaterial;
      this.selectedElement = null;
      this.originalSelectMaterial = null;
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    // Only handle primary button clicks without drags
    if (e.button !== 0) return;

    const rect = this.container.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.cameraRig.camera);
    const intersects = this.raycaster.intersectObjects(this.meshPool.rootGroup.children, true);

    if (intersects.length > 0) {
      const hit = intersects[0];
      const mesh = hit.object as THREE.Mesh;
      const elId = mesh.userData?.id || mesh.name;
      if (elId) {
        this.selectElement(elId, false);
      }
    } else {
      this.clearSelection();
      if (this.onElementSelected) {
        this.onElementSelected(null);
      }
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.container.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.cameraRig.camera);
    const intersects = this.raycaster.intersectObjects(this.meshPool.rootGroup.children, true);

    if (intersects.length > 0) {
      this.container.style.cursor = 'pointer';
    } else {
      this.container.style.cursor = 'default';
    }
  };

  public dispose(): void {
    this.stop();
    this.cameraRig.detach();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.container.removeEventListener('pointerdown', this.onPointerDown);
    this.container.removeEventListener('pointermove', this.onPointerMove);

    this.meshPool.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
