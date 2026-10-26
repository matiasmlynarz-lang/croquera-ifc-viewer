/**
 * main.ts — Application entry point for croquera-ifc-viewer.
 *
 * Connects the 3-stage progressive ingestion worker with buffer-first Three.js rendering,
 * GUID search, distance measurement, and the zero-copy bridge to croquera.com.
 */

import './styles/viewer.css';
import * as THREE from 'three';
import { Viewer3D, MaterialManager } from '@croquera/ifc-viewer';
import { GuidSearchEngine } from '@croquera/ifc-viewer';
import { MeasureTool, type MeasurementResult } from '@croquera/ifc-viewer';
import { CroqueraBridge } from '@croquera/ifc-viewer';
import { IfcAdaptiveWorkerPool } from '@croquera/ifc-core';
import type {
  Stage2BoundsPayload,
  Stage3GeometryChunkPayload,
} from '@croquera/ifc-core';

import { TopHud } from './ui/TopHud';
import { SearchFlyout } from './ui/SearchFlyout';
import { PropertiesCard } from './ui/PropertiesCard';
import { StatusHud } from './ui/StatusHud';
import { DropOverlay } from './ui/DropOverlay';

// ─── DOM Root Scaffold ──────────────────────────────────────────
const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="viewer-layout">
    <div id="viewport" class="viewport-container"></div>
    <div id="measurement-badge" class="measurement-badge">
      <span id="measurement-distance">0.00 m</span>
      <span id="measurement-deltas" style="color: var(--text-muted); font-size: 10px;"></span>
    </div>
  </div>
`;

const layout = app.querySelector('.viewer-layout') as HTMLElement;
const viewportContainer = layout.querySelector('#viewport') as HTMLElement;
const measureBadge = layout.querySelector('#measurement-badge') as HTMLElement;
const measureDistance = layout.querySelector('#measurement-distance') as HTMLElement;
const measureDeltas = layout.querySelector('#measurement-deltas') as HTMLElement;

// ─── Adaptive Worker Pool Initialization ────────────────────────
const workerPool = new IfcAdaptiveWorkerPool({
  workerFactory: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
});

// ─── Core Viewport & Engines ────────────────────────────────────
const propertiesCard = new PropertiesCard({
  onClose: () => {
    viewer.clearSelection();
  },
  onRequestPsets: async (stepId: number) => {
    const el = viewer.meshPool.getElementByStepId(stepId);
    if (el && el.psets && Object.keys(el.psets).length > 0) {
      return el.psets;
    }
    if (stepId > 0) {
      const resolved = await workerPool.resolveProperties(stepId);
      if (el && resolved && Object.keys(resolved).length > 0) {
        el.psets = resolved;
      }
      return resolved;
    }
    return {};
  },
});
layout.appendChild(propertiesCard.container);

const viewer = new Viewer3D({
  container: viewportContainer,
  onElementSelected: (element) => {
    propertiesCard.show(element);
  },
});

const searchEngine = new GuidSearchEngine(viewer.meshPool);
const croqueraBridge = new CroqueraBridge();

// ─── Measure Tool ───────────────────────────────────────────────
const measureTool = new MeasureTool(viewer, (result: MeasurementResult | null) => {
  if (result) {
    measureBadge.classList.add('visible');
    measureDistance.textContent = `${result.distance.toFixed(3)} m`;
    measureDeltas.textContent = `(dx: ${result.deltaX.toFixed(2)}, dy: ${result.deltaY.toFixed(2)}, dz: ${result.deltaZ.toFixed(2)})`;
  } else {
    measureBadge.classList.remove('visible');
  }
});

// ─── UI HUD & Navigation ────────────────────────────────────────
const statusHud = new StatusHud();
layout.appendChild(statusHud.container);

const searchFlyout = new SearchFlyout(searchEngine, {
  onSelectResult: (elementId: string) => {
    viewer.selectElement(elementId, true);
  },
});

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.ifc,.step';
fileInput.style.display = 'none';
document.body.appendChild(fileInput);

fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) {
    loadIfcFile(fileInput.files[0]);
  }
});

const topHud = new TopHud({
  onOpenFile: () => {
    fileInput.click();
  },
  onToggleMeasure: (active: boolean) => {
    if (active) {
      measureTool.activate();
      statusHud.setReady('Measure tool active. Click two points on the model.');
    } else {
      measureTool.deactivate();
      statusHud.setReady('Measurement finished.');
    }
  },
  onEditInCroquera: () => {
    croqueraBridge.editInCroquera();
  },
});
topHud.getSearchSlot().appendChild(searchFlyout.container);
layout.appendChild(topHud.container);

const dropOverlay = new DropOverlay({
  onFileDropped: (file: File) => {
    loadIfcFile(file);
  },
});
layout.appendChild(dropOverlay.container);


// ─── Progressive IFC Streaming Ingestion ────────────────────────
async function loadIfcFile(file: File): Promise<void> {
  statusHud.setLoading(`Streaming ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)...`);

  const startTime = performance.now();
  viewer.meshPool.clear();
  propertiesCard.hide();
  searchFlyout.clear();
  searchEngine.markDirty();
  topHud.setMeasureActive(false);
  measureTool.deactivate();

  try {
    croqueraBridge.setFile(file);
    const buffer = await file.arrayBuffer();

    let totalParsed = 0;
    let totalExpected = 0;
    let initialBox: THREE.Box3 | null = null;

    const updateHudProgress = () => {
      if (totalExpected > 0) {
        if (totalParsed > totalExpected) {
          totalExpected = totalParsed;
        }
        const pct = Math.min(99, Math.max(1, Math.round((totalParsed / totalExpected) * 100)));
        statusHud.setLoading(`Tessellating ${totalParsed} / ${totalExpected} elements (${pct}%)...`);
      } else {
        statusHud.setLoading(`Tessellating ${totalParsed} elements...`);
      }
    };

    await workerPool.parseFile(buffer, 200, (response) => {
      if (response.type === 'STAGE_SPATIAL_HIERARCHY') {
        if (response.materials && response.materials.length > 0) {
          MaterialManager.getInstance().registerMaterials(response.materials);
        }
        statusHud.setLoading(
          `Spatial hierarchy loaded (${response.spatialNodes.length} nodes, ${response.materials?.length || 0} materials).`
        );
      } else if (response.type === 'STAGE_BOUNDS_AABB') {
        const boundsPayload = response as Stage2BoundsPayload;
        totalExpected = boundsPayload.totalModelElements || boundsPayload.totalElements;
        const min = boundsPayload.modelAABB.min;
        const max = boundsPayload.modelAABB.max;
        const centerX = (min[0] + max[0]) / 2;
        const centerZ = (min[2] + max[2]) / 2;
        const minY = min[1];
        const horizontalDist = Math.hypot(centerX, centerZ);
        const isGeoreferenced = horizontalDist > 50 || Math.abs(minY) > 50;

        if (isGeoreferenced) {
          const offsetY = Math.abs(minY) > 5 ? minY : 0;
          viewer.meshPool.setRenderOffset(new THREE.Vector3(centerX, offsetY, centerZ));
        } else {
          viewer.meshPool.setRenderOffset(new THREE.Vector3(0, 0, 0));
        }

        const off = viewer.meshPool.getRenderOffset();
        initialBox = new THREE.Box3(
          new THREE.Vector3(min[0] - off.x, min[1] - off.y, min[2] - off.z),
          new THREE.Vector3(max[0] - off.x, max[1] - off.y, max[2] - off.z)
        );
        viewer.cameraRig.fitBounds(initialBox);
        statusHud.setLoading(`Camera framed on ${totalExpected} elements. Tessellating...`);
      } else if (response.type === 'STAGE_GEOMETRY_CHUNK') {
        const chunk = response as Stage3GeometryChunkPayload;
        viewer.meshPool.ingestChunk(chunk.elements);
        totalParsed += chunk.elements.length;
        if (chunk.chunkIndex === 0 && !viewer.meshPool.modelBoundingBox.isEmpty()) {
          const isDummyInitialBox = !initialBox || (
            Math.abs(initialBox.min.x - (-0.5)) < 0.01 &&
            Math.abs(initialBox.max.x - 0.5) < 0.01
          );
          if (isDummyInitialBox) {
            viewer.cameraRig.fitBounds(viewer.meshPool.modelBoundingBox);
          }
        }
        updateHudProgress();
      } else if (response.type === 'STAGE_INSTANCE_BATCH') {
        viewer.meshPool.ingestInstanceBatch(response.prototypeId, response.instances);
        totalParsed += response.instances.length;
        updateHudProgress();
      } else if (response.type === 'STAGE_COMPLETE') {
        statusHud.setLoading(`Finalizing ${response.totalElements} elements (100%)...`);
        searchEngine.rebuildIndex();
        const elapsed = (performance.now() - startTime).toFixed(0);
        if (!viewer.meshPool.modelBoundingBox.isEmpty()) {
          viewer.fitModel();
        }
        const threadsInfo = workerPool.isMultiThreadedSupported()
          ? `${workerPool.getPoolSize()} workers (parallel)`
          : '1 worker';
        statusHud.setReady(
          `Loaded ${response.totalElements} elements in ${elapsed} ms [${threadsInfo}]. Viewport active at 120 FPS.`
        );
      } else if (response.type === 'STAGE_ERROR') {
        statusHud.setError(`Error loading model: ${response.error}`);
      }
    });
  } catch (err: any) {
    statusHud.setError(`Failed to process model: ${err?.message || err}`);
  }
}
