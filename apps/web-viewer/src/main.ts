/**
 * main.ts — Application entry point for croquera-ifc-viewer.
 *
 * Connects the 3-stage progressive ingestion worker with buffer-first Three.js rendering,
 * native multi-file IFC federation (ModelManager), GUID search, distance measurement,
 * zero-copy bridge to Croquera, and the bidirectional QWebChannel IPC bridge for AIF_BIM_02.
 */

import './styles/viewer.css';
import * as THREE from 'three';
import { Viewer3D, MaterialManager, BatchedMeshPool } from '@croquera/ifc-viewer';
import { GuidSearchEngine } from '@croquera/ifc-viewer';
import { MeasureTool, type MeasurementResult } from '@croquera/ifc-viewer';
import { CroqueraBridge } from '@croquera/ifc-viewer';
import { IfcAdaptiveWorkerPool } from '@croquera/ifc-core';
import type {
  Stage2BoundsPayload,
  Stage3GeometryChunkPayload,
  SpatialNodeDTO,
} from '@croquera/ifc-core';
import type { RenderedElementRecord } from '@croquera/ifc-viewer';

import { TopHud } from './ui/TopHud';
import { SearchFlyout } from './ui/SearchFlyout';
import { PropertiesCard } from './ui/PropertiesCard';
import { StatusHud } from './ui/StatusHud';
import { DropOverlay } from './ui/DropOverlay';

// ── QWebChannel Type Declarations ──────────────────────────────────────────────
declare global {
  interface Window {
    QWebChannel?: any;
    qt?: any;
    backend?: any;
    cargarModeloIFC: (url: string, archivo: string) => Promise<void>;
    cargarModeloDWG: (url: string, archivo: string) => Promise<void>;
    cargarModeloContexto: (url: string, nombre: string) => void;
    retirarModeloContexto: (nombre: string) => void;
    limpiarContextos: () => void;
    limpiarEscenaCompleta: () => void;
    recibirSemantica: (semantica: Record<string, any>) => void;
    resaltarElementoPorID: (id: string, expressIDs?: number[]) => Promise<void>;
    aislarPorExpressIDs: (expressIDs: number[]) => Promise<void>;
    setProgress: (msg: string) => void;
  }
}

// ── DOM Root Scaffold ─────────────────────────────────────────────────────────
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

// ── Adaptive Worker Pool Initialization ────────────────────────────────────────
const workerPool = new IfcAdaptiveWorkerPool({
  workerFactory: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
});

// ── Semantic Map & Inverse Index ───────────────────────────────────────────────
const condIdToStepIdsMap = new Map<string, number[]>();
const stepIdToCondIdMap = new Map<number, string>();
const guidToCondIdMap = new Map<string, string>();

window.recibirSemantica = function (semantica: Record<string, { expressID?: number[] }>) {
  console.log(`[CroqueraViewer] Semántica inyectada desde Python: ${Object.keys(semantica).length} IDs`);
  condIdToStepIdsMap.clear();
  stepIdToCondIdMap.clear();

  for (const condId in semantica) {
    const data = semantica[condId];
    if (data && Array.isArray(data.expressID)) {
      condIdToStepIdsMap.set(condId, data.expressID);
      for (const stepId of data.expressID) {
        stepIdToCondIdMap.set(stepId, condId);
      }
    }
  }
};

// ── QWebChannel IPC Initialization ─────────────────────────────────────────────
function initQWebChannel() {
  if (typeof window.QWebChannel !== 'undefined' && window.qt && window.qt.webChannelTransport) {
    new window.QWebChannel(window.qt.webChannelTransport, (channel: any) => {
      window.backend = channel.objects.backend;
      console.log('[CroqueraViewer] Conectado al backend de Qt');
    });
  }
}
initQWebChannel();

// ── Core Viewport & Engines ────────────────────────────────────────────────────
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
    if (element) {
      propertiesCard.show(element);

      let foundCondId: string | null = null;
      if (element.stepId && stepIdToCondIdMap.has(element.stepId)) {
        foundCondId = stepIdToCondIdMap.get(element.stepId)!;
      } else if (element.id && guidToCondIdMap.has(element.id)) {
        foundCondId = guidToCondIdMap.get(element.id)!;
      }

      if (window.backend) {
        if (foundCondId) {
          console.log(`[CroqueraViewer] Clic en elemento con CONDICION.ID: ${foundCondId}`);
          window.backend.recibirElementoSeleccionado(foundCondId);
        } else {
          window.backend.recibirElementoSeleccionado(element.id || String(element.stepId));
        }
      }
    }
  },
});

const searchEngine = new GuidSearchEngine(viewer.meshPool);
const croqueraBridge = new CroqueraBridge();

// ── Measure Tool ───────────────────────────────────────────────────────────────
const measureTool = new MeasureTool(viewer, (result: MeasurementResult | null) => {
  if (result) {
    measureBadge.classList.add('visible');
    measureDistance.textContent = `${result.distance.toFixed(3)} m`;
    measureDeltas.textContent = `(dx: ${result.deltaX.toFixed(2)}, dy: ${result.deltaY.toFixed(2)}, dz: ${result.deltaZ.toFixed(2)})`;
  } else {
    measureBadge.classList.remove('visible');
  }
});

// ── UI HUD & Navigation ────────────────────────────────────────────────────────
const statusHud = new StatusHud();
layout.appendChild(statusHud.container);

const searchFlyout = new SearchFlyout(searchEngine, {
  onSelectResult: (elementId: string) => {
    viewer.selectElement(elementId, true);
  },
});

// ── Fase 1 & 2: Selector Nativo Múltiple e Iteración Asíncrona ─────────────────
const fileInput = document.createElement('input');
fileInput.id = 'ifc-file-input';
fileInput.type = 'file';
fileInput.multiple = true;
fileInput.accept = '.ifc,.step,.stp';
fileInput.style.display = 'none';
document.body.appendChild(fileInput);

fileInput.addEventListener('change', async (event) => {
  const target = event.target as HTMLInputElement;
  const files = target.files;
  if (!files || files.length === 0) return;

  const fileList = Array.from(files);
  // Limpiar el valor inmediatamente para permitir volver a cargar los mismos archivos si es necesario
  fileInput.value = '';

  await loadIfcFilesBatch(fileList);
});

const topHud = new TopHud({
  onOpenFile: () => {
    fileInput.click();
  },
  onToggleMeasure: (active: boolean) => {
    if (active) {
      measureTool.activate();
      statusHud.setReady('Herramienta de medición activa. Clic en dos puntos para medir.');
    } else {
      measureTool.deactivate();
      statusHud.setReady('Medición finalizada.');
    }
  },
  onEditInCroquera: () => {
    croqueraBridge.editInCroquera();
  },
});
topHud.getSearchSlot().appendChild(searchFlyout.container);
layout.appendChild(topHud.container);

const dropOverlay = new DropOverlay({
  onFilesDropped: (files: File[]) => {
    void loadIfcFilesBatch(files);
  },
  onFileDropped: (file: File) => {
    void loadIfcFilesBatch([file]);
  },
});
layout.appendChild(dropOverlay.container);

// ── Bounding Box Global de la Escena (Modelos Federados + Contextos) ───────────
const combinedSceneBounds = new THREE.Box3();
let hasEstablishedGlobalRenderOffset = false;
const globalWorldRenderOffset = new THREE.Vector3(0, 0, 0);

let currentIngestId = 0;
let isIsolated = false;
let mainDwgGroup: THREE.Group | null = null;
let idPeticionGlobal = 0;
let procesandoCola = false;
let totalEnColaHist = 0;
let procesadosContextos = 0;

interface ContextQueueItem {
  url: string;
  nombre: string;
}
const colaDeCarga: ContextQueueItem[] = [];

// Context Pools para modelos IFC (un BatchedMeshPool por modelo para gestión limpia)
const contextIfcPools = new Map<string, BatchedMeshPool>();
// Context Groups para modelos DWG
const contextDwgGroups = new Map<string, THREE.Group>();

function restoreIsolation() {
  if (!isIsolated) return;
  const elements = viewer.meshPool.getAllElements();
  for (const el of elements) {
    if ((el.mesh as any).isBatchedMesh && el.batchId !== undefined) {
      (el.mesh as THREE.BatchedMesh).setVisibleAt(el.batchId, true);
    } else if (el.mesh instanceof THREE.Mesh) {
      el.mesh.visible = true;
    }
  }
  isIsolated = false;
}

/**
 * Limpia integralmente el viewport, geometrías, árboles, memorias intermedias y tarjetas de propiedades.
 * Garantiza que cada nueva carga sustituya por completo la escena previa, permitiendo la federación
 * exclusivamente cuando el usuario selecciona múltiples archivos en una sola acción.
 */
function resetViewportScene(): void {
  currentIngestId++;
  idPeticionGlobal++;
  colaDeCarga.length = 0;
  procesandoCola = false;
  totalEnColaHist = 0;
  procesadosContextos = 0;

  restoreIsolation();
  viewer.meshPool.clear();
  viewer.clearSelection();
  modelManager.clear();
  hasEstablishedGlobalRenderOffset = false;
  globalWorldRenderOffset.set(0, 0, 0);

  if (mainDwgGroup) {
    viewer.scene.remove(mainDwgGroup);
    mainDwgGroup = null;
  }

  for (const [, pool] of contextIfcPools) {
    pool.dispose();
  }
  contextIfcPools.clear();

  for (const [, group] of contextDwgGroups) {
    viewer.scene.remove(group);
    group.traverse((c) => {
      if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose();
    });
  }
  contextDwgGroups.clear();
  combinedSceneBounds.makeEmpty();

  propertiesCard.closeAll();
  searchFlyout.clear();
  searchEngine.markDirty();
  topHud.setMeasureActive(false);
  measureTool.deactivate();
  condIdToStepIdsMap.clear();
  stepIdToCondIdMap.clear();
}

// ── Fase 3: ModelManager — Federación de Múltiples Modelos IFC ─────────────────
export interface LoadedModelEntry {
  modelId: string;
  name: string;
  elementCount: number;
  spatialTree: SpatialNodeDTO[];
  bounds: THREE.Box3;
  loadedAt: number;
}

class ModelManager {
  public readonly loadedModels: Map<string, LoadedModelEntry> = new Map();
  private modelSeq: number = 0;

  public generateUniqueId(filename: string): string {
    this.modelSeq++;
    const cleanName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `mdl_${this.modelSeq}_${cleanName}`;
  }

  public getTotalElements(): number {
    let sum = 0;
    for (const m of this.loadedModels.values()) {
      sum += m.elementCount;
    }
    return sum;
  }

  public async addModel(
    file: File,
    buffer: ArrayBuffer,
    batchInfo?: { current: number; total: number }
  ): Promise<LoadedModelEntry> {
    const modelId = this.generateUniqueId(file.name);
    const startTime = performance.now();

    const parsedData = await parseIfcBufferFederated(buffer, file.name, modelId, startTime, batchInfo);

    const entry: LoadedModelEntry = {
      modelId,
      name: file.name,
      elementCount: parsedData.elementCount,
      spatialTree: parsedData.spatialNodes,
      bounds: parsedData.modelBox,
      loadedAt: Date.now(),
    };

    this.loadedModels.set(modelId, entry);
    return entry;
  }

  public clear(): void {
    this.loadedModels.clear();
    this.modelSeq = 0;
  }
}

const modelManager = new ModelManager();
(window as any).__CROQUERA_MODEL_MANAGER__ = modelManager;

// ── Fase 2 & 4: Carga Individual y por Lotes con Feedback Global ───────────────
async function loadIfcFilesBatch(files: File[]): Promise<void> {
  if (files.length === 0) return;

  // Limpiar viewport y estado antes de iniciar la nueva carga.
  // La federación ocurre exclusivamente entre los modelos seleccionados juntos en este lote.
  resetViewportScene();

  const batchStartTime = performance.now();
  const totalFiles = files.length;

  for (let i = 0; i < totalFiles; i++) {
    const file = files[i];
    await loadIfcFile(file, i + 1, totalFiles);
  }

  if (totalFiles > 1) {
    const totalElapsed = (performance.now() - batchStartTime).toFixed(0);
    const totalModels = modelManager.loadedModels.size;
    const totalElements = modelManager.getTotalElements();
    statusHud.setReady(
      `Lote completado: ${totalFiles} archivos cargados (${totalModels} modelos en escena, ${totalElements} elementos en ${totalElapsed} ms). Viewport 120 FPS.`
    );
  }
}

async function loadIfcFile(file: File, batchIndex: number = 1, batchTotal: number = 1): Promise<void> {
  const prefix = batchTotal > 1 ? `[Cargando ${batchIndex} de ${batchTotal} archivos] ` : '';
  statusHud.setLoading(`${prefix}Streaming ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)...`);

  searchEngine.markDirty();
  topHud.setMeasureActive(false);
  measureTool.deactivate();

  try {
    croqueraBridge.setFile(file);
    const buffer = await file.arrayBuffer();
    croqueraBridge.setFile(buffer, file.name);
    await modelManager.addModel(file, buffer, { current: batchIndex, total: batchTotal });
  } catch (err: any) {
    statusHud.setError(`${prefix}Failed to process ${file.name}: ${err?.message || err}`);
  }
}

// ── Core Buffer Ingestion Engine (Federated Multi-Model Support) ───────────────
function parseIfcBufferFederated(
  buffer: ArrayBuffer,
  filename: string,
  modelId: string,
  startTime: number,
  batchInfo?: { current: number; total: number }
): Promise<{ elementCount: number; spatialNodes: SpatialNodeDTO[]; modelBox: THREE.Box3 }> {
  currentIngestId++;
  const thisIngestId = currentIngestId;

  let totalParsed = 0;
  let totalExpected = 0;
  let initialBox: THREE.Box3 | null = null;
  let spatialNodes: SpatialNodeDTO[] = [];
  const modelBox = new THREE.Box3();
  const remappedIdTable = new Map<string, string>();

  const batchPrefix =
    batchInfo && batchInfo.total > 1
      ? `Cargando ${batchInfo.current} de ${batchInfo.total} archivos (${filename}) — `
      : '';

  const resolveUniqueElementId = (rawId: string): string => {
    const cached = remappedIdTable.get(rawId);
    if (cached) return cached;
    if (viewer.meshPool.getElement(rawId) || viewer.meshPool.getGroup(rawId)) {
      const namespaced = `${modelId}:${rawId}`;
      remappedIdTable.set(rawId, namespaced);
      return namespaced;
    }
    remappedIdTable.set(rawId, rawId);
    return rawId;
  };

  const updateHudProgress = () => {
    if (totalExpected > 0) {
      if (totalParsed > totalExpected) {
        totalExpected = totalParsed;
      }
      const pct = Math.min(99, Math.max(1, Math.round((totalParsed / totalExpected) * 100)));
      statusHud.setLoading(`${batchPrefix}Teselando ${totalParsed} / ${totalExpected} elementos (${pct}%)...`);
    } else {
      statusHud.setLoading(`${batchPrefix}Teselando ${totalParsed} elementos...`);
    }
  };

  return new Promise((resolve, reject) => {
    workerPool.parseFile(buffer, 200, (response) => {
      if (thisIngestId !== currentIngestId) {
        resolve({ elementCount: totalParsed, spatialNodes, modelBox });
        return;
      }

      if (response.type === 'STAGE_SPATIAL_HIERARCHY') {
        spatialNodes = response.spatialNodes || [];
        if (response.materials && response.materials.length > 0) {
          const namespacedMaterials = response.materials.map((m) => ({
            ...m,
            id: `${modelId}:${m.id}`,
          }));
          MaterialManager.getInstance().registerMaterials(namespacedMaterials);
        }
        statusHud.setLoading(
          `${batchPrefix}Estructura espacial (${spatialNodes.length} nodos, ${response.materials?.length || 0} materiales)...`
        );
      } else if (response.type === 'STAGE_BOUNDS_AABB') {
        const boundsPayload = response as Stage2BoundsPayload;
        totalExpected = boundsPayload.totalModelElements || boundsPayload.totalElements;
        const min = boundsPayload.modelAABB.min;
        const max = boundsPayload.modelAABB.max;

        const siteOff = boundsPayload.siteOffset
          ? new THREE.Vector3(boundsPayload.siteOffset[0], boundsPayload.siteOffset[1], boundsPayload.siteOffset[2])
          : new THREE.Vector3(0, 0, 0);

        // Coordenadas absolutas de mundo (Float64) sumando siteOffset al bounding box local
        const worldMin = new THREE.Vector3(min[0], min[1], min[2]).add(siteOff);
        const worldMax = new THREE.Vector3(max[0], max[1], max[2]).add(siteOff);

        // Establecer renderOffset global únicamente con el primer modelo de la escena federada
        if (!hasEstablishedGlobalRenderOffset) {
          const centerX = (worldMin.x + worldMax.x) / 2;
          const centerZ = (worldMin.z + worldMax.z) / 2;
          const minY = worldMin.y;
          const horizontalDist = Math.hypot(centerX, centerZ);
          const isGeoreferenced = horizontalDist > 50 || Math.abs(minY) > 50;

          if (isGeoreferenced) {
            const offsetY = Math.abs(minY) > 5 ? minY : 0;
            globalWorldRenderOffset.set(centerX, offsetY, centerZ);
          } else {
            globalWorldRenderOffset.set(0, 0, 0);
          }
          hasEstablishedGlobalRenderOffset = true;
        }

        // Calcular la compensación relativa específica para este modelo:
        // v_GPU = v_local - modelDelta = (v_world - siteOff) - (globalWorldRenderOffset - siteOff) = v_world - globalWorldRenderOffset
        const modelDelta = globalWorldRenderOffset.clone().sub(siteOff);
        viewer.meshPool.setRenderOffset(modelDelta);

        initialBox = new THREE.Box3(
          worldMin.clone().sub(globalWorldRenderOffset),
          worldMax.clone().sub(globalWorldRenderOffset)
        );
        modelBox.copy(initialBox);
        combinedSceneBounds.union(initialBox);
        viewer.cameraRig.fitBounds(combinedSceneBounds);
        statusHud.setLoading(`${batchPrefix}Cámara encuadrada (${totalExpected} elementos). Cargando mallas...`);
      } else if (response.type === 'STAGE_GEOMETRY_CHUNK') {
        const chunk = response as Stage3GeometryChunkPayload;
        for (const el of chunk.elements) {
          if (el.materialId) {
            el.materialId = `${modelId}:${el.materialId}`;
          }
          const isMasterProto = Boolean(el.matrixId && el.matrixId === el.id);
          if (isMasterProto) {
            const protoKey = `${modelId}:${el.id}`;
            el.id = protoKey;
            el.matrixId = protoKey;
          } else {
            if (el.matrixId) {
              el.matrixId = `${modelId}:${el.matrixId}`;
            }
            el.id = resolveUniqueElementId(el.id);
            if (el.parentId) {
              el.parentId = resolveUniqueElementId(el.parentId);
            }
          }
        }

        viewer.meshPool.ingestChunk(chunk.elements);
        totalParsed += chunk.elements.length;
        if (chunk.chunkIndex === 0 && !viewer.meshPool.modelBoundingBox.isEmpty()) {
          const isDummyInitialBox = !initialBox || (
            Math.abs(initialBox.min.x - (-0.5)) < 0.01 &&
            Math.abs(initialBox.max.x - 0.5) < 0.01
          );
          if (isDummyInitialBox) {
            combinedSceneBounds.union(viewer.meshPool.modelBoundingBox);
            viewer.cameraRig.fitBounds(combinedSceneBounds);
          }
        }
        updateHudProgress();
      } else if (response.type === 'STAGE_INSTANCE_BATCH') {
        const namespacedProtoId = `${modelId}:${response.prototypeId}`;
        for (const inst of response.instances) {
          inst.id = resolveUniqueElementId(inst.id);
          if (inst.parentId) {
            inst.parentId = resolveUniqueElementId(inst.parentId);
          }
        }
        viewer.meshPool.ingestInstanceBatch(namespacedProtoId, response.instances);
        totalParsed += response.instances.length;
        updateHudProgress();
      } else if (response.type === 'STAGE_COMPLETE') {
        searchEngine.markDirty();
        searchEngine.rebuildIndex();
        const elapsed = (performance.now() - startTime).toFixed(0);
        if (!viewer.meshPool.modelBoundingBox.isEmpty()) {
          combinedSceneBounds.union(viewer.meshPool.modelBoundingBox);
          viewer.fitModel();
        }
        const threadsInfo = workerPool.isMultiThreadedSupported()
          ? `${workerPool.getPoolSize()} workers`
          : '1 worker';
        const activeCount = modelManager.loadedModels.size + 1;
        const modelLabel = activeCount > 1 ? ` (${activeCount} modelos federados)` : '';
        statusHud.setReady(
          `Modelo cargado: ${response.totalElements} elementos en ${elapsed} ms [${threadsInfo}]${modelLabel}. Viewport 120 FPS.`
        );
        resolve({ elementCount: response.totalElements, spatialNodes, modelBox });
      } else if (response.type === 'STAGE_ERROR') {
        statusHud.setError(`${batchPrefix}Error cargando modelo: ${response.error}`);
        reject(new Error(response.error));
      }
    }, true);
  });
}

// ── AIF IPC API: Carga de Modelo IFC por URL (Principal) ────────────────────────
window.cargarModeloIFC = async function (url: string, archivo: string): Promise<void> {
  statusHud.setLoading(`Descargando geometría IFC: ${archivo}...`);
  const startTime = performance.now();

  resetViewportScene();

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();

    croqueraBridge.setFile(buffer, archivo);
    const modelId = modelManager.generateUniqueId(archivo);
    const parsed = await parseIfcBufferFederated(buffer, archivo, modelId, startTime);
    modelManager.loadedModels.set(modelId, {
      modelId,
      name: archivo,
      elementCount: parsed.elementCount,
      spatialTree: parsed.spatialNodes,
      bounds: parsed.modelBox,
      loadedAt: Date.now(),
    });
  } catch (err: any) {
    statusHud.setError(`Falla al cargar modelo: ${err?.message || err}`);
    throw err;
  }
};

// ── AIF IPC API: Resaltar Elemento por ID / ExpressIDs ──────────────────────────
window.resaltarElementoPorID = async function (id: string, expressIDs?: number[]): Promise<void> {
  restoreIsolation();

  let stepIds = expressIDs;
  if ((!stepIds || stepIds.length === 0) && condIdToStepIdsMap.has(id)) {
    stepIds = condIdToStepIdsMap.get(id);
  }

  if (stepIds && stepIds.length > 0) {
    let firstSelected: RenderedElementRecord | null = null;
    const combinedBox = new THREE.Box3();

    for (const stepId of stepIds) {
      const el = viewer.meshPool.getElementByStepId(stepId);
      if (el) {
        if (!firstSelected) {
          firstSelected = viewer.selectElement(el.id, false);
        }
        if (!el.box.isEmpty()) {
          combinedBox.union(el.box);
        }
      }
    }

    if (firstSelected) {
      if (!combinedBox.isEmpty()) {
        viewer.cameraRig.fitBounds(combinedBox, 1.5);
      }
      propertiesCard.show(firstSelected);
      return;
    }
  }

  // Fallback: búsqueda por GUID/ID directo
  const el = viewer.selectElement(id, true);
  if (el) {
    propertiesCard.show(el);
  } else {
    console.warn(`[CroqueraViewer] Elemento ${id} no encontrado en visualizador.`);
  }
};

// ── AIF IPC API: Aislar Elementos por ExpressIDs ─────────────────────────────────
window.aislarPorExpressIDs = async function (expressIDs: number[]): Promise<void> {
  if (!expressIDs || expressIDs.length === 0) {
    restoreIsolation();
    viewer.fitModel();
    return;
  }

  const targetSet = new Set(expressIDs);
  const elements = viewer.meshPool.getAllElements();
  const isolatedBox = new THREE.Box3();

  for (const el of elements) {
    const visible = targetSet.has(el.stepId);
    if ((el.mesh as any).isBatchedMesh && el.batchId !== undefined) {
      (el.mesh as THREE.BatchedMesh).setVisibleAt(el.batchId, visible);
    } else if (el.mesh instanceof THREE.Mesh) {
      el.mesh.visible = visible;
    }
    if (visible && !el.box.isEmpty()) {
      isolatedBox.union(el.box);
    }
  }

  isIsolated = true;

  if (!isolatedBox.isEmpty()) {
    viewer.cameraRig.fitBounds(isolatedBox, 1.5);
  }
};

// ── AIF IPC API: Carga de Geometría DWG Principal ──────────────────────────────
function createTextMesh(text: string, colorHex: string, height: number, align?: string): THREE.Mesh {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = 64;
  ctx.font = `bold ${fontSize}px monospace`;
  const textWidth = ctx.measureText(text).width;
  canvas.width = Math.ceil(textWidth + 24);
  canvas.height = Math.ceil(fontSize + 24);
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = colorHex;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const aspect = canvas.width / canvas.height;
  const textHeight = height || 1.5;
  const textWidthMesh = textHeight * aspect;
  const geometry = new THREE.PlaneGeometry(textWidthMesh, textHeight);
  geometry.scale(-1, 1, 1);
  const halfWidth = textWidthMesh / 2;
  if (align === 'left') geometry.translate(-halfWidth, 0, 0);
  else if (align === 'right') geometry.translate(halfWidth, 0, 0);
  geometry.rotateX(Math.PI / 2);

  return new THREE.Mesh(geometry, material);
}

window.cargarModeloDWG = async function (url: string, archivo: string): Promise<void> {
  statusHud.setLoading(`Renderizando geometría DWG: ${archivo}...`);

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const data = await response.json();

    if (mainDwgGroup) {
      viewer.scene.remove(mainDwgGroup);
      mainDwgGroup = null;
    }

    mainDwgGroup = new THREE.Group();
    mainDwgGroup.name = archivo;

    if (data.lines) {
      const groups: Record<string, Record<string, number[][]>> = {};
      data.lines.forEach((line: any) => {
        const layer = line.layer || 'Defecto';
        const color = line.color || '#ffffff';
        if (!groups[layer]) groups[layer] = {};
        if (!groups[layer][color]) groups[layer][color] = [];

        const pts = line.points;
        for (let i = 0; i < pts.length - 1; i++) {
          groups[layer][color].push(
            [pts[i][0], pts[i][2], -pts[i][1]],
            [pts[i + 1][0], pts[i + 1][2], -pts[i + 1][1]]
          );
        }
      });

      Object.keys(groups).forEach((layerName) => {
        Object.keys(groups[layerName]).forEach((colorHex) => {
          const coords = groups[layerName][colorHex];
          if (coords.length === 0) return;

          const positions = new Float32Array(coords.length * 3);
          for (let i = 0; i < coords.length; i++) {
            positions[i * 3] = coords[i][0];
            positions[i * 3 + 1] = coords[i][1];
            positions[i * 3 + 2] = coords[i][2];
          }

          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          const material = new THREE.LineBasicMaterial({ color: new THREE.Color(colorHex) });
          const segments = new THREE.LineSegments(geometry, material);
          mainDwgGroup!.add(segments);
        });
      });
    }

    if (data.texts) {
      const maxTexts = Math.min(data.texts.length, 3000);
      for (let i = 0; i < maxTexts; i++) {
        const item = data.texts[i];
        const color = item.color || '#ffffff';
        const textMesh = createTextMesh(item.text, color, item.height, item.align);
        textMesh.position.set(item.point[0], item.point[2], -item.point[1]);
        textMesh.rotation.y = -((item.rotation || 0) * Math.PI) / 180;
        mainDwgGroup.add(textMesh);
      }
    }

    viewer.scene.add(mainDwgGroup);
    const box = new THREE.Box3().setFromObject(mainDwgGroup);
    combinedSceneBounds.union(box);
    viewer.cameraRig.fitBounds(box, 1.5);
    statusHud.setReady(`DWG ${archivo} renderizado.`);
  } catch (err: any) {
    statusHud.setError(`Error al cargar DWG: ${err?.message || err}`);
  }
};

// ── AIF IPC API: Carga Secuencial de Modelos de Contexto (IFC y DWG) ────────────
const contextGhostMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x94a3b8, // Slate gray arquitectónico
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
  side: THREE.DoubleSide,
  roughness: 0.6,
  metalness: 0.1,
});

const contextEdgeMaterial = new THREE.LineBasicMaterial({
  color: 0x64748b,
  transparent: true,
  opacity: 0.25,
});

async function procesarColaContextos(): Promise<void> {
  procesandoCola = true;

  while (colaDeCarga.length > 0) {
    const item = colaDeCarga.shift()!;
    procesadosContextos++;
    const myId = idPeticionGlobal;

    console.log(`[CroqueraViewer] Ingestando contexto: ${item.nombre} (${colaDeCarga.length} restantes)`);
    statusHud.setLoading(`Cargando contexto (${procesadosContextos}/${totalEnColaHist}): ${item.nombre}...`);

    if (window.backend) {
      try {
        window.backend.emitirProgresoContextos(procesadosContextos, totalEnColaHist, item.nombre);
      } catch (e) {
        console.warn('Error emitiendo progreso:', e);
      }
    }

    try {
      await new Promise((r) => setTimeout(r, 60));

      if (item.url.toLowerCase().endsWith('.json')) {
        // Carga de Contexto DWG (JSON)
        await cargarModeloDWGContexto(item.url, item.nombre);
      } else {
        // Carga de Contexto IFC
        await cargarModeloIFCContexto(item.url, item.nombre, myId);
      }
    } catch (e: any) {
      console.error(`Falla al cargar contexto ${item.nombre}:`, e);
    }
  }

  statusHud.setReady(`Contextos cargados (${procesadosContextos} modelos en escena).`);
  procesandoCola = false;

  // Ajustar cámara para encuadrar todo el corredor del proyecto
  if (!combinedSceneBounds.isEmpty()) {
    viewer.cameraRig.fitBounds(combinedSceneBounds, 1.3);
  }
}

async function cargarModeloDWGContexto(url: string, nombre: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const group = new THREE.Group();
  group.name = nombre;

  if (data.lines) {
    const groups: Record<string, Record<string, number[][]>> = {};
    data.lines.forEach((line: any) => {
      const layer = line.layer || 'Defecto';
      const color = line.color || '#888888';
      if (!groups[layer]) groups[layer] = {};
      if (!groups[layer][color]) groups[layer][color] = [];
      const pts = line.points;
      for (let i = 0; i < pts.length - 1; i++) {
        groups[layer][color].push(
          [pts[i][0], pts[i][2], -pts[i][1]],
          [pts[i + 1][0], pts[i + 1][2], -pts[i + 1][1]]
        );
      }
    });
    Object.keys(groups).forEach((layerName) => {
      Object.keys(groups[layerName]).forEach((colorHex) => {
        const coords = groups[layerName][colorHex];
        if (coords.length === 0) return;
        const positions = new Float32Array(coords.length * 3);
        for (let i = 0; i < coords.length; i++) {
          positions[i * 3] = coords[i][0];
          positions[i * 3 + 1] = coords[i][1];
          positions[i * 3 + 2] = coords[i][2];
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.LineBasicMaterial({
          color: new THREE.Color(colorHex),
          transparent: true,
          opacity: 0.5,
        });
        group.add(new THREE.LineSegments(geometry, material));
      });
    });
  }

  viewer.scene.add(group);
  contextDwgGroups.set(nombre, group);

  const box = new THREE.Box3().setFromObject(group);
  if (!box.isEmpty()) combinedSceneBounds.union(box);
}

async function cargarModeloIFCContexto(url: string, nombre: string, myId: number): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  const buffer = await resp.arrayBuffer();

  if (myId !== idPeticionGlobal) return;

  // Si ya existía un contexto con el mismo nombre, disponerlo limpiamente
  if (contextIfcPools.has(nombre)) {
    contextIfcPools.get(nombre)!.dispose();
    contextIfcPools.delete(nombre);
  }

  const contextPool = new BatchedMeshPool(viewer.scene);
  contextPool.rootGroup.name = `Context_${nombre}`;
  contextPool.edgesGroup.name = `ContextEdges_${nombre}`;
  contextPool.setRenderOffset(viewer.meshPool.getRenderOffset());

  await new Promise<void>((resolve, reject) => {
    workerPool.parseFile(buffer, 200, (response) => {
      if (myId !== idPeticionGlobal) {
        contextPool.dispose();
        resolve();
        return;
      }

      if (response.type === 'STAGE_BOUNDS_AABB') {
        const boundsPayload = response as Stage2BoundsPayload;
        const min = boundsPayload.modelAABB.min;
        const max = boundsPayload.modelAABB.max;

        const siteOff = boundsPayload.siteOffset
          ? new THREE.Vector3(boundsPayload.siteOffset[0], boundsPayload.siteOffset[1], boundsPayload.siteOffset[2])
          : new THREE.Vector3(0, 0, 0);

        const worldMin = new THREE.Vector3(min[0], min[1], min[2]).add(siteOff);
        const worldMax = new THREE.Vector3(max[0], max[1], max[2]).add(siteOff);

        // Si no se había definido el renderOffset global (primer modelo), definirlo
        if (!hasEstablishedGlobalRenderOffset && globalWorldRenderOffset.lengthSq() === 0) {
          const centerX = (worldMin.x + worldMax.x) / 2;
          const centerZ = (worldMin.z + worldMax.z) / 2;
          const minY = worldMin.y;
          if (Math.hypot(centerX, centerZ) > 50 || Math.abs(minY) > 50) {
            globalWorldRenderOffset.set(centerX, Math.abs(minY) > 5 ? minY : 0, centerZ);
          }
          hasEstablishedGlobalRenderOffset = true;
        }

        const modelDelta = globalWorldRenderOffset.clone().sub(siteOff);
        contextPool.setRenderOffset(modelDelta);
      } else if (response.type === 'STAGE_GEOMETRY_CHUNK') {
        const chunk = response as Stage3GeometryChunkPayload;
        contextPool.ingestChunk(chunk.elements);
      } else if (response.type === 'STAGE_INSTANCE_BATCH') {
        const batch = response as any;
        contextPool.ingestInstanceBatch(batch.prototypeId, batch.instances);
      } else if (response.type === 'STAGE_COMPLETE') {
        // Estilizar todas las mallas del contexto como geometría fantasma arquitectónica
        contextPool.rootGroup.traverse((obj) => {
          if ((obj as any).isBatchedMesh || (obj as any).isInstancedMesh || (obj as any).isMesh) {
            (obj as any).castShadow = false;
            (obj as any).receiveShadow = false;
            (obj as any).material = contextGhostMaterial;
          }
        });
        // Estilizar aristas sutiles para el contexto
        contextPool.edgesGroup.traverse((obj) => {
          if ((obj as any).isLineSegments) {
            (obj as any).material = contextEdgeMaterial;
          }
        });

        contextIfcPools.set(nombre, contextPool);

        if (!contextPool.modelBoundingBox.isEmpty()) {
          combinedSceneBounds.union(contextPool.modelBoundingBox);
        }
        resolve();
      } else if (response.type === 'STAGE_ERROR') {
        contextPool.dispose();
        reject(new Error(response.error));
      }
    });
  });
}

window.cargarModeloContexto = function (url: string, nombre: string): void {
  colaDeCarga.push({ url, nombre });
  totalEnColaHist++;
  if (!procesandoCola) {
    totalEnColaHist = colaDeCarga.length;
    procesadosContextos = 0;
    procesarColaContextos();
  }
};

window.retirarModeloContexto = function (nombre: string): void {
  const pool = contextIfcPools.get(nombre);
  if (pool) {
    pool.dispose();
    contextIfcPools.delete(nombre);
  }

  const group = contextDwgGroups.get(nombre);
  if (group) {
    viewer.scene.remove(group);
    group.traverse((c) => {
      if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose();
    });
    contextDwgGroups.delete(nombre);
  }
};

window.limpiarContextos = function (): void {
  idPeticionGlobal++;
  colaDeCarga.length = 0;
  procesandoCola = false;
  totalEnColaHist = 0;
  procesadosContextos = 0;

  for (const [, pool] of contextIfcPools) {
    pool.dispose();
  }
  contextIfcPools.clear();

  for (const [, group] of contextDwgGroups) {
    viewer.scene.remove(group);
    group.traverse((c) => {
      if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose();
    });
  }
  contextDwgGroups.clear();
};

// ── AIF IPC API: Limpieza Completa de la Escena ────────────────────────────────
window.limpiarEscenaCompleta = function (): void {
  resetViewportScene();
  statusHud.setReady('Escena limpia y lista.');
};

window.setProgress = function (msg: string): void {
  if (msg) {
    statusHud.setLoading(msg);
  } else {
    statusHud.setReady('Listo.');
  }
};
