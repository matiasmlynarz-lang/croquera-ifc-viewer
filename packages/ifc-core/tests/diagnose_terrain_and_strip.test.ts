import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';
import { IfcStepImporter, IFC_PRIORITY_STRUCTURAL_TYPES } from '../src/importer/IfcStepImporter';
import { ParametricSolidHasher } from '../src/detector/ParametricSolidHasher';

describe('Regression: IfcSite Terrain Ingestion and Roof Terrace Flush Boundary', () => {
  const filePath = 'C:/Users/CyD/Downloads/LTU_A-House_2014-09-25_ifc/LTU_A-House_redesign.ifc';
  const fileExists = fs.existsSync(filePath);

  it.skipIf(!fileExists)('retains IfcSite terrain and courtyards when filtered with IFC_PRIORITY_STRUCTURAL_TYPES', () => {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    importer.setProductTypesFilter(IFC_PRIORITY_STRUCTURAL_TYPES);

    importer.extractSpatialHierarchy();
    const bounds = importer.extractProductBounds();

    const siteBound = bounds.elements.find((e) => e.stepId === 1359);
    expect(siteBound).toBeDefined();
    expect(siteBound!.ifcType).toBe('IfcSite');

    const chunks = importer.extractGeometryChunks(100, undefined, [1359]);
    const siteElements = chunks.flatMap((c) => c.elements);

    const geomChildren = siteElements.filter((e) => e.type === 'GEOMETRY_ENTITY' && e.stepId === 1359);
    expect(geomChildren.length).toBe(13);

    const materials = geomChildren.map((c) => c.materialId);
    expect(materials).toContain('mat_ifc_004000'); // Grass courtyards
  });

  it.skipIf(!fileExists)('differentiates sub-millimeter profiles of walls #5884873 and #5886709 in ParametricSolidHasher', () => {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    importer.extractSpatialHierarchy();
    importer.prepareImport();

    const recs = importer['records'];
    const w1Rec = scanner.getRecord(5884873)!;
    const w2Rec = scanner.getRecord(5886709)!;

    const rep1 = recs.get((w1Rec.params[6] as any).ref)!;
    const item1 = recs.get((recs.get((rep1.params[2] as any)[0].ref)!.params[3] as any)[0].ref)!;
    const sig1 = ParametricSolidHasher.computeSolidHash(recs, item1, 1.0);

    const rep2 = recs.get((w2Rec.params[6] as any).ref)!;
    const item2 = recs.get((recs.get((rep2.params[2] as any)[0].ref)!.params[3] as any)[0].ref)!;
    const sig2 = ParametricSolidHasher.computeSolidHash(recs, item2, 1.0);

    expect(sig1).not.toBeNull();
    expect(sig2).not.toBeNull();
    expect(sig1!.hash).not.toBe(sig2!.hash);
  });

  it.skipIf(!fileExists)('cuts wall #5886709 flush with roof terrace when extracted sequentially after #5884873', () => {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    importer.extractSpatialHierarchy();
    importer.extractProductBounds();

    const chunks = importer.extractGeometryChunks(100, undefined, [5884873, 5886709]);
    const elements = chunks.flatMap((c) => c.elements);

    const wall2 = elements.find((e) => e.stepId === 5886709 && e.type === 'GEOMETRY_ENTITY');
    expect(wall2).toBeDefined();

    let maxY = -Infinity;
    for (let i = 1; i < wall2!.positions.length; i += 3) {
      if (wall2!.positions[i] > maxY) maxY = wall2!.positions[i];
    }

    expect(maxY).toBeLessThanOrEqual(13.441);
  });
});
