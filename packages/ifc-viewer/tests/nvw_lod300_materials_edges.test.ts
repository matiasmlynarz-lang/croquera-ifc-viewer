import { describe, it, expect } from 'vitest';
import fs from 'fs';
import * as THREE from 'three';
import { ChunkedStreamScanner, IfcStepImporter, PolyMesh, Vec3 } from '@croquera/ifc-core';
import { MaterialManager } from '../src/renderer/MaterialManager';
import { BatchedMeshPool } from '../src/renderer/BatchedMeshPool';

describe('NVW LOD300 Materials & Coplanar Edges Benchmark', () => {
  const filePath = 'C:/AI/10 CROQUERA/ModelosDePrueba/NVW_DCR-LOD300_Arch.ifc';

  it('PolyMesh.toEdgeGeometry suppresses coplanar diagonals and preserves boundary / crease edges', () => {
    const mesh = new PolyMesh('test_coplanar_quad');
    // Create a flat 1x1 quad split into 2 coplanar triangles in Z = 0
    // Triangle 1: (0,0,0) -> (1,0,0) -> (1,1,0)
    // Triangle 2: (0,0,0) -> (1,1,0) -> (0,1,0)
    // Shared diagonal: (0,0,0) to (1,1,0)
    mesh.addFace([new Vec3(0, 0, 0), new Vec3(1, 0, 0), new Vec3(1, 1, 0)]);
    mesh.addFace([new Vec3(0, 0, 0), new Vec3(1, 1, 0), new Vec3(0, 1, 0)]);

    const edgeGeo = mesh.toEdgeGeometry();
    const pos = edgeGeo.attributes.position;
    // Each line segment has 2 vertices (6 floats: x1,y1,z1, x2,y2,z2)
    const numLineSegments = pos.count / 2;

    // Must emit exactly 4 perimeter edges (the shared diagonal must be suppressed)
    expect(numLineSegments).toBe(4);

    // Now test a 90-degree folded crease:
    const foldMesh = new PolyMesh('test_folded_crease');
    // Face 1 on XY plane (normal Z): (0,0,0) -> (1,0,0) -> (1,1,0) -> (0,1,0)
    // Face 2 on YZ plane (normal X): (0,0,0) -> (0,1,0) -> (0,1,1) -> (0,0,1)
    // Shared edge: (0,0,0) to (0,1,0) with 90° dihedral angle
    foldMesh.addFace([new Vec3(0, 0, 0), new Vec3(1, 0, 0), new Vec3(1, 1, 0), new Vec3(0, 1, 0)]);
    foldMesh.addFace([new Vec3(0, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 1, 1), new Vec3(0, 0, 1)]);

    const foldEdgeGeo = foldMesh.toEdgeGeometry();
    const foldPos = foldEdgeGeo.attributes.position;
    // 2 quads sharing 1 edge = 7 unique edges in total (1 crease + 6 boundaries)
    // All 7 must be emitted because crease angle is 90°
    expect(foldPos.count / 2).toBe(7);
  });

  it('correctly infers semantic PBR materials without IfcSurfaceStyle for NVW_DCR-LOD300_Arch.ifc', () => {
    if (!fs.existsSync(filePath)) {
      console.warn('Skipping test: NVW_DCR-LOD300_Arch.ifc not found at path');
      return;
    }

    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    const hierarchy = importer.extractSpatialHierarchy();
    const materials = hierarchy.materials || [];

    // Must resolve materials from IFCRELASSOCIATESMATERIAL
    expect(materials.length).toBeGreaterThanOrEqual(15);

    // 1. Verify Glass & Glazing
    const glassMat = materials.find((m) => m.name.toLowerCase().includes('glazing') || m.name.toLowerCase().includes('glass'));
    expect(glassMat).toBeDefined();
    expect(glassMat?.transparent).toBe(true);
    expect(glassMat?.opacity).toBeLessThan(0.5);
    expect(glassMat?.category).toBe('glass');

    // 2. Verify Concrete
    const concreteMat = materials.find((m) => m.name.toLowerCase().includes('concrete'));
    expect(concreteMat).toBeDefined();
    expect(concreteMat?.category).toBe('concrete');
    expect(concreteMat?.roughness).toBeGreaterThanOrEqual(0.8);
    expect(concreteMat?.transparent).toBe(false);

    // 3. Verify Metal / Aluminium
    const metalMat = materials.find((m) => m.name.toLowerCase().includes('aluminium') || m.name.toLowerCase().includes('steel'));
    expect(metalMat).toBeDefined();
    expect(metalMat?.category).toBe('metal');
    expect(metalMat?.metalness).toBeGreaterThanOrEqual(0.7);

    // 4. Test MaterialManager GPU material synthesis
    const matMgr = MaterialManager.getInstance();
    matMgr.registerMaterials(materials);

    const threeGlass = matMgr.getMaterialById(glassMat!.id) as THREE.MeshStandardMaterial;
    expect(threeGlass).toBeDefined();
    expect(threeGlass.transparent).toBe(true);
    expect(threeGlass.opacity).toBeLessThan(0.5);

    // 5. Test BatchedMeshPool rendering bucket segregation
    const scene = new THREE.Scene();
    const pool = new BatchedMeshPool(scene);

    // Extract 5 specific architectural elements (walls and members)
    const targetProductIds = [3545, 9109, 16238, 411, 494];
    const extractedElements: any[] = [];
    importer.extractGeometryChunks(
      10,
      (chunk) => {
        for (const el of chunk.elements) {
          extractedElements.push(el);
        }
      },
      targetProductIds
    );

    pool.ingestChunk(extractedElements);

    // Verify BatchedMesh creation with non-monochrome materials
    expect(pool.rootGroup.children.length).toBeGreaterThan(0);
  }, 60000);
});
