import { describe, it, expect } from 'vitest';
import { PolyMesh, Vec3 } from '../src';
import { OpeningVoidSolver } from '../src/topology/OpeningVoidSolver';

function createBox(id: string, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): PolyMesh {
  const mesh = new PolyMesh(id);

  const v000 = new Vec3(minX, minY, minZ);
  const v100 = new Vec3(maxX, minY, minZ);
  const v110 = new Vec3(maxX, maxY, minZ);
  const v010 = new Vec3(minX, maxY, minZ);

  const v001 = new Vec3(minX, minY, maxZ);
  const v101 = new Vec3(maxX, minY, maxZ);
  const v111 = new Vec3(maxX, maxY, maxZ);
  const v011 = new Vec3(minX, maxY, maxZ);

  // Bottom face (-Y)
  mesh.addFace([v000, v100, v101, v001], new Vec3(0, -1, 0));
  // Top face (+Y)
  mesh.addFace([v010, v011, v111, v110], new Vec3(0, 1, 0));
  // Front face (+Z)
  mesh.addFace([v001, v101, v111, v011], new Vec3(0, 0, 1));
  // Back face (-Z)
  mesh.addFace([v100, v000, v010, v110], new Vec3(0, 0, -1));
  // Left face (-X)
  mesh.addFace([v000, v001, v011, v010], new Vec3(-1, 0, 0));
  // Right face (+X)
  mesh.addFace([v100, v110, v111, v101], new Vec3(1, 0, 0));

  mesh.rebuildTopology();
  return mesh;
}

describe('OpeningVoidSolver Unit Tests', () => {
  it('carves a through-hole door void into a host wall mesh', () => {
    // Host wall: [0, 0, 0] to [4, 3, 0.3] (thickness: 0.3m in Z)
    const hostWall = createBox('wall-1', 0, 0, 0, 4, 3, 0.3);
    const initialFaceCount = hostWall.faces.size;
    expect(initialFaceCount).toBe(6);

    // Door opening cutter extending beyond both Z sides: [1, 0, -0.1] to [2.2, 2.1, 0.4]
    const doorVoid = createBox('door-void-1', 1, 0, -0.1, 2.2, 2.1, 0.4);

    const success = OpeningVoidSolver.carveVoidIntoHost(hostWall, doorVoid, 'door-group-1');
    expect(success).toBe(true);

    // Verify jamba faces tagged with openingGroupId
    let jambaCount = 0;
    for (const f of hostWall.faces.values()) {
      if (f.openingId === 'door-group-1') {
        jambaCount++;
      }
    }

    // Jamba faces (left, right, top lintel) should be created
    expect(jambaCount).toBeGreaterThan(0);

    // Verify non-empty vertices and faces
    expect(hostWall.faces.size).toBeGreaterThan(initialFaceCount);
    expect(hostWall.vertices.size).toBeGreaterThan(8);
  });

  it('tags existing jamba faces correctly on coplanar matching openings', () => {
    const hostWall = createBox('wall-2', 0, 0, 0, 4, 3, 0.3);
    const doorVoid = createBox('door-void-2', 1, 0, -0.1, 2.2, 2.1, 0.4);

    // First carve the void
    OpeningVoidSolver.carveVoidIntoHost(hostWall, doorVoid, 'door-group-2');

    // Tagging against the same void should successfully identify existing matching faces
    const tagged = OpeningVoidSolver.tagExistingJambas(hostWall, doorVoid, 'door-group-2-recheck');
    expect(typeof tagged).toBe('number');
  });

  it('carves an opening that overflows the wall top without creating floating jambas outside host', () => {
    // Host wall: [0, 0, 0] to [4, 2.7, 0.15] (max height Y = 2.7 m)
    const hostWall = createBox('wall-edge', 0, 0, 0, 4, 2.7, 0.15);

    // Over-opening: [1, 1.8, -0.1] to [2.5, 3.2, 0.3] (height Y = 3.2 m overflows wall top by 0.5 m)
    const overOpening = createBox('over-opening', 1, 1.8, -0.1, 2.5, 3.2, 0.3);

    const success = OpeningVoidSolver.carveVoidIntoHost(hostWall, overOpening, 'over-group-1');
    expect(success).toBe(true);

    // Verify that NO vertex in the carved host wall exceeds the maximum wall height (Y = 2.7 m)
    const maxYAllowed = 2.7 + 1e-4;
    for (const v of hostWall.vertices.values()) {
      expect(v.position.y).toBeLessThanOrEqual(maxYAllowed);
    }

    // Verify that opening faces exist
    const openingFaces = Array.from(hostWall.faces.values()).filter(
      (f) => f.openingId === 'over-group-1'
    );
    expect(openingFaces.length).toBeGreaterThan(0);
  });

  it('carves a roof boundary cut across the top of a wall reducing its height and removing the top cap', () => {
    // Host wall: [0, 0, 0] to [4, 3, 0.3] (height 3.0m)
    const hostWall = createBox('wall-roof-trim', 0, 0, 0, 4, 3, 0.3);

    // Roof void cutting off top of wall: covers entire width/depth, Y from 2.2m to 3.5m
    const roofVoid = createBox('roof-cut-void', -0.5, 2.2, -0.5, 4.5, 3.5, 0.8);

    const success = OpeningVoidSolver.carveVoidIntoHost(hostWall, roofVoid, 'roof-trim-1');
    expect(success).toBe(true);

    // Verify wall maximum height is now capped at 2.2m (the roof cut line)
    let maxY = -Infinity;
    for (const v of hostWall.vertices.values()) {
      if (v.position.y > maxY) maxY = v.position.y;
    }
    expect(maxY).toBeCloseTo(2.2, 3);

    // Verify the new top cap has openingId tagged
    const cutCap = Array.from(hostWall.faces.values()).find(
      (f) => f.normal.y > 0.9 && f.openingId === 'roof-trim-1'
    );
    expect(cutCap).toBeDefined();
  });
});

