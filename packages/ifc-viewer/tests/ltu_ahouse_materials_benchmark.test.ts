import { describe, it, expect } from 'vitest';
import fs from 'fs';
import * as THREE from 'three';
import { ChunkedStreamScanner, IfcStepImporter } from '@croquera/ifc-core';
import { MaterialManager } from '../src/renderer/MaterialManager';
import { BatchedMeshPool } from '../src/renderer/BatchedMeshPool';

describe('LTU A-House Materials & Transparency Benchmark', () => {
  const filePath = 'C:/Users/CyD/Downloads/LTU_A-House_2014-09-25_ifc/LTU_A-House_redesign.ifc';

  it('correctly registers colors and transparent glass materials without degrading to monochrome clay', () => {
    if (!fs.existsSync(filePath)) {
      console.warn('Skipping benchmark: LTU_A-House_redesign.ifc not found at path');
      return;
    }

    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    const hierarchy = importer.extractSpatialHierarchy();

    // 1. Check material catalog from importer
    const materials = hierarchy.materials || [];
    expect(materials.length).toBeGreaterThan(10);

    const orangeMat = materials.find((m) => m.id.toLowerCase().includes('c95945'));
    expect(orangeMat).toBeDefined();
    expect(orangeMat?.baseColor.toLowerCase()).toBe('#c95945');

    const glassMat = materials.find((m) => m.id.toLowerCase().includes('f0f7f3'));
    expect(glassMat).toBeDefined();
    expect(glassMat?.opacity).toBeLessThan(0.2);

    // 2. Test MaterialManager synthesis and registration
    const matMgr = MaterialManager.getInstance();
    matMgr.registerMaterials(materials);

    const threeGlass = matMgr.getMaterialById(glassMat!.id) as THREE.MeshStandardMaterial;
    expect(threeGlass).toBeDefined();
    expect(threeGlass.transparent).toBe(true);
    expect(threeGlass.opacity).toBeCloseTo(0.12, 2);

    // 3. Extract Window 10255 and verify sub-mesh materials
    const extractedElements: any[] = [];
    importer.extractGeometryChunks(100, (chunk) => {
      for (const el of chunk.elements) {
        extractedElements.push(el);
      }
    }, [10255]);

    const windowParts = extractedElements.filter(
      (el) => el.type === 'GEOMETRY_ENTITY' && el.stepId === 10255
    );
    expect(windowParts.length).toBe(8);

    const glassPanes = windowParts.filter((p) => p.materialId?.includes('f0f7f3'));
    expect(glassPanes.length).toBe(2);

    // 4. Test BatchedMeshPool transparency handling
    const scene = new THREE.Scene();
    const pool = new BatchedMeshPool(scene);
    pool.ingestChunk(extractedElements);

    // All batched meshes with transparent material must have renderOrder === 1 and castShadow === false
    for (const child of pool.rootGroup.children) {
      if (child instanceof THREE.BatchedMesh) {
        const mat = child.material as THREE.MeshStandardMaterial;
        if (mat.transparent) {
          expect(child.renderOrder).toBe(1);
          expect(child.castShadow).toBe(false);
        }
      }
    }
  });
});
