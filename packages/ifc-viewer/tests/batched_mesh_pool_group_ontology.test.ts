import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { BatchedMeshPool } from '../src/renderer/BatchedMeshPool';
import type { TessellatedElementDTO } from '@croquera/ifc-core';

describe('BatchedMeshPool — Ontological GROUP & GEOMETRY_ENTITY Linkage (Rule 15)', () => {
  let scene: THREE.Scene;
  let pool: BatchedMeshPool;

  beforeEach(() => {
    scene = new THREE.Scene();
    pool = new BatchedMeshPool(scene);
  });

  it('stores GROUP metadata, links GEOMETRY_ENTITY children, inherits psets and resolves via group alias', () => {
    const realProductGuid = '1y_YjuQeb1s9hV01v5xWzM';
    const childGeometryId = 'synth_child_geom_001';
    const stepId = 2858;

    const groupElement: TessellatedElementDTO = {
      id: realProductGuid,
      stepId,
      name: 'Muro básico:Genérico - 200 mm',
      type: 'GROUP',
      ifcType: 'IfcWall',
      predefinedType: 'SOLIDWALL',
      parentId: 'building_default',
      storeyId: 'storey_level_1',
      psets: {
        Pset_WallCommon: {
          Reference: { value: 'BASIC_200' },
          LoadBearing: { value: true },
        },
      },
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      edgesBuffer: new Float32Array(0),
    };

    // 1 triangle (3 vertices)
    const positions = new Float32Array([0, 0, 0, 2, 0, 0, 2, 3, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const indices = new Uint32Array([0, 1, 2]);

    const childElement: TessellatedElementDTO = {
      id: childGeometryId,
      stepId,
      name: 'Muro básico:Genérico - 200 mm',
      type: 'GEOMETRY_ENTITY',
      ifcType: 'IfcWall',
      parentId: realProductGuid,
      storeyId: 'storey_level_1',
      psets: {},
      positions,
      normals,
      indices,
      edgesBuffer: new Float32Array(0),
    };

    // Ingest the chunk containing both the GROUP and child GEOMETRY_ENTITY
    pool.ingestChunk([groupElement, childElement]);

    // 1. Group metadata should be registered in groupMap
    const groupRec = pool.getGroup(realProductGuid);
    expect(groupRec).toBeDefined();
    expect(groupRec!.id).toBe(realProductGuid);
    expect(groupRec!.name).toBe('Muro básico:Genérico - 200 mm');
    expect(groupRec!.stepId).toBe(stepId);
    expect(groupRec!.ifcType).toBe('IfcWall');
    expect(groupRec!.childrenIds).toEqual([childGeometryId]);
    expect(groupRec!.box.isEmpty()).toBe(false);

    // 2. Rendered element should be enriched with group link and inherited psets
    const renderedChild = pool.getElement(childGeometryId);
    expect(renderedChild).toBeDefined();
    expect(renderedChild!.groupId).toBe(realProductGuid);
    expect(renderedChild!.groupName).toBe('Muro básico:Genérico - 200 mm');
    expect(renderedChild!.isPrimaryChild).toBe(true);
    expect(renderedChild!.psets).toBeDefined();
    expect(renderedChild!.psets!.Pset_WallCommon.Reference.value).toBe('BASIC_200');

    // 3. getElement(realProductGuid) should resolve to the rendered child in O(1) via groupAliasMap
    const resolvedViaGuid = pool.getElement(realProductGuid);
    expect(resolvedViaGuid).toBeDefined();
    expect(resolvedViaGuid!.id).toBe(childGeometryId);
    expect(resolvedViaGuid!.groupId).toBe(realProductGuid);

    // 4. getElementByStepId should resolve to the rendered element
    const resolvedViaStepId = pool.getElementByStepId(stepId);
    expect(resolvedViaStepId).toBeDefined();
    expect(resolvedViaStepId!.id).toBe(childGeometryId);

    // 5. getGroupForElement should return the parent group record
    const parentGroup = pool.getGroupForElement(childGeometryId);
    expect(parentGroup).toBeDefined();
    expect(parentGroup!.id).toBe(realProductGuid);
  });

  it('aggregates multiple child submeshes into the unified group bounding box', () => {
    const realGuid = '2z_MultiPartProduct_001';
    const child1Id = 'child_part_1';
    const child2Id = 'child_part_2';

    const groupDTO: TessellatedElementDTO = {
      id: realGuid,
      stepId: 4001,
      name: 'Ventana Compuesta',
      type: 'GROUP',
      ifcType: 'IfcWindow',
      parentId: 'bldg_1',
      storeyId: null,
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      edgesBuffer: new Float32Array(0),
    };

    const child1DTO: TessellatedElementDTO = {
      id: child1Id,
      stepId: 4001,
      name: 'Ventana Compuesta [Marco]',
      type: 'GEOMETRY_ENTITY',
      ifcType: 'IfcWindow',
      parentId: realGuid,
      storeyId: null,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      edgesBuffer: new Float32Array(0),
    };

    const child2DTO: TessellatedElementDTO = {
      id: child2Id,
      stepId: 4001,
      name: 'Ventana Compuesta [Vidrio]',
      type: 'GEOMETRY_ENTITY',
      ifcType: 'IfcWindow',
      parentId: realGuid,
      storeyId: null,
      positions: new Float32Array([1, 0, 0, 2, 0, 0, 2, 2, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      edgesBuffer: new Float32Array(0),
    };

    pool.ingestChunk([groupDTO, child1DTO, child2DTO]);

    const group = pool.getGroup(realGuid);
    expect(group).toBeDefined();
    expect(group!.childrenIds).toEqual([child1Id, child2Id]);

    // Box should enclose both child 1 (X: 0..1, Y: 0..1) and child 2 (X: 1..2, Y: 0..2)
    expect(group!.box.min.x).toBeCloseTo(0);
    expect(group!.box.max.x).toBeCloseTo(2);
    expect(group!.box.max.y).toBeCloseTo(2);

    // Primary child is child 1
    const rec1 = pool.getElement(child1Id);
    const rec2 = pool.getElement(child2Id);
    expect(rec1!.isPrimaryChild).toBe(true);
    expect(rec2!.isPrimaryChild).toBe(false);

    // Alias points to the primary child
    expect(pool.getElement(realGuid)!.id).toBe(child1Id);
  });

  it('clears all group metadata, aliases, and child links on clear()', () => {
    const realGuid = '3w_Group_To_Clear';
    const childId = 'child_to_clear';

    pool.ingestChunk([
      {
        id: realGuid,
        stepId: 5001,
        name: 'Elemento Temporal',
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
        id: childId,
        stepId: 5001,
        name: 'Elemento Temporal',
        type: 'GEOMETRY_ENTITY',
        ifcType: 'IfcBeam',
        parentId: realGuid,
        storeyId: null,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        edgesBuffer: new Float32Array(0),
      },
    ]);

    expect(pool.getGroup(realGuid)).toBeDefined();
    expect(pool.getElement(realGuid)).toBeDefined();

    pool.clear();

    expect(pool.getGroup(realGuid)).toBeUndefined();
    expect(pool.getElement(realGuid)).toBeUndefined();
    expect(pool.getElement(childId)).toBeUndefined();
    expect(pool.getAllGroups().length).toBe(0);
    expect(pool.getAllElements().length).toBe(0);
  });
});
