# croquera-ifc-viewer

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/Release-v0.1.0-brightgreen.svg)](https://github.com/matiasmlynarz-lang/croquera-ifc-viewer/releases)
[![IFC Standard](https://img.shields.io/badge/IFC_Standard-4.3_%7C_2x3-00557f.svg)](https://technical.buildingsmart.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Three.js](https://img.shields.io/badge/Three.js-0.174-black.svg?logo=threedotjs&logoColor=white)](https://threejs.org/)
[![Web Workers](https://img.shields.io/badge/Web_Workers-Multi--Threaded-6366F1.svg)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
[![Live Demo](https://img.shields.io/badge/Live_Demo-Online-2563EB.svg)](https://www.vivemejor.cl/croquera/viewer/)

> **One of the fastest web-based IFC viewers in the market.**  
> *Uno de los visualizadores IFC en navegador más rápidos del mercado.*

An ultra-performant, 100% client-side, open-source IFC 4.3 viewer designed for instant in-browser loading, zero-copy GPU tessellation, GUID search, and high-precision spatial measurements.

**Live Demo / Demostración en Vivo:**  
[https://www.vivemejor.cl/croquera/viewer/](https://www.vivemejor.cl/croquera/viewer/)

![croquera-ifc-viewer Preview](docs/images/croquera-viewer-preview.png)

---

## English

### Live Demo
Try it directly in your browser with zero installation:  
[https://www.vivemejor.cl/croquera/viewer/](https://www.vivemejor.cl/croquera/viewer/)

### Highlights
- **Lightning Fast Streaming:** Progressive 3-stage loading with instant camera framing (< 500 ms) and zero-copy `ArrayBuffer` transfer to Web Workers.
- **GPU Batching & Instancing:** Employs `THREE.BatchedMesh` and `THREE.InstancedMesh` for 60+ FPS navigation even on multi-million polygon BIM models.
- **Pure Web Standards:** No backend required, 100% private in-browser parsing.
- **Instant GUID Search:** O(1) indexed lookup with automated camera focus.
- **Precision Snapping Measurement:** Point-to-point and edge measurement with BVH-accelerated raycasting.
- **Direct Bridge:** Instant "Edit in Croquera" action to seamlessly open your model in [Croquera.com](https://croquera.com).

### Performance & Benchmarks (Engine Measured in Node.js)

> **Architectural Takeaway:** **Croquera's primary structural advantage is its 7.6x–22.7x faster Structure-of-Arrays STEP ingestion and early AABB bounding-box pass. In pure geometric tessellation, performance is closely contested: Croquera leads on models with heavy `IfcRepresentationMap` reuse and faceted B-Reps (9/12 models), while IFCLite's Rust/WASM kernel is faster in pure mesh generation on 3/12 CSG-heavy architectural models (`model_4_arc`, `LTU_A-House_redesign`, and `model_6_arc`).**

> **Important Scope Notice (Motor medido en Node.js):** All timings below measure the **isolated core engines running headlessly in Node.js v24 (V8 CLI)**, not in-browser rendering. Browser execution adds WebGL GPU uploads and Web Worker transfer overhead.

| Model | File Size | Entities | STEP Ingestion | Croq AABB *(Camera Ready)* | Pure Geometry (`Croq` / `Lite`) | Total End-to-End (`Croq` / `Lite`) | Triangles (`Croq` / `Lite`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`Emerg.ifc`** | 4.81 MB | 80,397 | **35 ms** vs 266 ms | 97 ms *(132 ms)* | **869 ms** / 1,310 ms | **1.00 s** / 1.58 s (1.57x) | 76.7k / 92.1k |
| **`LTU_A-House_Ducting.ifc`** | 7.99 MB | 163,551 | **41 ms** vs 714 ms | 116 ms *(157 ms)* | **1.11 s** / 1.52 s | **1.27 s** / 2.23 s (1.76x) | 672.9k / 673.5k |
| **`model_3_arc.ifc`** | 13.16 MB | 235,367 | **81 ms** vs 988 ms | 154 ms *(235 ms)* | **1.42 s** / 1.97 s | **1.66 s** / 2.96 s (1.79x) | 737.5k / 752.9k |
| **`model_8_arc.ifc`** | 21.04 MB | 213,610 | **62 ms** vs 814 ms | 41 ms *(103 ms)* | **1.54 s** / 3.11 s | **1.64 s** / 3.92 s (2.39x) | 1.72M / 1.72M |
| **`LTU_A-House_Sanitation.ifc`** | 25.72 MB | 502,564 | **97 ms** vs 1.89 s | 434 ms *(531 ms)* | **2.51 s** / 3.20 s | **3.04 s** / 5.09 s (1.67x) | 1.36M / 1.37M |
| **`LTU_A-House_K-modell.ifc`** | 30.90 MB | 481,125 | **122 ms** vs 2.33 s | 352 ms *(474 ms)* | **5.57 s** / 10.98 s | **6.04 s** / 13.32 s (2.20x) | 542.5k / 703.2k |
| **`model_4_arc.ifc`**¹ | 49.91 MB | 1,048,361 | **210 ms** vs 3.92 s | 129 ms *(339 ms)* | 7.15 s / **4.68 s** | **7.49 s** / 8.60 s (1.15x)¹ | 703.9k / 753.3k |
| **`LTU_A-House_Plumbing.ifc`**² | 69.59 MB | 1,291,216 | **365 ms** vs 7.78 s | 2.64 s *(3.00 s)* | **15.13 s** / 20.14 s² | **18.13 s** / 27.92 s (1.54x)² | 4.65M / 12.30M² |
| **`LTU_A-House_redesign.ifc`**¹ | 172.91 MB | 3,359,234 | **770 ms** vs 13.03 s | 921 ms *(1.69 s)* | 29.62 s / **27.73 s** | **31.31 s** / 40.76 s (1.30x)¹ | 2.14M / 2.52M |
| **`NVW_DCR-LOD300_Arch.ifc`** | 274.78 MB | 5,276,285 | **881 ms** vs 19.96 s | 390 ms *(1.27 s)* | **38.47 s** / 46.35 s | **39.74 s** / 66.31 s (1.67x) | 1.47M / 1.34M |
| **`model_6_arc.ifc`**¹ | 535.81 MB | 10,906,295 | **2.19 s** vs 41.17 s | 93 ms *(2.29 s)* | 32.80 s / **19.32 s** | **35.09 s** / 60.49 s (1.72x)¹ | 3.48M / 3.50M |
| **`Pasarela.ifc`** | 924.65 MB | 16,786,443 | **3.80 s** vs 62.46 s | 767 ms *(4.57 s)* | **43.82 s** / 180.89 s | **48.39 s** / 243.35 s (5.03x) | 7.51M / 7.50M |

> **Methodological Notes:**  
> - **¹ Pure Tessellation vs. Ingestion (`model_4_arc`, `LTU_A-House_redesign`, `model_6_arc`):** On these 3 models, IFCLite's Rust/WASM kernel is faster in pure geometry tessellation (`4.68 s vs 7.15 s`, `27.73 s vs 29.62 s`, and `19.32 s vs 32.80 s`). Croquera's end-to-end lead (such as the `1.15x` in `model_4_arc`) comes from its much faster STEP ingestion stage.
> - **² Non-Comparable Triangle Count in `LTU_A-House_Plumbing.ifc` (`4.65M` vs `12.30M`):** Croquera uses fewer radial segments when discretizing small-radius pipes, producing 2.64x fewer triangles than IFCLite. Part of Croquera's speed advantage on this specific model comes from generating less geometry.
> - **AABB Pre-Pass vs. Camera Ready:** `Croq AABB` (`41 ms` to `2.64 s`) is the isolated bounding-box computation; `Camera Ready` (`103 ms` to `4.57 s`) is the cumulative time (`STEP Ingestion + AABB`) until the camera frames the project envelope. Full details in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

### Packages
- **`@croquera/ifc-core`**: Decoupled IFC 4.3 streaming parser, topological B-Rep solver, and geometry evaluation engine.
- **`@croquera/ifc-viewer`**: Buffer-first Three.js rendering layer, batched pools, camera rig, and measurement tools.
- **`apps/web-viewer`**: Minimalist tactile Soft-Clay web application.

### Quick Start
```bash
# Install dependencies
npm install

# Run web viewer locally
npm run dev

# Run unit tests
npm test
```

---

## Español

### Demostración en Línea
Pruébalo directamente en el navegador sin instalar dependencias:  
[https://www.vivemejor.cl/croquera/viewer/](https://www.vivemejor.cl/croquera/viewer/)

### Características Destacadas
- **Streaming Ultrarrápido:** Ingesta progresiva en 3 etapas con encuadre de cámara instantáneo (< 500 ms) y transferencia `zero-copy` a Web Workers.
- **Lotes e Instancias en GPU:** Utiliza `THREE.BatchedMesh` y `THREE.InstancedMesh` para navegación a 60+ FPS en modelos BIM complejos.
- **100% Privado en Navegador:** Sin servidores intermedios; todo el procesamiento ocurre en local.
- **Búsqueda Instantánea de GUID:** Localización O(1) con auto-encuadre de cámara.
- **Herramienta de Medición con Snap:** Medición de precisión sobre aristas y vértices acelerada con BVH.
- **Puente Directo:** Botón "Editar en Croquera" para continuar modelando en [Croquera.com](https://croquera.com) con un solo clic.

### Rendimiento y Benchmarks (Motor medido en Node.js v24)
- **Entorno de Medición (Node.js CLI, no navegador):** Todos los números del benchmark corresponden a la ejecución aislada del motor en **Node.js v24 (V8 CLI)** en 64 bits. En el navegador intervienen además la subida de buffers a WebGL y la comunicación con Web Workers.
- **Dónde está la ventaja real (Ingesta vs. Teselación Pura):**
  - **Ingesta STEP (7,6x a 22,7x más rápida):** `ChunkedStreamScanner` indexa hasta 16,78 millones de entidades en **3,80 s** frente a **62,46 s** en IFCLite. Esta diferencia explica que Croquera obtenga menor tiempo total *end-to-end* en los 12 modelos (1,15x a 5,03x).
  - **Teselación Geométrica Pura (9/12 para Croquera, 3/12 para IFCLite):** En generación geométrica pura la disputa es pareja. IFCLite (Rust/WASM) vence en teselación pura en 3 de los 12 modelos (`model_4_arc.ifc`: 4,68 s vs 7,15 s; `LTU_A-House_redesign.ifc`: 27,73 s vs 29,62 s; `model_6_arc.ifc`: 19,32 s vs 32,80 s). En `model_4_arc.ifc`, el 1,15x a favor de Croquera en el total proviene íntegramente de los 3,7 s de ventaja en la ingesta STEP.
- **Nota sobre Triángulos en `LTU_A-House_Plumbing.ifc` (4,65 M vs 12,30 M):** Los conteos de triángulos no son directamente comparables en este modelo de tuberías porque Croquera discretiza los cilindros de pequeño radio con menos segmentos radiales (generando 2,64 veces menos triángulos), lo que explica buena parte de su ventaja de tiempo en ese archivo.
- **Cálculo AABB vs. Cámara Lista (sin mezclar métricas):**
  - **Cálculo de envolvente (AABB puro):** `41 ms a 2,64 s` (`767 ms` en el modelo de 925 MB).
  - **Cámara lista (`Ingesta STEP + AABB`):** `103 ms a 4,57 s` acumulados desde el inicio de lectura.
- Metodología completa y desglose por etapa en [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

---

## License

Licensed under the **Apache License, Version 2.0** ([LICENSE](LICENSE)).
