/**
 * Vec3 — Immutable 3D vector for @croquera/ifc-core.
 *
 * All operations return new instances; the original is never mutated.
 * Provides adapters to/from THREE.Vector3 for viewport communication.
 */
import * as THREE from 'three';
import { GeometryTolerance } from './GeometryTolerance';

export class Vec3 {
  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly z: number,
  ) {}

  // ─── Constants ──────────────────────────────────────────────
  static readonly ZERO = new Vec3(0, 0, 0);
  static readonly X = new Vec3(1, 0, 0);
  static readonly Y = new Vec3(0, 1, 0);
  static readonly Z = new Vec3(0, 0, 1);
  static readonly NEG_X = new Vec3(-1, 0, 0);
  static readonly NEG_Y = new Vec3(0, -1, 0);
  static readonly NEG_Z = new Vec3(0, 0, -1);

  // ─── Arithmetic ─────────────────────────────────────────────
  add(v: Vec3): Vec3 {
    return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z);
  }

  sub(v: Vec3): Vec3 {
    return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  scale(s: number): Vec3 {
    return new Vec3(this.x * s, this.y * s, this.z * s);
  }

  negate(): Vec3 {
    return new Vec3(-this.x, -this.y, -this.z);
  }

  // ─── Products ───────────────────────────────────────────────
  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v: Vec3): Vec3 {
    return new Vec3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x,
    );
  }

  // ─── Magnitudes ─────────────────────────────────────────────
  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  normalize(): Vec3 {
    const len = this.length();
    if (len < GeometryTolerance.MATH_EPSILON) return Vec3.ZERO;
    return this.scale(1 / len);
  }

  // ─── Distances & Interpolation ──────────────────────────────
  distanceTo(v: Vec3): number {
    return this.sub(v).length();
  }

  distanceToSq(v: Vec3): number {
    return this.sub(v).lengthSq();
  }

  lerp(v: Vec3, t: number): Vec3 {
    return new Vec3(
      this.x + (v.x - this.x) * t,
      this.y + (v.y - this.y) * t,
      this.z + (v.z - this.z) * t,
    );
  }

  // ─── Comparisons ────────────────────────────────────────────
  equals(v: Vec3, tolerance: number = GeometryTolerance.MATH_EPSILON): boolean {
    return (
      Math.abs(this.x - v.x) < tolerance &&
      Math.abs(this.y - v.y) < tolerance &&
      Math.abs(this.z - v.z) < tolerance
    );
  }

  isZero(tolerance: number = GeometryTolerance.MATH_EPSILON): boolean {
    return this.lengthSq() < tolerance * tolerance;
  }

  // ─── Projection ─────────────────────────────────────────────
  /** Project this vector onto direction `onto` (must be unit length for accurate result). */
  projectOnto(onto: Vec3): Vec3 {
    const d = onto.dot(onto);
    if (d < GeometryTolerance.MATH_EPSILON) return Vec3.ZERO;
    return onto.scale(this.dot(onto) / d);
  }

  /** Component of this vector perpendicular to `onto`. */
  rejectFrom(onto: Vec3): Vec3 {
    return this.sub(this.projectOnto(onto));
  }

  // ─── Angle ──────────────────────────────────────────────────
  /** Angle in radians between this and v. */
  angleTo(v: Vec3): number {
    const d = this.length() * v.length();
    if (d < GeometryTolerance.MATH_EPSILON) return 0;
    return Math.acos(Math.max(-1, Math.min(1, this.dot(v) / d)));
  }

  applyMatrix4(m: THREE.Matrix4): Vec3 {
    const v = this.toThree().applyMatrix4(m);
    return new Vec3(v.x, v.y, v.z);
  }

  // ─── Conversion: Three.js ───────────────────────────────────
  toThree(): THREE.Vector3 {
    return new THREE.Vector3(this.x, this.y, this.z);
  }

  static fromThree(v: THREE.Vector3): Vec3 {
    return new Vec3(v.x, v.y, v.z);
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  static fromArray(a: ArrayLike<number>, offset = 0): Vec3 {
    return new Vec3(a[offset], a[offset + 1], a[offset + 2]);
  }

  toString(): string {
    return `Vec3(${this.x.toFixed(4)}, ${this.y.toFixed(4)}, ${this.z.toFixed(4)})`;
  }
}
