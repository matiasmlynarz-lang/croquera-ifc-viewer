import { describe, it, expect } from 'vitest';
import { OnDemandRecordMap, type IIfcStreamingParser } from '../src/parser/IfcStreamingParser';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';
import type { StepRecord } from '../src/parser/IfcStepParser';

describe('Issue 1.3: Placement Memoization & Ephemeral Cache Filtering', () => {
  describe('OnDemandRecordMap Ephemeral Filtering & Batch Eviction', () => {
    it('does not cache ephemeral types (IFCCARTESIANPOINT, IFCPOLYLOOP, IFCFACE)', () => {
      const records = new Map<number, StepRecord>([
        [1, { id: 1, type: 'IFCCARTESIANPOINT', params: [[0, 0, 0]], rawLine: '#1=IFCCARTESIANPOINT((0,0,0));' }],
        [2, { id: 2, type: 'IFCPOLYLOOP', params: [[{ ref: 1 }]], rawLine: '#2=IFCPOLYLOOP((#1));' }],
        [3, { id: 3, type: 'IFCFACE', params: [[]], rawLine: '#3=IFCFACE(());' }],
        [10, { id: 10, type: 'IFCLOCALPLACEMENT', params: [null, { ref: 20 }], rawLine: '#10=IFCLOCALPLACEMENT($,#20);' }],
        [20, { id: 20, type: 'IFCAXIS2PLACEMENT3D', params: [{ ref: 1 }], rawLine: '#20=IFCAXIS2PLACEMENT3D(#1,$,$);' }],
      ]);

      const mockStreamingParser: IIfcStreamingParser = {
        totalEntities: 5,
        totalBytes: 1000,
        hasRecord: (id: number) => records.has(id),
        getRecordOnDemand: (id: number) => records.get(id),
        getRecordsByType: () => [],
        getRawSection: () => '',
        getByteRangesByType: () => [],
      };

      const map = new OnDemandRecordMap(mockStreamingParser, 100);

      // 1. Request ephemeral records
      const r1 = map.get(1);
      const r2 = map.get(2);
      const r3 = map.get(3);
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
      expect(r3).toBeDefined();

      // Access private cache via any for assertion
      const internalCache = (map as any).cache as Map<number, StepRecord>;
      expect(internalCache.has(1)).toBe(false);
      expect(internalCache.has(2)).toBe(false);
      expect(internalCache.has(3)).toBe(false);

      // 2. Request non-ephemeral structural records
      const r10 = map.get(10);
      const r20 = map.get(20);
      expect(r10).toBeDefined();
      expect(r20).toBeDefined();
      expect(internalCache.has(10)).toBe(true);
      expect(internalCache.has(20)).toBe(true);
    });

    it('performs batch eviction of 20% oldest entries when maxCacheSize is exceeded', () => {
      const records = new Map<number, StepRecord>();
      for (let i = 1; i <= 30; i++) {
        records.set(i, {
          id: i,
          type: 'IFCLOCALPLACEMENT',
          params: [],
          rawLine: `#${i}=IFCLOCALPLACEMENT;`,
        });
      }

      const mockStreamingParser: IIfcStreamingParser = {
        totalEntities: 30,
        totalBytes: 1000,
        hasRecord: (id: number) => records.has(id),
        getRecordOnDemand: (id: number) => records.get(id),
        getRecordsByType: () => [],
        getRawSection: () => '',
        getByteRangesByType: () => [],
      };

      // Set small cache limit of 10
      const map = new OnDemandRecordMap(mockStreamingParser, 10);
      const internalCache = (map as any).cache as Map<number, StepRecord>;

      for (let i = 1; i <= 10; i++) {
        map.get(i);
      }
      expect(internalCache.size).toBe(10);

      // Inserting 11th record triggers batch eviction of 20% (Math.floor(10 * 0.2) = 2 entries)
      map.get(11);
      // Size becomes: 10 - 2 (evicted #1, #2) + 1 (#11) = 9
      expect(internalCache.size).toBe(9);
      expect(internalCache.has(1)).toBe(false);
      expect(internalCache.has(2)).toBe(false);
      expect(internalCache.has(3)).toBe(true);
      expect(internalCache.has(11)).toBe(true);
    });
  });

  describe('IfcStepImporter Placement Matrix Memoization', () => {
    const samplePlacementIfc = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_placement.ifc','2026-10-22',('User'),('Org'),'Croquera','Croquera','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$r_g_0000000000000001',$,'Test Project',$,$,$,$,$,$);
#2= IFCSITE('0$r_g_0000000000000002',$,'Default Site',$,$,$,$,$,$,$,$,$,$,$);
#3= IFCBUILDING('0$r_g_0000000000000003',$,'Default Building',$,$,$,$,$,$,$,$,$);
#4= IFCBUILDINGSTOREY('0$r_g_0000000000000004',$,'Storey 1',$,$,$,$,$,$,0.0);
#10= IFCCARTESIANPOINT((5.,10.,15.));
#11= IFCDIRECTION((0.,0.,1.));
#12= IFCDIRECTION((1.,0.,0.));
#13= IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14= IFCLOCALPLACEMENT($,#13);
#20= IFCCARTESIANPOINT((1.,2.,3.));
#21= IFCAXIS2PLACEMENT3D(#20,#11,#12);
#22= IFCLOCALPLACEMENT(#14,#21);
#30= IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.)));
#31= IFCTRIANGULATEDFACESET(#30,$,.F.,((1,2,3)),$);
#32= IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#31));
#33= IFCPRODUCTDEFINITIONSHAPE($,$,(#32));
#40= IFCWALL('0$r_g_0000000000000010',$,'Wall A',$,$,#22,#33,$,.SOLIDWALL.);
#41= IFCWALL('0$r_g_0000000000000011',$,'Wall B',$,$,#22,#33,$,.SOLIDWALL.);
#50= IFCRELAGGREGATES('0$r_g_0000000000000020',$,$,$,#4,(#40,#41));
ENDSEC;
END-ISO-10303-21;
`;

    it('memoizes resolveLocalPlacementMatrix and resolveAxis2Placement3D returning defensive clones', () => {
      const importer = new IfcStepImporter(samplePlacementIfc);
      importer.prepareImport();

      // Access private methods via any for unit test verification
      const m1 = (importer as any).resolveLocalPlacementMatrix(22);
      expect(m1).toBeDefined();

      const placementCache = (importer as any).placementMatrixCache as Map<number, any>;
      const axis2Cache = (importer as any).axis2PlacementCache as Map<number, any>;

      // Both #14 and #22 placements should be in cache
      expect(placementCache.has(14)).toBe(true);
      expect(placementCache.has(22)).toBe(true);

      // Both #13 and #21 Axis2 placements should be in cache
      expect(axis2Cache.has(13)).toBe(true);
      expect(axis2Cache.has(21)).toBe(true);

      // Second retrieval must return an identical matrix in O(1)
      const m2 = (importer as any).resolveLocalPlacementMatrix(22);
      expect(m2.elements).toEqual(m1.elements);

      // Mutating m2 must NOT corrupt the cached matrix (Rule of Defensive Cloning)
      m2.elements[12] = 999999;
      const m3 = (importer as any).resolveLocalPlacementMatrix(22);
      expect(m3.elements[12]).not.toBe(999999);
      expect(m3.elements[12]).toBe(m1.elements[12]);
    });
  });
});
