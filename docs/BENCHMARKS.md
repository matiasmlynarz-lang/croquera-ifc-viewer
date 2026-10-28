# Performance & Benchmarks — Croquera IFC Core vs. IFCLite (Motor medido en Node.js)

This document provides the benchmark methodology and comparative performance analysis of **`@croquera/ifc-core`** against **`ifclite`** (`@ifc-lite/parser` v1.9.10 and `@ifc-lite/geometry` v1.9.10 Rust/WASM) across a 12-model engineering benchmark suite ranging from hospital facilities (4.81 MB) to civil infrastructure (924.65 MB).

> **Important Scope Notice (Engine Measured in Node.js):** All timings in this document measure the **core parsing and geometry engines running headlessly in Node.js v24 (V8 CLI)**, not in-browser rendering. Browser execution adds WebGL buffer uploads, shader compilation, and Web Worker message transfer overhead.

---

## Executive Summary & Core Thesis

> **Core Thesis:** **Croquera's primary structural advantage lies in STEP ingestion (7.6x–22.7x faster) and early bounding-box availability, whereas pure geometric tessellation is closely contested between both engines.**

1. **Where Croquera Leads Decisively — STEP Ingestion (`7.6x` to `22.7x` faster):**
   - Croquera's `ChunkedStreamScanner` indexes 5M to 16.8M STEP entities in **0.88 s to 3.80 s**, compared to **20.0 s to 62.5 s** in IFCLite.
   - Because STEP parsing is a sequential prerequisite, this ingestion gap gives Croquera a lower total end-to-end time across all 12 models (**1.15x to 5.03x** total pipeline advantage), even on models where IFCLite is faster during the geometry stage.

2. **Where the Engines Trade Leads — Pure Geometric Tessellation:**
   - **IFCLite (Rust/WASM) wins pure tessellation in 3 of the 12 models** (`model_4_arc.ifc`: **4,676 ms** vs 7,150 ms; `LTU_A-House_redesign.ifc`: **27,730 ms** vs 29,616 ms; `model_6_arc.ifc`: **19,321 ms** vs 32,801 ms). On these architectural models with heavy CSG wall/slab opening subtractions, IFCLite's compiled Rust/WASM kernel executes pure mesh generation **1.07x to 1.70x faster**. In `model_4_arc.ifc`, Croquera's 1.15x end-to-end edge (7.49 s vs 8.60 s) comes entirely from its 3.7 s lead in STEP ingestion.
   - **Croquera wins pure tessellation in 9 of the 12 models**, primarily when models make heavy use of `IfcRepresentationMap` instancing (`model_3_arc.ifc`, `model_8_arc.ifc`), faceted B-Reps, or large civil surface meshes (`Pasarela.ifc`: **43.8 s** vs 180.9 s).

3. **Important Caveat on Triangle Count Parity (`LTU_A-House_Plumbing.ifc`):**
   - On 11 of the 12 models, both engines produce comparable triangle counts (typically within 0.1%–15% depending on opening tessellation and crease policies).
   - **Exception — `LTU_A-House_Plumbing.ifc` (4.65M vs 12.30M triangles):** Croquera uses a coarser radial discretization for small-radius piping in `DirectCylinderGenerator`, emitting **4,653,280 triangles** compared to IFCLite's **12,295,200 triangles** (2.64x fewer triangles). Therefore, a substantial portion of Croquera's faster tessellation time on `LTU_A-House_Plumbing.ifc` (15.1 s vs 20.1 s) is directly attributable to generating less geometry rather than raw per-triangle throughput.

4. **Early Camera Framing (AABB Pre-Pass vs. Camera Ready):**
   - **AABB Pre-Pass Calculation:** `41 ms` to `2,635 ms` across the 12 models (`767 ms` on the 924.65 MB `Pasarela.ifc`).
   - **Camera Ready (`STEP Ingestion + AABB Pre-Pass`):** `103 ms` to `4,567 ms` (`4.57 s` on `Pasarela.ifc`).

---

## Test Environment & Conditions

- **Execution Mode:** Isolated headless engine benchmark in **Node.js v24.19.0 / V8 64-bit** (no browser DOM/WebGL).
- **Operating System:** Windows 11 (64-bit)
- **Memory Allocation:** Node `--max-old-space-size=8192` (8 GB heap)
- **Engine Packages:**
  - `@croquera/ifc-core` v0.1.0 (`ChunkedStreamScanner`, `IfcStepImporter`, `StaticProfileTemplates`, `DirectCylinderGenerator`, `OpeningVoidSolver`)
  - `@ifc-lite/parser` v1.9.10 (`IfcParser.parseColumnar`)
  - `@ifc-lite/geometry` v1.9.10 (`GeometryProcessor.processStreaming`, WASM streaming)

---

## Comprehensive 12-Model Benchmark Results (Node.js v24 CLI)

The following table presents measurements across all 12 benchmark datasets. **Bold** values indicate the faster engine in each specific stage (`STEP`, `Geom`, and `Total`):

| Model | File Size | Entities | Croq STEP | Lite STEP | Croq AABB *(Camera Ready)* | Croq Geom | Lite Geom | **Croq Total** | **Lite Total** | Total Ratio | Triangles (Croq / Lite) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`Emerg.ifc`**<br>*(Hospital Facility)* | 4.81 MB | 80,397 | **35 ms** | 266 ms | 97 ms<br>*(132 ms)* | **869 ms** | 1,310 ms | **1,001 ms** | 1,576 ms | 1.57x (Croq) | 76,713 / 92,061 |
| **`LTU_A-House_Ducting.ifc`**<br>*(MEP HVAC Ducting)* | 7.99 MB | 163,551 | **41 ms** | 714 ms | 116 ms<br>*(157 ms)* | **1,109 ms** | 1,517 ms | **1,267 ms** | 2,231 ms | 1.76x (Croq) | 672,854 / 673,502 |
| **`model_3_arc.ifc`**<br>*(Residential Architecture)* | 13.16 MB | 235,367 | **81 ms** | 988 ms | 154 ms<br>*(235 ms)* | **1,421 ms** | 1,968 ms | **1,656 ms** | 2,957 ms | 1.79x (Croq) | 737,514 / 752,873 |
| **`model_8_arc.ifc`**<br>*(Multi-Family Building)* | 21.04 MB | 213,610 | **62 ms** | 814 ms | 41 ms<br>*(103 ms)* | **1,540 ms** | 3,110 ms | **1,643 ms** | 3,924 ms | 2.39x (Croq) | 1,716,636 / 1,718,941 |
| **`LTU_A-House_Sanitation.ifc`**<br>*(MEP Sanitation)* | 25.72 MB | 502,564 | **97 ms** | 1,888 ms | 434 ms<br>*(531 ms)* | **2,506 ms** | 3,197 ms | **3,037 ms** | 5,085 ms | 1.67x (Croq) | 1,357,576 / 1,368,070 |
| **`LTU_A-House_K-modell.ifc`**<br>*(Structural Precast)* | 30.90 MB | 481,125 | **122 ms** | 2,332 ms | 352 ms<br>*(474 ms)* | **5,567 ms** | 10,984 ms | **6,042 ms** | 13,316 ms | 2.20x (Croq) | 542,493 / 703,199 |
| **`model_4_arc.ifc`**<br>*(Commercial Complex)* | 49.91 MB | 1,048,361 | **210 ms** | 3,923 ms | 129 ms<br>*(339 ms)* | 7,150 ms | **4,676 ms** | **7,488 ms** | 8,600 ms | 1.15x (Croq)¹ | 703,873 / 753,294 |
| **`LTU_A-House_Plumbing.ifc`**<br>*(MEP High-Density Piping)* | 69.59 MB | 1,291,216 | **365 ms** | 7,782 ms | 2,635 ms<br>*(3,000 ms)* | **15,134 ms**² | 20,139 ms | **18,134 ms** | 27,921 ms | 1.54x (Croq)² | 4,653,280 / 12,295,200² |
| **`LTU_A-House_redesign.ifc`**<br>*(Full Architectural Redesign)* | 172.91 MB | 3,359,234 | **770 ms** | 13,029 ms | 921 ms<br>*(1,691 ms)* | 29,616 ms | **27,730 ms** | **31,307 ms** | 40,759 ms | 1.30x (Croq)¹ | 2,136,879 / 2,515,414 |
| **`NVW_DCR-LOD300_Arch.ifc`**<br>*(LOD300 Institutional)* | 274.78 MB | 5,276,285 | **881 ms** | 19,958 ms | 390 ms<br>*(1,271 ms)* | **38,471 ms** | 46,348 ms | **39,742 ms** | 66,305 ms | 1.67x (Croq) | 1,474,591 / 1,338,709 |
| **`model_6_arc.ifc`**<br>*(High-Rise Complex)* | 535.81 MB | 10,906,295 | **2,193 ms** | 41,169 ms | 93 ms<br>*(2,286 ms)* | 32,801 ms | **19,321 ms** | **35,087 ms** | 60,490 ms | 1.72x (Croq)¹ | 3,482,705 / 3,500,008 |
| **`Pasarela.ifc`**<br>*(Civil Infrastructure)* | 924.65 MB | 16,786,443 | **3,800 ms** | 62,459 ms | 767 ms<br>*(4,567 ms)* | **43,824 ms** | 180,893 ms | **48,391 ms** | 243,352 ms | 5.03x (Croq) | 7,509,036 / 7,498,598 |

*¹ In `model_4_arc.ifc`, `LTU_A-House_redesign.ifc`, and `model_6_arc.ifc`, IFCLite's Rust/WASM kernel is faster in pure geometry tessellation (`Lite Geom` < `Croq Geom`); Croquera wins total end-to-end time due to its faster STEP ingestion stage.*  
*² In `LTU_A-House_Plumbing.ifc`, Croquera uses lower radial cylinder subdivision for small-diameter pipes (`4.65M` vs `12.30M` triangles); triangle counts are not directly comparable on this model.*

---

## Metric Definitions & Methodological Caveats

1. **Consolidated Products vs. Mesh Fragments:**
   - **Croquera (`Consolidated Products`):** Reports semantic BIM entities (`IfcProduct`), preserving up to 16 discrete material sub-meshes per product (`consolidateSubMeshes`) and extracting dihedral crease feature edges (`edgesBuffer`).
   - **IFCLite (`Mesh Fragments`):** Reports granular `MeshData` primitive fragments emitted per streaming batch without crease-edge buffers.

2. **AABB Pre-Pass vs. Camera Ready Time:**
   - **AABB Pre-Pass (`Croq AABB`):** Time spent purely scanning placement chains and bounding boxes (`41 ms` to `2,635 ms`).
   - **Camera Ready (`STEP + AABB`):** Cumulative time from buffer arrival until the 3D camera can frame the building envelope (`103 ms` to `4,567 ms`).

3. **Cylinder Discretization in Piping (`LTU_A-House_Plumbing.ifc`):**
   - `DirectCylinderGenerator` adapts radial segment counts based on pipe radius, resulting in **4.65M triangles** vs **12.30M triangles** in IFCLite. While visually appropriate for thin pipes at building scale, the workload is 2.64x smaller in vertex/index count, which explains part of the time difference on that specific file.

---

## Architectural Deep Dive

### 1. Ingestion Throughput & Flat Structure-of-Arrays (SoA)
Traditional STEP parsers allocate dynamic objects or hash tables per entity. In models with 10M–17M entities, heap allocation limits cause severe garbage collection pauses or out-of-memory crashes.

`croquera-ifc-viewer` solves this with a zero-copy Structure-of-Arrays (`ChunkedStreamScanner`):
- 10 bytes per entity in contiguous `Uint32Array`, `Uint16Array`, and `Int32Array`.
- Forward linked-list indexing per IFC type code.
- Dynamic sparse page tables for discontinuous entity IDs.

This enables scanning and indexing **4.4 to 6.0 million entities per second**, achieving up to a **22.7x speedup** over IFCLite's parser.

### 2. Direct TypedArray Compilation & `IfcRepresentationMap` Caching
Instead of allocating intermediate object-oriented `PolyMesh` / `Vector3` structures for every face and vertex, `@croquera/ifc-core` compiles IFC representations directly into flat `DirectMeshBuffers` (`positions`, `normals`, `indices`, `edgesBuffer`):
- **Single-Sided Outward CCW Winding:** Parametric templates (`StaticProfileTemplates.generateBox` and `generatePrismFromPolygon2D`) guarantee exact outward normals ($\vec{n}_{\text{geom}} \cdot \vec{n}_{\text{vertex}} = +1$) for both positive and negative extrusion depths (`dz < 0`), enabling `THREE.FrontSide` rendering without `DoubleSide` GPU fill-rate penalties.
- **Material-Partitioned Faceted B-Rep Compiler (`buildDirectFacetedPartitions`):** Directly compiles `IfcFacetedBrep`, `IfcFaceBasedSurfaceModel`, `IfcShellBasedSurfaceModel`, `IfcPolygonalFaceSet`, and `IfcTriangulatedFaceSet` partitioned by `IfcStyledItem` precedence (`faceToStyleMap` $>$ `itemToStyleMap`), supporting inner loop holes (`IfcFaceInnerBound` via `PolygonClipping.triangulateWithHoles`), `Orientation = .F.` loop reversal, and $O(E)$ welded-vertex dihedral crease extraction.
- **`IfcRepresentationMap` Prototype Cache (`mappedRepDirectCache`):** Shared representation maps (doors, windows, furniture, structural plates, MEP fittings) are tessellated once in representation space and transformed in-place via `applyIfcTransformInPlace` with determinant reflection compensation ($\det(M) < 0$).

### 3. Time-to-First-Frame (TTFF)
- **Croquera 3-Stage Pipeline:**
  1. `STAGE_BOUNDS_AABB` (41 ms to 2.6 s): The camera immediately frames the project envelope.
  2. `STAGE_GEOMETRY_CHUNK`: Geometry batches stream directly into GPU memory with progressive updates.
  3. `STAGE_INSTANCE_BATCH`: Instanced repetitions are drawn via `THREE.InstancedMesh` and `THREE.BatchedMesh`.

---

## Documented Methodology & Benchmark Harness

To verify the methodology and execute comparative benchmarks on local IFC models, run the standalone CLI harness:

```bash
# Clone the repository
git clone https://github.com/matiasmlynarz-lang/croquera-ifc-viewer.git
cd croquera-ifc-viewer

# Install dependencies
npm install

# Run benchmark on a single IFC model or an entire folder of IFC models
npx --node-options="--max-old-space-size=8192" tsx ./scripts/benchmark.ts "path/to/ModelosBenchmark"
```
