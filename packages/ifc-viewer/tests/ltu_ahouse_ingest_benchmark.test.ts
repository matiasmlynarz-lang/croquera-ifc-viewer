import { describe, it, expect } from 'vitest';
import fs from 'fs';
import * as THREE from 'three';
import { ChunkedStreamScanner, IfcStepImporter, IFC_PRIORITY_STRUCTURAL_TYPES } from '@croquera/ifc-core';
import { BatchedMeshPool } from '../src/renderer/BatchedMeshPool';
import { MaterialManager } from '../src/renderer/MaterialManager';

describe('LTU A-House & Material Normalization Benchmark Test', () => {
  const filePath = 'C:/Users/CyD/Downloads/LTU_A-House_2014-09-25_ifc/LTU_A-House_redesign.ifc';
  const fileExists = fs.existsSync(filePath);

  it.runIf(fileExists)(
    'correctly ingests LTU_A-House_redesign.ifc with <= 50 BatchedMeshes and no GPU/UI memory explosion',
    () => {
    const nodeBuffer = fs.readFileSync(filePath);
    const arrayBuffer = nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength);

    const scanner = new ChunkedStreamScanner(arrayBuffer);
    scanner.parseHeader();
    scanner.scanDataSection();

    expect(scanner.totalEntities).toBeGreaterThan(3_000_000);

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    importer.setProductTypesFilter(IFC_PRIORITY_STRUCTURAL_TYPES);

    // Stage 1: Spatial hierarchy & Material extraction
    const stage1 = importer.extractSpatialHierarchy();
    expect(stage1.materials).toBeDefined();

    // Verification: Material deduplication reduces materials from 2,600 to <= 70 (actual: 58)
    expect(stage1.materials!.length).toBeLessThanOrEqual(70);
    MaterialManager.getInstance().registerMaterials(stage1.materials!);

    // Stage 2: Product bounds
    const stage2 = importer.extractProductBounds();
    expect(stage2.totalElements).toBeGreaterThan(9000);

    // Stage 3: Ingest into BatchedMeshPool
    const scene = new THREE.Scene();
    const pool = new BatchedMeshPool(scene);

    const productStepIds = importer.getProductStepIds();
    // Test ingesting first 500 products (which previously spawned over 350 BatchedMeshes)
    const testBatch = productStepIds.slice(0, 500);

    importer.extractGeometryChunks(100, (chunk) => {
      pool.ingestChunk(chunk.elements);
    }, testBatch);

    const batchedBuckets = pool['batchedBuckets'] as Map<string, THREE.BatchedMesh[]>;
    let totalBatchedMeshes = 0;
    for (const list of batchedBuckets.values()) {
      totalBatchedMeshes += list.length;
    }

    // With visual key consolidation, 500 elements must fit in <= 10 BatchedMeshes (previously > 350)
    expect(batchedBuckets.size).toBeLessThanOrEqual(10);
    expect(totalBatchedMeshes).toBeLessThanOrEqual(10);
    expect(pool.modelBoundingBox.isEmpty()).toBe(false);
  }, 30000);

  it('deduplicates repetitive material layer usages into a single canonical BatchedMesh bucket', () => {
    // Synthetic STEP content with 3 walls having 3 distinct IFCMATERIALLAYERSETUSAGE pointing to same IFCMATERIAL
    const syntheticIfc = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('synth_mat_test.ifc','2026-10-23',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Site',$,$,$,$,$,$,$,$,$,$,$);
#3= IFCBUILDING('0$r_g_0000000000000003',$,'Building',$,$,$,$,$,$,$);
#4= IFCBUILDINGSTOREY('0$r_g_0000000000000004',$,'Storey 1',$,$,$,$,$,$,0.0);
#10= IFCCARTESIANPOINT((0.,0.,0.));
#11= IFCAXIS2PLACEMENT3D(#10,$,$);
#12= IFCLOCALPLACEMENT($,#11);
#20= IFCMATERIAL('Gypsum Wallboard',$,$);
#21= IFCMATERIALLAYER(#20,0.1,$);
#22= IFCMATERIALLAYERSET((#21),'Wall Layer Set');
#23= IFCMATERIALLAYERSETUSAGE(#22,.AXIS2.,.POSITIVE.,0.0);
#24= IFCMATERIALLAYERSETUSAGE(#22,.AXIS2.,.POSITIVE.,0.0);
#25= IFCMATERIALLAYERSETUSAGE(#22,.AXIS2.,.POSITIVE.,0.0);
#30= IFCWALL('0$r_g_0000000000000010',$,'Wall 1',$,$,#12,$,$);
#31= IFCWALL('0$r_g_0000000000000011',$,'Wall 2',$,$,#12,$,$);
#32= IFCWALL('0$r_g_0000000000000012',$,'Wall 3',$,$,#12,$,$);
#40= IFCRELASSOCIATESMATERIAL('0$r_g_0000000000000020',$,$,$,(#30),#23);
#41= IFCRELASSOCIATESMATERIAL('0$r_g_0000000000000021',$,$,$,(#31),#24);
#42= IFCRELASSOCIATESMATERIAL('0$r_g_0000000000000022',$,$,$,(#32),#25);
ENDSEC;
END-ISO-10303-21;
    `.trim();

    const rawBytes = new TextEncoder().encode(syntheticIfc);
    const scanner = new ChunkedStreamScanner(rawBytes.buffer);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    const stage1 = importer.extractSpatialHierarchy();

    // Verify only 1 deduplicated material is emitted for the 3 distinct IFCMATERIALLAYERSETUSAGE references
    expect(stage1.materials).toBeDefined();
    expect(stage1.materials!.length).toBe(1);
    expect(stage1.materials![0].name).toBe('Gypsum Wallboard');

    // Verify key resolution in MaterialManager
    MaterialManager.getInstance().registerMaterials(stage1.materials!);
    const key = MaterialManager.getInstance().getMaterialKey(stage1.materials![0].id);
    expect(key).toContain('_o100_r90_m0');
  });
});
