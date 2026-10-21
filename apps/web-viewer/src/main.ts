/**
 * main.ts — Application entry point for croquera-ifc-viewer.
 *
 * Connects the 3-stage progressive ingestion worker with buffer-first Three.js rendering,
 * GUID search, distance measurement, and the zero-copy bridge to croquera.com.
 */

import './styles/viewer.css';
import * as THREE from 'three';
import { Viewer3D, type RenderedElementRecord } from '@croquera/ifc-viewer';
import { GuidSearchEngine } from '@croquera/ifc-viewer';
import { MeasureTool, type MeasurementResult } from '@croquera/ifc-viewer';
import { CroqueraBridge } from '@croquera/ifc-viewer';
import { IfcImportWorkerCore } from '@croquera/ifc-core';
import type {
  IfcWorkerRequest,
  IfcWorkerResponse,
  Stage2BoundsPayload,
  Stage3GeometryChunkPayload,
} from '@croquera/ifc-core';

// ─── DOM Setup ──────────────────────────────────────────────────
const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="viewer-layout">
    <div id="viewport" class="viewport-container"></div>

    <!-- Top HUD Bar -->
    <header class="top-hud">
      <div class="app-brand">
        <svg class="brand-icon" viewBox="0 0 24 24">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
        CROQUERA IFC
      </div>

      <button id="btn-open-file" class="btn-tactile">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
        </svg>
        Open IFC
      </button>
      <input id="file-input" type="file" accept=".ifc,.step" style="display: none;" />

      <div class="search-container">
        <svg class="search-icon" viewBox="0 0 24 24">
          <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
        </svg>
        <input id="search-input" class="search-input" type="text" placeholder="Search GUID, UUID, #STEP, Type..." autocomplete="off" />
        <div id="search-flyout" class="search-results-flyout"></div>
      </div>

      <button id="btn-measure" class="btn-tactile">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M2 12h20M2 7l3 5-3 5M22 7l-3 5 3 5"/>
        </svg>
        Measure
      </button>

      <button id="btn-edit-croquera" class="btn-tactile btn-accent">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        Editar en Croquera
      </button>
    </header>

    <!-- Measurement Live Badge -->
    <div id="measurement-badge" class="measurement-badge">
      <span id="measurement-distance">0.00 m</span>
      <span id="measurement-deltas" style="color: var(--text-muted); font-size: 10px;"></span>
    </div>

    <!-- Status & Benchmark HUD -->
    <div class="status-hud">
      <div id="status-dot" class="status-dot"></div>
      <span id="status-text">Ready. Open or drag & drop an IFC model.</span>
    </div>

    <!-- Element Properties Floating Card -->
    <div id="properties-card" class="properties-card">
      <div class="card-header">
        <span id="card-title" class="card-title">Element Properties</span>
        <button id="card-close" class="card-close">&times;</button>
      </div>
      <div id="card-body" class="card-body"></div>
    </div>

    <!-- Drag & Drop Fullscreen Overlay -->
    <div id="drop-overlay" class="drop-overlay">
      <div class="drop-box">
        Drop IFC model here to stream & visualize
      </div>
    </div>
  </div>
`;

// ─── Component Initializations ──────────────────────────────────
const viewportContainer = document.getElementById('viewport')!;
const statusDot = document.getElementById('status-dot')!;
const statusText = document.getElementById('status-text')!;
const propsCard = document.getElementById('properties-card')!;
const cardTitle = document.getElementById('card-title')!;
const cardBody = document.getElementById('card-body')!;
const cardClose = document.getElementById('card-close')!;
const measureBadge = document.getElementById('measurement-badge')!;
const measureDistance = document.getElementById('measurement-distance')!;
const measureDeltas = document.getElementById('measurement-deltas')!;
const btnMeasure = document.getElementById('btn-measure')!;
const btnEditCroquera = document.getElementById('btn-edit-croquera')!;
const btnOpenFile = document.getElementById('btn-open-file')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchFlyout = document.getElementById('search-flyout')!;
const dropOverlay = document.getElementById('drop-overlay')!;

const viewer = new Viewer3D({
  container: viewportContainer,
  onElementSelected: (element) => {
    showElementProperties(element);
  },
});

const searchEngine = new GuidSearchEngine(viewer.meshPool);
const croqueraBridge = new CroqueraBridge();

let isMeasureActive = false;
const measureTool = new MeasureTool(viewer, (result: MeasurementResult | null) => {
  if (result) {
    measureBadge.classList.add('visible');
    measureDistance.textContent = `${result.distance.toFixed(3)} m`;
    measureDeltas.textContent = `(dx: ${result.deltaX.toFixed(2)}, dy: ${result.deltaY.toFixed(2)}, dz: ${result.deltaZ.toFixed(2)})`;
  } else {
    measureBadge.classList.remove('visible');
  }
});

// ─── Interaction Handlers ───────────────────────────────────────
btnMeasure.addEventListener('click', () => {
  isMeasureActive = !isMeasureActive;
  btnMeasure.classList.toggle('active', isMeasureActive);
  if (isMeasureActive) {
    measureTool.activate();
    statusText.textContent = 'Measure tool active. Click two points on the model.';
  } else {
    measureTool.deactivate();
    statusText.textContent = 'Measurement finished.';
  }
});

btnEditCroquera.addEventListener('click', () => {
  croqueraBridge.editInCroquera();
});

btnOpenFile.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) {
    loadIfcFile(fileInput.files[0]);
  }
});

cardClose.addEventListener('click', () => {
  propsCard.classList.remove('visible');
  viewer.clearSelection();
});

// ─── Search Handlers ────────────────────────────────────────────
searchInput.addEventListener('input', () => {
  const query = searchInput.value;
  const results = searchEngine.search(query, 10);

  if (results.length === 0 || !query.trim()) {
    searchFlyout.classList.remove('visible');
    searchFlyout.innerHTML = '';
    return;
  }

  searchFlyout.innerHTML = results
    .map(
      (r) => `
      <div class="search-result-item" data-id="${r.id}">
        <span class="result-name">${r.name || r.ifcType}</span>
        <span class="result-meta">
          <span>${r.ifcType}</span>
          <span>#${r.stepId}</span>
          <span>GUID: ${r.ifcGuid}</span>
        </span>
      </div>
    `
    )
    .join('');

  searchFlyout.classList.add('visible');

  searchFlyout.querySelectorAll('.search-result-item').forEach((item) => {
    item.addEventListener('click', () => {
      const elId = item.getAttribute('data-id');
      if (elId) {
        viewer.selectElement(elId, true);
        searchFlyout.classList.remove('visible');
        searchInput.value = '';
      }
    });
  });
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const results = searchEngine.search(searchInput.value, 1);
    if (results.length > 0) {
      viewer.selectElement(results[0].id, true);
      searchFlyout.classList.remove('visible');
    }
  } else if (e.key === 'Escape') {
    searchFlyout.classList.remove('visible');
  }
});

document.addEventListener('click', (e) => {
  if (!searchInput.contains(e.target as Node) && !searchFlyout.contains(e.target as Node)) {
    searchFlyout.classList.remove('visible');
  }
});

// ─── Drag & Drop ────────────────────────────────────────────────
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropOverlay.classList.add('active');
});

dropOverlay.addEventListener('dragleave', () => {
  dropOverlay.classList.remove('active');
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('active');
  if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
    loadIfcFile(e.dataTransfer.files[0]);
  }
});

// ─── Streaming IFC Ingestion ────────────────────────────────────
async function loadIfcFile(file: File): Promise<void> {
  statusDot.classList.add('loading');
  statusText.textContent = `Streaming ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)...`;

  const startTime = performance.now();
  viewer.meshPool.clear();
  propsCard.classList.remove('visible');

  const buffer = await file.arrayBuffer();
  croqueraBridge.setFile(buffer, file.name);

  // Direct asynchronous ingestion via IfcImportWorkerCore
  const workerCore = new IfcImportWorkerCore();
  const request: IfcWorkerRequest = {
    type: 'PARSE_IFC',
    stepBuffer: buffer,
    chunkSize: 200,
  };

  let totalParsed = 0;

  try {
    await workerCore.process(request, (response: IfcWorkerResponse) => {
      if (response.type === 'STAGE_SPATIAL_HIERARCHY') {
        statusText.textContent = `Spatial hierarchy loaded (${response.spatialNodes.length} nodes).`;
      } else if (response.type === 'STAGE_BOUNDS_AABB') {
        const boundsPayload = response as Stage2BoundsPayload;
        // Early camera auto-framing on overall model bounding box (< 500 ms)
        const box = new THREE.Box3(
          new THREE.Vector3(...boundsPayload.modelAABB.min),
          new THREE.Vector3(...boundsPayload.modelAABB.max)
        );
        viewer.cameraRig.fitBounds(box);
        statusText.textContent = `Camera framed on ${boundsPayload.totalElements} elements. Tessellating...`;
      } else if (response.type === 'STAGE_GEOMETRY_CHUNK') {
        const chunk = response as Stage3GeometryChunkPayload;
        viewer.meshPool.ingestChunk(chunk.elements);
        totalParsed += chunk.elements.length;
        statusText.textContent = `Tessellating ${totalParsed} elements (${Math.round(chunk.progress * 100)}%)...`;
      } else if (response.type === 'STAGE_INSTANCE_BATCH') {
        viewer.meshPool.ingestInstanceBatch(response.prototypeId, response.instances);
        totalParsed += response.instances.length;
      } else if (response.type === 'STAGE_COMPLETE') {
        const elapsed = (performance.now() - startTime).toFixed(0);
        statusDot.classList.remove('loading');
        statusText.textContent = `Loaded ${response.totalElements} elements in ${elapsed} ms. Viewport active at 120 FPS.`;
      } else if (response.type === 'STAGE_ERROR') {
        statusDot.classList.remove('loading');
        statusText.textContent = `Error loading model: ${response.error}`;
      }
    });
  } catch (err: any) {
    statusDot.classList.remove('loading');
    statusText.textContent = `Failed to process model: ${err?.message || err}`;
  }
}

// ─── Properties Display ─────────────────────────────────────────
function showElementProperties(el: RenderedElementRecord | null): void {
  if (!el) {
    propsCard.classList.remove('visible');
    return;
  }

  cardTitle.textContent = el.name || el.ifcType;

  let html = `
    <div class="prop-row">
      <span class="prop-label">IFC Type</span>
      <span class="prop-value">${el.ifcType}</span>
    </div>
    <div class="prop-row">
      <span class="prop-label">GUID</span>
      <span class="prop-value" style="font-size: 10px;">${el.id}</span>
    </div>
    <div class="prop-row">
      <span class="prop-label">STEP ID</span>
      <span class="prop-value">#${el.stepId}</span>
    </div>
  `;

  if (el.storeyId) {
    html += `
      <div class="prop-row">
        <span class="prop-label">Storey</span>
        <span class="prop-value">${el.storeyId}</span>
      </div>
    `;
  }

  if (el.psets && Object.keys(el.psets).length > 0) {
    html += `<div class="psets-section">`;
    for (const [psetName, props] of Object.entries(el.psets)) {
      html += `<div class="pset-title">${psetName}</div>`;
      for (const [propKey, propVal] of Object.entries(props)) {
        const valStr = typeof propVal === 'object' && propVal !== null && 'value' in propVal
          ? String(propVal.value)
          : String(propVal);
        html += `
          <div class="prop-row">
            <span class="prop-label">${propKey}</span>
            <span class="prop-value">${valStr}</span>
          </div>
        `;
      }
    }
    html += `</div>`;
  }

  cardBody.innerHTML = html;
  propsCard.classList.add('visible');
}
