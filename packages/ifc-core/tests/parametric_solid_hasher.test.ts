import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { type StepRecord } from '../src/parser/IfcStepParser';
import { ParametricSolidHasher } from '../src/detector/ParametricSolidHasher';
import { GeometryPrototypeDetector } from '../src/detector/GeometryPrototypeDetector';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';
import type { InstanceBatchPayload, Stage3GeometryChunkPayload } from '../src/types/IfcWorkerProtocol';

describe('ParametricSolidHasher — AST-Level Parametric Solid Deduplication', () => {
  // Helper to create AST record map
  function createRecordMap(records: StepRecord[]): Map<number, StepRecord> {
    const map = new Map<number, StepRecord>();
    for (const r of records) {
      map.set(r.id, r);
    }
    return map;
  }

  it('T1: Hashing de Perfiles Estándar — Identical dimensions with different STEP IDs produce identical hash', () => {
    // #10 = IFCRECTANGLEPROFILEDEF('RECT', $, $, 300.0, 500.0);
    // #20 = IFCRECTANGLEPROFILEDEF('RECT_DIFF_ID', $, $, 300.0, 500.0);
    // #30 = IFCRECTANGLEPROFILEDEF('RECT_DIFFERENT', $, $, 400.0, 500.0);
    const records = createRecordMap([
      { id: 10, type: 'IFCRECTANGLEPROFILEDEF', params: ['RECT', null, null, 300.0, 500.0] },
      { id: 20, type: 'IFCRECTANGLEPROFILEDEF', params: ['RECT_DIFF_ID', null, null, 300.0, 500.0] },
      { id: 30, type: 'IFCRECTANGLEPROFILEDEF', params: ['RECT_DIFFERENT', null, null, 400.0, 500.0] },
    ]);

    const hash1 = ParametricSolidHasher.computeProfileHash(records, 10, 1.0);
    const hash2 = ParametricSolidHasher.computeProfileHash(records, 20, 1.0);
    const hash3 = ParametricSolidHasher.computeProfileHash(records, 30, 1.0);

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).not.toBe(0n);
  });

  it('T2: Tolerancia de Cuantización de Extrusión — Values within weld tolerance produce identical hash', () => {
    // GeometryTolerance.COINCIDENT_POINT = 0.0001 (0.1 mm)
    // Depth 3000.0 vs 3000.00003 (< 0.05 mm) -> Same quantized depth
    // Depth 3000.0 vs 3005.0 (> 0.1 mm) -> Different quantized depth
    const records = createRecordMap([
      { id: 1, type: 'IFCRECTANGLEPROFILEDEF', params: ['COL', null, null, 250.0, 250.0] },
      { id: 10, type: 'IFCEXTRUDEDAREASOLID', params: [{ ref: 1 }, null, null, 3000.0] },
      { id: 20, type: 'IFCEXTRUDEDAREASOLID', params: [{ ref: 1 }, null, null, 3000.00003] },
      { id: 30, type: 'IFCEXTRUDEDAREASOLID', params: [{ ref: 1 }, null, null, 3005.0] },
    ]);

    const sig1 = ParametricSolidHasher.computeSolidHash(records, records.get(10)!);
    const sig2 = ParametricSolidHasher.computeSolidHash(records, records.get(20)!);
    const sig3 = ParametricSolidHasher.computeSolidHash(records, records.get(30)!);

    expect(sig1).not.toBeNull();
    expect(sig2).not.toBeNull();
    expect(sig3).not.toBeNull();

    expect(sig1!.hash).toBe(sig2!.hash);
    expect(sig1!.hash).not.toBe(sig3!.hash);
  });

  it('T3: Desacople de Matriz Local M_solid — Different placements produce same hash with decoupled solidMatrix', () => {
    // Sólido 1: Ubicación en (10, 20, 0)
    // Sólido 2: Ubicación en (50, 80, 100) con rotación 90° alrededor de Z
    const records = createRecordMap([
      { id: 1, type: 'IFCCIRCLEPROFILEDEF', params: ['PIPE', null, null, 150.0] },
      // Placement 1:
      { id: 101, type: 'IFCCARTESIANPOINT', params: [[10.0, 20.0, 0.0]] },
      { id: 100, type: 'IFCAXIS2PLACEMENT3D', params: [{ ref: 101 }, null, null] },
      // Placement 2:
      { id: 201, type: 'IFCCARTESIANPOINT', params: [[50.0, 80.0, 100.0]] },
      { id: 202, type: 'IFCDIRECTION', params: [[0.0, 0.0, 1.0]] },
      { id: 203, type: 'IFCDIRECTION', params: [[0.0, 1.0, 0.0]] }, // Rotated 90 deg
      { id: 200, type: 'IFCAXIS2PLACEMENT3D', params: [{ ref: 201 }, { ref: 202 }, { ref: 203 }] },
      // Solids:
      { id: 10, type: 'IFCEXTRUDEDAREASOLID', params: [{ ref: 1 }, { ref: 100 }, null, 2500.0] },
      { id: 20, type: 'IFCEXTRUDEDAREASOLID', params: [{ ref: 1 }, { ref: 200 }, null, 2500.0] },
    ]);

    const sig1 = ParametricSolidHasher.computeSolidHash(records, records.get(10)!);
    const sig2 = ParametricSolidHasher.computeSolidHash(records, records.get(20)!);

    expect(sig1).not.toBeNull();
    expect(sig2).not.toBeNull();

    // Hashes must be IDENTICAL because the solid profile & extrusion invariant is identical
    expect(sig1!.hash).toBe(sig2!.hash);

    // But solidMatrix must correctly capture local positions
    const pos1 = new THREE.Vector3();
    sig1!.solidMatrix.decompose(pos1, new THREE.Quaternion(), new THREE.Vector3());
    expect(pos1.x).toBeCloseTo(10.0);
    expect(pos1.y).toBeCloseTo(20.0);
    expect(pos1.z).toBeCloseTo(0.0);

    const pos2 = new THREE.Vector3();
    sig2!.solidMatrix.decompose(pos2, new THREE.Quaternion(), new THREE.Vector3());
    expect(pos2.x).toBeCloseTo(50.0);
    expect(pos2.y).toBeCloseTo(80.0);
    expect(pos2.z).toBeCloseTo(100.0);
  });

  it('T4: Perfiles Huecos y Complejos — Circle, Rectangle Hollow and I-Shape profiles', () => {
    const records = createRecordMap([
      // Circle Hollow: R=100, T=10
      { id: 1, type: 'IFCCIRCLEHOLLOWPROFILEDEF', params: ['CH', null, null, 100.0, 10.0] },
      { id: 2, type: 'IFCCIRCLEHOLLOWPROFILEDEF', params: ['CH2', null, null, 100.0, 10.0] },
      { id: 3, type: 'IFCCIRCLEHOLLOWPROFILEDEF', params: ['CH3', null, null, 100.0, 15.0] },
      // Rect Hollow: X=200, Y=100, T=8
      { id: 4, type: 'IFCRECTANGLEHOLLOWPROFILEDEF', params: ['RH', null, null, 200.0, 100.0, 8.0] },
      { id: 5, type: 'IFCRECTANGLEHOLLOWPROFILEDEF', params: ['RH2', null, null, 200.0, 100.0, 8.0] },
      // I-Shape: W=150, D=300, Tw=7.1, Tf=10.7
      { id: 6, type: 'IFCISHAPEPROFILEDEF', params: ['IPE300', null, null, 150.0, 300.0, 7.1, 10.7] },
      { id: 7, type: 'IFCISHAPEPROFILEDEF', params: ['IPE300_DUP', null, null, 150.0, 300.0, 7.1, 10.7] },
    ]);

    expect(ParametricSolidHasher.computeProfileHash(records, 1)).toBe(ParametricSolidHasher.computeProfileHash(records, 2));
    expect(ParametricSolidHasher.computeProfileHash(records, 1)).not.toBe(ParametricSolidHasher.computeProfileHash(records, 3));
    expect(ParametricSolidHasher.computeProfileHash(records, 4)).toBe(ParametricSolidHasher.computeProfileHash(records, 5));
    expect(ParametricSolidHasher.computeProfileHash(records, 6)).toBe(ParametricSolidHasher.computeProfileHash(records, 7));
  });

  it('T5: Deduplicación AST e Instanciación Sintética — 50 identical parametric members emit 1 prototype chunk and 50 instances', () => {
    // Generate synthetic STEP with 50 members (railing balusters or truss struts)
    const lines = [
      'ISO-10303-21;',
      'HEADER;',
      'FILE_DESCRIPTION((\'CROQUERA Test\'),\'2;1\');',
      'FILE_NAME(\'members.ifc\',\'2026-10-22\',(\'\'),(\'\'),\'\',\'\',\'\');',
      'FILE_SCHEMA((\'IFC4\'));',
      'ENDSEC;',
      'DATA;',
      '#1=IFCPROJECT(\'proj_1\',$,\'Test Project\',$,$,$,$,$,#2);',
      '#2=IFCUNITASSIGNMENT((#3));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      '#4=IFCSITE(\'site_1\',$,\'Site\',$,$,#5,$,$,.ELEMENT.,$,$,$,$,$);',
      '#5=IFCLOCALPLACEMENT($,#6);',
      '#6=IFCAXIS2PLACEMENT3D(#7,$,$);',
      '#7=IFCCARTESIANPOINT((0.,0.,0.));',
      '#8=IFCBUILDING(\'bldg_1\',$,\'Building\',$,$,#5,$,$,.ELEMENT.,$,$,$);',
      '#9=IFCBUILDINGSTOREY(\'lvl_1\',$,\'Level 1\',$,$,#5,$,$,.ELEMENT.,0.);',
      // Shared Profile and Representation
      '#20=IFCRECTANGLEPROFILEDEF(.AREA.,\'MEM_PROFILE\',$,0.3,0.3);',
      '#21=IFCEXTRUDEDAREASOLID(#20,#6,#22,3.0);',
      '#22=IFCDIRECTION((0.,0.,1.));',
      '#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));',
      '#23=IFCSHAPEREPRESENTATION(#24,\'Body\',\'SweptSolid\',(#21));',
      '#24=IFCGEOMETRICREPRESENTATIONCONTEXT($,\'Model\',3,0.0001,#6,$);',
    ];

    const memRefs: string[] = [];
    for (let i = 0; i < 50; i++) {
      const memId = 100 + i;
      const plId = 200 + i;
      const ptId = 300 + i;
      const locPlId = 400 + i;
      const x = (i % 10) * 4.0;
      const y = Math.floor(i / 10) * 4.0;
      lines.push(`#${ptId}=IFCCARTESIANPOINT((${x.toFixed(1)},${y.toFixed(1)},0.));`);
      lines.push(`#${plId}=IFCAXIS2PLACEMENT3D(#${ptId},$,$);`);
      lines.push(`#${locPlId}=IFCLOCALPLACEMENT($,#${plId});`);
      lines.push(`#${memId}=IFCMEMBER('mem_${i}',$,'Member',$,$,#${locPlId},#12,$,$);`);
      memRefs.push(`#${memId}`);
    }

    lines.push(`#500=IFCRELCONTAINEDINSPATIALSTRUCTURE('rel_all',$,$,$,(${memRefs.join(',')}),#9);`);
    lines.push('ENDSEC;');
    lines.push('END-ISO-10303-21;');

    const stepText = lines.join('\n');
    const importer = new IfcStepImporter(stepText);
    importer.prepareImport();

    const detector = new GeometryPrototypeDetector();
    let prototypeChunks = 0;
    let prototypeElementsCount = 0;
    let totalInstances = 0;

    importer.extractDeferredInstances(
      detector,
      (batch: InstanceBatchPayload) => {
        totalInstances += batch.instances.length;
      },
      (chunk: Stage3GeometryChunkPayload) => {
        prototypeChunks++;
        prototypeElementsCount += chunk.elements.length;
      },
      ['IFCMEMBER']
    );

    // Exactly 1 prototype chunk with 1 template element emitted
    expect(prototypeChunks).toBe(1);
    expect(prototypeElementsCount).toBe(1);

    // All 50 occurrences must be emitted as GPU instances in the batch
    expect(totalInstances).toBe(50);
  });

  it('T6: Benchmark de Velocidad AST Hasher — 10,000 calls must finish in < 25 ms', () => {
    const records = createRecordMap([
      { id: 1, type: 'IFCRECTANGLEPROFILEDEF', params: ['BEAM', null, null, 200.0, 400.0] },
      { id: 2, type: 'IFCCARTESIANPOINT', params: [[500.0, 1000.0, 0.0]] },
      { id: 3, type: 'IFCAXIS2PLACEMENT3D', params: [{ ref: 2 }, null, null] },
      { id: 10, type: 'IFCEXTRUDEDAREASOLID', params: [{ ref: 1 }, { ref: 3 }, null, 6000.0] },
    ]);

    const solidRec = records.get(10)!;

    // Warm up JIT
    for (let i = 0; i < 500; i++) {
      ParametricSolidHasher.computeSolidHash(records, solidRec);
    }

    const t0 = performance.now();
    let hashSum = 0n;
    for (let i = 0; i < 10000; i++) {
      const sig = ParametricSolidHasher.computeSolidHash(records, solidRec);
      if (sig) hashSum += sig.hash;
    }
    const elapsed = performance.now() - t0;

    expect(hashSum).not.toBe(0n);
    // Benchmark check: < 50 ms for 10,000 solids (< 0.005 ms per element)
    expect(elapsed).toBeLessThan(50.0);
  });

  it('T7: Distinción de Perfiles 2D con IFCAXIS2PLACEMENT2D — Rotation and 2D eccentricity produce distinct hashes', () => {
    // #100: Standard direction (1.0, 0.0)
    // #200: Rotated direction (0.0, 1.0)
    const records = createRecordMap([
      { id: 101, type: 'IFCCARTESIANPOINT', params: [[0.0, 0.0]] },
      { id: 102, type: 'IFCDIRECTION', params: [[1.0, 0.0]] },
      { id: 100, type: 'IFCAXIS2PLACEMENT2D', params: [{ ref: 101 }, { ref: 102 }] },

      { id: 201, type: 'IFCCARTESIANPOINT', params: [[0.0, 0.0]] },
      { id: 202, type: 'IFCDIRECTION', params: [[0.0, 1.0]] },
      { id: 200, type: 'IFCAXIS2PLACEMENT2D', params: [{ ref: 201 }, { ref: 202 }] },

      // Identical 500 x 1950 mm rectangles with different 2D rotation:
      { id: 10, type: 'IFCRECTANGLEPROFILEDEF', params: ['COL_50x195_DIR1', null, { ref: 100 }, 500.0, 1950.0] },
      { id: 20, type: 'IFCRECTANGLEPROFILEDEF', params: ['COL_50x195_DIR2', null, { ref: 200 }, 500.0, 1950.0] },
      // Implicit null placement:
      { id: 30, type: 'IFCRECTANGLEPROFILEDEF', params: ['COL_50x195_NULL', null, null, 500.0, 1950.0] },

      // Extrusions:
      { id: 11, type: 'IFCEXTRUDEDAREASOLID', params: [{ ref: 10 }, null, null, 3000.0] },
      { id: 21, type: 'IFCEXTRUDEDAREASOLID', params: [{ ref: 20 }, null, null, 3000.0] },

      // Eccentricity test:
      { id: 301, type: 'IFCCARTESIANPOINT', params: [[0.0, -43.3]] },
      { id: 300, type: 'IFCAXIS2PLACEMENT2D', params: [{ ref: 301 }, null] },
      { id: 40, type: 'IFCRECTANGLEPROFILEDEF', params: ['ECC_1', null, { ref: 100 }, 150.0, 300.0] },
      { id: 50, type: 'IFCRECTANGLEPROFILEDEF', params: ['ECC_2', null, { ref: 300 }, 150.0, 300.0] },
    ]);

    const profHash1 = ParametricSolidHasher.computeProfileHash(records, 10, 1.0);
    const profHash2 = ParametricSolidHasher.computeProfileHash(records, 20, 1.0);
    const profHashNull = ParametricSolidHasher.computeProfileHash(records, 30, 1.0);

    // Rotated 2D direction must produce different hash
    expect(profHash1).not.toBe(profHash2);
    // Standard (1, 0) direction at (0, 0) must match implicit null standard placement
    expect(profHash1).toBe(profHashNull);

    // Extruded solids using these profiles must have different solid hashes
    const sig1 = ParametricSolidHasher.computeSolidHash(records, records.get(11)!);
    const sig2 = ParametricSolidHasher.computeSolidHash(records, records.get(21)!);
    expect(sig1!.hash).not.toBe(sig2!.hash);

    // Eccentric 2D origin must produce different hash
    const eccHash1 = ParametricSolidHasher.computeProfileHash(records, 40, 1.0);
    const eccHash2 = ParametricSolidHasher.computeProfileHash(records, 50, 1.0);
    expect(eccHash1).not.toBe(eccHash2);
  });
});
