# Performance & Benchmarks — Croquera IFC Viewer vs. IFCLite

This document provides a comprehensive, reproducible benchmark comparing the performance profile of **`croquera-ifc-viewer`** (`@croquera/ifc-core`) against **`ifclite`** (`@ifc-lite/parser` v9.6.0 and `@ifc-lite/geometry` v7.9.0 Rust/WASM) across models ranging from micro components (30 KB) to gigabyte-scale infrastructure (925 MB).

---

## Executive Summary & Core Thesis

> **Core Thesis:** **Croquera prioritizes early model availability and interactive responsiveness; IFCLite delivers higher raw throughput in pure geometric computation.**
>
> In an interactive 3D web viewer, the defining user experience metric is not when the very last background primitive finishes calculating, but how quickly the user can begin inspecting, orienting, and orbiting the building envelope.

- **Early Interactive Availability (< 3.2 s on 1 GB):** Croquera extracts project-wide bounding boxes (AABB) and spatial references in **2 ms to 470 ms**. Even on a 924 MB highway model, the camera is positioned and the viewport is interactive in **3.1 seconds**, while geometry batches stream in progressively.
- **22x–24x Faster STEP Parsing & Ingestion on Giant Models:** On datasets with over 10 to 16 million records (`model_6_arc.ifc` and `VespucioNorte.ifc`), Croquera's `ChunkedStreamScanner` indexes the complete file in **1.5 to 2.7 seconds**, compared to **38 to 60 seconds** required by traditional parsers.
- **Pure Geometric Computation:** Compiled native engines (such as IFCLite's Rust/WASM kernel) execute pure mesh tessellation **1.5x to 3.2x faster** once parsed (17.3 s vs 55.6 s on 536 MB; 116.3 s vs 178.8 s on 925 MB).
- **Fault-Tolerant Geometry Extraction:** Croquera reliably processes orphan components or direct BIM exports that lack explicit `IfcBuildingStorey` spatial containers, where other engines fail to emit geometry.

---

## Test Environment & Conditions

- **Operating System:** Windows 11 (64-bit)
- **Runtime:** Node.js v24.19.0 / V8 64-bit
- **Memory Allocation:** Node `--max-old-space-size=8192` (8 GB heap)
- **Engine Packages:**
  - `@croquera/ifc-core` v0.1.0 (`ChunkedStreamScanner`, `IfcStepImporter`, `OpeningVoidSolver`)
  - `@ifc-lite/parser` v9.6.0 (`parseModel`)
  - `@ifc-lite/geometry` v7.9.0 (`GeometryProcessor`, WASM single-thread streaming)

---

## Comprehensive Benchmark Results

The following table presents measurements across 7 distinct real-world datasets:

| Model | File Size | Entities | Engine | STEP Scan / Parse | Bounding Box / Spatial | Full Tessellation | Total Pipeline Time | Geometry Output *(See Notes)* |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`Ventana_A.ifc`**<br>*(Isolated Window)* | 0.03 MB | 119 | **Croquera**<br>IFCLite | **4 ms**<br>22 ms | **6 ms**<br>N/A | **4 ms**<br>62 ms | **13 ms** (6.5x faster)<br>84 ms | **6 products**<br>0 meshes *(refused)* |
| **`new_bend_2024.ifc`**<br>*(Curved Profile)* | 1.10 MB | 2,840 | **Croquera**<br>IFCLite | **12 ms**<br>82 ms | **2 ms**<br>N/A | 142 ms<br>**63 ms** | **155 ms**<br>**145 ms** | **24 products**<br>19 meshes |
| **`EmergenciaNorte_Base.ifc`**<br>*(Multi-Storey Hospital)* | 4.81 MB | 80,397 | **Croquera**<br>IFCLite | **25 ms** (12x faster)<br>302 ms | **54 ms**<br>N/A | 1,560 ms<br>1,184 ms | **1,639 ms**<br>**1,486 ms** | **1,456 products**<br>1,306 meshes |
| **`Luminarias_Original.ifc`**<br>*(MEP Lighting Array)* | 5.75 MB | 91,204 | **Croquera**<br>IFCLite | **35 ms** (11.7x faster)<br>410 ms | **3 ms**<br>N/A | 319 ms<br>**96 ms** | **358 ms** (1.4x faster)<br>506 ms | **168 products**<br>144 meshes |
| **`proyecto_croquera.ifc`**<br>*(Direct BIM Export)* | 7.49 MB | 142,100 | **Croquera**<br>IFCLite | **13 ms** (4.1x faster)<br>53 ms | **17 ms**<br>N/A | **0 ms**<br>32 ms | **31 ms** (2.7x faster)<br>85 ms | **2 products**<br>0 meshes *(refused)* |
| **`model_6_arc.ifc`**<br>*(High-Rise Complex)* | 535.8 MB | 10,906,295 | **Croquera**<br>IFCLite | **1,567 ms** (24.2x faster)<br>37,973 ms | **76 ms**<br>N/A | 55,597 ms<br>**17,284 ms** | **57.2 s**<br>**55.2 s** | **2,641 products**<br>2,007 meshes |
| **`VespucioNorte.ifc`**<br>*(Civil Highway Corridor)* | 924.6 MB | 16,786,443 | **Croquera**<br>IFCLite | **2,705 ms** (22.1x faster)<br>59,926 ms | **470 ms**<br>N/A | 178,777 ms<br>**116,314 ms** | **181.9 s (3.0 min)**<br>**176.2 s (2.9 min)** | **499 products**<br>199,992 meshes |

---

## Metric Definitions: Products vs. Meshes

The output counts in the table above reflect the fundamental architectural differences between the two engines:

1. **Croquera (`Products`):**
   - Reports high-level consolidated semantic entities (`IfcProduct`, such as `IfcWall`, `IfcSlab`, `IfcDoor`, `IfcBridge`, etc.).
   - Each product consolidates its geometry into unified vertex, normal, index, and material buffers for batch GPU dispatch.
   - In `VespucioNorte.ifc`, 499 civil infrastructure products were identified, parsed, and tessellated.

2. **IFCLite (`Meshes`):**
   - Reports granular `MeshData` primitive fragments emitted per batch to the GPU.
   - In `VespucioNorte.ifc`, the highway surfaces were partitioned into 199,992 individual mesh primitive fragments across streaming batches.

3. **Spatial Hierarchy Tolerance:**
   - In `Ventana_A.ifc` and `proyecto_croquera.ifc`, IFCLite emitted 0 meshes with warnings (`[SpatialHierarchyBuilder] No storeys found in spatial hierarchy`). IFCLite requires standard `IfcBuildingStorey` spatial containers to trigger its geometry pipeline.
   - Croquera processes and renders valid B-Rep and CSG geometries regardless of whether spatial container hierarchies are present.

---

## Architectural Deep Dive

### 1. Ingestion Throughput & Flat Structure-of-Arrays (SoA)
Traditional STEP parsers allocate dynamic objects or hash tables per entity. In models with 10M–17M entities, JavaScript heap allocation limits (2^24 map size limit, string length limits) cause severe garbage collection pauses or outright process crashes.

`croquera-ifc-viewer` solves this with a zero-copy Structure-of-Arrays (`ChunkedStreamScanner`):
- 10 bytes per entity in contiguous `Uint32Array`, `Uint16Array`, and `Int32Array`.
- Forward linked-list indexing per IFC type code.
- Dynamic sparse page tables for discontinuous entity IDs.

This enables scanning and indexing **6.2 million entities per second**, achieving a **22x to 24x speedup** over traditional WebAssembly tokenizers.

### 2. Time-to-First-Frame (TTFF)
Users judge viewer responsiveness by how quickly the model appears on screen:
- **Croquera 3-Stage Pipeline:**
  1. `STAGE_BOUNDS_AABB` (< 100 ms average, 470 ms on 925 MB): The camera immediately frames the building envelope.
  2. `STAGE_GEOMETRY_CHUNK`: Geometry batches stream directly into GPU memory with progressive progress updates.
  3. `STAGE_INSTANCE_BATCH`: Instanced repetitions are drawn via `THREE.InstancedMesh`.
- **Monolithic Parsers:**
  Require completing the full entity parsing pass before yielding spatial coordinates, forcing the user to wait up to 60 seconds before seeing any visual feedback.

### 3. Early Interactive Availability vs. Pure Geometric Throughput
- **Geometric Computation:** In pure mesh calculation, IFCLite's Rust/WASM kernel exhibits higher raw tessellation throughput (1.5x to 3.2x faster than Croquera's TypeScript kernel on massive datasets).
- **Interactive UX Priority:** For a web viewer, waiting up to a minute before anything appears on screen creates significant friction. Croquera prioritizes early availability: by projecting the building envelope (AABB) in 76 ms to 470 ms and streaming geometry progressively, the user can start inspecting, orbiting, and querying BIM data almost immediately.

---

## Reproducing the Benchmark

The repository includes a dedicated benchmark CLI to reproduce these measurements:

```bash
# Clone the repository
git clone https://github.com/matiasmlynarz-lang/croquera-ifc-viewer.git
cd croquera-ifc-viewer

# Install dependencies
npm install

# Run benchmark on a specific IFC model
npm run benchmark -- "path/to/model.ifc"

# Run benchmark with expanded heap for massive files (> 500 MB)
npm run benchmark:large -- "path/to/model.ifc"
```
