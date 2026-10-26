import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { IfcStepImporter } from '@croquera/ifc-core';
import { BatchedMeshPool } from '../src/renderer/BatchedMeshPool';
import { GuidSearchEngine } from '../src/search/GuidSearchEngine';

describe('IfcSpace Hidden Geometry Verification', () => {
  const ifcWithSpace = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_space.ifc','2026-10-25',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Test Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Default Site',$,$,$,$,$,$,$,$,$,$,$);
#3= IFCBUILDING('0$r_g_0000000000000003',$,'Default Building',$,$,$,$,$,$,$,$,$);
#4= IFCBUILDINGSTOREY('0$r_g_0000000000000004',$,'Storey 1',$,$,$,$,$,$,0.0);
#10= IFCCARTESIANPOINT((0.,0.,0.));
#11= IFCDIRECTION((0.,0.,1.));
#12= IFCDIRECTION((1.,0.,0.));
#13= IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14= IFCLOCALPLACEMENT($,#13);

/* 3D Box geometry representation for IfcSpace */
#20= IFCCARTESIANPOINT((0.,0.,0.));
#21= IFCCARTESIANPOINT((5.,0.,0.));
#22= IFCCARTESIANPOINT((5.,4.,0.));
#23= IFCCARTESIANPOINT((0.,4.,0.));
#24= IFCPOLYLOOP((#20,#21,#22,#23));
#25= IFCFACEOUTERBOUND(#24,.T.);
#26= IFCFACE((#25));
#27= IFCCLOSEDSHELL((#26));
#28= IFCFACETEDBREP(#27);
#29= IFCSHAPEREPRESENTATION($,'Body','Brep',(#28));
#30= IFCPRODUCTDEFINITIONSHAPE($,$,(#29));

/* IfcSpace entity */
#50= IFCSPACE('0$r_g_0000000000000050',$,'SF.02.07',$,$,#14,#30,'Coffee Hub',.ELEMENT.,.INTERNAL.,$);
#60= IFCRELAGGREGATES('0$r_g_0000000000000060',$,$,$,#4,(#50));

/* A regular physical wall to ensure the viewer renders physical geometry */
#100= IFCWALL('0WallGuid0000000000001',$,'Muro Exterior',$,$,#14,#30,$,$);
#110= IFCRELAGGREGATES('0RelAgg000000000000002',$,$,$,#4,(#100));

ENDSEC;
END-ISO-10303-21;
`;

  it('marks IfcSpace chunk elements as hidden with empty geometry buffers', () => {
    const importer = new IfcStepImporter(ifcWithSpace);
    importer.prepareImport();
    const chunks: any[] = [];
    importer.extractGeometryChunks(100, (chunk) => {
      chunks.push(...chunk.elements);
    });

    const spaceElements = chunks.filter((el) => el.ifcType === 'IfcSpace');
    expect(spaceElements.length).toBeGreaterThan(0);

    for (const space of spaceElements) {
      expect(space.hidden).toBe(true);
      expect(space.positions.length).toBe(0);
      expect(space.edgesBuffer.length).toBe(0);
      expect(space.name).toBe('SF.02.07');
    }

    const wallElements = chunks.filter((el) => el.ifcType === 'IfcWall' && el.type === 'GEOMETRY_ENTITY');
    expect(wallElements.length).toBeGreaterThan(0);
    expect(wallElements[0].hidden).toBeFalsy();
    expect(wallElements[0].positions.length).toBeGreaterThan(0);
  });

  it('excludes IfcSpace from BatchedMesh and edgesGroup while preserving metadata in groupMap', () => {
    const scene = new THREE.Scene();
    const pool = new BatchedMeshPool(scene);

    const importer = new IfcStepImporter(ifcWithSpace);
    importer.prepareImport();

    importer.extractGeometryChunks(100, (chunk) => {
      pool.ingestChunk(chunk.elements);
    });

    // 1. Scene should only contain the physical wall, never the space
    const batchedMeshes = pool.rootGroup.children.filter((c: any) => c.isBatchedMesh) as THREE.BatchedMesh[];
    expect(batchedMeshes.length).toBeGreaterThan(0);

    // Ensure no element record exists in elementMap for IfcSpace
    const spaceEl = pool.getElement('0$r_g_0000000000000050');
    expect(spaceEl).toBeUndefined();

    // 2. But IfcSpace metadata is preserved in groupMap for spatial queries and search
    const spaceGroup = pool.getGroup('0$r_g_0000000000000050');
    expect(spaceGroup).toBeDefined();
    expect(spaceGroup!.ifcType).toBe('IfcSpace');
    expect(spaceGroup!.name).toBe('SF.02.07');

    // 3. GuidSearchEngine finds the space by name, GUID, and STEP id
    const searchEngine = new GuidSearchEngine(pool);
    searchEngine.rebuildIndex();

    const searchResults = searchEngine.search('SF.02.07', 5);
    expect(searchResults.length).toBe(1);
    expect(searchResults[0].ifcType).toBe('IfcSpace');
    expect(searchResults[0].id).toBe('0$r_g_0000000000000050');

    pool.dispose();
  });

  it('guarantees IfcSpace is never instanced or rendered when processed via phased worker pipeline (large files)', async () => {
    const { IfcImportWorkerCore } = await import('@croquera/ifc-core');
    const core = new IfcImportWorkerCore();
    const encoder = new TextEncoder();
    const buffer = encoder.encode(ifcWithSpace).buffer;

    const scene = new THREE.Scene();
    const pool = new BatchedMeshPool(scene);

    let coordinatorReady: any = null;
    await core.process(
      {
        type: 'INIT_COORDINATOR',
        stepBuffer: buffer,
        forcePhases: true,
      },
      (resp) => {
        if (resp.type === 'STAGE_COORDINATOR_READY') {
          coordinatorReady = resp;
        }
      }
    );

    expect(coordinatorReady).toBeDefined();
    // IFCSPACE must be in Priority types (productStepIds), NEVER in deferredTypes
    expect(coordinatorReady.deferredTypes).not.toContain('IFCSPACE');

    const tessellatorCore = new IfcImportWorkerCore();
    await tessellatorCore.process(
      {
        type: 'INIT_TESSELLATOR',
        scannerState: coordinatorReady.scannerState,
      },
      () => {}
    );

    const emittedResponses: any[] = [];
    await tessellatorCore.process(
      {
        type: 'TESSELLATE_BATCH',
        batchIndex: 0,
        productStepIds: coordinatorReady.productStepIds,
        deferredTypes: coordinatorReady.deferredTypes,
      },
      (resp) => {
        emittedResponses.push(resp);
        if (resp.type === 'STAGE_GEOMETRY_CHUNK') {
          pool.ingestChunk(resp.elements);
        } else if (resp.type === 'STAGE_INSTANCE_BATCH') {
          pool.ingestInstanceBatch(resp.prototypeId, resp.instances);
        }
      }
    );

    // Verify no instance batch was emitted for IfcSpace
    const instanceBatches = emittedResponses.filter((r) => r.type === 'STAGE_INSTANCE_BATCH');
    for (const ib of instanceBatches) {
      for (const inst of ib.instances) {
        expect(inst.ifcType).not.toBe('IfcSpace');
      }
    }

    // Verify BatchedMeshPool does NOT contain any mesh for IfcSpace
    const spaceEl = pool.getElement('0$r_g_0000000000000050');
    expect(spaceEl).toBeUndefined();

    // Verify no InstancedMesh was created for IfcSpace
    const instancedMeshes = pool.rootGroup.children.filter((c: any) => c.isInstancedMesh);
    expect(instancedMeshes.length).toBe(0);

    // Group metadata is still accessible
    const spaceGroup = pool.getGroup('0$r_g_0000000000000050');
    expect(spaceGroup).toBeDefined();
    expect(spaceGroup!.ifcType).toBe('IfcSpace');

    pool.dispose();
  });

  it('correctly instances deferred objects (IfcFurnishingElement, IfcRailing, IfcBuildingElementProxy) with edges and stepId', () => {
    const scene = new THREE.Scene();
    const pool = new BatchedMeshPool(scene);

    const protoId = 'proto_chair_001';
    // 1. Ingest prototype template (emitted with hidden: true by extractDeferredInstances)
    const positions = new Float32Array([
      0, 0, 0,  1, 0, 0,  1, 1, 0,
      0, 0, 0,  1, 1, 0,  0, 1, 0
    ]);
    const normals = new Float32Array([
      0, 0, 1,  0, 0, 1,  0, 0, 1,
      0, 0, 1,  0, 0, 1,  0, 0, 1
    ]);
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const edgesBuffer = new Float32Array([
      0, 0, 0,  1, 0, 0,
      1, 0, 0,  1, 1, 0,
      1, 1, 0,  0, 1, 0,
      0, 1, 0,  0, 0, 0
    ]);

    pool.ingestChunk([
      {
        id: protoId,
        stepId: 8576,
        name: '[Prototype] Office Stool',
        type: 'GEOMETRY_ENTITY',
        ifcType: 'IfcFurnishingElement',
        parentId: 'building_1',
        storeyId: 'storey_1',
        matrixId: protoId,
        hidden: true,
        positions,
        normals,
        indices,
        edgesBuffer,
      } as any,
    ]);

    // 2. Ingest instance batch
    const m1 = new THREE.Matrix4().makeTranslation(10, 0, 5);
    const m2 = new THREE.Matrix4().makeTranslation(20, 0, 5);
    pool.ingestInstanceBatch(protoId, [
      {
        id: 'inst_chair_1',
        stepId: 8576,
        name: 'Office Stool 1',
        ifcType: 'IfcFurnishingElement',
        parentId: 'building_1',
        storeyId: 'storey_1',
        transform: new Float32Array(m1.elements),
      },
      {
        id: 'inst_chair_2',
        stepId: 8577,
        name: 'Office Stool 2',
        ifcType: 'IfcFurnishingElement',
        parentId: 'building_1',
        storeyId: 'storey_1',
        transform: new Float32Array(m2.elements),
      },
    ]);

    // 3. Verify InstancedMesh exists in rootGroup
    const instancedMeshes = pool.rootGroup.children.filter((c: any) => c.isInstancedMesh) as THREE.InstancedMesh[];
    expect(instancedMeshes.length).toBe(1);
    expect(instancedMeshes[0].count).toBe(2);

    // 4. Verify edge lines exist in edgesGroup
    const edgeLines = pool.edgesGroup.children.filter((c: any) => c.isLineSegments);
    expect(edgeLines.length).toBe(1);

    // 5. Verify elements are indexed in elementMap and stepIdMap
    const el1 = pool.getElement('inst_chair_1');
    expect(el1).toBeDefined();
    expect(el1!.stepId).toBe(8576);
    expect(el1!.ifcType).toBe('IfcFurnishingElement');
    expect(pool.getElementByStepId(8576)?.id).toBe('inst_chair_1');
    expect(pool.getElementByStepId(8577)?.id).toBe('inst_chair_2');

    pool.dispose();
  });
});

