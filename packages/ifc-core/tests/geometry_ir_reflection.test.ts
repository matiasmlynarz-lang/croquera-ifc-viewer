import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PolyMesh } from '../src/topology/PolyMesh';
import { Vec3 } from '../src/math/Vec3';
import { IfcImportWorkerCore } from '../src/worker/IfcImportWorkerCore';
import type { IfcWorkerResponse, StageEditorPostprocessBatchPayload, StageHydrateBrepPayload } from '../src/types/IfcWorkerProtocol';

describe('GeometryIR Reflection and Editor PostProcess (Phase 6 - Bloque 3)', () => {
  it('serializes and deserializes PolyMesh with holes, owners and materials with zero loss of topological fidelity (Norma 17)', () => {
    const mesh = new PolyMesh('wall_reflection_test');

    // Face 1: Vertical rectangular wall (4m x 3m) with a window cutout
    const outerLoop1 = [
      new Vec3(0, 0, 0),
      new Vec3(4, 0, 0),
      new Vec3(4, 3, 0),
      new Vec3(0, 3, 0),
    ];
    const windowHole = [
      new Vec3(1, 1, 0),
      new Vec3(2.5, 1, 0),
      new Vec3(2.5, 2.2, 0),
      new Vec3(1, 2.2, 0),
    ];

    const face1 = mesh.addFace(outerLoop1, new Vec3(0, 0, 1), [windowHole], ['opening_window_777']);
    face1.materialId = 'mat_brick_red';
    face1.openingId = 'opening_host_wall';

    // Face 2: Floor slab face with material
    const outerLoop2 = [
      new Vec3(0, 0, 0),
      new Vec3(4, 0, 0),
      new Vec3(4, 0, 2),
      new Vec3(0, 0, 2),
    ];
    const face2 = mesh.addFace(outerLoop2, new Vec3(0, -1, 0));
    face2.materialId = 'mat_concrete_grey';

    // Export to GeometryIR
    const ir = mesh.toGeometryIR();

    expect(ir.positions).toBeDefined();
    expect(ir.faceLoopCounts).toBeDefined();
    expect(ir.faceLoopCounts!.length).toBe(2);
    expect(ir.faceLoopCounts![0]).toBe(4);
    expect(ir.faceLoopCounts![1]).toBe(4);

    expect(ir.holeCounts).toBeDefined();
    expect(ir.holeCounts![0]).toBe(1);
    expect(ir.holeCounts![1]).toBe(0);

    expect(ir.holeOwners).toBeDefined();
    expect(ir.holeOwners![0]).toBe('opening_window_777');

    expect(ir.faceMaterials).toBeDefined();
    expect(ir.faceMaterials![0]).toBe('mat_brick_red');
    expect(ir.faceMaterials![1]).toBe('mat_concrete_grey');

    expect(ir.faceOpeningIds).toBeDefined();
    expect(ir.faceOpeningIds![0]).toBe('opening_host_wall');
    expect(ir.faceOpeningIds![1]).toBeNull();

    expect(ir.triPositions.length).toBeGreaterThan(0);
    expect(ir.triIndices.length).toBeGreaterThan(0);

    // Rehydrate from GeometryIR
    const restored = PolyMesh.fromGeometryIR(ir, 'restored_wall');

    expect(restored.faces.size).toBe(2);
    const restoredFaces = Array.from(restored.faces.values());

    // Verify Face 1
    const rFace1 = restoredFaces[0];
    const rPositions1 = rFace1.getPositions();
    expect(rPositions1.length).toBe(4);
    expect(rPositions1[0].distanceTo(new Vec3(0, 0, 0))).toBeLessThan(1e-5);
    expect(rPositions1[1].distanceTo(new Vec3(4, 0, 0))).toBeLessThan(1e-5);
    expect(rPositions1[2].distanceTo(new Vec3(4, 3, 0))).toBeLessThan(1e-5);
    expect(rPositions1[3].distanceTo(new Vec3(0, 3, 0))).toBeLessThan(1e-5);

    expect(rFace1.holes.length).toBe(1);
    expect(rFace1.holes[0].length).toBe(4);
    expect(rFace1.holes[0][0].distanceTo(new Vec3(1, 1, 0))).toBeLessThan(1e-5);
    expect(rFace1.holeOwners).toBeDefined();
    expect(rFace1.holeOwners![0]).toBe('opening_window_777');
    expect(rFace1.materialId).toBe('mat_brick_red');
    expect(rFace1.openingId).toBe('opening_host_wall');

    // Verify Face 2
    const rFace2 = restoredFaces[1];
    expect(rFace2.getPositions().length).toBe(4);
    expect(rFace2.holes.length).toBe(0);
    expect(rFace2.materialId).toBe('mat_concrete_grey');

    // Round-trip idempotency test
    const irRoundTrip = restored.toGeometryIR();
    expect(irRoundTrip.faceLoopCounts).toEqual(ir.faceLoopCounts);
    expect(irRoundTrip.holeCounts).toEqual(ir.holeCounts);
    expect(irRoundTrip.holeOwners).toEqual(ir.holeOwners);
    expect(irRoundTrip.faceMaterials).toEqual(ir.faceMaterials);
    expect(irRoundTrip.faceOpeningIds).toEqual(ir.faceOpeningIds);
    expect(irRoundTrip.positions!.length).toBe(ir.positions!.length);
  });

  it('executes RUN_EDITOR_POSTPROCESS and HYDRATE_BREP in IfcImportWorkerCore (RPC Post-Process)', async () => {
    const fixturePath = 'C:/AI/10 CROQUERA/ModelosDePrueba/Paraderos_Original.ifc';
    const ifcContent = fs.readFileSync(fixturePath);
    const stepBuffer = ifcContent.buffer.slice(
      ifcContent.byteOffset,
      ifcContent.byteOffset + ifcContent.byteLength
    );

    const core = new IfcImportWorkerCore();
    let emittedResponses: IfcWorkerResponse[] = [];

    // Parse the file through WorkerCore
    await core.process(
      {
        type: 'PARSE_IFC',
        stepBuffer,
        chunkSize: 100,
      },
      (resp) => {
        emittedResponses.push(resp);
      }
    );

    const completePayload = emittedResponses.find((r) => r.type === 'STAGE_COMPLETE');
    expect(completePayload).toBeDefined();

    // Now dispatch RUN_EDITOR_POSTPROCESS
    let postprocessPayload: StageEditorPostprocessBatchPayload | null = null;
    await core.process(
      {
        type: 'RUN_EDITOR_POSTPROCESS',
      },
      (resp) => {
        if (resp.type === 'STAGE_EDITOR_POSTPROCESS_BATCH') {
          postprocessPayload = resp as StageEditorPostprocessBatchPayload;
        }
      }
    );

    expect(postprocessPayload).toBeDefined();
    expect(postprocessPayload!.type).toBe('STAGE_EDITOR_POSTPROCESS_BATCH');
    expect(postprocessPayload!.psetsByStepId).toBeDefined();
    expect(postprocessPayload!.grids).toBeDefined();
    expect(postprocessPayload!.openings).toBeDefined();
    expect(postprocessPayload!.openingToHostStepMap).toBeDefined();
    expect(postprocessPayload!.fillToOpeningStepMap).toBeDefined();

    // Now dispatch HYDRATE_BREP for STEP ID 30
    let hydratePayload: StageHydrateBrepPayload | null = null;
    await core.process(
      {
        type: 'HYDRATE_BREP',
        stepIds: [30],
        coalesceFaces: true,
      },
      (resp) => {
        if (resp.type === 'STAGE_HYDRATE_BREP') {
          hydratePayload = resp as StageHydrateBrepPayload;
        }
      }
    );

    expect(hydratePayload).toBeDefined();
    expect(hydratePayload!.type).toBe('STAGE_HYDRATE_BREP');
    expect(hydratePayload!.elements.length).toBe(1);
    expect(hydratePayload!.elements[0].stepId).toBe(30);
    expect(hydratePayload!.elements[0].geometryIR).toBeDefined();
    expect(hydratePayload!.elements[0].geometryIR.triPositions.length).toBeGreaterThan(0);
    expect(hydratePayload!.elements[0].geometryIR.triIndices.length).toBeGreaterThan(0);
  });
});
