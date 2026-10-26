import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { IfcImportWorkerCore } from '../src/worker/IfcImportWorkerCore';
import type { IfcWorkerResponse } from '../src/types/IfcWorkerProtocol';

describe('Worker pipeline with Paraderos_Original.ifc', () => {
  const filePath = 'C:/AI/10 CROQUERA/ModelosDePrueba/Paraderos_Original.ifc';

  it('runs worker process on Paraderos_Original.ifc and logs all emitted responses', async () => {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const core = new IfcImportWorkerCore();
    const emitted: IfcWorkerResponse[] = [];

    await core.process(
      {
        type: 'INIT_COORDINATOR',
        stepBuffer: arrayBuf as any,
      },
      (resp) => {
        emitted.push(resp);
      }
    );

    console.log('--- Worker Emitted Responses Count:', emitted.length);
    for (const r of emitted) {
      console.log(' Emitted type:', r.type);
      if (r.type === 'STAGE_SPATIAL_HIERARCHY') {
        console.log('  spatial materials:', r.materials);
      }
      if (r.type === 'STAGE_BOUNDS_AABB') {
        console.log('  bounds modelAABB:', r.modelAABB);
        console.log('  elements in bounds:', r.elements.length);
        for (const el of r.elements) {
          console.log(`   bound el: type=${el.type} stepId=${el.stepId} aabb=`, el.aabb);
        }
      }
      if (r.type === 'STAGE_COORDINATOR_READY') {
        console.log('  productStepIds:', r.productStepIds);
        console.log('  deferredTypes:', r.deferredTypes);
      }
    }

    // Now test TESSELLATE_BATCH
    const coordReady = emitted.find(r => r.type === 'STAGE_COORDINATOR_READY') as any;
    if (coordReady && coordReady.productStepIds.length > 0) {
      const tessEmitted: IfcWorkerResponse[] = [];
      await core.process(
        {
          type: 'TESSELLATE_BATCH',
          batchIndex: 0,
          productStepIds: coordReady.productStepIds,
        },
        (resp) => {
          tessEmitted.push(resp);
        }
      );
      console.log('--- Tessellate Batch Emitted Responses:', tessEmitted.length);
      for (const r of tessEmitted) {
        console.log(' Tess emitted type:', r.type);
        if (r.type === 'STAGE_GEOMETRY_CHUNK') {
          console.log('  chunk elements count:', r.elements.length);
          for (const el of r.elements) {
            console.log(`   el type=${el.type} ifcType=${el.ifcType} stepId=${el.stepId} materialId=${el.materialId}`);
          }
        }
      }
    }
  });
});
