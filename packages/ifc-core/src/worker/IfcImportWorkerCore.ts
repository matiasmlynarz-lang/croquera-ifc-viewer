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
import { safeDecodeUtf8 } from '../lexer/IfcStepByteLexer';
import { GeometryPrototypeDetector } from '../detector/GeometryPrototypeDetector';
import type {
  IfcWorkerRequest,
  IfcWorkerResponse,
} from '../types/IfcWorkerProtocol';

export const LARGE_FILE_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5 MB (aligned with Croquera THRESHOLD_SIZE_TIER_1_BYTES)

export class IfcImportWorkerCore {
  private currentImporter: IfcStepImporter | null = null;

  /**
   * Processes the import request emitting sequential events for the 3 stages or resolving lazy Psets.
   */
  public async process(
    request: IfcWorkerRequest,
    onEmit: (response: IfcWorkerResponse, transferables?: Transferable[]) => void
  ): Promise<void> {
    if (request.type === 'RESOLVE_PSETS') {
      try {
        if (!this.currentImporter) {
          onEmit({
            type: 'STAGE_RESOLVED_PSETS',
            requestId: request.requestId,
            stepId: request.stepId,
            psets: {},
          });
          return;
        }
        const psets = this.currentImporter.resolveElementProperties(request.stepId);
        onEmit({
          type: 'STAGE_RESOLVED_PSETS',
          requestId: request.requestId,
          stepId: request.stepId,
          psets,
        });
      } catch (err: any) {
        onEmit({
          type: 'STAGE_RESOLVED_PSETS',
          requestId: request.requestId,
          stepId: request.stepId,
          psets: {},
        });
      }
      return;
    }

    if (request.type === 'INIT_COORDINATOR') {
      try {
        const scanner = new ChunkedStreamScanner(request.stepBuffer);
        scanner.parseHeader();
        scanner.scanDataSection();

        const importer = IfcStepImporter.fromStreamingParser(scanner);
        this.currentImporter = importer;

        const isLargeFile = request.stepBuffer.byteLength > LARGE_FILE_THRESHOLD_BYTES;
        const shouldUsePhases = isLargeFile || Boolean(request.forcePhases);

        if (shouldUsePhases) {
          importer.setProductTypesFilter(IFC_PRIORITY_STRUCTURAL_TYPES);
        } else {
          importer.setProductTypesFilter(null);
        }

        const stage1 = importer.extractSpatialHierarchy();
        onEmit(stage1);

        const stage2 = importer.extractProductBounds();
        const productStepIds = importer.getProductStepIds();

        const activeDeferredTypes: string[] = [];
        let totalDeferredElements = 0;
        if (shouldUsePhases) {
          for (const dType of IfcStepImporter.DEFERRED_PRODUCT_TYPES) {
            const count = scanner.getRecordsByType(dType).length;
            if (count > 0) {
              activeDeferredTypes.push(dType);
              totalDeferredElements += count;
            }
          }
        }

        stage2.totalModelElements = stage2.totalElements + totalDeferredElements;
        onEmit(stage2);

        const sharedState = scanner.exportSharedState();

        onEmit({
          type: 'STAGE_COORDINATOR_READY',
          scannerState: sharedState,
          productStepIds,
          deferredTypes: activeDeferredTypes,
          totalElements: stage2.totalElements,
        });
      } catch (err: any) {
        onEmit({
          type: 'STAGE_ERROR',
          error: err?.message || String(err),
          stack: err?.stack,
        });
      }
      return;
    }

    if (request.type === 'INIT_TESSELLATOR') {
      try {
        const scanner = ChunkedStreamScanner.fromSharedState(request.scannerState);
        const importer = IfcStepImporter.fromStreamingParser(scanner);
        this.currentImporter = importer;
        importer.prepareImport();

        onEmit({
          type: 'STAGE_TESSELLATOR_READY',
        });
      } catch (err: any) {
        onEmit({
          type: 'STAGE_ERROR',
          error: err?.message || String(err),
          stack: err?.stack,
        });
      }
      return;
    }

    if (request.type === 'TESSELLATE_BATCH') {
      try {
        if (!this.currentImporter) {
          throw new Error('Tessellator worker was not initialized with INIT_TESSELLATOR or INIT_COORDINATOR.');
        }

        const importer = this.currentImporter;
        let elementsProcessed = 0;

        if (request.productStepIds && request.productStepIds.length > 0) {
          const chunkSize = request.chunkSize || 150;
          importer.extractGeometryChunks(
            chunkSize,
            (chunkPayload, transferables) => {
              onEmit(chunkPayload, transferables);
            },
            request.productStepIds
          );
          elementsProcessed += request.productStepIds.length;
        }

        if (request.deferredTypes && request.deferredTypes.length > 0) {
          const detector = new GeometryPrototypeDetector();
          const counts = importer.extractDeferredInstances(
            detector,
            (batchPayload) => {
              onEmit(batchPayload);
            },
            (protoChunk, transferables) => {
              onEmit(protoChunk, transferables);
            },
            request.deferredTypes
          );
          elementsProcessed += counts.totalPrototypes + counts.totalInstances;
        }

        onEmit({
          type: 'STAGE_BATCH_COMPLETE',
          batchIndex: request.batchIndex,
          elementsProcessed,
        });
      } catch (err: any) {
        onEmit({
          type: 'STAGE_ERROR',
          error: err?.message || String(err),
          stack: err?.stack,
        });
      }
      return;
    }

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
        const headText = safeDecodeUtf8(headBytes);
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

      this.currentImporter = importer;

      // Stage 1: Spatial hierarchy (< 200 ms)
      const stage1 = importer.extractSpatialHierarchy();
      onEmit(stage1);

      // Stage 2: Product AABB and model bounding box (< 500 ms)
      const stage2 = importer.extractProductBounds();
      let totalDeferredElements = 0;
      if (shouldUsePhases) {
        const parser = importer.getParser() as any;
        if (typeof parser.getRecordsByType === 'function') {
          for (const dType of IfcStepImporter.DEFERRED_PRODUCT_TYPES) {
            const count = parser.getRecordsByType(dType)?.length || 0;
            totalDeferredElements += count;
          }
        }
      }
      stage2.totalModelElements = stage2.totalElements + totalDeferredElements;
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
