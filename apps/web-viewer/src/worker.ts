/**
 * worker.ts — Web Worker entrypoint for apps/web-viewer.
 *
 * Dedicated background worker thread that processes progressive IFC streaming
 * via IfcImportWorkerCore and dispatches zero-copy Transferable ArrayBuffers.
 */

/// <reference lib="webworker" />

import { IfcImportWorkerCore } from '@croquera/ifc-core';
import type { IfcWorkerRequest } from '@croquera/ifc-core';

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
