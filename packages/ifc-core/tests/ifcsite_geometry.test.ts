import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';

describe('IfcSite Geometry and Corner Window Multi-Layer Piercing', () => {
  const filePath = 'C:/Users/CyD/Downloads/LTU_A-House_2014-09-25_ifc/LTU_A-House_redesign.ifc';
  const fileExists = fs.existsSync(filePath);

  it.skipIf(!fileExists)('extracts physical IfcSite terrain mesh with materials and establishes ontological Group hierarchy', () => {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    const spatial = importer.extractSpatialHierarchy();
    const bounds = importer.extractProductBounds();

    // 1. Verify Site #1359 is present in boundsDTOs
    const siteBound = bounds.elements.find((e) => e.stepId === 1359);
    expect(siteBound).toBeDefined();
    expect(siteBound!.ifcType).toBe('IfcSite');
    expect(siteBound!.type).toBe('GROUP');

    // 2. Extract geometry chunks filtering for Site #1359
    importer['productRecordsList'] = [scanner.getRecord(1359)!];
    const chunks = Array.from(importer.extractGeometryChunks(100));
    expect(chunks.length).toBeGreaterThan(0);

    const siteElements = chunks.flatMap((c) => c.elements);
    const groupElement = siteElements.find((e) => e.type === 'GROUP' && e.stepId === 1359);
    expect(groupElement).toBeDefined();
    expect(groupElement!.ifcType).toBe('IfcSite');

    const geometryChildren = siteElements.filter((e) => e.type === 'GEOMETRY_ENTITY' && e.stepId === 1359);
    expect(geometryChildren.length).toBe(13);

    // Verify all children have parentId set to the site group
    for (const child of geometryChildren) {
      expect(child.parentId).toBe(groupElement!.id);
      expect(child.positions.length).toBeGreaterThan(0);
    }

    // Verify terrain grass, earth, pavement, and boundary materials are registered
    const materials = geometryChildren.map((c) => c.materialId);
    expect(materials).toContain('mat_ifc_004000'); // Landskap-Gräs 2
    expect(materials).toContain('mat_ifc_6f544a'); // Färg-12
    expect(materials).toContain('mat_ifc_a8a8a8'); // Färg-02
    expect(materials).toContain('mat_ifc_ffffff'); // Färg-01
  });

  it.skipIf(!fileExists)('correctly carves through-hole in multi-layer corner cladding Wall 3194871', () => {
    const buf = fs.readFileSync(filePath);
    const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    importer.extractSpatialHierarchy();
    importer.prepareImport();

    const wallRec = scanner.getRecord(3194871)!;
    const ent = importer['rebuildProductEntity'](wallRec, null)!;
    expect(ent.polyMesh).toBeDefined();

    importer['carveOpeningsIntoMesh'](3194871, ent.polyMesh!);

    // Verify both outer face (Z ~ 0.28) and inner face (Z ~ 0.20) are perforated with through-hole
    const frontFaces = Array.from(ent.polyMesh!.faces.values()).filter(
      (f) => Math.abs(f.normal.z - 1.0) < 0.05
    );
    const backFaces = Array.from(ent.polyMesh!.faces.values()).filter(
      (f) => Math.abs(f.normal.z + 1.0) < 0.05
    );

    // Each perforated face is divided into 3 pieces around the window cut (bottom, left, right)
    expect(frontFaces.length).toBe(3);
    expect(backFaces.length).toBe(3);

    // Verify window jamb faces exist and have the opening ID
    const jambFaces = Array.from(ent.polyMesh!.faces.values()).filter((f) => f.openingId);
    expect(jambFaces.length).toBe(4); // 4 window reveals/jambs (top, bottom, left, right)
  });
});
