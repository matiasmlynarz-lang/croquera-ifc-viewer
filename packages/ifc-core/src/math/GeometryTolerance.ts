/**
 * GeometryTolerance — Single authoritative source for all geometric tolerances in @croquera/ifc-core.
 *
 * Centralizes all numerical thresholds, tolerances, and epsilon values to prevent drift across solvers.
 */

const MATH_EPSILON = 1e-10;
const COINCIDENT_POINT = 1e-4;
const COINCIDENT_POINT_SQ = 1e-8;
const SPATIAL_GRID_CELL_SIZE = 2e-4; // 0.2 mm spatial grid cell for hashing
const COINCIDENT_VERTEX = 1e-4; // 0.1 mm
const MIN_EDGE_LENGTH = 1e-4;   // 0.1 mm
const COPLANAR_NORMAL = 1e-5;
const POINT_ON_PLANE = 1e-4;    // 0.1 mm
const MIN_FACE_AREA = 1e-8;      // 0.01 mm²
const COINCIDENT_AREA_MIN = 1e-8;
const ANGULAR_EPSILON = 1e-4;   // rad (~0.0057°)
const SNAP_TOLERANCE = 0.02;    // 2 cm UI snap
const OPENING_JAMB_NORMAL_TOLERANCE = 0.005;
const OPENING_JAMB_DISTANCE_TOLERANCE = 0.001; // 1 mm
const OPENING_DIRECTION_ALIGNMENT_DOT = 0.85;
const OPENING_PARALLEL_CAP_DOT = 0.95;
const OPENING_SLANTED_CAP_DOT = 0.70;
const OPENING_OPPOSITE_NORMAL_DOT = -0.85;
const OPENING_VERTICAL_NORMAL_DOT = 0.70;
const OPENING_STRICT_OPPOSITE_DOT = -0.90;
const STOREY_ELEVATION_TOLERANCE = 0.05; // 5 cm
const STOREY_ALTITUDE_TOLERANCE = 0.30; // 30 cm
const TRUE_NORTH_TOLERANCE = 1e-6;
const IMPORTED_COPLANAR_NORMAL = 1e-4;
const IMPORTED_VERTEX_WELD = 1e-3; // 1 mm
const COLLINEAR_DOT_TOLERANCE = 0.999;
const TANGENT_CONNECT_TOLERANCE = 0.05;
const EDGE_EXTENSION_RAY_MARGIN = 5.0;
const OPENING_PIERCING_EXTENSION_MARGIN = 0.02; // 20 mm extension margin for coplanar / tangential void piercing checks
const COS_CREASE_THRESHOLD = 0.99619; // cos(5 deg) threshold for architectural crease edges

export const GeometryTolerance = {
  COS_CREASE_THRESHOLD,
  MATH_EPSILON,
  COINCIDENT_POINT,
  COINCIDENT_POINT_SQ,
  SPATIAL_GRID_CELL_SIZE,
  COINCIDENT_VERTEX,
  MIN_EDGE_LENGTH,
  COPLANAR_NORMAL,
  POINT_ON_PLANE,
  MIN_FACE_AREA,
  COINCIDENT_AREA_MIN,
  ANGULAR_EPSILON,
  SNAP_TOLERANCE,
  OPENING_JAMB_NORMAL_TOLERANCE,
  OPENING_JAMB_DISTANCE_TOLERANCE,
  OPENING_DIRECTION_ALIGNMENT_DOT,
  OPENING_PARALLEL_CAP_DOT,
  OPENING_SLANTED_CAP_DOT,
  OPENING_OPPOSITE_NORMAL_DOT,
  OPENING_VERTICAL_NORMAL_DOT,
  OPENING_STRICT_OPPOSITE_DOT,
  STOREY_ELEVATION_TOLERANCE,
  STOREY_ALTITUDE_TOLERANCE,
  TRUE_NORTH_TOLERANCE,
  IMPORTED_COPLANAR_NORMAL,
  IMPORTED_VERTEX_WELD,
  COLLINEAR_DOT_TOLERANCE,
  TANGENT_CONNECT_TOLERANCE,
  EDGE_EXTENSION_RAY_MARGIN,
  OPENING_PIERCING_EXTENSION_MARGIN,

  relativeEpsilon(magnitude: number): number {
    return Math.max(MATH_EPSILON, Math.abs(magnitude) * 1e-9);
  },

  /**
   * Computes adaptive tolerances proportional to characteristic object scale.
   */
  getModelScaleTolerance(characteristicLength: number): { vertexTol: number; minArea: number; minEdge: number } {
    const scale = Math.max(1e-3, characteristicLength); // Clamped to 1 mm min
    const vertexTol = Math.max(1e-6, Math.min(0.01, scale * 1e-4));
    const minEdge = Math.max(1e-6, Math.min(0.01, scale * 1e-4));
    const minArea = Math.max(1e-10, Math.min(0.01, scale * scale * 1e-6));
    return { vertexTol, minArea, minEdge };
  },

  /**
   * Computes characteristic scale (bounding box diagonal) for a set of points.
   */
  computeCharacteristicScale(positions: { x: number; y: number; z: number }[]): number {
    if (positions.length === 0) return 1.0;
    let minX = positions[0].x, maxX = positions[0].x;
    let minY = positions[0].y, maxY = positions[0].y;
    let minZ = positions[0].z, maxZ = positions[0].z;
    for (let i = 1; i < positions.length; i++) {
      const p = positions[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  },

  arePointsCoincident(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    tol: number = COINCIDENT_POINT
  ): boolean {
    const dx = ax - bx;
    const dy = ay - by;
    const dz = az - bz;
    return (dx * dx + dy * dy + dz * dz) < (tol * tol);
  }
} as const;
