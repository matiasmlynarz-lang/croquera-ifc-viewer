/**
 * GeometryIR — Universal Intermediate Representation for tessellated and boundary geometry.
 *
 * Designed for zero-copy Transferable ArrayBuffers between Web Workers, GPU pools,
 * and topological B-Rep hydration engines.
 */

export interface GeometryIR {
  // Planar loop boundaries (consumed by Croquera for editable PolyMesh hydration)
  positions?: Float64Array;
  faceLoopOffsets?: Uint32Array;
  faceLoopCounts?: Uint32Array;
  holeCounts?: Uint32Array;
  holeLoopOffsets?: Uint32Array;
  holeLoopCounts?: Uint32Array;
  holeOwners?: (string | null)[];
  faceMaterials?: (string | null)[];
  faceOpeningIds?: (string | null)[];

  // Direct GPU Buffers (consumed immediately by Three.js BatchedMesh / InstancedMesh)
  triPositions: Float32Array;     // [x, y, z, ...] relative to model centroid
  triNormals: Float32Array;       // [nx, ny, nz, ...]
  triIndices: Uint32Array;        // [i0, i1, i2, ...]
  featureEdges?: Float32Array;    // [ax, ay, az, bx, by, bz, ...] silhouette/crease edges
}
