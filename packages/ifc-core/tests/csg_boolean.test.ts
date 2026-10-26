import { describe, it, expect } from 'vitest';
import { BooleanCSGKernel, PolyMesh, Vec3 } from '../src';

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

function getMeshBounds(mesh: PolyMesh) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const v of mesh.vertices.values()) {
    minX = Math.min(minX, v.position.x);
    minY = Math.min(minY, v.position.y);
    minZ = Math.min(minZ, v.position.z);
    maxX = Math.max(maxX, v.position.x);
    maxY = Math.max(maxY, v.position.y);
    maxZ = Math.max(maxZ, v.position.z);
  }

  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

describe('BooleanCSGKernel Unit Tests', () => {
  it('performs regularized subtraction (A \\* B) on overlapping cubes', () => {
    // Base solid A: [0, 0, 0] to [2, 2, 2]
    const solidA = createBox('A', 0, 0, 0, 2, 2, 2);
    // Cutter solid B: [1, -0.5, -0.5] to [3, 2.5, 2.5] (cuts off the right half)
    const solidB = createBox('B', 1, -0.5, -0.5, 3, 2.5, 2.5);

    const result = BooleanCSGKernel.subtract(solidA, solidB);
    expect(result).toBeDefined();
    expect(result.faces.size).toBeGreaterThan(0);

    const box = getMeshBounds(result);
    expect(box.min.x).toBeCloseTo(0, 2);
    expect(box.max.x).toBeCloseTo(1, 2); // Right half subtracted
  });

  it('performs regularized union (A U* B) on adjacent/overlapping cubes', () => {
    const solidA = createBox('A', 0, 0, 0, 2, 2, 2);
    const solidB = createBox('B', 1, 0, 0, 3, 2, 2);

    const result = BooleanCSGKernel.union(solidA, solidB);
    expect(result).toBeDefined();
    expect(result.faces.size).toBeGreaterThan(0);

    const box = getMeshBounds(result);
    expect(box.min.x).toBeCloseTo(0, 2);
    expect(box.max.x).toBeCloseTo(3, 2);
  });

  it('preserves top and bottom caps with holes when cutting a hole through the center of a slab', () => {
    // Large slab A: [0, 0, 0] to [10, 1, 10]
    const slabA = createBox('SlabA', 0, 0, 0, 10, 1, 10);
    // Through-cutter B in the center: [4, -0.5, 4] to [6, 1.5, 6] (punches a 2x2 hole through Y=0 to Y=1)
    const cutterB = createBox('CutterB', 4, -0.5, 4, 6, 1.5, 6);

    const result = BooleanCSGKernel.subtract(slabA, cutterB);
    expect(result).toBeDefined();

    // Verify top (+Y) and bottom (-Y) caps exist and retain the cutout hole
    let topCaps = 0;
    let bottomCaps = 0;
    let topHolesCount = 0;
    let bottomHolesCount = 0;

    for (const face of result.faces.values()) {
      if (face.normal.y > 0.9) {
        topCaps++;
        topHolesCount += face.holes?.length || 0;
      } else if (face.normal.y < -0.9) {
        bottomCaps++;
        bottomHolesCount += face.holes?.length || 0;
      }
    }

    expect(topCaps).toBeGreaterThanOrEqual(1);
    expect(bottomCaps).toBeGreaterThanOrEqual(1);
    expect(topHolesCount).toBe(1);
    expect(bottomHolesCount).toBe(1);
  });

  it('preserves multiple sequential through-hole subtractions without re-materializing previously cut holes', () => {
    // Large slab: [0, 0, 0] to [15, 1, 15]
    const slabA = createBox('SlabA', 0, 0, 0, 15, 1, 15);
    // Hole 1: [2, -0.5, 2] to [5, 1.5, 5]
    const cutter1 = createBox('Cutter1', 2, -0.5, 2, 5, 1.5, 5);
    // Hole 2: [8, -0.5, 8] to [11, 1.5, 11] (distinct room/opening)
    const cutter2 = createBox('Cutter2', 8, -0.5, 8, 11, 1.5, 11);

    const step1 = BooleanCSGKernel.subtract(slabA, cutter1);
    const step2 = BooleanCSGKernel.subtract(step1, cutter2);

    expect(step2).toBeDefined();

    let topFacesCount = 0;
    let bottomFacesCount = 0;
    let topHolesTotal = 0;
    let bottomHolesTotal = 0;

    for (const face of step2.faces.values()) {
      if (face.normal.y > 0.9) {
        topFacesCount++;
        topHolesTotal += face.holes?.length || 0;
      } else if (face.normal.y < -0.9) {
        bottomFacesCount++;
        bottomHolesTotal += face.holes?.length || 0;
      }
    }

    // Exactly 1 top cap with 2 holes and 1 bottom cap with 2 holes (NO re-materialized solid cap filling hole 1!)
    expect(topFacesCount).toBe(1);
    expect(bottomFacesCount).toBe(1);
    expect(topHolesTotal).toBe(2);
    expect(bottomHolesTotal).toBe(2);
  });

  it('correctly clips a wall corner using a polygonal bounded half-space prism without collapsing the wall', () => {
    // Base wall A: [0, -0.0125, 0] to [3.375, 0.0125, 2.70] (dimensions of wall 3ueuomZd9CNA4hUyetwW_z)
    const wallA = createBox('WallA', 0, -0.0125, 0, 3.375, 0.0125, 2.70);

    // Miter cutter prism B at the corner: [3.3625, -0.0125, 0] to [50.0, 0.0125, 2.10]
    // Only cuts a 1.25 cm notch at the end up to 2.10m height
    const cornerCutter = createBox('CornerCutter', 3.3625, -0.015, -0.01, 50.0, 0.015, 2.10);

    const clippedWall = BooleanCSGKernel.subtract(wallA, cornerCutter);
    expect(clippedWall).toBeDefined();
    expect(clippedWall.faces.size).toBeGreaterThan(0);

    const bounds = getMeshBounds(clippedWall);
    // Preserves the full starting point X = 0
    expect(bounds.min.x).toBeCloseTo(0, 3);
    // The top part of the wall (Z > 2.10) still reaches the full 3.375m
    expect(bounds.max.x).toBeCloseTo(3.375, 3);
    // Preserves the full height Z = 2.70
    expect(bounds.max.z).toBeCloseTo(2.70, 3);
  });
});


