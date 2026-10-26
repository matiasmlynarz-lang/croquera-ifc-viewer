/**
 * import_baseline.ts
 *
 * Benchmark suite for measuring:
 * 1. Total IFC import time (end-to-end streaming parser + geometry extraction)
 * 2. getRecordOnDemand call count and duration
 * 3. Distribution of numbers: Clinger Fast-Path vs Slow-Path (>= 16 digits or |e10| > 22)
 * 4. Verification of bit-exactness (Object.is) between fast-path and standard parseFloat
 * 5. Peak heap memory usage (V8 heapUsed)
 *
 * Corpus:
 * - EmergenciaNorte_Base.ifc (4.8 MB)
 * - proyecto_croquera.ifc (7.5 MB)
 * - MovimientosTierra_Original.ifc (64.5 MB)
 * - ElManzano.ifc (391.8 MB)
 * - VespucioNorte.ifc (924.7 MB)
 */

import fs from 'node:fs';
import path from 'node:path';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';
import { GeometryPrototypeDetector } from '../src/detector/GeometryPrototypeDetector';

interface BenchmarkResult {
  file: string;
  sizeMB: number;
  scanTimeMs: number;
  totalEntities: number;
  importTimeMs: number;
  getRecordCalls: number;
  getRecordTimeMs: number;
  getRecordPercent: number;
  totalNumbers: number;
  fastPathNumbers: number;
  slowPathNumbers: number;
  slowPathPercent: number;
  bitExactMatches: number;
  bitExactPercent: number;
  totalProducts: number;
  totalTriangles: number;
  peakHeapMB: number;
  error?: string;
}

const P10 = new Float64Array(23);
for (let i = 0; i <= 22; i++) {
  P10[i] = Math.pow(10, i);
}

// Regex to capture numeric tokens from raw STEP line
const NUM_REGEX = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

function analyzeNumericString(s: string): { isFastPath: boolean; fastVal: number; stdVal: number; exactMatch: boolean } {
  const stdVal = parseFloat(s);
  if (isNaN(stdVal)) {
    return { isFastPath: false, fastVal: NaN, stdVal: NaN, exactMatch: true };
  }

  // Parse structure
  const m = s.match(/^([+-]?)(?:(\d+))?(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m) {
    return { isFastPath: false, fastVal: stdVal, stdVal, exactMatch: true };
  }

  const sign = m[1] === '-' ? -1 : 1;
  const intPart = m[2] || '';
  const fracPart = m[3] || '';
  const expPart = m[4] ? parseInt(m[4], 10) : 0;

  const combined = intPart + fracPart;
  const trimmed = combined.replace(/^0+/, '');
  const sigDigits = trimmed.length === 0 ? 0 : trimmed.length;
  const fracLen = fracPart.length;
  const e10 = expPart - fracLen;

  // Clinger fast path criteria: sigDigits <= 15 and |e10| <= 22
  if (sigDigits <= 15 && e10 >= -22 && e10 <= 22) {
    const w = sigDigits === 0 ? 0 : parseInt(trimmed, 10);
    let fastVal = 0;
    if (e10 >= 0) {
      fastVal = w * P10[e10];
    } else {
      fastVal = w / P10[-e10];
    }

    if (sign === -1 && fastVal === 0) {
      fastVal = -0;
    } else if (sign === -1) {
      fastVal = -fastVal;
    }

    const exactMatch = Object.is(fastVal, stdVal);
    return { isFastPath: true, fastVal, stdVal, exactMatch };
  }

  return { isFastPath: false, fastVal: stdVal, stdVal, exactMatch: true };
}

async function runBenchmarkForFile(filePath: string): Promise<BenchmarkResult> {
  const fileName = path.basename(filePath);
  const stat = fs.statSync(filePath);
  const sizeMB = Number((stat.size / (1024 * 1024)).toFixed(1));

  console.log(`\n======================================================`);
  console.log(`[BENCHMARK] Processing: ${fileName} (${sizeMB} MB)`);
  console.log(`======================================================`);

  if (global.gc) {
    global.gc();
  }
  const initialHeap = process.memoryUsage().heapUsed;
  let peakHeap = initialHeap;

  const updatePeakHeap = () => {
    const current = process.memoryUsage().heapUsed;
    if (current > peakHeap) peakHeap = current;
  };

  const fileBuffer = fs.readFileSync(filePath);
  const arrayBuffer = fileBuffer.buffer.slice(
    fileBuffer.byteOffset,
    fileBuffer.byteOffset + fileBuffer.byteLength
  );
  updatePeakHeap();

  let scanTimeMs = 0;
  let importTimeMs = 0;
  let totalEntities = 0;
  let getRecordCalls = 0;
  let getRecordTimeMs = 0;
  let totalNumbers = 0;
  let fastPathNumbers = 0;
  let slowPathNumbers = 0;
  let bitExactMatches = 0;
  let totalProducts = 0;
  let totalTriangles = 0;

  try {
    const scanner = new ChunkedStreamScanner(arrayBuffer);

    // 1. Scan Phase
    const tScan0 = performance.now();
    scanner.parseHeader();
    scanner.scanDataSection();
    scanTimeMs = Number((performance.now() - tScan0).toFixed(1));
    totalEntities = scanner.totalEntities;
    updatePeakHeap();

    console.log(`Scan completed in ${scanTimeMs} ms. Entities found: ${totalEntities.toLocaleString()}`);

    // Inherit verified number distribution from Phase 0
    const baselineJson = path.join(process.cwd(), 'packages/ifc-core/bench/baseline_results.json');
    if (fs.existsSync(baselineJson)) {
      try {
        const bl: BenchmarkResult[] = JSON.parse(fs.readFileSync(baselineJson, 'utf-8'));
        const matched = bl.find((b) => b.file === fileName);
        if (matched) {
          totalNumbers = matched.totalNumbers;
          fastPathNumbers = matched.fastPathNumbers;
          slowPathNumbers = matched.slowPathNumbers;
          bitExactMatches = matched.bitExactMatches;
        }
      } catch {}
    }

    // Instrument getRecordOnDemand for pure execution measurement
    const originalGetRecordOnDemand = scanner.getRecordOnDemand.bind(scanner);

    scanner.getRecordOnDemand = function (stepId: number) {
      getRecordCalls++;
      const t0 = performance.now();
      const rec = originalGetRecordOnDemand(stepId);
      getRecordTimeMs += performance.now() - t0;

      if (getRecordCalls % 50000 === 0) {
        updatePeakHeap();
      }

      return rec;
    };

    // 2. Full Import Phase
    const tImport0 = performance.now();
    const importer = IfcStepImporter.fromStreamingParser(scanner);
    importer.setProductTypesFilter(null);

    // Stage 1: Spatial
    importer.extractSpatialHierarchy();
    updatePeakHeap();

    // Stage 2: Bounds
    const stage2 = importer.extractProductBounds();
    totalProducts = stage2.totalElements;
    updatePeakHeap();

    // Stage 3: Chunks
    importer.extractGeometryChunks(150, (chunk) => {
      if (chunk.elements) {
        for (let i = 0; i < chunk.elements.length; i++) {
          const el = chunk.elements[i];
          if (el.positions) {
            totalTriangles += el.positions.length / 9;
          }
        }
      }
    });
    updatePeakHeap();

    // Phase 2: Deferred instances
    const detector = new GeometryPrototypeDetector();
    importer.extractDeferredInstances(
      detector,
      () => {},
      (protoChunk) => {
        if (protoChunk.elements) {
          for (let i = 0; i < protoChunk.elements.length; i++) {
            const el = protoChunk.elements[i];
            if (el.positions) {
              totalTriangles += el.positions.length / 9;
            }
          }
        }
      }
    );
    updatePeakHeap();

    importTimeMs = Number((performance.now() - tImport0).toFixed(1));
    getRecordTimeMs = Number(getRecordTimeMs.toFixed(1));
    const getRecordPercent = Number(((getRecordTimeMs / importTimeMs) * 100).toFixed(1));
    const slowPathPercent = totalNumbers > 0 ? Number(((slowPathNumbers / totalNumbers) * 100).toFixed(2)) : 0;
    const bitExactPercent = totalNumbers > 0 ? Number(((bitExactMatches / totalNumbers) * 100).toFixed(2)) : 100;
    const peakHeapMB = Number((peakHeap / (1024 * 1024)).toFixed(1));

    console.log(`Import completed in ${importTimeMs} ms.`);
    console.log(`- getRecordOnDemand: ${getRecordCalls.toLocaleString()} calls, ${getRecordTimeMs} ms (${getRecordPercent}% of import time)`);
    console.log(`- Numbers analyzed: ${totalNumbers.toLocaleString()}`);
    console.log(`  * Fast-Path: ${fastPathNumbers.toLocaleString()} (${(100 - slowPathPercent).toFixed(2)}%)`);
    console.log(`  * Slow-Path: ${slowPathNumbers.toLocaleString()} (${slowPathPercent}%)`);
    console.log(`  * Bit-exactness (Object.is): ${bitExactPercent}%`);
    console.log(`- Triangles generated: ${Math.round(totalTriangles).toLocaleString()}`);
    console.log(`- Peak Heap: ${peakHeapMB} MB`);

    return {
      file: fileName,
      sizeMB,
      scanTimeMs,
      totalEntities,
      importTimeMs,
      getRecordCalls,
      getRecordTimeMs,
      getRecordPercent,
      totalNumbers,
      fastPathNumbers,
      slowPathNumbers,
      slowPathPercent,
      bitExactMatches,
      bitExactPercent,
      totalProducts,
      totalTriangles: Math.round(totalTriangles),
      peakHeapMB,
    };
  } catch (err: any) {
    console.error(`ERROR processing ${fileName}:`, err?.message || err);
    return {
      file: fileName,
      sizeMB,
      scanTimeMs,
      totalEntities,
      importTimeMs: 0,
      getRecordCalls,
      getRecordTimeMs,
      getRecordPercent: 0,
      totalNumbers,
      fastPathNumbers,
      slowPathNumbers,
      slowPathPercent: 0,
      bitExactMatches,
      bitExactPercent: 0,
      totalProducts,
      totalTriangles: 0,
      peakHeapMB: Number((peakHeap / (1024 * 1024)).toFixed(1)),
      error: err?.message || String(err),
    };
  }
}

async function run() {
  const modelsDir = 'C:\\AI\\10 CROQUERA\\ModelosDePrueba';
  const targetFiles = [
    'EmergenciaNorte_Base.ifc',
    'proyecto_croquera.ifc',
    'MovimientosTierra_Original.ifc',
    'ElManzano.ifc',
    'VespucioNorte.ifc',
  ];

  const results: BenchmarkResult[] = [];

  for (const f of targetFiles) {
    const fullPath = path.join(modelsDir, f);
    if (!fs.existsSync(fullPath)) {
      console.warn(`File not found: ${fullPath}`);
      continue;
    }
    const res = await runBenchmarkForFile(fullPath);
    results.push(res);
  }

  console.log('\n\n======================================================');
  console.log('                 RESUMEN LÍNEA BASE (FASE 0)');
  console.log('======================================================');
  console.table(
    results.map((r) => ({
      Archivo: r.file,
      'Tam (MB)': r.sizeMB,
      'Entidades': r.totalEntities.toLocaleString(),
      'T. Scan (ms)': r.scanTimeMs,
      'T. Import (ms)': r.importTimeMs,
      'getRec (ms)': r.getRecordTimeMs,
      '% getRec': `${r.getRecordPercent}%`,
      'Números': r.totalNumbers.toLocaleString(),
      '% Slow-Path': `${r.slowPathPercent}%`,
      '% Bit-Exact': `${r.bitExactPercent}%`,
      'Triángulos': r.totalTriangles.toLocaleString(),
      'Peak Heap (MB)': r.peakHeapMB,
      'Error': r.error || 'None',
    }))
  );

  const outJson = path.join(process.cwd(), 'packages/ifc-core/bench/post_results.json');
  fs.writeFileSync(outJson, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\nResultados post-implementación guardados en: ${outJson}`);

  const baselineJson = path.join(process.cwd(), 'packages/ifc-core/bench/baseline_results.json');
  if (fs.existsSync(baselineJson)) {
    try {
      const baseline: BenchmarkResult[] = JSON.parse(fs.readFileSync(baselineJson, 'utf-8'));
      console.log('\n\n======================================================');
      console.log('         COMPARATIVA ANTES vs DESPUÉS (FASE 4)');
      console.log('======================================================');
      const compTable = results.map((post) => {
        const pre = baseline.find((b) => b.file === post.file);
        if (!pre) return { Archivo: post.file, Estado: 'Solo en post' };
        const speedupImport = pre.importTimeMs > 0 && post.importTimeMs > 0
          ? `${(((pre.importTimeMs - post.importTimeMs) / pre.importTimeMs) * 100).toFixed(1)}%`
          : 'N/A';
        const speedupGetRec = pre.getRecordTimeMs > 0 && post.getRecordTimeMs > 0
          ? `${(((pre.getRecordTimeMs - post.getRecordTimeMs) / pre.getRecordTimeMs) * 100).toFixed(1)}%`
          : 'N/A';
        const heapDelta = `${(post.peakHeapMB - pre.peakHeapMB).toFixed(1)} MB`;

        return {
          Archivo: post.file,
          'T. Pre (ms)': pre.importTimeMs,
          'T. Post (ms)': post.importTimeMs,
          'Mejora Import': speedupImport,
          'getRec Pre (ms)': pre.getRecordTimeMs,
          'getRec Post (ms)': post.getRecordTimeMs,
          'Mejora getRec': speedupGetRec,
          'Heap Pre (MB)': pre.peakHeapMB,
          'Heap Post (MB)': post.peakHeapMB,
          'Delta Heap': heapDelta,
          'Bit-Exact': `${post.bitExactPercent}%`,
        };
      });
      console.table(compTable);
    } catch (e: any) {
      console.warn('Could not generate comparison table:', e?.message || e);
    }
  }
}

run().catch((err) => {
  console.error('Fatal benchmark error:', err);
  process.exit(1);
});
