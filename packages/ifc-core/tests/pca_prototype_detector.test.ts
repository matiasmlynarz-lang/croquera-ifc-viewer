import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PCAAligner } from '../src/math/PCAAligner';
import {
  GeometryPrototypeDetector,
  M_CANONICAL,
  M_CANONICAL_INV,
} from '../src/detector/GeometryPrototypeDetector';

describe('PCAAligner & Canonical Prototype Detection', () => {
  // Helper to generate a rectangular box mesh with given dimensions
  function createBoxPositions(dx: number, dy: number, dz: number): Float32Array {
    const hx = dx / 2, hy = dy / 2, hz = dz / 2;
    // 8 vertices of a box
    const corners = [
      [-hx, -hy, -hz],
      [ hx, -hy, -hz],
      [ hx,  hy, -hz],
      [-hx,  hy, -hz],
      [-hx, -hy,  hz],
      [ hx, -hy,  hz],
      [ hx,  hy,  hz],
      [-hx,  hy,  hz],
    ];
    // 12 triangles = 36 vertices
    const faceIndices = [
      0, 1, 2,  0, 2, 3, // -Z
      4, 6, 5,  4, 7, 6, // +Z
      0, 4, 5,  0, 5, 1, // -Y
      2, 6, 7,  2, 7, 3, // +Y
      0, 3, 7,  0, 7, 4, // -X
      1, 5, 6,  1, 6, 2, // +X
    ];
    const pos = new Float32Array(faceIndices.length * 3);
    for (let i = 0; i < faceIndices.length; i++) {
      const c = corners[faceIndices[i]];
      pos[i * 3]     = c[0];
      pos[i * 3 + 1] = c[1];
      pos[i * 3 + 2] = c[2];
    }
    return pos;
  }

  // Helper to create an asymmetric L-shaped beam to test sign disambiguation (skewness)
  function createAsymmetricLBeam(): Float32Array {
    // Vertices concentrated on one side of each axis to have strong non-zero skewness
    const pts = [
      [0, 0, 0], [10, 0, 0], [10, 2, 0], [2, 2, 0], [2, 6, 0], [0, 6, 0],
      [0, 0, 1], [10, 0, 1], [10, 2, 1], [2, 2, 1], [2, 6, 1], [0, 6, 1],
    ];
    const pos = new Float32Array(pts.length * 3);
    for (let i = 0; i < pts.length; i++) {
      pos[i * 3]     = pts[i][0];
      pos[i * 3 + 1] = pts[i][1];
      pos[i * 3 + 2] = pts[i][2];
    }
    return pos;
  }

  // Helper to rotate a flat positions buffer by a given Matrix4
  function rotatePositions(positions: Float32Array, matrix: THREE.Matrix4): Float32Array {
    const out = new Float32Array(positions.length);
    const v = new THREE.Vector3();
    const count = Math.floor(positions.length / 3);
    for (let i = 0; i < count; i++) {
      v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      v.applyMatrix4(matrix);
      out[i * 3]     = v.x;
      out[i * 3 + 1] = v.y;
      out[i * 3 + 2] = v.z;
    }
    return out;
  }

  it('T1: Jacobi eigendecomposition decomposes known 3x3 symmetric covariance matrix', () => {
    // Generate an anisotropic ellipsoid point cloud with known variances (9, 4, 1)
    const N = 5000;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = (Math.PI * 2 * i) / N;
      const v = (Math.PI * (i % 100)) / 100;
      pos[i * 3]     = 3 * Math.cos(u) * Math.sin(v); // variance ~ 9/2
      pos[i * 3 + 1] = 2 * Math.sin(u) * Math.sin(v); // variance ~ 4/2
      pos[i * 3 + 2] = 1 * Math.cos(v);               // variance ~ 1
    }

    const pca = PCAAligner.computePCA(pos);
    expect(pca.eigenvalues[0]).toBeGreaterThan(pca.eigenvalues[1]);
    expect(pca.eigenvalues[1]).toBeGreaterThan(pca.eigenvalues[2]);
    expect(pca.eigenvalues[2]).toBeGreaterThan(0);

    // Verify rotation matrix is orthonormal and right-handed (det = +1)
    const det = pca.rotationMatrix.determinant();
    expect(Math.abs(det - 1.0)).toBeLessThan(1e-5);
  });

  it('T2: Eigenvalues and principal extents are strictly invariant under 3D rotations', () => {
    const baseBox = createBoxPositions(10, 4, 2);
    const basePCA = PCAAligner.computePCA(baseBox);

    // Rotate 90 degrees around Z
    const rotZ90 = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    const rotatedBoxZ90 = rotatePositions(baseBox, rotZ90);
    const pcaZ90 = PCAAligner.computePCA(rotatedBoxZ90);

    // Eigenvalues and principal extents must match within numerical tolerance
    expect(Math.abs(pcaZ90.extents[0] - basePCA.extents[0])).toBeLessThan(1e-4);
    expect(Math.abs(pcaZ90.extents[1] - basePCA.extents[1])).toBeLessThan(1e-4);
    expect(Math.abs(pcaZ90.extents[2] - basePCA.extents[2])).toBeLessThan(1e-4);

    expect(Math.abs(pcaZ90.eigenvalues[0] - basePCA.eigenvalues[0])).toBeLessThan(1e-4);
    expect(Math.abs(pcaZ90.eigenvalues[1] - basePCA.eigenvalues[1])).toBeLessThan(1e-4);
    expect(Math.abs(pcaZ90.eigenvalues[2] - basePCA.eigenvalues[2])).toBeLessThan(1e-4);

    // Rotate arbitrary 45 degrees around X and 30 degrees around Y
    const rotArb = new THREE.Matrix4()
      .makeRotationX(Math.PI / 4)
      .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 6));
    const rotatedBoxArb = rotatePositions(baseBox, rotArb);
    const pcaArb = PCAAligner.computePCA(rotatedBoxArb);

    expect(Math.abs(pcaArb.extents[0] - basePCA.extents[0])).toBeLessThan(1e-4);
    expect(Math.abs(pcaArb.extents[1] - basePCA.extents[1])).toBeLessThan(1e-4);
    expect(Math.abs(pcaArb.extents[2] - basePCA.extents[2])).toBeLessThan(1e-4);
  });

  it('T3: GeometryPrototypeDetector detects congruence with 90° baked rotation and decouples it', () => {
    const detector = new GeometryPrototypeDetector();

    // Box A: 10 x 4 x 2 located at world (0, 0, 0)
    const boxA = createBoxPositions(10, 4, 2);
    const placementA = new THREE.Matrix4().identity();

    const matchA = detector.checkOrRegister('element_A', 101, boxA, placementA);
    expect(matchA.isInstance).toBe(false);
    expect(matchA.prototypeId).toBe('element_A');
    expect(detector.totalPrototypes).toBe(1);
    expect(detector.totalInstancesDetected).toBe(0);

    // Box B: identical 10 x 4 x 2, but vertices were baked with a 90° rotation around Z,
    // and placed at world (5, 10, 0)
    const rotZ90 = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    const boxB = rotatePositions(boxA, rotZ90);
    const placementB = new THREE.Matrix4().makeTranslation(5, 10, 0);

    const matchB = detector.checkOrRegister('element_B', 102, boxB, placementB);
    expect(matchB.isInstance).toBe(true);
    expect(matchB.prototypeId).toBe('element_A'); // Successfully collapsed into prototype A!
    expect(detector.totalPrototypes).toBe(1);
    expect(detector.totalInstancesDetected).toBe(1);

    // Verification of GPU Reconstruction:
    // When InstancedMesh renders occurrence B using prototype A's canonical geometry:
    // v_rendered = M_croq_B · v_proto_croq
    // This must match B's world coordinates in Croquera Y-up space:
    // v_expected_croq = M_CANONICAL · placementB · v_B
    const M_to_proto_croq = matchA.toCanonicalCroqueraMatrix;
    const M_croq_B = new THREE.Matrix4().fromArray(matchB.transform);

    const numVerts = Math.floor(boxB.length / 3);
    for (let i = 0; i < numVerts; i++) {
      // 1. Prototype canonical vertex in Croquera space (derived from Box A)
      const vProtoCroq = new THREE.Vector3(boxA[i * 3], boxA[i * 3 + 1], boxA[i * 3 + 2])
        .applyMatrix4(M_to_proto_croq);

      // 2. Rendered vertex on GPU
      const vRendered = vProtoCroq.clone().applyMatrix4(M_croq_B);

      // 3. Expected world position in Croquera Y-up space
      const vExpectedCroq = new THREE.Vector3(boxB[i * 3], boxB[i * 3 + 1], boxB[i * 3 + 2])
        .applyMatrix4(placementB)
        .applyMatrix4(M_CANONICAL);

      // For symmetric box, any corner of box B must match a corner of the rendered mesh
      let minDiff = Infinity;
      for (let j = 0; j < numVerts; j++) {
        const vExpectedJ = new THREE.Vector3(boxB[j * 3], boxB[j * 3 + 1], boxB[j * 3 + 2])
          .applyMatrix4(placementB)
          .applyMatrix4(M_CANONICAL);
        const dist = vRendered.distanceTo(vExpectedJ);
        if (dist < minDiff) minDiff = dist;
      }
      expect(minDiff).toBeLessThan(1e-3); // 1 mm precision
    }
  });

  it('T4: Detects asymmetric geometry rotated by 180° via skewness sign disambiguation', () => {
    const detector = new GeometryPrototypeDetector();

    const beamA = createAsymmetricLBeam();
    const placementA = new THREE.Matrix4().identity();
    const matchA = detector.checkOrRegister('beam_A', 201, beamA, placementA);
    expect(matchA.isInstance).toBe(false);

    // Rotate beam by 180° around X
    const rotX180 = new THREE.Matrix4().makeRotationX(Math.PI);
    const beamB = rotatePositions(beamA, rotX180);
    const placementB = new THREE.Matrix4().makeTranslation(0, 0, 10);

    const matchB = detector.checkOrRegister('beam_B', 202, beamB, placementB);
    expect(matchB.isInstance).toBe(true);
    expect(matchB.prototypeId).toBe('beam_A');
  });

  it('T5: Rejects non-congruent geometries and creates separate prototypes', () => {
    const detector = new GeometryPrototypeDetector();

    // Box A: 10 x 4 x 2
    const boxA = createBoxPositions(10, 4, 2);
    const matchA = detector.checkOrRegister('box_1', 301, boxA, new THREE.Matrix4());
    expect(matchA.isInstance).toBe(false);

    // Box C: 10 x 4 x 3 (different thickness)
    const boxC = createBoxPositions(10, 4, 3);
    const matchC = detector.checkOrRegister('box_2', 302, boxC, new THREE.Matrix4());
    expect(matchC.isInstance).toBe(false);
    expect(matchC.prototypeId).toBe('box_2');
    expect(detector.totalPrototypes).toBe(2);
  });

  it('T6: Performance benchmark — evaluates 1,000 meshes in < 50ms', () => {
    const box = createBoxPositions(8, 3, 2);
    const tStart = performance.now();
    const iterations = 1000;

    for (let i = 0; i < iterations; i++) {
      PCAAligner.computePCA(box);
    }

    const elapsedMs = performance.now() - tStart;
    const avgMs = elapsedMs / iterations;
    expect(avgMs).toBeLessThan(0.05); // Must be faster than 0.05 ms per mesh
  });
});
