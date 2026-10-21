/**
 * IfcStepImporter — Importador de IFC 4.3 ISO-10303-21 nativo para CROQUERA.
 *
 * Parsea el archivo STEP, extrae la geometría teselada / B-Rep y la jerarquía espacial,
 * reconstruye los PolyMesh con Half-Edge invariants, hidrata los Property Sets
 * y restaura el BuildingFramework (niveles y grids) con fidelidad del 100%.
 */

import { IfcStepParser, type StepRecord, type StepParam } from '../parser/IfcStepParser';
import { OnDemandRecordMap, type IIfcStreamingParser } from '../parser/IfcStreamingParser';
import { PolyMesh } from '../topology/PolyMesh';
import { BooleanCSGKernel } from '../topology/BooleanCSGKernel';
import { PolygonClipping } from '../topology/PolygonClipping';
import { SweepKernel } from '../topology/SweepKernel';
import { RevolveKernel } from '../topology/RevolveKernel';
import { Vec3 } from '../math/Vec3';
import { Plane } from '../math/Plane';
import { GuidUtils } from '../types/GuidUtils';
import { GeometryTolerance } from '../math/GeometryTolerance';
import * as THREE from 'three';
import { GeometryPrototypeDetector } from '../detector/GeometryPrototypeDetector';
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
  IfcValueType,
  GeorefData,
  EntityType,
} from '../types/IfcWorkerProtocol';

export interface EvaluatedProductEntity {
  id: string;
  type: EntityType;
  name: string;
  parentId: string | null;
  storeyId?: string | null;
  matrixId?: string | null;
  polyMesh?: PolyMesh;
  hidden?: boolean;
  faces?: any[];
  vertices?: Vec3[];
  edges?: any[];
}

export interface ImportResult {
  importedEntityIds: string[];
  buildingIds: string[];
  storeyIds: string[];
  parser: IfcStepParser | IIfcStreamingParser; // Guardado para delta patching posterior
  defaultBuildingId?: string | null;
  parsedLevels?: { id: string; name: string; elevation: number }[];
  frameworkMetadata?: any;
  georef?: GeorefData | null;
}

export const IFC_PRIORITY_STRUCTURAL_TYPES = new Set<string>([
  'IFCWALL',
  'IFCWALLSTANDARDCASE',
  'IFCSLAB',
  'IFCCOLUMN',
  'IFCBEAM',
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
]);

/**
 * Diccionario inmutable de índices de atributos STEP (0-based) conforme a ISO 16739-1 (IFC 4.3 ADD2).
 * Norma 21: Prohibido acceder a parámetros STEP mediante índices numéricos mágicos sueltos.
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
    'IFCCIVILELEMENT',
    'IFCGEOGRAPHICELEMENT',
    'IFCEARTHWORKSELEMENT',
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

  // Parámetros y estado de georreferenciación LoGeoRef 50 (Fase 2)
  private extractedGeoref: GeorefData | null = null;
  private extractedTrueNorth: { x: number; y: number } | null = null;
  private siteGeoTranslationCaptured = false;
  private capturedSiteTranslation: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private capturedSiteRotation: THREE.Matrix4 = new THREE.Matrix4();

  // Estados preparados para streaming progresivo (Fase 4)
  private isPrepared = false;
  private elemPsetsMap: Map<number, Record<string, Record<string, any>>> = new Map();
  private elementMaterialMap: Map<number, string> = new Map();
  private itemToStyleMap: Map<number, string> = new Map();
  private faceToStyleMap: Map<number, string> = new Map();
  private frameworkMetadata: any = null;
  private stepIdToEntityId: Map<number, string> = new Map();
  private defaultProjectId: string | null = null;
  private defaultSiteId: string | null = null;
  private defaultBuildingId: string | null = null;
  private storeyMap: Map<number, { guid: string; name: string; elevation: number }> = new Map();
  private storeyToBuildingGuidMap: Map<number, string> = new Map();
  private parsedLevels: { id: string; name: string; elevation: number }[] = [];
  private buildingPlacements: Map<string, THREE.Matrix4> = new Map();

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
    } else if (stepContentOrParser instanceof IfcStepParser) {
      this.parser = stepContentOrParser;
      this.records = stepContentOrParser.records;
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

    // 1. Buscar unidades del SI (longitud y ángulo)
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

    // 2. Buscar unidades por conversión (longitud y ángulo)
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

  private populateSitePlacementRefs(): void {
    this.sitePlacementRefs.clear();
    const allSites = this.parser.getRecordsByType('IFCSITE');
    for (const site of allSites) {
      const pParam = site.params[5];
      if (pParam && typeof pParam === 'object' && 'ref' in pParam) {
        const sitePlRef = (pParam as any).ref;
        this.sitePlacementRefs.add(sitePlRef);
        // Resolver y capturar la traslación geodésica del Site en el paso preparatorio
        this.resolveLocalPlacementMatrix(sitePlRef);
      }
    }
  }

  /**
   * Prepara el grafo de relaciones, Psets y metadatos sin instanciar geometrías pesadas (Fase 4).
   */
  public prepareImport(): void {
    if (this.isPrepared) return;

    this.parseUnitAssignment();
    this.materialCatalog.clear();
    this.elemPsetsMap = this.extractElementPsets();
    this.elementMaterialMap = this.importMaterials();
    const styled = this.parseStyledItems();
    this.itemToStyleMap = styled.itemToStyleMap;
    this.faceToStyleMap = styled.faceToStyleMap;
    this.frameworkMetadata = this.extractFrameworkMetadata();

    this.stepParentToChildrenMap.clear();
    this.stepChildToParentMap.clear();
    this.openingToHostStepMap.clear();
    this.hostToOpeningsStepMap.clear();
    this.fillToOpeningStepMap.clear();
    this.populateSitePlacementRefs();
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

    this.spatialNodes = [];
    this.stepIdToEntityId.clear();
    this.defaultProjectId = null;
    this.defaultSiteId = null;
    this.defaultBuildingId = null;

    // 1. Proyectos
    const projectRecords = this.parser.getRecordsByType('IFCPROJECT');
    if (projectRecords.length === 0) {
      const msg = 'Advertencia STEP: El archivo no contiene la entidad raíz IfcProject. Se creará una estructura espacial por defecto.';
      console.warn(`[IfcStepImporter] ${msg}`);
      this.importWarnings.push(msg);
      const defaultGuid = GuidUtils.createIfcGuid();
      this.defaultProjectId = defaultGuid;
      this.spatialNodes.push({
        id: defaultGuid,
        stepId: 0,
        name: 'Proyecto por defecto',
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

    // 2. Sitios (Raíz física en SceneGraph: parentId = null si existen)
    const siteRecords = this.parser.getRecordsByType('IFCSITE');
    for (const site of siteRecords) {
      const guid = this.getParamString(site.params[0]) || GuidUtils.createIfcGuid();
      const name = this.getParamString(site.params[2]) || 'Sitio';
      if (!this.defaultSiteId) this.defaultSiteId = guid;
      this.stepIdToEntityId.set(site.id, guid);
      this.spatialNodes.push({
        id: guid,
        stepId: site.id,
        name,
        ifcType: 'IfcSite',
        parentId: null,
        psets: this.elemPsetsMap.get(site.id) || {},
      });
    }

    // 3. Edificios
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

      // Resolver ObjectPlacement (param 5) del edificio y convertir a coordenadas Croquera Y-Up (Norma 21, Norma 22)
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

    // 4. Pisos / Niveles
    const storeyTypes = ['IFCBUILDINGSTOREY', 'IFCFACILITYPART', 'IFCBUILDINGPART'];
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

      // Ajuste 2: Los IfcBuildingStorey no se crean como nodos GROUP en SceneGraph
      // (evita carpetas vacías de nivel en el árbol). Su información se traslada
      // a BuildingFramework.levels y los elementos se vinculan a su IfcBuilding contenedor con storeyId.
    }

    // 5. Lista de Productos
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
   * Extrae la jerarquía espacial (Etapa 1 - Fase 4).
   * Despliega Proyecto, Sitio, Edificio y Pisos en tiempo sub-200ms sin calcular geometrías.
   */
  public extractSpatialHierarchy(): Stage1SpatialPayload {
    this.prepareImport();

    return {
      type: 'STAGE_SPATIAL_HIERARCHY',
      spatialNodes: this.spatialNodes,
      materials: this.materialsList,
      parsedLevels: this.parsedLevels,
      frameworkMetadata: this.frameworkMetadata,
      defaultBuildingId: this.defaultBuildingId,
      georef: this.finalizeGeoref(),
    };
  }

  /**
   * Extrae las cajas envolventes AABB y la envolvente global del modelo (Etapa 2 - Fase 4).
   * Permite encuadrar la cámara inmediatamente en el viewport mientras se transmiten las mallas.
   */
  public extractProductBounds(): Stage2BoundsPayload {
    if (this.cachedBoundsPayload) return this.cachedBoundsPayload;
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

        if (parentStepId && this.storeyMap.has(parentStepId)) {
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

        // Norma 15.1: Ventanas/puertas no son hijas del vano invisible sino que conservan contenedor espacial y se vinculan vía Pset_OpeningFiller
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

        // 1. Resolver colocación espacial local
        const placementParam = rec.params[5];
        let mProduct = new THREE.Matrix4();
        if (placementParam && typeof placementParam === 'object' && 'ref' in placementParam) {
          mProduct = this.resolveLocalPlacementMatrix((placementParam as any).ref);
        }

        // 2. Extraer caja envolvente aproximada
        const shapeParam = rec.params[6];
        let subMeshes: { mesh: PolyMesh; itemId: number; materialId?: string }[] = [];
        if (shapeParam && typeof shapeParam === 'object' && 'ref' in shapeParam) {
          try {
            subMeshes = this.rebuildSubMeshesFromShape((shapeParam as any).ref, id, this.itemToStyleMap, this.faceToStyleMap);
          } catch (meshErr: any) {
            console.warn(`[IfcStepImporter] Fallo al extraer envolvente de producto #${rec.id}: ${meshErr?.message || meshErr}`);
          }
        }

        const elemMin = new THREE.Vector3(Infinity, Infinity, Infinity);
        const elemMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        let hasPoints = false;

        for (const sm of subMeshes) {
          for (const v of sm.mesh.vertices.values()) {
            const p = new THREE.Vector3(v.position.x, v.position.y, v.position.z).applyMatrix4(mProduct);
            // Cambio canónico: X_croq = X_ifc, Y_croq = Z_ifc, Z_croq = -Y_ifc (det = +1)
            const x = p.x;
            const y = p.z;
            const z = -p.y;

            if (x < elemMin.x) elemMin.x = x;
            if (y < elemMin.y) elemMin.y = y;
            if (z < elemMin.z) elemMin.z = z;
            if (x > elemMax.x) elemMax.x = x;
            if (y > elemMax.y) elemMax.y = y;
            if (z > elemMax.z) elemMax.z = z;

            if (x < modelMin.x) modelMin.x = x;
            if (y < modelMin.y) modelMin.y = y;
            if (z < modelMin.z) modelMin.z = z;
            if (x > modelMax.x) modelMax.x = x;
            if (y > modelMax.y) modelMax.y = y;
            if (z > modelMax.z) modelMax.z = z;

            hasPoints = true;
          }
        }

        // Si no hubo puntos geométricos, usar la posición de mProduct
        if (!hasPoints) {
          const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(mProduct);
          const ox = origin.x;
          const oy = origin.z;
          const oz = -origin.y;
          elemMin.set(ox - 0.1, oy - 0.1, oz - 0.1);
          elemMax.set(ox + 0.1, oy + 0.1, oz + 0.1);
        }

        const isExplicitAssembly =
          rec.type === 'IFCELEMENTASSEMBLY' ||
          rec.type === 'IFCGROUP';
        const hasChildren = this.stepParentToChildrenMap.has(rec.id) && (this.stepParentToChildrenMap.get(rec.id)!.size > 0);
        const isGroup = isExplicitAssembly || hasChildren || subMeshes.length > 0;

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
      elements,
      totalElements: elements.length,
      modelAABB: {
        min: [modelMin.x, modelMin.y, modelMin.z],
        max: [modelMax.x, modelMax.y, modelMax.z],
      },
    };

    return this.cachedBoundsPayload;
  }

  /**
   * Genera y transmite en lotes la geometría teselada usando Transferable Objects (Etapa 3 - Fase 4).
   */
  public extractGeometryChunks(
    chunkSize: number = 150,
    onChunk?: (chunk: Stage3GeometryChunkPayload, transferables: Transferable[]) => void
  ): Stage3GeometryChunkPayload[] {
    if (!this.isPrepared) this.prepareImport();

    const totalProducts = this.productRecordsList.length;
    const totalChunks = Math.max(1, Math.ceil(totalProducts / chunkSize));
    const allChunks: Stage3GeometryChunkPayload[] = [];

    let currentChunkElements: TessellatedElementDTO[] = [];
    let currentTransferables: Transferable[] = [];
    let chunkIndex = 0;

    for (let i = 0; i < totalProducts; i++) {
      const rec = this.productRecordsList[i];
      try {
        const parentStepId = this.stepChildToParentMap.get(rec.id);
        let parentGuid: string | null = null;
        let storeyGuid: string | null = null;

        if (parentStepId && this.storeyMap.has(parentStepId)) {
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
          const openingGroupEntity = this.rebuildProductEntity(rec, effectiveParent, this.elemPsetsMap.get(rec.id));
          if (openingGroupEntity) {
            const openingPolyMesh = openingGroupEntity.polyMesh;
            if (openingPolyMesh && openingPolyMesh.faces.size > 0) {
              const childGeoId = GuidUtils.createIfcGuid();
              const clonedMesh = openingPolyMesh.clone(childGeoId);
              for (const f of clonedMesh.faces.values()) f.hidden = true;
              clonedMesh.rebuildTopology();
              for (const e of clonedMesh.edges.values()) e.hidden = true;

              const geo = clonedMesh.toThreeGeometry();
              const edgeGeo = clonedMesh.toEdgeGeometry();
              const posAttr = geo.attributes.position;
              const normAttr = geo.attributes.normal;
              const edgePosAttr = edgeGeo.attributes.position;

              const positions = new Float32Array(posAttr.array);
              const normals = normAttr
                ? new Float32Array(normAttr.array)
                : new Float32Array(posAttr.array.length);
              const indices = geo.index
                ? new Uint32Array(geo.index.array)
                : new Uint32Array(positions.length / 3).map((_, idx) => idx);
              const edgesBuffer = edgePosAttr ? new Float32Array(edgePosAttr.array) : new Float32Array(0);

              const brepData = null;

              currentTransferables.push(positions.buffer, normals.buffer, indices.buffer);
              if (edgesBuffer.buffer.byteLength > 0) {
                currentTransferables.push(edgesBuffer.buffer);
              }

              const psets = this.elemPsetsMap.get(rec.id) || {};
              if (!psets.Pset_Opening) psets.Pset_Opening = {};
              if (hostGuid) {
                psets.Pset_Opening.VoidsElements = {
                  type: 'IfcLabel',
                  value: JSON.stringify([hostGuid]),
                };
              }
              this.stepIdToEntityId.set(rec.id, openingGroupEntity.id);

              currentChunkElements.push({
                id: openingGroupEntity.id,
                stepId: rec.id,
                name: openingGroupEntity.name || 'Vano (IfcOpeningElement)',
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

              currentChunkElements.push({
                id: childGeoId,
                stepId: rec.id,
                name: 'Geometría Vano',
                type: 'GEOMETRY_ENTITY',
                ifcType: 'IfcOpeningElement',
                predefinedType: 'OPENING',
                parentId: openingGroupEntity.id,
                storeyId: storeyGuid,
                psets,
                positions,
                normals,
                indices,
                edgesBuffer,
                brepData,
                hidden: true,
                isOpeningGeometry: true,
                openingGroupId: openingGroupEntity.id,
                hostIds: hostGuid ? [hostGuid] : [],
              });
            }
          }
        } else {
          const effectiveParent = parentGuid || this.defaultBuildingId || '';
          const parsed = this.rebuildProductEntities(
            rec,
            effectiveParent,
            this.elemPsetsMap.get(rec.id),
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
                parentId: rootEntity.parentId || this.defaultBuildingId,
                storeyId: storeyGuid,
                matrixId: rootEntity.matrixId || null,
                psets: this.elemPsetsMap.get(rec.id) || {},
                materialId: undefined,
                positions: new Float32Array(0),
                normals: new Float32Array(0),
                indices: new Uint32Array(0),
                edgesBuffer: new Float32Array(0),
                brepData: null,
              });

              for (const child of children) {
                if (child.polyMesh && child.polyMesh.faces.size > 0) {
                  const mesh = child.polyMesh;
                  const geo = mesh.toThreeGeometry();
                  const edgeGeo = mesh.toEdgeGeometry();
                  const posAttr = geo.attributes.position;
                  const normAttr = geo.attributes.normal;
                  const edgePosAttr = edgeGeo.attributes.position;

                  const positions = new Float32Array(posAttr.array);
                  const normals = normAttr
                    ? new Float32Array(normAttr.array)
                    : new Float32Array(posAttr.array.length);
                  const indices = geo.index
                    ? new Uint32Array(geo.index.array)
                    : new Uint32Array(positions.length / 3).map((_, idx) => idx);
                  const edgesBuffer = edgePosAttr ? new Float32Array(edgePosAttr.array) : new Float32Array(0);

                  const brepData = null;

                  currentTransferables.push(positions.buffer, normals.buffer, indices.buffer);
                  if (edgesBuffer.buffer.byteLength > 0) {
                    currentTransferables.push(edgesBuffer.buffer);
                  }

                  currentChunkElements.push({
                    id: child.id,
                    stepId: rec.id,
                    name: child.name || 'Malla',
                    type: 'GEOMETRY_ENTITY',
                    ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                    predefinedType: undefined,
                    parentId: child.parentId || rootEntity.id,
                    storeyId: storeyGuid,
                    psets: {},
                    materialId: (child.name !== 'Malla' ? child.name : undefined) || this.elementMaterialMap.get(rec.id) || this.itemToStyleMap.get(rec.id),
                    positions,
                    normals,
                    indices,
                    edgesBuffer,
                    brepData,
                  });
                }
              }
            } else if (rootEntity.polyMesh && rootEntity.polyMesh.faces.size > 0) {
              const mesh = rootEntity.polyMesh;
              const geo = mesh.toThreeGeometry();
              const edgeGeo = mesh.toEdgeGeometry();
              const posAttr = geo.attributes.position;
              const normAttr = geo.attributes.normal;
              const edgePosAttr = edgeGeo.attributes.position;

              const positions = new Float32Array(posAttr.array);
              const normals = normAttr
                ? new Float32Array(normAttr.array)
                : new Float32Array(posAttr.array.length);
              const indices = geo.index
                ? new Uint32Array(geo.index.array)
                : new Uint32Array(positions.length / 3).map((_, idx) => idx);
              const edgesBuffer = edgePosAttr ? new Float32Array(edgePosAttr.array) : new Float32Array(0);

              const brepData = null;

              currentTransferables.push(positions.buffer, normals.buffer, indices.buffer);
              if (edgesBuffer.buffer.byteLength > 0) {
                currentTransferables.push(edgesBuffer.buffer);
              }

              const assignedMatId = this.elementMaterialMap.get(rec.id) || this.itemToStyleMap.get(rec.id);

              currentChunkElements.push({
                id: rootEntity.id,
                stepId: rec.id,
                name: rootEntity.name || IfcStepImporter.canonicalizeIfcType(rec.type),
                type: 'GEOMETRY_ENTITY',
                ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                predefinedType: this.getPredefinedType(rec) || undefined,
                parentId: rootEntity.parentId || this.defaultBuildingId,
                storeyId: storeyGuid,
                psets: this.elemPsetsMap.get(rec.id) || {},
                materialId: assignedMatId,
                positions,
                normals,
                indices,
                edgesBuffer,
                brepData,
              });
            }
          }
        }
      } catch (err: any) {
        const msg = `Error al procesar producto STEP #${rec.id} (${rec.type}): ${err?.message || err}`;
        console.warn(`[IfcStepImporter] ${msg}`);
        this.importWarnings.push(msg);
      }

      // Emitir chunk cuando se alcanza chunkSize o el final
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
   * Extrae y procesa los elementos masivos diferidos (Fase 2 - Etapa B).
   * Identifica geometrías congruentes con GeometryPrototypeDetector y las emite
   * como InstanceBatchPayload, colapsando instancias en GPU (Norma 4: matrixId).
   */
  /**
   * Extrae directamente coordenadas crudas (Float32Array) de un ítem B-Rep sin instanciar PolyMesh en el heap.
   * Optimización crítica de memoria O(1) para inspección previa de congruencia geométrica (Norma 7).
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
    if (coords.length > 0) {
      return new Float32Array(coords);
    }

    const fallbackMesh = this.rebuildMeshFromItem(itemId, `temp_${itemId}`, this.itemToStyleMap, this.faceToStyleMap);
    if (!fallbackMesh || fallbackMesh.vertices.size === 0) return null;
    const vList = Array.from(fallbackMesh.vertices.values());
    const arr = new Float32Array(vList.length * 3);
    for (let i = 0; i < vList.length; i++) {
      arr[i * 3] = vList[i].position.x;
      arr[i * 3 + 1] = vList[i].position.y;
      arr[i * 3 + 2] = vList[i].position.z;
    }
    return arr;
  }

  /**
   * Extrae y procesa los elementos masivos diferidos (Fase 2 - Etapa B).
   * Identifica geometrías congruentes con GeometryPrototypeDetector y las emite
   * como InstanceBatchPayload, colapsando instancias en GPU (Norma 4: matrixId).
   */
  public extractDeferredInstances(
    detector: GeometryPrototypeDetector,
    onInstanceBatch: (batch: InstanceBatchPayload) => void,
    onPrototypeChunk?: (chunk: Stage3GeometryChunkPayload, transferables: Transferable[]) => void
  ): { totalPrototypes: number; totalInstances: number } {
    if (!this.isPrepared) this.prepareImport();

    const deferredTypes = [
      'IFCRAILING',
      'IFCCOVERING',
      'IFCPLATE',
      'IFCMEMBER',
      'IFCBUILDINGELEMENTPART',
      'IFCFURNISHINGELEMENT',
      'IFCFURNITURE',
      'IFCBUILDINGELEMENTPROXY',
      'IFCELEMENTASSEMBLY',
      'IFCFLOWSEGMENT',
      'IFCDUCTSEGMENT',
      'IFCDUCTFITTING',
      'IFCPIPESEGMENT',
      'IFCPIPEFITTING',
      'IFCAIRTERMINAL',
      'IFCDISTRIBUTIONPORT',
      'IFCFLOWTERMINAL',
      'IFCFLOWCONTROLLER',
      'IFCFLOWFITTING',
      'IFCFLOWMOVINGDEVICE',
      'IFCFLOWSTORAGEDEVICE',
      'IFCFLOWTREATMENTDEVICE',
      'IFCSENSOR',
      'IFCACTUATOR',
    ];

    const pendingBatches: Map<string, InstanceElementDTO[]> = new Map();

    for (const dType of deferredTypes) {
      const records = this.parser.getRecordsByType(dType);
      for (const rec of records) {
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

          // Resolver colocación espacial local
          const placementParam = rec.params[5];
          let mProduct = new THREE.Matrix4();
          if (placementParam && typeof placementParam === 'object' && 'ref' in placementParam) {
            mProduct = this.resolveLocalPlacementMatrix((placementParam as any).ref);
          }

          // Extraer representaciones de forma
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
            if (!repRec) continue;
            const geomItems = repRec.params[3];
            if (Array.isArray(geomItems)) {
              for (const gItem of geomItems) {
                if (gItem && typeof gItem === 'object' && 'ref' in gItem) {
                  allGeomRefs.push(gItem.ref);
                }
              }
            }
          }

          if (allGeomRefs.length <= 1) {
            // Caso 1: Producto monocomponente o perfil continuo (e.g. baranda individual estándar)
            const subMeshes = this.rebuildSubMeshesFromShape(
              (shapeParam as any).ref,
              productGuid,
              this.itemToStyleMap,
              this.faceToStyleMap
            );

            if (subMeshes.length === 0) continue;

            const primarySubMesh = subMeshes[0];
            const mesh = primarySubMesh.mesh;
            if (mesh.vertices.size === 0 || mesh.faces.size === 0) continue;

            // Consultar / registrar en el detector de prototipos
            const match = detector.checkOrRegister(productGuid, rec.id, mesh, mProduct);

            if (match.isInstance) {
              let batch = pendingBatches.get(match.prototypeId);
              if (!batch) {
                batch = [];
                pendingBatches.set(match.prototypeId, batch);
              }

              batch.push({
                id: productGuid,
                name,
                ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                parentId: parentGuid || this.defaultBuildingId || null,
                storeyId: storeyGuid,
                transform: match.transform,
                psets: this.elemPsetsMap.get(rec.id),
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
              // Prototipo nuevo: centrar en Croquera Y-up space in-place en el PolyMesh
              // y emitir como template oculto para InstancedMesh.
              //
              // CRITICO: InstancedMeshPool.allocate llama a protoPolyMesh.toThreeGeometry()
              // directamente, ignorando cualquier búfer pre-computado en el DTO. Por tanto
              // la transformación debe aplicarse IN-PLACE en los vértices del PolyMesh
              // (igual que rebuildProductEntities hace en Fase 1: applyMatrix4 + canonical swap).
              //
              // centroid_ifc = AABB midpoint (el mismo que usó el detector para M_croq)
              // v_proto_croq = (v_ifc.x - cx, v_ifc.z - cz, -(v_ifc.y - cy))
              if (onPrototypeChunk) {
                const [icx, icy, icz] = match.centroid_ifc;

                // Transformar vértices del PolyMesh in-place: centrar + canonical swap IFC->Croquera
                for (const v of mesh.vertices.values()) {
                  const vx = v.position.x - icx;
                  const vy = v.position.y - icy;
                  const vz = v.position.z - icz;
                  v.position = new Vec3(vx, vz, -vy); // X_croq=X_ifc-cx, Y_croq=Z_ifc-cz, Z_croq=-(Y_ifc-cy)
                }
                // toThreeGeometry() recalculará las normales desde los vértices ya transformados.
                // Solo transformamos los holes si existen.
                for (const f of mesh.faces.values()) {
                  if (f.holes && f.holes.length > 0) {
                    f.holes = f.holes.map((loop) =>
                      loop.map((pt) => new Vec3(pt.x - icx, pt.z - icz, -(pt.y - icy)))
                    );
                  }
                }

                // Generar búferes desde el PolyMesh ya transformado
                const geo = mesh.toThreeGeometry();
                const edgeGeo = mesh.toEdgeGeometry();
                const posAttr = geo.attributes.position;
                const normAttr = geo.attributes.normal;
                const edgePosAttr = edgeGeo.attributes.position;

                const positions = new Float32Array(posAttr.array);
                const normals = normAttr
                  ? new Float32Array(normAttr.array)
                  : new Float32Array(posAttr.array.length);
                const indices = geo.index
                  ? new Uint32Array(geo.index.array)
                  : new Uint32Array(positions.length / 3).map((_, idx) => idx);
                const edgesBuffer = (edgePosAttr && edgePosAttr.array.length > 0)
                  ? new Float32Array(edgePosAttr.array)
                  : new Float32Array(0);

                const brepData = null;
                const transferables: Transferable[] = [positions.buffer, normals.buffer, indices.buffer];
                if (edgesBuffer.buffer.byteLength > 0) {
                  transferables.push(edgesBuffer.buffer);
                }

                const assignedMatId =
                  this.elementMaterialMap.get(rec.id) || this.itemToStyleMap.get(rec.id);

                const protoElement: TessellatedElementDTO = {
                  id: productGuid,
                  stepId: rec.id,
                  name: `[Prototipo] ${name}`,
                  type: 'GEOMETRY_ENTITY',
                  ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                  predefinedType: this.getPredefinedType(rec) || undefined,
                  parentId: parentGuid || this.defaultBuildingId,
                  storeyId: storeyGuid,
                  matrixId: productGuid,
                  hidden: true,
                  psets: this.elemPsetsMap.get(rec.id) || {},
                  materialId: assignedMatId,
                  positions,
                  normals,
                  indices,
                  edgesBuffer,
                  brepData,
                };

                onPrototypeChunk(
                  { type: 'STAGE_GEOMETRY_CHUNK', chunkIndex: 0, totalChunks: 1, progress: 1.0, elements: [protoElement] },
                  transferables
                );

                // Emitir la primera ocurrencia como instancia
                let protoBatch = pendingBatches.get(productGuid);
                if (!protoBatch) {
                  protoBatch = [];
                  pendingBatches.set(productGuid, protoBatch);
                }
                protoBatch.push({
                  id: GuidUtils.createIfcGuid(),
                  name,
                  ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                  parentId: parentGuid || this.defaultBuildingId || null,
                  storeyId: storeyGuid,
                  transform: match.transform,
                  psets: {},
                });
              }
            }
          } else {
            // Caso 2: Ensamblaje masivo con cientos/miles de ítems discretos repetitivos (e.g. balaustres en ElManzano)
            // Emitir GROUP contenedor del ensamblaje (Norma 15)
            if (onPrototypeChunk) {
              onPrototypeChunk(
                {
                  type: 'STAGE_GEOMETRY_CHUNK',
                  chunkIndex: 0,
                  totalChunks: 1,
                  progress: 1.0,
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
              const rawPos = this.extractRawPositionsFromItem(itemRef);
              if (!rawPos || rawPos.length < 9) continue;

              const match = detector.checkOrRegister(`proto_item_${itemRef}`, itemRef, rawPos, mProduct);
              const pieceGuid = GuidUtils.createIfcGuid();

              if (match.isInstance) {
                let batch = pendingBatches.get(match.prototypeId);
                if (!batch) {
                  batch = [];
                  pendingBatches.set(match.prototypeId, batch);
                }

                batch.push({
                  id: pieceGuid,
                  name: `${name} (Pieza)`,
                  ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                  parentId: productGuid,
                  storeyId: storeyGuid,
                  transform: match.transform,
                  psets: {},
                });

                if (batch.length >= 250) {
                  onInstanceBatch({
                    type: 'STAGE_INSTANCE_BATCH',
                    prototypeId: match.prototypeId,
                    instances: batch,
                  });
                  pendingBatches.set(match.prototypeId, []);
                }
              } else {
                // Nuevo prototipo de pieza: transformar PolyMesh in-place
                const itemMesh = this.rebuildMeshFromItem(itemRef, match.prototypeId, this.itemToStyleMap, this.faceToStyleMap);
                if (itemMesh && itemMesh.faces.size > 0 && onPrototypeChunk) {
                  const [picx, picy, picz] = match.centroid_ifc;

                  // Transformar vértices in-place: centrar + canonical swap IFC->Croquera
                  for (const v of itemMesh.vertices.values()) {
                    const vx = v.position.x - picx;
                    const vy = v.position.y - picy;
                    const vz = v.position.z - picz;
                    v.position = new Vec3(vx, vz, -vy); // X_croq=X_ifc-cx, Y_croq=Z_ifc-cz, Z_croq=-(Y_ifc-cy)
                  }
                  // toThreeGeometry() recalculará las normales. Solo transformamos holes.
                  for (const f of itemMesh.faces.values()) {
                    if (f.holes && f.holes.length > 0) {
                      f.holes = f.holes.map((loop) =>
                        loop.map((pt) => new Vec3(pt.x - picx, pt.z - picz, -(pt.y - picy)))
                      );
                    }
                  }

                  const geo = itemMesh.toThreeGeometry();
                  const edgeGeo = itemMesh.toEdgeGeometry();
                  const posAttr = geo.attributes.position;
                  const normAttr = geo.attributes.normal;
                  const edgePosAttr = edgeGeo.attributes.position;

                  const positions = new Float32Array(posAttr.array);
                  const normals = normAttr
                    ? new Float32Array(normAttr.array)
                    : new Float32Array(posAttr.array.length);
                  const indices = geo.index
                    ? new Uint32Array(geo.index.array)
                    : new Uint32Array(positions.length / 3).map((_, idx) => idx);
                  const edgesBuffer = (edgePosAttr && edgePosAttr.array.length > 0)
                    ? new Float32Array(edgePosAttr.array)
                    : new Float32Array(0);

                  const brepData = null;
                  const transferables: Transferable[] = [positions.buffer, normals.buffer, indices.buffer];
                  if (edgesBuffer.buffer.byteLength > 0) {
                    transferables.push(edgesBuffer.buffer);
                  }

                  const assignedMatId =
                    this.elementMaterialMap.get(rec.id) || this.itemToStyleMap.get(rec.id);

                  const protoElement: TessellatedElementDTO = {
                    id: match.prototypeId,
                    stepId: itemRef,
                    name: `[Prototipo] ${name} (Pieza)`,
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
                    { type: 'STAGE_GEOMETRY_CHUNK', chunkIndex: 0, totalChunks: 1, progress: 1.0, elements: [protoElement] },
                    transferables
                  );

                  let pieceBatch = pendingBatches.get(match.prototypeId);
                  if (!pieceBatch) {
                    pieceBatch = [];
                    pendingBatches.set(match.prototypeId, pieceBatch);
                  }
                  pieceBatch.push({
                    id: GuidUtils.createIfcGuid(),
                    name: `${name} (Pieza)`,
                    ifcType: IfcStepImporter.canonicalizeIfcType(rec.type),
                    parentId: productGuid,
                    storeyId: storeyGuid,
                    transform: match.transform,
                    psets: {},
                  });
                }
              }
            }
          }
        } catch (err: any) {
          console.warn(`[IfcStepImporter] Falló la evaluación de instancia diferida #${rec.id}: ${err?.message || err}`);
        }
      }
    }

    // Flush de lotes pendientes restantes
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
   * Reconstruye una entidad de producto y sus posibles componentes hijos (GEOMETRY_ENTITY)
   * a partir de representaciones múltiples o sub-ítems MappedItem.
   * Cumple con Norma 15 (ontología binaria GROUP / GEOMETRY_ENTITY).
   */
  private rebuildProductEntities(
    rec: StepRecord,
    defaultParentId: string | null,
    _psets?: Record<string, Record<string, any>>,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>,
    elementMaterialMap?: Map<number, string>
  ): { rootEntity: EvaluatedProductEntity; children: EvaluatedProductEntity[] } | null {
    const rawGuid = this.getParamString(rec.params[0]);
    const id = this.stepIdToEntityId.get(rec.id) || (rawGuid && GuidUtils.isIfcGuid(rawGuid) ? rawGuid : GuidUtils.createIfcGuid());
    this.stepIdToEntityId.set(rec.id, id);
    const name = this.getParamString(rec.params[2]) || rec.type;

    // Param 6 suele ser la representación geométrica (IfcProductDefinitionShape)
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

    // 1. Resolver ObjectPlacement (rec.params[5]) del producto
    const placementParam = rec.params[5];
    let mProduct = new THREE.Matrix4();
    if (placementParam && typeof placementParam === 'object' && 'ref' in placementParam) {
      mProduct = this.resolveLocalPlacementMatrix(placementParam.ref);
    }

    // Material por defecto a nivel de producto
    const productLevelMatId = elementMaterialMap?.get(rec.id) || itemToStyleMap?.get(rec.id);

    // 2. Aplicar mProduct y cambio de base canónico (Z-Up -> Y-Up) a cada sub-malla
    for (const sm of subMeshes) {
      const mesh = sm.mesh;
      for (const v of mesh.vertices.values()) {
        const p = new THREE.Vector3(v.position.x, v.position.y, v.position.z).applyMatrix4(mProduct);
        // Cambio canónico: X_croq = X_ifc, Y_croq = Z_ifc, Z_croq = -Y_ifc (det = +1)
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
        const isAnonymousIfcMat = f.materialId && f.materialId.startsWith('mat_ifc_');
        if ((!f.materialId || isAnonymousIfcMat) && productLevelMatId) {
          f.materialId = productLevelMatId;
        } else if (!f.materialId && sm.materialId) {
          f.materialId = sm.materialId;
        }
      }
      if (productLevelMatId && (!sm.materialId || sm.materialId.startsWith('mat_ifc_'))) {
        sm.materialId = productLevelMatId;
      }
    }

    // En la lógica de Croquera, todo producto IFC con geometría se estructura formalmente
    // como un GROUP contenedor (con su clasificación IFC y metadatos) que alberga sus piezas/mallas
    // como GEOMETRY_ENTITY hijas (Norma 15).
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
        type: isSpace ? 'GEOMETRY_ENTITY' : 'GROUP',
        name,
        parentId: defaultParentId,
        matrixId: resolvedMatrixId || undefined,
        hidden: isSpace ? true : undefined,
        faces: [],
        vertices: [],
        edges: [],
      };

      const children: EvaluatedProductEntity[] = [];
      for (const sm of subMeshes) {
        const childId = GuidUtils.createIfcGuid();
        const childMesh = sm.mesh;
        const childName = sm.materialId || 'Malla';

        const childEntity: EvaluatedProductEntity = {
          id: childId,
          type: 'GEOMETRY_ENTITY',
          name: childName,
          parentId: id,
          polyMesh: childMesh,
          faces: [],
          vertices: [],
          edges: [],
        };

        for (const face of childMesh.faces.values()) {
          childEntity.faces!.push({
            id: face.id,
            vertices: face.getPositions(),
            holes: face.holes,
            normal: face.normal,
            plane: face.plane,
            edges: [],
            polyMeshId: childMesh.id,
            faceId: face.id,
          });
        }
        for (const v of childMesh.vertices.values()) {
          childEntity.vertices!.push(v.position);
        }
        for (const e of childMesh.edges.values()) {
          childEntity.edges!.push({ a: e.vA.position, b: e.vB.position });
        }

        children.push(childEntity);
      }

      if (children.length > 0 && children[0].polyMesh) {
        rootGroup.polyMesh = children[0].polyMesh;
      }

      return { rootEntity: rootGroup, children };
    }

    // Contenedores puramente lógicos o ensamblajes sin geometría propia directa (Grupos Rama - Norma 15)
    if (isExplicitAssembly || hasChildren || hasPsets || isSpace || isDoor) {
      const groupEntity: EvaluatedProductEntity = {
        id,
        type: isSpace ? 'GEOMETRY_ENTITY' : 'GROUP',
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
    if (res.rootEntity.type === 'GROUP' && res.children.length > 0 && res.children[0].polyMesh) {
      res.rootEntity.polyMesh = res.children[0].polyMesh;
    }
    return res.rootEntity;
  }

  /**
   * Reconstruye todos los sub-PolyMesh navegando desde IfcProductDefinitionShape -> IfcShapeRepresentation -> Mallas.
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
      if (!repRec) continue;

      const repStyleId = itemToStyleMap?.get(repRec.id);
      const geomItems = repRec.params[3];
      if (!Array.isArray(geomItems)) continue;

      for (const geomItem of geomItems) {
        if (!geomItem || typeof geomItem !== 'object' || !('ref' in geomItem)) continue;
        const gRec = this.records.get(geomItem.ref);
        if (!gRec) continue;

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
   * Consolida submallas múltiples pertenecientes al mismo producto agrupándolas por materialId.
   * Evita la explosión combinatoria de entidades hijas y draw calls en elementos masivos
   * compuestos por miles de ítems BRep discretos (e.g. balaustres, perfiles repetitivos).
   */
  private consolidateSubMeshes(
    subMeshes: { mesh: PolyMesh; itemId: number; materialId?: string }[],
    baseEntityId: string
  ): { mesh: PolyMesh; itemId: number; materialId?: string }[] {
    // Conforme a Norma 15 y buildingSMART, los elementos con componentes discretos
    // (sillas, muros multicapa, puertas, etc.) deben preservar sus piezas como GEOMETRY_ENTITY hijas.
    // Solo se consolidan elementos masivos (e.g. teselados o conjuntos > 16 fragmentos).
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
   * Reconstruye un PolyMesh desde representaciones STEP estándar (Malla, Extrusión o Mapeo).
   */
  private rebuildMeshFromItem(
    itemId: number,
    entityId: string,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>,
    visited: Set<number> = new Set<number>()
  ): PolyMesh | null {
    if (visited.has(itemId) || visited.size >= 64) {
      console.warn(`[IfcStepImporter] Ciclo o exceso de recursión detectado en ítem geom #${itemId}. Omitiendo.`);
      return null;
    }
    visited.add(itemId);

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
      const m = this.rebuildFromTriangulatedFaceSet(itemRec, entityId);
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

    return null;
  }

  /**
   * Reconstruye un PolyMesh desde un IfcBooleanResult / IfcBooleanClippingResult navegando recursivamente
   * por el primer operando (FirstOperand) hasta el sólido base.
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
        if (operator.includes('DIFFERENCE') && secondRec && (secondRec.type === 'IFCHALFSPACESOLID' || secondRec.type === 'IFCPOLYGONALBOUNDEDHALFSPACE')) {
          // Caso 1: Semiespacio analítico (IFCHALFSPACESOLID / IFCPOLYGONALBOUNDEDHALFSPACE) -> clipByPlane analítico
          const planeParam = secondRec.params[0];
          if (planeParam && typeof planeParam === 'object' && 'ref' in planeParam) {
            const planeRec = this.records.get(planeParam.ref);
            if (planeRec && planeRec.params[0] && typeof planeRec.params[0] === 'object' && 'ref' in planeRec.params[0]) {
              const posRec = this.records.get(planeRec.params[0].ref);
              if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
                const mPlane = this.resolveAxis2Placement3D(posRec);
                const pos = new Vec3(mPlane.elements[12], mPlane.elements[13], mPlane.elements[14]);
                const normal = new Vec3(mPlane.elements[8], mPlane.elements[9], mPlane.elements[10]).normalize();
                const plane = Plane.fromPointAndNormal(pos, normal);
                firstMesh.clipByPlane(plane, true);
              }
            }
          }
        } else {
          // Caso 2: Sólido poliédrico general -> Despacho a BooleanCSGKernel
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
        console.warn(`[IfcStepImporter] Fallo al aplicar operación booleana #${rec.id}: ${err?.message || err}`);
      }
    }
    return firstMesh;
  }

  /**
   * Reconstruye un PolyMesh desde un IfcExtrudedAreaSolid (Revit/ArchiCAD estándar).
   */
  /**
   * Reconstruye un PolyMesh desde un IfcExtrudedAreaSolid (Revit/ArchiCAD estándar).
   * Alimenta múltiples lazos y perfiles compuestos según Norma 16 (Ruta Única).
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

    // Ruta Única (Norma 16): extracción canónica de perfiles 2D
    const profileLoops = this.extractProfileLoops2D((sweptAreaParam as any).ref);
    if (profileLoops.length === 0) return null;

    // Vector de extrusión (IFCDIRECTION) en sistema local del sólido (default Z: (0, 0, 1))
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

    let mSolid: THREE.Matrix4 | null = null;
    if (positionParam && typeof positionParam === 'object' && 'ref' in positionParam) {
      const posRec = this.records.get(positionParam.ref);
      if (posRec && posRec.type === 'IFCAXIS2PLACEMENT3D') {
        mSolid = this.resolveAxis2Placement3D(posRec);
      }
    }

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

      if (mSolid) {
        baseVerts.forEach((v) => v.applyMatrix4(mSolid!));
        topVerts.forEach((v) => v.applyMatrix4(mSolid!));
        innerBaseLoops.forEach((loop) => loop.forEach((v) => v.applyMatrix4(mSolid!)));
        innerTopLoops.forEach((loop) => loop.forEach((v) => v.applyMatrix4(mSolid!)));
      }

      const basePts = baseVerts.map((v) => new Vec3(v.x, v.y, v.z));
      const topPts = topVerts.map((v) => new Vec3(v.x, v.y, v.z));

      const innerBasePts = innerBaseLoops.map((loop) =>
        loop.map((v) => new Vec3(v.x, v.y, v.z))
      );
      const innerTopPts = innerTopLoops.map((loop) =>
        loop.map((v) => new Vec3(v.x, v.y, v.z))
      );

      // Cara inferior (orientada hacia afuera en dirección opuesta a la extrusión)
      const bottomFace = [...basePts].reverse();
      const bottomHoles = innerBasePts.map((loop) => [...loop].reverse());
      polyMesh.addFace(bottomFace, undefined, bottomHoles.length > 0 ? bottomHoles : undefined);

      // Cara superior (orientada hacia afuera en dirección de extrusión)
      polyMesh.addFace(topPts, undefined, innerTopPts.length > 0 ? innerTopPts : undefined);

      // Caras laterales exteriores cuadriláteras
      const N = basePts.length;
      for (let i = 0; i < N; i++) {
        const next = (i + 1) % N;
        const sideFace = [basePts[i], basePts[next], topPts[next], topPts[i]];
        polyMesh.addFace(sideFace);
      }

      // Caras laterales interiores (túneles de huecos)
      for (let k = 0; k < innerBasePts.length; k++) {
        const hBase = innerBasePts[k];
        const hTop = innerTopPts[k];
        const M = hBase.length;
        for (let j = 0; j < M; j++) {
          const next = (j + 1) % M;
          const tunnelFace = [hBase[next], hBase[j], hTop[j], hTop[next]];
          polyMesh.addFace(tunnelFace);
        }
      }
    }

    if (polyMesh.faces.size === 0) return null;

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
   * Aplica una transformación afín THREE.Matrix4 a los vértices y huecos de un PolyMesh.
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
   * Reconstruye un PolyMesh desde un IfcSweptDiskSolid o IfcSweptDiskSolidPolygonal (ISO 16739-1 / IFC 4.3).
   * Genera un sólido tubular barriendo un disco plano circular ortogonal a la directriz 3D.
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
      const msg = `IfcSweptDiskSolid #${rec.id} sin directriz válida`;
      console.warn(`[IfcStepImporter] ${msg}`);
      this.importWarnings.push(msg);
      return null;
    }

    const directrix = this.extract3DCurvePoints((directrixParam as any).ref);
    if (!directrix || directrix.points.length < 2) {
      const msg = `Directriz 3D no resuelta o degenerada (< 2 puntos) en IfcSweptDiskSolid #${rec.id}`;
      console.warn(`[IfcStepImporter] ${msg}`);
      this.importWarnings.push(msg);
      return null;
    }

    const rawRadius = typeof radiusParam === 'number' ? radiusParam : parseFloat(String(radiusParam || 0)) || 0;
    const radius = rawRadius * this.lengthUnitScale;
    if (radius <= GeometryTolerance.COINCIDENT_POINT) {
      const msg = `Radio nulo o degenerado (${radius}) en IfcSweptDiskSolid #${rec.id}`;
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

    // Up-vector canónico invariante
    const up = Math.abs(T0.dot(Vec3.Y)) < 0.9 ? Vec3.Y : Vec3.X;
    const u = T0.cross(up).normalize();
    const v = T0.cross(u).normalize();

    // Discretización del perfil exterior en 16 segmentos en el plano ortogonal a T0
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

    // Sustracción de cavidad interior si innerRadius está especificado (ISO 16739-1)
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
            console.warn(`[IfcStepImporter] Sustracción de innerRadius en IfcSweptDiskSolid #${rec.id} falló: ${err?.message || err}`);
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
   * Reconstruye un PolyMesh desde IfcSurfaceCurveSweptAreaSolid o IfcFixedReferenceSweptAreaSolid.
   * Barre cualquier perfil 2D (catálogo completo) a lo largo de una directriz 3D.
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

      // Si el perfil contiene cavidades interiores (inners), sustraerlas
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
              console.warn(`[IfcStepImporter] Falló hueco interior de barrido en #${rec.id}: ${err?.message || err}`);
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
   * Reconstruye un PolyMesh desde un IfcRevolvedAreaSolid (ISO 16739-1 / IFC 4.3).
   * Rota cualquier perfil 2D alrededor de un eje lineal IFCAXIS1PLACEMENT.
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
      const msg = `Ángulo nulo o degenerado en IfcRevolvedAreaSolid #${rec.id}`;
      console.warn(`[IfcStepImporter] ${msg}`);
      this.importWarnings.push(msg);
      return null;
    }

    // Resolver IFCAXIS1PLACEMENT: Location (param[0]), Axis (param[1])
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
    let axisDirection = new Vec3(0, 0, 1); // Por defecto Z en ISO 10303-42 / IFC 4.3
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

    // Ruta Única (Norma 16): extracción de perfiles 2D
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

      // El perfil 2D en IFC se define en el plano local XY: (x, y, 0)
      const profileVertices = loop.outer.map((p) => new Vec3(p.x, p.y, 0));

      const revolved = RevolveKernel.revolveProfile({
        profileVertices,
        axisPoint,
        axisDirection,
        angleRadians,
        meshId: entityId,
      });

      if (!revolved || revolved.faces.size === 0) continue;

      // Si el perfil tiene huecos (e.g. IFCCIRCLEHOLLOWPROFILEDEF o WITHVOIDS), sustraer cavidad
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
              console.warn(`[IfcStepImporter] Falló hueco interior de revolución en #${rec.id}: ${err?.message || err}`);
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
   * Extrae contornos 2D ({ outer: { x, y }[], inners: { x, y }[][] }) desde cualquier definición IfcProfileDef.
   * Ruta Única (Norma 16): Gobierna extrusiones, barridos y revoluciones sin duplicación.
   * Soporta perfiles estándar, huecos, paramétricos (L, T, U, C, Z, Trapezium, Ellipse, AsymmetricI),
   * derivados (IfcDerivedProfileDef con operadores y reflexiones) y compuestos (IfcCompositeProfileDef).
   */
  private extractProfileLoops2D(
    profileRef: number,
    visited = new Set<number>()
  ): Array<{ outer: { x: number; y: number }[]; inners: { x: number; y: number }[][] }> {
    if (visited.has(profileRef) || visited.size >= 32) {
      console.warn(`[IfcStepImporter] Ciclo detectado en IfcProfileDef #${profileRef}`);
      return [];
    }
    visited.add(profileRef);

    const sweptAreaRec = this.records.get(profileRef);
    if (!sweptAreaRec) return [];

    // Manejo de IfcCompositeProfileDef (concatena múltiples sub-perfiles)
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

    // Manejo de IfcDerivedProfileDef (transformación 2D sobre perfil base)
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
          // Determinante 2D en plano XY: e[0]*e[5] - e[1]*e[4]
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

    // Perfiles paramétricos y estándar
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
        // Degrada limpiamente a canal U
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
        // Perfil costanera C de 12 vértices con pestañas rigidizadoras
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
      const msg = `Tipo de IfcProfileDef no soportado: #${sweptAreaRec.id} (${sweptAreaRec.type})`;
      console.warn(`[IfcStepImporter] ${msg}`);
      this.importWarnings.push(msg);
      return [];
    }

    if (isParameterizedProfile) {
      // Aplicar Position 2D (IFCAXIS2PLACEMENT2D) si existe
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
   * Resuelve la matriz 4x4 de un IfcCartesianTransformationOperator3D o 2D con fallbacks estrictos.
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
   * Reconstruye la lista exhaustiva de sub-mallas desde un IfcMappedItem (instancia de componente)
   * aplicando la transformación afín completa M_local = M_operator * M_mapOrigin^-1 sobre todos sus ítems.
   */
  private rebuildSubMeshesFromMappedItem(
    rec: StepRecord,
    baseEntityId: string,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>,
    visited: Set<number> = new Set<number>()
  ): { mesh: PolyMesh; itemId: number; materialId?: string }[] {
    const result: { mesh: PolyMesh; itemId: number; materialId?: string }[] = [];
    const sourceRef = rec.params[0];
    const targetRef = rec.params[1];

    if (!sourceRef || typeof sourceRef !== 'object' || !('ref' in sourceRef)) return result;
    const mapRec = this.records.get(sourceRef.ref);
    if (!mapRec || mapRec.type !== 'IFCREPRESENTATIONMAP') return result;

    const mappedRepRef = mapRec.params[1];
    if (!mappedRepRef || typeof mappedRepRef !== 'object' || !('ref' in mappedRepRef)) return result;

    const shapeRepRec = this.records.get(mappedRepRef.ref);
    if (!shapeRepRec) return result;

    const geomItems = shapeRepRec.params[3];
    if (!Array.isArray(geomItems) || geomItems.length === 0) return result;

    // 1. Matriz de MappingOrigin
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

    // 2. Matriz de Operator
    let mOperator = new THREE.Matrix4();
    if (targetRef && typeof targetRef === 'object' && 'ref' in targetRef) {
      const opRec = this.records.get(targetRef.ref);
      if (opRec) {
        mOperator = this.resolveCartesianTransformationOperator(opRec);
      }
    }

    // 3. Matriz combinada local: M_local = M_operator * M_mapOrigin^-1
    const mLocal = new THREE.Matrix4().multiplyMatrices(mOperator, mMapOriginInv);

    const mappedItemStyleId = itemToStyleMap?.get(rec.id);
    const repStyleId = itemToStyleMap?.get(shapeRepRec.id) || mappedItemStyleId;

    for (const item of geomItems) {
      if (!item || typeof item !== 'object' || !('ref' in item)) continue;
      const subMesh = this.rebuildMeshFromItem(item.ref, baseEntityId, itemToStyleMap, faceToStyleMap, visited);
      if (subMesh) {
        // Aplicar transformación local mLocal a los vértices y bucles de huecos
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
   * Reconstruye un PolyMesh desde un IfcMappedItem (compatibilidad con llamadas individuales).
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
    return subMeshes[0].mesh;
  }

  /**
   * Reconstruye un PolyMesh desde un IfcPolygonalFaceSet.
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

    // Param 2: Lista de referencias a caras (IFCINDEXEDPOLYGONALFACE / WITHVOIDS)
    const faceRefs = rec.params[IFC_GEOM_ATTRS.POLYGONAL_FACES];
    if (!Array.isArray(faceRefs)) return null;

    // Param 3: PnIndex (opcional, 1-based, ISO 16739-1)
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
   * Reconstruye un PolyMesh desde un IfcTriangulatedFaceSet (ISO 16739-1 / IFC 4.3).
   * Cumple con:
   * - Norma 11: Filtrado determinista de triángulos degenerados y colapsados.
   * - Norma 18 y 21: Resolución formal del atributo CoordIndex (params[3]) distinguiéndolo de PnIndex.
   * - Norma 22: Preservación de orientación antihoraria (CCW) hacia el exterior.
   */
  private rebuildFromTriangulatedFaceSet(rec: StepRecord, entityId: string): PolyMesh | null {
    const pointListRef = rec.params[0];
    if (!pointListRef || typeof pointListRef !== 'object' || !('ref' in pointListRef)) {
      return null;
    }

    const pointListRec = this.records.get(pointListRef.ref);
    if (!pointListRec) return null;

    const points = this.extractPointList(pointListRec);
    if (points.length === 0) return null;

    // En IfcTriangulatedFaceSet canónico (ISO 16739-1), los atributos son:
    // 0: Coordinates (IfcCartesianPointList3D)
    // 1: Normals (opcional)
    // 2: Closed (opcional, boolean)
    // 3: CoordIndex (LIST [1:?] OF LIST [3:3] OF IfcPositiveInteger)
    // 4: PnIndex (opcional, LIST [1:?] OF IfcPositiveInteger)
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
    const seenTriangles = new Set<string>();

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

      // Descartar si hay colapso de índices
      if (idx0 === idx1 || idx1 === idx2 || idx2 === idx0) continue;

      // Filtrar triángulos duplicados idénticos en el mismo IfcTriangulatedFaceSet (Norma 11)
      const triSig = [idx0, idx1, idx2].sort((a, b) => a - b).join(':');
      if (seenTriangles.has(triSig)) {
        continue;
      }
      seenTriangles.add(triSig);

      const p0 = resolvePoint(idx0);
      const p1 = resolvePoint(idx1);
      const p2 = resolvePoint(idx2);

      if (!p0 || !p1 || !p2) continue;

      // Filtrar triángulos colapsados, colineales o de área nula (Norma 11)
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
      // Coalescencia coplanar para restaurar polígonos n-gonos arquitectónicos (Normas 6, 7, 11, 13, 16, 17, 21, 24)
      polyMesh.coalesceCoplanarFaces();
      polyMesh.resetVersion();
      return polyMesh;
    }
    return null;
  }

  /**
   * Extrae lista de puntos Vec3 de un IFCCARTESIANPOINTLIST3D.
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
   * Agrega las caras de un IfcConnectedFaceSet / IfcClosedShell / IfcOpenShell al PolyMesh acumulador.
   * Filtra bucles degenerados y deduplica puntos mediante GeometryTolerance.COINCIDENT_POINT (Norma 6, Norma 11).
   * Asigna estilos y colores a nivel de cara y elemento según IFCSTYLEDITEM.
   */
  private appendFacesFromConnectedFaceSet(
    shellRec: StepRecord,
    polyMesh: PolyMesh,
    itemToStyleMap?: Map<number, string>,
    faceToStyleMap?: Map<number, string>,
    fallbackStyleId?: string
  ): number {
    // shellRec.params[0] es la lista de referencias a IfcFace (CfsFaces - ISO 10303-42 / ISO 16739-1)
    const faceRefsParam = shellRec.params[0];
    const faceRefs = Array.isArray(faceRefsParam)
      ? faceRefsParam
      : (faceRefsParam && typeof faceRefsParam === 'object' && 'ref' in faceRefsParam ? [faceRefsParam] : []);
    if (faceRefs.length === 0) return 0;

    let facesAdded = 0;

    // Función auxiliar para deduplicar vértices colineales/coincidentes y cerrar bucles de polígonos
    const cleanLoopPoints = (pts: Vec3[]): Vec3[] => {
      if (pts.length === 0) return [];
      const cleaned: Vec3[] = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].distanceTo(cleaned[cleaned.length - 1]) >= GeometryTolerance.COINCIDENT_POINT) {
          cleaned.push(pts[i]);
        }
      }
      // En STEP / ISO 10303-42, muchos exportadores repiten el primer vértice al final para cerrar el PolyLoop.
      // PolyMesh.addFace espera bucles abiertos donde el último vértice se conecta implícitamente al primero.
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

      // faceRec.params[0] es la lista de referencias a IfcFaceBound / IfcFaceOuterBound (Bounds)
      const boundRefsParam = faceRec.params[0];
      const boundRefs = Array.isArray(boundRefsParam)
        ? boundRefsParam
        : (boundRefsParam ? [boundRefsParam] : []);

      let outerLoop: Vec3[] | null = null;
      const innerHoles: Vec3[][] = [];

      // Detectar si hay algún IFCFACEOUTERBOUND explícito en los límites de la cara
      const hasOuterBound = boundRefs.some((r: any) => {
        if (!r || typeof r !== 'object' || !('ref' in r)) return false;
        const b = this.records.get(r.ref);
        return b?.type === 'IFCFACEOUTERBOUND';
      });

      for (const bRef of boundRefs) {
        if (!bRef || typeof bRef !== 'object' || !('ref' in bRef)) continue;
        const boundRec = this.records.get(bRef.ref);
        if (!boundRec) continue;

        // boundRec.params[0]: IfcLoop (típicamente IFCPOLYLOOP)
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

        // Verificar orientación geométrica del loop
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

        // Clasificación de contorno exterior vs huecos interiores
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

          // Asignación de material de presentación a la cara
          const matId =
            (fRef && faceToStyleMap?.get(fRef.ref)) ||
            (fRef && itemToStyleMap?.get(fRef.ref)) ||
            fallbackStyleId;
          if (matId && face) {
            face.materialId = matId;
          }
          facesAdded++;
        } catch (err: any) {
          // Norma 13: Cero supresión silenciosa de errores
          console.debug(`[IfcStepImporter] Cara ignorada por degeneración topológica #${faceRec.id}: ${err?.message || err}`);
        }
      }
    }

    return facesAdded;
  }

  /**
   * Reconstruye un PolyMesh desde un IfcFacetedBrep, IfcClosedShell, IfcOpenShell o IfcConnectedFaceSet.
   * Filtra bucles degenerados y deduplica puntos mediante GeometryTolerance.COINCIDENT_POINT (Norma 6).
   * Asigna estilos y colores a nivel de cara y elemento según IFCSTYLEDITEM.
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
   * Reconstruye un PolyMesh desde un IfcFaceBasedSurfaceModel (ISO 16739-1 / IFC 4.3).
   * Extrae la colección de IfcConnectedFaceSet (rec.params[0]) y acumula todas sus caras.
   * Cumple con Norma 6, Norma 7, Norma 11, Norma 15 y Norma 21.
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
   * Resuelve una matriz afín 4x4 a partir de un IFCAXIS2PLACEMENT3D.
   * Aplica por defecto las direcciones estándar buildingSMART (ISO 10303-42):
   * Axis = (0, 0, 1), RefDirection = (1, 0, 0).
   */
  private resolveAxis2Placement3D(rec: StepRecord): THREE.Matrix4 {
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
    return m;
  }

  /**
   * Resuelve la transformación 2D a partir de un IFCAXIS2PLACEMENT2D.
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
   * Extrae puntos 2D discretizados en el plano local (u, v) a partir de cualquier entidad de curva STEP.
   * Soporta IFCPOLYLINE, IFCCOMPOSITECURVE, IFCTRIMMEDCURVE, IFCCIRCLE (Normas 3, 6, 7, 13, 22).
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

    // Registro de advertencia conforme a Norma 13 (Cero Supresión Silenciosa)
    const msg = `Tipo de curva 2D no soportado o no implementado en STEP #${curveRec.id} (${curveRec.type})`;
    console.warn(`[IfcStepImporter] ${msg}`);
    this.importWarnings.push(msg);
    return [];
  }

  /**
   * Extrae puntos 2D de un IFCINDEXEDPOLYCURVE (IFC4 / IFC4.3) resolviendo su IFCCARTESIANPOINTLIST2D / 3D.
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

    // Si Segments es omitido ($ o null o []), los puntos se conectan en orden secuencial
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
            const p = allPoints[idx - 1]; // 1-based en el estándar IFC
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
   * Discretiza un arco circular 2D definido por 3 puntos (P1: inicio, P2: paso intermedio, P3: fin).
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
   * Extrae puntos 2D de un IFCPOLYLINE escalados por lengthUnitScale.
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
   * Extrae y ensambla los segmentos de un IFCCOMPOSITECURVE respetando SameSense y fusionando extremos.
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

      // Concatenación sin operador spread (Norma 7) y eliminación de vértices duplicados en extremos (Norma 6)
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

    // Si el lazo es cerrado (último punto coincide con el primero), descartar el punto duplicado de cierre
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
   * Extrae puntos 2D discretizados de un IFCTRIMMEDCURVE (arcos de círculo, líneas, elipses o polilíneas recortadas).
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
      // 1. Intentar resolver extremos directos como puntos cartesianos
      const p1 = this.extractPoint2D(trim1Param);
      const p2 = this.extractPoint2D(trim2Param);

      if (p1 && p2) {
        return senseAgreement ? [p1, p2] : [p2, p1];
      }

      // 2. Si no vienen puntos cartesianos directos, evaluar analíticamente P(u) = P0 + u * V
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
   * Discretiza un IFCCIRCLE en puntos 2D en base a su IFCAXIS2PLACEMENT2D y radio.
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
   * Discretiza un IFCELLIPSE en puntos 2D en base a su IFCAXIS2PLACEMENT2D y semiejes rx, ry.
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
   * Extrae puntos 3D formalmente tipados (Vec3) y estado cerrado a partir de cualquier entidad de curva 3D STEP.
   * Cumple con Norma 6, Norma 7, Norma 11, Norma 13, Norma 18 y Norma 22.
   * Soporta IFCPOLYLINE, IFCINDEXEDPOLYCURVE, IFCCOMPOSITECURVE, IFCTRIMMEDCURVE, IFCCIRCLE e IFCELLIPSE.
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

    const msg = `Tipo de curva 3D no soportado o no implementado en STEP #${curveRec.id} (${curveRec.type})`;
    console.warn(`[IfcStepImporter] ${msg}`);
    this.importWarnings.push(msg);
    return { points: [], isClosed: false };
  }

  /**
   * Extrae puntos 3D de un IFCPOLYLINE escalados por lengthUnitScale.
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
   * Extrae puntos 3D de un IFCINDEXEDPOLYCURVE (IFC 4.3).
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
   * Extrae y concatena segmentos 3D de un IFCCOMPOSITECURVE.
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
   * Extrae puntos 3D de un IFCTRIMMEDCURVE (línea, círculo, elipse o curva recortada en 3D).
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
   * Discretiza un IFCCIRCLE en puntos 3D según su IFCAXIS2PLACEMENT3D / 2D y radio.
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
   * Discretiza un IFCELLIPSE en puntos 3D según su IFCAXIS2PLACEMENT3D / 2D y semiejes rx, ry.
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
   * Discretiza un arco circular 3D definido por 3 puntos en el espacio cartesiano.
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

    // Colineal o degenerado: degradar limpiamente a polilínea (Norma 11)
    if (nLen < GeometryTolerance.COINCIDENT_POINT) {
      return [p1, p2, p3];
    }

    // Centro del círculo circunscrito en 3D
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
   * Resuelve la matriz acumulada de colocación en el espacio del edificio a partir de un IFCLOCALPLACEMENT.
   * Aísla las proyecciones UTM kilométricas y cotas s.n.m. de IfcSite para mantener el modelo centrado
   * en el origen local (0, 0, 0) y preservar la precisión numérica de 32 bits en WebGL/Three.js.
   */
  private resolveLocalPlacementMatrix(placementRef: number, visited = new Set<number>()): THREE.Matrix4 {
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

    // Si este placement pertenece a IfcSite, capturar las coordenadas geodésicas mundiales acumuladas (Norma 22)
    // y neutralizar la traslación a (0, 0, 0) para mitigar pérdida de precisión IEEE 754 en WebGL.
    if (this.sitePlacementRefs.has(placementRef)) {
      if (!this.siteGeoTranslationCaptured) {
        const el = mCombined.elements;
        this.capturedSiteTranslation = { x: el[12], y: el[13], z: el[14] };
        this.capturedSiteRotation = new THREE.Matrix4().extractRotation(mCombined);
        this.siteGeoTranslationCaptured = true;
      }
      mCombined.setPosition(0, 0, 0);
    }

    return mCombined;
  }

  /**
   * Convierte una matriz de colocación afín de IFC (Z-Up) al sistema de coordenadas de CROQUERA (Y-Up).
   * det(C) = +1. Preserva rotaciones, reflexiones y escalas (Norma 21, Norma 22).
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
   * Extrae el mapa de Property Sets asociados por ID de elemento STEP.
   */
  private extractElementPsets(): Map<number, Record<string, Record<string, any>>> {
    const map = new Map<number, Record<string, Record<string, any>>>();

    const pendingFormulasByElem = new Map<
      number,
      Array<{ psetName: string; propertyName: string; formula: string }>
    >();

    const relDefinesList = this.parser.getRecordsByType('IFCRELDEFINESBYPROPERTIES');
    for (const rel of relDefinesList) {
      const relElements = rel.params[4];
      const relPsetRef = rel.params[5];

      if (!Array.isArray(relElements) || !relPsetRef || typeof relPsetRef !== 'object' || !('ref' in relPsetRef)) {
        continue;
      }

      const psetRec = this.records.get(relPsetRef.ref);
      if (!psetRec || psetRec.type !== 'IFCPROPERTYSET') continue;

      const psetName = this.getParamString(psetRec.params[2]) || 'Pset_Unknown';
      const propRefs = psetRec.params[4];
      if (!Array.isArray(propRefs)) continue;

      // Normalizar nombre de Pset y deserializar JSON de reglas si aplica
      let effectivePsetName = psetName;
      const isParametricPset = psetName === 'Pset_CroqueraParametric' || psetName === 'CroqueraParametric';
      const isLinksPset = psetName === 'Pset_CroqueraLinks' || psetName === 'CroqueraLinks';

      if (isParametricPset) {
        effectivePsetName = '__CROQUERA_PARAMETRIC_RULES__';
      } else if (isLinksPset) {
        effectivePsetName = '__CROQUERA_PARAMETRIC_LINKS__';
      }

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
          valType = typeof val === 'number' ? 'IfcLengthMeasure' : typeof val === 'boolean' ? 'IfcBoolean' : 'IfcLabel';
        }

        // Detección y curación de dobles empaquetados JSON legados (e.g. '{"type":"IfcLengthMeasure","value":8.18}')
        if (typeof val === 'string' && val.startsWith('{"type":') && val.includes('"value":')) {
          try {
            const parsed = JSON.parse(val);
            if (parsed && typeof parsed === 'object' && 'value' in parsed) {
              val = parsed.value;
              if (parsed.type) valType = parsed.type;
            }
          } catch { /* mantener val */ }
        }

        if (isParametricPset || effectivePsetName === '__CROQUERA_PARAMETRIC_RULES__') {
          let ruleJson = typeof val === 'string' ? val : JSON.stringify(val);
          // Desenvolver si venía con doble wrapping de tipo { type: 'IfcLabel', value: ... }
          if (typeof ruleJson === 'string' && ruleJson.startsWith('{')) {
            try {
              const parsed = JSON.parse(ruleJson);
              if (parsed && typeof parsed === 'object' && 'value' in parsed && typeof parsed.value === 'string') {
                ruleJson = parsed.value;
              }
            } catch { /* mantener ruleJson */ }
          }

          let parsedObj: any = null;
          if (typeof ruleJson === 'string' && ruleJson.startsWith('{')) {
            try { parsedObj = JSON.parse(ruleJson); } catch { parsedObj = null; }
          }

          // Detección y registro de fórmulas paramétricas
          if (propName.startsWith('Formula.') || propName.startsWith('Formula:') || (parsedObj && typeof parsedObj.formula === 'string')) {
            let targetPset = parsedObj?.psetName;
            let targetProp = parsedObj?.propertyName;
            let formulaStr = parsedObj?.formula || ruleJson;

            if (!targetPset || !targetProp) {
              const cleanKey = propName.replace(/^Formula[:.]/, '');
              const dotIdx = cleanKey.lastIndexOf('.');
              if (dotIdx !== -1) {
                targetPset = cleanKey.slice(0, dotIdx);
                targetProp = cleanKey.slice(dotIdx + 1);
              }
            }

            if (targetPset && targetProp && formulaStr) {
              for (const elemRef of relElements) {
                if (!elemRef || typeof elemRef !== 'object' || !('ref' in elemRef)) continue;
                let list = pendingFormulasByElem.get(elemRef.ref);
                if (!list) {
                  list = [];
                  pendingFormulasByElem.set(elemRef.ref, list);
                }
                list.push({ psetName: targetPset, propertyName: targetProp, formula: String(formulaStr) });
              }
            }
          } else if (parsedObj && typeof parsedObj.formula === 'string' && parsedObj.psetName && parsedObj.propertyName) {
            for (const elemRef of relElements) {
              if (!elemRef || typeof elemRef !== 'object' || !('ref' in elemRef)) continue;
              let list = pendingFormulasByElem.get(elemRef.ref);
              if (!list) {
                list = [];
                pendingFormulasByElem.set(elemRef.ref, list);
              }
              list.push({ psetName: parsedObj.psetName, propertyName: parsedObj.propertyName, formula: String(parsedObj.formula) });
            }
          }

          psetValues[propName] = {
            type: 'IfcLabel',
            value: ruleJson,
          };
        } else {
          psetValues[propName] = {
            type: valType,
            value: val,
          };
        }
      }

      for (const elemRef of relElements) {
        if (!elemRef || typeof elemRef !== 'object' || !('ref' in elemRef)) continue;
        const elemId = elemRef.ref;
        let elemPsets = map.get(elemId);
        if (!elemPsets) {
          elemPsets = {};
          map.set(elemId, elemPsets);
        }
        elemPsets[effectivePsetName] = psetValues;
        if (effectivePsetName !== psetName) {
          elemPsets[psetName] = psetValues;
        }
      }
    }

    // Rehidratación determinista final de fórmulas en sus Psets de origen
    for (const [elemId, formulas] of pendingFormulasByElem.entries()) {
      let elemPsets = map.get(elemId);
      if (!elemPsets) {
        elemPsets = {};
        map.set(elemId, elemPsets);
      }
      for (const pf of formulas) {
        if (!elemPsets[pf.psetName]) {
          elemPsets[pf.psetName] = {};
        }
        const existing = elemPsets[pf.psetName][pf.propertyName];
        if (existing && typeof existing === 'object') {
          existing.value = pf.formula;
        } else {
          elemPsets[pf.psetName][pf.propertyName] = {
            type: 'IfcLengthMeasure',
            value: pf.formula,
          };
        }
      }
    }

    return map;
  }

  /**
   * Extrae los metadatos de BuildingFramework de Pset_CroqueraBuildingFramework si existen.
   */
  private extractFrameworkMetadata(): {
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
              sections = parsed.map((s: any) => ({
                id: s.id,
                name: s.name,
                origin: new Vec3(s.origin[0], s.origin[1], s.origin[2]),
                normal: new Vec3(s.normal[0], s.normal[1], s.normal[2]),
                isGrid: s.isGrid,
                gridLabel: s.gridLabel,
              }));
            } catch { /* ignore */ }
          }
        }

        return { minBound, maxBound, levels, sections };
      }
    }

    return null;
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
   * Extrae los parámetros de georreferenciación formal LoGeoRef 50 (IFC 4.3).
   * Resuelve IFCGEOMETRICREPRESENTATIONCONTEXT, IFCMAPCONVERSION e IFCPROJECTEDCRS.
   */
  private extractGeorefFromContext(): void {
    if (this.extractedGeoref) return;

    const contexts = this.parser.getRecordsByType('IFCGEOMETRICREPRESENTATIONCONTEXT');
    if (contexts.length === 0) return;

    // Priorizar el contexto geométrico principal cuyo ContextType sea 'Model'
    const targetContext = contexts.find((c) => {
      const typeStr = this.getParamString(c.params[1]);
      return typeStr && typeStr.toLowerCase() === 'model';
    }) || contexts[0];

    // 1. Extraer TrueNorth del contexto
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

    // 2. Buscar operaciones de coordenadas (relación inversa HasCoordinateOperation)
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

    // 3. Extraer parámetros numéricos de MapConversion
    const eastings = this.getParamNumber(opRec.params[2], 0.0);
    const northings = this.getParamNumber(opRec.params[3], 0.0);
    const orthogonalHeight = this.getParamNumber(opRec.params[4], 0.0);
    const xAxisAbscissa = this.getParamNumber(opRec.params[5], 1.0);
    const xAxisOrdinate = this.getParamNumber(opRec.params[6], 0.0);
    const scale = this.getParamNumber(opRec.params[7], 1.0);

    // 4. Extraer IFCPROJECTEDCRS
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
   * Consolida la georreferenciación final considerando LoGeoRef 50 formal
   * o fallback de traslación geodésica de IfcSite.
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

    // Si no hubo traslación de IfcSite ni MapConversion formal, pero sí un TrueNorth rotado en el contexto:
    if (this.extractedTrueNorth) {
      this.extractedGeoref = {
        crsName: null,
        crsDescription: 'Orientación TrueNorth de GeometricRepresentationContext',
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

    // El último parámetro suele ser el PredefinedType si es un enum
    const last = rec.params[rec.params.length - 1];
    if (last && typeof last === 'object' && 'enum' in last) {
      return last.enum;
    }
    return null;
  }

  /**
   * Pre-pass O(N) para indexar estilos de presentación e instanciar materiales relacionales.
   * Resuelve la cadena buildingSMART:
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

    const id = defaultId;
    const rec: MaterialRecord = {
      id,
      name: name || `Material ${cleanHex}`,
      baseColor: cleanHex,
      colorHex: cleanHex,
      roughness,
      metalness,
      opacity: clampedOpacity,
    };
    this.materialCatalog.set(id, rec);

    return id;
  }

  /**
   * Importa y rehidrata los materiales PBR definidos en el archivo STEP.
   * Retorna un mapa del StepId del elemento al ID del MaterialRecord.
   */
  private importMaterials(_db?: any): Map<number, string> {
    const elemToMatIdMap = new Map<number, string>();
    const relMaterials = this.parser.getRecordsByType('IFCRELASSOCIATESMATERIAL');
    if (relMaterials.length === 0) return elemToMatIdMap;

    // Cache de materialStepId -> MaterialRecord.id
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
   * Resuelve recursivamente la definición de un material a partir de su referencia STEP.
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

    // Buscar IFCSURFACESTYLE asociado
    let surfaceStyleRec: StepRecord | null = null;

    // 1. A través de IFCMATERIALDEFINITIONREPRESENTATION
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
              // Navegar Items (params[3]) -> StyledItem (params[1]) -> SurfaceStyle (M-7)
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

    // 2. Si no se encontró, buscar por nombre exacto de IFCSURFACESTYLE
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
            // Color RGB
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

            // Transparencia -> Opacidad
            const transParam = elRec.params[1];
            if (typeof transParam === 'number' || typeof transParam === 'string') {
              const trans = parseFloat(String(transParam)) || 0;
              opacity = Number(Math.max(0, Math.min(1, 1.0 - trans)).toFixed(3));
            }

            // Textura
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
    }

    const cleanName = matName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const matId = `mat_${cleanName}_${matStepRef}`;

    const materialRecord: MaterialRecord = {
      id: matId,
      name: matName,
      baseColor,
      colorHex: baseColor,
      roughness: 0.7,
      metalness: 0.05,
      opacity,
    };

    this.materialCatalog.set(materialRecord.id, materialRecord);
    return materialRecord;
  }
}