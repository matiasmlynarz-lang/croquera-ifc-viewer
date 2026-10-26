import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { BatchedMeshPool } from '../src/renderer/BatchedMeshPool';
import { GuidSearchEngine } from '../src/search/GuidSearchEngine';
import type { TessellatedElementDTO } from '@croquera/ifc-core';

describe('GuidSearchEngine — Ontological GROUP Search & Deduplication', () => {
  let scene: THREE.Scene;
  let pool: BatchedMeshPool;
  let searchEngine: GuidSearchEngine;

  beforeEach(() => {
    scene = new THREE.Scene();
    pool = new BatchedMeshPool(scene);
    searchEngine = new GuidSearchEngine(pool);
  });

  it('resolves real IFC GUID in O(1) returning canonical product name', () => {
    const realGuid = '000G000560008r00000HSG';
    const childId = 'child_submesh_99';
    const stepId = 7330;

    const groupDTO: TessellatedElementDTO = {
      id: realGuid,
      stepId,
      name: 'TPG-Poste Tipo 1',
      type: 'GROUP',
      ifcType: 'IfcColumn',
      predefinedType: 'COLUMN',
      parentId: 'building_1',
      storeyId: 'storey_1',
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      edgesBuffer: new Float32Array(0),
    };

    const childDTO: TessellatedElementDTO = {
      id: childId,
      stepId,
      name: 'TPG-Poste Tipo 1',
      type: 'GEOMETRY_ENTITY',
      ifcType: 'IfcColumn',
      parentId: realGuid,
      storeyId: 'storey_1',
      positions: new Float32Array([0, 0, 0, 0.5, 0, 0, 0.5, 3, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      edgesBuffer: new Float32Array(0),
    };

    pool.ingestChunk([groupDTO, childDTO]);

    // Search by exact 22-character IFC GUID
    const results = searchEngine.search(realGuid);
    expect(results.length).toBe(1);

    const match = results[0];
    expect(match.id).toBe(realGuid);
    expect(match.ifcGuid).toBe(realGuid);
    expect(match.name).toBe('TPG-Poste Tipo 1');
    expect(match.ifcType).toBe('IfcColumn');
    expect(match.stepId).toBe(stepId);
    expect(match.record).toBeDefined();
    expect(match.record.groupId).toBe(realGuid);
  });

  it('resolves STEP ID searches with # and without #', () => {
    const realGuid = '1y_YjuQeb1s9hV01v5xWzM';
    const childId = 'child_wall_01';
    const stepId = 2858;

    pool.ingestChunk([
      {
        id: realGuid,
        stepId,
        name: 'Muro básico:Genérico - 200 mm',
        type: 'GROUP',
        ifcType: 'IfcWall',
        parentId: null,
        storeyId: null,
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        indices: new Uint32Array(0),
        edgesBuffer: new Float32Array(0),
      },
      {
        id: childId,
        stepId,
        name: 'Muro básico:Genérico - 200 mm',
        type: 'GEOMETRY_ENTITY',
        ifcType: 'IfcWall',
        parentId: realGuid,
        storeyId: null,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        edgesBuffer: new Float32Array(0),
      },
    ]);

    // Search with "#2858"
    const resultsHash = searchEngine.search('#2858');
    expect(resultsHash.length).toBe(1);
    expect(resultsHash[0].stepId).toBe(2858);
    expect(resultsHash[0].name).toBe('Muro básico:Genérico - 200 mm');

    // Search with "2858"
    const resultsNumeric = searchEngine.search('2858');
    expect(resultsNumeric.length).toBe(1);
    expect(resultsNumeric[0].stepId).toBe(2858);
  });

  it('deduplicates multi-material submeshes under the same product in prefix and text search', () => {
    const wallGuid = '3z_CompositeWall_001';

    pool.ingestChunk([
      {
        id: wallGuid,
        stepId: 3001,
        name: 'Muro multicapa ladrillo',
        type: 'GROUP',
        ifcType: 'IfcWall',
        parentId: null,
        storeyId: null,
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        indices: new Uint32Array(0),
        edgesBuffer: new Float32Array(0),
      },
      {
        id: 'wall_layer_plaster',
        stepId: 3001,
        name: 'Muro multicapa ladrillo [Enlucido]',
        type: 'GEOMETRY_ENTITY',
        ifcType: 'IfcWall',
        parentId: wallGuid,
        storeyId: null,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        edgesBuffer: new Float32Array(0),
      },
      {
        id: 'wall_layer_brick',
        stepId: 3001,
        name: 'Muro multicapa ladrillo [Ladrillo]',
        type: 'GEOMETRY_ENTITY',
        ifcType: 'IfcWall',
        parentId: wallGuid,
        storeyId: null,
        positions: new Float32Array([1, 0, 0, 2, 0, 0, 2, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        edgesBuffer: new Float32Array(0),
      },
    ]);

    // Prefix search for "muro"
    const prefixMatches = searchEngine.search('muro');
    // Must return exactly 1 result for the product, not 3 separate duplicate entries
    expect(prefixMatches.length).toBe(1);
    expect(prefixMatches[0].id).toBe(wallGuid);
    expect(prefixMatches[0].name).toBe('Muro multicapa ladrillo');

    // Substring fallback search for "ladrillo"
    const subMatches = searchEngine.search('ladrillo');
    expect(subMatches.length).toBe(1);
    expect(subMatches[0].id).toBe(wallGuid);
  });

  it('automatically detects when new chunks are added without requiring manual rebuildIndex()', () => {
    // Initial state with 1 element
    pool.ingestChunk([
      {
        id: 'guid_item_1',
        stepId: 101,
        name: 'Primer Elemento',
        type: 'GROUP',
        ifcType: 'IfcBeam',
        parentId: null,
        storeyId: null,
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        indices: new Uint32Array(0),
        edgesBuffer: new Float32Array(0),
      },
      {
        id: 'child_item_1',
        stepId: 101,
        name: 'Primer Elemento',
        type: 'GEOMETRY_ENTITY',
        ifcType: 'IfcBeam',
        parentId: 'guid_item_1',
        storeyId: null,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        edgesBuffer: new Float32Array(0),
      },
    ]);

    expect(searchEngine.search('Primer').length).toBe(1);
    expect(searchEngine.search('Segundo').length).toBe(0);

    // Ingest a second chunk subsequently
    pool.ingestChunk([
      {
        id: 'guid_item_2',
        stepId: 102,
        name: 'Segundo Elemento',
        type: 'GROUP',
        ifcType: 'IfcColumn',
        parentId: null,
        storeyId: null,
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        indices: new Uint32Array(0),
        edgesBuffer: new Float32Array(0),
      },
      {
        id: 'child_item_2',
        stepId: 102,
        name: 'Segundo Elemento',
        type: 'GEOMETRY_ENTITY',
        ifcType: 'IfcColumn',
        parentId: 'guid_item_2',
        storeyId: null,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        edgesBuffer: new Float32Array(0),
      },
    ]);

    // search() must automatically detect new elements and find "Segundo Elemento"
    const results = searchEngine.search('Segundo');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Segundo Elemento');
    expect(results[0].id).toBe('guid_item_2');
  });
});
