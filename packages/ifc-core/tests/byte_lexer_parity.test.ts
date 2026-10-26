import { describe, it, expect } from 'vitest';
import { IfcStepLexer, StepTokenType } from '../src/lexer/IfcStepLexer';
import { IfcStepByteLexer } from '../src/lexer/IfcStepByteLexer';

describe('IfcStepByteLexer Parity Tests', () => {
  const encoder = new TextEncoder();

  function compareLexers(rawStepLine: string) {
    const bytes = encoder.encode(rawStepLine);
    const strLexer = new IfcStepLexer(rawStepLine);
    const byteLexer = new IfcStepByteLexer(bytes, 0, bytes.length);

    let tokenIndex = 0;
    while (true) {
      const strToken = strLexer.nextToken();
      const byteType = byteLexer.nextToken();

      expect(byteType, `Mismatch in token type at index ${tokenIndex}`).toBe(strToken.type);

      if (strToken.type === StepTokenType.EOF) {
        break;
      }

      // Check values
      if (strToken.type === StepTokenType.REF) {
        expect(byteLexer.refValue, `Mismatch in REF value at index ${tokenIndex}`).toBe(strToken.value);
      } else if (strToken.type === StepTokenType.NUMBER) {
        expect(
          Object.is(byteLexer.numValue, strToken.value),
          `Mismatch in NUMBER at index ${tokenIndex}: byte=${byteLexer.numValue}, str=${strToken.value}`
        ).toBe(true);
      } else if (strToken.type === StepTokenType.STRING || strToken.type === StepTokenType.ENUM || strToken.type === StepTokenType.WORD) {
        expect(byteLexer.stringValue, `Mismatch in string/enum/word at index ${tokenIndex}`).toBe(strToken.value);
      }

      tokenIndex++;
    }
  }

  it('maintains 100% token parity on complex STEP records', () => {
    const samples = [
      `#10= IFCWALL('2O2Fr$t4X7Zf8NOew3FL9r',#2,'Muro exterior',$,'Base',#5,#8,'12345',.SOLIDWALL.);`,
      `#20= IFCCARTESIANPOINT((1234.5678,-98.7654,0.));`,
      `#30= IFCDIRECTION((1.E-05,-1.E-05,1.0));`,
      `#40= IFCPROPERTYSET('1A2B3C',$,'Pset_WallCommon',$,(#41,#42,#43));`,
      `#50= IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.T.),$);`,
      `#60= IFCPROPERTYSINGLEVALUE('Description',$,IFCTEXT('Texto con comillas ''escapadas'' y barras \\\\'),$);`,
      `#70= IFCPROPERTYSINGLEVALUE('Unicode',$,IFCLABEL('Sala \\X2\\00D1and\\X0\\'),$);`,
      `#80= IFCAXIS2PLACEMENT3D(#81,#82,#83);`,
      `#90= IFCCOMPOSITECURVE((#91,#92),.NOTDEFINED.);`,
      `#100= IFCQUANTITYLENGTH('Height',$,$,177047.69148133343,$);`,
      `#110= IFCTRIANGULATEDFACESET(#111,((1,2,3),(2,3,4)),.T.,$,$);`,
    ];

    for (const line of samples) {
      compareLexers(line);
    }
  });
});
