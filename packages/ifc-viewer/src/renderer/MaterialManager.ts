/**
 * MaterialManager — High-performance material manager for technical architectural visualization.
 *
 * Provides:
 * - Default soft clay architectural material (matte chalk / off-white).
 * - Dynamic PBR material palette derived from IFC SurfaceStyles.
 * - Technical selection and hover highlight materials.
 */

import * as THREE from 'three';
import type { MaterialRecord } from '@croquera/ifc-core';

export class MaterialManager {
  private static instance: MaterialManager | null = null;
  private materialCache: Map<string, THREE.Material> = new Map();
  private materialRecordsMap: Map<string, MaterialRecord> = new Map();

  // Clay base architectural material
  private readonly defaultClayMaterial: THREE.MeshStandardMaterial;

  // Opening translucent material (subtle cyan/sky volume)
  private readonly openingMaterial: THREE.MeshStandardMaterial;

  // Selection highlight material (Croquera technical blue #2563EB)
  private readonly selectionMaterial: THREE.MeshStandardMaterial;

  // Hover highlight material (semi-transparent light blue)
  private readonly hoverMaterial: THREE.MeshStandardMaterial;

  constructor() {
    this.defaultClayMaterial = new THREE.MeshStandardMaterial({
      color: 0xf5f6f8,
      roughness: 0.85,
      metalness: 0.05,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    this.openingMaterial = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      roughness: 0.5,
      metalness: 0.1,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.selectionMaterial = new THREE.MeshStandardMaterial({
      color: 0x2563eb,
      roughness: 0.3,
      metalness: 0.2,
      emissive: 0x1d4ed8,
      emissiveIntensity: 0.2,
      side: THREE.FrontSide,
    });

    this.hoverMaterial = new THREE.MeshStandardMaterial({
      color: 0x60a5fa,
      roughness: 0.4,
      metalness: 0.1,
      transparent: true,
      opacity: 0.8,
      side: THREE.FrontSide,
    });
  }

  public static getInstance(): MaterialManager {
    if (!MaterialManager.instance) {
      MaterialManager.instance = new MaterialManager();
    }
    return MaterialManager.instance;
  }

  public registerMaterials(materials: MaterialRecord[]): void {
    for (const m of materials) {
      if (m.id) {
        this.materialRecordsMap.set(m.id, m);
        this.getOrCreateMaterial(m);
      }
    }
  }

  public getDefaultClay(): THREE.MeshStandardMaterial {
    return this.defaultClayMaterial;
  }

  public getOpeningMaterial(): THREE.MeshStandardMaterial {
    return this.openingMaterial;
  }

  public getSelectionMaterial(): THREE.MeshStandardMaterial {
    return this.selectionMaterial;
  }

  public getHoverMaterial(): THREE.MeshStandardMaterial {
    return this.hoverMaterial;
  }

  private parseIfcMaterialId(materialId: string): MaterialRecord | null {
    const match = /^mat_ifc_([0-9a-fA-F]{6})(?:_a(\d+))?$/i.exec(materialId);
    if (!match) return null;
    const hex = match[1];
    const opacity = match[2] !== undefined ? Math.max(0, Math.min(1, parseInt(match[2], 10) / 100)) : 1.0;
    const baseColor = `#${hex.toLowerCase()}`;
    const isTransparent = opacity < 0.999;
    const rec: MaterialRecord = {
      id: materialId,
      name: `IFC Style #${hex}`,
      baseColor,
      colorHex: baseColor,
      roughness: 0.7,
      metalness: 0.1,
      opacity,
      transparent: isTransparent,
    };
    return rec;
  }

  public getMaterialById(materialId?: string | null): THREE.Material {
    if (!materialId) return this.defaultClayMaterial;
    const cached = this.materialCache.get(materialId);
    if (cached) return cached;

    let record = this.materialRecordsMap.get(materialId);
    if (!record && materialId.startsWith('mat_ifc_')) {
      record = this.parseIfcMaterialId(materialId) || undefined;
      if (record) {
        this.materialRecordsMap.set(materialId, record);
      }
    }
    if (record) {
      return this.getOrCreateMaterial(record);
    }
    return this.defaultClayMaterial;
  }

  /**
   * Resolves a normalized visual material key for GPU draw-call and BatchedMesh pooling.
   * Guarantees that materials with identical visual properties (color, opacity, roughness, metalness)
   * share the exact same GPU bucket without fragmentation.
   */
  public getMaterialKey(materialId?: string | null): string {
    if (!materialId) return 'default_clay';
    let record = this.materialRecordsMap.get(materialId);
    if (!record && materialId.startsWith('mat_ifc_')) {
      record = this.parseIfcMaterialId(materialId) || undefined;
      if (record) {
        this.materialRecordsMap.set(materialId, record);
      }
    }
    if (!record) return materialId;
    if (record.textureBlob) return record.id;
    const color = (record.baseColor || record.colorHex || '#f5f6f8').toUpperCase();
    const opacity = record.opacity !== undefined ? Math.round(record.opacity * 100) : 100;
    const roughness = record.roughness !== undefined ? Math.round(record.roughness * 100) : 70;
    const metalness = record.metalness !== undefined ? Math.round(record.metalness * 100) : 10;
    return `${color}_o${opacity}_r${roughness}_m${metalness}`;
  }

  public getOrCreateMaterial(record?: MaterialRecord | null): THREE.Material {
    if (!record) {
      return this.defaultClayMaterial;
    }

    const key = this.getMaterialKey(record.id);
    const cached = this.materialCache.get(key);
    if (cached) return cached;

    const color = new THREE.Color(record.baseColor || record.colorHex || '#f5f6f8');
    const opacity = record.opacity !== undefined ? record.opacity : 1.0;
    const isTransparent = opacity < 0.999 || Boolean(record.transparent);

    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: record.roughness !== undefined ? record.roughness : 0.7,
      metalness: record.metalness !== undefined ? record.metalness : 0.1,
      transparent: isTransparent,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: !isTransparent,
      polygonOffset: !isTransparent,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    this.materialCache.set(key, mat);
    if (record.id && record.id !== key) {
      this.materialCache.set(record.id, mat);
    }
    return mat;
  }

  public getMaterialName(materialId?: string | null): string | null {
    if (!materialId) return null;
    const rec = this.materialRecordsMap.get(materialId);
    return rec?.name || null;
  }

  public dispose(): void {
    this.defaultClayMaterial.dispose();
    this.selectionMaterial.dispose();
    this.hoverMaterial.dispose();
    for (const mat of this.materialCache.values()) {
      mat.dispose();
    }
    this.materialCache.clear();
  }
}
