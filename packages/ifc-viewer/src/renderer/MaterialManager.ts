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
      side: THREE.FrontSide,
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

  public getMaterialById(materialId?: string | null): THREE.Material {
    if (!materialId) return this.defaultClayMaterial;
    const cached = this.materialCache.get(materialId);
    if (cached) return cached;

    const record = this.materialRecordsMap.get(materialId);
    if (record) {
      return this.getOrCreateMaterial(record);
    }
    return this.defaultClayMaterial;
  }

  public getOrCreateMaterial(record?: MaterialRecord | null): THREE.Material {
    if (!record) {
      return this.defaultClayMaterial;
    }

    const key = record.id || record.baseColor || 'default';
    const cached = this.materialCache.get(key);
    if (cached) return cached;

    const color = new THREE.Color(record.baseColor || record.colorHex || '#f5f6f8');
    const opacity = record.opacity !== undefined ? record.opacity : 1.0;
    const isTransparent = opacity < 0.99 || Boolean(record.transparent);

    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: record.roughness !== undefined ? record.roughness : 0.7,
      metalness: record.metalness !== undefined ? record.metalness : 0.1,
      transparent: isTransparent,
      opacity,
      side: isTransparent ? THREE.DoubleSide : THREE.FrontSide,
      depthWrite: !isTransparent,
    });

    this.materialCache.set(key, mat);
    return mat;
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
