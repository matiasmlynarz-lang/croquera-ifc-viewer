# croquera-ifc-viewer

> **The fastest web-based IFC viewer in the market.**  
> *El visualizador IFC en navegador más rápido del mercado.*

An ultra-performant, zero-dependency, open-source IFC 4.3 viewer designed for instant in-browser loading, zero-copy GPU tessellation, GUID search, and high-precision spatial measurements.

**Live Demo / Demostración en Vivo:**  
[https://www.vivemejor.cl/croquera/viewer/](https://www.vivemejor.cl/croquera/viewer/)

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

---

## License

Licensed under the **Apache License, Version 2.0** ([LICENSE](LICENSE)).
