import fs from 'fs';
import path from 'path';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';

const testFiles = [
  'c:/AI/10 CROQUERA/ModelosDePrueba/proyecto_croquera.ifc',
  'c:/AI/10 CROQUERA/ModelosDePrueba/MovimientosTierra_Original.ifc',
  'c:/AI/10 CROQUERA/ModelosDePrueba/ElManzano.ifc',
  'c:/AI/10 CROQUERA/ModelosDePrueba/VespucioNorte.ifc'
];

console.log('--- BENCHMARK DE RENDIMIENTO SOA (STRUCTURE OF ARRAYS) ---');

for (const f of testFiles) {
  if (!fs.existsSync(f)) continue;

  const baseName = path.basename(f);
  const buf = fs.readFileSync(f);
  const sizeMb = (buf.length / (1024 * 1024)).toFixed(2);

  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;

  const t0 = performance.now();
  const scanner = new ChunkedStreamScanner(buf);
  scanner.parseHeader();
  scanner.scanDataSection();
  const scanTime = performance.now() - t0;

  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMb = ((heapAfter - heapBefore) / (1024 * 1024)).toFixed(2);

  console.log(`\n[MODELO] ${baseName} (${sizeMb} MB)`);
  console.log(`  - Entidades indexadas: ${scanner.totalEntities.toLocaleString()} (Max ID: #${scanner.maxId.toLocaleString()})`);
  console.log(`  - Tipos distintos descubiertos: ${scanner.typeDictionary.size}`);
  console.log(`  - Tiempo de escaneo SoA: ${scanTime.toFixed(1)} ms (${(scanner.totalEntities / (scanTime / 1000)).toLocaleString(undefined, { maximumFractionDigits: 0 })} entidades/s)`);
  console.log(`  - Delta Heap V8: ${heapDeltaMb} MB`);

  // Stream a high-frequency type to verify traversal speed
  const sampleTypes = ['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCSLAB', 'IFCSHAPEREPRESENTATION', 'IFCPROPERTYSET'];
  for (const st of sampleTypes) {
    let count = 0;
    const tStream0 = performance.now();
    scanner.getRecordsByTypeStreaming(st, () => {
      count++;
    });
    const streamDt = performance.now() - tStream0;
    if (count > 0) {
      console.log(`  - Stream ${st}: ${count.toLocaleString()} entidades recorridas en ${streamDt.toFixed(2)} ms`);
      break;
    }
  }
}
