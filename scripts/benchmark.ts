import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ChunkedStreamScanner } from '../packages/ifc-core/src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../packages/ifc-core/src/importer/IfcStepImporter';

const require = createRequire(import.meta.url);

async function runBenchmarkForFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    console.error(`[ERROR] File not found: ${filePath}`);
    process.exit(1);
  }

  const stat = fs.statSync(filePath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
  const fileName = path.basename(filePath);

  console.log(`\n========================================================================`);
  console.log(` IFC BENCHMARK: ${fileName} (${sizeMB} MB)`);
  console.log(`========================================================================\n`);

  const tRead0 = performance.now();
  const buf = fs.readFileSync(filePath);
  const tRead1 = performance.now();
  console.log(`I/O Disk Read: ${(tRead1 - tRead0).toFixed(1)} ms | Initial Heap: ${(process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1)} MB\n`);

  // --- 1. CROQUERA IFC CORE ---
  console.log(`[1/2] Running Croquera IFC Core...`);
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const cT0 = performance.now();
  const scanner = new ChunkedStreamScanner(arrayBuf);
  scanner.parseHeader();
  scanner.scanDataSection();
  const cTScan = performance.now();

  const importer = IfcStepImporter.fromStreamingParser(scanner);
  const spatial = importer.extractSpatialHierarchy();
  const bounds = importer.extractProductBounds();
  const cTBounds = performance.now();

  const chunks = Array.from(importer.extractGeometryChunks(100));
  const cTGeom = performance.now();
  const croqProducts = chunks.reduce((acc, c) => acc + c.elements.length, 0);

  const croqScanMs = Math.round(cTScan - cT0);
  const croqBoundsMs = Math.round(cTBounds - cTScan);
  const croqGeomMs = Math.round(cTGeom - cTBounds);
  const croqTotalMs = Math.round(cTGeom - cT0);

  console.log(`  - STEP Ingestion & Indexing:  ${croqScanMs} ms (${scanner.totalEntities.toLocaleString()} entities)`);
  console.log(`  - Spatial & Bounds (AABB):    ${croqBoundsMs} ms (Camera ready in ${croqScanMs + croqBoundsMs} ms)`);
  console.log(`  - Geometry Tessellation:     ${croqGeomMs} ms`);
  console.log(`  - Total End-to-End:          ${croqTotalMs} ms`);
  console.log(`  - Output:                    ${croqProducts} consolidated products (IfcProduct)`);
  console.log(`  - Heap Usage:                ${(process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1)} MB\n`);

  // --- 2. IFCLITE (if installed) ---
  let ifcLiteAvailable = false;
  let parseModel: any;
  let GeometryProcessor: any;

  try {
    const ifcLitePkgPath = 'C:/Users/CyD/.gemini/antigravity-ide/brain/04534258-fe68-41ce-bd0a-7bedd4311976/scratch/benchmark-test/node_modules';
    parseModel = require(path.join(ifcLitePkgPath, '@ifc-lite/parser')).parseModel;
    GeometryProcessor = require(path.join(ifcLitePkgPath, '@ifc-lite/geometry')).GeometryProcessor;
    ifcLiteAvailable = true;
  } catch {
    try {
      parseModel = require('@ifc-lite/parser').parseModel;
      GeometryProcessor = require('@ifc-lite/geometry').GeometryProcessor;
      ifcLiteAvailable = true;
    } catch {
      // IFCLite optional
    }
  }

  if (ifcLiteAvailable) {
    console.log(`[2/2] Running IFCLite (Rust/WASM)...`);
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

    const proc = new GeometryProcessor();
    await proc.init();

    const lT0 = performance.now();
    const parsed = await parseModel(u8);
    const lTParse = performance.now();

    let liteMeshes = 0;
    for await (const ev of proc.processStreaming(u8)) {
      if (ev.type === 'batch') {
        liteMeshes += ev.meshes ? ev.meshes.length : 0;
      }
    }
    const lTGeom = performance.now();
    proc.dispose();

    const liteParseMs = Math.round(lTParse - lT0);
    const liteGeomMs = Math.round(lTGeom - lTParse);
    const liteTotalMs = Math.round(lTGeom - lT0);

    console.log(`  - STEP Parsing:              ${liteParseMs} ms`);
    console.log(`  - Geometry Streaming:        ${liteGeomMs} ms`);
    console.log(`  - Total End-to-End:          ${liteTotalMs} ms`);
    console.log(`  - Output:                    ${liteMeshes} mesh primitive fragments (MeshData)`);
    console.log(`  - Heap Usage:                ${(process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1)} MB\n`);

    console.log(`------------------------------------------------------------------------`);
    console.log(` COMPARISON SUMMARY:`);
    console.log(`  - STEP Ingestion:            Croquera is ${(liteParseMs / (croqScanMs || 1)).toFixed(1)}x faster`);
    console.log(`  - Time-to-First-Frame:       Croquera frames camera ${Math.round(liteParseMs - (croqScanMs + croqBoundsMs))} ms earlier`);
    console.log(`  - Pure Tessellation:         IFCLite is ${(croqGeomMs / (liteGeomMs || 1)).toFixed(1)}x faster`);
    console.log(`  - Total End-to-End:          Croquera: ${croqTotalMs} ms vs IFCLite: ${liteTotalMs} ms`);
    console.log(`------------------------------------------------------------------------\n`);
  } else {
    console.log(`[2/2] IFCLite not found in dependencies (Skipping comparison).`);
  }
}

const target = process.argv[2] || 'C:/AI/10 CROQUERA/ModelosDePrueba/EmergenciaNorte_Base.ifc';
runBenchmarkForFile(target).catch(console.error);
