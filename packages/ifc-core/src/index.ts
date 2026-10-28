/**
 * @croquera/ifc-core
 *
 * High-performance, streaming IFC 4.3 / STEP parser and topological kernel.
 * Open-source core engine under Apache-2.0 license.
 */

// Math
export * from './math/GeometryTolerance';
export * from './math/Vec3';
export * from './math/Plane';
export * from './math/Ray';
export * from './math/MathUtils';
export * from './math/PCAAligner';

// Topology
export * from './topology/HalfEdge';
export * from './topology/PolygonClipping';
export * from './topology/PlanarGraph';
export * from './topology/PolyMesh';
export * from './topology/BooleanCSGKernel';
export * from './topology/SweepKernel';
export * from './topology/RevolveKernel';
export * from './topology/OpeningVoidSolver';

// Types and DTOs
export * from './types/GuidUtils';
export * from './types/GeometryIR';
export * from './types/IfcWorkerProtocol';

// Lexer & Parser
export * from './lexer/IfcStepLexer';
export * from './lexer/StepByteNumber';
export * from './lexer/IfcStepByteLexer';
export * from './parser/IfcStepParser';
export * from './parser/IfcStreamingParser';
export * from './parser/ChunkedStreamScanner';
export * from './parser/IfcTypeDictionary';

// Geometry Generators
export * from './geometry/DirectCylinderGenerator';
export * from './geometry/StaticProfileTemplates';
export * from './geometry/ToroidTemplateCache';

// Detector & Importer
export * from './detector/GeometryPrototypeDetector';
export * from './detector/ParametricSolidHasher';
export * from './importer/IfcStepImporter';

// Web Worker Core, Client & Adaptive Pool
export * from './worker/IfcImportWorkerCore';
export * from './worker/IfcWorkerClient';
export * from './worker/IfcAdaptiveWorkerPool';
