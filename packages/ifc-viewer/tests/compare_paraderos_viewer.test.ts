import { describe, it, expect } from 'vitest';
import fs from 'fs';
import * as THREE from 'three';
import { ChunkedStreamScanner } from '../../ifc-core/src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../../ifc-core/src/importer/IfcStepImporter';
import { BatchedMeshPool } from '../src/renderer/BatchedMeshPool';
import { MaterialManager } from '../src/renderer/MaterialManager';

describe('Paraderos_Original.ifc in Viewer', () => {
  const filePath = 'C:/AI/10 CROQUERA/ModelosDePrueba/Paraderos_Original.ifc';

  it('tests full ingestion pipeline for Paraderos_Original.ifc', () => {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    const spatial = importer.extractSpatialHierarchy();
    const bounds = importer.extractProductBounds();

    console.log('--- Bounds ---');
    console.log('modelAABB:', bounds.modelAABB);

    // Register materials in MaterialManager
    MaterialManager.getInstance().registerMaterials(spatial.materials);

    const scene = new THREE.Scene();
    const meshPool = new BatchedMeshPool(scene);

    const min = bounds.modelAABB.min;
    const max = bounds.modelAABB.max;
    const centerX = (min[0] + max[0]) / 2;
    const centerZ = (min[2] + max[2]) / 2;
    const minY = min[1];
    const horizontalDist = Math.hypot(centerX, centerZ);
    const isGeoreferenced = horizontalDist > 50 || Math.abs(minY) > 50;
    if (isGeoreferenced) {
      const offsetY = Math.abs(minY) > 5 ? minY : 0;
      meshPool.setRenderOffset(new THREE.Vector3(centerX, offsetY, centerZ));
    }

    const chunks = Array.from(importer.extractGeometryChunks(100));
    meshPool.ingestChunk(chunks[0].elements);

    console.log('--- BatchedMeshes & Edges created ---');
    console.log('rootGroup children:', meshPool.rootGroup.children.length);
    console.log('edgesGroup children:', meshPool.edgesGroup.children.length);
    for (const child of meshPool.edgesGroup.children) {
      if (child instanceof THREE.LineSegments) {
        console.log(` LineSegments: count=${child.geometry.attributes.position.count / 2} lines`);
      }
    }
    for (const child of meshPool.rootGroup.children) {
      if (child instanceof THREE.BatchedMesh) {
        console.log(` BatchedMesh: name=${child.name}`);
        const mat = child.material as THREE.MeshStandardMaterial;
        console.log(`  Material: color=#${mat.color.getHexString()} side=${mat.side} (FrontSide=${THREE.FrontSide}, BackSide=${THREE.BackSide}, DoubleSide=${THREE.DoubleSide}) transparent=${mat.transparent}`);
      }
    }

    console.log('--- Model Bounding Box in MeshPool ---');
    console.log('MeshPool bounding box:', meshPool.modelBoundingBox);

    // Check camera fitting with bounds.modelAABB vs meshPool.modelBoundingBox
    const initialBox = new THREE.Box3(
      new THREE.Vector3(...bounds.modelAABB.min),
      new THREE.Vector3(...bounds.modelAABB.max)
    );
    console.log('Initial camera box center:', initialBox.getCenter(new THREE.Vector3()));
    console.log('Initial camera box size:', initialBox.getSize(new THREE.Vector3()));
    console.log('MeshPool box center:', meshPool.modelBoundingBox.getCenter(new THREE.Vector3()));
    console.log('MeshPool box size:', meshPool.modelBoundingBox.getSize(new THREE.Vector3()));
  });
});
