/**
 * BatchedMeshPool — Buffer-first GPU acceleration pool for streamed IFC elements.
 *
 * Ingests TessellatedElementDTO transferables directly from Web Workers into Three.js
 * BatchedMesh / InstancedMesh structures in O(1) without re-tessellation.
 */

import * as THREE from 'three';
import type { TessellatedElementDTO, InstanceElementDTO } from '@croquera/ifc-core';
import { MaterialManager } from './MaterialManager';

export interface RenderedElementRecord {
  id: string;
  stepId: number;
  name: string;
  ifcType: string;
  predefinedType?: string;
  parentId: string | null;
  storeyId: string | null;
  matrixId?: string | null;
  psets?: Record<string, Record<string, any>>;
  mesh: THREE.Mesh;
  edges?: THREE.LineSegments;
  box: THREE.Box3;
}

export class BatchedMeshPool {
  private readonly scene: THREE.Scene;
  private readonly materialManager: MaterialManager;

  // Global root group for all loaded IFC geometry
  public readonly rootGroup: THREE.Group = new THREE.Group();
  public readonly edgesGroup: THREE.Group = new THREE.Group();

  // Index of elements
  private elementMap: Map<string, RenderedElementRecord> = new Map();
  private stepIdMap: Map<number, string> = new Map();

  // Prototypes for InstancedMesh
  private prototypeGeometries: Map<string, THREE.BufferGeometry> = new Map();
  private prototypeMeshes: Map<string, THREE.InstancedMesh> = new Map();

  // Overall model bounding box
  public readonly modelBoundingBox: THREE.Box3 = new THREE.Box3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.materialManager = MaterialManager.getInstance();

    this.rootGroup.name = 'IfcModelRoot';
    this.edgesGroup.name = 'IfcEdgesRoot';

    this.scene.add(this.rootGroup);
    this.scene.add(this.edgesGroup);
  }

  /**
   * Ingests a chunk of tessellated elements streamed from the worker.
   */
  public ingestChunk(elements: TessellatedElementDTO[]): void {
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x27272a, // Graphite technical outline
      linewidth: 1,
      transparent: true,
      opacity: 0.85,
      depthTest: true,
    });

    for (const el of elements) {
      if (!el.positions || el.positions.length === 0) {
        continue;
      }

      const isOpening = el.ifcType === 'IfcOpeningElement' || Boolean(el.isOpeningGeometry);
      if (el.hidden && !isOpening) {
        continue;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(el.positions, 3));

      if (el.normals && el.normals.length === el.positions.length) {
        geometry.setAttribute('normal', new THREE.BufferAttribute(el.normals, 3));
      } else {
        geometry.computeVertexNormals();
      }

      if (el.indices && el.indices.length > 0) {
        geometry.setIndex(new THREE.BufferAttribute(el.indices, 1));
      }

      geometry.computeBoundingBox();

      let mat: THREE.Material;
      if (isOpening) {
        mat = this.materialManager.getOpeningMaterial();
      } else if (el.materialId) {
        mat = this.materialManager.getMaterialById(el.materialId);
      } else {
        mat = this.materialManager.getDefaultClay();
      }

      const mesh = new THREE.Mesh(geometry, mat);
      mesh.name = el.id;
      mesh.userData = {
        id: el.id,
        stepId: el.stepId,
        name: el.name,
        ifcType: el.ifcType,
        predefinedType: el.predefinedType,
        parentId: el.parentId,
        storeyId: el.storeyId,
        psets: el.psets,
        materialId: el.materialId,
        isOpening,
      };

      if (el.transform && el.transform.length === 16) {
        mesh.applyMatrix4(new THREE.Matrix4().fromArray(el.transform));
      }

      this.rootGroup.add(mesh);

      // Create architectural feature edge lines if provided
      let edgesLine: THREE.LineSegments | undefined;
      if (el.edgesBuffer && el.edgesBuffer.length > 0) {
        const edgeGeo = new THREE.BufferGeometry();
        edgeGeo.setAttribute('position', new THREE.BufferAttribute(el.edgesBuffer, 3));
        edgesLine = new THREE.LineSegments(edgeGeo, edgeMaterial);
        edgesLine.name = `edges_${el.id}`;
        if (el.transform && el.transform.length === 16) {
          edgesLine.applyMatrix4(new THREE.Matrix4().fromArray(el.transform));
        }
        this.edgesGroup.add(edgesLine);
      }

      // Update bounding boxes
      const elBox = new THREE.Box3().setFromObject(mesh);
      this.modelBoundingBox.union(elBox);

      const record: RenderedElementRecord = {
        id: el.id,
        stepId: el.stepId,
        name: el.name,
        ifcType: el.ifcType,
        predefinedType: el.predefinedType,
        parentId: el.parentId,
        storeyId: el.storeyId,
        matrixId: el.matrixId,
        psets: el.psets,
        mesh,
        edges: edgesLine,
        box: elBox,
      };

      this.elementMap.set(el.id, record);
      this.stepIdMap.set(el.stepId, el.id);

      // Cache prototype geometry for later instance batching
      if (el.matrixId === el.id) {
        this.prototypeGeometries.set(el.id, geometry);
      }
    }
  }

  /**
   * Ingests a batch of instanced components matching a prototype geometry.
   */
  public ingestInstanceBatch(prototypeId: string, instances: InstanceElementDTO[]): void {
    const protoGeo = this.prototypeGeometries.get(prototypeId);
    if (!protoGeo || instances.length === 0) return;

    const count = instances.length;
    const mat = this.materialManager.getDefaultClay();
    const instancedMesh = new THREE.InstancedMesh(protoGeo, mat, count);
    instancedMesh.name = `instanced_${prototypeId}`;

    const tempMatrix = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const inst = instances[i];
      if (inst.transform && inst.transform.length === 16) {
        tempMatrix.fromArray(inst.transform);
        instancedMesh.setMatrixAt(i, tempMatrix);
      }

      const instBox = new THREE.Box3().copy(protoGeo.boundingBox!).applyMatrix4(tempMatrix);
      this.modelBoundingBox.union(instBox);

      const record: RenderedElementRecord = {
        id: inst.id,
        stepId: 0,
        name: inst.name,
        ifcType: inst.ifcType,
        parentId: inst.parentId,
        storeyId: inst.storeyId,
        matrixId: prototypeId,
        psets: inst.psets,
        mesh: instancedMesh,
        box: instBox,
      };

      this.elementMap.set(inst.id, record);
    }

    instancedMesh.instanceMatrix.needsUpdate = true;
    this.rootGroup.add(instancedMesh);
    this.prototypeMeshes.set(prototypeId, instancedMesh);
  }

  public getElement(id: string): RenderedElementRecord | undefined {
    return this.elementMap.get(id);
  }

  public getElementByStepId(stepId: number): RenderedElementRecord | undefined {
    const id = this.stepIdMap.get(stepId);
    return id ? this.elementMap.get(id) : undefined;
  }

  public getAllElements(): RenderedElementRecord[] {
    return Array.from(this.elementMap.values());
  }

  public clear(): void {
    while (this.rootGroup.children.length > 0) {
      const child = this.rootGroup.children[0] as THREE.Mesh;
      this.rootGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
    }

    while (this.edgesGroup.children.length > 0) {
      const edgeChild = this.edgesGroup.children[0] as THREE.LineSegments;
      this.edgesGroup.remove(edgeChild);
      if (edgeChild.geometry) edgeChild.geometry.dispose();
    }

    this.elementMap.clear();
    this.stepIdMap.clear();
    this.prototypeGeometries.clear();
    this.prototypeMeshes.clear();
    this.modelBoundingBox.makeEmpty();
  }

  public dispose(): void {
    this.clear();
    this.scene.remove(this.rootGroup);
    this.scene.remove(this.edgesGroup);
  }
}
