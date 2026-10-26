/**
 * IfcWorkerProtocol — Contracts and DTOs for multi-stage asynchronous IFC ingestion.
 *
 * Enables 3-stage progressive streaming with zero-copy Transferable Objects (ArrayBuffers).
 */

import type { GeometryIR } from './GeometryIR';
import type { SharedScannerState, SharedSparsePage } from '../parser/ChunkedStreamScanner';
export type { SharedScannerState, SharedSparsePage };

export type EntityType = 'GEOMETRY_ENTITY' | 'GROUP' | 'SPATIAL_CONTAINER';

export interface IfcValueType {
  type: string;
  value: any;
}

export interface MaterialRecord {
  id: string;
  name: string;
  category?: string;
  baseColor: string;
  colorHex?: string;
  roughness?: number;
  metalness?: number;
  opacity?: number;
  transparent?: boolean;
  textureBlob?: string | null;
  textureMime?: string | null;
  textureScaleU?: number;
  textureScaleV?: number;
}

export interface GeorefData {
  crsName: string | null;
  crsDescription?: string | null;
  geodeticDatum?: string | null;
  verticalDatum?: string | null;
  mapProjection: string | null;
  mapZone?: string | null;
  mapUnit?: string | null;
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  xAxisAbscissa?: number;
  xAxisOrdinate?: number;
  scale?: number;
  trueNorthX?: number;
  trueNorthY?: number;
}

export interface IfcWorkerParseRequest {
  type: 'PARSE_IFC';
  stepContent?: string;
  stepBuffer?: ArrayBuffer;
  chunkSize?: number;
  streamingMode?: 'FULL' | 'PHASE_1_STRUCTURAL' | 'PHASE_2_INSTANCES';
  phase1EntityIds?: string[];
  forcePhases?: boolean;
}

export interface IfcWorkerResolvePsetsRequest {
  type: 'RESOLVE_PSETS';
  requestId?: string;
  stepId: number;
}

export interface IfcWorkerInitCoordinatorRequest {
  type: 'INIT_COORDINATOR';
  stepBuffer: SharedArrayBuffer | ArrayBuffer;
  forcePhases?: boolean;
}

export interface IfcWorkerInitTessellatorRequest {
  type: 'INIT_TESSELLATOR';
  scannerState: SharedScannerState;
  forcePhases?: boolean;
}

export interface IfcWorkerTessellateBatchRequest {
  type: 'TESSELLATE_BATCH';
  batchIndex: number;
  totalBatches?: number;
  productStepIds?: number[];
  deferredTypes?: string[];
  chunkSize?: number;
}

export type IfcWorkerRequest =
  | IfcWorkerParseRequest
  | IfcWorkerResolvePsetsRequest
  | IfcWorkerInitCoordinatorRequest
  | IfcWorkerInitTessellatorRequest
  | IfcWorkerTessellateBatchRequest;

export interface SpatialNodeDTO {
  id: string;
  stepId: number;
  name: string;
  ifcType: string;
  parentId: string | null;
  elevation?: number;
  transform?: number[]; // 16 floats (4x4 matrix)
  psets?: Record<string, Record<string, IfcValueType>>;
}

export interface ElementBoundsDTO {
  id: string;
  stepId: number;
  name: string;
  type?: EntityType;
  ifcType: string;
  predefinedType?: string;
  parentId: string | null;
  storeyId: string | null;
  matrixId?: string | null;
  aabb: {
    min: [number, number, number];
    max: [number, number, number];
  };
  psets?: Record<string, Record<string, IfcValueType>>;
}

export interface TessellatedElementDTO {
  id: string;
  stepId: number;
  name: string;
  type: EntityType;
  ifcType: string;
  predefinedType?: string;
  parentId: string | null;
  storeyId: string | null;
  matrixId?: string | null;
  transform?: Float32Array;
  psets?: Record<string, Record<string, IfcValueType>>;
  materialId?: string;

  // GPU Geometry Intermediate Representation (GeometryIR)
  geometry?: GeometryIR;

  // GPU Transferable buffers
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edgesBuffer?: Float32Array;

  // Opening & hierarchy metadata
  hidden?: boolean;
  isOpeningGroup?: boolean;
  isOpeningGeometry?: boolean;
  openingGroupId?: string;
  hostIds?: string[];

  // Optional loop data for editable topology
  brepData?: any;
}

export interface InstanceElementDTO {
  id: string;
  stepId?: number;
  name: string;
  ifcType: string;
  parentId: string | null;
  storeyId: string | null;
  transform: Float32Array; // 16 floats
  psets?: Record<string, Record<string, IfcValueType>>;
}

export interface InstanceBatchPayload {
  type: 'STAGE_INSTANCE_BATCH';
  prototypeId: string;
  instances: InstanceElementDTO[];
}

export interface Stage1SpatialPayload {
  type: 'STAGE_SPATIAL_HIERARCHY';
  spatialNodes: SpatialNodeDTO[];
  materials: MaterialRecord[];
  parsedLevels: { id: string; name: string; elevation: number }[];
  defaultBuildingId?: string | null;
  georef?: GeorefData | null;
}

export interface Stage2BoundsPayload {
  type: 'STAGE_BOUNDS_AABB';
  elements: ElementBoundsDTO[];
  totalElements: number;
  totalModelElements?: number;
  modelAABB: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

export interface Stage3GeometryChunkPayload {
  type: 'STAGE_GEOMETRY_CHUNK';
  chunkIndex: number;
  totalChunks: number;
  progress: number;
  elements: TessellatedElementDTO[];
}

export interface StagePhase1CompletePayload {
  type: 'STAGE_PHASE_1_COMPLETE';
  structuralCount: number;
}

export interface StageCompletePayload {
  type: 'STAGE_COMPLETE';
  totalElements: number;
  totalChunks: number;
  durationMs: number;
}

export interface StageErrorPayload {
  type: 'STAGE_ERROR';
  error: string;
  stack?: string;
}

export interface ResolvedPsetsPayload {
  type: 'STAGE_RESOLVED_PSETS';
  requestId?: string;
  stepId: number;
  psets: Record<string, Record<string, any>>;
}

export interface StageCoordinatorReadyPayload {
  type: 'STAGE_COORDINATOR_READY';
  scannerState: SharedScannerState;
  productStepIds: number[];
  deferredTypes: string[];
  totalElements: number;
}

export interface StageTessellatorReadyPayload {
  type: 'STAGE_TESSELLATOR_READY';
}

export interface StageBatchCompletePayload {
  type: 'STAGE_BATCH_COMPLETE';
  batchIndex: number;
  elementsProcessed: number;
}

export type IfcWorkerResponse =
  | Stage1SpatialPayload
  | Stage2BoundsPayload
  | Stage3GeometryChunkPayload
  | StagePhase1CompletePayload
  | InstanceBatchPayload
  | StageCompletePayload
  | StageErrorPayload
  | ResolvedPsetsPayload
  | StageCoordinatorReadyPayload
  | StageTessellatorReadyPayload
  | StageBatchCompletePayload;
