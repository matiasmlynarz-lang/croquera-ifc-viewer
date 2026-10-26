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
  private sunLight: THREE.DirectionalLight | null = null;
  private groundPlane: THREE.Mesh | null = null;
  private modelRadius: number = 10;

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

    // 1. Scene setup with architectural fog
    this.scene = new THREE.Scene();
    const bgColor = options.backgroundColor ?? 0xf0f1f5;
    this.scene.background = new THREE.Color(bgColor);
    this.scene.fog = new THREE.Fog(bgColor, 80, 500);

    // 2. Camera Rig
    this.cameraRig = new CameraRig();
    this.cameraRig.attach(this.container);

    // 3. Renderer with sRGB color space and ACESFilmic tone mapping
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';

    // 4. Lights & IBL Studio Environment
    this.setupLighting();

    // 5. Mesh Pool
    this.meshPool = new BatchedMeshPool(this.scene);

    // 6. Resize Observer
    this.handleResize();
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);

    // 7. Event listeners
    this.container.addEventListener('pointerdown', this.onPointerDown);
    this.container.addEventListener('pointerup', this.onPointerUp);
    this.container.addEventListener('pointermove', this.onPointerMove);

    // 8. Start loop
    this.start();
  }

  private setupLighting(): void {
    // Ambient light
    const ambient = new THREE.AmbientLight(0xffffff, 0.75);
    this.scene.add(ambient);

    // Hemisphere light for subtle porcelain gradient
    const hemi = new THREE.HemisphereLight(0xffffff, 0xe2e8f0, 0.45);
    hemi.position.set(0, 30, 0);
    this.scene.add(hemi);

    // Key directional light with soft architectural shadow
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(30, 60, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 300;
    const shadowD = 40;
    sun.shadow.camera.left = -shadowD;
    sun.shadow.camera.right = shadowD;
    sun.shadow.camera.top = shadowD;
    sun.shadow.camera.bottom = -shadowD;
    sun.shadow.bias = -0.0003;
    sun.shadow.radius = 2.5;
    sun.name = '__viewer_dir_light__';
    this.sunLight = sun;
    this.scene.add(sun);

    // Fill light
    const fill = new THREE.DirectionalLight(0xdbeafe, 0.4);
    fill.position.set(-25, 30, -25);
    this.scene.add(fill);

    // Ground plane for soft shadow receiver matching Croquera Viewport3D.ts
    const groundGeo = new THREE.PlaneGeometry(1000, 1000);
    const groundMat = new THREE.ShadowMaterial({ opacity: 0.14 });
    this.groundPlane = new THREE.Mesh(groundGeo, groundMat);
    this.groundPlane.name = '__viewer_ground__';
    this.groundPlane.rotation.x = -Math.PI / 2;
    this.groundPlane.position.y = 0;
    this.groundPlane.receiveShadow = true;
    this.scene.add(this.groundPlane);

    // IBL Studio Environment para reflejos PBR realistas a 60-120 FPS
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      pmrem.compileEquirectangularShader();

      const envScene = new THREE.Scene();
      envScene.background = new THREE.Color(0xf1f5f9);

      // Domo de estudio arquitectónico para iluminación HDRI procedural
      const envGeo = new THREE.SphereGeometry(100, 32, 16);
      const envMat = new THREE.MeshBasicMaterial({
        color: 0xf8fafc,
        side: THREE.BackSide,
      });
      envScene.add(new THREE.Mesh(envGeo, envMat));

      const envHemi = new THREE.HemisphereLight(0xffffff, 0x94a3b8, 1.2);
      envScene.add(envHemi);

      const light1 = new THREE.DirectionalLight(0xffffff, 2.0);
      light1.position.set(5, 12, 5);
      envScene.add(light1);

      const light2 = new THREE.DirectionalLight(0xbfdbfe, 1.0);
      light2.position.set(-8, -4, -6);
      envScene.add(light2);

      const renderTarget = pmrem.fromScene(envScene, 0.04);
      this.scene.environment = renderTarget.texture;
      pmrem.dispose();
      envGeo.dispose();
      envMat.dispose();
    } catch {
      // Fallback if WebGL PMREM not supported (e.g. headless tests)
    }
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
      this.updateFogDistances();
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
   * Recalculates dynamic linear fog distances:
   * - near: Placed behind focused model to keep model 100% sharp and crisp.
   * - far: Fuses ground plane into background porcelain color at the horizon.
   */
  private updateFogDistances(): void {
    if (!(this.scene.fog instanceof THREE.Fog)) return;
    const cameraDist = this.cameraRig.camera.position.distanceTo(this.cameraRig.target);
    const safeNear = Math.max(60.0, (cameraDist + this.modelRadius) * 1.3);
    const safeFar = Math.max(safeNear * 3.5, 400.0);
    this.scene.fog.near = safeNear;
    this.scene.fog.far = safeFar;
  }

  /**
   * Fits camera to entire model bounding box and dynamically updates shadow frustum and ground plane.
   */
  public fitModel(paddingFactor = 1.3): void {
    const box = this.meshPool.modelBoundingBox;
    this.cameraRig.fitBounds(box, paddingFactor);

    if (!box.isEmpty()) {
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const maxDim = Math.max(size.x, size.y, size.z, 10);
      this.modelRadius = maxDim / 2;

      // Adjust ground plane altitude and center to base of model
      if (this.groundPlane) {
        this.groundPlane.position.set(center.x, box.min.y - 0.01, center.z);
      }

      // Adjust sun shadow camera frustum and position to encompass entire model
      if (this.sunLight) {
        const shadowD = maxDim * 0.8;
        this.sunLight.position.set(center.x + shadowD, center.y + shadowD * 1.5, center.z + shadowD);
        this.sunLight.target.position.copy(center);
        this.sunLight.shadow.camera.left = -shadowD;
        this.sunLight.shadow.camera.right = shadowD;
        this.sunLight.shadow.camera.top = shadowD;
        this.sunLight.shadow.camera.bottom = -shadowD;
        this.sunLight.shadow.camera.near = 0.5;
        this.sunLight.shadow.camera.far = shadowD * 4;
        this.sunLight.shadow.camera.updateProjectionMatrix();
        this.sunLight.target.updateMatrixWorld();
      }

      this.updateFogDistances();
    }
  }

  private originalBatchColor: THREE.Color = new THREE.Color(0xffffff);
  private selectedElements: Array<{
    record: RenderedElementRecord;
    originalColor: THREE.Color;
    originalMaterial?: THREE.Material | THREE.Material[] | null;
  }> = [];

  /**
   * Selects an element by its ID or GUID and frames it.
   * If the element belongs to an ontological GROUP, all its child submeshes are highlighted
   * and the camera frames the group's unified bounding box.
   */
  public selectElement(idOrGuid: string, autoFrame = true): RenderedElementRecord | null {
    const el = this.meshPool.getElement(idOrGuid);
    this.clearSelection();

    if (el) {
      this.selectedElement = el;

      // Locate parent group or group metadata if part of an ontological GROUP
      const groupRec = el.groupId
        ? this.meshPool.getGroup(el.groupId)
        : this.meshPool.getGroupForElement(el.id);

      // Collect all child submeshes if group exists and has children; otherwise highlight this single element
      const targetRecords: RenderedElementRecord[] = [];
      if (groupRec && groupRec.childrenIds.length > 0) {
        for (const childId of groupRec.childrenIds) {
          const childRec = this.meshPool.getElement(childId);
          if (childRec) targetRecords.push(childRec);
        }
      }
      if (targetRecords.length === 0) {
        targetRecords.push(el);
      }

      const selectionBlue = new THREE.Color(0x2563eb); // Croquera technical selection blue

      for (const rec of targetRecords) {
        const savedColor = new THREE.Color(0xffffff);
        let savedMaterial: THREE.Material | THREE.Material[] | null = null;

        if ((rec.mesh as any).isBatchedMesh && rec.batchId !== undefined) {
          const batched = rec.mesh as THREE.BatchedMesh;
          try {
            if ((batched as any)._colorsTexture) {
              batched.getColorAt(rec.batchId, savedColor);
            } else {
              savedColor.set(0xffffff);
            }
          } catch {
            savedColor.set(0xffffff);
          }
          batched.setColorAt(rec.batchId, selectionBlue);
        } else if ((rec.mesh as any).isInstancedMesh && rec.batchId !== undefined) {
          const inst = rec.mesh as THREE.InstancedMesh;
          if (!inst.instanceColor) {
            inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(inst.count * 3).fill(1), 3);
          }
          try {
            inst.getColorAt(rec.batchId, savedColor);
          } catch {
            savedColor.set(0xffffff);
          }
          inst.setColorAt(rec.batchId, selectionBlue);
          inst.instanceColor.needsUpdate = true;
        } else if (rec.mesh instanceof THREE.Mesh) {
          savedMaterial = rec.mesh.material;
          rec.mesh.material = MaterialManager.getInstance().getSelectionMaterial();
        }

        this.selectedElements.push({
          record: rec,
          originalColor: savedColor,
          originalMaterial: savedMaterial,
        });
      }

      // Auto-frame camera using group's unified bounding box if available
      if (autoFrame) {
        const frameBox = groupRec && !groupRec.box.isEmpty() ? groupRec.box : el.box;
        if (!frameBox.isEmpty()) {
          this.cameraRig.fitBounds(frameBox, 1.5);
        }
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
    for (const item of this.selectedElements) {
      const rec = item.record;
      if ((rec.mesh as any).isBatchedMesh && rec.batchId !== undefined) {
        (rec.mesh as THREE.BatchedMesh).setColorAt(rec.batchId, item.originalColor);
      } else if ((rec.mesh as any).isInstancedMesh && rec.batchId !== undefined) {
        const inst = rec.mesh as THREE.InstancedMesh;
        inst.setColorAt(rec.batchId, item.originalColor);
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      } else if (rec.mesh instanceof THREE.Mesh && item.originalMaterial) {
        rec.mesh.material = item.originalMaterial;
      }
    }
    this.selectedElements = [];
    this.selectedElement = null;
    this.originalSelectMaterial = null;
  }

  private pointerDownPos: { x: number; y: number } = { x: 0, y: 0 };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button !== 0) return;

    // Discard clicks that were actually camera orbit/pan drag gestures
    const dist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
    if (dist > 5) return;

    const rect = this.container.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.cameraRig.camera);
    const intersects = this.raycaster.intersectObjects(this.meshPool.rootGroup.children, true);

    if (intersects.length > 0) {
      const hit = intersects[0];
      let elId: string | undefined;

      if ((hit as any).batchId !== undefined && (hit.object as any).isBatchedMesh) {
        elId = this.meshPool.getElementIdByBatch(hit.object as any, (hit as any).batchId);
      } else if ((hit as any).instanceId !== undefined && (hit.object as any).isInstancedMesh) {
        elId = this.meshPool.getElementIdByInstance(hit.object as any, (hit as any).instanceId);
      } else {
        const mesh = hit.object as THREE.Mesh;
        elId = mesh.userData?.id || mesh.name;
      }

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
    this.container.removeEventListener('pointerup', this.onPointerUp);
    this.container.removeEventListener('pointermove', this.onPointerMove);

    if (this.groundPlane) {
      this.groundPlane.geometry.dispose();
      (this.groundPlane.material as THREE.Material).dispose();
      this.groundPlane = null;
    }
    if (this.scene.environment) {
      this.scene.environment.dispose();
      this.scene.environment = null;
    }

    this.meshPool.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
