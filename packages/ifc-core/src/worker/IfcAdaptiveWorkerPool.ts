/**
 * IfcAdaptiveWorkerPool — Adaptive concurrent Web Worker pool for parallel IFC ingestion.
 *
 * Automatically inspects runtime hardware capabilities and browser security policies:
 * 1. Multi-threaded mode: If crossOriginIsolated and SharedArrayBuffer are available,
 *    spawns N = min(4, hardwareConcurrency - 1) background workers for parallel product tessellation.
 * 2. Dedicated single-worker streaming mode: If crossOriginIsolated is not active,
 *    operates via a dedicated background worker streaming 150-product chunks with zero-copy transfers,
 *    guaranteeing universal compatibility across all browser configurations.
 */

import { IfcWorkerClient } from './IfcWorkerClient';
import type {
  IfcWorkerResponse,
  Stage2BoundsPayload,
  StageEditorPostprocessBatchPayload,
  HydratedBrepDTO,
} from '../types/IfcWorkerProtocol';

export interface AdaptivePoolOptions {
  workerFactory?: () => Worker;
  workers?: IfcWorkerClient[];
  maxWorkers?: number;
  chunkSize?: number;
  forceMultiThreaded?: boolean;
}

export class IfcAdaptiveWorkerPool {
  private readonly workers: IfcWorkerClient[] = [];
  private readonly maxWorkers: number;
  private readonly isMultiThreaded: boolean;
  private primaryClient: IfcWorkerClient;

  constructor(options: AdaptivePoolOptions = {}) {
    const isIsolated = options.forceMultiThreaded || IfcWorkerClient.isCrossOriginIsolated();
    const concurrency =
      typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4;

    this.maxWorkers = options.maxWorkers ?? Math.max(1, Math.min(4, concurrency - 1));
    this.isMultiThreaded = isIsolated && this.maxWorkers > 1;

    if (options.workers && options.workers.length > 0) {
      this.workers = [...options.workers];
    } else if (options.workerFactory) {
      const count = this.isMultiThreaded ? this.maxWorkers : 1;
      for (let i = 0; i < count; i++) {
        try {
          const w = options.workerFactory();
          this.workers.push(new IfcWorkerClient(w));
        } catch (err) {
          console.warn(`[IfcAdaptiveWorkerPool] Failed to spawn worker ${i}:`, err);
        }
      }
    }

    if (this.workers.length > 0) {
      this.primaryClient = this.workers[0];
    } else {
      this.primaryClient = new IfcWorkerClient(); // In-thread core fallback
    }
  }

  /**
   * Returns true if multi-threaded parallel execution is active.
   */
  public isMultiThreadedSupported(): boolean {
    return this.isMultiThreaded;
  }

  /**
   * Returns the count of active workers in this pool.
   */
  public getPoolSize(): number {
    return Math.max(1, this.workers.length);
  }

  /**
   * Parses an IFC file buffer through the worker pool.
   * Uses 1 Coordinator + N Tessellators on SharedArrayBuffer when multi-threading is active,
   * with automatic fallback to single-worker streaming otherwise.
   */
  public async parseFile(
    stepBuffer: ArrayBuffer | SharedArrayBuffer,
    chunkSize: number = 200,
    onMessage: (response: IfcWorkerResponse) => void,
    lightweightBounds?: boolean
  ): Promise<void> {
    const isMulti = this.isMultiThreaded && this.workers.length > 1;

    if (!isMulti) {
      return this.primaryClient.parseFile(stepBuffer as ArrayBuffer, chunkSize, onMessage, lightweightBounds);
    }

    const startTime = performance.now();

    // 1. Prepare SharedArrayBuffer
    let sharedBuffer: SharedArrayBuffer;
    if (typeof SharedArrayBuffer !== 'undefined' && stepBuffer instanceof SharedArrayBuffer) {
      sharedBuffer = stepBuffer;
    } else if (typeof SharedArrayBuffer !== 'undefined') {
      sharedBuffer = new SharedArrayBuffer(stepBuffer.byteLength);
      new Uint8Array(sharedBuffer).set(new Uint8Array(stepBuffer));
    } else {
      return this.primaryClient.parseFile(stepBuffer as ArrayBuffer, chunkSize, onMessage, lightweightBounds);
    }

    let chunkCount = 0;
    let totalProcessedElements = 0;
    let totalExpectedElements = 0;
    const forwardMessage = (resp: IfcWorkerResponse) => {
      if (resp.type === 'STAGE_BOUNDS_AABB') {
        const bounds = resp as Stage2BoundsPayload;
        totalExpectedElements = bounds.totalModelElements || bounds.totalElements || 0;
      } else if (resp.type === 'STAGE_COORDINATOR_READY') {
        if (totalExpectedElements === 0) {
          totalExpectedElements = resp.totalElements || 0;
        }
      } else if (resp.type === 'STAGE_GEOMETRY_CHUNK') {
        chunkCount++;
        totalProcessedElements += resp.elements.length;
        if (totalExpectedElements > 0) {
          if (totalProcessedElements > totalExpectedElements) {
            totalExpectedElements = totalProcessedElements;
          }
          resp.progress = Math.min(0.99, Math.max(0.01, totalProcessedElements / totalExpectedElements));
        }
      } else if (resp.type === 'STAGE_INSTANCE_BATCH') {
        chunkCount++;
        totalProcessedElements += resp.instances.length;
        if (totalExpectedElements > 0 && totalProcessedElements > totalExpectedElements) {
          totalExpectedElements = totalProcessedElements;
        }
      }
      onMessage(resp);
    };

    // 2. Step 1 & 2: Coordinator (Worker 0) scans file, extracts spatial hierarchy & bounds
    const coordinator = this.workers[0];
    const coordReady = await coordinator.initCoordinator(sharedBuffer, forwardMessage, false, lightweightBounds);

    // 3. Tessellators (Workers 1..N-1) zero-copy hydration over shared scanner state
    const tessellators = this.workers.slice(1);
    await Promise.all(tessellators.map((t) => t.initTessellator(coordReady.scannerState)));

    // All available workers participate in tessellation (Worker 0 + Workers 1..N-1)
    const allWorkers = this.workers;

    // 4. Step 3: Dynamic work-stealing queue for Stage 3 structural products
    const productStepIds = coordReady.productStepIds;
    const productBatches: number[][] = [];
    for (let i = 0; i < productStepIds.length; i += chunkSize) {
      productBatches.push(productStepIds.slice(i, i + chunkSize));
    }

    let nextBatchIdx = 0;
    let totalStructuralProcessed = 0;

    const runWorkerStructuralTask = async (worker: IfcWorkerClient) => {
      while (true) {
        const batchIdx = nextBatchIdx++;
        if (batchIdx >= productBatches.length) break;

        const batchIds = productBatches[batchIdx];
        const res = await worker.tessellateBatch(
          {
            type: 'TESSELLATE_BATCH',
            batchIndex: batchIdx,
            productStepIds: batchIds,
            chunkSize,
          },
          forwardMessage
        );
        totalStructuralProcessed += res.elementsProcessed;
      }
    };

    await Promise.all(allWorkers.map((w) => runWorkerStructuralTask(w)));

    forwardMessage({
      type: 'STAGE_PHASE_1_COMPLETE',
      structuralCount: coordReady.totalElements,
    });

    // 5. Phase 2: Dynamic work-stealing queue for Deferred Types
    // Note: Partitioning by type guarantees 100% GeometryPrototypeDetector cache hit rate without thread locks.
    const deferredTypes = coordReady.deferredTypes;
    let nextDeferredIdx = 0;
    let totalDeferredProcessed = 0;

    if (deferredTypes && deferredTypes.length > 0) {
      const runWorkerDeferredTask = async (worker: IfcWorkerClient) => {
        while (true) {
          const dIdx = nextDeferredIdx++;
          if (dIdx >= deferredTypes.length) break;

          const dType = deferredTypes[dIdx];
          const res = await worker.tessellateBatch(
            {
              type: 'TESSELLATE_BATCH',
              batchIndex: productBatches.length + dIdx,
              deferredTypes: [dType],
              chunkSize,
            },
            forwardMessage
          );
          totalDeferredProcessed += res.elementsProcessed;
        }
      };

      await Promise.all(allWorkers.map((w) => runWorkerDeferredTask(w)));
    }

    // 6. Complete
    forwardMessage({
      type: 'STAGE_COMPLETE',
      totalElements: coordReady.totalElements + totalDeferredProcessed,
      totalChunks: chunkCount,
      durationMs: performance.now() - startTime,
    });
  }

  /**
   * Resolves Property Sets on-demand for a specific STEP ID through the primary worker client in O(1).
   */
  public async resolveProperties(stepId: number): Promise<Record<string, Record<string, any>>> {
    return this.primaryClient.resolveProperties(stepId);
  }

  /**
   * Executes deep editor post-process on the Coordinator worker (Phase 6 - Bloque 3.5).
   */
  public async runEditorPostprocess(batchSize?: number): Promise<StageEditorPostprocessBatchPayload> {
    const coordinator = this.workers[0] || this.primaryClient;
    return coordinator.runEditorPostprocess(batchSize);
  }

  /**
   * Requests on-demand B-Rep PolyMesh hydration for the specified STEP IDs (JIT).
   */
  public async hydrateBrep(stepIds: number[], coalesceFaces: boolean = true): Promise<HydratedBrepDTO[]> {
    const coordinator = this.workers[0] || this.primaryClient;
    return coordinator.hydrateBrep(stepIds, coalesceFaces);
  }

  /**
   * Terminates all background workers in the pool.
   */
  public terminate(): void {
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers.length = 0;
  }
}
