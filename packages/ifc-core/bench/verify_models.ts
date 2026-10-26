import fs from 'fs';
import path from 'path';
import { StepByteNumber } from '../src/lexer/StepByteNumber';

const testFiles = [
  'c:/AI/10 CROQUERA/ModelosDePrueba/proyecto_croquera.ifc',
  'c:/AI/10 CROQUERA/ModelosDePrueba/01_Estructura_R24.ifc',
  'c:/AI/10 CROQUERA/ModelosDePrueba/MovimientosTierra_Original.ifc',
  'c:/AI/10 CROQUERA/ModelosDePrueba/ElManzano.ifc',
  'c:/AI/10 CROQUERA/ModelosDePrueba/VespucioNorte.ifc'
];

console.log('--- INICIO DE VERIFICACIÓN DE EXACTITUD BIT-EXACTA (OPCIÓN B) ---');

let totalChecked = 0;
let totalMismatches = 0;

for (const f of testFiles) {
  if (!fs.existsSync(f)) {
    console.log('[SKIP] Archivo no encontrado:', f);
    continue;
  }
  const buf = fs.readFileSync(f);
  const sizeMb = (buf.length / (1024 * 1024)).toFixed(2);
  const baseName = path.basename(f);
  console.log(`[START] Verificando ${baseName} (${sizeMb} MB)...`);

  const cursor = { pos: 0 };
  let numbersChecked = 0;
  let mismatches = 0;
  const t0 = performance.now();

  let p = 0;
  const end = buf.length;
  while (p < end) {
    const c = buf[p];
    // Check if start of number: digit or '-' or '.' followed by digit
    if ((c >= 48 && c <= 57) || ((c === 45 || c === 46) && p + 1 < end && buf[p + 1] >= 48 && buf[p + 1] <= 57)) {
      if (p > 0 && buf[p - 1] === 35) { // '#' entity id
        p++;
        continue;
      }
      const tokenStart = p;
      const parsed = StepByteNumber.parseNumber(buf, p, end, cursor);
      const tokenEnd = cursor.pos;
      const rawStr = buf.subarray(tokenStart, tokenEnd).toString('ascii');
      const expected = parseFloat(rawStr);

      if (!Object.is(parsed, expected)) {
        mismatches++;
        if (mismatches <= 5) {
          console.error(`[ERROR] Mismatch en ${rawStr}: parsed=${parsed}, expected=${expected}`);
        }
      }
      numbersChecked++;
      p = tokenEnd;
    } else {
      p++;
    }
  }

  const dt = performance.now() - t0;
  console.log(`[DONE] ${baseName}: ${numbersChecked.toLocaleString()} números verificados en ${dt.toFixed(1)} ms. Mismatches: ${mismatches}`);
  totalChecked += numbersChecked;
  totalMismatches += mismatches;
}

console.log('-------------------------------------------------------------');
console.log(`TOTAL GENERAL: ${totalChecked.toLocaleString()} números verificados.`);
console.log(`TOTAL MISMATCHES: ${totalMismatches} (Exactitud: ${totalMismatches === 0 ? '100.0000%' : 'FALLÓ'})`);
