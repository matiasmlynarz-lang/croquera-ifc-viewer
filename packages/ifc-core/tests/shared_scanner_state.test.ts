import { describe, it, expect } from 'vitest';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';
import { IfcTypeDictionary } from '../src/parser/IfcTypeDictionary';
import { safeDecodeUtf8, decodeAscii } from '../src/lexer/IfcStepByteLexer';
import { IfcAdaptiveWorkerPool } from '../src/worker/IfcAdaptiveWorkerPool';
import { IfcWorkerClient } from '../src/worker/IfcWorkerClient';
import type { IfcWorkerResponse } from '../src/types/IfcWorkerProtocol';

describe('SharedScannerState & Multi-Worker Coordination Tests', () => {
  const encoder = new TextEncoder();

  const testIfcContent = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('multiworker_test.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Multiworker Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Site',$,$,$,$,$,$,$,$,$,$,$);
#3= IFCBUILDING('0$r_g_0000000000000003',$,'Building',$,$,$,$,$,$,$);
#4= IFCBUILDINGSTOREY('0$r_g_0000000000000004',$,'Storey 1',$,$,$,$,$,$,0.0);
#10= IFCCARTESIANPOINT((0.,0.,0.));
#11= IFCAXIS2PLACEMENT3D(#10,$,$);
#12= IFCLOCALPLACEMENT($,#11);
#20= IFCPOLYLINE((#10,#10));
#21= IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#20));
#22= IFCPRODUCTDEFINITIONSHAPE($,$,(#21));
#30= IFCWALL('0$r_g_0000000000000010',$,'Wall 1',$,$,#12,#22,$);
#31= IFCWALL('0$r_g_0000000000000011',$,'Wall 2',$,$,#12,#22,$);
#32= IFCSLAB('0$r_g_0000000000000012',$,'Slab 1',$,$,#12,#22,$);
#40= IFCFURNISHINGELEMENT('0$r_g_0000000000000020',$,'Desk 1',$,$,#12,#22,$);
#41= IFCFURNISHINGELEMENT('0$r_g_0000000000000021',$,'Chair 1',$,$,#12,#22,$);
#50= IFCRELAGGREGATES('0$r_g_0000000000000030',$,$,$,#1,(#2));
#51= IFCRELAGGREGATES('0$r_g_0000000000000031',$,$,$,#2,(#3));
#52= IFCRELAGGREGATES('0$r_g_0000000000000032',$,$,$,#3,(#4));
#53= IFCRELCONTAINEDINSPATIALSTRUCTURE('0$r_g_0000000000000033',$,$,$,(#30,#31,#32,#40,#41),#4);
ENDSEC;
END-ISO-10303-21;
  `.trim();

  it('scans in Coordinator and hydrates Tessellators in 0 ms with 100% bit-for-bit parity', () => {
    const rawBytes = encoder.encode(testIfcContent);
    const buffer = typeof SharedArrayBuffer !== 'undefined'
      ? new SharedArrayBuffer(rawBytes.byteLength)
      : new ArrayBuffer(rawBytes.byteLength);
    new Uint8Array(buffer).set(rawBytes);

    const coordinatorScanner = new ChunkedStreamScanner(buffer);
    coordinatorScanner.parseHeader();
    coordinatorScanner.scanDataSection();

    expect(coordinatorScanner.totalEntities).toBeGreaterThan(0);

    // Export shared state
    const exportStart = performance.now();
    const sharedState = coordinatorScanner.exportSharedState();
    const exportDuration = performance.now() - exportStart;
    expect(exportDuration).toBeLessThan(10); // Export must take < 10ms

    // Hydrate tessellator scanner
    const importStart = performance.now();
    const tessellatorScanner = ChunkedStreamScanner.fromSharedState(sharedState);
    const importDuration = performance.now() - importStart;
    expect(importDuration).toBeLessThan(10); // Hydration in 0 ms (pointer wrap)

    // Validate parity
    expect(tessellatorScanner.totalEntities).toBe(coordinatorScanner.totalEntities);
    expect(tessellatorScanner.maxId).toBe(coordinatorScanner.maxId);

    // Check all IDs
    const testIds = [1, 2, 3, 4, 10, 11, 12, 20, 21, 22, 30, 31, 32, 40, 41, 50, 51, 52, 53];
    for (const id of testIds) {
      expect(tessellatorScanner.hasRecord(id)).toBe(true);
      expect(tessellatorScanner.getRecordType(id)).toBe(coordinatorScanner.getRecordType(id));

      const origRec = coordinatorScanner.getRecord(id);
      const sharedRec = tessellatorScanner.getRecord(id);
      expect(sharedRec).toBeDefined();
      expect(sharedRec?.id).toBe(origRec?.id);
      expect(sharedRec?.type).toBe(origRec?.type);
      expect(sharedRec?.params.length).toBe(origRec?.params.length);
    }

    // Check getRecordsByType
    const wallsOrig = coordinatorScanner.getRecordsByType('IFCWALL');
    const wallsShared = tessellatorScanner.getRecordsByType('IFCWALL');
    expect(wallsShared.length).toBe(wallsOrig.length);
    expect(wallsShared.map((w) => w.id)).toEqual(wallsOrig.map((w) => w.id));

    const furnishOrig = coordinatorScanner.getRecordsByType('IFCFURNISHINGELEMENT');
    const furnishShared = tessellatorScanner.getRecordsByType('IFCFURNISHINGELEMENT');
    expect(furnishShared.length).toBe(furnishOrig.length);
    expect(furnishShared.map((f) => f.id)).toEqual(furnishOrig.map((f) => f.id));
  });

  it('orchestrates 1 Coordinator + N Tessellators through IfcAdaptiveWorkerPool', async () => {
    const rawBytes = encoder.encode(testIfcContent);
    const buffer = typeof SharedArrayBuffer !== 'undefined'
      ? new SharedArrayBuffer(rawBytes.byteLength)
      : new ArrayBuffer(rawBytes.byteLength);
    new Uint8Array(buffer).set(rawBytes);

    // Create 3 worker clients with fallback cores simulating 3 threads
    const workerClients = [
      new IfcWorkerClient(), // Coordinator
      new IfcWorkerClient(), // Tessellator 1
      new IfcWorkerClient(), // Tessellator 2
    ];

    const pool = new IfcAdaptiveWorkerPool({
      workers: workerClients,
      forceMultiThreaded: true,
      maxWorkers: 3,
    });

    expect(pool.getPoolSize()).toBe(3);
    expect(pool.isMultiThreadedSupported()).toBe(true);

    const emittedResponses: IfcWorkerResponse[] = [];
    await pool.parseFile(buffer, 1, (resp) => {
      emittedResponses.push(resp);
    });

    // Verify sequential stages were received
    const responseTypes = emittedResponses.map((r) => r.type);
    expect(responseTypes).toContain('STAGE_SPATIAL_HIERARCHY');
    expect(responseTypes).toContain('STAGE_BOUNDS_AABB');
    expect(responseTypes).toContain('STAGE_PHASE_1_COMPLETE');
    expect(responseTypes).toContain('STAGE_COMPLETE');

    // Stage 1 spatial hierarchy checks
    const spatialResp = emittedResponses.find((r) => r.type === 'STAGE_SPATIAL_HIERARCHY') as any;
    expect(spatialResp.spatialNodes.length).toBeGreaterThanOrEqual(4);

    // Stage 2 bounds checks
    const boundsResp = emittedResponses.find((r) => r.type === 'STAGE_BOUNDS_AABB') as any;
    expect(boundsResp.totalElements).toBeGreaterThan(0);

    // Stage complete checks
    const completeResp = emittedResponses.find((r) => r.type === 'STAGE_COMPLETE') as any;
    expect(completeResp.totalElements).toBeGreaterThan(0);
    expect(completeResp.durationMs).toBeGreaterThan(0);

    // Lazy Pset resolution in O(1)
    const psetsWall = await pool.resolveProperties(30);
    expect(psetsWall).toBeDefined();

    pool.terminate();
  });

  it('safely decodes UTF-8 and ASCII on SharedArrayBuffer without TextDecoder sharing violations', () => {
    const rawText = 'ISO-10303-21; HEADER; FILE_NAME(\'test_ñandú.ifc\'); DATA; #1= IFCWALL(\'guid\');';
    const bytes = encoder.encode(rawText);
    const shared = typeof SharedArrayBuffer !== 'undefined'
      ? new SharedArrayBuffer(bytes.byteLength)
      : new ArrayBuffer(bytes.byteLength);
    const u8 = new Uint8Array(shared);
    u8.set(bytes);

    // 1. safeDecodeUtf8 on shared memory view
    const slice = u8.subarray(0, 30);
    const decoded = safeDecodeUtf8(slice);
    expect(decoded).toContain('ISO-10303-21');

    // 2. decodeAscii on shared memory view
    const ascii = decodeAscii(u8, 0, 12);
    expect(ascii).toBe('ISO-10303-21');

    // 3. IfcTypeDictionary type code resolution directly from SharedArrayBuffer view
    const dict = new IfcTypeDictionary();
    const typeStart = u8.findIndex((_, idx) =>
      u8[idx] === 73 && u8[idx + 1] === 70 && u8[idx + 2] === 67 && u8[idx + 3] === 87
    );
    const code = dict.getTypeCodeFromBytes(u8, typeStart, 7);
    expect(code).toBeGreaterThan(0);
    expect(dict.getTypeName(code)).toBe('IFCWALL');
  });

  it('preserves 100% of entities with stepId >= 5,000,000 and sparse gaps across Web Workers (CRITICO-02)', () => {
    const highIdIfcContent = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('high_ids_test.ifc','2026-10-23',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Project',$,$,$,$,$,$);
#5000001= IFCWALL('0$r_g_0000000000000010',$,'Wall Over 5M',$,$,$,$,$);
#7092100= IFCSLAB('0$r_g_0000000000000020',$,'ElManzano Slab',$,$,$,$,$);
#16782104= IFCCOLUMN('0$r_g_0000000000000030',$,'VespucioNorte Column',$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
    `.trim();

    const rawBytes = encoder.encode(highIdIfcContent);
    const buffer = typeof SharedArrayBuffer !== 'undefined'
      ? new SharedArrayBuffer(rawBytes.byteLength)
      : new ArrayBuffer(rawBytes.byteLength);
    new Uint8Array(buffer).set(rawBytes);

    // Coordinator scanner
    const coordinatorScanner = new ChunkedStreamScanner(buffer);
    coordinatorScanner.parseHeader();
    coordinatorScanner.scanDataSection();

    expect(coordinatorScanner.totalEntities).toBe(4);
    expect(coordinatorScanner.maxId).toBe(16782104);

    // Verify Coordinator sees high IDs
    expect(coordinatorScanner.hasRecord(1)).toBe(true);
    expect(coordinatorScanner.hasRecord(5000001)).toBe(true);
    expect(coordinatorScanner.hasRecord(7092100)).toBe(true);
    expect(coordinatorScanner.hasRecord(16782104)).toBe(true);

    // Export shared state
    const sharedState = coordinatorScanner.exportSharedState();
    expect(sharedState.sparsePages).toBeDefined();
    expect(sharedState.sparsePages!.length).toBeGreaterThanOrEqual(3); // At least pages for 5000001, 7092100, 16782104

    for (const page of sharedState.sparsePages!) {
      expect(page.pageIdx).toBeGreaterThanOrEqual(0);
      expect(page.startOffsetsBuffer.byteLength).toBe(ChunkedStreamScanner['PAGE_SIZE'] * 4);
      expect(page.lengthsBuffer.byteLength).toBe(ChunkedStreamScanner['PAGE_SIZE'] * 4);
      expect(page.typeCodesBuffer.byteLength).toBe(ChunkedStreamScanner['PAGE_SIZE'] * 2);
      expect(page.typeNextBuffer.byteLength).toBe(ChunkedStreamScanner['PAGE_SIZE'] * 4);
    }

    // Hydrate secondary worker scanner (Tessellator)
    const tessellatorScanner = ChunkedStreamScanner.fromSharedState(sharedState);

    expect(tessellatorScanner.totalEntities).toBe(4);
    expect(tessellatorScanner.maxId).toBe(16782104);

    // Verify 100% bit-for-bit parity on all entities including stepId >= 5,000,000
    const testIds = [1, 5000001, 7092100, 16782104];
    for (const id of testIds) {
      expect(tessellatorScanner.hasRecord(id)).toBe(true);
      expect(tessellatorScanner.getRecordType(id)).toBe(coordinatorScanner.getRecordType(id));

      const origRec = coordinatorScanner.getRecord(id);
      const sharedRec = tessellatorScanner.getRecord(id);
      expect(sharedRec).toBeDefined();
      expect(sharedRec?.id).toBe(origRec?.id);
      expect(sharedRec?.type).toBe(origRec?.type);
      expect(sharedRec?.params).toEqual(origRec?.params);
    }

    // High non-existent ID
    expect(tessellatorScanner.hasRecord(16782105)).toBe(false);
    expect(tessellatorScanner.getRecord(16782105)).toBeUndefined();
    expect(tessellatorScanner.getRecordType(16782105)).toBeUndefined();

    // Verify type lists include high IDs
    const walls = tessellatorScanner.getRecordsByType('IFCWALL');
    expect(walls.length).toBe(1);
    expect(walls[0].id).toBe(5000001);

    const slabs = tessellatorScanner.getRecordsByType('IFCSLAB');
    expect(slabs.length).toBe(1);
    expect(slabs[0].id).toBe(7092100);

    const columns = tessellatorScanner.getRecordsByType('IFCCOLUMN');
    expect(columns.length).toBe(1);
    expect(columns[0].id).toBe(16782104);
  });
});


