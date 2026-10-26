import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MaterialManager } from '../src/renderer/MaterialManager';

describe('BatchedMesh color behavior', () => {
  it('checks material color and BatchedMesh setColorAt behavior', () => {
    const matMgr = MaterialManager.getInstance();
    matMgr.registerMaterials([
      {
        id: 'mat_ifc_ff6532',
        name: 'Orange Style',
        baseColor: '#ff6532',
        colorHex: '#ff6532',
        roughness: 0.5,
        metalness: 0,
        opacity: 1,
      },
    ]);

    const mat = matMgr.getMaterialById('mat_ifc_ff6532') as THREE.MeshStandardMaterial;
    console.log('Material color hex:', '#' + mat.color.getHexString());
    expect('#' + mat.color.getHexString()).toBe('#ff6532');

    const batched = new THREE.BatchedMesh(10, 100, 100, mat);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const geomId = batched.addGeometry(geo);
    const batchId = batched.addInstance(geomId);

    console.log('_colorsTexture before setColorAt:', (batched as any)._colorsTexture);

    const savedColor = new THREE.Color(0xffffff);
    if ((batched as any)._colorsTexture) {
      batched.getColorAt(batchId, savedColor);
    } else {
      savedColor.set(0xffffff);
    }
    console.log('savedColor before selection:', '#' + savedColor.getHexString());

    batched.setColorAt(batchId, new THREE.Color(0x2563eb));
    console.log('_colorsTexture after setColorAt:', (batched as any)._colorsTexture !== null);

    const currentColor = new THREE.Color();
    batched.getColorAt(batchId, currentColor);
    console.log('currentColor during selection:', '#' + currentColor.getHexString());

    // Now clear selection
    batched.setColorAt(batchId, savedColor);
    batched.getColorAt(batchId, currentColor);
    console.log('currentColor after clearSelection:', '#' + currentColor.getHexString());
  });
});
