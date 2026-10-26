/**
 * IfcWorkerClient — Client manager for background Web Worker IFC ingestion.
 *
 * Implements zero-copy Transferable ArrayBuffer dispatching to dedicated Web Workers,
 * with automatic fallback to IfcImportWorkerCore in environments where Workers are restricted.
 */

import { IfcImportWorkerCore } from './IfcImportWorkerCore';
import type { SharedScannerState } from '../parser/ChunkedStreamScanner';
import type {
  IfcWorkerRequest,
  IfcWorkerResponse,
  StageCoordinatorReadyPayload,
  StageBatchCompletePayload,
  IfcWorkerTessellateBatchRequest,
} from '../types/IfcWorkerProtocol';

export class IfcWorkerClient {
  private worker: Worker | null = null;
  private fallbackCore: IfcImportWorkerCore | null = null;

  constructor(worker?: Worker) {
    if (worker) {
      this.worker = worker;
    } else {
      this.fallbackCore = new IfcImportWorkerCore();
    }
  }

  /**
   * Returns true if SharedArrayBuffer and COOP/COEP crossOriginIsolated are enabled.
   */
  public static isCrossOriginIsolated(): boolean {
    return (
      typeof window !== 'undefined' &&
      Boolean((window as any).crossOriginIsolated) &&
      typeof SharedArrayBuffer !== 'undefined'
    );
  }

  /**
   * Initializes Coordinator worker (Worker 0) on a SharedArrayBuffer.
   */
  public async initCoordinator(
    stepBuffer: SharedArrayBuffer,
    onProgress: (resp: IfcWorkerResponse) => void,
    forcePhases?: boolean
  ): Promise<StageCoordinatorReadyPayload> {
    if (this.worker) {
      const activeWorker = this.worker;
      return new Promise<StageCoordinatorReadyPayload>((resolve, reject) => {
        const handleMessage = (e: MessageEvent<IfcWorkerResponse>) => {
          const resp = e.data;
          onProgress(resp);
          if (resp.type === 'STAGE_COORDINATOR_READY') {
            activeWorker.removeEventListener('message', handleMessage);
            activeWorker.removeEventListener('error', handleError);
            resolve(resp);
          } else if (resp.type === 'STAGE_ERROR') {
            activeWorker.removeEventListener('message', handleMessage);
            activeWorker.removeEventListener('error', handleError);
            reject(new Error(resp.error));
          }
        };

        const handleError = (err: ErrorEvent) => {
          activeWorker.removeEventListener('message', handleMessage);
          activeWorker.removeEventListener('error', handleError);
          reject(err);
        };

        activeWorker.addEventListener('message', handleMessage);
        activeWorker.addEventListener('error', handleError);

        const req: IfcWorkerRequest = {
          type: 'INIT_COORDINATOR',
          stepBuffer,
          forcePhases,
        };
        activeWorker.postMessage(req);
      });
    } else if (this.fallbackCore) {
      return new Promise<StageCoordinatorReadyPayload>((resolve, reject) => {
        const req: IfcWorkerRequest = {
          type: 'INIT_COORDINATOR',
          stepBuffer,
          forcePhases,
        };
        let readyPayload: StageCoordinatorReadyPayload | null = null;
        this.fallbackCore!.process(req, (resp) => {
          onProgress(resp);
          if (resp.type === 'STAGE_COORDINATOR_READY') {
            readyPayload = resp;
          } else if (resp.type === 'STAGE_ERROR') {
            reject(new Error(resp.error));
          }
        }).then(() => {
          if (readyPayload) {
            resolve(readyPayload);
          } else {
            reject(new Error('INIT_COORDINATOR failed to produce STAGE_COORDINATOR_READY'));
          }
        }).catch(reject);
      });
    }
    throw new Error('Worker and fallbackCore are both unavailable');
  }

  /**
   * Initializes a Tessellator worker (Workers 1..N-1) with zero-copy shared scanner state.
   */
  public async initTessellator(scannerState: SharedScannerState): Promise<void> {
    if (this.worker) {
      const activeWorker = this.worker;
      return new Promise<void>((resolve, reject) => {
        const handleMessage = (e: MessageEvent<IfcWorkerResponse>) => {
          const resp = e.data;
          if (resp.type === 'STAGE_TESSELLATOR_READY') {
            activeWorker.removeEventListener('message', handleMessage);
            activeWorker.removeEventListener('error', handleError);
            resolve();
          } else if (resp.type === 'STAGE_ERROR') {
            activeWorker.removeEventListener('message', handleMessage);
            activeWorker.removeEventListener('error', handleError);
            reject(new Error(resp.error));
          }
        };

        const handleError = (err: ErrorEvent) => {
          activeWorker.removeEventListener('message', handleMessage);
          activeWorker.removeEventListener('error', handleError);
          reject(err);
        };

        activeWorker.addEventListener('message', handleMessage);
        activeWorker.addEventListener('error', handleError);

        const req: IfcWorkerRequest = {
          type: 'INIT_TESSELLATOR',
          scannerState,
        };
        activeWorker.postMessage(req);
      });
    } else if (this.fallbackCore) {
      return new Promise<void>((resolve, reject) => {
        const req: IfcWorkerRequest = {
          type: 'INIT_TESSELLATOR',
          scannerState,
        };
        let ready = false;
        this.fallbackCore!.process(req, (resp) => {
          if (resp.type === 'STAGE_TESSELLATOR_READY') {
            ready = true;
          } else if (resp.type === 'STAGE_ERROR') {
            reject(new Error(resp.error));
          }
        }).then(() => {
          if (ready) resolve();
          else reject(new Error('INIT_TESSELLATOR failed to produce STAGE_TESSELLATOR_READY'));
        }).catch(reject);
      });
    }
    throw new Error('Worker and fallbackCore are both unavailable');
  }

  /**
   * Dispatches a batch of elements or deferred types to a worker for tessellation.
   */
  public async tessellateBatch(
    req: IfcWorkerTessellateBatchRequest,
    onChunk: (resp: IfcWorkerResponse) => void
  ): Promise<StageBatchCompletePayload> {
    if (this.worker) {
      const activeWorker = this.worker;
      return new Promise<StageBatchCompletePayload>((resolve, reject) => {
        const handleMessage = (e: MessageEvent<IfcWorkerResponse>) => {
          const resp = e.data;
          onChunk(resp);
          if (resp.type === 'STAGE_BATCH_COMPLETE' && resp.batchIndex === req.batchIndex) {
            activeWorker.removeEventListener('message', handleMessage);
            activeWorker.removeEventListener('error', handleError);
            resolve(resp);
          } else if (resp.type === 'STAGE_ERROR') {
            activeWorker.removeEventListener('message', handleMessage);
            activeWorker.removeEventListener('error', handleError);
            reject(new Error(resp.error));
          }
        };

        const handleError = (err: ErrorEvent) => {
          activeWorker.removeEventListener('message', handleMessage);
          activeWorker.removeEventListener('error', handleError);
          reject(err);
        };

        activeWorker.addEventListener('message', handleMessage);
        activeWorker.addEventListener('error', handleError);

        activeWorker.postMessage(req);
      });
    } else if (this.fallbackCore) {
      return new Promise<StageBatchCompletePayload>((resolve, reject) => {
        let completePayload: StageBatchCompletePayload | null = null;
        this.fallbackCore!.process(req, (resp) => {
          onChunk(resp);
          if (resp.type === 'STAGE_BATCH_COMPLETE' && resp.batchIndex === req.batchIndex) {
            completePayload = resp;
          } else if (resp.type === 'STAGE_ERROR') {
            reject(new Error(resp.error));
          }
        }).then(() => {
          if (completePayload) resolve(completePayload);
          else reject(new Error('TESSELLATE_BATCH failed to produce STAGE_BATCH_COMPLETE'));
        }).catch(reject);
      });
    }
    throw new Error('Worker and fallbackCore are both unavailable');
  }

  /**
   * Streams and parses an IFC file buffer asynchronously on a background thread.
   */
  public async parseFile(
    stepBuffer: ArrayBuffer,
    chunkSize: number = 200,
    onMessage: (response: IfcWorkerResponse) => void
  ): Promise<void> {
    if (this.worker) {
      const activeWorker = this.worker;
      return new Promise<void>((resolve, reject) => {
        const handleMessage = (e: MessageEvent<IfcWorkerResponse>) => {
          const resp = e.data;
          onMessage(resp);
          if (resp.type === 'STAGE_COMPLETE') {
            activeWorker.removeEventListener('message', handleMessage);
            activeWorker.removeEventListener('error', handleError);
            resolve();
          } else if (resp.type === 'STAGE_ERROR') {
            activeWorker.removeEventListener('message', handleMessage);
            activeWorker.removeEventListener('error', handleError);
            reject(new Error(resp.error));
          }
        };

        const handleError = (err: ErrorEvent) => {
          activeWorker.removeEventListener('message', handleMessage);
          activeWorker.removeEventListener('error', handleError);
          reject(err);
        };

        activeWorker.addEventListener('message', handleMessage);
        activeWorker.addEventListener('error', handleError);

        const req: IfcWorkerRequest = {
          type: 'PARSE_IFC',
          stepBuffer,
          chunkSize,
        };

        // Zero-copy transfer of input stepBuffer to worker thread
        activeWorker.postMessage(req, [stepBuffer]);
      });
    } else if (this.fallbackCore) {
      const req: IfcWorkerRequest = {
        type: 'PARSE_IFC',
        stepBuffer,
        chunkSize,
      };
      await this.fallbackCore.process(req, (resp) => {
        onMessage(resp);
      });
    }
  }

  /**
   * Resolves Property Sets on-demand for a specific STEP ID from the background worker in O(1).
   */
  public async resolveProperties(stepId: number): Promise<Record<string, Record<string, any>>> {
    if (this.worker) {
      const activeWorker = this.worker;
      const reqId = `pset_${stepId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      return new Promise<Record<string, Record<string, any>>>((resolve) => {
        const timeout = setTimeout(() => {
          activeWorker.removeEventListener('message', handleMessage);
          resolve({});
        }, 5000);

        const handleMessage = (e: MessageEvent<IfcWorkerResponse>) => {
          const resp = e.data;
          if (resp.type === 'STAGE_RESOLVED_PSETS' && (resp.requestId === reqId || resp.stepId === stepId)) {
            clearTimeout(timeout);
            activeWorker.removeEventListener('message', handleMessage);
            resolve(resp.psets || {});
          }
        };

        activeWorker.addEventListener('message', handleMessage);

        const req: IfcWorkerRequest = {
          type: 'RESOLVE_PSETS',
          requestId: reqId,
          stepId,
        };
        activeWorker.postMessage(req);
      });
    } else if (this.fallbackCore) {
      return new Promise<Record<string, Record<string, any>>>((resolve) => {
        const req: IfcWorkerRequest = {
          type: 'RESOLVE_PSETS',
          stepId,
        };
        this.fallbackCore!.process(req, (resp) => {
          if (resp.type === 'STAGE_RESOLVED_PSETS') {
            resolve(resp.psets || {});
          }
        }).catch(() => resolve({}));
      });
    }
    return {};
  }

  public terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
