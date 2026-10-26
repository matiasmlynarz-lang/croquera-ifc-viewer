import { describe, it, expect } from 'vitest';
import { ChunkedStreamScanner } from '../src/parser/ChunkedStreamScanner';
import { IfcStepImporter } from '../src/importer/IfcStepImporter';

describe('Material Style Precedence (Rule 15 & IFC 4.3)', () => {
  it('preserves IFCSTYLEDITEM submesh and face materials over product-level default materials', () => {
    const ifcContent = `
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test_win.ifc','2026-10-24T00:00:00',('Antigravity'),('Croquera'),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1= IFCPROJECT('0000000000000000000001',#2,'Project',$,$,$,$,(#10),#3);
#2= IFCOWNERHISTORY(#4,#5,$,.NOCHANGE.,$,$,$,0);
#3= IFCUNITASSIGNMENT((#6));
#4= IFCPERSONANDORGANIZATION(#7,#8,$);
#5= IFCAPPLICATION(#8,'1.0','Croquera','Croquera');
#6= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7= IFCPERSON('ID','Author',$,$,$,$,$,$);
#8= IFCORGANIZATION('ID','Org',$,$,$);
#9= IFCCARTESIANPOINT((0.,0.,0.));
#10= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.0001,#11,$);
#11= IFCAXIS2PLACEMENT3D(#9,$,$);

#20= IFCSITE('0000000000000000000002',#2,'Site',$,$,#21,$,$,.ELEMENT.,(0,0,0),(0,0,0),0.,$,$);
#21= IFCLOCALPLACEMENT($,#11);
#22= IFCBUILDING('0000000000000000000003',#2,'Building',$,$,#23,$,$,.ELEMENT.,$,$,$);
#23= IFCLOCALPLACEMENT(#21,#11);
#24= IFCBUILDINGSTOREY('0000000000000000000004',#2,'Level 1',$,$,#25,$,$,.ELEMENT.,0.);
#25= IFCLOCALPLACEMENT(#23,#11);
#26= IFCRELAGGREGATES('0000000000000000000005',#2,$,$,#1,(#20));
#27= IFCRELAGGREGATES('0000000000000000000006',#2,$,$,#20,(#22));
#28= IFCRELAGGREGATES('0000000000000000000007',#2,$,$,#22,(#24));

/* Product-level material association (anonymous layer set usage -> would default to clay) */
#30= IFCMATERIAL('Default_Wall_Mat');
#31= IFCRELASSOCIATESMATERIAL('0000000000000000000010',#2,$,$,(#50),#30);

/* Styled Item for Glass: color #F0F7F3, transparency 0.88 (opacity 0.12) */
#40= IFCCOLOURRGB($,0.941176,0.968627,0.952941);
#41= IFCSURFACESTYLERENDERING(#40,0.88,$,$,$,$,$,$,.NOTDEFINED.);
#42= IFCSURFACESTYLE('GlassStyle',.BOTH.,(#41));
#43= IFCPRESENTATIONSTYLEASSIGNMENT((#42));
#44= IFCSTYLEDITEM(#60,(#43),$);

/* Window Product with Brep geometry item */
#50= IFCWINDOW('0000000000000000000020',#2,'Window',$,$,#51,#52,$,1.0,1.5);
#51= IFCLOCALPLACEMENT(#25,#11);
#52= IFCPRODUCTDEFINITIONSHAPE($,$,(#53));
#53= IFCSHAPEREPRESENTATION(#10,'Body','Brep',(#60));

/* Closed shell for glass pane */
#60= IFCFACETEDBREP(#61);
#61= IFCCLOSEDSHELL((#70,#71,#72,#73,#74,#75));
#70= IFCFACE((#80));
#71= IFCFACE((#81));
#72= IFCFACE((#82));
#73= IFCFACE((#83));
#74= IFCFACE((#84));
#75= IFCFACE((#85));

#80= IFCFACEOUTERBOUND(#90,.T.);
#81= IFCFACEOUTERBOUND(#91,.T.);
#82= IFCFACEOUTERBOUND(#92,.T.);
#83= IFCFACEOUTERBOUND(#93,.T.);
#84= IFCFACEOUTERBOUND(#94,.T.);
#85= IFCFACEOUTERBOUND(#95,.T.);

#90= IFCPOLYLOOP((#100,#101,#102));
#91= IFCPOLYLOOP((#100,#102,#103));
#92= IFCPOLYLOOP((#104,#106,#105));
#93= IFCPOLYLOOP((#104,#107,#106));
#94= IFCPOLYLOOP((#100,#104,#105));
#95= IFCPOLYLOOP((#101,#105,#106));

#100= IFCCARTESIANPOINT((0.,0.,0.));
#101= IFCCARTESIANPOINT((1.,0.,0.));
#102= IFCCARTESIANPOINT((1.,1.,0.));
#103= IFCCARTESIANPOINT((0.,1.,0.));
#104= IFCCARTESIANPOINT((0.,0.,0.1));
#105= IFCCARTESIANPOINT((1.,0.,0.1));
#106= IFCCARTESIANPOINT((1.,1.,0.1));
#107= IFCCARTESIANPOINT((0.,1.,0.1));

#120= IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000030',#2,$,$,(#50),#24);
ENDSEC;
END-ISO-10303-21;
`;

    const encoder = new TextEncoder();
    const arrayBuf = encoder.encode(ifcContent).buffer;
    const scanner = new ChunkedStreamScanner(arrayBuf);
    scanner.parseHeader();
    scanner.scanDataSection();

    const importer = IfcStepImporter.fromStreamingParser(scanner);
    importer.extractSpatialHierarchy();

    const elements: any[] = [];
    importer.extractGeometryChunks(100, (chunk) => {
      for (const el of chunk.elements) {
        elements.push(el);
      }
    });

    const windowParts = elements.filter((el) => el.type === 'GEOMETRY_ENTITY' && el.stepId === 50);
    expect(windowParts.length).toBeGreaterThan(0);

    const glassPart = windowParts[0];
    expect(glassPart.materialId).toBeDefined();
    // Glass style material must match the IFCSTYLEDITEM (#f0f7f3 with opacity 12)
    expect(glassPart.materialId).toContain('mat_ifc_f0f7f3_a12');
    expect(glassPart.materialId).not.toBe('mat_default_wall_mat');
  });
});
