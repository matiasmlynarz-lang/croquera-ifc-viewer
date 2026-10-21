/**
 * IfcImportWorkerCore — Multi-stage IFC ingestion and tessellation engine for Web Workers.
 *
 * Implements the 3-stage state machine:
 * 1. Stage 1: Lexical analysis and spatial hierarchy (IfcProject, IfcSite, IfcBuilding, IfcBuildingStorey).
 * 2. Stage 2: Product AABBs and overall model bounding box for early camera framing (< 500 ms).
 * 3. Stage 3: Tessellated mesh chunks streamed via zero-copy Transferable Objects (Float32Array, Uint32Array).
 */

import { IfcStepImporter, IFC_PRIORITY_STRUCTURAL_TYPES } from '../importer/IfcStepImporter';
import { IfcStreamingParser } from '../parser/IfcStreamingParser';
import { ChunkedStreamScanner } from '../parser/ChunkedStreamScanner';
import { GeometryPrototypeDetector } from '../detector/GeometryPrototypeDetector';
import type {
  IfcWorkerRequest,
  IfcWorkerResponse,
} from '../types/IfcWorkerProtocol';

export const LARGE_FILE_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB

export class IfcImportWorkerCore {
  /**
   * Processes the import request emitting sequential events for the 3 stages.
   */
  public async process(
    request: IfcWorkerRequest,
    onEmit: (response: IfcWorkerResponse, transferables?: Transferable[]) => void
  ): Promise<void> {
    const startTime = performance.now();

    try {
      if (!request || (!request.stepContent && !request.stepBuffer)) {
        throw new Error('STEP / IFC content is empty or unspecified.');
      }

      const fileSizeBytes = request.stepBuffer
        ? request.stepBuffer.byteLength
        : (request.stepContent?.length ?? 0);

      if (request.stepBuffer) {
        const headBytes = new Uint8Array(request.stepBuffer, 0, Math.min(request.stepBuffer.byteLength, 4096));
        const headText = new TextDecoder('utf-8').decode(headBytes);
        const isStepFormat = /ISO-10303-21/i.test(headText) || /DATA\s*;/i.test(headText);
        if (!isStepFormat) {
          throw new Error('File does not comply with the ISO-10303-21 (STEP) standard.');
        }
      } else if (request.stepContent) {
        const isStepFormat =
          /ISO-10303-21/i.test(request.stepContent) || /DATA\s*;/i.test(request.stepContent);
        if (!isStepFormat) {
          throw new Error('File does not comply with the ISO-10303-21 (STEP) standard.');
        }
      }

      let importer: IfcStepImporter;
      const isLargeFile = fileSizeBytes > LARGE_FILE_THRESHOLD_BYTES;
      const shouldUsePhases = isLargeFile || Boolean(request.forcePhases) || request.streamingMode === 'PHASE_1_STRUCTURAL';

      if (request.stepBuffer) {
        const scanner = new ChunkedStreamScanner(request.stepBuffer);
        scanner.parseHeader();
        scanner.scanDataSection();
        importer = IfcStepImporter.fromStreamingParser(scanner);
        if (shouldUsePhases) {
          importer.setProductTypesFilter(IFC_PRIORITY_STRUCTURAL_TYPES);
        } else {
          importer.setProductTypesFilter(null);
        }
      } else if (isLargeFile || request.streamingMode !== undefined) {
        try {
          const streamingParser = new IfcStreamingParser(request.stepContent!);
          streamingParser.parseHeader();
          streamingParser.scanDataSection();
          importer = IfcStepImporter.fromStreamingParser(streamingParser);
          if (shouldUsePhases) {
            importer.setProductTypesFilter(IFC_PRIORITY_STRUCTURAL_TYPES);
          } else {
            importer.setProductTypesFilter(null);
          }
        } catch (streamingErr: any) {
          if (isLargeFile) {
            throw streamingErr;
          }
          console.warn('[IfcImportWorkerCore] Fallback to classic parser:', streamingErr?.message || streamingErr);
          importer = new IfcStepImporter(request.stepContent!);
          if (shouldUsePhases) {
            importer.setProductTypesFilter(IFC_PRIORITY_STRUCTURAL_TYPES);
          } else {
            importer.setProductTypesFilter(null);
          }
        }
      } else {
        importer = new IfcStepImporter(request.stepContent!);
        if (shouldUsePhases) {
          importer.setProductTypesFilter(IFC_PRIORITY_STRUCTURAL_TYPES);
        } else {
          importer.setProductTypesFilter(null);
        }
      }

      // Stage 1: Spatial hierarchy (< 200 ms)
      const stage1 = importer.extractSpatialHierarchy();
      onEmit(stage1);

      // Stage 2: Product AABB and model bounding box (< 500 ms)
      const stage2 = importer.extractProductBounds();
      onEmit(stage2);

      // Stage 3: Tessellated geometry chunks
      const chunkSize = request.chunkSize || 150;
      let chunkCount = 0;

      importer.extractGeometryChunks(chunkSize, (chunkPayload, transferables) => {
        chunkCount++;
        onEmit(chunkPayload, transferables);
      });

      onEmit({
        type: 'STAGE_PHASE_1_COMPLETE',
        structuralCount: stage2.totalElements,
      });

      // Phase 2: Deferred instances & prototype matching
      let deferredTotal = 0;
      if (
        shouldUsePhases &&
        (request.streamingMode === 'PHASE_2_INSTANCES' ||
          request.streamingMode === 'FULL' ||
          !request.streamingMode)
      ) {
        const detector = new GeometryPrototypeDetector();
        const counts = importer.extractDeferredInstances(
          detector,
          (batchPayload) => {
            onEmit(batchPayload);
          },
          (protoChunk, transferables) => {
            chunkCount++;
            onEmit(protoChunk, transferables);
          }
        );
        deferredTotal = counts.totalPrototypes + counts.totalInstances;
      }

      onEmit({
        type: 'STAGE_COMPLETE',
        totalElements: stage2.totalElements + deferredTotal,
        totalChunks: chunkCount,
        durationMs: performance.now() - startTime,
      });
    } catch (err: any) {
      onEmit({
        type: 'STAGE_ERROR',
        error: err?.message || String(err),
        stack: err?.stack,
      });
    }
  }
}
