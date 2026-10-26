import { describe, it, expect } from 'vitest';
import { IfcStepImporter, PolyMesh } from '../src';

const STEP_DATA = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2026-10-23',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#2),#10);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#3,#5);
#3=IFCAXIS2PLACEMENT3D(#4,#5,#6);
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCDIRECTION((0.,0.,1.));
#6=IFCDIRECTION((1.,0.,0.));
#7=IFCDIRECTION((-1.,0.,0.));
#8=IFCDIRECTION((0.,-1.,0.));
#9=IFCDIRECTION((0.,0.,1.));
#11=IFCDIRECTION((0.,1.));
#12=IFCDIRECTION((-1.,0.));
#10=IFCUNITASSIGNMENT((#13));
#13=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#14=IFCCARTESIANPOINT((0.,0.));

#7300=IFCCARTESIANPOINT((1.6875381349892133,0.));
#7301=IFCAXIS2PLACEMENT2D(#7300,#12);
#7302=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7301,3.3750762699784267,0.024999999999999731);
#7303=IFCAXIS2PLACEMENT3D(#4,$,$);
#7304=IFCEXTRUDEDAREASOLID(#7302,#7303,#9,2.6999998125252671);

#7305=IFCCARTESIANPOINT((0.,-2.0999999999980457));
#7306=IFCCARTESIANPOINT((0.02500000000032513,-2.0999999999980457));
#7307=IFCCARTESIANPOINT((0.02500000000032513,0.));
#7308=IFCPOLYLINE((#14,#7305,#7306,#7307,#14));
#7309=IFCCARTESIANPOINT((3.3625762699784261,0.012500000000324996,2.0999999999980457));
#7310=IFCAXIS2PLACEMENT3D(#7309,#7,#8);
#7311=IFCPLANE(#7310);
#7312=IFCCARTESIANPOINT((3.3625762699784261,0.012500000000324996,2.0999999999980457));
#7313=IFCAXIS2PLACEMENT3D(#7312,#7,#8);
#7314=IFCPOLYGONALBOUNDEDHALFSPACE(#7311,.T.,#7313,#7308);
#7315=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#7304,#7314);

#7316=IFCCARTESIANPOINT((-0.012500000000000622,0.));
#7317=IFCCARTESIANPOINT((-0.012500000000000622,-0.024999999999674873));
#7318=IFCCARTESIANPOINT((0.,-0.024999999999674873));
#7319=IFCPOLYLINE((#14,#7316,#7317,#7318,#14));
#7320=IFCCARTESIANPOINT((3.3625762699784261,-0.012499999999675005,2.0999999999980457));
#7321=IFCAXIS2PLACEMENT3D(#7320,#9,#7);
#7322=IFCPLANE(#7321);
#7323=IFCCARTESIANPOINT((3.3625762699784261,-0.012499999999675005,2.0999999999980457));
#7324=IFCAXIS2PLACEMENT3D(#7323,#9,#7);
#7325=IFCPOLYGONALBOUNDEDHALFSPACE(#7322,.T.,#7324,#7319);
#7326=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#7315,#7325);

#7328=IFCSHAPEREPRESENTATION(#2,'Body','Clipping',(#7326));
#7329=IFCPRODUCTDEFINITIONSHAPE($,$,(#7328));
#7330=IFCWALL('3ueuomZd9CNA4hUyetwW_z',$,'Basic Wall:Revestimiento 3cm:379058',$,$,#7303,#7329,'379058',.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;
`;

describe('Wall 3ueuomZd9CNA4hUyetwW_z Clipping Verification', () => {
  it('correctly imports and preserves wall 3ueuomZd9CNA4hUyetwW_z with complete 3.375m length and 2.70m height', () => {
    const importer = new IfcStepImporter(STEP_DATA);
    importer.prepareImport();
    const elements: any[] = [];
    importer.extractGeometryChunks(100, (chunk) => {
      elements.push(...chunk.elements);
    });

    expect(elements.length).toBeGreaterThan(0);
    console.log('Total elements extracted:', elements.length);
    const geomEntity = elements.find((e) => e.parentId === '3ueuomZd9CNA4hUyetwW_z' || (e.type === 'GEOMETRY_ENTITY' && e.positions?.length > 0));
    expect(geomEntity).toBeDefined();

    const positions: Float32Array = geomEntity.positions;
    expect(positions.length).toBeGreaterThan(0);

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]);
      maxX = Math.max(maxX, positions[i]);
      minY = Math.min(minY, positions[i + 1]);
      maxY = Math.max(maxY, positions[i + 1]);
      minZ = Math.min(minZ, positions[i + 2]);
      maxZ = Math.max(maxZ, positions[i + 2]);
    }

    console.log(`Bounds: X=[${minX.toFixed(4)}, ${maxX.toFixed(4)}], Y=[${minY.toFixed(4)}, ${maxY.toFixed(4)}], Z=[${minZ.toFixed(4)}, ${maxZ.toFixed(4)}]`);

    // Full wall length is preserved (starts at 0 and extends to 3.375m)
    expect(minX).toBeCloseTo(0.0, 2);
    expect(maxX).toBeCloseTo(3.375, 2);

    // Wall height is 2.70m in Y (Three.js Y-up: from 0 to 2.70)
    expect(minY).toBeCloseTo(0.0, 2);
    expect(maxY).toBeCloseTo(2.70, 2);

    // Wall thickness is 0.025m in Z (from -0.0125 to +0.0125)
    expect(minZ).toBeCloseTo(-0.0125, 2);
    expect(maxZ).toBeCloseTo(0.0125, 2);
  });
});

