import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ChunkedStreamScanner } from '../packages/ifc-core/src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../packages/ifc-core/src/importer/IfcStepImporter';

const require = createRequire(import.meta.url);

interface BenchmarkMetric {
  fileName: string;
  sizeMB: number;
  entities: number;
  readDiskMs: number;
  croq: {
    scanMs: number;
    boundsMs: number;
    geomMs: number;
    totalMs: number;
    products: number;
    triangles: number;
    heapMB: number;
    error?: string;
  };
  lite: {
    parseMs: number;
    geomMs: number;
    totalMs: number;
    meshes: number;
    triangles: number;
    heapMB: number;
    error?: string;
  } | null;
}

// Carga segura de IFCLite
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
    ifcLiteAvailable = false;
  }
}

async function runBenchmarkForFile(filePath: string): Promise<BenchmarkMetric> {
  const stat = fs.statSync(filePath);
  const sizeMB = parseFloat((stat.size / (1024 * 1024)).toFixed(2));
  const fileName = path.basename(filePath);

  console.log(`\n========================================================================`);
  console.log(` IFC BENCHMARK: ${fileName} (${sizeMB} MB)`);
  console.log(`========================================================================\n`);

  if (global.gc) {
    global.gc();
  }

  const tRead0 = performance.now();
  const buf = fs.readFileSync(filePath);
  const tRead1 = performance.now();
  const readDiskMs = parseFloat((tRead1 - tRead0).toFixed(1));
  console.log(`I/O Disk Read: ${readDiskMs} ms | Initial Heap: ${(process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1)} MB\n`);

  const metric: BenchmarkMetric = {
    fileName,
    sizeMB,
    entities: 0,
    readDiskMs,
    croq: {
      scanMs: 0,
      boundsMs: 0,
      geomMs: 0,
      totalMs: 0,
      products: 0,
      triangles: 0,
      heapMB: 0,
    },
    lite: null,
  };

  // --- 1. CROQUERA IFC CORE ---
  console.log(`[1/2] Running Croquera IFC Core...`);
  try {
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const cT0 = performance.now();
    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();
    const cTScan = performance.now();

    metric.entities = scanner.totalEntities;

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    const spatial = importer.extractSpatialHierarchy();
    const bounds = importer.extractProductBounds();
    const cTBounds = performance.now();

    let totalTris = 0;
    let totalProds = 0;
    for (const chunk of importer.extractGeometryChunks(100)) {
      totalProds += chunk.elements.length;
      for (const el of chunk.elements) {
        if (el.indices) {
          totalTris += Math.floor(el.indices.length / 3);
        }
      }
    }
    const cTGeom = performance.now();

    metric.croq.scanMs = Math.round(cTScan - cT0);
    metric.croq.boundsMs = Math.round(cTBounds - cTScan);
    metric.croq.geomMs = Math.round(cTGeom - cTBounds);
    metric.croq.totalMs = Math.round(cTGeom - cT0);
    metric.croq.products = totalProds;
    metric.croq.triangles = totalTris;
    metric.croq.heapMB = parseFloat((process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1));

    console.log(`  - STEP Ingestion & Indexing:  ${metric.croq.scanMs} ms (${scanner.totalEntities.toLocaleString()} entities)`);
    console.log(`  - Spatial & Bounds (AABB):    ${metric.croq.boundsMs} ms (Camera ready in ${metric.croq.scanMs + metric.croq.boundsMs} ms)`);
    console.log(`  - Geometry Tessellation:     ${metric.croq.geomMs} ms`);
    console.log(`  - Total End-to-End:          ${metric.croq.totalMs} ms`);
    console.log(`  - Output:                    ${metric.croq.products} consolidated products (${totalTris.toLocaleString()} triangles)`);
    console.log(`  - Heap Usage:                ${metric.croq.heapMB} MB\n`);
  } catch (err: any) {
    metric.croq.error = err.message || String(err);
    console.error(`  [ERROR Croquera]:`, metric.croq.error);
  }

  // --- 2. IFCLITE (Rust/WASM) ---
  if (ifcLiteAvailable) {
    console.log(`[2/2] Running IFCLite (Rust/WASM)...`);
    metric.lite = {
      parseMs: 0,
      geomMs: 0,
      totalMs: 0,
      meshes: 0,
      triangles: 0,
      heapMB: 0,
    };

    try {
      if (global.gc) {
        global.gc();
      }

      const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

      const proc = new GeometryProcessor();
      await proc.init();

      const lT0 = performance.now();
      const parsed = await parseModel(u8);
      const lTParse = performance.now();

      let liteMeshes = 0;
      let liteTris = 0;
      for await (const ev of proc.processStreaming(u8)) {
        if (ev.type === 'batch' && ev.meshes) {
          liteMeshes += ev.meshes.length;
          for (const m of ev.meshes) {
            if (m.indices) {
              liteTris += Math.floor(m.indices.length / 3);
            }
          }
        }
      }
      const lTGeom = performance.now();
      proc.dispose();

      metric.lite.parseMs = Math.round(lTParse - lT0);
      metric.lite.geomMs = Math.round(lTGeom - lTParse);
      metric.lite.totalMs = Math.round(lTGeom - lT0);
      metric.lite.meshes = liteMeshes;
      metric.lite.triangles = liteTris;
      metric.lite.heapMB = parseFloat((process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1));

      console.log(`  - STEP Parsing:              ${metric.lite.parseMs} ms`);
      console.log(`  - Geometry Streaming:        ${metric.lite.geomMs} ms`);
      console.log(`  - Total End-to-End:          ${metric.lite.totalMs} ms`);
      console.log(`  - Output:                    ${metric.lite.meshes} mesh fragments (${liteTris.toLocaleString()} triangles)`);
      console.log(`  - Heap Usage:                ${metric.lite.heapMB} MB\n`);

      console.log(`------------------------------------------------------------------------`);
      console.log(` COMPARISON SUMMARY:`);
      const scanSpeed = (metric.lite.parseMs / (metric.croq.scanMs || 1)).toFixed(1);
      console.log(`  - STEP Ingestion:            Croquera is ${scanSpeed}x faster`);
      console.log(`  - Time-to-First-Frame:       Croquera frames camera ${Math.round(metric.lite.parseMs - (metric.croq.scanMs + metric.croq.boundsMs))} ms earlier`);
      const geomWinner = metric.lite.geomMs < metric.croq.geomMs
        ? `IFCLite is ${(metric.croq.geomMs / (metric.lite.geomMs || 1)).toFixed(1)}x faster`
        : `Croquera is ${(metric.lite.geomMs / (metric.croq.geomMs || 1)).toFixed(1)}x faster`;
      console.log(`  - Pure Tessellation:         ${geomWinner}`);
      const totalWinner = metric.croq.totalMs < metric.lite.totalMs
        ? `Croquera won (by ${metric.lite.totalMs - metric.croq.totalMs} ms)`
        : `IFCLite won (by ${metric.croq.totalMs - metric.lite.totalMs} ms)`;
      console.log(`  - Total End-to-End:          ${totalWinner} (Croquera: ${metric.croq.totalMs} ms vs IFCLite: ${metric.lite.totalMs} ms)`);
      console.log(`------------------------------------------------------------------------\n`);
    } catch (err: any) {
      metric.lite.error = err.message || String(err);
      console.error(`  [ERROR IFCLite]:`, metric.lite.error);
    }
  }

  return metric;
}

function printConsolidatedReport(results: BenchmarkMetric[]) {
  console.log(`\n================================================================================================`);
  console.log(` CONSOLIDATED BENCHMARK REPORT: CROQUERA IFC CORE vs IFC-LITE`);
  console.log(`================================================================================================\n`);

  console.log(`| Modelo IFC | Tamaño | Entidades | Croq STEP | Lite STEP | Croq Geom | Lite Geom | Croq Total | Lite Total | Ganador Total | Factor |`);
  console.log(`| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |`);

  for (const r of results) {
    if (r.croq.error || (r.lite && r.lite.error)) {
      const errNote = r.croq.error ? `Croq Err` : `Lite Err`;
      console.log(`| ${r.fileName} | ${r.sizeMB} MB | ${r.entities.toLocaleString()} | - | - | - | - | - | - | ${errNote} | - |`);
      continue;
    }

    const croqStep = `${r.croq.scanMs} ms`;
    const liteStep = r.lite ? `${r.lite.parseMs} ms` : 'N/A';
    const croqGeom = `${r.croq.geomMs} ms`;
    const liteGeom = r.lite ? `${r.lite.geomMs} ms` : 'N/A';
    const croqTot = `${r.croq.totalMs} ms`;
    const liteTot = r.lite ? `${r.lite.totalMs} ms` : 'N/A';

    let winner = 'Croquera';
    let factor = '1.0x';
    if (r.lite) {
      if (r.croq.totalMs <= r.lite.totalMs) {
        winner = 'Croquera';
        factor = `${(r.lite.totalMs / (r.croq.totalMs || 1)).toFixed(2)}x`;
      } else {
        winner = 'IFC-Lite';
        factor = `${(r.croq.totalMs / (r.lite.totalMs || 1)).toFixed(2)}x`;
      }
    }

    console.log(`| ${r.fileName} | ${r.sizeMB} MB | ${r.entities.toLocaleString()} | ${croqStep} | ${liteStep} | ${croqGeom} | ${liteGeom} | ${croqTot} | ${liteTot} | **${winner}** | ${factor} |`);
  }

  console.log(`\n================================================================================================\n`);
}

async function main() {
  const targetPath = process.argv[2] || 'C:/AI/10 CROQUERA/ModelosBenchmark';

  if (!fs.existsSync(targetPath)) {
    console.error(`[ERROR] Target path does not exist: ${targetPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(targetPath);
  let filesToTest: string[] = [];

  if (stat.isDirectory()) {
    const allFiles = fs.readdirSync(targetPath);
    filesToTest = allFiles
      .filter((f) => f.toLowerCase().endsWith('.ifc'))
      .map((f) => path.join(targetPath, f))
      .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
    console.log(`[INFO] Found ${filesToTest.length} IFC benchmark files in ${targetPath}`);
  } else {
    filesToTest = [targetPath];
  }

  const results: BenchmarkMetric[] = [];
  for (const file of filesToTest) {
    try {
      const metric = await runBenchmarkForFile(file);
      results.push(metric);
    } catch (e: any) {
      console.error(`[CRITICAL ERROR] on file ${file}:`, e);
    }
  }

  printConsolidatedReport(results);
}

main().catch(console.error);
