/**
 * IfcStepImporter — Native IFC 4.3 ISO-10303-21 importer for CROQUERA.
 *
 * Parses the STEP file, extracts tessellated / B-Rep geometry and spatial hierarchy,
 * reconstructs PolyMesh structures with Half-Edge invariants, hydrates Property Sets,
 * and restores BuildingFramework (levels and grids) with 100% fidelity.
 */

import { IfcStepParser, type StepRecord, type StepParam } from '../parser/IfcStepParser';
import { OnDemandRecordMap, type IIfcStreamingParser } from '../parser/IfcStreamingParser';
import { PolyMesh } from '../topology/PolyMesh';
import { BooleanCSGKernel } from '../topology/BooleanCSGKernel';
import { PolygonClipping } from '../topology/PolygonClipping';
import { SweepKernel } from '../topology/SweepKernel';
import { RevolveKernel } from '../topology/RevolveKernel';
import { OpeningVoidSolver } from '../topology/OpeningVoidSolver';
import { Vec3 } from '../math/Vec3';
import { Plane } from '../math/Plane';
import { GuidUtils } from '../types/GuidUtils';
import { GeometryTolerance } from '../math/GeometryTolerance';
import * as THREE from 'three';
import { GeometryPrototypeDetector, M_CANONICAL, M_CANONICAL_INV } from '../detector/GeometryPrototypeDetector';
import { ParametricSolidHasher, type ParametricSolidSignature } from '../detector/ParametricSolidHasher';
import { DirectCylinderGenerator, type DirectMeshBuffers } from '../geometry/DirectCylinderGenerator';
import { StaticProfileTemplates } from '../geometry/StaticProfileTemplates';
import { ToroidTemplateCache } from '../geometry/ToroidTemplateCache';
import type {
  Stage1SpatialPayload,
  Stage2BoundsPayload,
  Stage3GeometryChunkPayload,
  SpatialNodeDTO,
  ElementBoundsDTO,
  TessellatedElementDTO,
  InstanceBatchPayload,
  InstanceElementDTO,
  MaterialRecord,
  GeorefData,
  EntityType,
  CachedOpeningDTO,
  IfcGridDTO,
  IfcGridAxisDTO,
} from '../types/IfcWorkerProtocol';

export interface EvaluatedProductEntity {
  id: string;
  type: EntityType;
  name: string;
  parentId: string | null;
  storeyId?: string | null;
  matrixId?: string | null;
  polyMesh?: PolyMesh;
  rawGeometry?: {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    edgesBuffer?: Float32Array;
  };
  materialId?: string;
  hidden?: boolean;
  faces?: any[];
  vertices?: Vec3[];
  edges?: any[];
}

export interface ImportResult {
  importedEntityIds: string[];
  buildingIds: string[];
  storeyIds: string[];
  parser: IfcStepParser | IIfcStreamingParser; // Saved for subsequent delta patching
  defaultBuildingId?: string | null;
  parsedLevels?: { id: string; name: string; elevation: number }[];
  georef?: GeorefData | null;
}

export const IFC_PRIORITY_STRUCTURAL_TYPES = new Set<string>([
  'IFCWALL',
  'IFCWALLSTANDARDCASE',
  'IFCSLAB',
  'IFCCOLUMN',
  'IFCBEAM',
  'IFCMEMBER',
  'IFCPLATE',
  'IFCSIGN',
  'IFCSIGNAL',
  'IFCDOOR',
  'IFCWINDOW',
  'IFCROOF',
  'IFCSTAIR',
  'IFCSTAIRFLIGHT',
  'IFCRAMP',
  'IFCRAMPFLIGHT',
  'IFCFOOTING',
  'IFCCURTAINWALL',
  'IFCOPENINGELEMENT',
  'IFCSPACE',
  'IFCEARTHWORKSELEMENT',
  'IFCEARTHWORKSCUT',
  'IFCEARTHWORKSFILL',
  'IFCSITE',
]);

/**
 * Immutable dictionary of STEP attribute indices (0-based) conforming to ISO 16739-1 (IFC 4.3 ADD2).
 * Rule 21: Prohibited to access STEP parameters via bare magic numeric indices.
 */
export const IFC_GEOM_ATTRS = {
  // IfcFacetedBrep / IfcFacetedBrepWithVoids
  FACETED_BREP_OUTER: 0,
  FACETED_BREP_VOIDS: 1,

  // IfcPolygonalFaceSet
  POLYGONAL_COORDINATES: 0,
  POLYGONAL_CLOSED: 1,
  POLYGONAL_FACES: 2,
  POLYGONAL_PN_INDEX: 3,

  // IfcTriangulatedFaceSet / IfcTriangulatedIrregularNetwork
  TRIANGULATED_COORDINATES: 0,
  TRIANGULATED_NORMALS: 1,
  TRIANGULATED_CLOSED: 2,
  TRIANGULATED_COORD_INDEX: 3,
  TRIANGULATED_PN_INDEX: 4,

  // IfcLine
  LINE_PNT: 0,
  LINE_DIR: 1,

  // IfcVector
  VECTOR_ORIENTATION: 0,
  VECTOR_MAGNITUDE: 1,

  // IfcTrimmedCurve
  TRIMMED_BASIS_CURVE: 0,
  TRIMMED_1: 1,
  TRIMMED_2: 2,
  TRIMMED_SENSE_AGREEMENT: 3,
  TRIMMED_MASTER_REP: 4,

  // IfcEllipse
  ELLIPSE_POSITION: 0,
  ELLIPSE_SEMI_AXIS_1: 1,
  ELLIPSE_SEMI_AXIS_2: 2,

  // IfcCircle
  CIRCLE_POSITION: 0,
  CIRCLE_RADIUS: 1,

  // IfcExtrudedAreaSolid
  EXTRUDED_SWEPT_AREA: 0,
  EXTRUDED_POSITION: 1,
  EXTRUDED_EXTRUDED_DIRECTION: 2,
  EXTRUDED_DEPTH: 3,

  // IfcRevolvedAreaSolid
  REVOLVED_SWEPT_AREA: 0,
  REVOLVED_POSITION: 1,
  REVOLVED_AXIS: 2,
  REVOLVED_ANGLE: 3,

  // IfcSweptDiskSolid
  SWEPT_DISK_DIRECTRIX: 0,
  SWEPT_DISK_RADIUS: 1,
  SWEPT_DISK_INNER_RADIUS: 2,
  SWEPT_DISK_START_PARAM: 3,
  SWEPT_DISK_END_PARAM: 4,

  // IfcSurfaceCurveSweptAreaSolid
  SURFACE_SWEEP_SWEPT_AREA: 0,
  SURFACE_SWEEP_POSITION: 1,
  SURFACE_SWEEP_DIRECTRIX: 2,
  SURFACE_SWEEP_START_PARAM: 3,
  SURFACE_SWEEP_END_PARAM: 4,
  SURFACE_SWEEP_REFERENCE_SURFACE: 5,
} as const;

export class IfcStepImporter {
  public static readonly IFC_TYPE_MAP: Record<string, string> = {
    // Espacial y contenedores
    IFCPROJECT: 'IfcProject',
    IFCSITE: 'IfcSite',
    IFCBUILDING: 'IfcBuilding',
    IFCBUILDINGSTOREY: 'IfcBuildingStorey',
    IFCFACILITY: 'IfcFacility',
    IFCFACILITYPART: 'IfcFacilityPart',
    IFCBUILDINGPART: 'IfcBuildingPart',
    IFCBRIDGE: 'IfcBridge',
    IFCROAD: 'IfcRoad',
    IFCRAILWAY: 'IfcRailway',
    IFCMARINEFACILITY: 'IfcMarineFacility',
    IFCSPACE: 'IfcSpace',
    // Arquitectura y estructura
    IFCWALL: 'IfcWall',
    IFCWALLSTANDARDCASE: 'IfcWallStandardCase',
    IFCSLAB: 'IfcSlab',
    IFCCOLUMN: 'IfcColumn',
    IFCBEAM: 'IfcBeam',
    IFCDOOR: 'IfcDoor',
    IFCDOORSTANDARDCASE: 'IfcDoor',
    IFCDOORTYPE: 'IfcDoorType',
    IFCDOORSTYLE: 'IfcDoorStyle',
    IFCWINDOW: 'IfcWindow',
    IFCBUILDINGELEMENTPROXY: 'IfcBuildingElementProxy',
    IFCCOVERING: 'IfcCovering',
    IFCFOOTING: 'IfcFooting',
    IFCROOF: 'IfcRoof',
    IFCSTAIR: 'IfcStair',
    IFCSTAIRFLIGHT: 'IfcStairFlight',
    IFCRAMP: 'IfcRamp',
    IFCRAMPFLIGHT: 'IfcRampFlight',
    IFCRAILING: 'IfcRailing',
    IFCCURTAINWALL: 'IfcCurtainWall',
    IFCPLATE: 'IfcPlate',
    IFCMEMBER: 'IfcMember',
    IFCBUILDINGELEMENTPART: 'IfcBuildingElementPart',
    IFCFURNISHINGELEMENT: 'IfcFurnishingElement',
    IFCFURNITURE: 'IfcFurniture',
    IFCELEMENTASSEMBLY: 'IfcElementAssembly',
    IFCGROUP: 'IfcGroup',
    IFCOPENINGELEMENT: 'IfcOpeningElement',
    // Armaduras y componentes
    IFCREINFORCINGBAR: 'IfcReinforcingBar',
    IFCREINFORCINGMESH: 'IfcReinforcingMesh',
    IFCTENDON: 'IfcTendon',
    IFCTENDONANCHOR: 'IfcTendonAnchor',
    IFCDISCRETEACCESSORY: 'IfcDiscreteAccessory',
    IFCFASTENER: 'IfcFastener',
    IFCMECHANICALFASTENER: 'IfcMechanicalFastener',
    IFCSURFACEFEATURE: 'IfcSurfaceFeature',
    IFCVOIDINGFEATURE: 'IfcVoidingFeature',
    IFCVIBRATIONISOLATOR: 'IfcVibrationIsolator',
    // Infraestructura civil y terreno
    IFCCIVILELEMENT: 'IfcCivilElement',
    IFCGEOGRAPHICELEMENT: 'IfcGeographicElement',
    IFCEARTHWORKSELEMENT: 'IfcEarthworksElement',
    IFCEARTHWORKSCUT: 'IfcEarthworksCut',
    IFCEARTHWORKSFILL: 'IfcEarthworksFill',
    IFCROADPART: 'IfcRoadPart',
    IFCTRACKELEMENT: 'IfcTrackElement',
    IFCTRANSPORTELEMENT: 'IfcTransportElement',
    IFCBEARING: 'IfcBearing',
    IFCPAVEMENT: 'IfcPavement',
    IFCKERB: 'IfcKerb',
    IFCSIGNAL: 'IfcSignal',
    IFCSIGN: 'IfcSign',
    // MEP y redes
    IFCDISTRIBUTIONELEMENT: 'IfcDistributionElement',
    IFCDISTRIBUTIONFLOWELEMENT: 'IfcDistributionFlowElement',
    IFCDISTRIBUTIONCONTROLELEMENT: 'IfcDistributionControlElement',
    IFCDISTRIBUTIONCHAMBERELEMENT: 'IfcDistributionChamberElement',
    IFCENERGYCONVERSIONDEVICE: 'IfcEnergyConversionDevice',
    IFCFLOWSEGMENT: 'IfcFlowSegment',
    IFCDUCTSEGMENT: 'IfcDuctSegment',
    IFCDUCTFITTING: 'IfcDuctFitting',
    IFCPIPESEGMENT: 'IfcPipeSegment',
    IFCPIPEFITTING: 'IfcPipeFitting',
    IFCCABLECARRIERSEGMENT: 'IfcCableCarrierSegment',
    IFCCABLECARRIERFITTING: 'IfcCableCarrierFitting',
    IFCCABLESEGMENT: 'IfcCableSegment',
    IFCCABLEFITTING: 'IfcCableFitting',
    IFCAIRTERMINAL: 'IfcAirTerminal',
    IFCAIRTERMINALBOX: 'IfcAirTerminalBox',
    IFCDISTRIBUTIONPORT: 'IfcDistributionPort',
    IFCFLOWTERMINAL: 'IfcFlowTerminal',
    IFCFLOWCONTROLLER: 'IfcFlowController',
    IFCFLOWFITTING: 'IfcFlowFitting',
    IFCFLOWMOVINGDEVICE: 'IfcFlowMovingDevice',
    IFCFLOWSTORAGEDEVICE: 'IfcFlowStorageDevice',
    IFCFLOWTREATMENTDEVICE: 'IfcFlowTreatmentDevice',
    IFCSENSOR: 'IfcSensor',
    IFCACTUATOR: 'IfcActuator',
    IFCALARM: 'IfcAlarm',
    IFCCONTROLLER: 'IfcController',
    IFCUNITARYCONTROLELEMENT: 'IfcUnitaryControlElement',
    IFCAUDIOVISUALAPPLIANCE: 'IfcAudioVisualAppliance',
    IFCCOMMUNICATIONAPPLIANCE: 'IfcCommunicationAppliance',
    IFCELECTRICAPPLIANCE: 'IfcElectricAppliance',
    IFCFIREPROTECTIONAPPLIANCE: 'IfcFireProtectionAppliance',
    IFCLIGHTFIXTURE: 'IfcLightFixture',
    IFCMEDICALDEVICE: 'IfcMedicalDevice',
    IFCOUTLET: 'IfcOutlet',
    IFCSANITARYTERMINAL: 'IfcSanitaryTerminal',
    IFCSPACEHEATER: 'IfcSpaceHeater',
    IFCVALVE: 'IfcValve',
    IFCPUMP: 'IfcPump',
    IFCFAN: 'IfcFan',
    IFCBOILER: 'IfcBoiler',
    IFCBURNER: 'IfcBurner',
    IFCHILLER: 'IfcChiller',
    IFCCOIL: 'IfcCoil',
    IFCCOMPRESSOR: 'IfcCompressor',
    IFCCONDENSER: 'IfcCondenser',
    IFCCOOLINGTOWER: 'IfcCoolingTower',
    IFCHEATEXCHANGER: 'IfcHeatExchanger',
    IFCHUMIDIFIER: 'IfcHumidifier',
    IFCMOTORCONNECTION: 'IfcMotorConnection',
    IFCSOLARDEVICE: 'IfcSolarDevice',
    IFCINTERCEPTOR: 'IfcInterceptor',
    IFCTANK: 'IfcTank',
    IFCFILTER: 'IfcFilter',
  };

  public static readonly ALL_PRODUCT_TYPES: readonly string[] = [
    // Arquitectura y estructura
    'IFCWALL',
    'IFCWALLSTANDARDCASE',
    'IFCWALLELEMENTEDCASE',
    'IFCSLAB',
    'IFCSLABELEMENTEDCASE',
    'IFCSLABSTANDARDCASE',
    'IFCCOLUMN',
    'IFCCOLUMNSTANDARDCASE',
    'IFCBEAM',
    'IFCBEAMSTANDARDCASE',
    'IFCDOOR',
    'IFCDOORSTANDARDCASE',
    'IFCDOORTYPE',
    'IFCDOORSTYLE',
    'IFCWINDOW',
    'IFCWINDOWSTANDARDCASE',
    'IFCBUILDINGELEMENTPROXY',
    'IFCCOVERING',
    'IFCFOOTING',
    'IFCPILE',
    'IFCDEEPFOUNDATION',
    'IFCROOF',
    'IFCSTAIR',
    'IFCSTAIRFLIGHT',
    'IFCRAMP',
    'IFCRAMPFLIGHT',
    'IFCRAILING',
    'IFCCURTAINWALL',
    'IFCPLATE',
    'IFCPLATESTANDARDCASE',
    'IFCMEMBER',
    'IFCMEMBERSTANDARDCASE',
    'IFCBUILDINGELEMENTPART',
    'IFCFURNISHINGELEMENT',
    'IFCFURNITURE',
    'IFCSYSTEMFURNITUREELEMENT',
    'IFCELEMENTASSEMBLY',
    'IFCGROUP',
    'IFCOPENINGELEMENT',
    'IFCSPACE',
    'IFCSHADINGDEVICE',
    'IFCCHIMNEY',
    // Armaduras, acero y componentes
    'IFCREINFORCINGBAR',
    'IFCREINFORCINGMESH',
    'IFCTENDON',
    'IFCTENDONANCHOR',
    'IFCTENDONCONDUIT',
    'IFCVIBRATIONISOLATOR',
    'IFCDISCRETEACCESSORY',
    'IFCFASTENER',
    'IFCMECHANICALFASTENER',
    'IFCSURFACEFEATURE',
    'IFCVOIDINGFEATURE',
    // Infraestructura civil y terreno
    'IFCSITE',
    'IFCCIVILELEMENT',
    'IFCGEOGRAPHICELEMENT',
    'IFCEARTHWORKSELEMENT',
    'IFCEARTHWORKSCUT',
    'IFCEARTHWORKSFILL',
    'IFCTRACKELEMENT',
    'IFCPAVEMENT',
    'IFCKERB',
    'IFCBEARING',
    'IFCSIGNAL',
    'IFCSIGN',
    'IFCTRANSPORTELEMENT',
    // MEP y redes
    'IFCDISTRIBUTIONELEMENT',
    'IFCDISTRIBUTIONFLOWELEMENT',
    'IFCDISTRIBUTIONCONTROLELEMENT',
    'IFCDISTRIBUTIONCHAMBERELEMENT',
    'IFCENERGYCONVERSIONDEVICE',
    'IFCFLOWSEGMENT',
    'IFCDUCTSEGMENT',
    'IFCDUCTFITTING',
    'IFCPIPESEGMENT',
    'IFCPIPEFITTING',
    'IFCCABLECARRIERSEGMENT',
    'IFCCABLECARRIERFITTING',
    'IFCCABLESEGMENT',
    'IFCCABLEFITTING',
    'IFCAIRTERMINAL',
    'IFCAIRTERMINALBOX',
    'IFCDISTRIBUTIONPORT',
    'IFCFLOWTERMINAL',
    'IFCFLOWCONTROLLER',
    'IFCFLOWFITTING',
    'IFCFLOWMOVINGDEVICE',
    'IFCFLOWSTORAGEDEVICE',
    'IFCFLOWTREATMENTDEVICE',
    'IFCSENSOR',
    'IFCACTUATOR',
    'IFCALARM',
    'IFCCONTROLLER',
    'IFCUNITARYCONTROLELEMENT',
    'IFCAUDIOVISUALAPPLIANCE',
    'IFCCOMMUNICATIONAPPLIANCE',
    'IFCELECTRICAPPLIANCE',
    'IFCFIREPROTECTIONAPPLIANCE',
    'IFCLIGHTFIXTURE',
    'IFCMEDICALDEVICE',
    'IFCOUTLET',
    'IFCSANITARYTERMINAL',
    'IFCSPACEHEATER',
    'IFCVALVE',
    'IFCPUMP',
    'IFCFAN',
    'IFCBOILER',
    'IFCBURNER',
    'IFCHILLER',
    'IFCCOIL',
    'IFCCOMPRESSOR',
    'IFCCONDENSER',
    'IFCCOOLINGTOWER',
    'IFCHEATEXCHANGER',
    'IFCHUMIDIFIER',
    'IFCMOTORCONNECTION',
    'IFCSOLARDEVICE',
    'IFCINTERCEPTOR',
    'IFCTANK',
    'IFCFILTER',
  ];

  public static readonly DEFERRED_PRODUCT_TYPES: readonly string[] =
    IfcStepImporter.ALL_PRODUCT_TYPES.filter((t) => !IFC_PRIORITY_STRUCTURAL_TYPES.has(t));

  public static canonicalizeIfcType(rawType: string): string {
    if (!rawType) return 'IfcBuildingElementProxy';
    const upper = rawType.toUpperCase().trim();
    if (IfcStepImporter.IFC_TYPE_MAP[upper]) {
      return IfcStepImporter.IFC_TYPE_MAP[upper];
    }
    if (rawType.startsWith('Ifc') && rawType.length > 3 && rawType[3] === rawType[3].toUpperCase()) {
      return rawType;
    }
    if (upper.startsWith('IFC')) {
      const rest = upper.slice(3);
      return 'Ifc' + rest.charAt(0).toUpperCase() + rest.slice(1).toLowerCase();
    }
    return rawType;
  }

  private parser: IfcStepParser | IIfcStreamingParser;
  private records: Map<number, StepRecord>;
  private productTypesFilter: Set<string> | null = null;
  private stepParentToChildrenMap: Map<number, Set<number>> = new Map();
  private stepChildToParentMap: Map<number, number> = new Map();
  private openingToHostStepMap: Map<number, number> = new Map();
  private hostToOpeningsStepMap: Map<number, Set<number>> = new Map();
  private fillToOpeningStepMap: Map<number, number> = new Map();
  private sitePlacementRefs: Set<number> = new Set();
  private lengthUnitScale: number = 1.0;
  private planeAngleUnitScale: number = Math.PI / 180;
  public importWarnings: string[] = [];

  // LoGeoRef 50 georeferencing parameters and state (Phase 2)
  private extractedGeoref: GeorefData | null = null;
  private extractedTrueNorth: { x: number; y: number } | null = null;
  private siteGeoTranslationCaptured = false;
  private capturedSiteTranslation: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private capturedSiteRotation: THREE.Matrix4 = new THREE.Matrix4();

  // Prepared states for progressive streaming (Phase 4)
  private isPrepared = false;
  private psetRelationsByElement: Map<number, number[]> = new Map();
  private elemPsetsMap: Map<number, Record<string, Record<string, any>>> = new Map();
  private elementMaterialMap: Map<number, string> = new Map();
  private itemToStyleMap: Map<number, string> = new Map();
  private faceToStyleMap: Map<number, string> = new Map();
  private stepIdToEntityId: Map<number, string> = new Map();
  private defaultProjectId: string | null = null;
  private defaultSiteId: string | null = null;
  private defaultBuildingId: string | null = null;
  private storeyMap: Map<number, { guid: string; name: string; elevation: number }> = new Map();
  private storeyToBuildingGuidMap: Map<number, string> = new Map();
  private parsedLevels: { id: string; name: string; elevation: number }[] = [];
  private buildingPlacements: Map<string, THREE.Matrix4> = new Map();
  private parametricPrototypes: Map<
    bigint,
    {
      prototypeId: string;
      stepId: number;
      centroid_ifc: [number, number, number];
      pcaRotation: THREE.Matrix4;
      solidMatrixInv: THREE.Matrix4;
    }
  > = new Map();
  private parametricMeshCache: Map<bigint, PolyMesh> = new Map();
  private openingMeshCache: Map<number, { polyMesh: PolyMesh; id: string } | null> = new Map();
  private placementMatrixCache: Map<number, THREE.Matrix4> = new Map();
  private axis2PlacementCache: Map<number, THREE.Matrix4> = new Map();
  private mepFacetedPrototypeCache: Map<number, DirectMeshBuffers | null> = new Map();
  private mepExtrudedPrototypeCache: Map<number, DirectMeshBuffers | null> = new Map();

  private getInheritedStoreyGuid(stepId: number): string | null {
    let currStepId: number | undefined = stepId;
    const visited = new Set<number>();
    while (currStepId !== undefined && !visited.has(currStepId)) {
      visited.add(currStepId);
      if (this.storeyMap.has(currStepId)) {
        return this.storeyMap.get(currStepId)!.guid;
      }
      currStepId = this.stepChildToParentMap.get(currStepId);
    }
    return null;
  }
  private spatialNodes: SpatialNodeDTO[] = [];
  private productRecordsList: StepRecord[] = [];
  private cachedBoundsPayload: Stage2BoundsPayload | null = null;
  private materialsList: MaterialRecord[] = [];
  private materialCatalog: Map<string, MaterialRecord> = new Map();

  constructor(stepContentOrParser: string | IIfcStreamingParser | IfcStepParser) {
    if (typeof stepContentOrParser === 'string') {
      this.parser = new IfcStepParser(stepContentOrParser);
      this.parser.parse();
      this.records = this.parser.records;
    } else if (stepContentOrParser instanceof IfcStepParser || ('records' in stepContentOrParser && (stepContentOrParser as any).records instanceof Map)) {
      this.parser = stepContentOrParser as any;
      this.records = (stepContentOrParser as any).records;
    } else {
      this.parser = stepContentOrParser;
      this.records = new OnDemandRecordMap(stepContentOrParser);
    }
  }

  public static fromStreamingParser(streamingParser: IIfcStreamingParser): IfcStepImporter {
    return new IfcStepImporter(streamingParser);
  }

  public setProductTypesFilter(filter: Set<string> | null): void {
    this.productTypesFilter = filter;
  }

  public getParser(): IfcStepParser | IIfcStreamingParser {
    return this.parser;
  }

  private parseUnitAssignment(): void {
    this.lengthUnitScale = 1.0;
    this.planeAngleUnitScale = Math.PI / 180;

    // 1. Search SI units (length and angle)
    const siUnits = this.parser.getRecordsByType('IFCSIUNIT');
    let lengthFound = false;
    for (const u of siUnits) {
      const unitType = this.getParamEnumOrString(u.params[1]);
      if (!lengthFound && (unitType === '.LENGTHUNIT.' || unitType === 'LENGTHUNIT')) {
        const prefix = this.getParamEnumOrString(u.params[2]);
        if (prefix === '.MILLI.' || prefix === 'MILLI') {
          this.lengthUnitScale = 0.001;
          lengthFound = true;
        } else if (prefix === '.CENTI.' || prefix === 'CENTI') {
          this.lengthUnitScale = 0.01;
          lengthFound = true;
        } else if (prefix === '.DECI.' || prefix === 'DECI') {
          this.lengthUnitScale = 0.1;
          lengthFound = true;
        } else if (prefix === '.KILO.' || prefix === 'KILO') {
          this.lengthUnitScale = 1000.0;
          lengthFound = true;
        } else if (!prefix || prefix === '$' || prefix === '.NONE.') {
          this.lengthUnitScale = 1.0;
          lengthFound = true;
        }
      } else if (unitType === '.PLANEANGLEUNIT.' || unitType === 'PLANEANGLEUNIT') {
        const name = this.getParamEnumOrString(u.params[3]) || this.getParamEnumOrString(u.params[2]);
        if (name === '.RADIAN.' || name === 'RADIAN') {
          this.planeAngleUnitScale = 1.0;
        } else if (name === '.DEGREE.' || name === 'DEGREE') {
          this.planeAngleUnitScale = Math.PI / 180;
        }
      }
    }

    // 2. Search conversion-based units (length and angle)
    const convUnits = this.parser.getRecordsByType('IFCCONVERSIONBASEDUNIT');
    for (const cu of convUnits) {
      const unitType = this.getParamEnumOrString(cu.params[1]);
      if (!lengthFound && (unitType === '.LENGTHUNIT.' || unitType === 'LENGTHUNIT')) {
        const name = (this.getParamString(cu.params[2]) || '').toUpperCase();
        if (name.includes('INCH')) {
          this.lengthUnitScale = 0.0254;
          lengthFound = true;
        } else if (name.includes('FOOT') || name.includes('FEET')) {
          this.lengthUnitScale = 0.3048;
          lengthFound = true;
        } else {
          const factorParam = cu.params[3];
          if (factorParam && typeof factorParam === 'object' && 'ref' in factorParam) {
            const mUnit = this.records.get(factorParam.ref);
            if (mUnit && mUnit.type === 'IFCMEASUREWITHUNIT') {
              const valParam = mUnit.params[0];
              let val = 1.0;
              if (typeof valParam === 'number') {
                val = valParam;
              } else if (valParam && typeof valParam === 'object' && 'params' in valParam) {
                val = Number(valParam.params[0]) || 1.0;
              } else {
                val = parseFloat(String(valParam)) || 1.0;
              }
              if (val > 0) {
                this.lengthUnitScale = val;
                lengthFound = true;
              }
            }
          }
        }
      } else if (unitType === '.PLANEANGLEUNIT.' || unitType === 'PLANEANGLEUNIT') {
        const name = (this.getParamString(cu.params[2]) || '').toUpperCase();
        if (name.includes('DEGREE')) {
          this.planeAngleUnitScale = Math.PI / 180;
        }
      }
    }
  }

  private getParamEnumOrString(p: StepParam): string | null {
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') {
      if ('enum' in p && typeof (p as any).enum === 'string') return (p as any).enum;
      if ('params' in p && typeof (p as any).params[0] === 'string') return (p as any).params[0];
    }
    return null;
  }

  private isSpatialRootSite(siteRecord: StepRecord): boolean {
    const parentStepId = this.stepChildToParentMap.get(siteRecord.id);
    if (parentStepId) {
      const parentRec = this.records.get(parentStepId);
      if (parentRec) {
        const pType = parentRec.type.toUpperCase();
        if (
          pType.includes('STOREY') ||
          pType.includes('BUILDING') ||
          pType.includes('FACILITY') ||
          pType.includes('SPACE')
        ) {
          return false;
        }
      }
    }

    const pParam = siteRecord.params[5];
    if (pParam && typeof pParam === 'object' && 'ref' in pParam) {
      const plRec = this.records.get((pParam as any).ref);
      if (plRec && plRec.type === 'IFCLOCALPLACEMENT') {
        const relToParam = plRec.params[0];
        if (relToParam && typeof relToParam === 'object' && 'ref' in relToParam) {
          const parentPlRef = (relToParam as any).ref;
          for (const storey of this.parser.getRecordsByType('IFCBUILDINGSTOREY')) {
            const stPl = storey.params[5];
            if (stPl && typeof stPl === 'object' && 'ref' in stPl && (stPl as any).ref === parentPlRef) {
              return false;
            }
          }
          for (const bldg of this.parser.getRecordsByType('IFCBUILDING')) {
            const bPl = bldg.params[5];
            if (bPl && typeof bPl === 'object' && 'ref' in bPl && (bPl as any).ref === parentPlRef) {
              return false;
            }
          }
        }
      }
    }

    return true;
  }

  private populateSitePlacementRefs(): void {
    this.sitePlacementRefs.clear();
    const allSites = this.parser.getRecordsByType('IFCSITE');
    if (allSites.length === 0) return;

    // Identify the true root spatial site
    let rootSite: StepRecord | null = null;

    // Priority 1: Site aggregated from IfcProject via IfcRelAggregates
    const projectRecords = this.parser.getRecordsByType('IFCPROJECT');
    if (projectRecords.length > 0) {
      const projId = projectRecords[0].id;
      const projChildren = this.stepParentToChildrenMap.get(projId);
      if (projChildren) {
        for (const childId of projChildren) {
          const candidate = allSites.find((s) => s.id === childId);
          if (candidate) {
            rootSite = candidate;
            break;
          }
        }
      }
    }

    // Priority 2: First site satisfying spatial root invariants
    if (!rootSite) {
      for (const site of allSites) {
        if (this.isSpatialRootSite(site)) {
          rootSite = site;
          break;
        }
      }
    }

    if (!rootSite) {
      rootSite = allSites[0];
    }

    const pParam = rootSite.params[5];
    if (pParam && typeof pParam === 'object' && 'ref' in pParam) {
      const sitePlRef = (pParam as any).ref;
      this.sitePlacementRefs.add(sitePlRef);
      // Resolve and capture geodetic translation of the root site
      this.resolveLocalPlacementMatrix(sitePlRef);
    }
  }

  /**
   * Prepares the relationship graph, Psets, and metadata without instantiating heavy geometries (Phase 4).
   */
  public prepareImport(): void {
    if (this.isPrepared) return;

    this.parseUnitAssignment();
    this.materialCatalog.clear();
    this.indexPsetRelations();
    this.elemPsetsMap.clear();
    this.parametricPrototypes.clear();
    this.parametricMeshCache.clear();
    this.openingMeshCache.clear();
    this.placementMatrixCache.clear();
    this.axis2PlacementCache.clear();
    this.resolveSpatialContainerPsets();
    this.elementMaterialMap = this.importMaterials();
    const styled = this.parseStyledItems();
    this.itemToStyleMap = styled.itemToStyleMap;
    this.faceToStyleMap = styled.faceToStyleMap;

    this.stepParentToChildrenMap.clear();
    this.stepChildToParentMap.clear();
    this.openingToHostStepMap.clear();
    this.hostToOpeningsStepMap.clear();
    this.fillToOpeningStepMap.clear();
    this.extractGeorefFromContext();

    const addStepRelation = (parentStepId: number, childStepId: number) => {
      if (!this.stepParentToChildrenMap.has(parentStepId)) {
        this.stepParentToChildrenMap.set(parentStepId, new Set());
      }
      this.stepParentToChildrenMap.get(parentStepId)!.add(childStepId);
      this.stepChildToParentMap.set(childStepId, parentStepId);
    };

    const relContainmentList = this.parser.getRecordsByType('IFCRELCONTAINEDINSPATIALSTRUCTURE');
    for (const rel of relContainmentList) {
      const elements = rel.params[4];
      const spatialRef = rel.params[5];
      if (Array.isArray(elements) && spatialRef && typeof spatialRef === 'object' && 'ref' in spatialRef) {
        for (const el of elements) {
          if (el && typeof el === 'object' && 'ref' in el) {
            addStepRelation((spatialRef as any).ref, (el as any).ref);
          }
        }
      }
    }

    const relAggregatesList = this.parser.getRecordsByType('IFCRELAGGREGATES');
    for (const rel of relAggregatesList) {
      const relating = rel.params[4];
      const related = rel.params[5];
      if (relating && typeof relating === 'object' && 'ref' in relating && Array.isArray(related)) {
        for (const ch of related) {
          if (ch && typeof ch === 'object' && 'ref' in ch) {
            const childRec = this.records.get((ch as any).ref);
            if (childRec && childRec.type === 'IFCDISTRIBUTIONPORT') continue;
            addStepRelation((relating as any).ref, (ch as any).ref);
          }
        }
      }
    }

    const relNestsList = this.parser.getRecordsByType('IFCRELNESTS');
    for (const rel of relNestsList) {
      const relating = rel.params[4];
      const related = rel.params[5];
      if (relating && typeof relating === 'object' && 'ref' in relating && Array.isArray(related)) {
        for (const ch of related) {
          if (ch && typeof ch === 'object' && 'ref' in ch) {
            const childRec = this.records.get((ch as any).ref);
            if (childRec && childRec.type === 'IFCDISTRIBUTIONPORT') continue;
            addStepRelation((relating as any).ref, (ch as any).ref);
          }
        }
      }
    }

    const relVoidsList = this.parser.getRecordsByType('IFCRELVOIDSELEMENT');
    for (const rel of relVoidsList) {
      const hostParam = rel.params[4];
      const openingParam = rel.params[5];
      if (
        hostParam && typeof hostParam === 'object' && 'ref' in hostParam &&
        openingParam && typeof openingParam === 'object' && 'ref' in openingParam
      ) {
        this.openingToHostStepMap.set((openingParam as any).ref, (hostParam as any).ref);
        if (!this.hostToOpeningsStepMap.has((hostParam as any).ref)) {
          this.hostToOpeningsStepMap.set((hostParam as any).ref, new Set());
        }
        this.hostToOpeningsStepMap.get((hostParam as any).ref)!.add((openingParam as any).ref);
      }
    }

    // IFCRELFILLSELEMENT (RelatingOpeningElement -> RelatedBuildingElement [Door/Window]) (A-7)
    const relFillsList = this.parser.getRecordsByType('IFCRELFILLSELEMENT');
    for (const rel of relFillsList) {
      const openingParam = rel.params[4];
      const fillParam = rel.params[5];
      if (
        openingParam && typeof openingParam === 'object' && 'ref' in openingParam &&
        fillParam && typeof fillParam === 'object' && 'ref' in fillParam
      ) {
        this.fillToOpeningStepMap.set((fillParam as any).ref, (openingParam as any).ref);
      }
    }

    this.populateSitePlacementRefs();

    this.spatialNodes = [];
    this.stepIdToEntityId.clear();
    this.defaultProjectId = null;
    this.defaultSiteId = null;
    this.defaultBuildingId = null;

    // 1. Projects
    const projectRecords = this.parser.getRecordsByType('IFCPROJECT');
    if (projectRecords.length === 0) {
      const msg = 'STEP Warning: File does not contain root entity IfcProject. Default spatial structure will be created.';
      console.warn(`[IfcStepImporter] ${msg}`);
      this.importWarnings.push(msg);
      const defaultGuid = GuidUtils.createIfcGuid();
      this.defaultProjectId = defaultGuid;
      this.spatialNodes.push({
        id: defaultGuid,
        stepId: 0,
        name: 'Default Project',
        ifcType: 'IfcProject',
        parentId: null,
        psets: {},
      });
    } else {
      for (const proj of projectRecords) {
        const guid = this.getParamString(proj.params[0]) || GuidUtils.createIfcGuid();
        const name = this.getParamString(proj.params[2]) || 'Proyecto';
        if (!this.defaultProjectId) this.defaultProjectId = guid;
        this.stepIdToEntityId.set(proj.id, guid);
        this.spatialNodes.push({
          id: guid,
          stepId: proj.id,
          name,
          ifcType: 'IfcProject',
          parentId: null,
          psets: this.elemPsetsMap.get(proj.id) || {},
        });
      }
    }

    // 2. Sites (Physical root in SceneGraph: parentId = null if root site)
    const siteRecords = this.parser.getRecordsByType('IFCSITE');
    for (const site of siteRecords) {
      const guid = this.getParamString(site.params[0]) || GuidUtils.createIfcGuid();
      const name = this.getParamString(site.params[2]) || 'Sitio';
      const isRoot = this.isSpatialRootSite(site);
      if (isRoot && !this.defaultSiteId) this.defaultSiteId = guid;
      this.stepIdToEntityId.set(site.id, guid);

      const parentStepId = this.stepChildToParentMap.get(site.id);
      const parentGuid = isRoot ? null : (parentStepId ? this.stepIdToEntityId.get(parentStepId) || null : null);

      this.spatialNodes.push({
        id: guid,
        stepId: site.id,
        name,
        ifcType: 'IfcSite',
        parentId: parentGuid,
        psets: this.elemPsetsMap.get(site.id) || {},
      });
    }
    if (!this.defaultSiteId && siteRecords.length > 0) {
      this.defaultSiteId = this.stepIdToEntityId.get(siteRecords[0].id) || null;
    }

    // 3. Buildings
    const facilityTypes = [
      'IFCBUILDING',
      'IFCFACILITY',
      'IFCBRIDGE',
      'IFCROAD',
      'IFCRAILWAY',
      'IFCMARINEFACILITY',
    ];
    const buildingRecords = facilityTypes.flatMap((t) => this.parser.getRecordsByType(t));
    for (const bldg of buildingRecords) {
      const guid = this.getParamString(bldg.params[0]) || GuidUtils.createIfcGuid();
      const name = this.getParamString(bldg.params[2]) || 'Edificio';
      if (!this.defaultBuildingId) this.defaultBuildingId = guid;
      this.stepIdToEntityId.set(bldg.id, guid);
      const parentStepId = this.stepChildToParentMap.get(bldg.id);
      let parentGuid = (parentStepId ? this.stepIdToEntityId.get(parentStepId) : null) || this.defaultSiteId || null;
      if (parentGuid === this.defaultProjectId) {
        parentGuid = this.defaultSiteId || null;
      }

      // Resolve ObjectPlacement (param 5) of the building and convert to Croquera Y-Up coordinates (Rule 21, Rule 22)
      const placementParam = bldg.params[5];
      let bldgPlacementMatrix = new THREE.Matrix4();
      if (placementParam && typeof placementParam === 'object' && 'ref' in placementParam) {
        const mIfc = this.resolveLocalPlacementMatrix((placementParam as any).ref);
        bldgPlacementMatrix = IfcStepImporter.convertIfcPlacementToCroquera(mIfc);
      }
      this.buildingPlacements.set(guid, bldgPlacementMatrix);

      this.spatialNodes.push({
        id: guid,
        stepId: bldg.id,
        name,
        ifcType: IfcStepImporter.canonicalizeIfcType(bldg.type),
        parentId: parentGuid,
        transform: Array.from(bldgPlacementMatrix.elements),
        psets: this.elemPsetsMap.get(bldg.id) || {},
      });
    }

    // 4. Storeys / Levels
    const storeyTypes = ['IFCBUILDINGSTOREY', 'IFCFACILITYPART', 'IFCBUILDINGPART', 'IFCROADPART'];
    const storeyRecords = storeyTypes.flatMap((t) => this.parser.getRecordsByType(t));
    this.storeyMap.clear();
    this.storeyToBuildingGuidMap.clear();
    this.parsedLevels = [];

    for (const storey of storeyRecords) {
      const guid = this.getParamString(storey.params[0]) || GuidUtils.createIfcGuid();
      const name = this.getParamString(storey.params[2]) || 'Nivel';
      const elevParam = storey.params[9];
      const rawElevation = typeof elevParam === 'number' ? elevParam : parseFloat(String(elevParam || 0)) || 0;
      const elevation = rawElevation * this.lengthUnitScale;

      this.storeyMap.set(storey.id, { guid, name, elevation });
      if (storey.type === 'IFCBUILDINGSTOREY' || storey.type === 'IFCFACILITYPART') {
        this.parsedLevels.push({ id: guid, name, elevation });
      }
      this.stepIdToEntityId.set(storey.id, guid);
      const parentStepId = this.stepChildToParentMap.get(storey.id);
      const parentGuid = (parentStepId ? this.stepIdToEntityId.get(parentStepId) : null) || this.defaultBuildingId;
      if (parentGuid) {
        this.storeyToBuildingGuidMap.set(storey.id, parentGuid);
      }

      this.spatialNodes.push({
        id: guid,
        stepId: storey.id,
        name,
        ifcType: IfcStepImporter.canonicalizeIfcType(storey.type),
        parentId: parentGuid,
        elevation,
        psets: this.elemPsetsMap.get(storey.id) || {},
      });

      // Adjustment 2: IfcBuildingStorey nodes are not created as GROUP nodes in SceneGraph
      // (avoids empty storey folders in the tree). Their information is transferred
      // to BuildingFramework.levels and elements are linked to their host IfcBuilding with storeyId.
    }

    // 5. Product List
    const productTypes = IfcStepImporter.ALL_PRODUCT_TYPES;

    const productMap = new Map<number, StepRecord>();
    for (const pType of productTypes) {
      if (this.productTypesFilter && !this.productTypesFilter.has(pType.toUpperCase())) {
        continue;
      }
      for (const rec of this.parser.getRecordsByType(pType)) {
        if (!this.stepIdToEntityId.has(rec.id)) {
          productMap.set(rec.id, rec);
        }
      }
    }

    if (!(this.records instanceof OnDemandRecordMap)) {
      for (const rec of this.records.values()) {
        if (this.productTypesFilter && !this.productTypesFilter.has(rec.type.toUpperCase())) {
          continue;
        }
        if (!this.stepIdToEntityId.has(rec.id) && !productMap.has(rec.id)) {
          const p6 = rec.params[6];
          if (p6 && typeof p6 === 'object' && 'ref' in p6) {
            const shapeRec = this.records.get((p6 as any).ref);
            if (shapeRec && shapeRec.type === 'IFCPRODUCTDEFINITIONSHAPE') {
              productMap.set(rec.id, rec);
            }
          }
        }
      }
    }

    // Physical geometry on spatial elements (e.g. IfcSite with terrain representation)
    for (const site of siteRecords) {
      if (this.productTypesFilter && !this.productTypesFilter.has('IFCSITE')) {
        continue;
      }
      const shapeParam = site.params[6];
      if (shapeParam && typeof shapeParam === 'object' && 'ref' in shapeParam) {
        productMap.set(site.id, site);
      }
    }

    this.productRecordsList = Array.from(productMap.values());
    for (const rec of this.productRecordsList) {
      if (!this.stepIdToEntityId.has(rec.id)) {
        const rawGuid = this.getParamString(rec.params[0]);
        const id = rawGuid && GuidUtils.isIfcGuid(rawGuid) ? rawGuid : GuidUtils.createIfcGuid();
        this.stepIdToEntityId.set(rec.id, id);
      }
    }
    this.materialsList = Array.from(this.materialCatalog.values());
    this.isPrepared = true;
  }

  /**
   * Extracts the spatial hierarchy (Stage 1 - Phase 4).
   * Deploys Project, Site, Building, and Storeys in sub-200ms without computing geometries.
   */
  public extractSpatialHierarchy(): Stage1SpatialPayload {
    this.prepareImport();

    return {
      type: 'STAGE_SPATIAL_HIERARCHY',
      spatialNodes: this.spatialNodes,
      materials: this.materialsList,
      parsedLevels: this.parsedLevels,
      defaultBuildingId: this.defaultBuildingId,
      georef: this.finalizeGeoref(),
    };
  }

  /**
   * Fast O(1) computation of element bounds from placement matrix and optional IfcBoundingBox.
   * Avoids tessellation, CSG booleans, extrusions, and heavy memory allocation in Stage 2.
   */
  private resolveProductFastBounds(
    shapeRef: number | null,
    mProduct: THREE.Matrix4,
    elemMin: THREE.Vector3,
    elemMax: THREE.Vector3
  ): boolean {
    if (shapeRef === null) return false;
    const shapeRec = this.records.get(shapeRef);
    if (!shapeRec || shapeRec.type !== 'IFCPRODUCTDEFINITIONSHAPE') return false;

    const repsList = shapeRec.params[2];
    if (!Array.isArray(repsList)) return false;

    for (const item of repsList) {
      if (!item || typeof item !== 'object' || !('ref' in item)) continue;
      const repRec = this.records.get(item.ref);
      if (!repRec) continue;

      const geomItems = repRec.params[3];
      if (!Array.isArray(geomItems)) continue;

      for (const geomItem of geomItems) {
        if (!geomItem || typeof geomItem !== 'object' || !('ref' in geomItem)) continue;
        const gRec = this.records.get(geomItem.ref);
        if (!gRec) continue;

        if (gRec.type === 'IFCBOUNDINGBOX') {
          // #ID = IFCBOUNDINGBOX(Corner, XDim, YDim, ZDim);
          const corner = new THREE.Vector3(0, 0, 0);
          const cornerParam = gRec.params[0];
          if (cornerParam && typeof cornerParam === 'object' && 'ref' in cornerParam) {
            const ptRec = this.records.get(cornerParam.ref);
            if (ptRec && Array.isArray(ptRec.params[0])) {
              const coords = ptRec.params[0].map((v: any) =>
                (typeof v === 'number' ? v : parseFloat(String(v)) || 0) * this.lengthUnitScale
              );
              corner.set(coords[0] || 0, coords[1] || 0, coords[2] || 0);
            }
          }

          const xDim = (typeof gRec.params[1] === 'number' ? gRec.params[1] : parseFloat(String(gRec.params[1])) || 0) * this.lengthUnitScale;
          const yDim = (typeof gRec.params[2] === 'number' ? gRec.params[2] : parseFloat(String(gRec.params[2])) || 0) * this.lengthUnitScale;
          const zDim = (typeof gRec.params[3] === 'number' ? gRec.params[3] : parseFloat(String(gRec.params[3])) || 0) * this.lengthUnitScale;

          for (let ix = 0; ix <= 1; ix++) {
            for (let iy = 0; iy <= 1; iy++) {
              for (let iz = 0; iz <= 1; iz++) {
                const pt = new THREE.Vector3(
                  corner.x + ix * xDim,
                  corner.y + iy * yDim,
                  corner.z + iz * zDim
                ).applyMatrix4(mProduct);
                // Canonical change of basis: X_croq = X_ifc, Y_croq = Z_ifc, Z_croq = -Y_ifc (det = +1)
                const x = pt.x;
                const y = pt.z;
                const z = -pt.y;

                if (x < elemMin.x) elemMin.x = x;
                if (y < elemMin.y) elemMin.y = y;
                if (z < elemMin.z) elemMin.z = z;
                if (x > elemMax.x) elemMax.x = x;
                if (y > elemMax.y) elemMax.y = y;
                if (z > elemMax.z) elemMax.z = z;
              }
            }
          }
          return true;
        }

        if (
          gRec.type === 'IFCTRIANGULATEDFACESET' ||
          gRec.type === 'IFCTRIANGULATEDIRREGULARNETWORK' ||
          gRec.type === 'IFCPOLYGONALFACESET'
        ) {
          const ptRef = gRec.params[0];
          if (ptRef && typeof ptRef === 'object' && 'ref' in ptRef) {
            const ptListRec = this.records.get(ptRef.ref);
            if (ptListRec && Array.isArray(ptListRec.params[0])) {
              const rawCoords = ptListRec.params[0];
              const el = mProduct.elements;
              const scale = this.lengthUnitScale;
              for (let i = 0; i < rawCoords.length; i++) {
                const pt = rawCoords[i];
                if (!Array.isArray(pt) || pt.length < 3) continue;
                const x = (typeof pt[0] === 'number' ? pt[0] : parseFloat(String(pt[0])) || 0) * scale;
                const y = (typeof pt[1] === 'number' ? pt[1] : parseFloat(String(pt[1])) || 0) * scale;
                const z = (typeof pt[2] === 'number' ? pt[2] : parseFloat(String(pt[2])) || 0) * scale;

                const px = el[0] * x + el[4] * y + el[8] * z + el[12];
                const py = el[1] * x + el[5] * y + el[9] * z + el[13];
                const pz = el[2] * x + el[6] * y + el[10] * z + el[14];

                const cx = px;
                const cy = pz;
                const cz = -py;

                if (cx < elemMin.x) elemMin.x = cx;
                if (cy < elemMin.y) elemMin.y = cy;
                if (cz < elemMin.z) elemMin.z = cz;
                if (cx > elemMax.x) elemMax.x = cx;
                if (cy > elemMax.y) elemMax.y = cy;
                if (cz > elemMax.z) elemMax.z = cz;
              }
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * Extracts AABB bounding boxes and global model bounding envelope (Stage 2 - Phase 4).
   * Enables framing camera immediately in the viewport while meshes are streamed.
   * If lightweight is true, skips accumulating element bounds array, computing only modelAABB.
   */
  public extractProductBounds(lightweight = false): Stage2BoundsPayload {
    if (this.cachedBoundsPayload) {
      if (!lightweight && this.cachedBoundsPayload.elements.length === 0 && this.productRecordsList.length > 0) {
        // Cache was created in lightweight mode but full elements were requested. Recompute.
      } else {
        return this.cachedBoundsPayload;
      }
    }
    if (!this.isPrepared) this.prepareImport();

    const elements: ElementBoundsDTO[] = [];
    const modelMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    const modelMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    for (const rec of this.productRecordsList) {
      try {
        const rawGuid = this.getParamString(rec.params[0]);
        const id = this.stepIdToEntityId.get(rec.id) || (rawGuid && GuidUtils.isIfcGuid(rawGuid) ? rawGuid : GuidUtils.createIfcGuid());
        this.stepIdToEntityId.set(rec.id, id);
        const name = this.getParamString(rec.params[2]) || rec.type;

        const parentStepId = this.stepChildToParentMap.get(rec.id);
        let parentGuid: string | null = null;
        let storeyGuid: string | null = null;

        if (rec.type === 'IFCSITE' && (!parentStepId || !this.storeyMap.has(parentStepId))) {
          parentGuid = (parentStepId ? this.stepIdToEntityId.get(parentStepId) : null) || null;
          storeyGuid = null;
        } else if (parentStepId && this.storeyMap.has(parentStepId)) {
          storeyGuid = this.storeyMap.get(parentStepId)!.guid;
          parentGuid = this.storeyToBuildingGuidMap.get(parentStepId) || this.defaultBuildingId || null;
        } else if (parentStepId) {
          parentGuid = this.stepIdToEntityId.get(parentStepId) || this.defaultBuildingId || null;
          storeyGuid = this.getInheritedStoreyGuid(parentStepId);
        } else {
          parentGuid = this.defaultBuildingId || null;
        }

        if (parentGuid === this.defaultProjectId) {
          parentGuid = null;
        }

        if (rec.type === 'IFCOPENINGELEMENT') {
          const hostStepId = this.openingToHostStepMap.get(rec.id);
          const hostGuid = hostStepId ? this.stepIdToEntityId.get(hostStepId) : null;
          if (hostGuid) {
            parentGuid = hostGuid;
          }
        }

        // Rule 15.1: Windows/doors are not children of invisible openings but keep spatial containers and link via Pset_OpeningFiller
        if (this.fillToOpeningStepMap.has(rec.id)) {
          const openingStepId = this.fillToOpeningStepMap.get(rec.id)!;
          const openingGuid = this.stepIdToEntityId.get(openingStepId);
          if (openingGuid) {
            const psets = this.elemPsetsMap.get(rec.id) || {};
            if (!psets.Pset_OpeningFiller) psets.Pset_OpeningFiller = {};
            psets.Pset_OpeningFiller.FillsOpening = {
              type: 'IfcLabel',
              value: openingGuid,
            };
            this.elemPsetsMap.set(rec.id, psets);
          }
        }

        // 1. Resolve local spatial placement
        const placementParam = rec.params[5];
        let mProduct = new THREE.Matrix4();
        if (placementParam && typeof placementParam === 'object' && 'ref' in placementParam) {
          mProduct = this.resolveLocalPlacementMatrix((placementParam as any).ref);
        }

        // 2. Extract approximate bounding box in O(1) without tessellation
        const shapeParam = rec.params[6];
        const shapeRef = (shapeParam && typeof shapeParam === 'object' && 'ref' in shapeParam)
          ? (shapeParam as any).ref
          : null;

        const elemMin = new THREE.Vector3(Infinity, Infinity, Infinity);
        const elemMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

        const hasBox = this.resolveProductFastBounds(shapeRef, mProduct, elemMin, elemMax);
        if (!hasBox) {
          const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(mProduct);
          const ox = origin.x;
          const oy = origin.z;
          const oz = -origin.y;
          elemMin.set(ox - 0.5, oy - 0.5, oz - 0.5);
          elemMax.set(ox + 0.5, oy + 0.5, oz + 0.5);
        }

        const isVirtual = rec.type === 'IFCOPENINGELEMENT' || rec.type === 'IFCSPACE';
        if (!isVirtual) {
          if (elemMin.x < modelMin.x) modelMin.x = elemMin.x;
          if (elemMin.y < modelMin.y) modelMin.y = elemMin.y;
          if (elemMin.z < modelMin.z) modelMin.z = elemMin.z;
          if (elemMax.x > modelMax.x) modelMax.x = elemMax.x;
          if (elemMax.y > modelMax.y) modelMax.y = elemMax.y;
          if (elemMax.z > modelMax.z) modelMax.z = elemMax.z;
        }

        const isExplicitAssembly =
          rec.type === 'IFCELEMENTASSEMBLY' ||
          rec.type === 'IFCGROUP';
        const hasChildren = this.stepParentToChildrenMap.has(rec.id) && (this.stepParentToChildrenMap.get(rec.id)!.size > 0);
        const hasShape = Boolean(shapeRef !== null);
        const isGroup = isExplicitAssembly || hasChildren || hasShape;

        if (!lightweight) {
          elements.push({
            id,
            stepId: rec.id,
            name,
            type: isGroup ? 'GROUP' : 'GEOMETRY_ENTITY',
            ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
            predefinedType: this.getPredefinedType(rec) || undefined,
            parentId: parentGuid,
            storeyId: storeyGuid,
            aabb: {
              min: [elemMin.x, elemMin.y, elemMin.z],
              max: [elemMax.x, elemMax.y, elemMax.z],
            },
            psets: this.elemPsetsMap.get(rec.id) || {},
          });
        }
      } catch (prodErr: any) {
        const msg = `Error al calcular envolvente de producto STEP #${rec.id} (${rec.type}): ${prodErr?.message || prodErr}`;
        console.warn(`[IfcStepImporter] ${msg}`);
        this.importWarnings.push(msg);
      }
    }

    if (modelMin.x === Infinity) {
      modelMin.set(-5, 0, -5);
      modelMax.set(5, 3, 5);
    }

    this.cachedBoundsPayload = {
      type: 'STAGE_BOUNDS_AABB',
      elements: lightweight ? [] : elements,
      totalElements: lightweight ? this.productRecordsList.length : elements.length,
      modelAABB: {
        min: [modelMin.x, modelMin.y, modelMin.z],
        max: [modelMax.x, modelMax.y, modelMax.z],
      },
    };

    return this.cachedBoundsPayload;
  }

  /**
   * Returns the list of STEP IDs for all priority product records gathered during prepareImport.
   */
  public getProductStepIds(): number[] {
    if (!this.isPrepared) this.prepareImport();
    return this.productRecordsList.map((r) => r.id);
  }

  public getProductRecordsList(): readonly StepRecord[] {
    if (!this.isPrepared) this.prepareImport();
    return this.productRecordsList;
  }

  public getStepIdToEntityIdMap(): ReadonlyMap<number, string> {
    return this.stepIdToEntityId;
  }

  /**
   * Generates and streams tessellated geometry in batches using Transferable Objects (Stage 3 - Phase 4).
   * Supports an optional subset of STEP IDs for distributed multi-worker tessellation.
   */
  public extractGeometryChunks(
    chunkSize: number = 150,
    onChunk?: (chunk: Stage3GeometryChunkPayload, transferables: Transferable[]) => void,
    subsetStepIds?: number[]
  ): Stage3GeometryChunkPayload[] {
    if (!this.isPrepared) this.prepareImport();

    const recordsToProcess: StepRecord[] = subsetStepIds
      ? subsetStepIds.map((id) => this.records.get(id)).filter((r): r is StepRecord => Boolean(r))
      : this.productRecordsList;

    const totalProducts = recordsToProcess.length;
    const totalChunks = Math.max(1, Math.ceil(totalProducts / chunkSize));
    const allChunks: Stage3GeometryChunkPayload[] = [];

    let currentChunkElements: TessellatedElementDTO[] = [];
    let currentTransferables: Transferable[] = [];
    let chunkIndex = 0;

    for (let i = 0; i < totalProducts; i++) {
      const rec = recordsToProcess[i];
      try {
        const parentStepId = this.stepChildToParentMap.get(rec.id);
        let parentGuid: string | null = null;
        let storeyGuid: string | null = null;

        if (rec.type === 'IFCSITE' && (!parentStepId || !this.storeyMap.has(parentStepId))) {
          parentGuid = (parentStepId ? this.stepIdToEntityId.get(parentStepId) : null) || null;
          storeyGuid = null;
        } else if (parentStepId && this.storeyMap.has(parentStepId)) {
          storeyGuid = this.storeyMap.get(parentStepId)!.guid;
          parentGuid = this.storeyToBuildingGuidMap.get(parentStepId) || this.defaultBuildingId || null;
        } else if (parentStepId) {
          parentGuid = this.stepIdToEntityId.get(parentStepId) || this.defaultBuildingId || null;
          storeyGuid = this.getInheritedStoreyGuid(parentStepId);
        } else {
          parentGuid = this.defaultBuildingId || null;
        }

        if (parentGuid === this.defaultProjectId) {
          parentGuid = null;
        }

        if (rec.type === 'IFCOPENINGELEMENT') {
          const hostStepId = this.openingToHostStepMap.get(rec.id);
          const hostGuid = hostStepId ? this.stepIdToEntityId.get(hostStepId) : null;
          if (hostGuid) {
            parentGuid = hostGuid;
          }
        }

        if (this.fillToOpeningStepMap.has(rec.id)) {
          const openingStepId = this.fillToOpeningStepMap.get(rec.id)!;
          const openingGuid = this.stepIdToEntityId.get(openingStepId);
          if (openingGuid) {
            const psets = this.elemPsetsMap.get(rec.id) || {};
            if (!psets.Pset_OpeningFiller) psets.Pset_OpeningFiller = {};
            psets.Pset_OpeningFiller.FillsOpening = {
              type: 'IfcLabel',
              value: openingGuid,
            };
            this.elemPsetsMap.set(rec.id, psets);
          }
        }

        if (rec.type === 'IFCOPENINGELEMENT') {
          const hostStepId = this.openingToHostStepMap.get(rec.id);
          const hostGuid = hostStepId ? this.stepIdToEntityId.get(hostStepId) : null;
          if (hostGuid) {
            parentGuid = hostGuid;
          }

          const effectiveParent = parentGuid || this.defaultBuildingId || '';
          const rawGuid = this.getParamString(rec.params[0]);
          const openingId =
            this.stepIdToEntityId.get(rec.id) ||
            (rawGuid && GuidUtils.isIfcGuid(rawGuid) ? rawGuid : GuidUtils.createIfcGuid());
          this.stepIdToEntityId.set(rec.id, openingId);

          const rawName = this.getParamString(rec.params[2]);
          const openingName = rawName || 'Opening (IfcOpeningElement)';

          const psets = this.elemPsetsMap.get(rec.id) || {};
          if (!psets.Pset_Opening) psets.Pset_Opening = {};
          if (hostGuid) {
            psets.Pset_Opening.VoidsElements = {
              type: 'IfcLabel',
              value: JSON.stringify([hostGuid]),
            };
          }

          currentChunkElements.push({
            id: openingId,
            stepId: rec.id,
            name: openingName,
            type: 'GROUP',
            ifcType: 'IfcOpeningElement',
            predefinedType: 'OPENING',
            parentId: effectiveParent,
            storeyId: storeyGuid,
            psets,
            positions: new Float32Array(0),
            normals: new Float32Array(0),
            indices: new Uint32Array(0),
            edgesBuffer: new Float32Array(0),
            brepData: null,
            hidden: true,
          });
        } else if (rec.type === 'IFCSPACE') {
          // Spatial functional volumes (Rule 15): retain spatial metadata and hierarchy,
          // but hide 3D geometry from physical architectural viewport rendering
          const rawGuid = this.getParamString(rec.params[0]);
          const spaceId = this.stepIdToEntityId.get(rec.id) || (rawGuid && GuidUtils.isIfcGuid(rawGuid) ? rawGuid : GuidUtils.createIfcGuid());
          const spaceName = this.getParamString(rec.params[2]) || 'Espacio';
          const psets = this.elemPsetsMap.get(rec.id) || {};
          const effectiveParent = parentGuid || this.defaultBuildingId || '';

          currentChunkElements.push({
            id: spaceId,
            stepId: rec.id,
            name: spaceName,
            type: 'GROUP',
            ifcType: 'IfcSpace',
            predefinedType: this.getPredefinedType(rec) || undefined,
            parentId: effectiveParent,
            storeyId: storeyGuid,
            psets,
            positions: new Float32Array(0),
            normals: new Float32Array(0),
            indices: new Uint32Array(0),
            edgesBuffer: new Float32Array(0),
            brepData: null,
            hidden: true,
          });
        } else {
          const effectiveParent = (rec.type === 'IFCSITE' && (!parentStepId || !this.storeyMap.has(parentStepId))) ? (parentGuid || null) : (parentGuid || this.defaultBuildingId || '');
          const psets = this.elemPsetsMap.get(rec.id) || this.resolveElementProperties(rec.id);
          const parsed = this.rebuildProductEntities(
            rec,
            effectiveParent,
            psets,
            this.itemToStyleMap,
            this.faceToStyleMap,
            this.elementMaterialMap
          );

          if (parsed) {
            const { rootEntity, children } = parsed;

            if (rootEntity.type === 'GROUP') {
              currentChunkElements.push({
                id: rootEntity.id,
                stepId: rec.id,
                name: rootEntity.name || IfcStepImporter.canonicalizeIfcType(rec.type),
                type: 'GROUP',
                ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                predefinedType: this.getPredefinedType(rec) || undefined,
                parentId: rootEntity.parentId !== undefined ? rootEntity.parentId : ((rec.type === 'IFCSITE' && (!parentStepId || !this.storeyMap.has(parentStepId))) ? (parentGuid || null) : this.defaultBuildingId),
                storeyId: storeyGuid,
                matrixId: rootEntity.matrixId || null,
                psets: psets || {},
                materialId: undefined,
                positions: new Float32Array(0),
                normals: new Float32Array(0),
                indices: new Uint32Array(0),
                edgesBuffer: new Float32Array(0),
                brepData: null,
                hidden: rootEntity.hidden,
              });

              for (const child of children) {
                if (child.rawGeometry) {
                  const { positions, normals, indices } = child.rawGeometry;
                  const edgesBuffer = child.rawGeometry.edgesBuffer || new Float32Array(0);

                  currentTransferables.push(positions.buffer, normals.buffer, indices.buffer);
                  if (edgesBuffer.buffer.byteLength > 0) {
                    currentTransferables.push(edgesBuffer.buffer);
                  }

                  currentChunkElements.push({
                    id: child.id,
                    stepId: rec.id,
                    name: child.name || rootEntity.name || 'Malla Triangulada',
                    type: 'GEOMETRY_ENTITY',
                    ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                    predefinedType: undefined,
                    parentId: child.parentId || rootEntity.id,
                    storeyId: storeyGuid,
                    psets: {},
                    materialId: child.materialId || this.elementMaterialMap.get(rec.id) || this.itemToStyleMap.get(rec.id),
                    positions,
                    normals,
                    indices,
                    edgesBuffer,
                    geometry: {
                      triPositions: positions,
                      triNormals: normals,
                      triIndices: indices,
                      featureEdges: edgesBuffer,
                    },
                    brepData: null,
                    hidden: child.hidden || rootEntity.hidden,
                  });
                  continue;
                }

                if (child.polyMesh && child.polyMesh.faces.size > 0) {
                  const mesh = child.polyMesh;
                  this.carveOpeningsIntoMesh(rec.id, mesh);
                  const { positions, normals, indices, edgesBuffer } = mesh.toRawBuffers();
                  const brepData = null;

                  currentTransferables.push(positions.buffer, normals.buffer, indices.buffer);
                  if (edgesBuffer.buffer.byteLength > 0) {
                    currentTransferables.push(edgesBuffer.buffer);
                  }

                  currentChunkElements.push({
                    id: child.id,
                    stepId: rec.id,
                    name: child.name || rootEntity.name || 'Malla',
                    type: 'GEOMETRY_ENTITY',
                    ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                    predefinedType: undefined,
                    parentId: child.parentId || rootEntity.id,
                    storeyId: storeyGuid,
                    psets: {},
                    materialId: child.materialId || this.elementMaterialMap.get(rec.id) || this.itemToStyleMap.get(rec.id),
                    positions,
                    normals,
                    indices,
                    edgesBuffer,
                    geometry: {
                      triPositions: positions,
                      triNormals: normals,
                      triIndices: indices,
                      featureEdges: edgesBuffer,
                    },
                    brepData,
                    hidden: child.hidden || rootEntity.hidden,
                  });
                }
              }
            } else if (rootEntity.rawGeometry) {
              const { positions, normals, indices } = rootEntity.rawGeometry;
              const edgesBuffer = rootEntity.rawGeometry.edgesBuffer || new Float32Array(0);

              currentTransferables.push(positions.buffer, normals.buffer, indices.buffer);
              if (edgesBuffer.buffer.byteLength > 0) {
                currentTransferables.push(edgesBuffer.buffer);
              }

              const assignedMatId = rootEntity.materialId || this.elementMaterialMap.get(rec.id) || this.itemToStyleMap.get(rec.id);

              currentChunkElements.push({
                id: rootEntity.id,
                stepId: rec.id,
                name: rootEntity.name || IfcStepImporter.canonicalizeIfcType(rec.type),
                type: 'GEOMETRY_ENTITY',
                ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                predefinedType: this.getPredefinedType(rec) || undefined,
                parentId: rootEntity.parentId !== undefined ? rootEntity.parentId : ((rec.type === 'IFCSITE' && (!parentStepId || !this.storeyMap.has(parentStepId))) ? (parentGuid || null) : this.defaultBuildingId),
                storeyId: storeyGuid,
                psets: psets || {},
                materialId: assignedMatId,
                positions,
                normals,
                indices,
                edgesBuffer,
                geometry: {
                  triPositions: positions,
                  triNormals: normals,
                  triIndices: indices,
                  featureEdges: edgesBuffer,
                },
                brepData: null,
                hidden: rootEntity.hidden,
              });
            } else if (rootEntity.polyMesh && rootEntity.polyMesh.faces.size > 0) {
              const mesh = rootEntity.polyMesh;
              this.carveOpeningsIntoMesh(rec.id, mesh);
              const { positions, normals, indices, edgesBuffer } = mesh.toRawBuffers();
              const brepData = null;

              currentTransferables.push(positions.buffer, normals.buffer, indices.buffer);
              if (edgesBuffer.buffer.byteLength > 0) {
                currentTransferables.push(edgesBuffer.buffer);
              }

              const assignedMatId = rootEntity.materialId || this.elementMaterialMap.get(rec.id) || this.itemToStyleMap.get(rec.id);

              currentChunkElements.push({
                id: rootEntity.id,
                stepId: rec.id,
                name: rootEntity.name || IfcStepImporter.canonicalizeIfcType(rec.type),
                type: 'GEOMETRY_ENTITY',
                ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                predefinedType: this.getPredefinedType(rec) || undefined,
                parentId: rootEntity.parentId || this.defaultBuildingId,
                storeyId: storeyGuid,
                psets: psets || {},
                materialId: assignedMatId,
                positions,
                normals,
                indices,
                edgesBuffer,
                geometry: {
                  triPositions: positions,
                  triNormals: normals,
                  triIndices: indices,
                  featureEdges: edgesBuffer,
                },
                brepData,
                hidden: rootEntity.hidden,
              });
            }
          }
        }
      } catch (err: any) {
        const msg = `Error processing STEP product #${rec.id} (${rec.type}): ${err?.message || err}`;
        console.warn(`[IfcStepImporter] ${msg}`);
        this.importWarnings.push(msg);
      }

      // Emit chunk when chunkSize is reached or at the end
      if (currentChunkElements.length >= chunkSize || (i === totalProducts - 1 && currentChunkElements.length > 0)) {
        const payload: Stage3GeometryChunkPayload = {
          type: 'STAGE_GEOMETRY_CHUNK',
          chunkIndex,
          totalChunks,
          progress: (chunkIndex + 1) / totalChunks,
          elements: currentChunkElements,
        };

        allChunks.push(payload);
        if (onChunk) {
          onChunk(payload, currentTransferables);
        }

        chunkIndex++;
        currentChunkElements = [];
        currentTransferables = [];
      }
    }

    return allChunks;
  }

  /**
   * Carves associated openings (IfcOpeningElement) into the host element's B-Rep mesh.
   */
  private carveOpeningsIntoMesh(hostStepId: number, hostMesh: PolyMesh): void {
    const openingStepIds = this.hostToOpeningsStepMap.get(hostStepId);
    if (!openingStepIds || openingStepIds.size === 0) return;

    let anyCarved = false;
    for (const opStepId of openingStepIds) {
      let cached = this.openingMeshCache.get(opStepId);
      if (cached === undefined) {
        const opRec = this.records.get(opStepId);
        if (!opRec) {
          this.openingMeshCache.set(opStepId, null);
          continue;
        }
        const opEntity = this.rebuildProductEntity(opRec, null, this.elemPsetsMap.get(opStepId));
        if (opEntity && opEntity.polyMesh && opEntity.polyMesh.faces.size > 0) {
          cached = { polyMesh: opEntity.polyMesh, id: opEntity.id };
          this.openingMeshCache.set(opStepId, cached);
        } else {
          this.openingMeshCache.set(opStepId, null);
          continue;
        }
      }

      if (cached && cached.polyMesh && cached.polyMesh.faces.size > 0) {
        const carved = OpeningVoidSolver.carveVoidIntoHost(
          hostMesh,
          cached.polyMesh,
          cached.id,
          new THREE.Matrix4(),
          true,
          false,
          true
        );
        if (carved) {
          anyCarved = true;
        }
      }
    }

    if (anyCarved) {
      hostMesh.rebuildTopology();
    }
  }

  /**
   * Directly extracts raw coordinates (Float32Array) from a B-Rep item without instantiating PolyMesh on the heap.
   * Critical O(1) memory optimization for preliminary geometric congruence inspection (Rule 7).
   */
  private extractRawPositionsFromItem(itemId: number): Float32Array | null {
    const rec = this.records.get(itemId);
    if (!rec) return null;

    const shells: StepRecord[] = [];
    if (rec.type === 'IFCFACETEDBREP' || rec.type === 'IFCFACETEDBREPWITHVOIDS') {
      const sRef = rec.params[IFC_GEOM_ATTRS.FACETED_BREP_OUTER];
      if (sRef && typeof sRef === 'object' && 'ref' in sRef) {
        const found = this.records.get(sRef.ref);
        if (found) shells.push(found);
      }
      if (rec.type === 'IFCFACETEDBREPWITHVOIDS') {
        const voidsParam = rec.params[IFC_GEOM_ATTRS.FACETED_BREP_VOIDS];
        if (Array.isArray(voidsParam)) {
          for (const vRef of voidsParam) {
            if (vRef && typeof vRef === 'object' && 'ref' in vRef) {
              const vFound = this.records.get(vRef.ref);
              if (vFound) shells.push(vFound);
            }
          }
        }
      }
    } else if (
      rec.type === 'IFCCLOSEDSHELL' ||
      rec.type === 'IFCOPENSHELL' ||
      rec.type === 'IFCCONNECTEDFACESET'
    ) {
      shells.push(rec);
    }

    if (shells.length === 0) return null;

    const coords: number[] = [];
    for (const shellRec of shells) {
      const faceRefs = shellRec.params[0];
      if (!Array.isArray(faceRefs)) continue;

      for (const fRef of faceRefs) {
        if (!fRef || typeof fRef !== 'object' || !('ref' in fRef)) continue;
        const faceRec = this.records.get(fRef.ref);
        if (!faceRec) continue;
        const boundRefs = Array.isArray(faceRec.params[0]) ? faceRec.params[0] : [faceRec.params[0]];
        for (const bRef of boundRefs) {
          if (!bRef || typeof bRef !== 'object' || !('ref' in bRef)) continue;
          const bRec = this.records.get(bRef.ref);
          if (!bRec) continue;
          const loopRef = bRec.params[0];
          if (!loopRef || typeof loopRef !== 'object' || !('ref' in loopRef)) continue;
          const loopRec = this.records.get(loopRef.ref);
          if (!loopRec || loopRec.type !== 'IFCPOLYLOOP') continue;
          const ptRefs = loopRec.params[0];
          if (!Array.isArray(ptRefs)) continue;
          for (const ptRef of ptRefs) {
            if (!ptRef || typeof ptRef !== 'object' || !('ref' in ptRef)) continue;
            const ptRec = this.records.get(ptRef.ref);
            if (ptRec && ptRec.type === 'IFCCARTESIANPOINT' && Array.isArray(ptRec.params[0])) {
              const p = ptRec.params[0];
              const x = (typeof p[0] === 'number' ? p[0] : parseFloat(String(p[0])) || 0) * this.lengthUnitScale;
              const y = (typeof p[1] === 'number' ? p[1] : parseFloat(String(p[1])) || 0) * this.lengthUnitScale;
              const z = (typeof p[2] === 'number' ? p[2] : parseFloat(String(p[2])) || 0) * this.lengthUnitScale;
              coords.push(x, y, z);
            }
          }
        }
      }
    }
    return coords.length > 0 ? new Float32Array(coords) : null;
  }

  /**
   * Extracts and processes deferred massive elements (Phase 2 - Stage B).
   * Identifies congruent geometries with GeometryPrototypeDetector and emits them
   * as InstanceBatchPayload, collapsing instances on the GPU (Rule 4: matrixId).
   */
  public extractDeferredInstances(
    detector: GeometryPrototypeDetector,
    onInstanceBatch: (batch: InstanceBatchPayload) => void,
    onPrototypeChunk?: (chunk: Stage3GeometryChunkPayload, transferables: Transferable[]) => void,
    subsetDeferredTypes?: string[]
  ): { totalPrototypes: number; totalInstances: number } {
    if (!this.isPrepared) this.prepareImport();

    const deferredTypes = subsetDeferredTypes && subsetDeferredTypes.length > 0
      ? subsetDeferredTypes
      : IfcStepImporter.DEFERRED_PRODUCT_TYPES;

    const pendingBatches: Map<string, InstanceElementDTO[]> = new Map();
    const mappedRepPrototypes: Map<
      string,
      { parts: Array<{ prototypeId: string; baseCroqMatrix: THREE.Matrix4 }> }
    > = new Map();

    for (const dType of deferredTypes) {
      if (dType === 'IFCOPENINGELEMENT' || dType === 'IFCSPACE') continue;
      const records = this.parser.getRecordsByType(dType);
      for (const rec of records) {
        if (rec.type === 'IFCOPENINGELEMENT' || rec.type === 'IFCSPACE') continue;
        try {
          const rawGuid = this.getParamString(rec.params[0]);
          const productGuid =
            this.stepIdToEntityId.get(rec.id) ||
            (rawGuid && GuidUtils.isIfcGuid(rawGuid) ? rawGuid : GuidUtils.createIfcGuid());
          this.stepIdToEntityId.set(rec.id, productGuid);
          const name = this.getParamString(rec.params[2]) || rec.type;

          const parentStepId = this.stepChildToParentMap.get(rec.id);
          let parentGuid: string | null = null;
          let storeyGuid: string | null = null;

          if (parentStepId && this.storeyMap.has(parentStepId)) {
            storeyGuid = this.storeyMap.get(parentStepId)!.guid;
            parentGuid =
              this.storeyToBuildingGuidMap.get(parentStepId) || this.defaultBuildingId || null;
          } else if (parentStepId) {
            parentGuid = this.stepIdToEntityId.get(parentStepId) || this.defaultBuildingId || null;
            storeyGuid = this.getInheritedStoreyGuid(parentStepId);
          } else {
            parentGuid = this.defaultBuildingId || null;
          }

          if (parentGuid === this.defaultProjectId) parentGuid = null;

          // Resolve local spatial placement
          const placementParam = rec.params[5];
          let mProduct = new THREE.Matrix4();
          if (placementParam && typeof placementParam === 'object' && 'ref' in placementParam) {
            mProduct = this.resolveLocalPlacementMatrix((placementParam as any).ref);
          }

          // Extract shape representations
          const shapeParam = rec.params[6];
          if (!shapeParam || typeof shapeParam !== 'object' || !('ref' in shapeParam)) {
            continue;
          }
          const shapeRec = this.records.get((shapeParam as any).ref);
          if (!shapeRec) continue;
          const repsList = shapeRec.params[2];
          if (!Array.isArray(repsList)) continue;

          let allGeomRefs: number[] = [];
          for (const repItem of repsList) {
            if (!repItem || typeof repItem !== 'object' || !('ref' in repItem)) continue;
            const repRec = this.records.get(repItem.ref);
            if (!repRec || this.isNonBodyShapeRepresentation(repRec)) continue;
            const geomItems = repRec.params[3];
            if (Array.isArray(geomItems)) {
              for (const gItem of geomItems) {
                if (gItem && typeof gItem === 'object' && 'ref' in gItem) {
                  const gRec = this.records.get(gItem.ref);
                  if (gRec && gRec.type === 'IFCBOUNDINGBOX') continue;
                  allGeomRefs.push(gItem.ref);
                }
              }
            }
          }

          if (allGeomRefs.length <= 1) {
            // Case 1: Single-component product, MappedRepresentation, or continuous profile
            let paramSig: ParametricSolidSignature | null = null;
            let mappedInfo: { mapRecId: number; mLocal: THREE.Matrix4; cacheKey: string } | null = null;

            if (allGeomRefs.length === 1) {
              const geomRec = this.records.get(allGeomRefs[0]);
              if (geomRec) {
                if (geomRec.type === 'IFCMAPPEDITEM') {
                  const resolvedMap = this.resolveMappedItemInfo(geomRec);
                  if (resolvedMap) {
                    const styleOverride =
                      this.itemToStyleMap.get(geomRec.id) ||
                      this.elementMaterialMap.get(rec.id) ||
                      this.itemToStyleMap.get(rec.id) ||
                      '';
                    mappedInfo = {
                      mapRecId: resolvedMap.mapRecId,
                      mLocal: resolvedMap.mLocal,
                      cacheKey: `${resolvedMap.mapRecId}_${styleOverride}`,
                    };
                  }
                } else {
                  paramSig = ParametricSolidHasher.computeSolidHash(this.records, geomRec, this.lengthUnitScale);
                }
              }
            }

            if (mappedInfo) {
              const cachedMapped = mappedRepPrototypes.get(mappedInfo.cacheKey);
              if (cachedMapped && cachedMapped.parts.length > 0) {
                const M_eff = new THREE.Matrix4().multiplyMatrices(mProduct, mappedInfo.mLocal);
                const M_placement_croq = M_CANONICAL.clone().multiply(M_eff).multiply(M_CANONICAL_INV);

                if (cachedMapped.parts.length === 1) {
                  const part = cachedMapped.parts[0];
                  const M_croq = new THREE.Matrix4().multiplyMatrices(M_placement_croq, part.baseCroqMatrix);

                  let batch = pendingBatches.get(part.prototypeId);
                  if (!batch) {
                    batch = [];
                    pendingBatches.set(part.prototypeId, batch);
                  }

                  batch.push({
                    id: productGuid,
                    stepId: rec.id,
                    name,
                    ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                    parentId: parentGuid || this.defaultBuildingId || null,
                    storeyId: storeyGuid,
                    transform: new Float32Array(M_croq.elements),
                    psets: this.elemPsetsMap.get(rec.id),
                  });

                  detector.totalInstancesDetected++;

                  if (batch.length >= 100) {
                    onInstanceBatch({
                      type: 'STAGE_INSTANCE_BATCH',
                      prototypeId: part.prototypeId,
                      instances: batch,
                    });
                    pendingBatches.set(part.prototypeId, []);
                  }
                } else {
                  if (onPrototypeChunk) {
                    onPrototypeChunk(
                      {
                        type: 'STAGE_GEOMETRY_CHUNK',
                        chunkIndex: 0,
                        totalChunks: 1,
                        progress: 0.0,
                        elements: [
                          {
                            id: productGuid,
                            stepId: rec.id,
                            name,
                            type: 'GROUP',
                            ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                            predefinedType: this.getPredefinedType(rec) || undefined,
                            parentId: parentGuid || this.defaultBuildingId,
                            storeyId: storeyGuid,
                            psets: this.elemPsetsMap.get(rec.id) || {},
                            positions: new Float32Array(0),
                            normals: new Float32Array(0),
                            indices: new Uint32Array(0),
                            edgesBuffer: new Float32Array(0),
                            brepData: null,
                          },
                        ],
                      },
                      []
                    );
                  }

                  for (let k = 0; k < cachedMapped.parts.length; k++) {
                    const part = cachedMapped.parts[k];
                    const M_croq = new THREE.Matrix4().multiplyMatrices(M_placement_croq, part.baseCroqMatrix);
                    const pieceGuid = GuidUtils.createIfcGuid();

                    let batch = pendingBatches.get(part.prototypeId);
                    if (!batch) {
                      batch = [];
                      pendingBatches.set(part.prototypeId, batch);
                    }

                    batch.push({
                      id: pieceGuid,
                      stepId: rec.id,
                      name: `${name} (Part ${k + 1})`,
                      ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                      parentId: productGuid,
                      storeyId: storeyGuid,
                      transform: new Float32Array(M_croq.elements),
                      psets: {},
                    });

                    detector.totalInstancesDetected++;

                    if (batch.length >= 100) {
                      onInstanceBatch({
                        type: 'STAGE_INSTANCE_BATCH',
                        prototypeId: part.prototypeId,
                        instances: batch,
                      });
                      pendingBatches.set(part.prototypeId, []);
                    }
                  }
                }
                continue;
              }
            }

            if (paramSig) {
              const existingProto = this.parametricPrototypes.get(paramSig.hash);
              if (existingProto) {
                const M_rel = new THREE.Matrix4().multiplyMatrices(paramSig.solidMatrix, existingProto.solidMatrixInv);
                const M_eff = new THREE.Matrix4().multiplyMatrices(mProduct, M_rel);
                const [cx, cy, cz] = existingProto.centroid_ifc;
                const M_ifc = M_eff
                  .multiply(new THREE.Matrix4().makeTranslation(cx, cy, cz))
                  .multiply(existingProto.pcaRotation);
                const M_croq = M_CANONICAL.clone().multiply(M_ifc).multiply(M_CANONICAL_INV);

                let batch = pendingBatches.get(existingProto.prototypeId);
                if (!batch) {
                  batch = [];
                  pendingBatches.set(existingProto.prototypeId, batch);
                }

                batch.push({
                  id: productGuid,
                  stepId: rec.id,
                  name,
                  ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                  parentId: parentGuid || this.defaultBuildingId || null,
                  storeyId: storeyGuid,
                  transform: new Float32Array(M_croq.elements),
                  psets: this.elemPsetsMap.get(rec.id),
                });

                detector.totalInstancesDetected++;

                if (batch.length >= 100) {
                  onInstanceBatch({
                    type: 'STAGE_INSTANCE_BATCH',
                    prototypeId: existingProto.prototypeId,
                    instances: batch,
                  });
                  pendingBatches.set(existingProto.prototypeId, []);
                }
                continue;
              }
            }

            const subMeshes = this.rebuildSubMeshesFromShape(
              (shapeParam as any).ref,
              productGuid,
              this.itemToStyleMap,
              this.faceToStyleMap
            );

            if (subMeshes.length === 0) continue;

            const mPlacementCroqInv = mappedInfo
              ? M_CANONICAL.clone()
                  .multiply(new THREE.Matrix4().multiplyMatrices(mProduct, mappedInfo.mLocal))
                  .multiply(M_CANONICAL_INV)
                  .invert()
              : null;
            const registeredMappedParts: Array<{ prototypeId: string; baseCroqMatrix: THREE.Matrix4 }> = [];

            if (subMeshes.length === 1) {
              const primarySubMesh = subMeshes[0];
              const mesh = primarySubMesh.mesh;
              if (mesh.vertices.size === 0 || mesh.faces.size === 0) continue;

              // Query / register in prototype detector using a distinct prototype template key
              // so the product's own IFC GUID is preserved on the rendered instance.
              const protoKey = `proto_${rec.id}`;
              const match = detector.checkOrRegister(protoKey, rec.id, mesh, mProduct);

              if (mPlacementCroqInv) {
                const mMatch = new THREE.Matrix4().fromArray(match.transform);
                registeredMappedParts.push({
                  prototypeId: match.prototypeId,
                  baseCroqMatrix: new THREE.Matrix4().multiplyMatrices(mPlacementCroqInv, mMatch),
                });
              }

              if (match.isInstance) {
                let batch = pendingBatches.get(match.prototypeId);
                if (!batch) {
                  batch = [];
                  pendingBatches.set(match.prototypeId, batch);
                }

                batch.push({
                  id: productGuid,
                  stepId: rec.id,
                  name,
                  ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                  parentId: parentGuid || this.defaultBuildingId || null,
                  storeyId: storeyGuid,
                  transform: match.transform,
                  psets: this.elemPsetsMap.get(rec.id),
                });

                if (paramSig) {
                  const protoRec = detector.getPrototype(match.prototypeId);
                  this.parametricPrototypes.set(paramSig.hash, {
                    prototypeId: match.prototypeId,
                    stepId: rec.id,
                    centroid_ifc: match.centroid_ifc,
                    pcaRotation: protoRec?.pcaRotation || new THREE.Matrix4().identity(),
                    solidMatrixInv: paramSig.solidMatrix.clone().invert(),
                  });
                }

                if (batch.length >= 100) {
                  onInstanceBatch({
                    type: 'STAGE_INSTANCE_BATCH',
                    prototypeId: match.prototypeId,
                    instances: batch,
                  });
                  pendingBatches.set(match.prototypeId, []);
                }
              } else {
                // New prototype: center in Croquera Y-up space in-place on PolyMesh
                // and emit as hidden template for InstancedMesh.
                const M_proto = match.toCanonicalCroqueraMatrix;

                // Transform PolyMesh vertices in-place to canonical Croquera space via PCA
                for (const v of mesh.vertices.values()) {
                  v.position = v.position.applyMatrix4(M_proto);
                }
                // toThreeGeometry() will recalculate normals from already transformed vertices.
                // Only transform holes if they exist.
                for (const f of mesh.faces.values()) {
                  if (f.holes && f.holes.length > 0) {
                    f.holes = f.holes.map((loop) =>
                      loop.map((pt) => pt.applyMatrix4(M_proto))
                    );
                  }
                }

                if (onPrototypeChunk) {
                  // Generate buffers directly from transformed PolyMesh (Paso 1.2)
                  const { positions, normals, indices, edgesBuffer } = mesh.toRawBuffers();
                  const brepData = null;
                  const transferables: Transferable[] = [positions.buffer, normals.buffer, indices.buffer];
                  if (edgesBuffer.buffer.byteLength > 0) {
                    transferables.push(edgesBuffer.buffer);
                  }

                  const assignedMatId =
                    primarySubMesh.materialId ||
                    this.elementMaterialMap.get(rec.id) ||
                    this.itemToStyleMap.get(rec.id);

                  const protoElement: TessellatedElementDTO = {
                    id: match.prototypeId,
                    stepId: rec.id,
                    name: `[Prototype] ${name}`,
                    type: 'GEOMETRY_ENTITY',
                    ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                    predefinedType: this.getPredefinedType(rec) || undefined,
                    parentId: parentGuid || this.defaultBuildingId,
                    storeyId: storeyGuid,
                    matrixId: match.prototypeId,
                    hidden: true,
                    psets: {},
                    materialId: assignedMatId,
                    positions,
                    normals,
                    indices,
                    edgesBuffer,
                    brepData,
                  };

                  onPrototypeChunk(
                    { type: 'STAGE_GEOMETRY_CHUNK', chunkIndex: 0, totalChunks: 1, progress: 0.0, elements: [protoElement] },
                    transferables
                  );
                }

                // Emit first occurrence as an instance preserving its real IFC productGuid and psets
                let protoBatch = pendingBatches.get(match.prototypeId);
                if (!protoBatch) {
                  protoBatch = [];
                  pendingBatches.set(match.prototypeId, protoBatch);
                }
                protoBatch.push({
                  id: productGuid,
                  stepId: rec.id,
                  name,
                  ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                  parentId: parentGuid || this.defaultBuildingId || null,
                  storeyId: storeyGuid,
                  transform: match.transform,
                  psets: this.elemPsetsMap.get(rec.id),
                });

                if (paramSig) {
                  const protoRec = detector.getPrototype(match.prototypeId);
                  this.parametricPrototypes.set(paramSig.hash, {
                    prototypeId: match.prototypeId,
                    stepId: rec.id,
                    centroid_ifc: match.centroid_ifc,
                    pcaRotation: protoRec?.pcaRotation || new THREE.Matrix4().identity(),
                    solidMatrixInv: paramSig.solidMatrix.clone().invert(),
                  });
                }
              }
            } else {
              // Multi-component assembly (e.g. MappedItem or multi-material element)
              // Emit container GROUP for assembly to preserve product GUID, metadata and IFC classification (Rule 15)
              if (onPrototypeChunk) {
                onPrototypeChunk(
                  {
                    type: 'STAGE_GEOMETRY_CHUNK',
                    chunkIndex: 0,
                    totalChunks: 1,
                    progress: 0.0,
                    elements: [
                      {
                        id: productGuid,
                        stepId: rec.id,
                        name,
                        type: 'GROUP',
                        ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                        predefinedType: this.getPredefinedType(rec) || undefined,
                        parentId: parentGuid || this.defaultBuildingId,
                        storeyId: storeyGuid,
                        psets: this.elemPsetsMap.get(rec.id) || {},
                        positions: new Float32Array(0),
                        normals: new Float32Array(0),
                        indices: new Uint32Array(0),
                        edgesBuffer: new Float32Array(0),
                        brepData: null,
                      },
                    ],
                  },
                  []
                );
              }

              for (let k = 0; k < subMeshes.length; k++) {
                const sm = subMeshes[k];
                const mesh = sm.mesh;
                if (mesh.vertices.size === 0 || mesh.faces.size === 0) continue;

                const subKey = `proto_${rec.id}_sub_${k}`;
                const match = detector.checkOrRegister(subKey, rec.id, mesh, mProduct);
                const pieceGuid = GuidUtils.createIfcGuid();

                if (mPlacementCroqInv) {
                  const mMatch = new THREE.Matrix4().fromArray(match.transform);
                  registeredMappedParts.push({
                    prototypeId: match.prototypeId,
                    baseCroqMatrix: new THREE.Matrix4().multiplyMatrices(mPlacementCroqInv, mMatch),
                  });
                }

                if (match.isInstance) {
                  let batch = pendingBatches.get(match.prototypeId);
                  if (!batch) {
                    batch = [];
                    pendingBatches.set(match.prototypeId, batch);
                  }

                  batch.push({
                    id: pieceGuid,
                    stepId: rec.id,
                    name: `${name} (Part ${k + 1})`,
                    ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                    parentId: productGuid,
                    storeyId: storeyGuid,
                    transform: match.transform,
                    psets: {},
                  });

                  if (batch.length >= 100) {
                    onInstanceBatch({
                      type: 'STAGE_INSTANCE_BATCH',
                      prototypeId: match.prototypeId,
                      instances: batch,
                    });
                    pendingBatches.set(match.prototypeId, []);
                  }
                } else {
                  const M_proto = match.toCanonicalCroqueraMatrix;

                  for (const v of mesh.vertices.values()) {
                    v.position = v.position.applyMatrix4(M_proto);
                  }
                  for (const f of mesh.faces.values()) {
                    if (f.holes && f.holes.length > 0) {
                      f.holes = f.holes.map((loop) =>
                        loop.map((pt) => pt.applyMatrix4(M_proto))
                      );
                    }
                  }

                  if (onPrototypeChunk) {
                    const { positions, normals, indices, edgesBuffer } = mesh.toRawBuffers();

                    const transferables: Transferable[] = [positions.buffer, normals.buffer, indices.buffer];
                    if (edgesBuffer.buffer.byteLength > 0) {
                      transferables.push(edgesBuffer.buffer);
                    }

                    const assignedMatId =
                      sm.materialId || this.elementMaterialMap.get(rec.id) || this.itemToStyleMap.get(rec.id);

                    const protoElement: TessellatedElementDTO = {
                      id: match.prototypeId,
                      stepId: rec.id,
                      name: `[Prototype] ${name} (Part ${k + 1})`,
                      type: 'GEOMETRY_ENTITY',
                      ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                      predefinedType: this.getPredefinedType(rec) || undefined,
                      parentId: productGuid,
                      storeyId: storeyGuid,
                      matrixId: match.prototypeId,
                      hidden: true,
                      psets: {},
                      materialId: assignedMatId,
                      positions,
                      normals,
                      indices,
                      edgesBuffer,
                      brepData: null,
                    };

                    onPrototypeChunk(
                      { type: 'STAGE_GEOMETRY_CHUNK', chunkIndex: 0, totalChunks: 1, progress: 0.0, elements: [protoElement] },
                      transferables
                    );
                  }

                  let protoBatch = pendingBatches.get(match.prototypeId);
                  if (!protoBatch) {
                    protoBatch = [];
                    pendingBatches.set(match.prototypeId, protoBatch);
                  }
                  protoBatch.push({
                    id: pieceGuid,
                    stepId: rec.id,
                    name: `${name} (Part ${k + 1})`,
                    ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                    parentId: productGuid,
                    storeyId: storeyGuid,
                    transform: match.transform,
                    psets: {},
                  });
                }
              }
            }

            if (mappedInfo && registeredMappedParts.length > 0) {
              mappedRepPrototypes.set(mappedInfo.cacheKey, { parts: registeredMappedParts });
            }
          } else {
            // Case 2: Massive assembly with hundreds/thousands of discrete repetitive items (e.g. balusters in ElManzano)
            // Emit container GROUP for assembly (Rule 15)
            if (onPrototypeChunk) {
              onPrototypeChunk(
                {
                  type: 'STAGE_GEOMETRY_CHUNK',
                  chunkIndex: 0,
                  totalChunks: 1,
                  progress: 0.0,
                  elements: [
                    {
                      id: productGuid,
                      stepId: rec.id,
                      name,
                      type: 'GROUP',
                      ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                      predefinedType: this.getPredefinedType(rec) || undefined,
                      parentId: parentGuid || this.defaultBuildingId,
                      storeyId: storeyGuid,
                      psets: this.elemPsetsMap.get(rec.id) || {},
                      positions: new Float32Array(0),
                      normals: new Float32Array(0),
                      indices: new Uint32Array(0),
                      edgesBuffer: new Float32Array(0),
                      brepData: null,
                    },
                  ],
                },
                []
              );
            }

            for (const itemRef of allGeomRefs) {
              const itemRec = this.records.get(itemRef);
              const paramSig = itemRec ? ParametricSolidHasher.computeSolidHash(this.records, itemRec, this.lengthUnitScale) : null;

              if (paramSig) {
                const existingProto = this.parametricPrototypes.get(paramSig.hash);
                if (existingProto) {
                  const M_rel = new THREE.Matrix4().multiplyMatrices(paramSig.solidMatrix, existingProto.solidMatrixInv);
                  const M_eff = new THREE.Matrix4().multiplyMatrices(mProduct, M_rel);
                  const [cx, cy, cz] = existingProto.centroid_ifc;
                  const M_ifc = M_eff
                    .multiply(new THREE.Matrix4().makeTranslation(cx, cy, cz))
                    .multiply(existingProto.pcaRotation);
                  const M_croq = M_CANONICAL.clone().multiply(M_ifc).multiply(M_CANONICAL_INV);

                  const pieceGuid = GuidUtils.createIfcGuid();
                  let batch = pendingBatches.get(existingProto.prototypeId);
                  if (!batch) {
                    batch = [];
                    pendingBatches.set(existingProto.prototypeId, batch);
                  }

                  batch.push({
                    id: pieceGuid,
                    stepId: rec.id,
                    name: `${name} (Part)`,
                    ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                    parentId: productGuid,
                    storeyId: storeyGuid,
                    transform: new Float32Array(M_croq.elements),
                    psets: {},
                  });

                  detector.totalInstancesDetected++;

                  if (batch.length >= 250) {
                    onInstanceBatch({
                      type: 'STAGE_INSTANCE_BATCH',
                      prototypeId: existingProto.prototypeId,
                      instances: batch,
                    });
                    pendingBatches.set(existingProto.prototypeId, []);
                  }
                  continue;
                }
              }

              const rawPos = this.extractRawPositionsFromItem(itemRef);
              let candidateMesh: PolyMesh | null = null;

              if (!rawPos || rawPos.length < 9) {
                // If raw coordinates cannot be extracted directly (e.g. extrusion, revolve, boolean, swept solid),
                // reconstruct PolyMesh ONCE.
                candidateMesh = this.rebuildMeshFromItem(itemRef, `proto_item_${itemRef}`, this.itemToStyleMap, this.faceToStyleMap);
                if (!candidateMesh || candidateMesh.faces.size === 0 || candidateMesh.vertices.size === 0) {
                  continue;
                }
              }

              const match = detector.checkOrRegister(
                `proto_item_${itemRef}`,
                itemRef,
                candidateMesh || rawPos!,
                mProduct
              );
              const pieceGuid = GuidUtils.createIfcGuid();

              if (match.isInstance) {
                let batch = pendingBatches.get(match.prototypeId);
                if (!batch) {
                  batch = [];
                  pendingBatches.set(match.prototypeId, batch);
                }

                batch.push({
                  id: pieceGuid,
                  name: `${name} (Part)`,
                  ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                  parentId: productGuid,
                  storeyId: storeyGuid,
                  transform: match.transform,
                  psets: {},
                });

                if (paramSig) {
                  const protoRec = detector.getPrototype(match.prototypeId);
                  this.parametricPrototypes.set(paramSig.hash, {
                    prototypeId: match.prototypeId,
                    stepId: itemRef,
                    centroid_ifc: match.centroid_ifc,
                    pcaRotation: protoRec?.pcaRotation || new THREE.Matrix4().identity(),
                    solidMatrixInv: paramSig.solidMatrix.clone().invert(),
                  });
                }

                if (batch.length >= 250) {
                  onInstanceBatch({
                    type: 'STAGE_INSTANCE_BATCH',
                    prototypeId: match.prototypeId,
                    instances: batch,
                  });
                  pendingBatches.set(match.prototypeId, []);
                }
              } else {
                // New part prototype:
                // If candidateMesh was already reconstructed, REUSE IT directly (cero double reconstruction)!
                // If rawPos was used, candidateMesh is null, so build itemMesh ONCE for the prototype.
                const itemMesh = candidateMesh || this.rebuildMeshFromItem(itemRef, match.prototypeId, this.itemToStyleMap, this.faceToStyleMap);
                if (itemMesh && itemMesh.faces.size > 0 && onPrototypeChunk) {
                  const M_proto = match.toCanonicalCroqueraMatrix;

                  // Transform vertices in-place to canonical Croquera space via PCA
                  for (const v of itemMesh.vertices.values()) {
                    v.position = v.position.applyMatrix4(M_proto);
                  }
                  // toThreeGeometry() will recalculate normals. Only transform holes.
                  for (const f of itemMesh.faces.values()) {
                    if (f.holes && f.holes.length > 0) {
                      f.holes = f.holes.map((loop) =>
                        loop.map((pt) => pt.applyMatrix4(M_proto))
                      );
                    }
                  }

                  const { positions, normals, indices, edgesBuffer } = itemMesh.toRawBuffers();

                  const brepData = null;
                  const transferables: Transferable[] = [positions.buffer, normals.buffer, indices.buffer];
                  if (edgesBuffer.buffer.byteLength > 0) {
                    transferables.push(edgesBuffer.buffer);
                  }

                  const assignedMatId =
                    this.itemToStyleMap.get(itemRef) ||
                    this.elementMaterialMap.get(rec.id) ||
                    this.itemToStyleMap.get(rec.id);

                  const protoElement: TessellatedElementDTO = {
                    id: match.prototypeId,
                    stepId: itemRef,
                    name: `[Prototype] ${name} (Part)`,
                    type: 'GEOMETRY_ENTITY',
                    ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                    predefinedType: this.getPredefinedType(rec) || undefined,
                    parentId: productGuid,
                    storeyId: storeyGuid,
                    matrixId: match.prototypeId,
                    hidden: true,
                    psets: {},
                    materialId: assignedMatId,
                    positions,
                    normals,
                    indices,
                    edgesBuffer,
                    brepData,
                  };

                  onPrototypeChunk(
                    { type: 'STAGE_GEOMETRY_CHUNK', chunkIndex: 0, totalChunks: 1, progress: 0.0, elements: [protoElement] },
                    transferables
                  );

                  let pieceBatch = pendingBatches.get(match.prototypeId);
                  if (!pieceBatch) {
                    pieceBatch = [];
                    pendingBatches.set(match.prototypeId, pieceBatch);
                  }
                  pieceBatch.push({
                    id: GuidUtils.createIfcGuid(),
                    stepId: rec.id,
                    name: `${name} (Part)`,
                    ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                    parentId: productGuid,
                    storeyId: storeyGuid,
                    transform: match.transform,
                    psets: {},
                  });

                  if (paramSig) {
                    const protoRec = detector.getPrototype(match.prototypeId);
                    this.parametricPrototypes.set(paramSig.hash, {
                      prototypeId: match.prototypeId,
                      stepId: itemRef,
                      centroid_ifc: match.centroid_ifc,
                      pcaRotation: protoRec?.pcaRotation || new THREE.Matrix4().identity(),
                      solidMatrixInv: paramSig.solidMatrix.clone().invert(),
                    });
                  }
                }
              }
            }
          }
        } catch (err: any) {
          console.warn(`[IfcStepImporter] Deferred instance evaluation failed for #${rec.id}: ${err?.message || err}`);
        }
      }
    }

    // Flush remaining pending batches
    for (const [prototypeId, instances] of pendingBatches.entries()) {
      if (instances.length > 0) {
        onInstanceBatch({
          type: 'STAGE_INSTANCE_BATCH',
          prototypeId,
          instances,
        });
      }
    }

    return {
      totalPrototypes: detector.totalPrototypes,
      totalInstances: detector.totalInstancesDetected,
    };
  }


  /**
   * Fast O(1) memory extraction of an IFCTRIANGULATEDFACESET / IFCTRIANGULATEDIRREGULARNETWORK
   * directly into Float32Array and Uint32Array without instantiating PolyMesh, Vec3, or Faces.
   */
  private extractFastTriangulatedItem(
    itemRec: StepRecord,
    mProduct: THREE.Matrix4
  ): { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edgesBuffer: Float32Array } | null {
    const pointListRef = itemRec.params[0];
    if (!pointListRef || typeof pointListRef !== 'object' || !('ref' in pointListRef)) {
      return null;
    }

    const pointListRec = this.records.get(pointListRef.ref);
    if (!pointListRec || !Array.isArray(pointListRec.params[0])) return null;

    const rawCoords = pointListRec.params[0];
    const numPts = rawCoords.length;
    if (numPts === 0) return null;

    // Resolve coordIndex and pnIndex
    let coordIndex: any = null;
    let pnIndexRaw: any = null;

    const candidate3 = itemRec.params[3];
    const candidate4 = itemRec.params[4];
    if (Array.isArray(candidate3) && candidate3.length > 0 && Array.isArray(candidate3[0])) {
      coordIndex = candidate3;
      if (Array.isArray(candidate4) && candidate4.length > 0 && !Array.isArray(candidate4[0])) {
        pnIndexRaw = candidate4;
      }
    } else if (Array.isArray(candidate4) && candidate4.length > 0 && Array.isArray(candidate4[0])) {
      coordIndex = candidate4;
      const candidate5 = itemRec.params[5];
      if (Array.isArray(candidate5) && candidate5.length > 0 && !Array.isArray(candidate5[0])) {
        pnIndexRaw = candidate5;
      } else if (Array.isArray(candidate3) && candidate3.length > 0 && !Array.isArray(candidate3[0])) {
        pnIndexRaw = candidate3;
      }
    }

    if (!coordIndex || !Array.isArray(coordIndex)) return null;

    // 1. Vectorized points extraction with matrix transform & canonical change of basis
    const positions = new Float32Array(numPts * 3);
    const el = mProduct.elements;
    const scale = this.lengthUnitScale;

    for (let i = 0; i < numPts; i++) {
      const pt = rawCoords[i];
      if (!Array.isArray(pt) || pt.length < 3) continue;

      const x = (typeof pt[0] === 'number' ? pt[0] : parseFloat(String(pt[0])) || 0) * scale;
      const y = (typeof pt[1] === 'number' ? pt[1] : parseFloat(String(pt[1])) || 0) * scale;
      const z = (typeof pt[2] === 'number' ? pt[2] : parseFloat(String(pt[2])) || 0) * scale;

      const px = el[0] * x + el[4] * y + el[8] * z + el[12];
      const py = el[1] * x + el[5] * y + el[9] * z + el[13];
      const pz = el[2] * x + el[6] * y + el[10] * z + el[14];

      // Canonical Croquera swap: X_croq = px, Y_croq = pz, Z_croq = -py
      positions[i * 3] = px;
      positions[i * 3 + 1] = pz;
      positions[i * 3 + 2] = -py;
    }

    // 2. Build triangle indices
    let maxCoordIndex = 0;
    for (const tri of coordIndex) {
      if (Array.isArray(tri)) {
        for (const idx of tri) {
          const num = typeof idx === 'number' ? idx : parseInt(String(idx), 10);
          if (num > maxCoordIndex) maxCoordIndex = num;
        }
      }
    }
    const isPointPnIndex = Array.isArray(pnIndexRaw) && pnIndexRaw.length >= maxCoordIndex;

    const numTris = coordIndex.length;
    const indices = new Uint32Array(numTris * 3);
    let writeIdx = 0;
    const det = mProduct.determinant();
    const isFlipped = det < 0;

    for (let t = 0; t < numTris; t++) {
      const tri = coordIndex[t];
      if (!Array.isArray(tri) || tri.length < 3) continue;

      let idx0 = typeof tri[0] === 'number' ? tri[0] : parseInt(String(tri[0]), 10);
      let idx1 = typeof tri[1] === 'number' ? tri[1] : parseInt(String(tri[1]), 10);
      let idx2 = typeof tri[2] === 'number' ? tri[2] : parseInt(String(tri[2]), 10);

      if (isNaN(idx0) || isNaN(idx1) || isNaN(idx2) || idx0 < 1 || idx1 < 1 || idx2 < 1) continue;
      if (idx0 === idx1 || idx1 === idx2 || idx2 === idx0) continue;

      if (isPointPnIndex) {
        idx0 = typeof pnIndexRaw[idx0 - 1] === 'number' ? pnIndexRaw[idx0 - 1] : parseInt(String(pnIndexRaw[idx0 - 1]), 10);
        idx1 = typeof pnIndexRaw[idx1 - 1] === 'number' ? pnIndexRaw[idx1 - 1] : parseInt(String(pnIndexRaw[idx1 - 1]), 10);
        idx2 = typeof pnIndexRaw[idx2 - 1] === 'number' ? pnIndexRaw[idx2 - 1] : parseInt(String(pnIndexRaw[idx2 - 1]), 10);
      }

      const u0 = idx0 - 1;
      const u1 = idx1 - 1;
      const u2 = idx2 - 1;

      if (u0 >= numPts || u1 >= numPts || u2 >= numPts) continue;

      if (isFlipped) {
        indices[writeIdx++] = u0;
        indices[writeIdx++] = u2;
        indices[writeIdx++] = u1;
      } else {
        indices[writeIdx++] = u0;
        indices[writeIdx++] = u1;
        indices[writeIdx++] = u2;
      }
    }

    if (writeIdx === 0) return null;
    const finalIndices = writeIdx === indices.length ? indices : indices.subarray(0, writeIdx);

    // 3. Fast vertex normal accumulation and per-triangle normal tracking
    const normals = new Float32Array(numPts * 3);
    const triCount = finalIndices.length / 3;
    const triNormals = new Float32Array(triCount * 3);

    for (let t = 0; t < triCount; t++) {
      const i0 = finalIndices[t * 3];
      const i1 = finalIndices[t * 3 + 1];
      const i2 = finalIndices[t * 3 + 2];

      const p0x = positions[i0 * 3], p0y = positions[i0 * 3 + 1], p0z = positions[i0 * 3 + 2];
      const p1x = positions[i1 * 3], p1y = positions[i1 * 3 + 1], p1z = positions[i1 * 3 + 2];
      const p2x = positions[i2 * 3], p2y = positions[i2 * 3 + 1], p2z = positions[i2 * 3 + 2];

      const v01x = p1x - p0x, v01y = p1y - p0y, v01z = p1z - p0z;
      const v02x = p2x - p0x, v02y = p2y - p0y, v02z = p2z - p0z;

      const nx = v01y * v02z - v01z * v02y;
      const ny = v01z * v02x - v01x * v02z;
      const nz = v01x * v02y - v01y * v02x;

      const tLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (tLen > 1e-8) {
        triNormals[t * 3] = nx / tLen;
        triNormals[t * 3 + 1] = ny / tLen;
        triNormals[t * 3 + 2] = nz / tLen;
      }

      normals[i0 * 3] += nx; normals[i0 * 3 + 1] += ny; normals[i0 * 3 + 2] += nz;
      normals[i1 * 3] += nx; normals[i1 * 3 + 1] += ny; normals[i1 * 3 + 2] += nz;
      normals[i2 * 3] += nx; normals[i2 * 3 + 1] += ny; normals[i2 * 3 + 2] += nz;
    }

    for (let i = 0; i < numPts; i++) {
      const nx = normals[i * 3];
      const ny = normals[i * 3 + 1];
      const nz = normals[i * 3 + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 1e-6) {
        normals[i * 3] = nx / len;
        normals[i * 3 + 1] = ny / len;
        normals[i * 3 + 2] = nz / len;
      } else {
        normals[i * 3] = 0;
        normals[i * 3 + 1] = 1;
        normals[i * 3 + 2] = 0;
      }
    }

    // 4. Feature edge extraction for architectural outlines & creases (suppress coplanar diagonals)
    const edgeMap = new Map<bigint, { v0: number; v1: number; t0: number; t1?: number; count: number }>();

    for (let t = 0; t < triCount; t++) {
      const i0 = finalIndices[t * 3];
      const i1 = finalIndices[t * 3 + 1];
      const i2 = finalIndices[t * 3 + 2];

      const triEdges = [
        [i0, i1],
        [i1, i2],
        [i2, i0],
      ];

      for (let e = 0; e < 3; e++) {
        const a = triEdges[e][0];
        const b = triEdges[e][1];
        const minV = a < b ? a : b;
        const maxV = a < b ? b : a;
        const key = (BigInt(minV) << 32n) | BigInt(maxV);

        let entry = edgeMap.get(key);
        if (!entry) {
          edgeMap.set(key, { v0: minV, v1: maxV, t0: t, count: 1 });
        } else {
          entry.t1 = t;
          entry.count++;
        }
      }
    }

    const COS_CREASE_THRESHOLD = 0.99619; // cos(5 deg)
    const edgeFloats: number[] = [];

    for (const edge of edgeMap.values()) {
      let isFeature = false;
      if (edge.count === 1 || edge.count > 2) {
        isFeature = true;
      } else if (edge.count === 2 && edge.t1 !== undefined) {
        const idx0 = edge.t0 * 3;
        const idx1 = edge.t1 * 3;
        const dot = Math.abs(
          triNormals[idx0] * triNormals[idx1] +
          triNormals[idx0 + 1] * triNormals[idx1 + 1] +
          triNormals[idx0 + 2] * triNormals[idx1 + 2]
        );
        if (dot < COS_CREASE_THRESHOLD) {
          isFeature = true;
        }
      }

      if (isFeature) {
        const u0 = edge.v0 * 3;
        const u1 = edge.v1 * 3;
        edgeFloats.push(
          positions[u0], positions[u0 + 1], positions[u0 + 2],
          positions[u1], positions[u1 + 1], positions[u1 + 2]
        );
      }
    }

    return {
      positions,
      normals,
      indices: finalIndices,
      edgesBuffer: new Float32Array(edgeFloats),
    };
  }

  /**
   * Fast-path generator for pure IFCTRIANGULATEDFACESET products without openings.
   * Directly produces raw TypedArrays (Float32Array / Uint32Array) for zero-copy GPU transmission.
   */
  private tryBuildFastTriangulatedEntities(
    rec: StepRecord,
    defaultParentId: string | null,
    _psets?: Record<string, Record<string, any>>,
    itemToStyleMap?: Map<number, string>,
    _faceToStyleMap?: Map<number, string>,
    elementMaterialMap?: Map<number, string>
  ): { rootEntity: EvaluatedProductEntity; children: EvaluatedProductEntity[] } | null {
    if (this.hostToOpeningsStepMap.has(rec.id)) {
      return null;
    }

    const shapeParam = rec.params[6];
    if (!shapeParam || typeof shapeParam !== 'object' || !('ref' in shapeParam)) {
      return null;
    }

    const shapeRec = this.records.get(shapeParam.ref);
    if (!shapeRec || shapeRec.type !== 'IFCPRODUCTDEFINITIONSHAPE') {
      return null;
    }

    const repsList = shapeRec.params[2];
    if (!Array.isArray(repsList) || repsList.length === 0) {
      return null;
    }

    const fastItems: { itemRec: StepRecord; repStyleId?: string }[] = [];
    let hasOtherGeometry = false;

    for (const item of repsList) {
      if (!item || typeof item !== 'object' || !('ref' in item)) continue;
      const repRec = this.records.get(item.ref);
      if (!repRec || this.isNonBodyShapeRepresentation(repRec)) continue;

      const repStyleId = itemToStyleMap?.get(repRec.id);
      const geomItems = repRec.params[3];
      if (!Array.isArray(geomItems)) continue;

      for (const geomItem of geomItems) {
        if (!geomItem || typeof geomItem !== 'object' || !('ref' in geomItem)) continue;
        const gRec = this.records.get(geomItem.ref);
        if (!gRec || gRec.type === 'IFCBOUNDINGBOX') continue;

        if (gRec.type === 'IFCTRIANGULATEDFACESET' || gRec.type === 'IFCTRIANGULATEDIRREGULARNETWORK') {
          fastItems.push({ itemRec: gRec, repStyleId: itemToStyleMap?.get(gRec.id) || repStyleId });
        } else {
          hasOtherGeometry = true;
          break;
        }
      }
      if (hasOtherGeometry) break;
    }

    if (hasOtherGeometry || fastItems.length === 0) {
      return null;
    }

    // Resolve ObjectPlacement
    const placementParam = rec.params[5];
    let mProduct = new THREE.Matrix4();
    if (placementParam && typeof placementParam === 'object' && 'ref' in placementParam) {
      mProduct = this.resolveLocalPlacementMatrix(placementParam.ref);
    }

    const rawGuid = this.getParamString(rec.params[0]);
    const id = this.stepIdToEntityId.get(rec.id) || (rawGuid && GuidUtils.isIfcGuid(rawGuid) ? rawGuid : GuidUtils.createIfcGuid());
    this.stepIdToEntityId.set(rec.id, id);
    const name = this.getParamString(rec.params[2]) || rec.type;
    const productLevelMatId = elementMaterialMap?.get(rec.id) || itemToStyleMap?.get(rec.id);

    const isSpace = rec.type === 'IFCSPACE';
    const children: EvaluatedProductEntity[] = [];

    for (let idx = 0; idx < fastItems.length; idx++) {
      const fi = fastItems[idx];
      const rawGeo = this.extractFastTriangulatedItem(fi.itemRec, mProduct);
      if (!rawGeo || rawGeo.indices.length === 0) continue;

      const childId = GuidUtils.createIfcGuid();
      const matId = fi.repStyleId || productLevelMatId;
      const childName = fastItems.length === 1
        ? name
        : `${name} [${matId || 'Parte ' + (idx + 1)}]`;

      children.push({
        id: childId,
        type: 'GEOMETRY_ENTITY',
        name: childName,
        parentId: id,
        rawGeometry: rawGeo,
        materialId: matId,
        hidden: isSpace ? true : undefined,
        faces: [],
        vertices: [],
        edges: [],
      });
    }

    if (children.length === 0) return null;

    const matrixSourceVal = _psets?.Pset_InstanceCommon?.MatrixSourceId;
    const matrixSourceId = (typeof matrixSourceVal === 'object' && matrixSourceVal !== null && 'value' in matrixSourceVal)
      ? matrixSourceVal.value
      : (typeof matrixSourceVal === 'string' ? matrixSourceVal : null);

    const relatingTypeVal = _psets?.IfcRelDefinesByType?.RelatingType;
    const relatingTypeId = (typeof relatingTypeVal === 'object' && relatingTypeVal !== null && 'value' in relatingTypeVal)
      ? relatingTypeVal.value
      : (typeof relatingTypeVal === 'string' ? relatingTypeVal : null);

    const resolvedMatrixId = matrixSourceId || relatingTypeId || null;

    const rootGroup: EvaluatedProductEntity = {
      id,
      type: 'GROUP',
      name,
      parentId: defaultParentId,
      matrixId: resolvedMatrixId || undefined,
      hidden: isSpace ? true : undefined,
      faces: [],
      vertices: [],
      edges: [],
    };

    return { rootEntity: rootGroup, children };
  }

  /**
   * Fast-path generator for MEP products (pipes, ducts, conduit segments) without boolean openings.
   * Directly produces analytical cylinders with continuous normals, watertight caps,
   * and zero intermediate PolyMesh/CSG allocations.
   */
  private tryBuildFastMepEntities(
    rec: StepRecord,
    defaultParentId: string | null,
    _psets?: Record<string, Record<string, any>>,
    itemToStyleMap?: Map<number, string>,
    _faceToStyleMap?: Map<number, string>,
    elementMaterialMap?: Map<number, string>
  ): { rootEntity: EvaluatedProductEntity; children: EvaluatedProductEntity[] } | null {
    if (this.hostToOpeningsStepMap.has(rec.id)) {
      return null;
    }

    if (
      rec.type === 'IFCSITE' ||
      rec.type === 'IFCWALL' ||
      rec.type === 'IFCWALLSTANDARDCASE' ||
      rec.type === 'IFCROOF' ||
      rec.type === 'IFCWINDOW' ||
      rec.type === 'IFCDOOR' ||
      rec.type === 'IFCOPENINGELEMENT'
    ) {
      return null;
    }

    const shapeParam = rec.params[6];
    if (!shapeParam || typeof shapeParam !== 'object' || !('ref' in shapeParam)) {
      return null;
    }

    const shapeRec = this.records.get(shapeParam.ref);
    if (!shapeRec || shapeRec.type !== 'IFCPRODUCTDEFINITIONSHAPE') {
      return null;
    }

    const repsList = shapeRec.params[2];
    if (!Array.isArray(repsList) || repsList.length === 0) {
      return null;
    }

    // Resolve product placement matrix
    const placementParam = rec.params[5];
    let mProduct = new THREE.Matrix4();
    if (placementParam && typeof placementParam === 'object' && 'ref' in placementParam) {
      mProduct = this.resolveLocalPlacementMatrix(placementParam.ref);
    }

    interface MepItem {
      geomRec: StepRecord;
      mLocal: THREE.Matrix4;
      styleId?: string;
    }
    const mepCandidates: MepItem[] = [];
    let hasOtherGeometry = false;

    for (const item of repsList) {
      if (!item || typeof item !== 'object' || !('ref' in item)) continue;
      const repRec = this.records.get(item.ref);
      if (!repRec || this.isNonBodyShapeRepresentation(repRec)) continue;

      const repStyleId = itemToStyleMap?.get(repRec.id);
      const geomItems = repRec.params[3];
      if (!Array.isArray(geomItems) || geomItems.length === 0) continue;

      for (const geomItem of geomItems) {
        if (!geomItem || typeof geomItem !== 'object' || !('ref' in geomItem)) continue;
        const gRec = this.records.get(geomItem.ref);
        if (!gRec || gRec.type === 'IFCBOUNDINGBOX') continue;

        if (gRec.type === 'IFCMAPPEDITEM') {
          const sourceRef = gRec.params[0];
          const targetRef = gRec.params[1];
          if (!sourceRef || typeof sourceRef !== 'object' || !('ref' in sourceRef)) {
            hasOtherGeometry = true;
            break;
          }
          const mapRec = this.records.get(sourceRef.ref);
          if (!mapRec || mapRec.type !== 'IFCREPRESENTATIONMAP') {
            hasOtherGeometry = true;
            break;
          }
          const mappedRepRef = mapRec.params[1];
          if (!mappedRepRef || typeof mappedRepRef !== 'object' || !('ref' in mappedRepRef)) {
            hasOtherGeometry = true;
            break;
          }
          const shapeRepRec = this.records.get(mappedRepRef.ref);
          if (!shapeRepRec) {
            hasOtherGeometry = true;
            break;
          }

          let mMapOrigin = new THREE.Matrix4();
          const mapOriginParam = mapRec.params[0];
          if (typeof mapOriginParam === 'string' && mapOriginParam.startsWith('#')) {
            const originId = parseInt(mapOriginParam.slice(1), 10);
            const originRec = this.records.get(originId);
            if (originRec && originRec.type === 'IFCAXIS2PLACEMENT3D') {
              mMapOrigin = this.resolveAxis2Placement3D(originRec);
            }
          } else if (mapOriginParam && typeof mapOriginParam === 'object' && 'ref' in mapOriginParam) {
            const originRec = this.records.get(mapOriginParam.ref);
            if (originRec && originRec.type === 'IFCAXIS2PLACEMENT3D') {
              mMapOrigin = this.resolveAxis2Placement3D(originRec);
            }
          }
          const mMapOriginInv = new THREE.Matrix4().copy(mMapOrigin).invert();

          let mOperator = new THREE.Matrix4();
          if (targetRef && typeof targetRef === 'object' && 'ref' in targetRef) {
            const opRec = this.records.get(targetRef.ref);
            if (opRec) {
              mOperator = this.resolveCartesianTransformationOperator(opRec);
            }
          }
          const mLocal = new THREE.Matrix4().multiplyMatrices(mOperator, mMapOriginInv);
          const mappedStyle = itemToStyleMap?.get(gRec.id) || repStyleId;

          const innerGeomItems = shapeRepRec.params[3];
          if (!Array.isArray(innerGeomItems)) {
            hasOtherGeometry = true;
            break;
          }
          for (const innerItem of innerGeomItems) {
            if (!innerItem || typeof innerItem !== 'object' || !('ref' in innerItem)) continue;
            const innerRec = this.records.get(innerItem.ref);
            if (!innerRec) continue;
            if (this.isMepGeometryRecord(innerRec)) {
              mepCandidates.push({
                geomRec: innerRec,
                mLocal,
                styleId: itemToStyleMap?.get(innerRec.id) || mappedStyle,
              });
            } else {
              hasOtherGeometry = true;
              break;
            }
          }
        } else if (this.isMepGeometryRecord(gRec)) {
          mepCandidates.push({
            geomRec: gRec,
            mLocal: new THREE.Matrix4(),
            styleId: itemToStyleMap?.get(gRec.id) || repStyleId,
          });
        } else {
          hasOtherGeometry = true;
          break;
        }
      }
      if (hasOtherGeometry) break;
    }

    if (hasOtherGeometry || mepCandidates.length === 0) {
      return null;
    }

    const rawGuid = this.getParamString(rec.params[0]);
    const id = this.stepIdToEntityId.get(rec.id) || (rawGuid && GuidUtils.isIfcGuid(rawGuid) ? rawGuid : GuidUtils.createIfcGuid());
    this.stepIdToEntityId.set(rec.id, id);
    const name = this.getParamString(rec.params[2]) || rec.type;
    const productLevelMatId = elementMaterialMap?.get(rec.id) || itemToStyleMap?.get(rec.id);
    const isSpace = rec.type === 'IFCSPACE';

    const buffersByMaterial = new Map<string, DirectMeshBuffers[]>();

    for (const cand of mepCandidates) {
      const buffers = this.extractMepItemBuffers(cand.geomRec, cand.mLocal, mProduct);
      if (!buffers || buffers.indices.length === 0) {
        return null;
      }
      const matKey = cand.styleId || productLevelMatId || '__default__';
      let group = buffersByMaterial.get(matKey);
      if (!group) {
        group = [];
        buffersByMaterial.set(matKey, group);
      }
      group.push(buffers);
    }

    const children: EvaluatedProductEntity[] = [];
    let childIdx = 0;

    for (const [matKey, list] of buffersByMaterial.entries()) {
      const merged = DirectCylinderGenerator.mergeDirectBuffers(list);
      if (!merged || merged.indices.length === 0) continue;

      const childId = GuidUtils.createIfcGuid();
      const matId = matKey === '__default__' ? undefined : matKey;
      const childName = buffersByMaterial.size === 1
        ? name
        : `${name} [${matId || 'Parte ' + (++childIdx)}]`;

      children.push({
        id: childId,
        type: 'GEOMETRY_ENTITY',
        name: childName,
        parentId: id,
        rawGeometry: merged,
        materialId: matId,
        hidden: isSpace ? true : undefined,
        faces: [],
        vertices: [],
        edges: [],
      });
    }

    if (children.length === 0) return null;

    const matrixSourceVal = _psets?.Pset_InstanceCommon?.MatrixSourceId;
    const matrixSourceId = (typeof matrixSourceVal === 'object' && matrixSourceVal !== null && 'value' in matrixSourceVal)
      ? matrixSourceVal.value
      : (typeof matrixSourceVal === 'string' ? matrixSourceVal : null);

    const relatingTypeVal = _psets?.IfcRelDefinesByType?.RelatingType;
    const relatingTypeId = (typeof relatingTypeVal === 'object' && relatingTypeVal !== null && 'value' in relatingTypeVal)
      ? relatingTypeVal.value
      : (typeof relatingTypeVal === 'string' ? relatingTypeVal : null);

    const resolvedMatrixId = matrixSourceId || relatingTypeId || null;

    const rootGroup: EvaluatedProductEntity = {
      id,
      type: 'GROUP',
      name,
      parentId: defaultParentId,
      matrixId: resolvedMatrixId || undefined,
      hidden: isSpace ? true : undefined,
      faces: [],
      vertices: [],
      edges: [],
    };

    return { rootEntity: rootGroup, children };
  }

  private isMepGeometryRecord(rec: StepRecord): boolean {
    if (rec.type === 'IFCEXTRUDEDAREASOLID') {
      const sweptAreaParam = rec.params[0];
      if (sweptAreaParam && typeof sweptAreaParam === 'object' && 'ref' in sweptAreaParam) {
        const profileRec = this.records.get(sweptAreaParam.ref);
        if (profileRec) {
          return (
            profileRec.type === 'IFCCIRCLEPROFILEDEF' ||
            profileRec.type === 'IFCCIRCLEHOLLOWPROFILEDEF' ||
            profileRec.type === 'IFCRECTANGLEPROFILEDEF' ||
            profileRec.type === 'IFCRECTANGLEHOLLOWPROFILEDEF' ||
            profileRec.type === 'IFCISHAPEPROFILEDEF' ||
            profileRec.type === 'IFCLSHAPEPROFILEDEF' ||
            profileRec.type === 'IFCTSHAPEPROFILEDEF' ||
            profileRec.type === 'IFCUSHAPEPROFILEDEF' ||
            profileRec.type === 'IFCCSHAPEPROFILEDEF' ||
            profileRec.type === 'IFCARBITRARYCLOSEDPROFILEDEF'
          );
        }
      }
    } else if (
      rec.type === 'IFCSWEPTDISKSOLID' ||
      rec.type === 'IFCSWEPTDISKSOLIDPOLYGONAL' ||
      rec.type === 'IFCREVOLVEDAREASOLID' ||
      rec.type === 'IFCSHELLBASEDSURFACEMODEL' ||
      rec.type === 'IFCFACETEDBREP' ||
      rec.type === 'IFCCLOSEDSHELL' ||
      rec.type === 'IFCOPENSHELL' ||
      rec.type === 'IFCCONNECTEDFACESET'
    ) {
      return true;
    }
    return false;
  }

  private extractMepItemBuffers(
    geomRec: StepRecord,
    mLocal: THREE.Matrix4,
    mProduct: THREE.Matrix4
  ): DirectMeshBuffers | null {
    if (geomRec.type === 'IFCEXTRUDEDAREASOLID') {
      const sweptAreaParam = geomRec.params[0];
      const positionParam = geomRec.params[1];
      const dirParam = geomRec.params[2];
      const depthParam = geomRec.params[3];

      const rawDepth = typeof depthParam === 'number' ? depthParam : parseFloat(String(depthParam || 0)) || 0;
      const depth = rawDepth * this.lengthUnitScale;
      if (depth <= GeometryTolerance.MIN_EDGE_LENGTH) return null;

      if (!sweptAreaParam || typeof sweptAreaParam !== 'object' || !('ref' in sweptAreaParam)) return null;
      const profileRec = this.records.get(sweptAreaParam.ref);
      if (!profileRec) return null;

      const isStaticProfile =
        profileRec.type === 'IFCRECTANGLEPROFILEDEF' ||
        profileRec.type === 'IFCRECTANGLEHOLLOWPROFILEDEF' ||
        profileRec.type === 'IFCISHAPEPROFILEDEF' ||
        profileRec.type === 'IFCLSHAPEPROFILEDEF' ||
        profileRec.type === 'IFCTSHAPEPROFILEDEF' ||
        profileRec.type === 'IFCUSHAPEPROFILEDEF' ||
        profileRec.type === 'IFCCSHAPEPROFILEDEF' ||
        profileRec.type === 'IFCARBITRARYCLOSEDPROFILEDEF';

      if (isStaticProfile) {
        let m2D = new THREE.Matrix4();
        const pos2DParam = profileRec.params[2];
        if (pos2DParam && typeof pos2DParam === 'object' && 'ref' in pos2DParam) {
          const pos2DRec = this.records.get(pos2DParam.ref);
          if (pos2DRec && pos2DRec.type === 'IFCAXIS2PLACEMENT2D') {
            const t2d = this.resolveAxis2Placement2D(pos2DRec);
            m2D.set(
              t2d.dirX.x, t2d.dirY.x, 0, t2d.origin.x,
              t2d.dirX.y, t2d.dirY.y, 0, t2d.origin.y,
              0,          0,          1, 0,
              0,          0,          0, 1
            );
          }
        }

        let dirX = 0, dirY = 0, dirZ = 1;
        if (dirParam && typeof dirParam === 'object' && 'ref' in dirParam) {
          const dirRec = this.records.get(dirParam.ref);
          if (dirRec && Array.isArray(dirRec.params[0])) {
            const d = dirRec.params[0].map((v: any) => typeof v === 'number' ? v : parseFloat(String(v)) || 0);
            if (d.length >= 3) {
              dirX = d[0]; dirY = d[1]; dirZ = d[2];
            }
          }
        }

        let mSolid = new THREE.Matrix4();
        if (positionParam && typeof positionParam === 'object' && 'ref' in positionParam) {
          const posRec = this.records.get(positionParam.ref);
          if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
            mSolid = this.resolveAxis2Placement3D(posRec);
          }
        }

        let protoBuffers: DirectMeshBuffers | null | undefined = this.mepExtrudedPrototypeCache.get(geomRec.id);
        if (protoBuffers === undefined) {
          protoBuffers = null;
          if (profileRec.type === 'IFCRECTANGLEPROFILEDEF' || profileRec.type === 'IFCRECTANGLEHOLLOWPROFILEDEF') {
            const rawX = typeof profileRec.params[3] === 'number' ? profileRec.params[3] : parseFloat(String(profileRec.params[3])) || 1.0;
            const rawY = typeof profileRec.params[4] === 'number' ? profileRec.params[4] : parseFloat(String(profileRec.params[4])) || 1.0;
            const xDim = rawX * this.lengthUnitScale;
            const yDim = rawY * this.lengthUnitScale;
            protoBuffers = StaticProfileTemplates.generateBox(xDim, yDim, depth, [0, 0], [dirX, dirY, dirZ]);
          } else if (profileRec.type === 'IFCISHAPEPROFILEDEF') {
            const rawWidth = typeof profileRec.params[3] === 'number' ? profileRec.params[3] : parseFloat(String(profileRec.params[3])) || 0.2;
            const rawDepth = typeof profileRec.params[4] === 'number' ? profileRec.params[4] : parseFloat(String(profileRec.params[4])) || 0.4;
            const rawWeb = typeof profileRec.params[5] === 'number' ? profileRec.params[5] : parseFloat(String(profileRec.params[5])) || 0.01;
            const rawFlange = typeof profileRec.params[6] === 'number' ? profileRec.params[6] : parseFloat(String(profileRec.params[6])) || 0.02;
            protoBuffers = StaticProfileTemplates.generateIShapeBeam(
              rawWidth * this.lengthUnitScale,
              rawDepth * this.lengthUnitScale,
              rawWeb * this.lengthUnitScale,
              rawFlange * this.lengthUnitScale,
              depth,
              [0, 0],
              [dirX, dirY, dirZ]
            );
          } else if (profileRec.type === 'IFCLSHAPEPROFILEDEF') {
            const rawDepth = typeof profileRec.params[3] === 'number' ? profileRec.params[3] : parseFloat(String(profileRec.params[3])) || 0.1;
            const rawWidth = typeof profileRec.params[4] === 'number' ? profileRec.params[4] : parseFloat(String(profileRec.params[4])) || rawDepth;
            const rawThickness = typeof profileRec.params[5] === 'number' ? profileRec.params[5] : parseFloat(String(profileRec.params[5])) || 0.01;
            protoBuffers = StaticProfileTemplates.generateLShapeBeam(
              rawWidth * this.lengthUnitScale,
              rawDepth * this.lengthUnitScale,
              rawThickness * this.lengthUnitScale,
              depth,
              [0, 0],
              [dirX, dirY, dirZ]
            );
          } else if (profileRec.type === 'IFCTSHAPEPROFILEDEF') {
            const rawDepth = typeof profileRec.params[3] === 'number' ? profileRec.params[3] : parseFloat(String(profileRec.params[3])) || 0.1;
            const rawFlangeWidth = typeof profileRec.params[4] === 'number' ? profileRec.params[4] : parseFloat(String(profileRec.params[4])) || 0.1;
            const rawWeb = typeof profileRec.params[5] === 'number' ? profileRec.params[5] : parseFloat(String(profileRec.params[5])) || 0.01;
            const rawFlange = typeof profileRec.params[6] === 'number' ? profileRec.params[6] : parseFloat(String(profileRec.params[6])) || 0.01;
            protoBuffers = StaticProfileTemplates.generateTShapeBeam(
              rawFlangeWidth * this.lengthUnitScale,
              rawDepth * this.lengthUnitScale,
              rawWeb * this.lengthUnitScale,
              rawFlange * this.lengthUnitScale,
              depth,
              [0, 0],
              [dirX, dirY, dirZ]
            );
          } else if (profileRec.type === 'IFCUSHAPEPROFILEDEF' || profileRec.type === 'IFCCSHAPEPROFILEDEF') {
            const rawDepth = typeof profileRec.params[3] === 'number' ? profileRec.params[3] : parseFloat(String(profileRec.params[3])) || 0.1;
            const rawFlangeWidth = typeof profileRec.params[4] === 'number' ? profileRec.params[4] : parseFloat(String(profileRec.params[4])) || 0.05;
            const rawWeb = typeof profileRec.params[5] === 'number' ? profileRec.params[5] : parseFloat(String(profileRec.params[5])) || 0.01;
            const rawFlange = typeof profileRec.params[6] === 'number' ? profileRec.params[6] : parseFloat(String(profileRec.params[6])) || 0.01;
            protoBuffers = StaticProfileTemplates.generateUShapeBeam(
              rawFlangeWidth * this.lengthUnitScale,
              rawDepth * this.lengthUnitScale,
              rawWeb * this.lengthUnitScale,
              rawFlange * this.lengthUnitScale,
              depth,
              [0, 0],
              [dirX, dirY, dirZ]
            );
          } else if (profileRec.type === 'IFCARBITRARYCLOSEDPROFILEDEF') {
            const curveParam = profileRec.params[2];
            if (curveParam && typeof curveParam === 'object' && 'ref' in curveParam) {
              const rawPts = this.extract2DCurvePoints((curveParam as any).ref);
              if (rawPts && rawPts.length >= 3) {
                const pts = rawPts.map(p => ({ x: p.x, y: p.y }));
                if (pts.length >= 4) {
                  const first = pts[0];
                  const last = pts[pts.length - 1];
                  if (Math.hypot(first.x - last.x, first.y - last.y) < GeometryTolerance.COINCIDENT_POINT) {
                    pts.pop();
                  }
                }
                if (pts.length >= 3) {
                  if (PolygonClipping.signedArea2D(pts) < 0) {
                    pts.reverse();
                  }
                  let capTriangles: [number, number, number][] = [];
                  if (pts.length === 3) {
                    capTriangles = [[0, 1, 2]];
                  } else if (pts.length === 4) {
                    capTriangles = [[0, 1, 2], [0, 2, 3]];
                  } else {
                    const v2List = pts.map(p => new THREE.Vector2(p.x, p.y));
                    const tris = THREE.ShapeUtils.triangulateShape(v2List, []) as [number, number, number][];
                    if (tris && tris.length > 0) {
                      capTriangles = tris;
                    }
                  }
                  if (capTriangles.length > 0) {
                    const loop2D: [number, number][] = pts.map(p => [p.x, p.y]);
                    protoBuffers = StaticProfileTemplates.generatePrismFromPolygon2D(
                      loop2D,
                      capTriangles,
                      depth,
                      [0, 0],
                      [dirX, dirY, dirZ]
                    );
                  }
                }
              }
            }
          }
          this.mepExtrudedPrototypeCache.set(geomRec.id, protoBuffers);
        }
        if (!protoBuffers) return null;

        const buffers: DirectMeshBuffers = {
          positions: new Float32Array(protoBuffers.positions),
          normals: new Float32Array(protoBuffers.normals),
          indices: new Uint32Array(protoBuffers.indices),
          edgesBuffer: protoBuffers.edgesBuffer ? new Float32Array(protoBuffers.edgesBuffer) : undefined,
        };

        const mTotal = new THREE.Matrix4().copy(mProduct).multiply(mLocal).multiply(mSolid).multiply(m2D);
        DirectCylinderGenerator.applyTransformAndCanonicalSwap(buffers, mTotal);
        return buffers;
      }

      let radius = 0;
      let innerRadius = 0;
      if (profileRec.type === 'IFCCIRCLEPROFILEDEF') {
        const rawR = typeof profileRec.params[3] === 'number' ? profileRec.params[3] : parseFloat(String(profileRec.params[3])) || 0.5;
        radius = rawR * this.lengthUnitScale;
      } else if (profileRec.type === 'IFCCIRCLEHOLLOWPROFILEDEF') {
        const rawR = typeof profileRec.params[3] === 'number' ? profileRec.params[3] : parseFloat(String(profileRec.params[3])) || 0.5;
        const rawW = typeof profileRec.params[4] === 'number' ? profileRec.params[4] : parseFloat(String(profileRec.params[4])) || 0.05;
        radius = rawR * this.lengthUnitScale;
        const wallThickness = rawW * this.lengthUnitScale;
        innerRadius = Math.max(0, radius - wallThickness);
      } else {
        return null;
      }
      if (radius <= GeometryTolerance.MATH_EPSILON) return null;

      let p0x = 0, p0y = 0;
      const pos2DParam = profileRec.params[2];
      if (pos2DParam && typeof pos2DParam === 'object' && 'ref' in pos2DParam) {
        const pos2DRec = this.records.get(pos2DParam.ref);
        if (pos2DRec && pos2DRec.type === 'IFCAXIS2PLACEMENT2D') {
          const t2d = this.resolveAxis2Placement2D(pos2DRec);
          p0x = t2d.origin.x;
          p0y = t2d.origin.y;
        }
      }

      let dirX = 0, dirY = 0, dirZ = 1;
      if (dirParam && typeof dirParam === 'object' && 'ref' in dirParam) {
        const dirRec = this.records.get(dirParam.ref);
        if (dirRec && Array.isArray(dirRec.params[0])) {
          const d = dirRec.params[0].map((v: any) => typeof v === 'number' ? v : parseFloat(String(v)) || 0);
          if (d.length >= 3) {
            dirX = d[0]; dirY = d[1]; dirZ = d[2];
          }
        }
      }
      const dLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
      if (dLen > 1e-8) {
        dirX /= dLen; dirY /= dLen; dirZ /= dLen;
      }

      const p0: [number, number, number] = [p0x, p0y, 0];
      const p1: [number, number, number] = [p0x + dirX * depth, p0y + dirY * depth, dirZ * depth];

      let mSolid = new THREE.Matrix4();
      if (positionParam && typeof positionParam === 'object' && 'ref' in positionParam) {
        const posRec = this.records.get(positionParam.ref);
        if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
          mSolid = this.resolveAxis2Placement3D(posRec);
        }
      }

      let protoBuffers = this.mepExtrudedPrototypeCache.get(geomRec.id);
      if (protoBuffers === undefined) {
        protoBuffers = DirectCylinderGenerator.generateMesh({
          p0,
          p1,
          radius,
          innerRadius,
          hasStartCap: true,
          hasEndCap: true,
        });
        this.mepExtrudedPrototypeCache.set(geomRec.id, protoBuffers);
      }
      if (!protoBuffers) return null;

      const buffers: DirectMeshBuffers = {
        positions: new Float32Array(protoBuffers.positions),
        normals: new Float32Array(protoBuffers.normals),
        indices: new Uint32Array(protoBuffers.indices),
        edgesBuffer: protoBuffers.edgesBuffer ? new Float32Array(protoBuffers.edgesBuffer) : undefined,
      };

      const mTotal = new THREE.Matrix4().copy(mProduct).multiply(mLocal).multiply(mSolid);
      DirectCylinderGenerator.applyTransformAndCanonicalSwap(buffers, mTotal);
      return buffers;
    }

    if (geomRec.type === 'IFCSWEPTDISKSOLID' || geomRec.type === 'IFCSWEPTDISKSOLIDPOLYGONAL') {
      const directrixParam = geomRec.params[0];
      const radiusParam = geomRec.params[1];
      const innerRadiusParam = geomRec.params[2];

      if (!directrixParam || typeof directrixParam !== 'object' || !('ref' in directrixParam)) return null;
      const directrix = this.extract3DCurvePoints((directrixParam as any).ref);
      if (!directrix || directrix.points.length < 2) return null;

      const pts = directrix.points;
      let isLinear = true;
      if (pts.length > 2) {
        const v0 = pts[1].sub(pts[0]).normalize();
        for (let k = 2; k < pts.length; k++) {
          const vk = pts[k].sub(pts[k - 1]).normalize();
          if (Math.abs(v0.dot(vk) - 1.0) > 1e-4) {
            isLinear = false;
            break;
          }
        }
      }
      if (!isLinear) {
        return null;
      }

      const rawRadius = typeof radiusParam === 'number' ? radiusParam : parseFloat(String(radiusParam || 0)) || 0;
      const radius = rawRadius * this.lengthUnitScale;
      if (radius <= GeometryTolerance.MATH_EPSILON) return null;

      let innerRadius = 0;
      if (innerRadiusParam !== null && innerRadiusParam !== undefined && innerRadiusParam !== '$') {
        const rawInner = typeof innerRadiusParam === 'number' ? innerRadiusParam : parseFloat(String(innerRadiusParam)) || 0;
        innerRadius = rawInner * this.lengthUnitScale;
      }

      const startPt = pts[0];
      const endPt = pts[pts.length - 1];
      const p0: [number, number, number] = [startPt.x, startPt.y, startPt.z];
      const p1: [number, number, number] = [endPt.x, endPt.y, endPt.z];

      let protoBuffers = this.mepExtrudedPrototypeCache.get(geomRec.id);
      if (protoBuffers === undefined) {
        protoBuffers = DirectCylinderGenerator.generateMesh({
          p0,
          p1,
          radius,
          innerRadius,
          hasStartCap: true,
          hasEndCap: true,
        });
        this.mepExtrudedPrototypeCache.set(geomRec.id, protoBuffers);
      }
      if (!protoBuffers) return null;

      const buffers: DirectMeshBuffers = {
        positions: new Float32Array(protoBuffers.positions),
        normals: new Float32Array(protoBuffers.normals),
        indices: new Uint32Array(protoBuffers.indices),
        edgesBuffer: protoBuffers.edgesBuffer ? new Float32Array(protoBuffers.edgesBuffer) : undefined,
      };

      const mTotal = new THREE.Matrix4().copy(mProduct).multiply(mLocal);
      DirectCylinderGenerator.applyTransformAndCanonicalSwap(buffers, mTotal);
      return buffers;
    }

    if (geomRec.type === 'IFCREVOLVEDAREASOLID') {
      const sweptAreaParam = geomRec.params[IFC_GEOM_ATTRS.REVOLVED_SWEPT_AREA];
      const positionParam = geomRec.params[IFC_GEOM_ATTRS.REVOLVED_POSITION];
      const axisParam = geomRec.params[IFC_GEOM_ATTRS.REVOLVED_AXIS];
      const angleParam = geomRec.params[IFC_GEOM_ATTRS.REVOLVED_ANGLE];

      if (!sweptAreaParam || typeof sweptAreaParam !== 'object' || !('ref' in sweptAreaParam)) return null;
      const profileRec = this.records.get(sweptAreaParam.ref);
      if (!profileRec || (profileRec.type !== 'IFCCIRCLEPROFILEDEF' && profileRec.type !== 'IFCCIRCLEHOLLOWPROFILEDEF')) {
        return null;
      }

      const rawAngle = typeof angleParam === 'number' ? angleParam : parseFloat(String(angleParam || 0)) || 0;
      const angleRadians = this.toAngleRadians(rawAngle);
      if (Math.abs(angleRadians) < GeometryTolerance.MATH_EPSILON) return null;

      const rawR = typeof profileRec.params[3] === 'number' ? profileRec.params[3] : parseFloat(String(profileRec.params[3])) || 0.05;
      const pipeRadius = rawR * this.lengthUnitScale;
      if (pipeRadius <= GeometryTolerance.MATH_EPSILON) return null;

      let bendRadius = pipeRadius * 3.0; // standard 1.5D
      if (axisParam && typeof axisParam === 'object' && 'ref' in axisParam) {
        const axisRec = this.records.get(axisParam.ref);
        if (axisRec && axisRec.params[0] && typeof axisRec.params[0] === 'object' && 'ref' in axisRec.params[0]) {
          const locRec = this.records.get(axisRec.params[0].ref);
          if (locRec && Array.isArray(locRec.params[0])) {
            const c = locRec.params[0].map((v: any) => (typeof v === 'number' ? v : parseFloat(String(v)) || 0) * this.lengthUnitScale);
            const dist = Math.hypot(c[0] || 0, c[1] || 0);
            if (dist > GeometryTolerance.MATH_EPSILON) {
              bendRadius = dist;
            }
          }
        }
      }

      let mSolid = new THREE.Matrix4();
      if (positionParam && typeof positionParam === 'object' && 'ref' in positionParam) {
        const posRec = this.records.get(positionParam.ref);
        if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
          mSolid = this.resolveAxis2Placement3D(posRec);
        }
      }

      let protoBuffers = this.mepExtrudedPrototypeCache.get(geomRec.id);
      if (protoBuffers === undefined) {
        protoBuffers = ToroidTemplateCache.getOrCreateToroidMesh({
          pipeRadius,
          bendRadius,
          sweepAngleRad: Math.abs(angleRadians),
          hasStartCap: true,
          hasEndCap: true,
        });
        this.mepExtrudedPrototypeCache.set(geomRec.id, protoBuffers);
      }
      if (!protoBuffers) return null;

      const buffers: DirectMeshBuffers = {
        positions: new Float32Array(protoBuffers.positions),
        normals: new Float32Array(protoBuffers.normals),
        indices: new Uint32Array(protoBuffers.indices),
        edgesBuffer: protoBuffers.edgesBuffer ? new Float32Array(protoBuffers.edgesBuffer) : undefined,
      };

      const mTotal = new THREE.Matrix4().copy(mProduct).multiply(mLocal).multiply(mSolid);
      DirectCylinderGenerator.applyTransformAndCanonicalSwap(buffers, mTotal);
      return buffers;
    }

    if (
      geomRec.type === 'IFCSHELLBASEDSURFACEMODEL' ||
      geomRec.type === 'IFCFACETEDBREP' ||
      geomRec.type === 'IFCCLOSEDSHELL' ||
      geomRec.type === 'IFCOPENSHELL' ||
      geomRec.type === 'IFCCONNECTEDFACESET'
    ) {
      return this.extractDirectFacetedBuffers(geomRec, mLocal, mProduct);
    }

    return null;
  }

  /**
   * Fast-path extractor for discrete faceted boundary shells without boolean openings.
   * Produces direct TypedArrays for quads/triangles with zero PolyMesh allocations.
   * Caches the prototype geometry in local coordinates for instant reuse across mapped instances.
   */
  private extractDirectFacetedBuffers(
    geomRec: StepRecord,
    mLocal: THREE.Matrix4,
    mProduct: THREE.Matrix4
  ): DirectMeshBuffers | null {
    let protoBuffers = this.mepFacetedPrototypeCache.get(geomRec.id);
    if (protoBuffers === undefined) {
      protoBuffers = this.buildDirectFacetedPrototype(geomRec);
      this.mepFacetedPrototypeCache.set(geomRec.id, protoBuffers);
    }
    if (!protoBuffers) return null;

    const buffers: DirectMeshBuffers = {
      positions: new Float32Array(protoBuffers.positions),
      normals: new Float32Array(protoBuffers.normals),
      indices: new Uint32Array(protoBuffers.indices),
      edgesBuffer: protoBuffers.edgesBuffer ? new Float32Array(protoBuffers.edgesBuffer) : undefined,
    };

    const mTotal = new THREE.Matrix4().copy(mProduct).multiply(mLocal);
    DirectCylinderGenerator.applyTransformAndCanonicalSwap(buffers, mTotal);
    return buffers;
  }

  private buildDirectFacetedPrototype(geomRec: StepRecord): DirectMeshBuffers | null {
    const shells: StepRecord[] = [];
    if (geomRec.type === 'IFCSHELLBASEDSURFACEMODEL') {
      const shellsParam = geomRec.params[0];
      const sRefs = Array.isArray(shellsParam) ? shellsParam : [shellsParam];
      for (const sRef of sRefs) {
        if (sRef && typeof sRef === 'object' && 'ref' in sRef) {
          const sRec = this.records.get(sRef.ref);
          if (sRec) shells.push(sRec);
        }
      }
    } else if (geomRec.type === 'IFCFACETEDBREP') {
      const outerParam = geomRec.params[0];
      if (outerParam && typeof outerParam === 'object' && 'ref' in outerParam) {
        const sRec = this.records.get(outerParam.ref);
        if (sRec) shells.push(sRec);
      }
    } else if (
      geomRec.type === 'IFCCLOSEDSHELL' ||
      geomRec.type === 'IFCOPENSHELL' ||
      geomRec.type === 'IFCCONNECTEDFACESET'
    ) {
      shells.push(geomRec);
    }

    if (shells.length === 0) return null;

    const posList: number[] = [];
    const normList: number[] = [];
    const indList: number[] = [];
    const edgeList: number[] = [];
    let vertIndexBase = 0;

    for (const shellRec of shells) {
      const faceRefs = shellRec.params[0];
      if (!Array.isArray(faceRefs)) continue;

      for (const fRef of faceRefs) {
        if (!fRef || typeof fRef !== 'object' || !('ref' in fRef)) continue;
        const faceRec = this.records.get(fRef.ref);
        if (!faceRec) continue;

        const boundRefs = Array.isArray(faceRec.params[0]) ? faceRec.params[0] : [faceRec.params[0]];
        // If face has multiple bounds (holes), fallback to standard PolyMesh/CSG
        if (boundRefs.length !== 1) return null;

        const bRef = boundRefs[0];
        if (!bRef || typeof bRef !== 'object' || !('ref' in bRef)) continue;
        const bRec = this.records.get(bRef.ref);
        if (!bRec) continue;

        const loopRef = bRec.params[0];
        if (!loopRef || typeof loopRef !== 'object' || !('ref' in loopRef)) continue;
        const loopRec = this.records.get(loopRef.ref);
        if (!loopRec || loopRec.type !== 'IFCPOLYLOOP') continue;

        const ptRefs = loopRec.params[0];
        if (!Array.isArray(ptRefs) || ptRefs.length < 3) continue;

        const nPts = ptRefs.length;
        const faceStartV = vertIndexBase;
        const facePts: [number, number, number][] = [];

        for (let i = 0; i < nPts; i++) {
          const ptRef = ptRefs[i];
          if (!ptRef || typeof ptRef !== 'object' || !('ref' in ptRef)) return null;
          const ptRec = this.records.get(ptRef.ref);
          if (!ptRec || ptRec.type !== 'IFCCARTESIANPOINT' || !Array.isArray(ptRec.params[0])) return null;
          const p = ptRec.params[0];
          const x = (typeof p[0] === 'number' ? p[0] : parseFloat(String(p[0])) || 0) * this.lengthUnitScale;
          const y = (typeof p[1] === 'number' ? p[1] : parseFloat(String(p[1])) || 0) * this.lengthUnitScale;
          const z = (typeof p[2] === 'number' ? p[2] : parseFloat(String(p[2])) || 0) * this.lengthUnitScale;
          facePts.push([x, y, z]);
          posList.push(x, y, z);
        }

        // Newell's method for exact polygon normal
        let nx = 0, ny = 0, nz = 0;
        for (let i = 0; i < nPts; i++) {
          const cur = facePts[i];
          const next = facePts[(i + 1) % nPts];
          nx += (cur[1] - next[1]) * (cur[2] + next[2]);
          ny += (cur[2] - next[2]) * (cur[0] + next[0]);
          nz += (cur[0] - next[0]) * (cur[1] + next[1]);
        }
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 1e-8) {
          nx /= len; ny /= len; nz /= len;
        } else {
          nx = 0; ny = 1; nz = 0;
        }

        for (let i = 0; i < nPts; i++) {
          normList.push(nx, ny, nz);
        }

        // Robust polygon triangulation (supports concave faces)
        if (nPts === 3) {
          indList.push(faceStartV, faceStartV + 1, faceStartV + 2);
        } else {
          const v3 = facePts.map((p) => new Vec3(p[0], p[1], p[2]));
          const norm = new Vec3(nx, ny, nz);
          const basis = PolygonClipping.getLocalBasis(v3[0], norm);
          const poly2D = v3.map((v) => PolygonClipping.projectTo2D(v, basis));
          const isCCW = PolygonClipping.signedArea2D(poly2D) > 0;
          const v2List = (isCCW ? poly2D : [...poly2D].reverse()).map((p) => new THREE.Vector2(p.x, p.y));
          const rawTris = THREE.ShapeUtils.triangulateShape(v2List, []) as [number, number, number][];

          if (rawTris && rawTris.length > 0) {
            for (const [i0, i1, i2] of rawTris) {
              const orig0 = isCCW ? i0 : nPts - 1 - i0;
              const orig1 = isCCW ? i1 : nPts - 1 - i1;
              const orig2 = isCCW ? i2 : nPts - 1 - i2;

              const p0 = v3[orig0];
              const p1 = v3[orig1];
              const p2 = v3[orig2];
              const triN = p1.sub(p0).cross(p2.sub(p0));
              if (triN.dot(norm) >= 0) {
                indList.push(faceStartV + orig0, faceStartV + orig1, faceStartV + orig2);
              } else {
                indList.push(faceStartV + orig0, faceStartV + orig2, faceStartV + orig1);
              }
            }
          } else {
            // Fallback to fan if triangulation fails for degenerate points
            for (let i = 1; i < nPts - 1; i++) {
              indList.push(faceStartV, faceStartV + i, faceStartV + i + 1);
            }
          }
        }

        // Feature edge outlines along polygon perimeter
        for (let i = 0; i < nPts; i++) {
          const pA = facePts[i];
          const pB = facePts[(i + 1) % nPts];
          edgeList.push(pA[0], pA[1], pA[2], pB[0], pB[1], pB[2]);
        }

        vertIndexBase += nPts;
      }
    }

    if (indList.length === 0) return null;

    return {
      positions: new Float32Array(posList),
      normals: new Float32Array(normList),
      indices: new Uint32Array(indList),
      edgesBuffer: edgeList.length > 0 ? new Float32Array(edgeList) : undefined,
    };
  }

  /**
   * Reconstructs a product entity and its potential child components (GEOMETRY_ENTITY)
   * from multiple representations or MappedItem sub-items.
   * Complies with Rule 15 (binary ontology GROUP / GEOMETRY_ENTITY).
   */
  public rebuildProductEntities(
    rec: StepRecord,
    defaultParentId: string | null,
    _psets?: Record<string, Record<string, any>>,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>,
    elementMaterialMap?: Map<number, string>,
    instantiateMesh: boolean = false
  ): { rootEntity: EvaluatedProductEntity; children: EvaluatedProductEntity[] } | null {
    // Fast-path 1: Pure IFCTRIANGULATEDFACESET products without openings
    if (!instantiateMesh) {
      const fastTriangulated = this.tryBuildFastTriangulatedEntities(
        rec,
        defaultParentId,
        _psets,
        itemToStyleMap,
        faceToStyleMap,
        elementMaterialMap
      );
      if (fastTriangulated) {
        return fastTriangulated;
      }

      // Fast-path 2: Analytical MEP products (pipes, conduits, ducts) without openings
      const fastMep = this.tryBuildFastMepEntities(
        rec,
        defaultParentId,
        _psets,
        itemToStyleMap,
        faceToStyleMap,
        elementMaterialMap
      );
      if (fastMep) {
        return fastMep;
      }
    }

    const rawGuid = this.getParamString(rec.params[0]);
    const id = this.stepIdToEntityId.get(rec.id) || (rawGuid && GuidUtils.isIfcGuid(rawGuid) ? rawGuid : GuidUtils.createIfcGuid());
    this.stepIdToEntityId.set(rec.id, id);
    const name = this.getParamString(rec.params[2]) || rec.type;

    // Param 6 is usually geometric representation (IfcProductDefinitionShape)
    const shapeParam = rec.params[6];
    let subMeshes: { mesh: PolyMesh; itemId: number; materialId?: string }[] = [];

    if (shapeParam && typeof shapeParam === 'object' && 'ref' in shapeParam) {
      subMeshes = this.rebuildSubMeshesFromShape(shapeParam.ref, id, itemToStyleMap, faceToStyleMap);
    }

    const isDoor = rec.type === 'IFCDOOR' || rec.type === 'IFCDOORSTANDARDCASE';
    const isSpace = rec.type === 'IFCSPACE';
    const isExplicitAssembly =
      rec.type === 'IFCELEMENTASSEMBLY' ||
      rec.type === 'IFCGROUP';
    const hasChildren = this.stepParentToChildrenMap.has(rec.id) && (this.stepParentToChildrenMap.get(rec.id)!.size > 0);
    const hasPsets = Boolean(_psets && Object.keys(_psets).length > 0);

    if (subMeshes.length === 0 && !isExplicitAssembly && !hasChildren && !hasPsets && !isSpace && !isDoor) {
      return null;
    }

    // 1. Resolve ObjectPlacement (rec.params[5]) of product
    const placementParam = rec.params[5];
    let mProduct = new THREE.Matrix4();
    if (placementParam && typeof placementParam === 'object' && 'ref' in placementParam) {
      mProduct = this.resolveLocalPlacementMatrix(placementParam.ref);
    }

    // Default material at product level
    const productLevelMatId = elementMaterialMap?.get(rec.id) || itemToStyleMap?.get(rec.id);

    // 2. Apply mProduct and canonical change of basis (Z-Up -> Y-Up) to each sub-mesh
    for (const sm of subMeshes) {
      const mesh = sm.mesh;
      for (const v of mesh.vertices.values()) {
        const p = new THREE.Vector3(v.position.x, v.position.y, v.position.z).applyMatrix4(mProduct);
        // Canonical change: X_croq = X_ifc, Y_croq = Z_ifc, Z_croq = -Y_ifc (det = +1)
        v.position = new Vec3(p.x, p.z, -p.y);
      }
      for (const f of mesh.faces.values()) {
        if (f.holes && f.holes.length > 0) {
          f.holes = f.holes.map((loop) =>
            loop.map((pt) => {
              const p = new THREE.Vector3(pt.x, pt.y, pt.z).applyMatrix4(mProduct);
              return new Vec3(p.x, p.z, -p.y);
            })
          );
        }
        if (!f.materialId) {
          f.materialId = sm.materialId || productLevelMatId;
        }
      }
      if (!sm.materialId && productLevelMatId) {
        sm.materialId = productLevelMatId;
      }
    }

    // In Croquera logic, every IFC product with geometry is formally structured
    // as a container GROUP (with its IFC classification and metadata) hosting its parts/meshes
    // as child GEOMETRY_ENTITY elements (Rule 15).
    const matrixSourceVal = _psets?.Pset_InstanceCommon?.MatrixSourceId;
    const matrixSourceId = (typeof matrixSourceVal === 'object' && matrixSourceVal !== null && 'value' in matrixSourceVal)
      ? matrixSourceVal.value
      : (typeof matrixSourceVal === 'string' ? matrixSourceVal : null);

    const relatingTypeVal = _psets?.IfcRelDefinesByType?.RelatingType;
    const relatingTypeId = (typeof relatingTypeVal === 'object' && relatingTypeVal !== null && 'value' in relatingTypeVal)
      ? relatingTypeVal.value
      : (typeof relatingTypeVal === 'string' ? relatingTypeVal : null);

    const resolvedMatrixId = matrixSourceId || relatingTypeId || null;

    if (subMeshes.length > 0) {
      const rootGroup: EvaluatedProductEntity = {
        id,
        type: 'GROUP',
        name,
        parentId: defaultParentId,
        matrixId: resolvedMatrixId || undefined,
        hidden: isSpace ? true : undefined,
        faces: [],
        vertices: [],
        edges: [],
      };

      const children: EvaluatedProductEntity[] = [];
      for (let idx = 0; idx < subMeshes.length; idx++) {
        const sm = subMeshes[idx];
        const childId = GuidUtils.createIfcGuid();
        const childMesh = sm.mesh;
        const childName = subMeshes.length === 1
          ? name
          : `${name} [${sm.materialId || 'Parte ' + (idx + 1)}]`;

        const childEntity: EvaluatedProductEntity = {
          id: childId,
          type: 'GEOMETRY_ENTITY',
          name: childName,
          parentId: id,
          materialId: sm.materialId,
          polyMesh: childMesh,
          hidden: isSpace ? true : undefined,
          faces: [],
          vertices: [],
          edges: [],
        };

        // faces, vertices y edges se conservan vacíos durante el streaming directo (Paso 1.1)
        children.push(childEntity);
      }

      if (children.length > 0 && children[0].polyMesh) {
        rootGroup.polyMesh = children[0].polyMesh;
      }

      return { rootEntity: rootGroup, children };
    }

    // Purely logical containers or assemblies without direct geometry (Branch Groups - Rule 15)
    if (isExplicitAssembly || hasChildren || hasPsets || isSpace || isDoor) {
      const groupEntity: EvaluatedProductEntity = {
        id,
        type: 'GROUP',
        name,
        parentId: defaultParentId,
        matrixId: resolvedMatrixId || undefined,
        hidden: isSpace ? true : undefined,
        faces: [],
        vertices: [],
        edges: [],
      };
      return { rootEntity: groupEntity, children: [] };
    }

    return null;
  }

  private rebuildProductEntity(
    rec: StepRecord,
    defaultParentId: string | null,
    psets?: Record<string, Record<string, any>>
  ): EvaluatedProductEntity | null {
    const res = this.rebuildProductEntities(rec, defaultParentId, psets);
    if (!res) return null;
    if (res.rootEntity.type === 'GROUP' && res.children.length > 0) {
      if (res.children.length === 1 && res.children[0].polyMesh) {
        res.rootEntity.polyMesh = res.children[0].polyMesh;
      } else {
        const combinedMesh = new PolyMesh(res.rootEntity.id);
        for (const ch of res.children) {
          if (ch.polyMesh) {
            for (const f of ch.polyMesh.faces.values()) {
              combinedMesh.addFace(f.getPositions(), f.normal);
            }
          } else if (ch.rawGeometry) {
            const numTris = ch.rawGeometry.indices.length / 3;
            const pos = ch.rawGeometry.positions;
            const idx = ch.rawGeometry.indices;
            for (let t = 0; t < numTris; t++) {
              const i0 = idx[t * 3] * 3;
              const i1 = idx[t * 3 + 1] * 3;
              const i2 = idx[t * 3 + 2] * 3;
              const p0 = new Vec3(pos[i0], pos[i0 + 1], pos[i0 + 2]);
              const p1 = new Vec3(pos[i1], pos[i1 + 1], pos[i1 + 2]);
              const p2 = new Vec3(pos[i2], pos[i2 + 1], pos[i2 + 2]);
              combinedMesh.addFace([p0, p1, p2]);
            }
          }
        }
        if (combinedMesh.faces.size > 0) {
          combinedMesh.rebuildTopology();
          res.rootEntity.polyMesh = combinedMesh;
        } else if (res.children[0].polyMesh) {
          res.rootEntity.polyMesh = res.children[0].polyMesh;
        }
      }
    }
    return res.rootEntity;
  }

  /**
   * Reconstructs all sub-PolyMeshes navigating from IfcProductDefinitionShape -> IfcShapeRepresentation -> Meshes.
   */
  private rebuildSubMeshesFromShape(
    shapeRef: number,
    baseEntityId: string,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>
  ): { mesh: PolyMesh; itemId: number; materialId?: string }[] {
    const result: { mesh: PolyMesh; itemId: number; materialId?: string }[] = [];
    const shapeRec = this.records.get(shapeRef);
    if (!shapeRec) return result;

    const repsList = shapeRec.params[2];
    if (!Array.isArray(repsList)) return result;

    for (const item of repsList) {
      if (!item || typeof item !== 'object' || !('ref' in item)) continue;
      const repRec = this.records.get(item.ref);
      if (!repRec || this.isNonBodyShapeRepresentation(repRec)) continue;

      const repStyleId = itemToStyleMap?.get(repRec.id);
      const geomItems = repRec.params[3];
      if (!Array.isArray(geomItems)) continue;

      for (const geomItem of geomItems) {
        if (!geomItem || typeof geomItem !== 'object' || !('ref' in geomItem)) continue;
        const gRec = this.records.get(geomItem.ref);
        if (!gRec || gRec.type === 'IFCBOUNDINGBOX') continue;

        if (gRec.type === 'IFCMAPPEDITEM') {
          const mappedSubMeshes = this.rebuildSubMeshesFromMappedItem(
            gRec,
            baseEntityId,
            itemToStyleMap,
            faceToStyleMap
          );
          for (const sm of mappedSubMeshes) {
            if (!sm.materialId && repStyleId) {
              sm.materialId = repStyleId;
              for (const f of sm.mesh.faces.values()) {
                if (!f.materialId) f.materialId = repStyleId;
              }
            }
            result.push(sm);
          }
        } else {
          const mesh = this.rebuildMeshFromItem(geomItem.ref, baseEntityId, itemToStyleMap, faceToStyleMap);
          if (mesh) {
            const itemMatId = itemToStyleMap?.get(geomItem.ref) || repStyleId;
            if (itemMatId) {
              for (const f of mesh.faces.values()) {
                if (!f.materialId) f.materialId = itemMatId;
              }
            }
            result.push({ mesh, itemId: geomItem.ref, materialId: itemMatId });
          }
        }
      }
    }

    return this.consolidateSubMeshes(result, baseEntityId);
  }

  /**
   * Consolidates multiple sub-meshes belonging to the same product by grouping them by materialId.
   * Prevents combinatorial explosion of child entities and draw calls in massive elements
   * composed of thousands of discrete BRep items (e.g. balusters, repetitive profiles).
   */
  private consolidateSubMeshes(
    subMeshes: { mesh: PolyMesh; itemId: number; materialId?: string }[],
    baseEntityId: string
  ): { mesh: PolyMesh; itemId: number; materialId?: string }[] {
    // In compliance with Rule 15 and buildingSMART, elements with discrete components
    // (chairs, multilayer walls, doors, etc.) must preserve their parts as child GEOMETRY_ENTITY elements.
    // Only massive elements (e.g. tessellations or sets > 16 fragments) are consolidated.
    if (subMeshes.length <= 16) return subMeshes;

    const byMaterial = new Map<string, { mesh: PolyMesh; itemId: number; materialId?: string }[]>();
    for (const sm of subMeshes) {
      const matKey = sm.materialId || '__default__';
      let group = byMaterial.get(matKey);
      if (!group) {
        group = [];
        byMaterial.set(matKey, group);
      }
      group.push(sm);
    }

    const consolidated: { mesh: PolyMesh; itemId: number; materialId?: string }[] = [];
    let matIdx = 0;

    for (const [matKey, list] of byMaterial.entries()) {
      if (list.length === 1) {
        consolidated.push(list[0]);
        continue;
      }

      const combinedMesh = new PolyMesh(`${baseEntityId}_combined_${matIdx++}`);
      const materialId = matKey === '__default__' ? undefined : matKey;

      for (const sm of list) {
        for (const face of sm.mesh.faces.values()) {
          const positions = face.getPositions();
          if (positions.length >= 3) {
            const addedFace = combinedMesh.addFace(
              positions,
              face.normal,
              face.holes,
              face.holeOwners
            );
            if (face.materialId || materialId) {
              addedFace.materialId = face.materialId || materialId;
            }
          }
        }
      }

      if (combinedMesh.faces.size > 0) {
        consolidated.push({
          mesh: combinedMesh,
          itemId: list[0].itemId,
          materialId,
        });
      }
    }

    return consolidated;
  }

  /**
   * Reconstructs a PolyMesh from standard STEP representations (Mesh, Extrusion, or Mapping).
   */
  private rebuildMeshFromItem(
    itemId: number,
    entityId: string,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>,
    visited: Set<number> = new Set<number>()
  ): PolyMesh | null {
    if (visited.has(itemId) || visited.size >= 64) {
      console.warn(`[IfcStepImporter] Cycle or recursion depth exceeded in geom item #${itemId}. Skipping.`);
      return null;
    }
    visited.add(itemId);

    try {
      const itemRec = this.records.get(itemId);
      if (!itemRec) return null;

      if (itemRec.type === 'IFCPOLYGONALFACESET') {
        const m = this.rebuildFromPolygonalFaceSet(itemRec, entityId);
        const styleMatId = itemToStyleMap?.get(itemId);
        if (styleMatId && m) {
          for (const f of m.faces.values()) { if (!f.materialId) f.materialId = styleMatId; }
        }
        return m;
      }

      if (itemRec.type === 'IFCTRIANGULATEDFACESET' || itemRec.type === 'IFCTRIANGULATEDIRREGULARNETWORK') {
        const m = this.rebuildFromTriangulatedFaceSet(itemRec, entityId, true);
        const styleMatId = itemToStyleMap?.get(itemId);
        if (styleMatId && m) {
          for (const f of m.faces.values()) { if (!f.materialId) f.materialId = styleMatId; }
        }
        return m;
      }

      if (itemRec.type === 'IFCEXTRUDEDAREASOLID') {
        return this.rebuildFromExtrudedAreaSolid(itemRec, entityId, itemToStyleMap);
      }

      if (itemRec.type === 'IFCSWEPTDISKSOLID' || itemRec.type === 'IFCSWEPTDISKSOLIDPOLYGONAL') {
        return this.rebuildFromSweptDiskSolid(itemRec, entityId, itemToStyleMap);
      }

      if (itemRec.type === 'IFCSURFACECURVESWEPTAREASOLID' || itemRec.type === 'IFCFIXEDREFERENCESWEPTAREASOLID') {
        return this.rebuildFromSurfaceCurveSweptAreaSolid(itemRec, entityId, itemToStyleMap);
      }

      if (itemRec.type === 'IFCREVOLVEDAREASOLID') {
        return this.rebuildFromRevolvedAreaSolid(itemRec, entityId, itemToStyleMap);
      }

      if (itemRec.type === 'IFCMAPPEDITEM') {
        return this.rebuildFromMappedItem(itemRec, entityId, itemToStyleMap, faceToStyleMap, visited);
      }

      if (
        itemRec.type === 'IFCFACETEDBREP' ||
        itemRec.type === 'IFCCLOSEDSHELL' ||
        itemRec.type === 'IFCOPENSHELL' ||
        itemRec.type === 'IFCCONNECTEDFACESET' ||
        itemRec.type === 'IFCFACETEDBREPWITHVOIDS'
      ) {
        return this.rebuildFromFacetedBrep(itemRec, entityId, itemToStyleMap, faceToStyleMap);
      }

      if (itemRec.type === 'IFCFACEBASEDSURFACEMODEL') {
        return this.rebuildFromFaceBasedSurfaceModel(itemRec, entityId, itemToStyleMap, faceToStyleMap);
      }

      if (itemRec.type === 'IFCSHELLBASEDSURFACEMODEL') {
        const shellsParam = itemRec.params[0];
        const shells = Array.isArray(shellsParam) ? shellsParam : [shellsParam];
        const polyMesh = new PolyMesh(entityId);
        const repStyleId = itemToStyleMap?.get(itemId);
        let totalFaces = 0;
        for (const sRef of shells) {
          if (sRef && typeof sRef === 'object' && 'ref' in sRef) {
            const sRec = this.records.get(sRef.ref);
            if (sRec) {
              totalFaces += this.appendFacesFromConnectedFaceSet(
                sRec,
                polyMesh,
                itemToStyleMap,
                faceToStyleMap,
                repStyleId
              );
            }
          }
        }
        if (totalFaces > 0 && polyMesh.faces.size > 0) {
          polyMesh.resetVersion();
          return polyMesh;
        }
      }

      if (itemRec.type === 'IFCBOOLEANRESULT' || itemRec.type === 'IFCBOOLEANCLIPPINGRESULT') {
        return this.rebuildFromBooleanResult(itemRec, entityId, itemToStyleMap, faceToStyleMap, visited);
      }

      if (itemRec.type === 'IFCPOLYGONALBOUNDEDHALFSPACE') {
        return this.rebuildFromPolygonalBoundedHalfSpace(itemRec, entityId);
      }

      return null;
    } finally {
      visited.delete(itemId);
    }
  }

  /**
   * Reconstructs a PolyMesh from an IfcBooleanResult / IfcBooleanClippingResult by navigating recursively
   * through the first operand (FirstOperand) to the base solid.
   */
  private rebuildFromBooleanResult(
    rec: StepRecord,
    entityId: string,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>,
    visited: Set<number> = new Set<number>()
  ): PolyMesh | null {
    // rec.params: [Operator, FirstOperand, SecondOperand]
    const opParam = rec.params[0];
    const operator = (
      typeof opParam === 'string'
        ? opParam
        : opParam && typeof opParam === 'object' && 'enum' in opParam
          ? (opParam as any).enum
          : ''
    ).toUpperCase();
    const firstOperandParam = rec.params[1];
    if (!firstOperandParam || typeof firstOperandParam !== 'object' || !('ref' in firstOperandParam)) {
      return null;
    }
    const firstMesh = this.rebuildMeshFromItem(firstOperandParam.ref, entityId, itemToStyleMap, faceToStyleMap, visited);
    if (!firstMesh) return null;

    const secondOperandParam = rec.params[2];
    if (secondOperandParam && typeof secondOperandParam === 'object' && 'ref' in secondOperandParam) {
      try {
        const secondRec = this.records.get(secondOperandParam.ref);
        const isHalfSpace =
          secondRec &&
          secondRec.type === 'IFCHALFSPACESOLID';
        if (operator.includes('DIFFERENCE') && isHalfSpace) {
          // Case 1: Analytical infinite half-space solid -> analytical clipByPlane
          const planeParam = secondRec.params[0];
          if (planeParam && typeof planeParam === 'object' && 'ref' in planeParam) {
            const planeRec = this.records.get(planeParam.ref);
            if (planeRec && planeRec.params[0] && typeof planeRec.params[0] === 'object' && 'ref' in planeRec.params[0]) {
              const posRec = this.records.get(planeRec.params[0].ref);
              if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
                const mPlane = this.resolveAxis2Placement3D(posRec);
                const pos = new Vec3(mPlane.elements[12], mPlane.elements[13], mPlane.elements[14]);
                let normal = new Vec3(mPlane.elements[8], mPlane.elements[9], mPlane.elements[10]).normalize();
                const agreementFlag = secondRec.params[1] !== false && secondRec.params[1] !== '.F.';
                // In ISO 10303-42 / IFC: AgreementFlag == false means surface normal points INTO the removed half-space.
                // AgreementFlag == true means surface normal points AWAY from the removed half-space.
                if (agreementFlag) {
                  normal = normal.negate();
                }
                const plane = Plane.fromPointAndNormal(pos, normal);
                firstMesh.clipByPlane(plane, true);
              }
            }
          }
        } else {
          // Case 2: General polyhedral solid -> Dispatch to BooleanCSGKernel
          const secondMesh = this.rebuildMeshFromItem(
            secondOperandParam.ref,
            GuidUtils.createIfcGuid(),
            itemToStyleMap,
            faceToStyleMap,
            visited
          );
          if (secondMesh && secondMesh.faces.size > 0) {
            if (operator.includes('DIFFERENCE')) {
              const subMesh = BooleanCSGKernel.subtract(firstMesh, secondMesh, {
                openingGroupId: entityId,
              });
              if (subMesh && subMesh.faces.size > 0) {
                return subMesh;
              }
            } else if (operator.includes('UNION')) {
              const unionMesh = BooleanCSGKernel.union(firstMesh, secondMesh);
              if (unionMesh && unionMesh.faces.size > 0) {
                return unionMesh;
              }
            } else if (operator.includes('INTERSECTION')) {
              const interMesh = BooleanCSGKernel.intersect(firstMesh, secondMesh);
              if (interMesh && interMesh.faces.size > 0) {
                return interMesh;
              }
            }
          }
        }
      } catch (err: any) {
        console.warn(`[IfcStepImporter] Failed to apply boolean operation #${rec.id}: ${err?.message || err}`);
      }
    }
    return firstMesh;
  }

  /**
   * Reconstructs a PolyMesh from an IfcPolygonalBoundedHalfSpace (ISO 16739-1 / IFC 4.3).
   * Generates a 2-manifold closed polygonal prism extruded along the halfspace normal direction
   * for exact CSG boolean clipping, preserving the unclipped body of the element.
   */
  private rebuildFromPolygonalBoundedHalfSpace(rec: StepRecord, entityId: string): PolyMesh | null {
    // rec.params: [BaseSurface, AgreementFlag, Position, PolygonalBoundary]
    const positionParam = rec.params[2];
    if (!positionParam || typeof positionParam !== 'object' || !('ref' in positionParam)) {
      return null;
    }
    const posRec = this.records.get(positionParam.ref);
    if (!posRec || posRec.type !== 'IFCAXIS2PLACEMENT3D') {
      return null;
    }
    const mPos = this.resolveAxis2Placement3D(posRec);

    const boundaryParam = rec.params[3];
    if (!boundaryParam || typeof boundaryParam !== 'object' || !('ref' in boundaryParam)) {
      return null;
    }
    const rawBoundaryPoints = this.extract2DCurvePoints(boundaryParam.ref);
    if (rawBoundaryPoints.length < 3) return null;

    const pts = [...rawBoundaryPoints];
    if (pts.length >= 4) {
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < GeometryTolerance.COINCIDENT_POINT) {
        pts.pop();
      }
    }
    if (pts.length < 3) return null;

    // Ensure CCW orientation in the (u, v) plane
    if (PolygonClipping.signedArea2D(pts) < 0) {
      pts.reverse();
    }

    // Resolve BaseSurface plane in object space
    let basePlane: Plane | null = null;
    let nBase = new Vec3(0, 0, 1);
    const planeParam = rec.params[0];
    if (planeParam && typeof planeParam === 'object' && 'ref' in planeParam) {
      const planeRec = this.records.get(planeParam.ref);
      if (planeRec && planeRec.params[0] && typeof planeRec.params[0] === 'object' && 'ref' in planeRec.params[0]) {
        const planePosRec = this.records.get(planeRec.params[0].ref);
        if (planePosRec && planePosRec.type === 'IFCAXIS2PLACEMENT3D') {
          const mPlane = this.resolveAxis2Placement3D(planePosRec);
          const p0 = new Vec3(mPlane.elements[12], mPlane.elements[13], mPlane.elements[14]);
          nBase = new Vec3(mPlane.elements[8], mPlane.elements[9], mPlane.elements[10]).normalize();
          basePlane = Plane.fromPointAndNormal(p0, nBase);
        }
      }
    }

    const agreementFlagParam = rec.params[1];
    const agreementFlag = agreementFlagParam !== false && agreementFlagParam !== '.F.';

    // In ISO 10303-42 / IFC 4.3 standard:
    // AgreementFlag == false: surface normal points INTO the removed halfspace volume.
    // AgreementFlag == true: surface normal points AWAY from the removed halfspace volume.
    const vIntoHalfspace = agreementFlag ? nBase.negate() : nBase;

    // Build bounding prism spanning from -H to +H along local Z of Position
    const H = 50.0;
    const bottomPts = pts.map((p) => new Vec3(p.x, p.y, -H));
    const topPts = pts.map((p) => new Vec3(p.x, p.y, H));

    const polyMesh = new PolyMesh(entityId);
    // Bottom cap (Z = -H, normal points into -Z => reversed)
    polyMesh.addFace([...bottomPts].reverse());
    // Top cap (Z = +H, normal points into +Z => unreversed)
    polyMesh.addFace(topPts);

    // Side faces
    const N = pts.length;
    for (let i = 0; i < N; i++) {
      const next = (i + 1) % N;
      polyMesh.addFace([bottomPts[i], bottomPts[next], topPts[next], topPts[i]]);
    }

    // Transform prism into object space
    this.applyMatrixToPolyMesh(polyMesh, mPos);
    polyMesh.rebuildTopology();

    // Symmetrically slice the bounding prism with BaseSurface:
    // clipByPlane(plane, true) keeps points where (p - p0) . cutNormal <= 0.
    // Since vIntoHalfspace points into the solid volume to RETAIN, we want (p - p0) . vIntoHalfspace >= 0,
    // which corresponds to cutNormal = -vIntoHalfspace.
    if (basePlane) {
      const cutNormal = vIntoHalfspace.negate();
      const clipPlane = Plane.fromPointAndNormal(basePlane.origin, cutNormal);
      polyMesh.clipByPlane(clipPlane, true);
    } else {
      const zPos = new Vec3(mPos.elements[8], mPos.elements[9], mPos.elements[10]).normalize();
      const originPos = new Vec3(mPos.elements[12], mPos.elements[13], mPos.elements[14]);
      const dot = vIntoHalfspace.dot(zPos);
      const cutNormal = dot >= 0 ? zPos.negate() : zPos;
      const clipPlane = Plane.fromPointAndNormal(originPos, cutNormal);
      polyMesh.clipByPlane(clipPlane, true);
    }

    polyMesh.rebuildTopology();
    polyMesh.resetVersion();
    return polyMesh;
  }

  /**
   * Reconstructs a PolyMesh from an IfcExtrudedAreaSolid (Revit/ArchiCAD standard).
   * Supplies multiple loops and composite profiles according to Rule 16 (Single Path).
   */
  private rebuildFromExtrudedAreaSolid(
    rec: StepRecord,
    entityId: string,
    itemToStyleMap?: Map<number, string>
  ): PolyMesh | null {
    // rec.params: [SweptArea, Position, ExtrudedDirection, Depth]
    const sweptAreaParam = rec.params[IFC_GEOM_ATTRS.EXTRUDED_SWEPT_AREA];
    const positionParam = rec.params[IFC_GEOM_ATTRS.EXTRUDED_POSITION];
    const dirParam = rec.params[IFC_GEOM_ATTRS.EXTRUDED_EXTRUDED_DIRECTION];
    const depthParam = rec.params[IFC_GEOM_ATTRS.EXTRUDED_DEPTH];

    const rawDepth = typeof depthParam === 'number' ? depthParam : parseFloat(String(depthParam || 0)) || 0;
    const depth = rawDepth * this.lengthUnitScale;
    if (depth <= 0) return null;

    if (!sweptAreaParam || typeof sweptAreaParam !== 'object' || !('ref' in sweptAreaParam)) {
      return null;
    }

    let mSolid: THREE.Matrix4 | null = null;
    if (positionParam && typeof positionParam === 'object' && 'ref' in positionParam) {
      const posRec = this.records.get(positionParam.ref);
      if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
        mSolid = this.resolveAxis2Placement3D(posRec);
      }
    }

    // 2nd-tier parametric mesh cache check
    const paramSig = ParametricSolidHasher.computeExtrudedAreaSolidHash(this.records, rec, this.lengthUnitScale);
    if (paramSig && this.parametricMeshCache.has(paramSig.hash)) {
      const cached = this.parametricMeshCache.get(paramSig.hash)!;
      const polyMesh = cached.clone(entityId);
      if (mSolid) {
        this.applyMatrixToPolyMesh(polyMesh, mSolid);
      }
      const styleMatId = itemToStyleMap?.get(rec.id);
      if (styleMatId) {
        for (const face of polyMesh.faces.values()) {
          face.materialId = styleMatId;
        }
      }
      polyMesh.resetVersion();
      return polyMesh;
    }

    // Single Path (Rule 16): canonical 2D profile extraction
    const profileLoops = this.extractProfileLoops2D((sweptAreaParam as any).ref);
    if (profileLoops.length === 0) return null;

    // Extrusion vector (IFCDIRECTION) in solid local system (default Z: (0, 0, 1))
    let extrudeDir = new THREE.Vector3(0, 0, 1);
    if (dirParam && typeof dirParam === 'object' && 'ref' in dirParam) {
      const dirRec = this.records.get(dirParam.ref);
      if (dirRec && Array.isArray(dirRec.params[0])) {
        const d = dirRec.params[0].map((v: any) => typeof v === 'number' ? v : parseFloat(String(v)) || 0);
        if (d.length >= 3) {
          extrudeDir.set(d[0], d[1], d[2]);
        }
      }
    }
    extrudeDir.normalize().multiplyScalar(depth);

    const polyMesh = new PolyMesh(entityId);

    for (const { outer: profile2DPoints, inners: inner2DLoops } of profileLoops) {
      if (profile2DPoints.length < 3) continue;

      let baseVerts = profile2DPoints.map((p) => new THREE.Vector3(p.x, p.y, 0));
      let topVerts = baseVerts.map((v) => new THREE.Vector3().addVectors(v, extrudeDir));

      let innerBaseLoops = inner2DLoops.map((loop) =>
        loop.map((p) => new THREE.Vector3(p.x, p.y, 0))
      );
      let innerTopLoops = innerBaseLoops.map((loop) =>
        loop.map((v) => new THREE.Vector3().addVectors(v, extrudeDir))
      );

      const basePts = baseVerts.map((v) => new Vec3(v.x, v.y, v.z));
      const topPts = topVerts.map((v) => new Vec3(v.x, v.y, v.z));

      const innerBasePts = innerBaseLoops.map((loop) =>
        loop.map((v) => new Vec3(v.x, v.y, v.z))
      );
      const innerTopPts = innerTopLoops.map((loop) =>
        loop.map((v) => new Vec3(v.x, v.y, v.z))
      );

      const isNegativeExtrusion = extrudeDir.z < 0;

      // Bottom / starting face (Z = 0):
      // When extruding in +Z direction, Z = 0 is bottom cap and must point in -Z (reversed).
      // When extruding in -Z direction, Z = 0 is top cap and must point in +Z (unreversed).
      const startFace = isNegativeExtrusion ? basePts : [...basePts].reverse();
      const startHoles = innerBasePts.map((loop) => (isNegativeExtrusion ? loop : [...loop].reverse()));
      polyMesh.addFace(startFace, undefined, startHoles.length > 0 ? startHoles : undefined);

      // Top / ending face (Z = extrudeDir.z):
      // When extruding in +Z direction, Z = extrudeDir.z is top cap and must point in +Z (unreversed).
      // When extruding in -Z direction, Z = extrudeDir.z is bottom cap and must point in -Z (reversed).
      const endFace = isNegativeExtrusion ? [...topPts].reverse() : topPts;
      const endHoles = innerTopPts.map((loop) => (isNegativeExtrusion ? [...loop].reverse() : loop));
      polyMesh.addFace(endFace, undefined, endHoles.length > 0 ? endHoles : undefined);

      // Outer quadrilateral side faces (oriented outwards)
      const N = basePts.length;
      for (let i = 0; i < N; i++) {
        const next = (i + 1) % N;
        const sideFace = isNegativeExtrusion
          ? [basePts[next], basePts[i], topPts[i], topPts[next]]
          : [basePts[i], basePts[next], topPts[next], topPts[i]];
        polyMesh.addFace(sideFace);
      }

      // Inner side faces (opening tunnels)
      for (let k = 0; k < innerBasePts.length; k++) {
        const hBase = innerBasePts[k];
        const hTop = innerTopPts[k];
        const M = hBase.length;
        for (let j = 0; j < M; j++) {
          const next = (j + 1) % M;
          const tunnelFace = isNegativeExtrusion
            ? [hBase[j], hBase[next], hTop[next], hTop[j]]
            : [hBase[next], hBase[j], hTop[j], hTop[next]];
          polyMesh.addFace(tunnelFace);
        }
      }
    }

    if (polyMesh.faces.size === 0) return null;

    // Cache un-transformed PolyMesh for 2nd-tier mesh deduplication
    if (paramSig && !this.parametricMeshCache.has(paramSig.hash)) {
      this.parametricMeshCache.set(paramSig.hash, polyMesh.clone());
    }

    if (mSolid) {
      this.applyMatrixToPolyMesh(polyMesh, mSolid);
    }

    const styleMatId = itemToStyleMap?.get(rec.id);
    if (styleMatId) {
      for (const face of polyMesh.faces.values()) {
        face.materialId = styleMatId;
      }
    }

    polyMesh.resetVersion();
    return polyMesh;
  }

  /**
   * Applies an affine THREE.Matrix4 transformation to the vertices and holes of a PolyMesh.
   */
  private applyMatrixToPolyMesh(mesh: PolyMesh, mat: THREE.Matrix4): void {
    for (const v of mesh.vertices.values()) {
      const p = new THREE.Vector3(v.position.x, v.position.y, v.position.z).applyMatrix4(mat);
      v.position = new Vec3(p.x, p.y, p.z);
    }
    for (const f of mesh.faces.values()) {
      if (f.holes && f.holes.length > 0) {
        f.holes = f.holes.map((loop) =>
          loop.map((pt) => {
            const p = new THREE.Vector3(pt.x, pt.y, pt.z).applyMatrix4(mat);
            return new Vec3(p.x, p.y, p.z);
          })
        );
      }
    }
  }

  /**
   * Reconstructs a PolyMesh from an IfcSweptDiskSolid or IfcSweptDiskSolidPolygonal (ISO 16739-1 / IFC 4.3).
   * Generates a tubular solid sweeping an orthogonal flat circular disk along the 3D directrix.
   */
  private rebuildFromSweptDiskSolid(
    rec: StepRecord,
    entityId: string,
    itemToStyleMap?: Map<number, string>
  ): PolyMesh | null {
    const directrixParam = rec.params[IFC_GEOM_ATTRS.SWEPT_DISK_DIRECTRIX];
    const radiusParam = rec.params[IFC_GEOM_ATTRS.SWEPT_DISK_RADIUS];
    const innerRadiusParam = rec.params[IFC_GEOM_ATTRS.SWEPT_DISK_INNER_RADIUS];

    if (!directrixParam || typeof directrixParam !== 'object' || !('ref' in directrixParam)) {
      const msg = `IfcSweptDiskSolid #${rec.id} without valid directrix`;
      console.warn(`[IfcStepImporter] ${msg}`);
      this.importWarnings.push(msg);
      return null;
    }

    const directrix = this.extract3DCurvePoints((directrixParam as any).ref);
    if (!directrix || directrix.points.length < 2) {
      const msg = `3D Directrix unresolved or degenerate (< 2 points) in IfcSweptDiskSolid #${rec.id}`;
      console.warn(`[IfcStepImporter] ${msg}`);
      this.importWarnings.push(msg);
      return null;
    }

    const rawRadius = typeof radiusParam === 'number' ? radiusParam : parseFloat(String(radiusParam || 0)) || 0;
    const radius = rawRadius * this.lengthUnitScale;
    if (radius <= GeometryTolerance.COINCIDENT_POINT) {
      const msg = `Zero or degenerate radius (${radius}) in IfcSweptDiskSolid #${rec.id}`;
      console.warn(`[IfcStepImporter] ${msg}`);
      this.importWarnings.push(msg);
      return null;
    }

    const pathPoints = directrix.points;
    const p0 = pathPoints[0];
    const p1 = pathPoints[1];
    let T0 = p1.sub(p0);
    const t0Len = T0.length();
    if (t0Len < GeometryTolerance.COINCIDENT_POINT) {
      return null;
    }
    T0 = T0.scale(1 / t0Len);

    // Canonical invariant up-vector
    const up = Math.abs(T0.dot(Vec3.Y)) < 0.9 ? Vec3.Y : Vec3.X;
    const u = T0.cross(up).normalize();
    const v = T0.cross(u).normalize();

    // Discretization of outer profile into 16 segments in the plane orthogonal to T0
    const SEGMENTS = 16;
    const outerProfileVerts: Vec3[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const theta = (i / SEGMENTS) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      outerProfileVerts.push(
        new Vec3(
          p0.x + radius * (cosT * u.x + sinT * v.x),
          p0.y + radius * (cosT * u.y + sinT * v.y),
          p0.z + radius * (cosT * u.z + sinT * v.z)
        )
      );
    }

    const outerMesh = SweepKernel.sweepProfileAlongPath(
      outerProfileVerts,
      pathPoints,
      directrix.isClosed,
      entityId
    );
    if (!outerMesh || outerMesh.faces.size === 0) {
      return null;
    }

    let finalMesh = outerMesh;

    // Subtraction of inner cavity if innerRadius is specified (ISO 16739-1)
    if (innerRadiusParam !== null && innerRadiusParam !== undefined && innerRadiusParam !== '$') {
      const rawInnerRadius =
        typeof innerRadiusParam === 'number' ? innerRadiusParam : parseFloat(String(innerRadiusParam)) || 0;
      const innerRadius = rawInnerRadius * this.lengthUnitScale;
      if (innerRadius > GeometryTolerance.COINCIDENT_POINT && innerRadius < radius) {
        const innerProfileVerts: Vec3[] = [];
        for (let i = 0; i < SEGMENTS; i++) {
          const theta = (i / SEGMENTS) * Math.PI * 2;
          const cosT = Math.cos(theta);
          const sinT = Math.sin(theta);
          innerProfileVerts.push(
            new Vec3(
              p0.x + innerRadius * (cosT * u.x + sinT * v.x),
              p0.y + innerRadius * (cosT * u.y + sinT * v.y),
              p0.z + innerRadius * (cosT * u.z + sinT * v.z)
            )
          );
        }
        const innerMesh = SweepKernel.sweepProfileAlongPath(
          innerProfileVerts,
          pathPoints,
          directrix.isClosed,
          GuidUtils.createIfcGuid()
        );
        if (innerMesh && innerMesh.faces.size > 0) {
          try {
            const hollow = BooleanCSGKernel.subtract(outerMesh, innerMesh, {
              openingGroupId: entityId,
            });
            if (hollow && hollow.faces.size > 0) {
              finalMesh = hollow;
            }
          } catch (err: any) {
            console.warn(`[IfcStepImporter] Subtraction of innerRadius in IfcSweptDiskSolid #${rec.id} failed: ${err?.message || err}`);
          }
        }
      }
    }

    const styleMatId = itemToStyleMap?.get(rec.id);
    if (styleMatId) {
      for (const face of finalMesh.faces.values()) {
        face.materialId = styleMatId;
      }
    }

    finalMesh.resetVersion();
    return finalMesh;
  }

  /**
   * Reconstructs a PolyMesh from IfcSurfaceCurveSweptAreaSolid or IfcFixedReferenceSweptAreaSolid.
   * Sweeps any 2D profile (complete catalog) along a 3D directrix.
   */
  private rebuildFromSurfaceCurveSweptAreaSolid(
    rec: StepRecord,
    entityId: string,
    itemToStyleMap?: Map<number, string>
  ): PolyMesh | null {
    const sweptAreaParam = rec.params[IFC_GEOM_ATTRS.SURFACE_SWEEP_SWEPT_AREA];
    const positionParam = rec.params[IFC_GEOM_ATTRS.SURFACE_SWEEP_POSITION];
    const directrixParam = rec.params[IFC_GEOM_ATTRS.SURFACE_SWEEP_DIRECTRIX];

    if (!sweptAreaParam || typeof sweptAreaParam !== 'object' || !('ref' in sweptAreaParam)) {
      return null;
    }
    if (!directrixParam || typeof directrixParam !== 'object' || !('ref' in directrixParam)) {
      return null;
    }

    const profileLoops = this.extractProfileLoops2D((sweptAreaParam as any).ref);
    if (profileLoops.length === 0) return null;

    const directrix = this.extract3DCurvePoints((directrixParam as any).ref);
    if (!directrix || directrix.points.length < 2) return null;

    let mSolid: THREE.Matrix4 | null = null;
    if (positionParam && typeof positionParam === 'object' && 'ref' in positionParam) {
      const posRec = this.records.get(positionParam.ref);
      if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
        mSolid = this.resolveAxis2Placement3D(posRec);
      }
    }

    const pathPoints = directrix.points;
    const p0 = pathPoints[0];
    const p1 = pathPoints[1];
    let T0 = p1.sub(p0);
    const t0Len = T0.length();
    if (t0Len < GeometryTolerance.COINCIDENT_POINT) return null;
    T0 = T0.scale(1 / t0Len);

    const up = Math.abs(T0.dot(Vec3.Y)) < 0.9 ? Vec3.Y : Vec3.X;
    const u = T0.cross(up).normalize();
    const v = T0.cross(u).normalize();

    let combinedMesh: PolyMesh | null = null;

    for (const loop of profileLoops) {
      if (loop.outer.length < 3) continue;

      const profileVerts: Vec3[] = loop.outer.map(
        (p) =>
          new Vec3(
            p0.x + p.x * u.x + p.y * v.x,
            p0.y + p.x * u.y + p.y * v.y,
            p0.z + p.x * u.z + p.y * v.z
          )
      );

      const swept = SweepKernel.sweepProfileAlongPath(
        profileVerts,
        pathPoints,
        directrix.isClosed,
        entityId
      );
      if (!swept || swept.faces.size === 0) continue;

      // If the profile contains inner cavities (inners), subtract them
      if (loop.inners && loop.inners.length > 0) {
        for (const inner of loop.inners) {
          if (inner.length < 3) continue;
          const innerVerts: Vec3[] = inner.map(
            (p) =>
              new Vec3(
                p0.x + p.x * u.x + p.y * v.x,
                p0.y + p.x * u.y + p.y * v.y,
                p0.z + p.x * u.z + p.y * v.z
              )
          );
          const innerSwept = SweepKernel.sweepProfileAlongPath(
            innerVerts,
            pathPoints,
            directrix.isClosed,
            GuidUtils.createIfcGuid()
          );
          if (innerSwept && innerSwept.faces.size > 0) {
            try {
              const hollow = BooleanCSGKernel.subtract(swept, innerSwept, {
                openingGroupId: entityId,
              });
              if (hollow && hollow.faces.size > 0) {
                for (const fid of Array.from(swept.faces.keys())) {
                  swept.removeFace(fid);
                }
                for (const f of hollow.faces.values()) {
                  const newF = swept.addFace(f.getPositions(), undefined, f.holes);
                  if (f.materialId && newF) newF.materialId = f.materialId;
                }
              }
            } catch (err: any) {
              console.warn(`[IfcStepImporter] Inner sweep void failed in #${rec.id}: ${err?.message || err}`);
            }
          }
        }
      }

      if (!combinedMesh) {
        combinedMesh = swept;
      } else {
        for (const f of swept.faces.values()) {
          const newF = combinedMesh.addFace(f.getPositions(), undefined, f.holes);
          if (f.materialId && newF) newF.materialId = f.materialId;
        }
      }
    }

    if (!combinedMesh || combinedMesh.faces.size === 0) return null;

    if (mSolid) {
      this.applyMatrixToPolyMesh(combinedMesh, mSolid);
    }

    const styleMatId = itemToStyleMap?.get(rec.id);
    if (styleMatId) {
      for (const face of combinedMesh.faces.values()) {
        face.materialId = styleMatId;
      }
    }

    combinedMesh.resetVersion();
    return combinedMesh;
  }

  /**
   * Reconstructs a PolyMesh from an IfcRevolvedAreaSolid (ISO 16739-1 / IFC 4.3).
   * Revolves any 2D profile around a linear IFCAXIS1PLACEMENT axis.
   */
  private rebuildFromRevolvedAreaSolid(
    rec: StepRecord,
    entityId: string,
    itemToStyleMap?: Map<number, string>
  ): PolyMesh | null {
    const sweptAreaParam = rec.params[IFC_GEOM_ATTRS.REVOLVED_SWEPT_AREA];
    const positionParam = rec.params[IFC_GEOM_ATTRS.REVOLVED_POSITION];
    const axisParam = rec.params[IFC_GEOM_ATTRS.REVOLVED_AXIS];
    const angleParam = rec.params[IFC_GEOM_ATTRS.REVOLVED_ANGLE];

    if (!sweptAreaParam || typeof sweptAreaParam !== 'object' || !('ref' in sweptAreaParam)) {
      return null;
    }
    if (!axisParam || typeof axisParam !== 'object' || !('ref' in axisParam)) {
      return null;
    }

    const rawAngle = typeof angleParam === 'number' ? angleParam : parseFloat(String(angleParam || 0)) || 0;
    const angleRadians = this.toAngleRadians(rawAngle);
    if (Math.abs(angleRadians) < GeometryTolerance.MATH_EPSILON) {
      const msg = `Zero or degenerate angle in IfcRevolvedAreaSolid #${rec.id}`;
      console.warn(`[IfcStepImporter] ${msg}`);
      this.importWarnings.push(msg);
      return null;
    }

    // Resolve IFCAXIS1PLACEMENT: Location (param[0]), Axis (param[1])
    const axisRec = this.records.get(axisParam.ref);
    if (!axisRec) return null;

    const locParam = axisRec.params[0];
    let axisPoint = new Vec3(0, 0, 0);
    if (locParam && typeof locParam === 'object' && 'ref' in locParam) {
      const locRec = this.records.get(locParam.ref);
      if (locRec && Array.isArray(locRec.params[0])) {
        const c = locRec.params[0].map((v: any) =>
          (typeof v === 'number' ? v : parseFloat(String(v)) || 0) * this.lengthUnitScale
        );
        axisPoint = new Vec3(c[0] || 0, c[1] || 0, c[2] || 0);
      }
    }

    const dirParam = axisRec.params[1];
    let axisDirection = new Vec3(0, 0, 1); // Default Z in ISO 10303-42 / IFC 4.3
    if (dirParam && typeof dirParam === 'object' && 'ref' in dirParam) {
      const dirRec = this.records.get(dirParam.ref);
      if (dirRec && Array.isArray(dirRec.params[0])) {
        const d = dirRec.params[0].map((v: any) => (typeof v === 'number' ? v : parseFloat(String(v)) || 0));
        const len = Math.hypot(d[0] || 0, d[1] || 0, d[2] || 0);
        if (len > GeometryTolerance.COINCIDENT_POINT) {
          axisDirection = new Vec3((d[0] || 0) / len, (d[1] || 0) / len, (d[2] || 0) / len);
        }
      }
    }

    // Single Path (Rule 16): 2D profile extraction
    const profileLoops = this.extractProfileLoops2D((sweptAreaParam as any).ref);
    if (profileLoops.length === 0) return null;

    let mSolid: THREE.Matrix4 | null = null;
    if (positionParam && typeof positionParam === 'object' && 'ref' in positionParam) {
      const posRec = this.records.get(positionParam.ref);
      if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
        mSolid = this.resolveAxis2Placement3D(posRec);
      }
    }

    let combinedMesh: PolyMesh | null = null;

    for (const loop of profileLoops) {
      if (loop.outer.length < 3) continue;

      // The 2D profile in IFC is defined in the local XY plane: (x, y, 0)
      const profileVertices = loop.outer.map((p) => new Vec3(p.x, p.y, 0));

      const revolved = RevolveKernel.revolveProfile({
        profileVertices,
        axisPoint,
        axisDirection,
        angleRadians,
        meshId: entityId,
      });

      if (!revolved || revolved.faces.size === 0) continue;

      // If the profile has holes (e.g. IFCCIRCLEHOLLOWPROFILEDEF or WITHVOIDS), subtract cavity
      if (loop.inners && loop.inners.length > 0) {
        for (const inner of loop.inners) {
          if (inner.length < 3) continue;
          const innerVerts = inner.map((p) => new Vec3(p.x, p.y, 0));
          const innerRevolved = RevolveKernel.revolveProfile({
            profileVertices: innerVerts,
            axisPoint,
            axisDirection,
            angleRadians,
            meshId: GuidUtils.createIfcGuid(),
          });
          if (innerRevolved && innerRevolved.faces.size > 0) {
            try {
              const hollow = BooleanCSGKernel.subtract(revolved, innerRevolved, {
                openingGroupId: entityId,
              });
              if (hollow && hollow.faces.size > 0) {
                for (const fid of Array.from(revolved.faces.keys())) {
                  revolved.removeFace(fid);
                }
                for (const f of hollow.faces.values()) {
                  const newF = revolved.addFace(f.getPositions(), undefined, f.holes);
                  if (f.materialId && newF) newF.materialId = f.materialId;
                }
              }
            } catch (err: any) {
              console.warn(`[IfcStepImporter] Inner revolution void failed in #${rec.id}: ${err?.message || err}`);
            }
          }
        }
      }

      if (!combinedMesh) {
        combinedMesh = revolved;
      } else {
        for (const f of revolved.faces.values()) {
          const newF = combinedMesh.addFace(f.getPositions(), undefined, f.holes);
          if (f.materialId && newF) newF.materialId = f.materialId;
        }
      }
    }

    if (!combinedMesh || combinedMesh.faces.size === 0) return null;

    if (mSolid) {
      this.applyMatrixToPolyMesh(combinedMesh, mSolid);
    }

    const styleMatId = itemToStyleMap?.get(rec.id);
    if (styleMatId) {
      for (const face of combinedMesh.faces.values()) {
        face.materialId = styleMatId;
      }
    }

    combinedMesh.resetVersion();
    return combinedMesh;
  }

  /**
   * Extracts 2D contours ({ outer: { x, y }[], inners: { x, y }[][] }) from any IfcProfileDef definition.
   * Single Path (Rule 16): Governs extrusions, sweeps, and revolutions without duplication.
   * Supports standard, hollow, parameterized (L, T, U, C, Z, Trapezium, Ellipse, AsymmetricI),
   * derived (IfcDerivedProfileDef with operators and reflections), and composite profiles (IfcCompositeProfileDef).
   */
  private extractProfileLoops2D(
    profileRef: number,
    visited = new Set<number>()
  ): Array<{ outer: { x: number; y: number }[]; inners: { x: number; y: number }[][] }> {
    if (visited.has(profileRef) || visited.size >= 32) {
      console.warn(`[IfcStepImporter] Cycle detected in IfcProfileDef #${profileRef}`);
      return [];
    }
    visited.add(profileRef);

    const sweptAreaRec = this.records.get(profileRef);
    if (!sweptAreaRec) return [];

    // Handling of IfcCompositeProfileDef (concatenates multiple sub-profiles)
    if (sweptAreaRec.type === 'IFCCOMPOSITEPROFILEDEF') {
      const profilesParam = sweptAreaRec.params[2];
      const pList = Array.isArray(profilesParam)
        ? profilesParam
        : (profilesParam && typeof profilesParam === 'object' && 'ref' in profilesParam ? [profilesParam] : []);
      const results: Array<{ outer: { x: number; y: number }[]; inners: { x: number; y: number }[][] }> = [];
      for (const pRef of pList) {
        if (pRef && typeof pRef === 'object' && 'ref' in pRef) {
          const subLoops = this.extractProfileLoops2D(pRef.ref, visited);
          for (const loop of subLoops) {
            results.push(loop);
          }
        }
      }
      return results;
    }

    // Handling of IfcDerivedProfileDef (2D transformation over base profile)
    if (sweptAreaRec.type === 'IFCDERIVEDPROFILEDEF') {
      const parentRef = sweptAreaRec.params[2];
      const opRef = sweptAreaRec.params[3];
      if (!parentRef || typeof parentRef !== 'object' || !('ref' in parentRef)) return [];

      const baseLoops = this.extractProfileLoops2D(parentRef.ref, visited);
      if (baseLoops.length === 0) return [];

      let mat2D = new THREE.Matrix4();
      let isReflected = false;

      if (opRef && typeof opRef === 'object' && 'ref' in opRef) {
        const opRec = this.records.get(opRef.ref);
        if (opRec) {
          mat2D = this.resolveCartesianTransformationOperator(opRec);
          const e = mat2D.elements;
          // 2D determinant in XY plane: e[0]*e[5] - e[1]*e[4]
          const det2D = e[0] * e[5] - e[1] * e[4];
          if (det2D < 0) {
            isReflected = true;
          }
        }
      }

      const transformPoint = (p: { x: number; y: number }): { x: number; y: number } => {
        const v = new THREE.Vector3(p.x, p.y, 0).applyMatrix4(mat2D);
        return { x: v.x, y: v.y };
      };

      const transformedLoops: Array<{ outer: { x: number; y: number }[]; inners: { x: number; y: number }[][] }> = [];
      for (const loop of baseLoops) {
        let newOuter = loop.outer.map(transformPoint);
        if (isReflected) newOuter.reverse();

        const newInners: { x: number; y: number }[][] = [];
        for (const inner of loop.inners) {
          let tInner = inner.map(transformPoint);
          if (isReflected) tInner.reverse();
          newInners.push(tInner);
        }
        transformedLoops.push({ outer: newOuter, inners: newInners });
      }
      return transformedLoops;
    }

    let profile2DPoints: { x: number; y: number }[] = [];
    const inner2DLoops: { x: number; y: number }[][] = [];
    let isParameterizedProfile = false;

    // Parameterized and standard profiles
    if (sweptAreaRec.type === 'IFCRECTANGLEPROFILEDEF') {
      isParameterizedProfile = true;
      const rawX = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 1.0;
      const rawY = typeof sweptAreaRec.params[4] === 'number' ? sweptAreaRec.params[4] : parseFloat(String(sweptAreaRec.params[4])) || 1.0;
      const hx = (rawX * this.lengthUnitScale) / 2;
      const hy = (rawY * this.lengthUnitScale) / 2;
      profile2DPoints = [
        { x: -hx, y: -hy },
        { x: hx, y: -hy },
        { x: hx, y: hy },
        { x: -hx, y: hy },
      ];
    } else if (sweptAreaRec.type === 'IFCCIRCLEPROFILEDEF') {
      isParameterizedProfile = true;
      const rawRadius = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 0.5;
      const radius = rawRadius * this.lengthUnitScale;
      const SEGMENTS = 24;
      for (let i = 0; i < SEGMENTS; i++) {
        const theta = (i / SEGMENTS) * Math.PI * 2;
        profile2DPoints.push({ x: radius * Math.cos(theta), y: radius * Math.sin(theta) });
      }
    } else if (sweptAreaRec.type === 'IFCCIRCLEHOLLOWPROFILEDEF') {
      isParameterizedProfile = true;
      const rawRadius = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 0.5;
      const rawWallThickness = typeof sweptAreaRec.params[4] === 'number' ? sweptAreaRec.params[4] : parseFloat(String(sweptAreaRec.params[4])) || 0.05;
      const outerRadius = rawRadius * this.lengthUnitScale;
      const wallThickness = rawWallThickness * this.lengthUnitScale;
      const innerRadius = Math.max(0, outerRadius - wallThickness);
      const SEGMENTS = 24;
      for (let i = 0; i < SEGMENTS; i++) {
        const theta = (i / SEGMENTS) * Math.PI * 2;
        profile2DPoints.push({ x: outerRadius * Math.cos(theta), y: outerRadius * Math.sin(theta) });
      }
      if (innerRadius > GeometryTolerance.COINCIDENT_POINT) {
        const innerLoop: { x: number; y: number }[] = [];
        for (let i = 0; i < SEGMENTS; i++) {
          const theta = (i / SEGMENTS) * Math.PI * 2;
          innerLoop.push({ x: innerRadius * Math.cos(theta), y: innerRadius * Math.sin(theta) });
        }
        if (PolygonClipping.signedArea2D(innerLoop) < 0) innerLoop.reverse();
        inner2DLoops.push(innerLoop);
      }
    } else if (sweptAreaRec.type === 'IFCRECTANGLEHOLLOWPROFILEDEF') {
      isParameterizedProfile = true;
      const rawX = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 1.0;
      const rawY = typeof sweptAreaRec.params[4] === 'number' ? sweptAreaRec.params[4] : parseFloat(String(sweptAreaRec.params[4])) || 1.0;
      const rawWallThickness = typeof sweptAreaRec.params[5] === 'number' ? sweptAreaRec.params[5] : parseFloat(String(sweptAreaRec.params[5])) || 0.05;
      const xDim = rawX * this.lengthUnitScale;
      const yDim = rawY * this.lengthUnitScale;
      const wallThickness = rawWallThickness * this.lengthUnitScale;
      const hx = xDim / 2;
      const hy = yDim / 2;
      profile2DPoints = [
        { x: -hx, y: -hy },
        { x: hx, y: -hy },
        { x: hx, y: hy },
        { x: -hx, y: hy },
      ];
      const innerX = Math.max(0, xDim - 2 * wallThickness);
      const innerY = Math.max(0, yDim - 2 * wallThickness);
      if (innerX > GeometryTolerance.COINCIDENT_POINT && innerY > GeometryTolerance.COINCIDENT_POINT) {
        const ihx = innerX / 2;
        const ihy = innerY / 2;
        const innerLoop = [
          { x: -ihx, y: -ihy },
          { x: ihx, y: -ihy },
          { x: ihx, y: ihy },
          { x: -ihx, y: ihy },
        ];
        if (PolygonClipping.signedArea2D(innerLoop) < 0) innerLoop.reverse();
        inner2DLoops.push(innerLoop);
      }
    } else if (sweptAreaRec.type === 'IFCISHAPEPROFILEDEF') {
      isParameterizedProfile = true;
      const rawWidth = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 0.3;
      const rawDepth = typeof sweptAreaRec.params[4] === 'number' ? sweptAreaRec.params[4] : parseFloat(String(sweptAreaRec.params[4])) || 0.3;
      const rawWebThickness = typeof sweptAreaRec.params[5] === 'number' ? sweptAreaRec.params[5] : parseFloat(String(sweptAreaRec.params[5])) || 0.01;
      const rawFlangeThickness = typeof sweptAreaRec.params[6] === 'number' ? sweptAreaRec.params[6] : parseFloat(String(sweptAreaRec.params[6])) || 0.02;
      const b = rawWidth * this.lengthUnitScale;
      const h = rawDepth * this.lengthUnitScale;
      const tw = rawWebThickness * this.lengthUnitScale;
      const tf = rawFlangeThickness * this.lengthUnitScale;
      const w2 = b / 2;
      const d2 = h / 2;
      const tw2 = tw / 2;
      const yFlangeBot = -d2 + tf;
      const yFlangeTop = d2 - tf;
      profile2DPoints = [
        { x: -w2, y: -d2 },
        { x: w2, y: -d2 },
        { x: w2, y: yFlangeBot },
        { x: tw2, y: yFlangeBot },
        { x: tw2, y: yFlangeTop },
        { x: w2, y: yFlangeTop },
        { x: w2, y: d2 },
        { x: -w2, y: d2 },
        { x: -w2, y: yFlangeTop },
        { x: -tw2, y: yFlangeTop },
        { x: -tw2, y: yFlangeBot },
        { x: -w2, y: yFlangeBot },
      ];
    } else if (sweptAreaRec.type === 'IFCLSHAPEPROFILEDEF') {
      isParameterizedProfile = true;
      const rawDepth = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 0.1;
      const rawWidth = typeof sweptAreaRec.params[4] === 'number' ? sweptAreaRec.params[4] : parseFloat(String(sweptAreaRec.params[4])) || rawDepth;
      const rawThickness = typeof sweptAreaRec.params[5] === 'number' ? sweptAreaRec.params[5] : parseFloat(String(sweptAreaRec.params[5])) || 0.01;
      const h = rawDepth * this.lengthUnitScale;
      const b = rawWidth * this.lengthUnitScale;
      const t = Math.min(rawThickness * this.lengthUnitScale, Math.min(h, b) * 0.9);
      const h2 = h / 2;
      const b2 = b / 2;
      profile2DPoints = [
        { x: -b2, y: -h2 },
        { x: b2, y: -h2 },
        { x: b2, y: -h2 + t },
        { x: -b2 + t, y: -h2 + t },
        { x: -b2 + t, y: h2 },
        { x: -b2, y: h2 },
      ];
    } else if (sweptAreaRec.type === 'IFCTSHAPEPROFILEDEF') {
      isParameterizedProfile = true;
      const rawDepth = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 0.1;
      const rawFlangeWidth = typeof sweptAreaRec.params[4] === 'number' ? sweptAreaRec.params[4] : parseFloat(String(sweptAreaRec.params[4])) || 0.1;
      const rawWebThickness = typeof sweptAreaRec.params[5] === 'number' ? sweptAreaRec.params[5] : parseFloat(String(sweptAreaRec.params[5])) || 0.01;
      const rawFlangeThickness = typeof sweptAreaRec.params[6] === 'number' ? sweptAreaRec.params[6] : parseFloat(String(sweptAreaRec.params[6])) || 0.01;
      const h = rawDepth * this.lengthUnitScale;
      const b = rawFlangeWidth * this.lengthUnitScale;
      const tw = rawWebThickness * this.lengthUnitScale;
      const tf = rawFlangeThickness * this.lengthUnitScale;
      const h2 = h / 2;
      const b2 = b / 2;
      const w2 = tw / 2;
      profile2DPoints = [
        { x: -w2, y: -h2 },
        { x: w2, y: -h2 },
        { x: w2, y: h2 - tf },
        { x: b2, y: h2 - tf },
        { x: b2, y: h2 },
        { x: -b2, y: h2 },
        { x: -b2, y: h2 - tf },
        { x: -w2, y: h2 - tf },
      ];
    } else if (sweptAreaRec.type === 'IFCUSHAPEPROFILEDEF') {
      isParameterizedProfile = true;
      const rawDepth = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 0.1;
      const rawFlangeWidth = typeof sweptAreaRec.params[4] === 'number' ? sweptAreaRec.params[4] : parseFloat(String(sweptAreaRec.params[4])) || 0.05;
      const rawWebThickness = typeof sweptAreaRec.params[5] === 'number' ? sweptAreaRec.params[5] : parseFloat(String(sweptAreaRec.params[5])) || 0.01;
      const rawFlangeThickness = typeof sweptAreaRec.params[6] === 'number' ? sweptAreaRec.params[6] : parseFloat(String(sweptAreaRec.params[6])) || 0.01;
      const h = rawDepth * this.lengthUnitScale;
      const b = rawFlangeWidth * this.lengthUnitScale;
      const tw = rawWebThickness * this.lengthUnitScale;
      const tf = rawFlangeThickness * this.lengthUnitScale;
      const h2 = h / 2;
      const b2 = b / 2;
      profile2DPoints = [
        { x: -b2, y: -h2 },
        { x: b2, y: -h2 },
        { x: b2, y: -h2 + tf },
        { x: -b2 + tw, y: -h2 + tf },
        { x: -b2 + tw, y: h2 - tf },
        { x: b2, y: h2 - tf },
        { x: b2, y: h2 },
        { x: -b2, y: h2 },
      ];
    } else if (sweptAreaRec.type === 'IFCCSHAPEPROFILEDEF') {
      isParameterizedProfile = true;
      const rawDepth = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 0.1;
      const rawWidth = typeof sweptAreaRec.params[4] === 'number' ? sweptAreaRec.params[4] : parseFloat(String(sweptAreaRec.params[4])) || 0.05;
      const rawWallThickness = typeof sweptAreaRec.params[5] === 'number' ? sweptAreaRec.params[5] : parseFloat(String(sweptAreaRec.params[5])) || 0.005;
      const rawGirth = typeof sweptAreaRec.params[6] === 'number' ? sweptAreaRec.params[6] : parseFloat(String(sweptAreaRec.params[6])) || 0.015;
      const h = rawDepth * this.lengthUnitScale;
      const b = rawWidth * this.lengthUnitScale;
      const t = rawWallThickness * this.lengthUnitScale;
      const g = rawGirth * this.lengthUnitScale;
      const h2 = h / 2;
      const b2 = b / 2;

      if (g <= t + GeometryTolerance.COINCIDENT_POINT) {
        // Cleanly degrades to U-channel
        profile2DPoints = [
          { x: -b2, y: -h2 },
          { x: b2, y: -h2 },
          { x: b2, y: -h2 + t },
          { x: -b2 + t, y: -h2 + t },
          { x: -b2 + t, y: h2 - t },
          { x: b2, y: h2 - t },
          { x: b2, y: h2 },
          { x: -b2, y: h2 },
        ];
      } else {
        // 12-vertex C-purlin profile with stiffener lips
        profile2DPoints = [
          { x: -b2, y: -h2 },
          { x: b2, y: -h2 },
          { x: b2, y: -h2 + g },
          { x: b2 - t, y: -h2 + g },
          { x: b2 - t, y: -h2 + t },
          { x: -b2 + t, y: -h2 + t },
          { x: -b2 + t, y: h2 - t },
          { x: b2 - t, y: h2 - t },
          { x: b2 - t, y: h2 - g },
          { x: b2, y: h2 - g },
          { x: b2, y: h2 },
          { x: -b2, y: h2 },
        ];
      }
    } else if (sweptAreaRec.type === 'IFCZSHAPEPROFILEDEF') {
      isParameterizedProfile = true;
      const rawDepth = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 0.1;
      const rawFlangeWidth = typeof sweptAreaRec.params[4] === 'number' ? sweptAreaRec.params[4] : parseFloat(String(sweptAreaRec.params[4])) || 0.05;
      const rawWebThickness = typeof sweptAreaRec.params[5] === 'number' ? sweptAreaRec.params[5] : parseFloat(String(sweptAreaRec.params[5])) || 0.01;
      const rawFlangeThickness = typeof sweptAreaRec.params[6] === 'number' ? sweptAreaRec.params[6] : parseFloat(String(sweptAreaRec.params[6])) || 0.01;
      const h = rawDepth * this.lengthUnitScale;
      const b = rawFlangeWidth * this.lengthUnitScale;
      const tw = rawWebThickness * this.lengthUnitScale;
      const tf = rawFlangeThickness * this.lengthUnitScale;
      const h2 = h / 2;
      const w2 = tw / 2;
      profile2DPoints = [
        { x: -b + w2, y: -h2 },
        { x: w2, y: -h2 },
        { x: w2, y: h2 - tf },
        { x: b + w2, y: h2 - tf },
        { x: b + w2, y: h2 },
        { x: -w2, y: h2 },
        { x: -w2, y: -h2 + tf },
        { x: -b + w2, y: -h2 + tf },
      ];
    } else if (sweptAreaRec.type === 'IFCTRAPEZIUMPROFILEDEF') {
      isParameterizedProfile = true;
      const rawBottom = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 0.2;
      const rawTop = typeof sweptAreaRec.params[4] === 'number' ? sweptAreaRec.params[4] : parseFloat(String(sweptAreaRec.params[4])) || 0.1;
      const rawYDim = typeof sweptAreaRec.params[5] === 'number' ? sweptAreaRec.params[5] : parseFloat(String(sweptAreaRec.params[5])) || 0.2;
      const rawOffset = typeof sweptAreaRec.params[6] === 'number' ? sweptAreaRec.params[6] : parseFloat(String(sweptAreaRec.params[6])) || 0.0;
      const bBot = rawBottom * this.lengthUnitScale;
      const bTop = rawTop * this.lengthUnitScale;
      const yDim = rawYDim * this.lengthUnitScale;
      const offset = rawOffset * this.lengthUnitScale;
      const h2 = yDim / 2;
      const x0 = -bBot / 2;
      const x1 = bBot / 2;
      const xtl = x0 + offset;
      const xtr = xtl + bTop;
      profile2DPoints = [
        { x: x0, y: -h2 },
        { x: x1, y: -h2 },
        { x: xtr, y: h2 },
        { x: xtl, y: h2 },
      ];
    } else if (sweptAreaRec.type === 'IFCELLIPSEPROFILEDEF') {
      isParameterizedProfile = true;
      const rawRx = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 0.2;
      const rawRy = typeof sweptAreaRec.params[4] === 'number' ? sweptAreaRec.params[4] : parseFloat(String(sweptAreaRec.params[4])) || 0.1;
      const rx = Math.abs(rawRx) * this.lengthUnitScale;
      const ry = Math.abs(rawRy) * this.lengthUnitScale;
      const SEGMENTS = 24;
      for (let i = 0; i < SEGMENTS; i++) {
        const theta = (i / SEGMENTS) * Math.PI * 2;
        profile2DPoints.push({ x: rx * Math.cos(theta), y: ry * Math.sin(theta) });
      }
    } else if (sweptAreaRec.type === 'IFCASYMMETRICISHAPEPROFILEDEF') {
      isParameterizedProfile = true;
      const rawBotWidth = typeof sweptAreaRec.params[3] === 'number' ? sweptAreaRec.params[3] : parseFloat(String(sweptAreaRec.params[3])) || 0.3;
      const rawDepth = typeof sweptAreaRec.params[4] === 'number' ? sweptAreaRec.params[4] : parseFloat(String(sweptAreaRec.params[4])) || 0.3;
      const rawWebThickness = typeof sweptAreaRec.params[5] === 'number' ? sweptAreaRec.params[5] : parseFloat(String(sweptAreaRec.params[5])) || 0.01;
      const rawBotFlangeThickness = typeof sweptAreaRec.params[6] === 'number' ? sweptAreaRec.params[6] : parseFloat(String(sweptAreaRec.params[6])) || 0.02;
      const rawTopWidth = typeof sweptAreaRec.params[8] === 'number' ? sweptAreaRec.params[8] : parseFloat(String(sweptAreaRec.params[8])) || rawBotWidth;
      const rawTopFlangeThickness = typeof sweptAreaRec.params[9] === 'number' ? sweptAreaRec.params[9] : parseFloat(String(sweptAreaRec.params[9])) || rawBotFlangeThickness;
      const bb = rawBotWidth * this.lengthUnitScale;
      const bt = rawTopWidth * this.lengthUnitScale;
      const h = rawDepth * this.lengthUnitScale;
      const tw = rawWebThickness * this.lengthUnitScale;
      const tfb = rawBotFlangeThickness * this.lengthUnitScale;
      const tft = rawTopFlangeThickness * this.lengthUnitScale;
      const bb2 = bb / 2;
      const bt2 = bt / 2;
      const d2 = h / 2;
      const tw2 = tw / 2;
      const yBotFlange = -d2 + tfb;
      const yTopFlange = d2 - tft;
      profile2DPoints = [
        { x: -bb2, y: -d2 },
        { x: bb2, y: -d2 },
        { x: bb2, y: yBotFlange },
        { x: tw2, y: yBotFlange },
        { x: tw2, y: yTopFlange },
        { x: bt2, y: yTopFlange },
        { x: bt2, y: d2 },
        { x: -bt2, y: d2 },
        { x: -bt2, y: yTopFlange },
        { x: -tw2, y: yTopFlange },
        { x: -tw2, y: yBotFlange },
        { x: -bb2, y: yBotFlange },
      ];
    } else if (sweptAreaRec.type === 'IFCARBITRARYCLOSEDPROFILEDEF' || sweptAreaRec.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS') {
      const curveParam = sweptAreaRec.params[2];
      if (curveParam && typeof curveParam === 'object' && 'ref' in curveParam) {
        profile2DPoints = this.extract2DCurvePoints((curveParam as any).ref);
      }
      if (sweptAreaRec.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS') {
        const innersParam = sweptAreaRec.params[3];
        const innerItems = Array.isArray(innersParam)
          ? innersParam
          : (innersParam && typeof innersParam === 'object' && 'ref' in innersParam ? [innersParam] : []);
        for (const item of innerItems) {
          if (item && typeof item === 'object' && 'ref' in item) {
            const hPts = this.extract2DCurvePoints(item.ref);
            if (hPts.length >= 3) {
              if (hPts.length >= 4) {
                const first = hPts[0];
                const last = hPts[hPts.length - 1];
                if (Math.hypot(first.x - last.x, first.y - last.y) < GeometryTolerance.COINCIDENT_POINT) {
                  hPts.pop();
                }
              }
              if (hPts.length >= 3) {
                if (PolygonClipping.signedArea2D(hPts) < 0) {
                  hPts.reverse();
                }
                inner2DLoops.push(hPts);
              }
            }
          }
        }
      }
    } else {
      const msg = `Unsupported IfcProfileDef type: #${sweptAreaRec.id} (${sweptAreaRec.type})`;
      console.warn(`[IfcStepImporter] ${msg}`);
      this.importWarnings.push(msg);
      return [];
    }

    if (isParameterizedProfile) {
      // Apply Position 2D (IFCAXIS2PLACEMENT2D) if present
      const pos2DParam = sweptAreaRec.params[2];
      if (pos2DParam && typeof pos2DParam === 'object' && 'ref' in pos2DParam) {
        const pos2DRec = this.records.get(pos2DParam.ref);
        if (pos2DRec && pos2DRec.type === 'IFCAXIS2PLACEMENT2D') {
          const t2d = this.resolveAxis2Placement2D(pos2DRec);
          profile2DPoints = profile2DPoints.map((p) => ({
            x: t2d.origin.x + p.x * t2d.dirX.x + p.y * t2d.dirY.x,
            y: t2d.origin.y + p.x * t2d.dirX.y + p.y * t2d.dirY.y,
          }));
          for (let k = 0; k < inner2DLoops.length; k++) {
            inner2DLoops[k] = inner2DLoops[k].map((p) => ({
              x: t2d.origin.x + p.x * t2d.dirX.x + p.y * t2d.dirY.x,
              y: t2d.origin.y + p.x * t2d.dirX.y + p.y * t2d.dirY.y,
            }));
          }
        }
      }
    }

    if (profile2DPoints.length >= 4) {
      const first = profile2DPoints[0];
      const last = profile2DPoints[profile2DPoints.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < GeometryTolerance.COINCIDENT_POINT) {
        profile2DPoints.pop();
      }
    }
    if (profile2DPoints.length >= 3 && PolygonClipping.signedArea2D(profile2DPoints) < 0) {
      profile2DPoints.reverse();
    }

    if (profile2DPoints.length < 3) return [];

    return [{ outer: profile2DPoints, inners: inner2DLoops }];
  }

  /**
   * Resolves the 4x4 matrix of an IfcCartesianTransformationOperator3D or 2D with strict fallbacks.
   */
  private resolveCartesianTransformationOperator(opRec: StepRecord): THREE.Matrix4 {
    const mat = new THREE.Matrix4();
    if (
      opRec.type !== 'IFCCARTESIANTRANSFORMATIONOPERATOR3D' &&
      opRec.type !== 'IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM' &&
      opRec.type !== 'IFCCARTESIANTRANSFORMATIONOPERATOR2D' &&
      opRec.type !== 'IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM'
    ) {
      return mat;
    }

    // params[0]: Axis1 (IFCDIRECTION or null) -> u (default: 1, 0, 0)
    // params[1]: Axis2 (IFCDIRECTION or null) -> v (default: 0, 1, 0)
    // params[2]: LocalOrigin (IFCCARTESIANPOINT) -> t (default: 0, 0, 0)
    // params[3]: Scale (REAL or null) -> s (default: 1.0)
    // params[4]: Axis3 (IFCDIRECTION or null) -> w (default: u x v)

    let u = new THREE.Vector3(1, 0, 0);
    let v = new THREE.Vector3(0, 1, 0);
    let w = new THREE.Vector3(0, 0, 1);
    let t = new THREE.Vector3(0, 0, 0);

    const axis1Param = opRec.params[0];
    if (axis1Param && typeof axis1Param === 'object' && 'ref' in axis1Param) {
      const dirRec = this.records.get(axis1Param.ref);
      if (dirRec && Array.isArray(dirRec.params[0])) {
        const d = dirRec.params[0].map((n: any) => typeof n === 'number' ? n : parseFloat(String(n)) || 0);
        if (d.length >= 3) u.set(d[0], d[1], d[2]).normalize();
        else if (d.length === 2) u.set(d[0], d[1], 0).normalize();
      }
    }

    const axis2Param = opRec.params[1];
    if (axis2Param && typeof axis2Param === 'object' && 'ref' in axis2Param) {
      const dirRec = this.records.get(axis2Param.ref);
      if (dirRec && Array.isArray(dirRec.params[0])) {
        const d = dirRec.params[0].map((n: any) => typeof n === 'number' ? n : parseFloat(String(n)) || 0);
        if (d.length >= 3) v.set(d[0], d[1], d[2]).normalize();
        else if (d.length === 2) v.set(d[0], d[1], 0).normalize();
      }
    }

    const originParam = opRec.params[2];
    if (originParam && typeof originParam === 'object' && 'ref' in originParam) {
      const ptRec = this.records.get(originParam.ref);
      if (ptRec && Array.isArray(ptRec.params[0])) {
        const p = ptRec.params[0].map((n: any) =>
          (typeof n === 'number' ? n : parseFloat(String(n)) || 0) * this.lengthUnitScale
        );
        if (p.length >= 3) t.set(p[0], p[1], p[2]);
        else if (p.length === 2) t.set(p[0], p[1], 0);
      }
    }

    const scale1Param = opRec.params[3];
    const s1 = typeof scale1Param === 'number' ? scale1Param : parseFloat(String(scale1Param || 1)) || 1.0;

    const is3D = opRec.type.startsWith('IFCCARTESIANTRANSFORMATIONOPERATOR3D');
    if (is3D) {
      const axis3Param = opRec.params[4];
      if (axis3Param && typeof axis3Param === 'object' && 'ref' in axis3Param) {
        const dirRec = this.records.get(axis3Param.ref);
        if (dirRec && Array.isArray(dirRec.params[0])) {
          const d = dirRec.params[0].map((n: any) => typeof n === 'number' ? n : parseFloat(String(n)) || 0);
          if (d.length >= 3) w.set(d[0], d[1], d[2]).normalize();
        }
      } else {
        w.crossVectors(u, v).normalize();
      }
    } else {
      w.set(0, 0, 1);
    }

    const s2Param = opRec.params[5];
    const s2 = typeof s2Param === 'number' ? s2Param : (parseFloat(String(s2Param)) || s1);
    const s3Param = opRec.params[6];
    const s3 = typeof s3Param === 'number' ? s3Param : (parseFloat(String(s3Param)) || s1);

    u.multiplyScalar(s1);
    v.multiplyScalar(s2);
    w.multiplyScalar(s3);

    mat.makeBasis(u, v, w);
    mat.setPosition(t);
    return mat;
  }

  /**
   * Determines whether an IfcShapeRepresentation is a non-solid auxiliary representation
   * (such as BoundingBox, Axis, FootPrint, Curve2D, or Annotation) that must be excluded
   * from 3D B-Rep / surface body extraction.
   */
  private isNonBodyShapeRepresentation(repRec: StepRecord): boolean {
    const repIdentifier = (this.getParamString(repRec.params[1]) || '').toUpperCase();
    const repType = (this.getParamString(repRec.params[2]) || '').toUpperCase();
    if (
      repIdentifier === 'AXIS' ||
      repIdentifier === 'FOOTPRINT' ||
      repIdentifier === 'BOX' ||
      repIdentifier === 'ANNOTATION' ||
      repIdentifier === 'CLEARANCE' ||
      repIdentifier === 'LIGHTING'
    ) {
      return true;
    }
    if (
      repType === 'BOUNDINGBOX' ||
      repType === 'CURVE2D' ||
      repType === 'ANNOTATION2D' ||
      repType === 'GEOMETRICCURVESET'
    ) {
      return true;
    }
    return false;
  }

  /**
   * Resolves the target IfcRepresentationMap ID and combined local transformation matrix
   * M_local = M_operator * M_mapOrigin^-1 for an IfcMappedItem record.
   */
  private resolveMappedItemInfo(
    rec: StepRecord
  ): { mapRecId: number; shapeRepRec: StepRecord; mLocal: THREE.Matrix4 } | null {
    const sourceRef = rec.params[0];
    const targetRef = rec.params[1];

    if (!sourceRef || typeof sourceRef !== 'object' || !('ref' in sourceRef)) return null;
    const mapRec = this.records.get(sourceRef.ref);
    if (!mapRec || mapRec.type !== 'IFCREPRESENTATIONMAP') return null;

    const mappedRepRef = mapRec.params[1];
    if (!mappedRepRef || typeof mappedRepRef !== 'object' || !('ref' in mappedRepRef)) return null;

    const shapeRepRec = this.records.get(mappedRepRef.ref);
    if (!shapeRepRec) return null;

    let mMapOrigin = new THREE.Matrix4();
    const mapOriginParam = mapRec.params[0];
    if (typeof mapOriginParam === 'string' && mapOriginParam.startsWith('#')) {
      const originId = parseInt(mapOriginParam.slice(1), 10);
      const originRec = this.records.get(originId);
      if (originRec && originRec.type === 'IFCAXIS2PLACEMENT3D') {
        mMapOrigin = this.resolveAxis2Placement3D(originRec);
      }
    } else if (mapOriginParam && typeof mapOriginParam === 'object' && 'ref' in mapOriginParam) {
      const originRec = this.records.get(mapOriginParam.ref);
      if (originRec && originRec.type === 'IFCAXIS2PLACEMENT3D') {
        mMapOrigin = this.resolveAxis2Placement3D(originRec);
      }
    }
    const mMapOriginInv = new THREE.Matrix4().copy(mMapOrigin).invert();

    let mOperator = new THREE.Matrix4();
    if (targetRef && typeof targetRef === 'object' && 'ref' in targetRef) {
      const opRec = this.records.get(targetRef.ref);
      if (opRec) {
        mOperator = this.resolveCartesianTransformationOperator(opRec);
      }
    }

    const mLocal = new THREE.Matrix4().multiplyMatrices(mOperator, mMapOriginInv);
    return { mapRecId: mapRec.id, shapeRepRec, mLocal };
  }

  /**
   * Reconstructs the exhaustive list of sub-meshes from an IfcMappedItem (component instance)
   * applying the complete affine transformation M_local = M_operator * M_mapOrigin^-1 over all its items.
   */
  private rebuildSubMeshesFromMappedItem(
    rec: StepRecord,
    baseEntityId: string,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>,
    visited: Set<number> = new Set<number>()
  ): { mesh: PolyMesh; itemId: number; materialId?: string }[] {
    const result: { mesh: PolyMesh; itemId: number; materialId?: string }[] = [];
    const mappedInfo = this.resolveMappedItemInfo(rec);
    if (!mappedInfo) return result;

    const { shapeRepRec, mLocal } = mappedInfo;
    const geomItems = shapeRepRec.params[3];
    if (!Array.isArray(geomItems) || geomItems.length === 0) return result;

    const mappedItemStyleId = itemToStyleMap?.get(rec.id);
    const repStyleId = itemToStyleMap?.get(shapeRepRec.id) || mappedItemStyleId;

    for (const item of geomItems) {
      if (!item || typeof item !== 'object' || !('ref' in item)) continue;
      const gRec = this.records.get(item.ref);
      if (gRec && gRec.type === 'IFCBOUNDINGBOX') continue;
      const subMesh = this.rebuildMeshFromItem(item.ref, baseEntityId, itemToStyleMap, faceToStyleMap, visited);
      if (subMesh) {
        // Apply local transformation mLocal to vertices and hole loops
        for (const v of subMesh.vertices.values()) {
          const p = new THREE.Vector3(v.position.x, v.position.y, v.position.z).applyMatrix4(mLocal);
          v.position = new Vec3(p.x, p.y, p.z);
        }
        for (const f of subMesh.faces.values()) {
          if (f.holes && f.holes.length > 0) {
            f.holes = f.holes.map((loop) =>
              loop.map((pt) => {
                const p = new THREE.Vector3(pt.x, pt.y, pt.z).applyMatrix4(mLocal);
                return new Vec3(p.x, p.y, p.z);
              })
            );
          }
        }

        const subItemStyleId = itemToStyleMap?.get(item.ref) || repStyleId;
        if (subItemStyleId) {
          for (const f of subMesh.faces.values()) {
            if (!f.materialId) f.materialId = subItemStyleId;
          }
        }

        result.push({ mesh: subMesh, itemId: item.ref, materialId: subItemStyleId });
      }
    }

    return result;
  }

  /**
   * Reconstructs a unified PolyMesh from an IfcMappedItem, merging all constituent solids
   * when the underlying IfcRepresentationMap contains multiple geometric items.
   */
  private rebuildFromMappedItem(
    rec: StepRecord,
    entityId: string,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>,
    visited: Set<number> = new Set<number>()
  ): PolyMesh | null {
    const subMeshes = this.rebuildSubMeshesFromMappedItem(rec, entityId, itemToStyleMap, faceToStyleMap, visited);
    if (subMeshes.length === 0) return null;
    if (subMeshes.length === 1) return subMeshes[0].mesh;

    const combinedMesh = new PolyMesh(entityId);
    for (const sm of subMeshes) {
      for (const face of sm.mesh.faces.values()) {
        const positions = face.getPositions();
        if (positions.length >= 3) {
          const addedFace = combinedMesh.addFace(
            positions,
            face.normal,
            face.holes,
            face.holeOwners
          );
          const matId = face.materialId || sm.materialId;
          if (matId) {
            addedFace.materialId = matId;
          }
        }
      }
    }
    return combinedMesh.faces.size > 0 ? combinedMesh : null;
  }

  /**
   * Reconstructs a PolyMesh from an IfcPolygonalFaceSet.
   */
  private rebuildFromPolygonalFaceSet(rec: StepRecord, entityId: string): PolyMesh | null {
    // Param 0: Point list ref (IFCCARTESIANPOINTLIST3D)
    const pointListRef = rec.params[IFC_GEOM_ATTRS.POLYGONAL_COORDINATES];
    if (!pointListRef || typeof pointListRef !== 'object' || !('ref' in pointListRef)) {
      return null;
    }

    const pointListRec = this.records.get(pointListRef.ref);
    if (!pointListRec) return null;

    const points = this.extractPointList(pointListRec);
    if (points.length === 0) return null;

    // Param 2: List of face references (IFCINDEXEDPOLYGONALFACE / WITHVOIDS)
    const faceRefs = rec.params[IFC_GEOM_ATTRS.POLYGONAL_FACES];
    if (!Array.isArray(faceRefs)) return null;

    // Param 3: PnIndex (optional, 1-based, ISO 16739-1)
    const rawParam3 = rec.params[IFC_GEOM_ATTRS.POLYGONAL_PN_INDEX];
    const pnIndexRaw: StepParam[] | null = Array.isArray(rawParam3) ? rawParam3 : null;

    const resolvePoint = (oneBasedIdx: number): Vec3 | undefined => {
      let mappedIdx = oneBasedIdx;
      if (pnIndexRaw && oneBasedIdx >= 1 && oneBasedIdx <= pnIndexRaw.length) {
        const entry = pnIndexRaw[oneBasedIdx - 1];
        mappedIdx = typeof entry === 'number' ? entry : parseInt(String(entry), 10);
      }
      return points[mappedIdx - 1];
    };

    const polyMesh = new PolyMesh(entityId);

    for (const fRef of faceRefs) {
      if (!fRef || typeof fRef !== 'object' || !('ref' in fRef)) continue;
      const faceRec = this.records.get(fRef.ref);
      if (!faceRec) continue;

      if (faceRec.type === 'IFCINDEXEDPOLYGONALFACE') {
        const indices = faceRec.params[0];
        if (Array.isArray(indices)) {
          const facePositions = indices
            .map((idx: any) => {
              const num = typeof idx === 'number' ? idx : parseInt(String(idx), 10);
              return resolvePoint(num);
            })
            .filter((p): p is Vec3 => Boolean(p));

          if (facePositions.length >= 3) {
            polyMesh.addFace(facePositions);
          }
        }
      } else if (faceRec.type === 'IFCINDEXEDPOLYGONALFACEWITHVOIDS') {
        const outerIndices = faceRec.params[0];
        const innerIndicesList = faceRec.params[1];

        if (Array.isArray(outerIndices)) {
          const outerPositions = outerIndices
            .map((idx: any) => resolvePoint(typeof idx === 'number' ? idx : parseInt(String(idx), 10)))
            .filter((p): p is Vec3 => Boolean(p));

          const holePositions: Vec3[][] = [];
          if (Array.isArray(innerIndicesList)) {
            for (const holeIdxList of innerIndicesList) {
              if (Array.isArray(holeIdxList)) {
                const hPositions = holeIdxList
                  .map((idx: any) => resolvePoint(typeof idx === 'number' ? idx : parseInt(String(idx), 10)))
                  .filter((p): p is Vec3 => Boolean(p));
                if (hPositions.length >= 3) {
                  holePositions.push(hPositions);
                }
              }
            }
          }

          if (outerPositions.length >= 3) {
            polyMesh.addFace(outerPositions, undefined, holePositions);
          }
        }
      }
    }

    if (polyMesh.faces.size > 0) {
      polyMesh.resetVersion();
      return polyMesh;
    }
    return null;
  }

  /**
   * Reconstructs a PolyMesh from an IfcTriangulatedFaceSet (ISO 16739-1 / IFC 4.3).
   * Complies with:
   * - Rule 11: Deterministic filtering of degenerate and collapsed triangles.
   * - Rule 18 and 21: Formal resolution of CoordIndex attribute (params[3]) distinguishing it from PnIndex.
   * - Rule 22: Preservation of counter-clockwise (CCW) outward orientation.
   */
  private rebuildFromTriangulatedFaceSet(
    rec: StepRecord,
    entityId: string,
    coalesceFaces: boolean = false
  ): PolyMesh | null {
    const pointListRef = rec.params[0];
    if (!pointListRef || typeof pointListRef !== 'object' || !('ref' in pointListRef)) {
      return null;
    }

    const pointListRec = this.records.get(pointListRef.ref);
    if (!pointListRec) return null;

    const points = this.extractPointList(pointListRec);
    if (points.length === 0) return null;

    // In canonical IfcTriangulatedFaceSet (ISO 16739-1), attributes are:
    // 0: Coordinates (IfcCartesianPointList3D)
    // 1: Normals (optional)
    // 2: Closed (optional, boolean)
    // 3: CoordIndex (LIST [1:?] OF LIST [3:3] OF IfcPositiveInteger)
    // 4: PnIndex (optional, LIST [1:?] OF IfcPositiveInteger)
    let coordIndex: any = null;
    let pnIndexRaw: any = null;

    const candidate3 = rec.params[3];
    const candidate4 = rec.params[4];
    if (Array.isArray(candidate3) && candidate3.length > 0 && Array.isArray(candidate3[0])) {
      coordIndex = candidate3;
      if (Array.isArray(candidate4) && candidate4.length > 0 && !Array.isArray(candidate4[0])) {
        pnIndexRaw = candidate4;
      }
    } else if (Array.isArray(candidate4) && candidate4.length > 0 && Array.isArray(candidate4[0])) {
      coordIndex = candidate4;
      const candidate5 = rec.params[5];
      if (Array.isArray(candidate5) && candidate5.length > 0 && !Array.isArray(candidate5[0])) {
        pnIndexRaw = candidate5;
      } else if (Array.isArray(candidate3) && candidate3.length > 0 && !Array.isArray(candidate3[0])) {
        pnIndexRaw = candidate3;
      }
    }

    if (!coordIndex) return null;

    let maxCoordIndex = 0;
    for (const tri of coordIndex) {
      if (Array.isArray(tri)) {
        for (const idx of tri) {
          const num = typeof idx === 'number' ? idx : parseInt(String(idx), 10);
          if (num > maxCoordIndex) maxCoordIndex = num;
        }
      }
    }

    const isPointPnIndex = Array.isArray(pnIndexRaw) && pnIndexRaw.length >= maxCoordIndex;

    const resolvePoint = (oneBasedIdx: number): Vec3 | undefined => {
      if (isPointPnIndex && oneBasedIdx >= 1 && oneBasedIdx <= pnIndexRaw.length) {
        const entry = pnIndexRaw[oneBasedIdx - 1];
        const mappedIdx = typeof entry === 'number' ? entry : parseInt(String(entry), 10);
        return points[mappedIdx - 1];
      }
      return points[oneBasedIdx - 1];
    };

    const polyMesh = new PolyMesh(entityId);
    const seenTriangles = new Set<bigint>();

    const maxIndexLimit = isPointPnIndex ? pnIndexRaw.length : points.length;

    for (const tri of coordIndex) {
      if (!Array.isArray(tri) || tri.length < 3) continue;

      const idx0 = typeof tri[0] === 'number' ? tri[0] : parseInt(String(tri[0]), 10);
      const idx1 = typeof tri[1] === 'number' ? tri[1] : parseInt(String(tri[1]), 10);
      const idx2 = typeof tri[2] === 'number' ? tri[2] : parseInt(String(tri[2]), 10);

      if (
        isNaN(idx0) || isNaN(idx1) || isNaN(idx2) ||
        idx0 < 1 || idx1 < 1 || idx2 < 1 ||
        idx0 > maxIndexLimit || idx1 > maxIndexLimit || idx2 > maxIndexLimit
      ) {
        continue;
      }

      // Discard if index collapsed
      if (idx0 === idx1 || idx1 === idx2 || idx2 === idx0) continue;

      // Filter duplicate identical triangles in the same IfcTriangulatedFaceSet (Rule 11)
      let a = idx0;
      let b = idx1;
      let c = idx2;
      if (a > b) { const t = a; a = b; b = t; }
      if (b > c) { const t = b; b = c; c = t; }
      if (a > b) { const t = a; a = b; b = t; }

      const triSig = (BigInt(a) << 64n) | (BigInt(b) << 32n) | BigInt(c);
      if (seenTriangles.has(triSig)) {
        continue;
      }
      seenTriangles.add(triSig);

      const p0 = resolvePoint(idx0);
      const p1 = resolvePoint(idx1);
      const p2 = resolvePoint(idx2);

      if (!p0 || !p1 || !p2) continue;

      // Filter collapsed, collinear, or zero-area triangles (Rule 11)
      const v01 = p1.sub(p0);
      const v02 = p2.sub(p0);
      const cross = v01.cross(v02);
      const triArea = 0.5 * cross.length();
      if (triArea <= GeometryTolerance.MIN_FACE_AREA) {
        continue;
      }

      polyMesh.addFace([p0, p1, p2]);
    }

    if (polyMesh.faces.size > 0) {
      if (coalesceFaces) {
        // Coplanar coalescence to restore architectural n-gon polygons when explicitly requested (Paso 1.4 / JIT)
        polyMesh.coalesceCoplanarFaces();
      }
      polyMesh.resetVersion();
      return polyMesh;
    }
    return null;
  }

  /**
   * Extracts list of Vec3 points from an IFCCARTESIANPOINTLIST3D.
   */
  private extractPointList(rec: StepRecord): Vec3[] {
    const coords = rec.params[0];
    if (!Array.isArray(coords)) return [];

    const result: Vec3[] = [];
    for (const pt of coords) {
      if (Array.isArray(pt) && pt.length >= 3) {
        const x = (typeof pt[0] === 'number' ? pt[0] : parseFloat(String(pt[0]))) * this.lengthUnitScale;
        const y = (typeof pt[1] === 'number' ? pt[1] : parseFloat(String(pt[1]))) * this.lengthUnitScale;
        const z = (typeof pt[2] === 'number' ? pt[2] : parseFloat(String(pt[2]))) * this.lengthUnitScale;
        result.push(new Vec3(x, y, z));
      }
    }
    return result;
  }

  /**
   * Appends faces from an IfcConnectedFaceSet / IfcClosedShell / IfcOpenShell to the accumulator PolyMesh.
   * Filters degenerate loops and deduplicates points using GeometryTolerance.COINCIDENT_POINT (Rule 6, Rule 11).
   * Assigns styles and colors at face and element level according to IFCSTYLEDITEM.
   */
  private appendFacesFromConnectedFaceSet(
    shellRec: StepRecord,
    polyMesh: PolyMesh,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>,
    fallbackStyleId?: string
  ): number {
    // shellRec.params[0] is the list of references to IfcFace (CfsFaces - ISO 10303-42 / ISO 16739-1)
    const faceRefsParam = shellRec.params[0];
    const faceRefs = Array.isArray(faceRefsParam)
      ? faceRefsParam
      : (faceRefsParam && typeof faceRefsParam === 'object' && 'ref' in faceRefsParam ? [faceRefsParam] : []);
    if (faceRefs.length === 0) return 0;

    let facesAdded = 0;

    // Helper function to deduplicate collinear/coincident vertices and close polygon loops
    const cleanLoopPoints = (pts: Vec3[]): Vec3[] => {
      if (pts.length === 0) return [];
      const cleaned: Vec3[] = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].distanceTo(cleaned[cleaned.length - 1]) >= GeometryTolerance.COINCIDENT_POINT) {
          cleaned.push(pts[i]);
        }
      }
      // In STEP / ISO 10303-42, many exporters repeat the first vertex at the end to close the PolyLoop.
      // PolyMesh.addFace expects open loops where the last vertex implicitly connects to the first.
      if (
        cleaned.length > 1 &&
        cleaned[cleaned.length - 1].distanceTo(cleaned[0]) < GeometryTolerance.COINCIDENT_POINT
      ) {
        cleaned.pop();
      }
      return cleaned;
    };

    for (const fRef of faceRefs) {
      if (!fRef || typeof fRef !== 'object' || !('ref' in fRef)) continue;
      const faceRec = this.records.get(fRef.ref);
      if (!faceRec) continue;

      // faceRec.params[0] is the list of references to IfcFaceBound / IfcFaceOuterBound (Bounds)
      const boundRefsParam = faceRec.params[0];
      const boundRefs = Array.isArray(boundRefsParam)
        ? boundRefsParam
        : (boundRefsParam ? [boundRefsParam] : []);

      let outerLoop: Vec3[] | null = null;
      const innerHoles: Vec3[][] = [];

      // Detect if there is any explicit IFCFACEOUTERBOUND in face boundaries
      const hasOuterBound = boundRefs.some((r: any) => {
        if (!r || typeof r !== 'object' || !('ref' in r)) return false;
        const b = this.records.get(r.ref);
        return b?.type === 'IFCFACEOUTERBOUND';
      });

      for (const bRef of boundRefs) {
        if (!bRef || typeof bRef !== 'object' || !('ref' in bRef)) continue;
        const boundRec = this.records.get(bRef.ref);
        if (!boundRec) continue;

        // boundRec.params[0]: IfcLoop (typically IFCPOLYLOOP)
        // boundRec.params[1]: Orientation (BOOLEAN)
        const loopRef = boundRec.params[0];
        if (!loopRef || typeof loopRef !== 'object' || !('ref' in loopRef)) continue;
        const loopRec = this.records.get(loopRef.ref);
        if (!loopRec) continue;

        const rawPts: Vec3[] = [];
        if (loopRec.type === 'IFCPOLYLOOP') {
          const ptRefs = loopRec.params[0];
          if (Array.isArray(ptRefs)) {
            for (const ptRef of ptRefs) {
              if (!ptRef || typeof ptRef !== 'object' || !('ref' in ptRef)) continue;
              const ptRec = this.records.get(ptRef.ref);
              if (ptRec && ptRec.type === 'IFCCARTESIANPOINT' && Array.isArray(ptRec.params[0])) {
                const coords = ptRec.params[0].map((v: any) =>
                  (typeof v === 'number' ? v : parseFloat(String(v)) || 0) * this.lengthUnitScale
                );
                if (coords.length >= 3) {
                  rawPts.push(new Vec3(coords[0], coords[1], coords[2]));
                } else if (coords.length === 2) {
                  rawPts.push(new Vec3(coords[0], coords[1], 0));
                }
              }
            }
          }
        }

        const loopPts = cleanLoopPoints(rawPts);
        if (loopPts.length < 3) continue;

        // Verify geometric loop orientation
        const orientationParam = boundRec.params[1];
        let orientation = true;
        if (orientationParam === false) {
          orientation = false;
        } else if (
          typeof orientationParam === 'object' &&
          orientationParam !== null &&
          'enum' in orientationParam &&
          (orientationParam.enum === 'F' || orientationParam.enum === 'FALSE')
        ) {
          orientation = false;
        } else if (typeof orientationParam === 'string') {
          const s = orientationParam.toUpperCase();
          if (s === '.F.' || s === 'F' || s === 'FALSE' || s === '.FALSE.') {
            orientation = false;
          }
        }

        if (!orientation) {
          loopPts.reverse();
        }

        // Outer boundary vs inner voids classification
        const isOuter = boundRec.type === 'IFCFACEOUTERBOUND';
        if (isOuter && !outerLoop) {
          outerLoop = loopPts;
        } else if (!hasOuterBound && !outerLoop) {
          outerLoop = loopPts;
        } else {
          innerHoles.push(loopPts);
        }
      }

      if (outerLoop && outerLoop.length >= 3) {
        try {
          const face = polyMesh.addFace(
            outerLoop,
            undefined,
            innerHoles.length > 0 ? innerHoles : undefined
          );

          // Assign presentation material to the face
          const matId =
            (fRef && faceToStyleMap?.get(fRef.ref)) ||
            (fRef && itemToStyleMap?.get(fRef.ref)) ||
            fallbackStyleId;
          if (matId && face) {
            face.materialId = matId;
          }
          facesAdded++;
        } catch (err: any) {
          // Rule 13: Zero silent suppression of errors
          console.debug(`[IfcStepImporter] Face skipped due to topological degeneracy #${faceRec.id}: ${err?.message || err}`);
        }
      }
    }

    return facesAdded;
  }

  /**
   * Reconstructs a PolyMesh from an IfcFacetedBrep, IfcClosedShell, IfcOpenShell, or IfcConnectedFaceSet.
   * Filters degenerate loops and deduplicates points using GeometryTolerance.COINCIDENT_POINT (Rule 6).
   * Assigns styles and colors at face and element level according to IFCSTYLEDITEM.
   */
  private rebuildFromFacetedBrep(
    rec: StepRecord,
    entityId: string,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>
  ): PolyMesh | null {
    let shellRec: StepRecord | undefined;

    if (rec.type === 'IFCFACETEDBREP' || rec.type === 'IFCFACETEDBREPWITHVOIDS') {
      const shellRef = rec.params[IFC_GEOM_ATTRS.FACETED_BREP_OUTER];
      if (shellRef && typeof shellRef === 'object' && 'ref' in shellRef) {
        shellRec = this.records.get(shellRef.ref);
      }
    } else if (
      rec.type === 'IFCCLOSEDSHELL' ||
      rec.type === 'IFCOPENSHELL' ||
      rec.type === 'IFCCONNECTEDFACESET'
    ) {
      shellRec = rec;
    }

    if (!shellRec) return null;

    const polyMesh = new PolyMesh(entityId);
    const repStyleId = itemToStyleMap?.get(rec.id);
    let facesAdded = this.appendFacesFromConnectedFaceSet(
      shellRec,
      polyMesh,
      itemToStyleMap,
      faceToStyleMap,
      repStyleId
    );

    if (rec.type === 'IFCFACETEDBREPWITHVOIDS') {
      const voidsParam = rec.params[IFC_GEOM_ATTRS.FACETED_BREP_VOIDS];
      if (Array.isArray(voidsParam)) {
        for (const voidRef of voidsParam) {
          if (voidRef && typeof voidRef === 'object' && 'ref' in voidRef) {
            const voidShellRec = this.records.get(voidRef.ref);
            if (voidShellRec) {
              facesAdded += this.appendFacesFromConnectedFaceSet(
                voidShellRec,
                polyMesh,
                itemToStyleMap,
                faceToStyleMap,
                repStyleId
              );
            }
          }
        }
      }
    }

    if (facesAdded > 0 && polyMesh.faces.size > 0) {
      polyMesh.resetVersion();
      return polyMesh;
    }
    return null;
  }

  /**
   * Reconstructs a PolyMesh from an IfcFaceBasedSurfaceModel (ISO 16739-1 / IFC 4.3).
   * Extracts the collection of IfcConnectedFaceSet (rec.params[0]) and accumulates all its faces.
   * Complies with Rule 6, Rule 7, Rule 11, Rule 15, and Rule 21.
   */
  private rebuildFromFaceBasedSurfaceModel(
    rec: StepRecord,
    entityId: string,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>
  ): PolyMesh | null {
    const cfsListParam = rec.params[0];
    const cfsList = Array.isArray(cfsListParam)
      ? cfsListParam
      : (cfsListParam && typeof cfsListParam === 'object' && 'ref' in cfsListParam ? [cfsListParam] : []);
    if (cfsList.length === 0) return null;

    const polyMesh = new PolyMesh(entityId);
    const repStyleId = itemToStyleMap?.get(rec.id);
    let totalFaces = 0;

    for (const cfsRef of cfsList) {
      if (!cfsRef || typeof cfsRef !== 'object' || !('ref' in cfsRef)) continue;
      const cfsRec = this.records.get(cfsRef.ref);
      if (!cfsRec) continue;
      totalFaces += this.appendFacesFromConnectedFaceSet(
        cfsRec,
        polyMesh,
        itemToStyleMap,
        faceToStyleMap,
        repStyleId
      );
    }

    if (totalFaces > 0 && polyMesh.faces.size > 0) {
      polyMesh.resetVersion();
      return polyMesh;
    }
    return null;
  }

  /**
   * Resolves a 4x4 affine matrix from an IFCAXIS2PLACEMENT3D.
   * Applies buildingSMART standard directions by default (ISO 10303-42):
   * Axis = (0, 0, 1), RefDirection = (1, 0, 0).
   */
  private resolveAxis2Placement3D(rec: StepRecord): THREE.Matrix4 {
    const cached = this.axis2PlacementCache.get(rec.id);
    if (cached) {
      return cached.clone();
    }

    const loc = new THREE.Vector3(0, 0, 0);
    const dirZ = new THREE.Vector3(0, 0, 1);
    const dirX = new THREE.Vector3(1, 0, 0);

    // Param 0: Location (IFCCARTESIANPOINT)
    const locParam = rec.params[0];
    if (locParam && typeof locParam === 'object' && 'ref' in locParam) {
      const ptRec = this.records.get(locParam.ref);
      if (ptRec && Array.isArray(ptRec.params[0])) {
        const coords = ptRec.params[0].map((v: any) =>
          (typeof v === 'number' ? v : parseFloat(String(v)) || 0) * this.lengthUnitScale
        );
        if (coords.length >= 3) {
          loc.set(coords[0], coords[1], coords[2]);
        } else if (coords.length === 2) {
          loc.set(coords[0], coords[1], 0);
        }
      }
    }

    // Param 1: Axis (IFCDIRECTION)
    const axisParam = rec.params[1];
    if (axisParam && typeof axisParam === 'object' && 'ref' in axisParam) {
      const dirRec = this.records.get(axisParam.ref);
      if (dirRec && Array.isArray(dirRec.params[0])) {
        const d = dirRec.params[0].map((v: any) => typeof v === 'number' ? v : parseFloat(String(v)) || 0);
        if (d.length >= 3) {
          dirZ.set(d[0], d[1], d[2]);
        }
      }
    }

    // Param 2: RefDirection (IFCDIRECTION)
    const refDirParam = rec.params[2];
    if (refDirParam && typeof refDirParam === 'object' && 'ref' in refDirParam) {
      const dirRec = this.records.get(refDirParam.ref);
      if (dirRec && Array.isArray(dirRec.params[0])) {
        const d = dirRec.params[0].map((v: any) => typeof v === 'number' ? v : parseFloat(String(v)) || 0);
        if (d.length >= 3) {
          dirX.set(d[0], d[1], d[2]);
        }
      }
    }

    dirZ.normalize();
    dirX.normalize();

    let dirY = new THREE.Vector3().crossVectors(dirZ, dirX);
    if (dirY.lengthSq() < 1e-8) {
      const alt = Math.abs(dirZ.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      dirY.crossVectors(dirZ, alt).normalize();
    } else {
      dirY.normalize();
    }
    dirX.crossVectors(dirY, dirZ).normalize();

    const m = new THREE.Matrix4();
    m.makeBasis(dirX, dirY, dirZ);
    m.setPosition(loc);
    this.axis2PlacementCache.set(rec.id, m.clone());
    return m;
  }

  /**
   * Resolves the 2D transformation from an IFCAXIS2PLACEMENT2D.
   */
  private resolveAxis2Placement2D(rec: StepRecord): { origin: { x: number; y: number }; dirX: { x: number; y: number }; dirY: { x: number; y: number } } {
    let ox = 0, oy = 0;
    let dx = 1, dy = 0;

    const locParam = rec.params[0];
    if (locParam && typeof locParam === 'object' && 'ref' in locParam) {
      const ptRec = this.records.get(locParam.ref);
      if (ptRec && Array.isArray(ptRec.params[0])) {
        const coords = ptRec.params[0].map((v: any) =>
          (typeof v === 'number' ? v : parseFloat(String(v)) || 0) * this.lengthUnitScale
        );
        if (coords.length >= 2) {
          ox = coords[0];
          oy = coords[1];
        }
      }
    }

    const refDirParam = rec.params[1];
    if (refDirParam && typeof refDirParam === 'object' && 'ref' in refDirParam) {
      const dirRec = this.records.get(refDirParam.ref);
      if (dirRec && Array.isArray(dirRec.params[0])) {
        const d = dirRec.params[0].map((v: any) => typeof v === 'number' ? v : parseFloat(String(v)) || 0);
        if (d.length >= 2) {
          const len = Math.hypot(d[0], d[1]) || 1;
          dx = d[0] / len;
          dy = d[1] / len;
        }
      }
    }

    return {
      origin: { x: ox, y: oy },
      dirX: { x: dx, y: dy },
      dirY: { x: -dy, y: dx },
    };
  }

  /**
   * Extracts discretized 2D points in the local (u, v) plane from any STEP curve entity.
   * Supports IFCPOLYLINE, IFCCOMPOSITECURVE, IFCTRIMMEDCURVE, IFCCIRCLE (Rules 3, 6, 7, 13, 22).
   */
  private extract2DCurvePoints(curveRef: number, visited = new Set<number>()): { x: number; y: number }[] {
    if (visited.has(curveRef) || visited.size >= 32) {
      return [];
    }
    visited.add(curveRef);

    const curveRec = this.records.get(curveRef);
    if (!curveRec) return [];

    if (curveRec.type === 'IFCPOLYLINE') {
      return this.extractPolyline2DPoints(curveRec);
    }

    if (curveRec.type === 'IFCCOMPOSITECURVE') {
      return this.extractCompositeCurvePoints(curveRec, visited);
    }

    if (curveRec.type === 'IFCTRIMMEDCURVE') {
      return this.extractTrimmedCurvePoints(curveRec, visited);
    }

    if (curveRec.type === 'IFCCIRCLE') {
      return this.extractCircleCurvePoints(curveRec);
    }

    if (curveRec.type === 'IFCELLIPSE') {
      return this.extractEllipseCurvePoints(curveRec);
    }

    if (curveRec.type === 'IFCINDEXEDPOLYCURVE') {
      return this.extractIndexedPolyCurve2DPoints(curveRec);
    }

    // Warning logging in compliance with Rule 13 (Zero Silent Suppression)
    const msg = `Unsupported or unimplemented 2D curve type in STEP #${curveRec.id} (${curveRec.type})`;
    console.warn(`[IfcStepImporter] ${msg}`);
    this.importWarnings.push(msg);
    return [];
  }

  /**
   * Extracts 2D points from an IFCINDEXEDPOLYCURVE (IFC4 / IFC4.3) resolving its IFCCARTESIANPOINTLIST2D / 3D.
   */
  private extractIndexedPolyCurve2DPoints(curveRec: StepRecord): { x: number; y: number }[] {
    const pointsParam = curveRec.params[0];
    if (!pointsParam || typeof pointsParam !== 'object' || !('ref' in pointsParam)) {
      return [];
    }

    const pointsRec = this.records.get((pointsParam as any).ref);
    if (!pointsRec) return [];

    const allPoints: { x: number; y: number }[] = [];
    if (pointsRec.type === 'IFCCARTESIANPOINTLIST2D' || pointsRec.type === 'IFCCARTESIANPOINTLIST3D') {
      const coordList = Array.isArray(pointsRec.params[0]) ? pointsRec.params[0] : [];
      for (const pt of coordList) {
        if (Array.isArray(pt) && pt.length >= 2) {
          const x = (typeof pt[0] === 'number' ? pt[0] : parseFloat(String(pt[0])) || 0) * this.lengthUnitScale;
          const y = (typeof pt[1] === 'number' ? pt[1] : parseFloat(String(pt[1])) || 0) * this.lengthUnitScale;
          allPoints.push({ x, y });
        }
      }
    } else {
      return [];
    }

    if (allPoints.length === 0) return [];

    const segmentsParam = curveRec.params[1];
    let points: { x: number; y: number }[] = [];

    // If Segments is omitted ($ or null or []), points are connected in sequential order
    if (!segmentsParam || !Array.isArray(segmentsParam) || segmentsParam.length === 0) {
      points = allPoints.slice();
    } else {
      for (const seg of segmentsParam) {
        if (!seg) continue;
        let indices: number[] = [];
        let isArc = false;

        if (typeof seg === 'object' && 'type' in seg && (seg as any).type === 'IFCARCINDEX') {
          isArc = true;
          indices = this.extractIndicesList((seg as any).params);
        } else if (typeof seg === 'object' && 'type' in seg && (seg as any).type === 'IFCLINEINDEX') {
          indices = this.extractIndicesList((seg as any).params);
        } else if (Array.isArray(seg)) {
          indices = this.extractIndicesList(seg);
        }

        if (isArc && indices.length >= 3) {
          const p1 = allPoints[indices[0] - 1];
          const p2 = allPoints[indices[1] - 1];
          const p3 = allPoints[indices[2] - 1];
          if (p1 && p2 && p3) {
            const arcPts = this.discretize3PointArc2D(p1, p2, p3);
            for (const ap of arcPts) {
              if (points.length > 0) {
                const last = points[points.length - 1];
                if (Math.hypot(last.x - ap.x, last.y - ap.y) < GeometryTolerance.COINCIDENT_POINT) {
                  continue;
                }
              }
              points.push(ap);
            }
          }
        } else {
          for (const idx of indices) {
            const p = allPoints[idx - 1]; // 1-based in the IFC standard
            if (p) {
              if (points.length > 0) {
                const last = points[points.length - 1];
                if (Math.hypot(last.x - p.x, last.y - p.y) < GeometryTolerance.COINCIDENT_POINT) {
                  continue;
                }
              }
              points.push(p);
            }
          }
        }
      }
    }

    if (points.length >= 4) {
      const first = points[0];
      const last = points[points.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < GeometryTolerance.COINCIDENT_POINT) {
        points.pop();
      }
    }

    return points;
  }

  private extractIndicesList(params: any): number[] {
    const indices: number[] = [];
    if (!params) return indices;
    if (Array.isArray(params)) {
      for (const item of params) {
        if (Array.isArray(item)) {
          for (const sub of item) {
            const num = typeof sub === 'number' ? sub : parseInt(String(sub), 10);
            if (!isNaN(num)) indices.push(num);
          }
        } else {
          const num = typeof item === 'number' ? item : parseInt(String(item), 10);
          if (!isNaN(num)) indices.push(num);
        }
      }
    }
    return indices;
  }

  /**
   * Discretizes a 2D circular arc defined by 3 points (P1: start, P2: intermediate point, P3: end).
   */
  private discretize3PointArc2D(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
    segments: number = 12
  ): { x: number; y: number }[] {
    const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
    if (Math.abs(d) < GeometryTolerance.COINCIDENT_POINT) {
      return [p1, p2, p3];
    }

    const p1Sq = p1.x * p1.x + p1.y * p1.y;
    const p2Sq = p2.x * p2.x + p2.y * p2.y;
    const p3Sq = p3.x * p3.x + p3.y * p3.y;

    const cx = (p1Sq * (p2.y - p3.y) + p2Sq * (p3.y - p1.y) + p3Sq * (p1.y - p2.y)) / d;
    const cy = (p1Sq * (p3.x - p2.x) + p2Sq * (p1.x - p3.x) + p3Sq * (p2.x - p1.x)) / d;
    const radius = Math.hypot(p1.x - cx, p1.y - cy);

    let a1 = Math.atan2(p1.y - cy, p1.x - cx);
    let a2 = Math.atan2(p2.y - cy, p2.x - cx);
    let a3 = Math.atan2(p3.y - cy, p3.x - cx);

    const normalizeAngle = (a: number, base: number) => {
      let diff = a - base;
      while (diff <= -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      return base + diff;
    };

    a2 = normalizeAngle(a2, a1);
    a3 = normalizeAngle(a3, a2);

    const result: { x: number; y: number }[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = a1 + t * (a3 - a1);
      result.push({
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      });
    }
    return result;
  }

  /**
   * Extracts 2D points from an IFCPOLYLINE scaled by lengthUnitScale.
   */
  private extractPolyline2DPoints(curveRec: StepRecord): { x: number; y: number }[] {
    const points: { x: number; y: number }[] = [];
    if (!Array.isArray(curveRec.params[0])) return points;

    for (const ptRef of curveRec.params[0]) {
      if (ptRef && typeof ptRef === 'object' && 'ref' in ptRef) {
        const ptRec = this.records.get(ptRef.ref);
        if (ptRec && Array.isArray(ptRec.params[0])) {
          const c = ptRec.params[0].map((v: any) =>
            (typeof v === 'number' ? v : parseFloat(String(v)) || 0) * this.lengthUnitScale
          );
          if (c.length >= 2) {
            points.push({ x: c[0], y: c[1] });
          }
        }
      }
    }

    if (points.length >= 4) {
      const first = points[0];
      const last = points[points.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < GeometryTolerance.COINCIDENT_POINT) {
        points.pop();
      }
    }

    return points;
  }

  /**
   * Extracts and assembles segments from an IFCCOMPOSITECURVE respecting SameSense and merging endpoints.
   */
  private extractCompositeCurvePoints(compositeRec: StepRecord, visited: Set<number>): { x: number; y: number }[] {
    const segmentsParam = compositeRec.params[0];
    if (!Array.isArray(segmentsParam)) return [];

    const points: { x: number; y: number }[] = [];

    for (const segItem of segmentsParam) {
      if (!segItem || typeof segItem !== 'object' || !('ref' in segItem)) continue;
      const segRec = this.records.get(segItem.ref);
      if (!segRec || segRec.type !== 'IFCCOMPOSITECURVESEGMENT') continue;

      const sameSenseParam = segRec.params[1];
      const sameSense = sameSenseParam !== false && sameSenseParam !== '.F.' && String(sameSenseParam).toUpperCase() !== '.F.';
      const parentCurveParam = segRec.params[2];
      if (!parentCurveParam || typeof parentCurveParam !== 'object' || !('ref' in parentCurveParam)) continue;

      const segPoints = this.extract2DCurvePoints(parentCurveParam.ref, visited);
      if (segPoints.length === 0) continue;

      if (!sameSense) {
        segPoints.reverse();
      }

      // Concatenation without spread operator (Rule 7) and duplicate vertex removal at endpoints (Rule 6)
      for (const p of segPoints) {
        if (points.length > 0) {
          const last = points[points.length - 1];
          if (Math.hypot(last.x - p.x, last.y - p.y) < GeometryTolerance.COINCIDENT_POINT) {
            continue;
          }
        }
        points.push(p);
      }
    }

    // If the loop is closed (last point coincides with the first), discard closing duplicate point
    if (points.length >= 4) {
      const first = points[0];
      const last = points[points.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < GeometryTolerance.COINCIDENT_POINT) {
        points.pop();
      }
    }

    return points;
  }

  /**
   * Extracts discretized 2D points from an IFCTRIMMEDCURVE (circular arcs, lines, ellipses, or trimmed polylines).
   */
  private extractTrimmedCurvePoints(trimmedRec: StepRecord, visited: Set<number>): { x: number; y: number }[] {
    const basisParam = trimmedRec.params[IFC_GEOM_ATTRS.TRIMMED_BASIS_CURVE];
    if (!basisParam || typeof basisParam !== 'object' || !('ref' in basisParam)) return [];

    const basisRec = this.records.get(basisParam.ref);
    if (!basisRec) return [];

    const trim1Param = trimmedRec.params[IFC_GEOM_ATTRS.TRIMMED_1];
    const trim2Param = trimmedRec.params[IFC_GEOM_ATTRS.TRIMMED_2];
    const senseParam = trimmedRec.params[IFC_GEOM_ATTRS.TRIMMED_SENSE_AGREEMENT];
    const senseAgreement = senseParam !== false && senseParam !== '.F.' && String(senseParam).toUpperCase() !== '.F.';

    const trim1Val = this.extractAngleParameter(trim1Param);
    const trim2Val = this.extractAngleParameter(trim2Param);

    if (basisRec.type === 'IFCLINE') {
      // 1. Attempt to resolve direct endpoints as cartesian points
      const p1 = this.extractPoint2D(trim1Param);
      const p2 = this.extractPoint2D(trim2Param);

      if (p1 && p2) {
        return senseAgreement ? [p1, p2] : [p2, p1];
      }

      // 2. If no direct cartesian points are provided, analytically evaluate P(u) = P0 + u * V
      const pntParam = basisRec.params[IFC_GEOM_ATTRS.LINE_PNT];
      const dirParam = basisRec.params[IFC_GEOM_ATTRS.LINE_DIR];
      let p0 = { x: 0, y: 0 };
      if (pntParam && typeof pntParam === 'object' && 'ref' in pntParam) {
        const ptRec = this.records.get((pntParam as any).ref);
        if (ptRec && Array.isArray(ptRec.params[0])) {
          const raw = ptRec.params[0];
          p0 = {
            x: (typeof raw[0] === 'number' ? raw[0] : parseFloat(String(raw[0])) || 0) * this.lengthUnitScale,
            y: (typeof raw[1] === 'number' ? raw[1] : parseFloat(String(raw[1])) || 0) * this.lengthUnitScale,
          };
        }
      }

      let vx = 1;
      let vy = 0;
      if (dirParam && typeof dirParam === 'object' && 'ref' in dirParam) {
        const vecRec = this.records.get((dirParam as any).ref);
        if (vecRec) {
          if (vecRec.type === 'IFCVECTOR') {
            const orientParam = vecRec.params[IFC_GEOM_ATTRS.VECTOR_ORIENTATION];
            const magParam = vecRec.params[IFC_GEOM_ATTRS.VECTOR_MAGNITUDE];
            const rawMag = typeof magParam === 'number' ? magParam : parseFloat(String(magParam)) || 1.0;
            const mag = rawMag * this.lengthUnitScale;
            if (orientParam && typeof orientParam === 'object' && 'ref' in orientParam) {
              const dirRec = this.records.get((orientParam as any).ref);
              if (dirRec && Array.isArray(dirRec.params[0])) {
                const ratios = dirRec.params[0];
                const rx = typeof ratios[0] === 'number' ? ratios[0] : parseFloat(String(ratios[0])) || 0;
                const ry = typeof ratios[1] === 'number' ? ratios[1] : parseFloat(String(ratios[1])) || 0;
                const len = Math.hypot(rx, ry);
                if (len > GeometryTolerance.COINCIDENT_POINT) {
                  vx = (rx / len) * mag;
                  vy = (ry / len) * mag;
                }
              }
            }
          } else if (vecRec.type === 'IFCDIRECTION' && Array.isArray(vecRec.params[0])) {
            const ratios = vecRec.params[0];
            const rx = typeof ratios[0] === 'number' ? ratios[0] : parseFloat(String(ratios[0])) || 0;
            const ry = typeof ratios[1] === 'number' ? ratios[1] : parseFloat(String(ratios[1])) || 0;
            const len = Math.hypot(rx, ry);
            if (len > GeometryTolerance.COINCIDENT_POINT) {
              vx = rx / len;
              vy = ry / len;
            }
          }
        }
      }

      const u1 = trim1Val !== null ? trim1Val : 0;
      const u2 = trim2Val !== null ? trim2Val : 1;
      const ptStart = { x: p0.x + u1 * vx, y: p0.y + u1 * vy };
      const ptEnd = { x: p0.x + u2 * vx, y: p0.y + u2 * vy };

      return senseAgreement ? [ptStart, ptEnd] : [ptEnd, ptStart];
    }

    if (basisRec.type === 'IFCELLIPSE') {
      let startRad = 0;
      let endRad = Math.PI * 2;

      if (trim1Val !== null && trim2Val !== null) {
        startRad = this.toAngleRadians(trim1Val);
        endRad = this.toAngleRadians(trim2Val);
      } else {
        const p1 = this.extractPoint2D(trim1Param);
        const p2 = this.extractPoint2D(trim2Param);
        if (p1 && p2) {
          const ellipsePosParam = basisRec.params[IFC_GEOM_ATTRS.ELLIPSE_POSITION];
          let origin = { x: 0, y: 0 };
          let dirX = { x: 1, y: 0 };
          let dirY = { x: 0, y: 1 };
          if (ellipsePosParam && typeof ellipsePosParam === 'object' && 'ref' in ellipsePosParam) {
            const posRec = this.records.get((ellipsePosParam as any).ref);
            if (posRec && posRec.type === 'IFCAXIS2PLACEMENT2D') {
              const t2d = this.resolveAxis2Placement2D(posRec);
              origin = t2d.origin;
              dirX = t2d.dirX;
              dirY = t2d.dirY;
            }
          }
          const pR1 = basisRec.params[IFC_GEOM_ATTRS.ELLIPSE_SEMI_AXIS_1];
          const pR2 = basisRec.params[IFC_GEOM_ATTRS.ELLIPSE_SEMI_AXIS_2];
          const rawR1 = typeof pR1 === 'number' ? pR1 : parseFloat(String(pR1 || 0)) || 0;
          const rawR2 = typeof pR2 === 'number' ? pR2 : parseFloat(String(pR2 || 0)) || 0;
          const r1 = Math.abs(rawR1) * this.lengthUnitScale;
          const r2 = Math.abs(rawR2) * this.lengthUnitScale;

          const v1 = { x: p1.x - origin.x, y: p1.y - origin.y };
          const v2 = { x: p2.x - origin.x, y: p2.y - origin.y };
          const u1 = (v1.x * dirX.x + v1.y * dirX.y) / (r1 > GeometryTolerance.COINCIDENT_POINT ? r1 : 1);
          const w1 = (v1.x * dirY.x + v1.y * dirY.y) / (r2 > GeometryTolerance.COINCIDENT_POINT ? r2 : 1);
          const u2 = (v2.x * dirX.x + v2.y * dirX.y) / (r1 > GeometryTolerance.COINCIDENT_POINT ? r1 : 1);
          const w2 = (v2.x * dirY.x + v2.y * dirY.y) / (r2 > GeometryTolerance.COINCIDENT_POINT ? r2 : 1);
          startRad = Math.atan2(w1, u1);
          endRad = Math.atan2(w2, u2);
          if (endRad <= startRad) {
            endRad += Math.PI * 2;
          }
        }
      }

      return this.extractEllipseCurvePoints(basisRec, startRad, endRad, senseAgreement);
    }

    if (basisRec.type === 'IFCCIRCLE') {
      let startRad = 0;
      let endRad = Math.PI / 2;

      if (trim1Val !== null && trim2Val !== null) {
        startRad = this.toAngleRadians(trim1Val);
        endRad = this.toAngleRadians(trim2Val);
      } else {
        const p1 = this.extractPoint2D(trim1Param);
        const p2 = this.extractPoint2D(trim2Param);
        if (p1 && p2) {
          const circlePosParam = basisRec.params[IFC_GEOM_ATTRS.CIRCLE_POSITION];
          let origin = { x: 0, y: 0 };
          let dirX = { x: 1, y: 0 };
          let dirY = { x: 0, y: 1 };
          if (circlePosParam && typeof circlePosParam === 'object' && 'ref' in circlePosParam) {
            const posRec = this.records.get((circlePosParam as any).ref);
            if (posRec && posRec.type === 'IFCAXIS2PLACEMENT2D') {
              const t2d = this.resolveAxis2Placement2D(posRec);
              origin = t2d.origin;
              dirX = t2d.dirX;
              dirY = t2d.dirY;
            }
          }
          const v1 = { x: p1.x - origin.x, y: p1.y - origin.y };
          const v2 = { x: p2.x - origin.x, y: p2.y - origin.y };
          const u1 = v1.x * dirX.x + v1.y * dirX.y;
          const w1 = v1.x * dirY.x + v1.y * dirY.y;
          const u2 = v2.x * dirX.x + v2.y * dirX.y;
          const w2 = v2.x * dirY.x + v2.y * dirY.y;
          startRad = Math.atan2(w1, u1);
          endRad = Math.atan2(w2, u2);
          if (endRad <= startRad) {
            endRad += Math.PI * 2;
          }
        }
      }

      return this.extractCircleCurvePoints(basisRec, startRad, endRad, senseAgreement);
    }

    if (basisRec.type === 'IFCPOLYLINE') {
      return this.extractPolyline2DPoints(basisRec);
    }

    return this.extract2DCurvePoints(basisRec.id, visited);
  }

  /**
   * Discretizes an IFCCIRCLE into 2D points based on its IFCAXIS2PLACEMENT2D and radius.
   */
  private extractCircleCurvePoints(
    circleRec: StepRecord,
    trimStartRad?: number,
    trimEndRad?: number,
    senseAgreement: boolean = true
  ): { x: number; y: number }[] {
    const posParam = circleRec.params[0];
    const radiusParam = circleRec.params[1];
    const rawRadius = typeof radiusParam === 'number' ? radiusParam : parseFloat(String(radiusParam || 0)) || 0;
    const radius = rawRadius * this.lengthUnitScale;
    if (radius < GeometryTolerance.COINCIDENT_POINT) {
      return [];
    }

    let origin = { x: 0, y: 0 };
    let dirX = { x: 1, y: 0 };
    let dirY = { x: 0, y: 1 };

    if (posParam && typeof posParam === 'object' && 'ref' in posParam) {
      const posRec = this.records.get(posParam.ref);
      if (posRec && posRec.type === 'IFCAXIS2PLACEMENT2D') {
        const t2d = this.resolveAxis2Placement2D(posRec);
        origin = t2d.origin;
        dirX = t2d.dirX;
        dirY = t2d.dirY;
      }
    }

    let start = trimStartRad !== undefined ? trimStartRad : 0;
    let end = trimEndRad !== undefined ? trimEndRad : Math.PI * 2;

    let sweep: number;
    if (trimStartRad !== undefined && trimEndRad !== undefined) {
      sweep = end - start;
      if (senseAgreement) {
        while (sweep <= 0) sweep += Math.PI * 2;
        while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
      } else {
        while (sweep >= 0) sweep -= Math.PI * 2;
        while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
      }
    } else {
      sweep = senseAgreement ? Math.PI * 2 : -Math.PI * 2;
    }

    const numSegments = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
    const points: { x: number; y: number }[] = [];

    for (let i = 0; i <= numSegments; i++) {
      const t = i / numSegments;
      const theta = start + t * sweep;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      points.push({
        x: origin.x + radius * (cosT * dirX.x + sinT * dirY.x),
        y: origin.y + radius * (cosT * dirX.y + sinT * dirY.y),
      });
    }

    return points;
  }

  /**
   * Discretizes an IFCELLIPSE into 2D points based on its IFCAXIS2PLACEMENT2D and semi-axes rx, ry.
   */
  private extractEllipseCurvePoints(
    ellipseRec: StepRecord,
    trimStartRad?: number,
    trimEndRad?: number,
    senseAgreement: boolean = true
  ): { x: number; y: number }[] {
    const posParam = ellipseRec.params[IFC_GEOM_ATTRS.ELLIPSE_POSITION];
    const r1Param = ellipseRec.params[IFC_GEOM_ATTRS.ELLIPSE_SEMI_AXIS_1];
    const r2Param = ellipseRec.params[IFC_GEOM_ATTRS.ELLIPSE_SEMI_AXIS_2];
    const rawR1 = typeof r1Param === 'number' ? r1Param : parseFloat(String(r1Param || 0)) || 0;
    const rawR2 = typeof r2Param === 'number' ? r2Param : parseFloat(String(r2Param || 0)) || 0;
    const r1 = Math.abs(rawR1) * this.lengthUnitScale;
    const r2 = Math.abs(rawR2) * this.lengthUnitScale;

    if (r1 < GeometryTolerance.COINCIDENT_POINT || r2 < GeometryTolerance.COINCIDENT_POINT) {
      return [];
    }

    let origin = { x: 0, y: 0 };
    let dirX = { x: 1, y: 0 };
    let dirY = { x: 0, y: 1 };

    if (posParam && typeof posParam === 'object' && 'ref' in posParam) {
      const posRec = this.records.get((posParam as any).ref);
      if (posRec && posRec.type === 'IFCAXIS2PLACEMENT2D') {
        const t2d = this.resolveAxis2Placement2D(posRec);
        origin = t2d.origin;
        dirX = t2d.dirX;
        dirY = t2d.dirY;
      }
    }

    const start = trimStartRad !== undefined ? trimStartRad : 0;
    const end = trimEndRad !== undefined ? trimEndRad : Math.PI * 2;

    let sweep: number;
    if (trimStartRad !== undefined && trimEndRad !== undefined) {
      sweep = end - start;
      if (senseAgreement) {
        while (sweep <= 0) sweep += Math.PI * 2;
        while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
      } else {
        while (sweep >= 0) sweep -= Math.PI * 2;
        while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
      }
    } else {
      sweep = senseAgreement ? Math.PI * 2 : -Math.PI * 2;
    }

    const numSegments = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
    const points: { x: number; y: number }[] = [];

    for (let i = 0; i <= numSegments; i++) {
      const t = i / numSegments;
      const theta = start + t * sweep;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      points.push({
        x: origin.x + r1 * cosT * dirX.x + r2 * sinT * dirY.x,
        y: origin.y + r1 * cosT * dirX.y + r2 * sinT * dirY.y,
      });
    }

    return points;
  }

  private toAngleRadians(val: number): number {
    if (Math.abs(val) > Math.PI * 2 + 1e-4) {
      return val * (Math.PI / 180);
    }
    return val * this.planeAngleUnitScale;
  }

  private extractAngleParameter(param: StepParam): number | null {
    if (typeof param === 'number') return param;
    if (Array.isArray(param)) {
      for (const item of param) {
        const val = this.extractAngleParameter(item);
        if (val !== null) return val;
      }
      return null;
    }
    if (param && typeof param === 'object') {
      if ('params' in param && Array.isArray((param as any).params) && (param as any).params.length > 0) {
        return this.extractAngleParameter((param as any).params[0]);
      }
      if ('ref' in param) {
        const rec = this.records.get((param as any).ref);
        if (rec && Array.isArray(rec.params) && rec.params.length > 0) {
          return this.extractAngleParameter(rec.params[0]);
        }
      }
    }
    const n = parseFloat(String(param));
    return isNaN(n) ? null : n;
  }

  private extractPoint2D(param: StepParam): { x: number; y: number } | null {
    if (!param) return null;
    if (Array.isArray(param)) {
      for (const item of param) {
        const pt = this.extractPoint2D(item);
        if (pt) return pt;
      }
      return null;
    }
    if (typeof param === 'object' && 'ref' in param) {
      const ptRec = this.records.get((param as any).ref);
      if (ptRec && Array.isArray(ptRec.params[0])) {
        const c = ptRec.params[0].map((v: any) =>
          (typeof v === 'number' ? v : parseFloat(String(v)) || 0) * this.lengthUnitScale
        );
        if (c.length >= 2) return { x: c[0], y: c[1] };
      }
    }
    return null;
  }

  /**
   * Extracts formally typed 3D points (Vec3) and closed state from any STEP 3D curve entity.
   * Complies with Rule 6, Rule 7, Rule 11, Rule 13, Rule 18, and Rule 22.
   * Supports IFCPOLYLINE, IFCINDEXEDPOLYCURVE, IFCCOMPOSITECURVE, IFCTRIMMEDCURVE, IFCCIRCLE, and IFCELLIPSE.
   */
  private extract3DCurvePoints(
    curveRef: number,
    visited = new Set<number>()
  ): { points: Vec3[]; isClosed: boolean } {
    if (visited.has(curveRef) || visited.size >= 32) {
      return { points: [], isClosed: false };
    }
    visited.add(curveRef);

    const curveRec = this.records.get(curveRef);
    if (!curveRec) return { points: [], isClosed: false };

    if (curveRec.type === 'IFCPOLYLINE') {
      return this.extractPolyline3DPoints(curveRec);
    }

    if (curveRec.type === 'IFCINDEXEDPOLYCURVE') {
      return this.extractIndexedPolyCurve3DPoints(curveRec);
    }

    if (curveRec.type === 'IFCCOMPOSITECURVE') {
      return this.extractCompositeCurve3DPoints(curveRec, visited);
    }

    if (curveRec.type === 'IFCTRIMMEDCURVE') {
      return this.extractTrimmedCurve3DPoints(curveRec, visited);
    }

    if (curveRec.type === 'IFCCIRCLE') {
      return this.extractCircleCurve3DPoints(curveRec);
    }

    if (curveRec.type === 'IFCELLIPSE') {
      return this.extractEllipseCurve3DPoints(curveRec);
    }

    const msg = `Unsupported or unimplemented 3D curve type in STEP #${curveRec.id} (${curveRec.type})`;
    console.warn(`[IfcStepImporter] ${msg}`);
    this.importWarnings.push(msg);
    return { points: [], isClosed: false };
  }

  /**
   * Extracts 3D points from an IFCPOLYLINE scaled by lengthUnitScale.
   */
  private extractPolyline3DPoints(curveRec: StepRecord): { points: Vec3[]; isClosed: boolean } {
    const points: Vec3[] = [];
    if (!Array.isArray(curveRec.params[0])) return { points, isClosed: false };

    for (const ptRef of curveRec.params[0]) {
      if (ptRef && typeof ptRef === 'object' && 'ref' in ptRef) {
        const ptRec = this.records.get(ptRef.ref);
        if (ptRec && Array.isArray(ptRec.params[0])) {
          const c = ptRec.params[0].map((v: any) =>
            (typeof v === 'number' ? v : parseFloat(String(v)) || 0) * this.lengthUnitScale
          );
          let pt: Vec3;
          if (c.length >= 3) {
            pt = new Vec3(c[0], c[1], c[2]);
          } else if (c.length === 2) {
            pt = new Vec3(c[0], c[1], 0);
          } else {
            continue;
          }

          if (points.length > 0) {
            const last = points[points.length - 1];
            if (last.distanceTo(pt) <= GeometryTolerance.COINCIDENT_POINT) {
              continue;
            }
          }
          points.push(pt);
        }
      }
    }

    let isClosed = false;
    if (points.length >= 4) {
      const first = points[0];
      const last = points[points.length - 1];
      if (first.distanceTo(last) <= GeometryTolerance.COINCIDENT_POINT) {
        isClosed = true;
        points.pop();
      }
    }

    return { points, isClosed };
  }

  /**
   * Extracts 3D points from an IFCINDEXEDPOLYCURVE (IFC 4.3).
   */
  private extractIndexedPolyCurve3DPoints(curveRec: StepRecord): { points: Vec3[]; isClosed: boolean } {
    const pointsParam = curveRec.params[0];
    if (!pointsParam || typeof pointsParam !== 'object' || !('ref' in pointsParam)) {
      return { points: [], isClosed: false };
    }

    const pointsRec = this.records.get((pointsParam as any).ref);
    if (!pointsRec) return { points: [], isClosed: false };

    const allPoints: Vec3[] = [];
    if (pointsRec.type === 'IFCCARTESIANPOINTLIST3D' || pointsRec.type === 'IFCCARTESIANPOINTLIST2D') {
      const coordList = Array.isArray(pointsRec.params[0]) ? pointsRec.params[0] : [];
      for (const pt of coordList) {
        if (Array.isArray(pt)) {
          const x = (typeof pt[0] === 'number' ? pt[0] : parseFloat(String(pt[0])) || 0) * this.lengthUnitScale;
          const y = (typeof pt[1] === 'number' ? pt[1] : parseFloat(String(pt[1])) || 0) * this.lengthUnitScale;
          const z =
            (pt.length >= 3
              ? typeof pt[2] === 'number'
                ? pt[2]
                : parseFloat(String(pt[2])) || 0
              : 0) * this.lengthUnitScale;
          allPoints.push(new Vec3(x, y, z));
        }
      }
    } else {
      return { points: [], isClosed: false };
    }

    if (allPoints.length === 0) return { points: [], isClosed: false };

    const segmentsParam = curveRec.params[1];
    let points: Vec3[] = [];

    if (!segmentsParam || !Array.isArray(segmentsParam) || segmentsParam.length === 0) {
      points = allPoints.slice();
    } else {
      for (const seg of segmentsParam) {
        if (!seg) continue;
        let indices: number[] = [];
        let isArc = false;

        if (typeof seg === 'object' && 'type' in seg && (seg as any).type === 'IFCARCINDEX') {
          isArc = true;
          indices = this.extractIndicesList((seg as any).params);
        } else if (typeof seg === 'object' && 'type' in seg && (seg as any).type === 'IFCLINEINDEX') {
          indices = this.extractIndicesList((seg as any).params);
        } else if (Array.isArray(seg)) {
          indices = this.extractIndicesList(seg);
        }

        if (isArc && indices.length >= 3) {
          const p1 = allPoints[indices[0] - 1];
          const p2 = allPoints[indices[1] - 1];
          const p3 = allPoints[indices[2] - 1];
          if (p1 && p2 && p3) {
            const arcPts = this.discretize3PointArc3D(p1, p2, p3);
            for (const ap of arcPts) {
              if (points.length > 0) {
                const last = points[points.length - 1];
                if (last.distanceTo(ap) <= GeometryTolerance.COINCIDENT_POINT) {
                  continue;
                }
              }
              points.push(ap);
            }
          }
        } else {
          for (const idx of indices) {
            const p = allPoints[idx - 1];
            if (p) {
              if (points.length > 0) {
                const last = points[points.length - 1];
                if (last.distanceTo(p) <= GeometryTolerance.COINCIDENT_POINT) {
                  continue;
                }
              }
              points.push(p);
            }
          }
        }
      }
    }

    let isClosed = false;
    if (points.length >= 4) {
      const first = points[0];
      const last = points[points.length - 1];
      if (first.distanceTo(last) <= GeometryTolerance.COINCIDENT_POINT) {
        isClosed = true;
        points.pop();
      }
    }

    return { points, isClosed };
  }

  /**
   * Extracts and concatenates 3D segments from an IFCCOMPOSITECURVE.
   */
  private extractCompositeCurve3DPoints(
    compositeRec: StepRecord,
    visited: Set<number>
  ): { points: Vec3[]; isClosed: boolean } {
    const segmentsParam = compositeRec.params[0];
    if (!Array.isArray(segmentsParam)) return { points: [], isClosed: false };

    const points: Vec3[] = [];

    for (const segItem of segmentsParam) {
      if (!segItem || typeof segItem !== 'object' || !('ref' in segItem)) continue;
      const segRec = this.records.get(segItem.ref);
      if (!segRec || segRec.type !== 'IFCCOMPOSITECURVESEGMENT') continue;

      const sameSenseParam = segRec.params[1];
      const sameSense =
        sameSenseParam !== false &&
        sameSenseParam !== '.F.' &&
        String(sameSenseParam).toUpperCase() !== '.F.';
      const parentCurveParam = segRec.params[2];
      if (!parentCurveParam || typeof parentCurveParam !== 'object' || !('ref' in parentCurveParam)) continue;

      const { points: segPoints } = this.extract3DCurvePoints(parentCurveParam.ref, visited);
      if (segPoints.length === 0) continue;

      if (!sameSense) {
        segPoints.reverse();
      }

      for (const p of segPoints) {
        if (points.length > 0) {
          const last = points[points.length - 1];
          if (last.distanceTo(p) <= GeometryTolerance.COINCIDENT_POINT) {
            continue;
          }
        }
        points.push(p);
      }
    }

    let isClosed = false;
    if (points.length >= 4) {
      const first = points[0];
      const last = points[points.length - 1];
      if (first.distanceTo(last) <= GeometryTolerance.COINCIDENT_POINT) {
        isClosed = true;
        points.pop();
      }
    }

    return { points, isClosed };
  }

  /**
   * Extracts 3D points from an IFCTRIMMEDCURVE (line, circle, ellipse, or trimmed 3D curve).
   */
  private extractTrimmedCurve3DPoints(
    trimmedRec: StepRecord,
    visited: Set<number>
  ): { points: Vec3[]; isClosed: boolean } {
    const basisParam = trimmedRec.params[IFC_GEOM_ATTRS.TRIMMED_BASIS_CURVE];
    if (!basisParam || typeof basisParam !== 'object' || !('ref' in basisParam)) {
      return { points: [], isClosed: false };
    }

    const basisRec = this.records.get(basisParam.ref);
    if (!basisRec) return { points: [], isClosed: false };

    const trim1Param = trimmedRec.params[IFC_GEOM_ATTRS.TRIMMED_1];
    const trim2Param = trimmedRec.params[IFC_GEOM_ATTRS.TRIMMED_2];
    const senseParam = trimmedRec.params[IFC_GEOM_ATTRS.TRIMMED_SENSE_AGREEMENT];
    const senseAgreement =
      senseParam !== false && senseParam !== '.F.' && String(senseParam).toUpperCase() !== '.F.';

    const trim1Val = this.extractAngleParameter(trim1Param);
    const trim2Val = this.extractAngleParameter(trim2Param);

    if (basisRec.type === 'IFCLINE') {
      const p1 = this.extractPoint3D(trim1Param);
      const p2 = this.extractPoint3D(trim2Param);
      if (p1 && p2) {
        return {
          points: senseAgreement ? [p1, p2] : [p2, p1],
          isClosed: false,
        };
      }

      const pntParam = basisRec.params[IFC_GEOM_ATTRS.LINE_PNT];
      const dirParam = basisRec.params[IFC_GEOM_ATTRS.LINE_DIR];
      let p0 = new Vec3(0, 0, 0);
      if (pntParam && typeof pntParam === 'object' && 'ref' in pntParam) {
        const ptRec = this.records.get((pntParam as any).ref);
        if (ptRec && Array.isArray(ptRec.params[0])) {
          const raw = ptRec.params[0];
          p0 = new Vec3(
            (typeof raw[0] === 'number' ? raw[0] : parseFloat(String(raw[0])) || 0) * this.lengthUnitScale,
            (typeof raw[1] === 'number' ? raw[1] : parseFloat(String(raw[1])) || 0) * this.lengthUnitScale,
            (typeof raw[2] === 'number' ? raw[2] : parseFloat(String(raw[2])) || 0) * this.lengthUnitScale
          );
        }
      }

      let vDir = new Vec3(1, 0, 0);
      if (dirParam && typeof dirParam === 'object' && 'ref' in dirParam) {
        const vecRec = this.records.get((dirParam as any).ref);
        if (vecRec) {
          if (vecRec.type === 'IFCVECTOR') {
            const orientParam = vecRec.params[IFC_GEOM_ATTRS.VECTOR_ORIENTATION];
            const magParam = vecRec.params[IFC_GEOM_ATTRS.VECTOR_MAGNITUDE];
            const rawMag = typeof magParam === 'number' ? magParam : parseFloat(String(magParam)) || 1.0;
            const mag = rawMag * this.lengthUnitScale;
            if (orientParam && typeof orientParam === 'object' && 'ref' in orientParam) {
              const dirRec = this.records.get((orientParam as any).ref);
              if (dirRec && Array.isArray(dirRec.params[0])) {
                const r = dirRec.params[0];
                const rx = typeof r[0] === 'number' ? r[0] : parseFloat(String(r[0])) || 0;
                const ry = typeof r[1] === 'number' ? r[1] : parseFloat(String(r[1])) || 0;
                const rz = typeof r[2] === 'number' ? r[2] : parseFloat(String(r[2])) || 0;
                const len = Math.hypot(rx, ry, rz);
                if (len > GeometryTolerance.COINCIDENT_POINT) {
                  vDir = new Vec3((rx / len) * mag, (ry / len) * mag, (rz / len) * mag);
                }
              }
            }
          } else if (vecRec.type === 'IFCDIRECTION' && Array.isArray(vecRec.params[0])) {
            const r = vecRec.params[0];
            const rx = typeof r[0] === 'number' ? r[0] : parseFloat(String(r[0])) || 0;
            const ry = typeof r[1] === 'number' ? r[1] : parseFloat(String(r[1])) || 0;
            const rz = typeof r[2] === 'number' ? r[2] : parseFloat(String(r[2])) || 0;
            const len = Math.hypot(rx, ry, rz);
            if (len > GeometryTolerance.COINCIDENT_POINT) {
              vDir = new Vec3(rx / len, ry / len, rz / len);
            }
          }
        }
      }

      const u1 = trim1Val !== null ? trim1Val : 0;
      const u2 = trim2Val !== null ? trim2Val : 1;
      const ptStart = p0.add(vDir.scale(u1));
      const ptEnd = p0.add(vDir.scale(u2));
      return {
        points: senseAgreement ? [ptStart, ptEnd] : [ptEnd, ptStart],
        isClosed: false,
      };
    }

    if (basisRec.type === 'IFCCIRCLE') {
      let startRad = 0;
      let endRad = Math.PI / 2;

      if (trim1Val !== null && trim2Val !== null) {
        startRad = this.toAngleRadians(trim1Val);
        endRad = this.toAngleRadians(trim2Val);
      } else {
        const p1 = this.extractPoint3D(trim1Param);
        const p2 = this.extractPoint3D(trim2Param);
        if (p1 && p2) {
          const circlePosParam = basisRec.params[IFC_GEOM_ATTRS.CIRCLE_POSITION];
          let origin = new Vec3(0, 0, 0);
          let dirX = new Vec3(1, 0, 0);
          let dirY = new Vec3(0, 1, 0);
          if (circlePosParam && typeof circlePosParam === 'object' && 'ref' in circlePosParam) {
            const posRec = this.records.get((circlePosParam as any).ref);
            if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
              const m = this.resolveAxis2Placement3D(posRec);
              origin = new Vec3(m.elements[12], m.elements[13], m.elements[14]);
              dirX = new Vec3(m.elements[0], m.elements[1], m.elements[2]).normalize();
              dirY = new Vec3(m.elements[4], m.elements[5], m.elements[6]).normalize();
            } else if (posRec && posRec.type === 'IFCAXIS2PLACEMENT2D') {
              const t2d = this.resolveAxis2Placement2D(posRec);
              origin = new Vec3(t2d.origin.x, t2d.origin.y, 0);
              dirX = new Vec3(t2d.dirX.x, t2d.dirX.y, 0);
              dirY = new Vec3(t2d.dirY.x, t2d.dirY.y, 0);
            }
          }
          const v1 = p1.sub(origin);
          const v2 = p2.sub(origin);
          startRad = Math.atan2(v1.dot(dirY), v1.dot(dirX));
          endRad = Math.atan2(v2.dot(dirY), v2.dot(dirX));
          if (endRad <= startRad) endRad += Math.PI * 2;
        }
      }

      return this.extractCircleCurve3DPoints(basisRec, startRad, endRad, senseAgreement);
    }

    if (basisRec.type === 'IFCELLIPSE') {
      let startRad = 0;
      let endRad = Math.PI * 2;

      if (trim1Val !== null && trim2Val !== null) {
        startRad = this.toAngleRadians(trim1Val);
        endRad = this.toAngleRadians(trim2Val);
      } else {
        const p1 = this.extractPoint3D(trim1Param);
        const p2 = this.extractPoint3D(trim2Param);
        if (p1 && p2) {
          const ellipsePosParam = basisRec.params[IFC_GEOM_ATTRS.ELLIPSE_POSITION];
          let origin = new Vec3(0, 0, 0);
          let dirX = new Vec3(1, 0, 0);
          let dirY = new Vec3(0, 1, 0);
          if (ellipsePosParam && typeof ellipsePosParam === 'object' && 'ref' in ellipsePosParam) {
            const posRec = this.records.get((ellipsePosParam as any).ref);
            if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
              const m = this.resolveAxis2Placement3D(posRec);
              origin = new Vec3(m.elements[12], m.elements[13], m.elements[14]);
              dirX = new Vec3(m.elements[0], m.elements[1], m.elements[2]).normalize();
              dirY = new Vec3(m.elements[4], m.elements[5], m.elements[6]).normalize();
            } else if (posRec && posRec.type === 'IFCAXIS2PLACEMENT2D') {
              const t2d = this.resolveAxis2Placement2D(posRec);
              origin = new Vec3(t2d.origin.x, t2d.origin.y, 0);
              dirX = new Vec3(t2d.dirX.x, t2d.dirX.y, 0);
              dirY = new Vec3(t2d.dirY.x, t2d.dirY.y, 0);
            }
          }
          const pR1 = basisRec.params[IFC_GEOM_ATTRS.ELLIPSE_SEMI_AXIS_1];
          const pR2 = basisRec.params[IFC_GEOM_ATTRS.ELLIPSE_SEMI_AXIS_2];
          const rawR1 = typeof pR1 === 'number' ? pR1 : parseFloat(String(pR1 || 0)) || 0;
          const rawR2 = typeof pR2 === 'number' ? pR2 : parseFloat(String(pR2 || 0)) || 0;
          const r1 = Math.abs(rawR1) * this.lengthUnitScale;
          const r2 = Math.abs(rawR2) * this.lengthUnitScale;

          const v1 = p1.sub(origin);
          const v2 = p2.sub(origin);
          const u1 = v1.dot(dirX) / (r1 > GeometryTolerance.COINCIDENT_POINT ? r1 : 1);
          const w1 = v1.dot(dirY) / (r2 > GeometryTolerance.COINCIDENT_POINT ? r2 : 1);
          const u2 = v2.dot(dirX) / (r1 > GeometryTolerance.COINCIDENT_POINT ? r1 : 1);
          const w2 = v2.dot(dirY) / (r2 > GeometryTolerance.COINCIDENT_POINT ? r2 : 1);
          startRad = Math.atan2(w1, u1);
          endRad = Math.atan2(w2, u2);
          if (endRad <= startRad) endRad += Math.PI * 2;
        }
      }

      return this.extractEllipseCurve3DPoints(basisRec, startRad, endRad, senseAgreement);
    }

    if (basisRec.type === 'IFCPOLYLINE') {
      return this.extractPolyline3DPoints(basisRec);
    }

    return this.extract3DCurvePoints(basisRec.id, visited);
  }

  /**
   * Discretizes an IFCCIRCLE into 3D points based on its IFCAXIS2PLACEMENT3D / 2D and radius.
   */
  private extractCircleCurve3DPoints(
    circleRec: StepRecord,
    trimStartRad?: number,
    trimEndRad?: number,
    senseAgreement: boolean = true
  ): { points: Vec3[]; isClosed: boolean } {
    const posParam = circleRec.params[0];
    const radiusParam = circleRec.params[1];
    const rawRadius = typeof radiusParam === 'number' ? radiusParam : parseFloat(String(radiusParam || 0)) || 0;
    const radius = rawRadius * this.lengthUnitScale;
    if (radius < GeometryTolerance.COINCIDENT_POINT) {
      return { points: [], isClosed: false };
    }

    let origin = new Vec3(0, 0, 0);
    let dirX = new Vec3(1, 0, 0);
    let dirY = new Vec3(0, 1, 0);

    if (posParam && typeof posParam === 'object' && 'ref' in posParam) {
      const posRec = this.records.get(posParam.ref);
      if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
        const m = this.resolveAxis2Placement3D(posRec);
        origin = new Vec3(m.elements[12], m.elements[13], m.elements[14]);
        dirX = new Vec3(m.elements[0], m.elements[1], m.elements[2]).normalize();
        dirY = new Vec3(m.elements[4], m.elements[5], m.elements[6]).normalize();
      } else if (posRec && posRec.type === 'IFCAXIS2PLACEMENT2D') {
        const t2d = this.resolveAxis2Placement2D(posRec);
        origin = new Vec3(t2d.origin.x, t2d.origin.y, 0);
        dirX = new Vec3(t2d.dirX.x, t2d.dirX.y, 0);
        dirY = new Vec3(t2d.dirY.x, t2d.dirY.y, 0);
      }
    }

    const isFullCircle = trimStartRad === undefined && trimEndRad === undefined;
    const start = trimStartRad !== undefined ? trimStartRad : 0;
    const end = trimEndRad !== undefined ? trimEndRad : Math.PI * 2;

    let sweep: number;
    if (trimStartRad !== undefined && trimEndRad !== undefined) {
      sweep = end - start;
      if (senseAgreement) {
        while (sweep <= 0) sweep += Math.PI * 2;
        while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
      } else {
        while (sweep >= 0) sweep -= Math.PI * 2;
        while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
      }
    } else {
      sweep = senseAgreement ? Math.PI * 2 : -Math.PI * 2;
    }

    const numSegments = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
    const points: Vec3[] = [];

    for (let i = 0; i <= numSegments; i++) {
      const t = i / numSegments;
      const theta = start + t * sweep;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      points.push(
        new Vec3(
          origin.x + radius * (cosT * dirX.x + sinT * dirY.x),
          origin.y + radius * (cosT * dirX.y + sinT * dirY.y),
          origin.z + radius * (cosT * dirX.z + sinT * dirY.z)
        )
      );
    }

    let isClosed = false;
    if (isFullCircle || Math.abs(Math.abs(sweep) - Math.PI * 2) < GeometryTolerance.POINT_ON_PLANE) {
      isClosed = true;
      if (
        points.length >= 4 &&
        points[0].distanceTo(points[points.length - 1]) <= GeometryTolerance.COINCIDENT_POINT
      ) {
        points.pop();
      }
    }

    return { points, isClosed };
  }

  /**
   * Discretizes an IFCELLIPSE into 3D points based on its IFCAXIS2PLACEMENT3D / 2D and semi-axes rx, ry.
   */
  private extractEllipseCurve3DPoints(
    ellipseRec: StepRecord,
    trimStartRad?: number,
    trimEndRad?: number,
    senseAgreement: boolean = true
  ): { points: Vec3[]; isClosed: boolean } {
    const posParam = ellipseRec.params[IFC_GEOM_ATTRS.ELLIPSE_POSITION];
    const r1Param = ellipseRec.params[IFC_GEOM_ATTRS.ELLIPSE_SEMI_AXIS_1];
    const r2Param = ellipseRec.params[IFC_GEOM_ATTRS.ELLIPSE_SEMI_AXIS_2];
    const rawR1 = typeof r1Param === 'number' ? r1Param : parseFloat(String(r1Param || 0)) || 0;
    const rawR2 = typeof r2Param === 'number' ? r2Param : parseFloat(String(r2Param || 0)) || 0;
    const r1 = Math.abs(rawR1) * this.lengthUnitScale;
    const r2 = Math.abs(rawR2) * this.lengthUnitScale;

    if (r1 < GeometryTolerance.COINCIDENT_POINT || r2 < GeometryTolerance.COINCIDENT_POINT) {
      return { points: [], isClosed: false };
    }

    let origin = new Vec3(0, 0, 0);
    let dirX = new Vec3(1, 0, 0);
    let dirY = new Vec3(0, 1, 0);

    if (posParam && typeof posParam === 'object' && 'ref' in posParam) {
      const posRec = this.records.get(posParam.ref);
      if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
        const m = this.resolveAxis2Placement3D(posRec);
        origin = new Vec3(m.elements[12], m.elements[13], m.elements[14]);
        dirX = new Vec3(m.elements[0], m.elements[1], m.elements[2]).normalize();
        dirY = new Vec3(m.elements[4], m.elements[5], m.elements[6]).normalize();
      } else if (posRec && posRec.type === 'IFCAXIS2PLACEMENT2D') {
        const t2d = this.resolveAxis2Placement2D(posRec);
        origin = new Vec3(t2d.origin.x, t2d.origin.y, 0);
        dirX = new Vec3(t2d.dirX.x, t2d.dirX.y, 0);
        dirY = new Vec3(t2d.dirY.x, t2d.dirY.y, 0);
      }
    }

    const isFullEllipse = trimStartRad === undefined && trimEndRad === undefined;
    const start = trimStartRad !== undefined ? trimStartRad : 0;
    const end = trimEndRad !== undefined ? trimEndRad : Math.PI * 2;

    let sweep: number;
    if (trimStartRad !== undefined && trimEndRad !== undefined) {
      sweep = end - start;
      if (senseAgreement) {
        while (sweep <= 0) sweep += Math.PI * 2;
        while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
      } else {
        while (sweep >= 0) sweep -= Math.PI * 2;
        while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
      }
    } else {
      sweep = senseAgreement ? Math.PI * 2 : -Math.PI * 2;
    }

    const numSegments = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
    const points: Vec3[] = [];

    for (let i = 0; i <= numSegments; i++) {
      const t = i / numSegments;
      const theta = start + t * sweep;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      points.push(
        new Vec3(
          origin.x + r1 * cosT * dirX.x + r2 * sinT * dirY.x,
          origin.y + r1 * cosT * dirX.y + r2 * sinT * dirY.y,
          origin.z + r1 * cosT * dirX.z + r2 * sinT * dirY.z
        )
      );
    }

    let isClosed = false;
    if (isFullEllipse || Math.abs(Math.abs(sweep) - Math.PI * 2) < GeometryTolerance.POINT_ON_PLANE) {
      isClosed = true;
      if (
        points.length >= 4 &&
        points[0].distanceTo(points[points.length - 1]) <= GeometryTolerance.COINCIDENT_POINT
      ) {
        points.pop();
      }
    }

    return { points, isClosed };
  }

  /**
   * Discretizes a 3D circular arc defined by 3 points in cartesian space.
   */
  private discretize3PointArc3D(
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    segments: number = 12
  ): Vec3[] {
    const v1 = p2.sub(p1);
    const v2 = p3.sub(p1);
    const normal = v1.cross(v2);
    const nLen = normal.length();

    // Collinear or degenerate: cleanly degrade to polyline (Rule 11)
    if (nLen < GeometryTolerance.COINCIDENT_POINT) {
      return [p1, p2, p3];
    }

    // 3D circumscribed circle center
    const v1Sq = v1.lengthSq();
    const v2Sq = v2.lengthSq();
    const term = v2.scale(v1Sq).sub(v1.scale(v2Sq));
    const centerOffset = term.cross(normal).scale(1 / (2 * nLen * nLen));
    const center = p1.add(centerOffset);
    const radius = p1.distanceTo(center);

    if (radius < GeometryTolerance.COINCIDENT_POINT) {
      return [p1, p2, p3];
    }

    const ex = p1.sub(center).normalize();
    const ez = normal.scale(1 / nLen);
    const ey = ez.cross(ex).normalize();

    const a1 = 0;
    const rel2 = p2.sub(center);
    const rel3 = p3.sub(center);
    let a2 = Math.atan2(rel2.dot(ey), rel2.dot(ex));
    let a3 = Math.atan2(rel3.dot(ey), rel3.dot(ex));

    const normalizeAngle = (a: number, base: number) => {
      let diff = a - base;
      while (diff <= -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      return base + diff;
    };

    a2 = normalizeAngle(a2, a1);
    a3 = normalizeAngle(a3, a2);

    const result: Vec3[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = a1 + t * (a3 - a1);
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      result.push(
        new Vec3(
          center.x + radius * (cosA * ex.x + sinA * ey.x),
          center.y + radius * (cosA * ex.y + sinA * ey.y),
          center.z + radius * (cosA * ex.z + sinA * ey.z)
        )
      );
    }
    return result;
  }

  private extractPoint3D(param: StepParam): Vec3 | null {
    if (!param) return null;
    if (Array.isArray(param)) {
      for (const item of param) {
        const pt = this.extractPoint3D(item);
        if (pt) return pt;
      }
      return null;
    }
    if (typeof param === 'object' && 'ref' in param) {
      const ptRec = this.records.get((param as any).ref);
      if (ptRec && Array.isArray(ptRec.params[0])) {
        const c = ptRec.params[0].map((v: any) =>
          (typeof v === 'number' ? v : parseFloat(String(v)) || 0) * this.lengthUnitScale
        );
        if (c.length >= 3) return new Vec3(c[0], c[1], c[2]);
        if (c.length === 2) return new Vec3(c[0], c[1], 0);
      }
    }
    return null;
  }

  /**
   * Resolves the cumulative placement matrix in building space from an IFCLOCALPLACEMENT.
   * Isolates kilometric UTM projections and elevations above sea level from IfcSite to keep the model centered
   * at the local origin (0, 0, 0) and preserve 32-bit numerical precision in WebGL/Three.js.
   */
  private resolveLocalPlacementMatrix(placementRef: number, visited = new Set<number>()): THREE.Matrix4 {
    const cached = this.placementMatrixCache.get(placementRef);
    if (cached) {
      return cached.clone();
    }

    const mat = new THREE.Matrix4();
    if (visited.has(placementRef)) return mat;
    visited.add(placementRef);

    const placeRec = this.records.get(placementRef);
    if (!placeRec || placeRec.type !== 'IFCLOCALPLACEMENT') return mat;

    const relToParam = placeRec.params[0];
    const relPlacementParam = placeRec.params[1];

    let mLocal = new THREE.Matrix4();
    if (relPlacementParam && typeof relPlacementParam === 'object' && 'ref' in relPlacementParam) {
      const relRec = this.records.get(relPlacementParam.ref);
      if (relRec && relRec.type === 'IFCAXIS2PLACEMENT3D') {
        mLocal = this.resolveAxis2Placement3D(relRec);
      }
    }

    let mParent = new THREE.Matrix4();
    if (relToParam && typeof relToParam === 'object' && 'ref' in relToParam) {
      mParent = this.resolveLocalPlacementMatrix(relToParam.ref, visited);
    }

    const mCombined = new THREE.Matrix4().multiplyMatrices(mParent, mLocal);

    // If this placement belongs to IfcSite, capture cumulative world geodetic coordinates (Rule 22)
    // and neutralize translation to (0, 0, 0) to mitigate IEEE 754 precision loss in WebGL.
    if (this.sitePlacementRefs.has(placementRef)) {
      if (!this.siteGeoTranslationCaptured) {
        const el = mCombined.elements;
        this.capturedSiteTranslation = { x: el[12], y: el[13], z: el[14] };
        this.capturedSiteRotation = new THREE.Matrix4().extractRotation(mCombined);
        this.siteGeoTranslationCaptured = true;
      }
      mCombined.setPosition(0, 0, 0);
    }

    this.placementMatrixCache.set(placementRef, mCombined.clone());
    return mCombined;
  }

  /**
   * Converts an affine IFC placement matrix (Z-Up) to the CROQUERA coordinate system (Y-Up).
   * det(C) = +1. Preserves rotations, reflections, and scales (Rule 21, Rule 22).
   */
  public static convertIfcPlacementToCroquera(mIfc: THREE.Matrix4): THREE.Matrix4 {
    const C = new THREE.Matrix4().set(
      1,  0,  0, 0,
      0,  0,  1, 0,
      0, -1,  0, 0,
      0,  0,  0, 1
    );
    const C_inv = new THREE.Matrix4().set(
      1,  0,  0, 0,
      0,  0, -1, 0,
      0,  1,  0, 0,
      0,  0,  0, 1
    );
    return new THREE.Matrix4().multiplyMatrices(C, mIfc).multiply(C_inv);
  }

  /**
   * Builds an O(1) lightweight index mapping STEP element IDs to their associated IFCPROPERTYSET references.
   */
  private indexPsetRelations(): void {
    this.psetRelationsByElement.clear();
    const relDefinesList = this.parser.getRecordsByType('IFCRELDEFINESBYPROPERTIES');
    for (const rel of relDefinesList) {
      const relElements = rel.params[4];
      const relPsetRef = rel.params[5];
      if (Array.isArray(relElements) && relPsetRef && typeof relPsetRef === 'object' && 'ref' in relPsetRef) {
        const psetRef = (relPsetRef as any).ref;
        for (const el of relElements) {
          if (el && typeof el === 'object' && 'ref' in el) {
            const elId = (el as any).ref;
            let list = this.psetRelationsByElement.get(elId);
            if (!list) {
              list = [];
              this.psetRelationsByElement.set(elId, list);
            }
            list.push(psetRef);
          }
        }
      }
    }

    // IFCRELDEFINESBYTYPE (RelatingType -> RelatedObjects)
    const relDefinesTypes = this.parser.getRecordsByType('IFCRELDEFINESBYTYPE');
    for (const rel of relDefinesTypes) {
      const relElements = rel.params[4];
      const relTypeRef = rel.params[5];
      if (Array.isArray(relElements) && relTypeRef && typeof relTypeRef === 'object' && 'ref' in relTypeRef) {
        const typeId = (relTypeRef as any).ref;
        const typePsets = this.psetRelationsByElement.get(typeId) || [];
        const typeRec = this.records.get(typeId);
        const directPsets: number[] = [];
        if (typeRec) {
          for (const paramIdx of [5, 6]) {
            const pSetParam = typeRec.params[paramIdx];
            if (Array.isArray(pSetParam)) {
              for (const p of pSetParam) {
                if (p && typeof p === 'object' && 'ref' in p) directPsets.push((p as any).ref);
              }
            }
          }
        }
        const allTypePsetRefs = [...typePsets, ...directPsets];
        if (allTypePsetRefs.length > 0) {
          for (const el of relElements) {
            if (el && typeof el === 'object' && 'ref' in el) {
              const elId = (el as any).ref;
              let list = this.psetRelationsByElement.get(elId);
              if (!list) {
                list = [];
                this.psetRelationsByElement.set(elId, list);
              }
              for (const pRef of allTypePsetRefs) {
                if (!list.includes(pRef)) list.push(pRef);
              }
            }
          }
        }
      }
    }
  }

  /**
   * Pre-resolves Property Sets for spatial containers (IfcProject, IfcSite, IfcBuilding, IfcBuildingStorey).
   */
  private resolveSpatialContainerPsets(): void {
    for (const proj of this.parser.getRecordsByType('IFCPROJECT')) this.resolveElementProperties(proj.id);
    for (const site of this.parser.getRecordsByType('IFCSITE')) this.resolveElementProperties(site.id);
    for (const bldg of this.parser.getRecordsByType('IFCBUILDING')) this.resolveElementProperties(bldg.id);
    for (const storey of this.parser.getRecordsByType('IFCBUILDINGSTOREY')) this.resolveElementProperties(storey.id);
  }

  /**
   * Resolves and extracts Property Sets (Psets) and quantities on-demand for a specific STEP element ID.
   * Resolves in O(1) via pre-indexed psetRelationsByElement pointer lookup.
   */
  public resolveElementProperties(stepId: number): Record<string, Record<string, any>> {
    const cached = this.elemPsetsMap.get(stepId);
    if (cached && Object.keys(cached).length > 0) {
      return cached;
    }

    const psets: Record<string, Record<string, any>> = cached || {};
    const psetRefs = this.psetRelationsByElement.get(stepId) || [];

    for (const psetRefId of psetRefs) {
      const psetRec = this.records.get(psetRefId);
      if (!psetRec) continue;

      if (psetRec.type === 'IFCPROPERTYSET') {
        const psetName = this.getParamString(psetRec.params[2]) || 'Pset_Unknown';
        const propRefs = psetRec.params[4];
        if (!Array.isArray(propRefs)) continue;

        const psetValues: Record<string, any> = {};

        for (const pRef of propRefs) {
          if (!pRef || typeof pRef !== 'object' || !('ref' in pRef)) continue;
          const propRec = this.records.get(pRef.ref);
          if (!propRec || propRec.type !== 'IFCPROPERTYSINGLEVALUE') continue;

          const propName = this.getParamString(propRec.params[0]);
          if (!propName) continue;

          const nominal = propRec.params[2];
          let val: any = null;
          let valType: string = 'IfcLabel';

          if (nominal && typeof nominal === 'object' && 'params' in nominal) {
            val = nominal.params[0];
            const stepType = (nominal.type || '').toUpperCase();
            if (stepType === 'IFCLENGTHMEASURE') valType = 'IfcLengthMeasure';
            else if (stepType === 'IFCINTEGER') valType = 'IfcInteger';
            else if (stepType === 'IFCBOOLEAN') valType = 'IfcBoolean';
            else if (stepType === 'IFCREAL') valType = 'IfcReal';
            else if (stepType === 'IFCIDENTIFIER') valType = 'IfcIdentifier';
            else valType = 'IfcLabel';
          } else {
            val = nominal;
          }

          psetValues[propName] = { type: valType, value: val };
        }

        psets[psetName] = psetValues;
      } else if (psetRec.type === 'IFCELEMENTQUANTITY') {
        const qtoName = this.getParamString(psetRec.params[2]) || 'Qto_Quantities';
        const qRefs = psetRec.params[5];
        if (!Array.isArray(qRefs)) continue;

        const qtoValues: Record<string, any> = {};
        for (const qRef of qRefs) {
          if (!qRef || typeof qRef !== 'object' || !('ref' in qRef)) continue;
          const qRec = this.records.get(qRef.ref);
          if (!qRec) continue;
          const qName = this.getParamString(qRec.params[0]);
          if (!qName) continue;
          const qVal = this.getParamNumber(qRec.params[3], 0);
          const qType =
            qRec.type === 'IFCQUANTITYLENGTH'
              ? 'IfcLengthMeasure'
              : qRec.type === 'IFCQUANTITYAREA'
              ? 'IfcAreaMeasure'
              : qRec.type === 'IFCQUANTITYVOLUME'
              ? 'IfcVolumeMeasure'
              : qRec.type === 'IFCQUANTITYCOUNT'
              ? 'IfcCountMeasure'
              : 'IfcQuantity';
          qtoValues[qName] = { type: qType, value: qVal };
        }
        psets[qtoName] = qtoValues;
      }
    }

    // Rehydrate parametric formulas from Pset_CroqueraParametric / CroqueraParametric
    const parametricPset = psets['Pset_CroqueraParametric'] || psets['CroqueraParametric'] || psets['__CROQUERA_PARAMETRIC_RULES__'];
    if (parametricPset) {
      psets['__CROQUERA_PARAMETRIC_RULES__'] = parametricPset;
      for (const [propName, propObj] of Object.entries(parametricPset)) {
        const rawVal = propObj && typeof propObj === 'object' && 'value' in propObj ? propObj.value : propObj;
        let targetPset: string | undefined;
        let targetProp: string | undefined;
        let formulaStr: string | undefined;

        if (typeof rawVal === 'string' && rawVal.startsWith('{')) {
          try {
            const parsed = JSON.parse(rawVal);
            if (parsed && typeof parsed.formula === 'string') {
              formulaStr = parsed.formula;
              targetPset = parsed.psetName;
              targetProp = parsed.propertyName;
            }
          } catch { /* ignore JSON error */ }
        }

        if (!formulaStr) {
          formulaStr = typeof rawVal === 'string' ? rawVal : String(rawVal ?? '');
          if (propName.startsWith('Formula.') || propName.startsWith('Formula:')) {
            const cleanKey = propName.replace(/^Formula[:.]/, '');
            const dotIdx = cleanKey.lastIndexOf('.');
            if (dotIdx !== -1) {
              targetPset = cleanKey.slice(0, dotIdx);
              targetProp = cleanKey.slice(dotIdx + 1);
            }
          }
        }

        if (targetPset && targetProp && formulaStr) {
          if (!psets[targetPset]) {
            psets[targetPset] = {};
          }
          if (psets[targetPset][targetProp] && typeof psets[targetPset][targetProp] === 'object') {
            psets[targetPset][targetProp].value = formulaStr;
          } else {
            psets[targetPset][targetProp] = {
              type: 'IfcLabel',
              value: formulaStr,
            };
          }
        }
      }
    }

    const linksPset = psets['Pset_CroqueraLinks'] || psets['CroqueraLinks'];
    if (linksPset) {
      psets['__CROQUERA_PARAMETRIC_LINKS__'] = linksPset;
    }

    this.elemPsetsMap.set(stepId, psets);
    return psets;
  }

  /**
   * Extracts structural grid systems (IfcGrid / IfcGridAxis) defined in the IFC model.
   * Feeds the BuildingFramework with structural axes for 2D plans and 3D snapping.
   */
  public extractGrids(): IfcGridDTO[] {
    const gridRecords = this.parser.getRecordsByType('IFCGRID');
    const grids: IfcGridDTO[] = [];

    for (const gRec of gridRecords) {
      const rawGuid = this.getParamString(gRec.params[0]);
      const id = this.stepIdToEntityId.get(gRec.id) || (rawGuid && GuidUtils.isIfcGuid(rawGuid) ? rawGuid : GuidUtils.createIfcGuid());
      this.stepIdToEntityId.set(gRec.id, id);
      const name = this.getParamString(gRec.params[2]) || `Grid_${gRec.id}`;

      const uAxesParam = gRec.params[7];
      const vAxesParam = gRec.params[8];
      const wAxesParam = gRec.params[9];

      const parseAxisList = (param: any): IfcGridAxisDTO[] => {
        if (!Array.isArray(param)) return [];
        const result: IfcGridAxisDTO[] = [];
        for (const axisRef of param) {
          if (!axisRef || typeof axisRef !== 'object' || !('ref' in axisRef)) continue;
          const axisRec = this.records.get(axisRef.ref);
          if (!axisRec || axisRec.type !== 'IFCGRIDAXIS') continue;

          const tag = this.getParamString(axisRec.params[0]) || '';
          const sameSense = Boolean(axisRec.params[2]);
          const curveRef = axisRec.params[1];
          let uvStart: [number, number, number] = [0, 0, 0];
          let uvEnd: [number, number, number] = [0, 0, 0];

          if (curveRef && typeof curveRef === 'object' && 'ref' in curveRef) {
            const curveRec = this.records.get(curveRef.ref);
            if (curveRec) {
              if (curveRec.type === 'IFCLINE') {
                const pntRef = curveRec.params[0];
                const dirRef = curveRec.params[1];
                let pt = new Vec3(0, 0, 0);
                let dir = new Vec3(1, 0, 0);
                if (pntRef && typeof pntRef === 'object' && 'ref' in pntRef) {
                  const pRec = this.records.get(pntRef.ref);
                  if (pRec && Array.isArray(pRec.params[0])) {
                    pt = new Vec3(
                      this.getParamNumber(pRec.params[0][0], 0),
                      this.getParamNumber(pRec.params[0][1], 0),
                      this.getParamNumber(pRec.params[0][2], 0)
                    );
                  }
                }
                if (dirRef && typeof dirRef === 'object' && 'ref' in dirRef) {
                  const dRec = this.records.get(dirRef.ref);
                  if (dRec && dRec.type === 'IFCVECTOR') {
                    const dirVecRef = dRec.params[0];
                    const mag = this.getParamNumber(dRec.params[1], 10);
                    if (dirVecRef && typeof dirVecRef === 'object' && 'ref' in dirVecRef) {
                      const dvRec = this.records.get(dirVecRef.ref);
                      if (dvRec && Array.isArray(dvRec.params[0])) {
                        dir = new Vec3(
                          this.getParamNumber(dvRec.params[0][0], 1),
                          this.getParamNumber(dvRec.params[0][1], 0),
                          this.getParamNumber(dvRec.params[0][2], 0)
                        ).scale(mag);
                      }
                    }
                  }
                }
                uvStart = [pt.x - dir.x * 20, pt.y - dir.y * 20, pt.z - dir.z * 20];
                uvEnd = [pt.x + dir.x * 20, pt.y + dir.y * 20, pt.z + dir.z * 20];
              } else if (curveRec.type === 'IFCPOLYLINE') {
                const ptsRef = curveRec.params[0];
                if (Array.isArray(ptsRef) && ptsRef.length >= 2) {
                  const p0Ref = (ptsRef[0] as any)?.ref;
                  const p1Ref = (ptsRef[ptsRef.length - 1] as any)?.ref;
                  const p0Rec = typeof p0Ref === 'number' ? this.records.get(p0Ref) : undefined;
                  const p1Rec = typeof p1Ref === 'number' ? this.records.get(p1Ref) : undefined;
                  if (p0Rec && p1Rec && Array.isArray(p0Rec.params[0]) && Array.isArray(p1Rec.params[0])) {
                    uvStart = [
                      this.getParamNumber(p0Rec.params[0][0], 0),
                      this.getParamNumber(p0Rec.params[0][1], 0),
                      this.getParamNumber(p0Rec.params[0][2], 0),
                    ];
                    uvEnd = [
                      this.getParamNumber(p1Rec.params[0][0], 0),
                      this.getParamNumber(p1Rec.params[0][1], 0),
                      this.getParamNumber(p1Rec.params[0][2], 0),
                    ];
                  }
                }
              }
            }
          }

          result.push({
            tag,
            sameSense,
            uvStart,
            uvEnd,
          });
        }
        return result;
      };

      grids.push({
        id,
        stepId: gRec.id,
        name,
        uAxes: parseAxisList(uAxesParam),
        vAxes: parseAxisList(vAxesParam),
        wAxes: wAxesParam ? parseAxisList(wAxesParam) : undefined,
      });
    }

    return grids;
  }

  /**
   * Extracts cached 3D volumetric opening meshes and their host/filler relational links (Phase 6 - Bloque 3.3).
   * Used by Croquera editor post-process for interactive MoveTool / PushPullOpeningTool boolean recalculations.
   */
  public extractCachedOpenings(): CachedOpeningDTO[] {
    const openings: CachedOpeningDTO[] = [];

    for (const [opStepId, cached] of this.openingMeshCache.entries()) {
      if (!cached || !cached.polyMesh || cached.polyMesh.faces.size === 0) continue;

      const hostStepId = this.openingToHostStepMap.get(opStepId);
      const hostGuid = hostStepId ? this.stepIdToEntityId.get(hostStepId) : undefined;

      // Find if any filler (door/window) fills this opening
      let fillerStepId: number | undefined;
      let fillerGuid: string | undefined;
      for (const [fStepId, oStepId] of this.fillToOpeningStepMap.entries()) {
        if (oStepId === opStepId) {
          fillerStepId = fStepId;
          fillerGuid = this.stepIdToEntityId.get(fStepId);
          break;
        }
      }

      // Matrix4 identity (volumes are reconstructed in world/project space)
      const matrix = new Float32Array(16);
      new THREE.Matrix4().identity().toArray(matrix);

      openings.push({
        openingGuid: cached.id,
        openingStepId: opStepId,
        hostStepId,
        hostGuid,
        fillerStepId,
        fillerGuid,
        matrix,
        volumeIR: cached.polyMesh.toGeometryIR(),
      });
    }

    return openings;
  }

  public getOpeningToHostStepMap(): Map<number, number> {
    return this.openingToHostStepMap;
  }

  public getFillToOpeningStepMap(): Map<number, number> {
    return this.fillToOpeningStepMap;
  }

  public getRecord(stepId: number): StepRecord | undefined {
    return this.records.get(stepId);
  }

  /**
   * Hydrates a complete, editable 2-manifold B-Rep PolyMesh for a given STEP element ID.
   * Carves openings if it's a host element and coalesces coplanar faces into architectural N-gons.
   */
  public hydrateBrepMesh(stepId: number, coalesceFaces: boolean = true): { id: string; polyMesh: PolyMesh } | null {
    const rec = this.records.get(stepId);
    if (!rec) return null;

    const evaluated = this.rebuildProductEntity(rec, null, this.elemPsetsMap.get(stepId));
    if (!evaluated || !evaluated.polyMesh || evaluated.polyMesh.faces.size === 0) return null;

    // Carve openings if this element is a host (e.g. wall, slab)
    this.carveOpeningsIntoMesh(stepId, evaluated.polyMesh);

    // Coalesce coplanar faces into original architectural N-gons if requested
    if (coalesceFaces) {
      evaluated.polyMesh.coalesceCoplanarFaces();
    }

    return {
      id: evaluated.id,
      polyMesh: evaluated.polyMesh,
    };
  }



  private getParamString(p: StepParam): string | null {
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object' && 'params' in p && typeof p.params[0] === 'string') {
      return p.params[0];
    }
    return null;
  }

  private getParamNumber(p: StepParam, fallback: number): number {
    if (typeof p === 'number') return p;
    if (typeof p === 'string') {
      const n = parseFloat(p);
      return Number.isFinite(n) ? n : fallback;
    }
    if (p && typeof p === 'object' && 'params' in p && typeof p.params[0] === 'number') {
      return p.params[0];
    }
    return fallback;
  }

  /**
   * Extracts formal LoGeoRef 50 georeferencing parameters (IFC 4.3).
   * Resolves IFCGEOMETRICREPRESENTATIONCONTEXT, IFCMAPCONVERSION, and IFCPROJECTEDCRS.
   */
  private extractGeorefFromContext(): void {
    if (this.extractedGeoref) return;

    const contexts = this.parser.getRecordsByType('IFCGEOMETRICREPRESENTATIONCONTEXT');
    if (contexts.length === 0) return;

    // Prioritize main geometric context whose ContextType is 'Model'
    const targetContext = contexts.find((c) => {
      const typeStr = this.getParamString(c.params[1]);
      return typeStr && typeStr.toLowerCase() === 'model';
    }) || contexts[0];

    // 1. Extract TrueNorth from context
    let trueNorthX = 0.0;
    let trueNorthY = 1.0;
    const tnParam = targetContext.params[5];
    if (tnParam && typeof tnParam === 'object' && 'ref' in tnParam) {
      const dirRec = this.records.get((tnParam as { ref: number }).ref);
      if (dirRec && dirRec.type === 'IFCDIRECTION' && Array.isArray(dirRec.params[0])) {
        const coords = dirRec.params[0].map((v: any) =>
          typeof v === 'number' ? v : parseFloat(String(v)) || 0
        );
        if (coords.length >= 2) {
          trueNorthX = coords[0];
          trueNorthY = coords[1];
        }
      }
    }

    if (Math.abs(trueNorthX) > 1e-6 || Math.abs(trueNorthY - 1.0) > 1e-6) {
      this.extractedTrueNorth = { x: trueNorthX, y: trueNorthY };
    }

    // 2. Search coordinate operations (inverse relationship HasCoordinateOperation)
    const mapConversions = [
      ...this.parser.getRecordsByType('IFCMAPCONVERSION'),
      ...this.parser.getRecordsByType('IFCMAPCONVERSIONSCALED'),
      ...this.parser.getRecordsByType('IFCRIGIDOPERATION'),
    ];

    let opRec: StepRecord | undefined;
    for (const op of mapConversions) {
      const sourceCrsParam = op.params[0];
      if (
        sourceCrsParam &&
        typeof sourceCrsParam === 'object' &&
        'ref' in sourceCrsParam &&
        (sourceCrsParam as { ref: number }).ref === targetContext.id
      ) {
        opRec = op;
        break;
      }
    }

    if (!opRec && mapConversions.length > 0) {
      opRec = mapConversions[0];
    }

    if (!opRec) {
      return;
    }

    // 3. Extract numerical parameters from MapConversion
    const eastings = this.getParamNumber(opRec.params[2], 0.0);
    const northings = this.getParamNumber(opRec.params[3], 0.0);
    const orthogonalHeight = this.getParamNumber(opRec.params[4], 0.0);
    const xAxisAbscissa = this.getParamNumber(opRec.params[5], 1.0);
    const xAxisOrdinate = this.getParamNumber(opRec.params[6], 0.0);
    const scale = this.getParamNumber(opRec.params[7], 1.0);

    // 4. Extract IFCPROJECTEDCRS
    let crsName: string | null = null;
    let crsDescription: string | null = null;
    let geodeticDatum: string | null = null;
    let verticalDatum: string | null = null;
    let mapProjection: string | null = null;
    let mapZone: string | null = null;
    let mapUnit: string | null = 'METRE';

    const targetCrsParam = opRec.params[1];
    if (targetCrsParam && typeof targetCrsParam === 'object' && 'ref' in targetCrsParam) {
      const crsRec = this.records.get((targetCrsParam as { ref: number }).ref);
      if (crsRec && crsRec.type === 'IFCPROJECTEDCRS') {
        crsName = this.getParamString(crsRec.params[0]);
        crsDescription = this.getParamString(crsRec.params[1]);
        geodeticDatum = this.getParamString(crsRec.params[2]);
        verticalDatum = this.getParamString(crsRec.params[3]);
        mapProjection = this.getParamString(crsRec.params[4]);
        mapZone = this.getParamString(crsRec.params[5]);

        const unitParam = crsRec.params[6];
        if (unitParam && typeof unitParam === 'object' && 'ref' in unitParam) {
          const unitRec = this.records.get((unitParam as { ref: number }).ref);
          if (unitRec) {
            if (unitRec.type === 'IFCSIUNIT') {
              const uName = this.getParamEnumOrString(unitRec.params[3]);
              if (uName) mapUnit = uName.replace(/^\./, '').replace(/\.$/, '');
            } else if (unitRec.type === 'IFCCONVERSIONBASEDUNIT') {
              mapUnit = this.getParamString(unitRec.params[2]);
            }
          }
        }
      }
    }

    this.extractedGeoref = {
      crsName,
      crsDescription,
      geodeticDatum,
      verticalDatum,
      mapProjection,
      mapZone,
      mapUnit,
      eastings,
      northings,
      orthogonalHeight,
      xAxisAbscissa,
      xAxisOrdinate,
      scale,
      trueNorthX,
      trueNorthY,
    };
  }

  /**
   * Consolidates final georeferencing considering formal LoGeoRef 50
   * or IfcSite geodetic translation fallback.
   */
  public finalizeGeoref(): GeorefData | null {
    if (this.extractedGeoref) {
      if (
        this.extractedTrueNorth &&
        this.extractedGeoref.trueNorthX !== undefined &&
        this.extractedGeoref.trueNorthY !== undefined &&
        Math.abs(this.extractedGeoref.trueNorthX) < 1e-6 &&
        Math.abs(this.extractedGeoref.trueNorthY - 1.0) < 1e-6
      ) {
        this.extractedGeoref.trueNorthX = this.extractedTrueNorth.x;
        this.extractedGeoref.trueNorthY = this.extractedTrueNorth.y;
      }
      return this.extractedGeoref;
    }

    if (this.siteGeoTranslationCaptured) {
      const { x, y, z } = this.capturedSiteTranslation;
      const hasTranslation = Math.abs(x) > 1e-4 || Math.abs(y) > 1e-4 || Math.abs(z) > 1e-4;

      if (hasTranslation) {
        const rotEl = this.capturedSiteRotation.elements;
        const xAxisAbscissa = rotEl[0];
        const xAxisOrdinate = rotEl[1];

        this.extractedGeoref = {
          crsName: null,
          crsDescription: 'Coordenadas geodésicas capturadas de IfcSite',
          geodeticDatum: null,
          verticalDatum: null,
          mapProjection: null,
          mapZone: null,
          mapUnit: 'METRE',
          eastings: x,
          northings: y,
          orthogonalHeight: z,
          xAxisAbscissa: Number.isFinite(xAxisAbscissa) ? xAxisAbscissa : 1.0,
          xAxisOrdinate: Number.isFinite(xAxisOrdinate) ? xAxisOrdinate : 0.0,
          scale: 1.0,
          trueNorthX: this.extractedTrueNorth?.x ?? 0.0,
          trueNorthY: this.extractedTrueNorth?.y ?? 1.0,
        };
        return this.extractedGeoref;
      }
    }

    // If there was no IfcSite translation nor formal MapConversion, but a rotated TrueNorth in context exists:
    if (this.extractedTrueNorth) {
      this.extractedGeoref = {
        crsName: null,
        crsDescription: 'TrueNorth orientation from GeometricRepresentationContext',
        geodeticDatum: null,
        verticalDatum: null,
        mapProjection: null,
        mapZone: null,
        mapUnit: 'METRE',
        eastings: 0.0,
        northings: 0.0,
        orthogonalHeight: 0.0,
        xAxisAbscissa: 1.0,
        xAxisOrdinate: 0.0,
        scale: 1.0,
        trueNorthX: this.extractedTrueNorth.x,
        trueNorthY: this.extractedTrueNorth.y,
      };
      return this.extractedGeoref;
    }

    return null;
  }

  public getExtractedGeoref(): GeorefData | null {
    return this.finalizeGeoref();
  }

  private extractEnumString(param: StepParam | undefined): string | null {
    if (!param) return null;
    if (typeof param === 'object' && 'enum' in param && param.enum) {
      return param.enum;
    }
    if (typeof param === 'string') {
      const clean = param.replace(/\./g, '').trim();
      if (clean && clean !== '$' && clean !== '*') return clean;
    }
    return null;
  }

  private getPredefinedType(rec: StepRecord): string | null {
    if (rec.type === 'IFCDOOR' || rec.type === 'IFCDOORSTANDARDCASE') {
      const opParam = rec.params[11];
      const opType = this.extractEnumString(opParam);
      if (opType) return opType;

      const predParam = rec.params[10];
      const predType = this.extractEnumString(predParam);
      if (predType) return predType;
    }

    if (rec.type === 'IFCDOORTYPE' || rec.type === 'IFCDOORSTYLE') {
      const opParam = rec.params[11] ?? rec.params[10];
      const opType = this.extractEnumString(opParam);
      if (opType) return opType;

      const predParam = rec.params[9];
      const predType = this.extractEnumString(predParam);
      if (predType) return predType;
    }

    // Last parameter is usually PredefinedType if it is an enum
    const last = rec.params[rec.params.length - 1];
    if (last && typeof last === 'object' && 'enum' in last) {
      return last.enum;
    }
    return null;
  }

  /**
   * O(N) pre-pass to index presentation styles and instantiate relational materials.
   * Resolves the buildingSMART chain:
   * IFCSTYLEDITEM -> [IFCPRESENTATIONSTYLEASSIGNMENT] -> IFCSURFACESTYLE -> IFCSURFACESTYLERENDERING / IFCSURFACESTYLESHADING -> IFCCOLOURRGB
   */
  private parseStyledItems(): {
    itemToStyleMap: Map<number, string>;
    faceToStyleMap: Map<number, string>;
  } {
    const itemToStyleMap = new Map<number, string>();
    const faceToStyleMap = new Map<number, string>();

    const styledItemRecords = this.parser.getRecordsByType('IFCSTYLEDITEM');
    if (styledItemRecords.length === 0) {
      return { itemToStyleMap, faceToStyleMap };
    }

    const resolvedStyleMap = new Map<number, string>();

    for (const styledRec of styledItemRecords) {
      const itemParam = styledRec.params[0];
      const stylesParam = styledRec.params[1];
      if (!itemParam || typeof itemParam !== 'object' || !('ref' in itemParam)) continue;
      if (!stylesParam) continue;

      const styleRefs: number[] = [];
      if (Array.isArray(stylesParam)) {
        for (const s of stylesParam) {
          if (s && typeof s === 'object' && 'ref' in s) styleRefs.push(s.ref);
        }
      } else if (typeof stylesParam === 'object' && 'ref' in stylesParam) {
        styleRefs.push(stylesParam.ref);
      }

      let materialId: string | null = null;

      for (const sRef of styleRefs) {
        if (resolvedStyleMap.has(sRef)) {
          materialId = resolvedStyleMap.get(sRef)!;
          break;
        }

        const candidateRec = this.records.get(sRef);
        if (!candidateRec) continue;

        let surfaceStyleRec: StepRecord | null = null;

        if (candidateRec.type === 'IFCPRESENTATIONSTYLEASSIGNMENT') {
          const list = candidateRec.params[0];
          if (Array.isArray(list)) {
            for (const sub of list) {
              if (sub && typeof sub === 'object' && 'ref' in sub) {
                const subRec = this.records.get(sub.ref);
                if (subRec && subRec.type === 'IFCSURFACESTYLE') {
                  surfaceStyleRec = subRec;
                  break;
                }
              }
            }
          }
        } else if (candidateRec.type === 'IFCSURFACESTYLE') {
          surfaceStyleRec = candidateRec;
        }

        if (surfaceStyleRec) {
          materialId = this.resolveSurfaceStyleToMaterial(surfaceStyleRec);
          if (materialId) {
            resolvedStyleMap.set(sRef, materialId);
            resolvedStyleMap.set(surfaceStyleRec.id, materialId);
            break;
          }
        }
      }

      if (materialId) {
        const itemStepId = itemParam.ref as number;
        itemToStyleMap.set(itemStepId, materialId);
        faceToStyleMap.set(itemStepId, materialId);
      }
    }

    return { itemToStyleMap, faceToStyleMap };
  }

  private resolveSurfaceStyleToMaterial(styleRec: StepRecord): string | null {
    const styleName = this.getParamString(styleRec.params[0]) || undefined;
    if (styleName) {
      for (const m of this.materialCatalog.values()) {
        if (m.name && m.name.toLowerCase() === styleName.toLowerCase()) {
          return m.id;
        }
      }
    }
    const styleElements = styleRec.params[2];
    if (!Array.isArray(styleElements)) return null;

    for (const elRef of styleElements) {
      if (!elRef || typeof elRef !== 'object' || !('ref' in elRef)) continue;
      const elRec = this.records.get(elRef.ref);
      if (!elRec) continue;

      if (elRec.type === 'IFCSURFACESTYLERENDERING' || elRec.type === 'IFCSURFACESTYLESHADING') {
        const colorParam = elRec.params[0];
        let baseColor = '#D4D4D8';

        if (colorParam && typeof colorParam === 'object') {
          let colorRec: StepRecord | null = null;
          if ('ref' in colorParam) {
            colorRec = this.records.get(colorParam.ref) || null;
          } else if ((colorParam as any).type === 'IFCCOLOURRGB') {
            colorRec = colorParam as any;
          }

          if (colorRec && colorRec.type === 'IFCCOLOURRGB') {
            const r = Number(colorRec.params[1]) || 0;
            const g = Number(colorRec.params[2]) || 0;
            const b = Number(colorRec.params[3]) || 0;
            const rByte = Math.max(0, Math.min(255, Math.round(r * 255)));
            const gByte = Math.max(0, Math.min(255, Math.round(g * 255)));
            const bByte = Math.max(0, Math.min(255, Math.round(b * 255)));
            baseColor = `#${((1 << 24) + (rByte << 16) + (gByte << 8) + bByte).toString(16).slice(1).toUpperCase()}`;
          }
        }

        const transParam = elRec.params[1];
        let opacity = 1.0;
        if (typeof transParam === 'number' || typeof transParam === 'string') {
          const trans = parseFloat(String(transParam)) || 0;
          opacity = Math.max(0, Math.min(1, 1.0 - trans));
        }

        return this.getOrCreateWorkerMaterial(baseColor, styleName, 0.5, 0.0, opacity);
      }
    }

    return null;
  }

  private getOrCreateWorkerMaterial(
    baseColor: string,
    name?: string,
    roughness = 0.5,
    metalness = 0.0,
    opacity = 1.0,
    textureBlob?: string | null,
    textureMime?: string | null
  ): string {
    const cleanHex = baseColor.toLowerCase();
    const clampedOpacity = Math.max(0, Math.min(1, opacity));
    const isTrans = clampedOpacity < 0.999;
    const defaultId = isTrans
      ? `mat_ifc_${cleanHex.replace('#', '')}_a${Math.round(clampedOpacity * 100)}`
      : `mat_ifc_${cleanHex.replace('#', '')}`;

    const sig = `${cleanHex}_${clampedOpacity}_${roughness}_${metalness}_${textureBlob ? 'tex' : 'notex'}`;
    for (const [id, m] of this.materialCatalog.entries()) {
      const mSig = `${m.baseColor.toLowerCase()}_${m.opacity}_${m.roughness}_${m.metalness}_${m.textureBlob ? 'tex' : 'notex'}`;
      if (mSig === sig) return id;
    }

    const id = textureBlob ? `${defaultId}_tex_${this.materialCatalog.size}` : defaultId;
    const rec: MaterialRecord = {
      id,
      name: name || `Material ${cleanHex}`,
      baseColor: cleanHex,
      colorHex: cleanHex,
      roughness,
      metalness,
      opacity: clampedOpacity,
      textureBlob: textureBlob || null,
      textureMime: textureMime || null,
    };
    this.materialCatalog.set(id, rec);

    return id;
  }

  /**
   * Imports and rehydrates PBR materials defined in the STEP file.
   * Returns a map from element StepId to MaterialRecord ID.
   */
  private importMaterials(_db?: any): Map<number, string> {
    const elemToMatIdMap = new Map<number, string>();
    const relMaterials = this.parser.getRecordsByType('IFCRELASSOCIATESMATERIAL');
    if (relMaterials.length === 0) return elemToMatIdMap;

    // Cache of materialStepId -> MaterialRecord.id
    const resolvedMaterialMap = new Map<number, string>();

    for (const rel of relMaterials) {
      const relElements = rel.params[4];
      const relMaterialParam = rel.params[5];

      if (!relMaterialParam || typeof relMaterialParam !== 'object' || !('ref' in relMaterialParam)) {
        continue;
      }

      const matStepRef = relMaterialParam.ref as number;
      let targetMatId = resolvedMaterialMap.get(matStepRef);

      if (!targetMatId) {
        const matRecord = this.resolveMaterialRecord(matStepRef);
        if (matRecord) {
          targetMatId = matRecord.id;
          resolvedMaterialMap.set(matStepRef, targetMatId);
        }
      }

      if (targetMatId && Array.isArray(relElements)) {
        for (const el of relElements) {
          if (el && typeof el === 'object' && 'ref' in el && typeof el.ref === 'number') {
            elemToMatIdMap.set(el.ref, targetMatId);
          }
        }
      }
    }

    return elemToMatIdMap;
  }

  /**
   * Recursively resolves a material definition from its STEP reference.
   */
  private resolveMaterialRecord(matStepRef: number, __db?: any): MaterialRecord | null {
    const rec = this.records.get(matStepRef);
    if (!rec) return null;

    let targetMatRec: StepRecord | null = null;

    if (rec.type === 'IFCMATERIAL') {
      targetMatRec = rec;
    } else if (rec.type === 'IFCMATERIALLAYERSETUSAGE' || rec.type === 'IFCMATERIALLAYERSET') {
      const layerSet =
        rec.type === 'IFCMATERIALLAYERSET'
          ? rec
          : rec.params[0] && typeof rec.params[0] === 'object' && 'ref' in rec.params[0]
            ? this.records.get(rec.params[0].ref)
            : null;
      if (layerSet && Array.isArray(layerSet.params[0]) && layerSet.params[0].length > 0) {
        const firstLayerRef = layerSet.params[0][0];
        if (firstLayerRef && typeof firstLayerRef === 'object' && 'ref' in firstLayerRef) {
          const layerRec = this.records.get(firstLayerRef.ref);
          if (layerRec && layerRec.params[0] && typeof layerRec.params[0] === 'object' && 'ref' in layerRec.params[0]) {
            targetMatRec = this.records.get(layerRec.params[0].ref) || null;
          }
        }
      }
    } else if (rec.type === 'IFCMATERIALCONSTITUENTSET') {
      const constituents = rec.params[2] || rec.params[1];
      if (Array.isArray(constituents) && constituents.length > 0) {
        const firstRef = constituents[0];
        if (firstRef && typeof firstRef === 'object' && 'ref' in firstRef) {
          const constRec = this.records.get(firstRef.ref);
          if (constRec) {
            const matRefParam = constRec.params[2] || constRec.params[1];
            if (matRefParam && typeof matRefParam === 'object' && 'ref' in matRefParam) {
              targetMatRec = this.records.get(matRefParam.ref) || null;
            }
          }
        }
      }
    }

    const matName = targetMatRec ? this.getParamString(targetMatRec.params[0]) || 'Material' : 'Material';
    const matCategory = targetMatRec ? this.getParamString(targetMatRec.params[2]) || 'other' : 'other';

    // Search associated IFCSURFACESTYLE
    let surfaceStyleRec: StepRecord | null = null;

    // 1. Via IFCMATERIALDEFINITIONREPRESENTATION
    const defReps = this.parser.getRecordsByType('IFCMATERIALDEFINITIONREPRESENTATION');
    for (const defRep of defReps) {
      const repMatParam = defRep.params[3];
      if (
        repMatParam &&
        typeof repMatParam === 'object' &&
        'ref' in repMatParam &&
        repMatParam.ref === (targetMatRec ? targetMatRec.id : matStepRef)
      ) {
        const repsParam = defRep.params[2];
        if (Array.isArray(repsParam) && repsParam.length > 0) {
          for (const styleRef of repsParam) {
            if (!styleRef || typeof styleRef !== 'object' || !('ref' in styleRef)) continue;
            const candidate = this.records.get(styleRef.ref);
            if (!candidate) continue;

            if (candidate.type === 'IFCSURFACESTYLE') {
              surfaceStyleRec = candidate;
              break;
            } else if (candidate.type === 'IFCSTYLEDREPRESENTATION') {
              // Navigate Items (params[3]) -> StyledItem (params[1]) -> SurfaceStyle (M-7)
              const itemsParam = candidate.params[3];
              if (Array.isArray(itemsParam)) {
                for (const itRef of itemsParam) {
                  if (!itRef || typeof itRef !== 'object' || !('ref' in itRef)) continue;
                  const itemRec = this.records.get(itRef.ref);
                  if (itemRec && itemRec.type === 'IFCSTYLEDITEM') {
                    const stylesParam = itemRec.params[1];
                    const stylesList = Array.isArray(stylesParam)
                      ? stylesParam
                      : (stylesParam && typeof stylesParam === 'object' && 'ref' in stylesParam ? [stylesParam] : []);
                    for (const sRef of stylesList) {
                      if (!sRef || typeof sRef !== 'object' || !('ref' in sRef)) continue;
                      const sRec = this.records.get(sRef.ref);
                      if (sRec && sRec.type === 'IFCSURFACESTYLE') {
                        surfaceStyleRec = sRec;
                        break;
                      }
                    }
                  }
                  if (surfaceStyleRec) break;
                }
              }
            }
            if (surfaceStyleRec) break;
          }
        }
      }
      if (surfaceStyleRec) break;
    }

    // 2. If not found, search by exact IFCSURFACESTYLE name
    if (!surfaceStyleRec) {
      const allStyles = this.parser.getRecordsByType('IFCSURFACESTYLE');
      for (const s of allStyles) {
        if (this.getParamString(s.params[0]) === matName) {
          surfaceStyleRec = s;
          break;
        }
      }
    }

    let baseColor = '#D4D4D8';
    let opacity = 1.0;
    let roughness = 0.7;
    let metalness = 0.05;
    let effectiveCategory: string | undefined = matCategory !== 'other' ? matCategory : undefined;
    let textureBlob: string | null = null;
    let textureMime: string | null = null;

    if (surfaceStyleRec) {
      const styleElements = surfaceStyleRec.params[2];
      if (Array.isArray(styleElements)) {
        for (const elRef of styleElements) {
          if (!elRef || typeof elRef !== 'object' || !('ref' in elRef)) continue;
          const elRec = this.records.get(elRef.ref);
          if (!elRec) continue;

          if (elRec.type === 'IFCSURFACESTYLEWITHTEXTURES') {
            const texturesParam = elRec.params[0];
            const texList = Array.isArray(texturesParam)
              ? texturesParam
              : texturesParam && typeof texturesParam === 'object' && 'ref' in texturesParam
                ? [texturesParam]
                : [];
            for (const tRef of texList) {
              if (!tRef || typeof tRef !== 'object' || !('ref' in tRef)) continue;
              const texRec = this.records.get(tRef.ref);
              if (!texRec) continue;
              if (texRec.type === 'IFCBLOBTEXTURE') {
                const mime = this.getParamString(texRec.params[3]) || 'image/jpeg';
                const rawBase64 = this.getParamString(texRec.params[4]) || '';
                if (rawBase64) {
                  textureMime = mime;
                  textureBlob = rawBase64.startsWith('data:') ? rawBase64 : `data:${mime};base64,${rawBase64}`;
                  break;
                }
              } else if (texRec.type === 'IFCIMAGETEXTURE') {
                const loc = this.getParamString(texRec.params[3]);
                if (loc) {
                  textureMime = 'image/jpeg';
                  textureBlob = loc;
                  break;
                }
              }
            }
          }

          if (elRec.type === 'IFCSURFACESTYLERENDERING' || elRec.type === 'IFCSURFACESTYLESHADING') {
            // RGB Color
            const colorParam = elRec.params[0];
            if (colorParam && typeof colorParam === 'object' && 'ref' in colorParam) {
              const colorRec = this.records.get(colorParam.ref);
              if (colorRec && colorRec.type === 'IFCCOLOURRGB') {
                const r = Number(colorRec.params[1]) || 0;
                const g = Number(colorRec.params[2]) || 0;
                const b = Number(colorRec.params[3]) || 0;
                const rByte = Math.max(0, Math.min(255, Math.round(r * 255)));
                const gByte = Math.max(0, Math.min(255, Math.round(g * 255)));
                const bByte = Math.max(0, Math.min(255, Math.round(b * 255)));
                baseColor = `#${((1 << 24) + (rByte << 16) + (gByte << 8) + bByte).toString(16).slice(1).toUpperCase()}`;
              }
            }

            // Transparency -> Opacity
            const transParam = elRec.params[1];
            if (typeof transParam === 'number' || typeof transParam === 'string') {
              const trans = parseFloat(String(transParam)) || 0;
              opacity = Number(Math.max(0, Math.min(1, 1.0 - trans)).toFixed(3));
              if (opacity < 0.99) {
                roughness = 0.1;
                metalness = 0.1;
                if (!effectiveCategory) effectiveCategory = 'glass';
              }
            }

            // Texture
            if (elRec.type === 'IFCSURFACESTYLERENDERING' && elRec.params.length > 9) {
              const texParam = elRec.params[9];
              if (texParam && typeof texParam === 'object' && 'ref' in texParam) {
                const texRec = this.records.get(texParam.ref);
                if (texRec && texRec.type === 'IFCBLOBTEXTURE') {
                  const mime = this.getParamString(texRec.params[3]) || 'image/jpeg';
                  const rawBase64 = this.getParamString(texRec.params[4]) || '';
                  if (rawBase64) {
                    textureMime = mime;
                    textureBlob = rawBase64.startsWith('data:') ? rawBase64 : `data:${mime};base64,${rawBase64}`;
                  }
                } else if (texRec && texRec.type === 'IFCIMAGETEXTURE') {
                  const loc = this.getParamString(texRec.params[3]);
                  if (loc) {
                    textureMime = 'image/jpeg';
                    textureBlob = loc;
                  }
                }
              }
            }
          }
        }
      }
    } else {
      // Inferencia semántica universal cuando el archivo STEP omite IFCSURFACESTYLE
      const inferred = this.inferPbrFromMaterialMetadata(matName, matCategory);
      baseColor = inferred.baseColor;
      opacity = inferred.opacity;
      roughness = inferred.roughness;
      metalness = inferred.metalness;
      if (!effectiveCategory) {
        effectiveCategory = inferred.category;
      }
    }

    const cleanName = matName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const cleanHex = baseColor.toLowerCase();
    const clampedOpacity = Math.max(0, Math.min(1, opacity));
    const alphaSuffix = clampedOpacity < 0.99 ? `_a${Math.round(clampedOpacity * 100)}` : '';
    const matId = textureBlob
      ? `mat_${cleanName}_${cleanHex.replace('#', '')}_${matStepRef}`
      : `mat_${cleanName}_${cleanHex.replace('#', '')}${alphaSuffix}`;

    const existing = this.materialCatalog.get(matId);
    if (existing) {
      return existing;
    }

    const materialRecord: MaterialRecord = {
      id: matId,
      name: matName,
      category: effectiveCategory,
      baseColor,
      colorHex: baseColor,
      roughness,
      metalness,
      opacity: clampedOpacity,
      transparent: clampedOpacity < 0.99,
      textureBlob,
      textureMime,
    };

    this.materialCatalog.set(materialRecord.id, materialRecord);
    return materialRecord;
  }

  /**
   * Infers physically plausible PBR parameters (color, roughness, metalness, opacity, transparency)
   * from the lexical name and category of an IfcMaterial when explicit IfcSurfaceStyle is omitted.
   * Universal, deterministic architectural classifier.
   */
  private inferPbrFromMaterialMetadata(
    matName: string,
    matCategory?: string
  ): {
    baseColor: string;
    roughness: number;
    metalness: number;
    opacity: number;
    transparent: boolean;
    category?: string;
  } {
    const raw = `${matName} ${matCategory || ''}`.toLowerCase();

    // 1. Glass & Glazing
    if (
      raw.includes('glass') ||
      raw.includes('glaz') ||
      raw.includes('vidrio') ||
      raw.includes('cristal') ||
      raw.includes('low-e')
    ) {
      return {
        baseColor: '#A5C8E1',
        roughness: 0.1,
        metalness: 0.1,
        opacity: 0.35,
        transparent: true,
        category: 'glass',
      };
    }

    // 2. Concrete, Cement, Mortar, Grout
    if (
      raw.includes('concrete') ||
      raw.includes('cip') ||
      raw.includes('hormigon') ||
      raw.includes('hormigón') ||
      raw.includes('concreto') ||
      raw.includes('mortar') ||
      raw.includes('mortero') ||
      raw.includes('cement') ||
      raw.includes('grout')
    ) {
      return {
        baseColor: '#9CA3AF',
        roughness: 0.85,
        metalness: 0.05,
        opacity: 1.0,
        transparent: false,
        category: 'concrete',
      };
    }

    // 3. Metals (Steel, Aluminium, Iron, Copper, Zinc, Brass)
    if (
      raw.includes('aluminium') ||
      raw.includes('aluminum') ||
      raw.includes('aluminio')
    ) {
      return {
        baseColor: '#94A3B8',
        roughness: 0.3,
        metalness: 0.85,
        opacity: 1.0,
        transparent: false,
        category: 'metal',
      };
    }
    if (
      raw.includes('steel') ||
      raw.includes('acero') ||
      raw.includes('metal') ||
      raw.includes('iron') ||
      raw.includes('hierro') ||
      raw.includes('copper') ||
      raw.includes('cobre') ||
      raw.includes('zinc') ||
      raw.includes('brass') ||
      raw.includes('bronze')
    ) {
      return {
        baseColor: '#64748B',
        roughness: 0.35,
        metalness: 0.8,
        opacity: 1.0,
        transparent: false,
        category: 'metal',
      };
    }

    // 4. Wood & Timber
    if (
      raw.includes('wood') ||
      raw.includes('timber') ||
      raw.includes('madera') ||
      raw.includes('plywood') ||
      raw.includes('terciado') ||
      raw.includes('lumber') ||
      raw.includes('oak') ||
      raw.includes('pine') ||
      raw.includes('pino') ||
      raw.includes('roble') ||
      raw.includes('cedar')
    ) {
      return {
        baseColor: '#B48B57',
        roughness: 0.75,
        metalness: 0.0,
        opacity: 1.0,
        transparent: false,
        category: 'wood',
      };
    }

    // 5. Masonry, Brick, Stone, Ceramic, Terracotta, Tile
    if (
      raw.includes('brick') ||
      raw.includes('ladrillo') ||
      raw.includes('terra cotta') ||
      raw.includes('terracotta')
    ) {
      return {
        baseColor: '#B45309',
        roughness: 0.8,
        metalness: 0.05,
        opacity: 1.0,
        transparent: false,
        category: 'ceramic',
      };
    }
    if (
      raw.includes('stone') ||
      raw.includes('piedra') ||
      raw.includes('granite') ||
      raw.includes('granito') ||
      raw.includes('marble') ||
      raw.includes('marmol') ||
      raw.includes('mármol') ||
      raw.includes('ceramic') ||
      raw.includes('ceramica') ||
      raw.includes('cerámica') ||
      raw.includes('tile') ||
      raw.includes('porcelan')
    ) {
      return {
        baseColor: '#D1D5DB',
        roughness: 0.65,
        metalness: 0.05,
        opacity: 1.0,
        transparent: false,
        category: 'stone',
      };
    }

    // 6. Insulation, Drywall, Gypsum, Sheathing, Membrane, Soffit
    if (
      raw.includes('insulat') ||
      raw.includes('aisla') ||
      raw.includes('gypsum') ||
      raw.includes('sheathing') ||
      raw.includes('drywall') ||
      raw.includes('pladur') ||
      raw.includes('volcanita') ||
      raw.includes('soffit') ||
      raw.includes('fascia') ||
      raw.includes('membrane')
    ) {
      return {
        baseColor: '#E2E8F0',
        roughness: 0.9,
        metalness: 0.0,
        opacity: 1.0,
        transparent: false,
        category: 'other',
      };
    }

    // 7. Photovoltaic / Solar Cells
    if (
      raw.includes('photovoltaic') ||
      raw.includes('solar') ||
      raw.includes('pv')
    ) {
      return {
        baseColor: '#1E293B',
        roughness: 0.2,
        metalness: 0.6,
        opacity: 1.0,
        transparent: false,
        category: 'other',
      };
    }

    // 8. Default architectural neutral
    return {
      baseColor: '#D4D4D8',
      roughness: 0.7,
      metalness: 0.05,
      opacity: 1.0,
      transparent: false,
      category: matCategory !== 'other' ? matCategory : undefined,
    };
  }

  /**
   * Serializes a PolyMesh to IfcPolygonalFaceSetJSON structure.
   */
  public static serializePolyMeshToJSON(polyMesh: PolyMesh): any {
    const coordinates: number[] = [];
    const coordIndex: number[][] = [];
    const normals: number[] = [];
    const holesData: number[][][] = [];

    const cellSize = GeometryTolerance.COINCIDENT_POINT * 2;
    const tolSq = GeometryTolerance.COINCIDENT_POINT_SQ;
    const grid = new Map<number, number[]>();

    const getCellKey = (cx: number, cy: number, cz: number): number => {
      return (((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) | 0);
    };

    const getOrAddVertexIndex = (pos: Vec3): number => {
      const gx = Math.floor(pos.x / cellSize);
      const gy = Math.floor(pos.y / cellSize);
      const gz = Math.floor(pos.z / cellSize);

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const cellKey = getCellKey(gx + dx, gy + dy, gz + dz);
            const bucket = grid.get(cellKey);
            if (!bucket) continue;

            for (const candIdx of bucket) {
              const cx = coordinates[candIdx * 3];
              const cy = coordinates[candIdx * 3 + 1];
              const cz = coordinates[candIdx * 3 + 2];
              const diffX = cx - pos.x;
              const diffY = cy - pos.y;
              const diffZ = cz - pos.z;
              if (diffX * diffX + diffY * diffY + diffZ * diffZ < tolSq) {
                return candIdx;
              }
            }
          }
        }
      }

      const newIdx = coordinates.length / 3;
      coordinates.push(pos.x, pos.y, pos.z);
      const homeKey = getCellKey(gx, gy, gz);
      let homeBucket = grid.get(homeKey);
      if (!homeBucket) {
        homeBucket = [];
        grid.set(homeKey, homeBucket);
      }
      homeBucket.push(newIdx);
      return newIdx;
    };

    for (const face of polyMesh.faces.values()) {
      const faceVerts = face.getPositions ? face.getPositions() : (face as any).vertices;
      if (!faceVerts || faceVerts.length < 3) continue;
      const faceIndices: number[] = [];
      for (const v of faceVerts) {
        faceIndices.push(getOrAddVertexIndex(v));
      }
      coordIndex.push(faceIndices);
      const n = face.normal || new Vec3(0, 0, 1);
      normals.push(n.x, n.y, n.z);

      if (face.holes && face.holes.length > 0) {
        const faceHoles: number[][] = [];
        for (const hole of face.holes) {
          const holeIndices: number[] = [];
          for (const v of hole) {
            holeIndices.push(getOrAddVertexIndex(v));
          }
          faceHoles.push(holeIndices);
        }
        holesData.push(faceHoles);
      } else {
        holesData.push([]);
      }
    }

    return {
      coordinates,
      coordIndex,
      normals,
      holes: holesData,
    };
  }

  /**
   * Evaluates if any GROUP leaf entities in database lack geometry representation.
   */
  public static hasMissingGeometries(db: any): boolean {
    if (!db || typeof db.getAllEntities !== 'function') return false;
    const allDbEntities = db.getAllEntities();
    const childrenParentIds = new Set(
      allDbEntities.map((e: any) => e.parentId).filter((id: any): id is string => Boolean(id))
    );
    return allDbEntities.some(
      (e: any) => e.type === 'GROUP' && !e.matrixId && !childrenParentIds.has(e.id) && !db.getGeometry(e.id)
    );
  }

  /**
   * Rehydrates missing geometries for GROUP leaf entities in CroqueraDB.
   */
  public healMissingGeometries(db: any): number {
    this.prepareImport();
    const allDbEntities = db.getAllEntities();
    const childrenParentIds = new Set(
      allDbEntities.map((e: any) => e.parentId).filter((id: any): id is string => Boolean(id))
    );

    const emptyLeafEntities = allDbEntities.filter(
      (e: any) => e.type === 'GROUP' && !e.matrixId && !childrenParentIds.has(e.id) && !db.getGeometry(e.id)
    );

    if (emptyLeafEntities.length === 0) return 0;

    let healedCount = 0;
    const entitiesToHealMap = new Map(emptyLeafEntities.map((e: any) => [e.id, e]));

    const performHealing = () => {
      for (const rec of this.productRecordsList) {
        const entityId = this.stepIdToEntityId.get(rec.id);
        if (!entityId || !entitiesToHealMap.has(entityId)) continue;

        const dbEnt: any = entitiesToHealMap.get(entityId)!;
        const parsed = this.rebuildProductEntities(
          rec,
          dbEnt.parentId ?? null,
          undefined,
          this.itemToStyleMap,
          this.faceToStyleMap,
          this.elementMaterialMap,
          true
        );

        if (parsed && parsed.children.length > 0) {
          for (const child of parsed.children) {
            child.storeyId = dbEnt.storeyId;
            db.upsertEntity({
              id: child.id,
              type: child.type,
              name: child.name,
              parentId: dbEnt.id,
              hostFaceId: null,
              storeyId: dbEnt.storeyId || null,
              matrixId: null,
              transform: null,
            });

            if (child.polyMesh) {
              db.upsertGeometry(child.id, IfcStepImporter.serializePolyMeshToJSON(child.polyMesh));
            }

            db.upsertMetadata({
              entityId: child.id,
              ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
              predefinedType: undefined,
              psets: {},
            });
          }
          healedCount++;
        }
      }
    };

    if (typeof db.transaction === 'function') {
      db.transaction(performHealing);
    } else {
      performHealing();
    }

    return healedCount;
  }

  /**
   * Executes synchronous import into SceneGraph, CroqueraDB and BuildingFrameworkManager.
   */
  public importInto(
    sceneGraph: any,
    db?: any,
    frameworkManager?: any
  ): ImportResult {
    if (db && typeof db.transaction === 'function') {
      return db.transaction(() => this.executeImportInto(sceneGraph, db, frameworkManager));
    }
    return this.executeImportInto(sceneGraph, undefined, frameworkManager);
  }

  private executeImportInto(
    sceneGraph: any,
    db?: any,
    frameworkManager?: any
  ): ImportResult {
    const importedEntityIds: string[] = [];
    const buildingIds: string[] = [];
    const storeyIds: string[] = [];

    this.prepareImport();
    const spatial = this.extractSpatialHierarchy();

    if (db) {
      if ((globalThis as any).ModelCommand) {
        (globalThis as any).ModelCommand.initialize({ sceneGraph, db });
      }
      if (spatial.georef) {
        db.setGeorefData(spatial.georef);
      }
    }

    const defaultBuildingId = spatial.defaultBuildingId;
    if (defaultBuildingId) {
      buildingIds.push(defaultBuildingId);
    }

    // 1. Spatial Nodes
    for (const node of spatial.spatialNodes) {
      if (node.ifcType === 'IfcBuilding') {
        buildingIds.push(node.id);
      } else if (node.ifcType === 'IfcBuildingStorey') {
        storeyIds.push(node.id);
        if (db) {
          db.upsertEntity({
            id: node.id,
            type: 'GROUP',
            name: node.name,
            parentId: node.parentId,
            hostFaceId: null,
            storeyId: node.id,
            matrixId: null,
            transform: null,
          });
          db.upsertMetadata({
            entityId: node.id,
            ifcType: node.ifcType,
            predefinedType: undefined,
            psets: node.psets || {},
          });
        }
        continue;
      } else if (node.ifcType === 'IfcProject') {
        if (db) {
          db.upsertEntity({
            id: node.id,
            type: 'GROUP',
            name: node.name,
            parentId: null,
            hostFaceId: null,
            storeyId: null,
            matrixId: null,
            transform: null,
          });
          db.upsertMetadata({
            entityId: node.id,
            ifcType: 'IfcProject',
            predefinedType: undefined,
            psets: node.psets || {},
          });
        }
        continue;
      }

      const entity: any = {
        id: node.id,
        type: 'GROUP',
        name: node.name,
        parentId: node.parentId,
        faces: [],
        vertices: [],
        edges: [],
        metadata: {
          entityId: node.id,
          ifcType: node.ifcType,
          psets: node.psets || {},
        },
      };
      if (node.transform && node.ifcType === 'IfcBuilding') {
        const mat4 = new THREE.Matrix4().fromArray(node.transform);
        if ((globalThis as any).Transform3D) {
          entity.transform = (globalThis as any).Transform3D.fromMatrix4(mat4);
        } else {
          const pos = new THREE.Vector3();
          const quat = new THREE.Quaternion();
          const scl = new THREE.Vector3();
          mat4.decompose(pos, quat, scl);
          entity.transform = {
            position: [pos.x, pos.y, pos.z],
            rotation: [quat.x, quat.y, quat.z, quat.w],
            scale: [scl.x, scl.y, scl.z],
            toMatrix4: () => mat4.clone(),
            toTransformData: () => ({
              position: [pos.x, pos.y, pos.z],
              rotation: [quat.x, quat.y, quat.z, quat.w],
              scale: [scl.x, scl.y, scl.z],
            }),
          };
        }
      }
      sceneGraph.addEntity(entity);

      if (db) {
        db.upsertEntity({
          id: node.id,
          type: 'GROUP',
          name: node.name,
          parentId: node.parentId,
          hostFaceId: null,
          storeyId: null,
          matrixId: null,
          transform: entity.transform ? (typeof entity.transform.toTransformData === 'function' ? entity.transform.toTransformData() : entity.transform) : null,
        });
        db.upsertMetadata({
          entityId: node.id,
          ifcType: node.ifcType,
          predefinedType: undefined,
          psets: node.psets || {},
        });
      }
    }

    // 2. Product Records (Geometry & Components)
    const stepIdToEntityId = this.stepIdToEntityId;
    const productRecords = this.productRecordsList;
    const fillToOpeningMap = this.fillToOpeningStepMap;
    const openingToHostMap = this.openingToHostStepMap;

    if (db && typeof db.upsertMaterial === 'function') {
      for (const mat of this.materialCatalog.values()) {
        const m = mat as any;
        const sanitizedMat: any = {
          ...mat,
          category: mat.category || 'other',
          baseColor: mat.baseColor || '#D4D4D8',
          roughness: mat.roughness ?? 0.5,
          metalness: mat.metalness ?? 0.0,
          opacity: mat.opacity ?? 1.0,
          transmission: m.transmission ?? 0.0,
          clearcoat: m.clearcoat ?? 0.0,
          ior: m.ior ?? 1.5,
          isMirror: Boolean(m.isMirror),
          textureBlob: mat.textureBlob || null,
          textureMime: mat.textureMime || null,
          textureScaleU: mat.textureScaleU ?? 1.0,
          textureScaleV: mat.textureScaleV ?? 1.0,
        };
        db.upsertMaterial(sanitizedMat);
        if ((globalThis as any).MaterialRegistry && typeof (globalThis as any).MaterialRegistry.getInstance === 'function') {
          (globalThis as any).MaterialRegistry.getInstance().getOrCreateThreeMaterial(sanitizedMat);
        }
      }
    }

    for (const rec of productRecords) {
      try {
        const entityId = stepIdToEntityId.get(rec.id);
        const parentStepId = this.stepChildToParentMap.get(rec.id);
        let parentGuid = (parentStepId ? stepIdToEntityId.get(parentStepId) : null) || defaultBuildingId || null;
        let storeyGuid: string | null = null;

        if (rec.type === 'IFCSITE' && (!parentStepId || !this.storeyMap.has(parentStepId))) {
          parentGuid = (parentStepId ? stepIdToEntityId.get(parentStepId) : null) || null;
          storeyGuid = null;
        } else if (parentStepId && this.storeyMap.has(parentStepId)) {
          storeyGuid = this.storeyMap.get(parentStepId)!.guid;
          parentGuid = this.storeyToBuildingGuidMap.get(parentStepId) || defaultBuildingId || null;
        } else if (parentStepId) {
          storeyGuid = this.getInheritedStoreyGuid(parentStepId);
        }

        if (parentGuid === this.defaultProjectId) {
          parentGuid = null;
        }

        let fillsOpeningGuid: string | null = null;
        if (fillToOpeningMap.has(rec.id)) {
          const opStepId = fillToOpeningMap.get(rec.id)!;
          const opGuid = stepIdToEntityId.get(opStepId);
          if (opGuid) {
            fillsOpeningGuid = opGuid;
          }
        }

        // Special handling: IfcDoor OperationType
        let doorPredefinedType: string | undefined;
        let doorDrawingPset: any = undefined;
        if (rec.type === 'IFCDOOR' || rec.type === 'IFCDOORSTANDARDCASE') {
          const opTypeParam = rec.params[11];
          let opTypeStr = this.getParamEnumOrString(opTypeParam);
          if (opTypeStr) {
            opTypeStr = opTypeStr.replace(/^\./, '').replace(/\.$/, '');
          }
          if (opTypeStr && opTypeStr !== '$') {
            doorPredefinedType = opTypeStr;
            const hingeJamb = opTypeStr.includes('LEFT') ? 'NEG_X' : 'POS_X';
            doorDrawingPset = {
              OperationType: opTypeStr,
              HingeJamb: hingeJamb,
              SwingSide: 'POS_Y',
            };
          } else {
            const predParam = rec.params[10];
            const predStr = this.getParamEnumOrString(predParam);
            if (predStr && predStr !== '$') {
              doorPredefinedType = predStr.replace(/^\./, '').replace(/\.$/, '');
            }
          }
        }

        if (rec.type === 'IFCOPENINGELEMENT') {
          const hostStepId = openingToHostMap.get(rec.id);
          const hostGuid = hostStepId ? stepIdToEntityId.get(hostStepId) : null;
          if (hostGuid) parentGuid = hostGuid;

          const openingId = entityId || GuidUtils.createIfcGuid();
          const opName = this.getParamString(rec.params[2]) || 'Vano (IfcOpeningElement)';
          const opGroup: any = {
            id: openingId,
            type: 'GROUP',
            name: opName,
            parentId: parentGuid,
            storeyId: storeyGuid,
            hidden: true,
            faces: [],
            vertices: [],
            edges: [],
            isOpeningGroup: true,
            stepId: rec.id,
            metadata: {
              entityId: openingId,
              ifcType: 'IfcOpeningElement',
              predefinedType: 'OPENING',
              psets: {},
            },
          };
          sceneGraph.addEntity(opGroup);
          importedEntityIds.push(openingId);

          if (db) {
            db.upsertEntity({
              id: openingId,
              type: 'GROUP',
              name: opName,
              parentId: parentGuid,
              hostFaceId: null,
              storeyId: storeyGuid,
              matrixId: null,
              transform: null,
            });
            db.upsertMetadata({
              entityId: openingId,
              ifcType: 'IfcOpeningElement',
              predefinedType: 'OPENING',
              psets: {},
            });
          }

          const hydrated = this.hydrateBrepMesh(rec.id, true);
          if (hydrated && hydrated.polyMesh && hydrated.polyMesh.faces.size > 0) {
            const childGeoId = GuidUtils.createIfcGuid();
            const clonedMesh = hydrated.polyMesh.clone(childGeoId);
            for (const f of clonedMesh.faces.values()) f.hidden = true;
            clonedMesh.rebuildTopology();
            for (const e of clonedMesh.edges.values()) e.hidden = true;

            const childGeoEntity: any = {
              id: childGeoId,
              type: 'GEOMETRY_ENTITY',
              name: 'Geometría Vano',
              parentId: openingId,
              storeyId: storeyGuid,
              hidden: true,
              polyMesh: clonedMesh,
              faces: [],
              vertices: [],
              edges: [],
              metadata: {
                entityId: childGeoId,
                ifcType: 'IfcOpeningElement',
                psets: {},
              },
            };

            const verts: Vec3[] = [];
            for (const v of clonedMesh.vertices.values()) verts.push(v.position);
            const edgs: any[] = [];
            for (const e of clonedMesh.edges.values()) edgs.push({ a: e.vA.position, b: e.vB.position, hidden: true });
            const fcs: any[] = [];
            for (const [faceId, face] of clonedMesh.faces) {
              const faceVerts = face.getPositions();
              const faceEdges: any[] = [];
              for (const he of face.getHalfEdges()) {
                faceEdges.push({ a: he.origin.position, b: he.target.position });
              }
              fcs.push({
                id: faceId,
                faceId,
                polyMeshId: clonedMesh.id,
                vertices: faceVerts,
                holes: face.holes ? face.holes.map((h: any) => [...h]) : [],
                normal: face.normal,
                plane: face.plane,
                hidden: true,
                edges: faceEdges,
              });
            }
            childGeoEntity.faces = fcs;
            childGeoEntity.vertices = verts;
            childGeoEntity.edges = edgs;

            const threeGroup = new THREE.Group();
            threeGroup.visible = false;
            childGeoEntity.threeGroup = threeGroup;

            sceneGraph.addEntity(childGeoEntity);
            importedEntityIds.push(childGeoId);

            if (db) {
              db.upsertEntity({
                id: childGeoId,
                type: 'GEOMETRY_ENTITY',
                name: 'Geometría Vano',
                parentId: openingId,
                hostFaceId: null,
                storeyId: storeyGuid,
                matrixId: null,
                transform: null,
              });
              db.upsertGeometry(childGeoId, IfcStepImporter.serializePolyMeshToJSON(clonedMesh));
              db.upsertMetadata({
                entityId: childGeoId,
                ifcType: 'IfcOpeningElement',
                predefinedType: undefined,
                psets: {},
              });
            }

            if (hostGuid) {
              const hostEnt = sceneGraph.getEntity(hostGuid);
              if (hostEnt && hostEnt.polyMesh) {
                const taggedCount = OpeningVoidSolver.tagExistingJambas(hostEnt.polyMesh, clonedMesh, openingId);
                if (taggedCount >= 3) {
                  // Pre-cut opening
                } else {
                  const carved = OpeningVoidSolver.carveVoidIntoHost(hostEnt.polyMesh, clonedMesh, openingId);
                  if (carved) {
                    hostEnt.polyMesh.rebuildTopology();
                    const hVerts: Vec3[] = [];
                    for (const v of hostEnt.polyMesh.vertices.values()) hVerts.push(v.position);
                    const hEdgs: any[] = [];
                    for (const e of hostEnt.polyMesh.edges.values()) hEdgs.push({ a: e.vA.position, b: e.vB.position, hidden: e.hidden });
                    const hFcs: any[] = [];
                    for (const [faceId, face] of hostEnt.polyMesh.faces) {
                      const faceVerts = face.getPositions();
                      const faceEdges: any[] = [];
                      for (const he of face.getHalfEdges()) {
                        faceEdges.push({ a: he.origin.position, b: he.target.position });
                      }
                      hFcs.push({
                        id: faceId,
                        faceId,
                        polyMeshId: hostEnt.polyMesh.id,
                        vertices: faceVerts,
                        holes: face.holes ? face.holes.map((h: any) => [...h]) : [],
                        normal: face.normal,
                        plane: face.plane,
                        materialId: face.materialId,
                        hidden: face.hidden,
                        edges: faceEdges,
                      });
                    }
                    hostEnt.faces = hFcs;
                    hostEnt.vertices = hVerts;
                    hostEnt.edges = hEdgs;

                    if (db) {
                      db.upsertGeometry(hostEnt.id, IfcStepImporter.serializePolyMeshToJSON(hostEnt.polyMesh));
                    }
                  }
                }
              }
            }
          }
          continue;
        }

        const isSpace = rec.type === 'IFCSPACE';
        const rawPsets = this.resolveElementProperties(rec.id);
        if (fillsOpeningGuid) {
          rawPsets['Pset_OpeningFiller'] = {
            FillsOpening: { type: 'IfcIdentifier', value: fillsOpeningGuid },
          };
        }
        if (doorDrawingPset) {
          rawPsets['Croquera_DoorDrawing'] = doorDrawingPset;
        }

        const parsed = this.rebuildProductEntities(
          rec,
          parentGuid,
          rawPsets,
          this.itemToStyleMap,
          this.faceToStyleMap,
          this.elementMaterialMap,
          true
        );
        if (parsed) {
          const { rootEntity, children } = parsed;
          rootEntity.storeyId = storeyGuid;

          const elementPredefinedType = doorPredefinedType || this.getPredefinedType(rec) || undefined;
          if (isSpace) {
            rootEntity.type = 'GEOMETRY_ENTITY';
            rootEntity.hidden = true;
            const longName = this.getParamString(rec.params[7]) || '';
            const spaceName = rootEntity.name || 'Espacio';
            const spacePsets: Record<string, any> = {
              Pset_SpaceCommon: {
                Name: { value: spaceName },
                LongName: { value: longName },
              },
            };
            (rootEntity as any).metadata = {
              entityId: rootEntity.id,
              ifcType: 'IfcSpace',
              name: spaceName,
              longName,
              psets: spacePsets,
            };
          } else {
            (rootEntity as any).metadata = {
              entityId: rootEntity.id,
              ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
              predefinedType: elementPredefinedType,
              psets: rawPsets,
            };
          }

          if (rootEntity.polyMesh && (!rootEntity.faces || rootEntity.faces.length === 0)) {
            const mesh = rootEntity.polyMesh;
            const verts: Vec3[] = [];
            for (const v of mesh.vertices.values()) verts.push(v.position);
            const edgs: any[] = [];
            for (const e of mesh.edges.values()) edgs.push({ a: e.vA.position, b: e.vB.position, hidden: e.hidden });
            const fcs: any[] = [];
            for (const [faceId, face] of mesh.faces) {
              const faceVerts = face.getPositions();
              const faceEdges: any[] = [];
              for (const he of face.getHalfEdges()) {
                faceEdges.push({ a: he.origin.position, b: he.target.position });
              }
              fcs.push({
                id: faceId,
                faceId,
                polyMeshId: mesh.id,
                vertices: faceVerts,
                holes: face.holes ? face.holes.map((h: any) => [...h]) : [],
                normal: face.normal,
                plane: face.plane,
                materialId: face.materialId || rootEntity.materialId,
                hidden: face.hidden,
                edges: faceEdges,
              });
            }
            rootEntity.faces = fcs;
            rootEntity.vertices = verts;
            rootEntity.edges = edgs;
          }

          sceneGraph.addEntity(rootEntity);
          importedEntityIds.push(rootEntity.id);

          const assignedMatId = this.elementMaterialMap.get(rec.id) || this.itemToStyleMap?.get(rec.id);
          if (assignedMatId) {
            rootEntity.materialId = assignedMatId;
          }

          if (db) {
            db.upsertEntity({
              id: rootEntity.id,
              type: rootEntity.type,
              name: rootEntity.name,
              parentId: rootEntity.parentId || defaultBuildingId,
              hostFaceId: null,
              storeyId: rootEntity.storeyId || null,
              matrixId: rootEntity.matrixId || null,
              transform: null,
            });

            if (rootEntity.polyMesh) {
              db.upsertGeometry(rootEntity.id, IfcStepImporter.serializePolyMeshToJSON(rootEntity.polyMesh));
            }

            db.upsertMetadata({
              entityId: rootEntity.id,
              ifcType: (rootEntity as any).metadata?.ifcType || IfcStepImporter.canonicalizeIfcType(rec.type),
              predefinedType: (rootEntity as any).metadata?.predefinedType || undefined,
              psets: (rootEntity as any).metadata?.psets || {},
            });

            let hasFaceAssigned = false;
            if (rootEntity.polyMesh && typeof db.setMaterialAssignment === 'function') {
              for (const face of rootEntity.polyMesh.faces.values()) {
                if (face.materialId && (!assignedMatId || face.materialId !== assignedMatId)) {
                  hasFaceAssigned = true;
                  db.setMaterialAssignment({
                    id: GuidUtils.createIfcGuid(),
                    entityId: rootEntity.id,
                    faceId: face.id,
                    materialId: face.materialId,
                  });
                }
              }
            }

            if (assignedMatId && typeof db.setMaterialAssignment === 'function') {
              db.setMaterialAssignment({
                id: GuidUtils.createIfcGuid(),
                entityId: rootEntity.id,
                faceId: null,
                materialId: assignedMatId,
              });
            } else if (hasFaceAssigned && rootEntity.polyMesh && rootEntity.polyMesh.faces.size > 0 && typeof db.setMaterialAssignment === 'function') {
              const firstMat = rootEntity.polyMesh.faces.values().next().value?.materialId;
              if (firstMat) {
                db.setMaterialAssignment({
                  id: GuidUtils.createIfcGuid(),
                  entityId: rootEntity.id,
                  faceId: null,
                  materialId: firstMat,
                });
              }
            }
          }

          for (const child of children) {
            child.storeyId = storeyGuid;

            if (child.polyMesh && (!child.faces || child.faces.length === 0)) {
              const mesh = child.polyMesh;
              const verts: Vec3[] = [];
              for (const v of mesh.vertices.values()) verts.push(v.position);
              const edgs: any[] = [];
              for (const e of mesh.edges.values()) edgs.push({ a: e.vA.position, b: e.vB.position, hidden: e.hidden });
              const fcs: any[] = [];
              for (const [faceId, face] of mesh.faces) {
                const faceVerts = face.getPositions();
                const faceEdges: any[] = [];
                for (const he of face.getHalfEdges()) {
                  faceEdges.push({ a: he.origin.position, b: he.target.position });
                }
                fcs.push({
                  id: faceId,
                  faceId,
                  polyMeshId: mesh.id,
                  vertices: faceVerts,
                  holes: face.holes ? face.holes.map((h: any) => [...h]) : [],
                  normal: face.normal,
                  plane: face.plane,
                  materialId: face.materialId || child.materialId,
                  hidden: face.hidden,
                  edges: faceEdges,
                });
              }
              child.faces = fcs;
              child.vertices = verts;
              child.edges = edgs;
            }

            (child as any).metadata = {
              entityId: child.id,
              ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
              predefinedType: elementPredefinedType,
              psets: {},
            };

            sceneGraph.addEntity(child);
            importedEntityIds.push(child.id);

            const childMatId = child.materialId || assignedMatId;
            if (childMatId) {
              child.materialId = childMatId;
            }

            if (db) {
              db.upsertEntity({
                id: child.id,
                type: child.type,
                name: child.name,
                parentId: child.parentId,
                hostFaceId: null,
                storeyId: child.storeyId || null,
                matrixId: child.matrixId || null,
                transform: null,
              });

              if (child.polyMesh) {
                db.upsertGeometry(child.id, IfcStepImporter.serializePolyMeshToJSON(child.polyMesh));
              }

              db.upsertMetadata({
                entityId: child.id,
                ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                predefinedType: elementPredefinedType,
                psets: {},
              });

              if (childMatId && typeof db.setMaterialAssignment === 'function') {
                db.setMaterialAssignment({
                  id: GuidUtils.createIfcGuid(),
                  entityId: child.id,
                  faceId: null,
                  materialId: childMatId,
                });
              }
            }
          }
        }
      } catch (err: any) {
        console.warn(`[IfcStepImporter] Error al procesar producto #${rec.id}:`, err);
      }
    }

    // 3. Framework & Grids
    if (frameworkManager) {
      const bId = defaultBuildingId || buildingIds[0];
      if (bId) {
        let fw = typeof frameworkManager.getFramework === 'function' ? frameworkManager.getFramework(bId) : undefined;
        if (!fw && typeof frameworkManager.ensureBuildingFramework === 'function') {
          fw = frameworkManager.ensureBuildingFramework(bId);
        } else if (!fw && typeof frameworkManager.createFramework === 'function') {
          fw = frameworkManager.createFramework(bId);
        }
        if (fw) {
          const frameworkMetadata = this.extractFrameworkMetadata();
          if (frameworkMetadata) {
            if (frameworkMetadata.minBound && frameworkMetadata.maxBound && typeof fw.updateBounds === 'function') {
              fw.updateBounds({
                min: frameworkMetadata.minBound,
                max: frameworkMetadata.maxBound,
              });
            }
            if (frameworkMetadata.levels && frameworkMetadata.levels.length > 0) {
              fw.levels = frameworkMetadata.levels;
            } else if (spatial.parsedLevels && spatial.parsedLevels.length > 0) {
              fw.levels = spatial.parsedLevels.map((l: any) => ({
                id: l.id,
                name: l.name,
                elevation: l.elevation,
              }));
            }
            if (frameworkMetadata.sections && frameworkMetadata.sections.length > 0) {
              fw.sections = frameworkMetadata.sections;
            }
            if (typeof fw.rebuildLevels === 'function') {
              fw.rebuildLevels();
            }
          } else {
            if (spatial.parsedLevels && spatial.parsedLevels.length > 0) {
              fw.levels = spatial.parsedLevels.map((l: any) => ({
                id: l.id,
                name: l.name,
                elevation: l.elevation,
              }));
              if (typeof fw.rebuildLevels === 'function') {
                fw.rebuildLevels();
              }
            }

            // Modelos externos sin Pset_CroqueraBuildingFramework: calcular envolvente geométrica
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            let hasGeom = false;

            for (const entId of importedEntityIds) {
              const entity = sceneGraph.getEntity(entId);
              if (entity && entity.polyMesh && entity.polyMesh.vertices && entity.polyMesh.vertices.size > 0) {
                for (const v of entity.polyMesh.vertices.values()) {
                  const p = v.position;
                  if (p.x < minX) minX = p.x;
                  if (p.y < minY) minY = p.y;
                  if (p.z < minZ) minZ = p.z;
                  if (p.x > maxX) maxX = p.x;
                  if (p.y > maxY) maxY = p.y;
                  if (p.z > maxZ) maxZ = p.z;
                  hasGeom = true;
                }
              }
            }

            if (hasGeom && typeof fw.updateBounds === 'function') {
              fw.updateBounds({
                min: new Vec3(minX - 1.0, minY, minZ - 1.0),
                max: new Vec3(maxX + 1.0, maxY + 0.5, maxZ + 1.0),
              });
            }

            const grids = this.extractGrids();
            for (const gridDTO of grids) {
              const allAxes = [...gridDTO.uAxes, ...gridDTO.vAxes, ...(gridDTO.wAxes || [])];
              for (const axis of allAxes) {
                const start = new Vec3(axis.uvStart[0], axis.uvStart[1], axis.uvStart[2]);
                const end = new Vec3(axis.uvEnd[0], axis.uvEnd[1], axis.uvEnd[2]);
                const dir = end.sub(start);
                const normal = dir.isZero() ? Vec3.X : new Vec3(-dir.z, 0, dir.x).normalize();
                const sec = fw.addSection(start, normal, `Eje ${axis.tag}`, GuidUtils.createIfcGuid(), false);
                fw.convertSectionToGrid(sec.id, axis.tag);
              }
            }
          }
        }
      }
    }

    return {
      importedEntityIds,
      buildingIds,
      storeyIds,
      parser: this.getParser(),
      defaultBuildingId,
      parsedLevels: spatial.parsedLevels,
      georef: spatial.georef || this.getExtractedGeoref(),
    };
  }

  /**
   * Extrae los metadatos de BuildingFramework de Pset_CroqueraBuildingFramework si existen.
   */
  public extractFrameworkMetadata(): {
    minBound?: Vec3;
    maxBound?: Vec3;
    levels?: any[];
    sections?: any[];
  } | null {
    const psetRecords = this.parser.getRecordsByType('IFCPROPERTYSET');

    for (const pset of psetRecords) {
      const name = this.getParamString(pset.params[2]);
      if (name === 'Pset_CroqueraBuildingFramework') {
        const propRefs = pset.params[4];
        if (!Array.isArray(propRefs)) continue;

        let minBound: Vec3 | undefined;
        let maxBound: Vec3 | undefined;
        let levels: any[] | undefined;
        let sections: any[] | undefined;

        for (const pRef of propRefs) {
          if (!pRef || typeof pRef !== 'object' || !('ref' in pRef)) continue;
          const p = this.records.get(pRef.ref);
          if (!p || p.type !== 'IFCPROPERTYSINGLEVALUE') continue;

          const pName = this.getParamString(p.params[0]);
          const rawVal = p.params[2];
          const valStr = rawVal && typeof rawVal === 'object' && 'params' in rawVal ? rawVal.params[0] : rawVal;

          if (pName === 'MinBound' && typeof valStr === 'string') {
            const m = valStr.match(/\(([^,]+),([^,]+),([^)]+)\)/);
            if (m) minBound = new Vec3(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
          } else if (pName === 'MaxBound' && typeof valStr === 'string') {
            const m = valStr.match(/\(([^,]+),([^,]+),([^)]+)\)/);
            if (m) maxBound = new Vec3(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
          } else if (pName === 'LevelsJson' && typeof valStr === 'string') {
            try { levels = JSON.parse(valStr); } catch { /* ignore */ }
          } else if (pName === 'SectionsJson' && typeof valStr === 'string') {
            try {
              const parsed = JSON.parse(valStr);
              sections = parsed.map((s: any) => {
                const getV3 = (v: any): Vec3 => {
                  if (Array.isArray(v)) return new Vec3(v[0], v[1], v[2]);
                  if (v && typeof v === 'object') return new Vec3(v.x, v.y, v.z);
                  return new Vec3(0, 0, 0);
                };
                return {
                  id: s.id,
                  name: s.name,
                  origin: getV3(s.origin),
                  normal: getV3(s.normal),
                  isGrid: s.isGrid,
                  gridLabel: s.gridLabel,
                  activeCut: s.activeCut,
                };
              });
            } catch { /* ignore */ }
          }
        }

        return { minBound, maxBound, levels, sections };
      }
    }

    return null;
  }
}