/**
 * IfcImportWorker — Web Worker for asynchronous background IFC ingestion.
 *
 * Listens to parsing requests on a dedicated background thread and dispatches
 * the 3 progressive stage events using zero-copy Transferable Objects.
 */

/// <reference lib="webworker" />

import { IfcImportWorkerCore } from './IfcImportWorkerCore';
import type { IfcWorkerRequest } from '../types/IfcWorkerProtocol';

const core = new IfcImportWorkerCore();

self.onmessage = async (e: MessageEvent<IfcWorkerRequest>) => {
  await core.process(e.data, (response, transferables) => {
    if (transferables && transferables.length > 0) {
      (self as any).postMessage(response, transferables);
    } else {
      (self as any).postMessage(response);
    }
  });
};
