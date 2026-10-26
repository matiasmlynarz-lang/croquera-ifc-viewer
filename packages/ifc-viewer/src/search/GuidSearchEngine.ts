/**
 * GuidSearchEngine — Fast in-memory indexer for GUID, UUID, STEP ID, and metadata queries.
 *
 * Implements O(1) indexed lookups using pre-populated hash maps for IFC GUIDs,
 * RFC 4122 UUIDs, and numeric STEP record IDs.
 */

import { GuidUtils } from '@croquera/ifc-core';
import type { BatchedMeshPool, RenderedElementRecord, GroupMetadataRecord } from '../renderer/BatchedMeshPool';

export interface SearchMatch {
  id: string;
  ifcGuid: string;
  uuid: string;
  name: string;
  ifcType: string;
  stepId: number;
  storeyId: string | null;
  record: RenderedElementRecord;
}

type IndexableItem = RenderedElementRecord | GroupMetadataRecord;

export class GuidSearchEngine {
  private readonly meshPool: BatchedMeshPool;

  // Inverted indexes for O(1) lookups
  private readonly guidMap: Map<string, IndexableItem> = new Map();
  private readonly stepIdMap: Map<number, IndexableItem> = new Map();
  private readonly namePrefixMap: Map<string, Set<IndexableItem>> = new Map();
  private isIndexDirty: boolean = true;
  private lastIndexedCount: number = -1;

  constructor(meshPool: BatchedMeshPool) {
    this.meshPool = meshPool;
  }

  /**
   * Rebuilds the O(1) inverted indices from the current mesh pool elements and groups.
   */
  public rebuildIndex(): void {
    this.guidMap.clear();
    this.stepIdMap.clear();
    this.namePrefixMap.clear();

    // 1. Index all canonical group products first (Rule 15).
    // Ensures prefix sets and inverted index lookups prioritize the canonical product.
    const groups = this.meshPool.getAllGroups();
    for (const grp of groups) {
      this.indexItem(grp);
    }

    // 2. Index all rendered geometry elements
    const elements = this.meshPool.getAllElements();
    for (const el of elements) {
      this.indexItem(el);
    }

    this.lastIndexedCount = elements.length + groups.length;
    this.isIndexDirty = false;
  }

  /**
   * Marks the index as dirty, triggering auto-rebuild on next search query.
   */
  public markDirty(): void {
    this.isIndexDirty = true;
  }

  /**
   * Incrementally indexes a newly ingested element or group.
   */
  public indexItem(item: IndexableItem): void {
    const rawId = item.id.toLowerCase();
    this.guidMap.set(rawId, item);

    try {
      if (GuidUtils.isIfcGuid(item.id)) {
        const uuid = GuidUtils.ifcGuidToUuid(item.id).toLowerCase();
        this.guidMap.set(uuid, item);
      } else {
        const ifcGuid = GuidUtils.uuidToIfcGuid(item.id).toLowerCase();
        this.guidMap.set(ifcGuid, item);
      }
    } catch {
      // Keep raw id mapping
    }

    if (item.stepId > 0) {
      this.stepIdMap.set(item.stepId, item);
    }

    // Populate prefix index for fast autocompletion (tokens of name, ifcType)
    const tokens = `${item.name} ${item.ifcType}`.toLowerCase().split(/[\s_-]+/);
    for (const token of tokens) {
      if (token.length < 2) continue;
      const maxLen = Math.min(token.length, 10);
      for (let len = 2; len <= maxLen; len++) {
        const prefix = token.slice(0, len);
        let set = this.namePrefixMap.get(prefix);
        if (!set) {
          set = new Set();
          this.namePrefixMap.set(prefix, set);
        }
        if (set.size < 50) {
          set.add(item);
        }
      }
    }
  }

  public indexElement(el: RenderedElementRecord): void {
    this.indexItem(el);
  }

  public indexGroup(grp: GroupMetadataRecord): void {
    this.indexItem(grp);
  }

  /**
   * Searches the loaded model for matching GUIDs, names, or IFC types.
   * Resolves exact STEP IDs and GUIDs in O(1).
   */
  public search(query: string, maxResults = 20): SearchMatch[] {
    const clean = query.trim();
    if (!clean) return [];

    const totalCount = this.meshPool.getAllElements().length + this.meshPool.getAllGroups().length;
    if (this.isIndexDirty || totalCount !== this.lastIndexedCount) {
      this.rebuildIndex();
    }

    const lower = clean.toLowerCase();
    const isStepIdSearch = clean.startsWith('#') || /^\d+$/.test(clean);
    const targetStepId = isStepIdSearch ? parseInt(clean.replace('#', ''), 10) : null;

    // 1. O(1) STEP ID exact match
    if (targetStepId !== null) {
      const match = this.stepIdMap.get(targetStepId);
      if (match) {
        return [this.toSearchMatch(match)];
      }
      const directEl = this.meshPool.getElementByStepId(targetStepId);
      if (directEl) {
        return [this.toSearchMatch(directEl)];
      }
    }

    // 2. O(1) Exact GUID / UUID match
    const exactGuidMatch = this.guidMap.get(lower) || this.meshPool.getElement(clean);
    if (exactGuidMatch) {
      return [this.toSearchMatch(exactGuidMatch)];
    }

    // 3. O(1) Prefix index lookup with group deduplication
    const prefixMatches = this.namePrefixMap.get(lower);
    if (prefixMatches && prefixMatches.size > 0) {
      const matches: SearchMatch[] = [];
      const seenGroupOrId = new Set<string>();

      for (const item of prefixMatches) {
        const isGroup = !('mesh' in item);
        const dedupeKey = isGroup ? item.id : ((item as RenderedElementRecord).groupId || item.id);
        if (seenGroupOrId.has(dedupeKey)) continue;
        seenGroupOrId.add(dedupeKey);

        matches.push(this.toSearchMatch(item));
        if (matches.length >= maxResults) break;
      }
      return matches;
    }

    // 4. Fallback substring search (prioritizing canonical GROUP products)
    const matches: SearchMatch[] = [];
    const seenGroupOrId = new Set<string>();

    const groups = this.meshPool.getAllGroups();
    for (const grp of groups) {
      const matchesNameOrType =
        grp.name.toLowerCase().includes(lower) ||
        grp.ifcType.toLowerCase().includes(lower) ||
        grp.id.toLowerCase().includes(lower);

      if (matchesNameOrType) {
        seenGroupOrId.add(grp.id);
        matches.push(this.toSearchMatch(grp));
        if (matches.length >= maxResults) {
          return matches;
        }
      }
    }

    const elements = this.meshPool.getAllElements();
    for (const el of elements) {
      const dedupeKey = el.groupId || el.id;
      if (seenGroupOrId.has(dedupeKey)) continue;

      const matchesNameOrType =
        el.name.toLowerCase().includes(lower) ||
        el.ifcType.toLowerCase().includes(lower) ||
        el.id.toLowerCase().includes(lower);

      if (matchesNameOrType) {
        seenGroupOrId.add(dedupeKey);
        matches.push(this.toSearchMatch(el));
        if (matches.length >= maxResults) {
          break;
        }
      }
    }

    return matches;
  }

  private toSearchMatch(item: IndexableItem): SearchMatch {
    const isGroup = !('mesh' in item);
    const resolvedRecord = isGroup ? this.meshPool.getElement(item.id) : (item as RenderedElementRecord);

    const canonicalId = isGroup ? item.id : ((item as RenderedElementRecord).groupId || item.id);
    const canonicalName = isGroup ? item.name : ((item as RenderedElementRecord).groupName || item.name);

    let ifcGuid = canonicalId;
    let uuid = canonicalId;

    try {
      if (GuidUtils.isIfcGuid(canonicalId)) {
        uuid = GuidUtils.ifcGuidToUuid(canonicalId);
      } else {
        ifcGuid = GuidUtils.uuidToIfcGuid(canonicalId);
      }
    } catch {
      // Keep raw id
    }

    return {
      id: canonicalId,
      ifcGuid,
      uuid,
      name: canonicalName,
      ifcType: item.ifcType,
      stepId: item.stepId,
      storeyId: item.storeyId,
      record: resolvedRecord!,
    };
  }
}
