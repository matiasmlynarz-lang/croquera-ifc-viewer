import { describe, it, expect } from 'vitest';
import { StepByteNumber } from '../src/lexer/StepByteNumber';

describe('StepByteNumber Unit Tests', () => {
  const encoder = new TextEncoder();

  function parse(str: string): number {
    const bytes = encoder.encode(str);
    const cursor = { pos: 0 };
    return StepByteNumber.parseNumber(bytes, 0, bytes.length, cursor);
  }

  it('correctly parses canonical STEP numbers with exact bit parity', () => {
    const cases = [
      '0.',
      '-0.',
      '+0.',
      '1.E-05',
      '+1.5',
      '.5',
      '-.5',
      '1234.5678',
      '-98.7654',
      '0.000123',
      '999999.999999',
      '100000000000000.',
      '-100000000000000.',
      '3.14159265358979',
      '2.71828182845904',
      // High-precision 16-17 digit coordinates typical of Revit/Tekla
      '177047.69148133343',
      '3392408.1159127178',
      '274.44999999999999',
      '0.60000000000000009',
      '-7.3731461616277283',
      '6.1230317691118863E-17',
      '1.0000000000000001E-05',
      '-0.50000108368230201',
      // Extreme values
      '1E308',
      '1E-308',
      '2.2250738585072014E-308',
    ];

    for (const c of cases) {
      const expected = parseFloat(c);
      const actual = parse(c);
      expect(Object.is(actual, expected), `Failed exact match on "${c}": actual=${actual}, expected=${expected}`).toBe(true);
    }
  });

  it('preserves negative zero (-0) identically to IEEE-754', () => {
    const negZero = parse('-0.');
    expect(Object.is(negZero, -0)).toBe(true);
    expect(1 / negZero).toBe(-Infinity);

    const posZero = parse('0.');
    expect(Object.is(posZero, 0)).toBe(true);
    expect(1 / posZero).toBe(Infinity);
  });

  it('scans integer references accurately', () => {
    const sample = encoder.encode('#123456789,');
    const cursor = { pos: 1 }; // skip '#'
    const ref = StepByteNumber.parseInteger(sample, 1, sample.length, cursor);
    expect(ref).toBe(123456789);
    expect(cursor.pos).toBe(10); // stopped at comma
  });

  it('achieves 100% bit-exactness over 50,000 random generated floating-point numbers', () => {
    let seed = 42;
    function rand() {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    }

    for (let i = 0; i < 50000; i++) {
      const sign = rand() < 0.5 ? '-' : '';
      const intPart = Math.floor(rand() * 1000000);
      const fracPart = Math.floor(rand() * 1000000);
      const exp = Math.floor(rand() * 40) - 20;

      let str = '';
      const style = Math.floor(rand() * 4);
      if (style === 0) {
        str = `${sign}${intPart}.${fracPart}`;
      } else if (style === 1) {
        str = `${sign}${intPart}.${fracPart}E${exp >= 0 ? '+' : ''}${exp}`;
      } else if (style === 2) {
        str = `${sign}.${fracPart}`;
      } else {
        str = `${sign}${intPart}.`;
      }

      const expected = parseFloat(str);
      const actual = parse(str);
      expect(
        Object.is(actual, expected),
        `Mismatch on random float "${str}": actual=${actual}, expected=${expected}`
      ).toBe(true);
    }
  });

  it('achieves 100% bit-exactness over 50,000 high-precision 16 to 19 digit numbers (Tier 2 Eisel-Lemire)', () => {
    let seed = 987654321;
    function rand() {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    }

    for (let i = 0; i < 50000; i++) {
      const digitsCount = 16 + Math.floor(rand() * 4); // 16, 17, 18, 19 digits
      let digits = '';
      digits += Math.floor(1 + rand() * 9);
      for (let d = 1; d < digitsCount; d++) {
        digits += Math.floor(rand() * 10);
      }
      const dotPos = Math.floor(1 + rand() * (digitsCount - 1));
      const expVal = Math.floor(rand() * 80) - 40;
      const neg = rand() < 0.5;
      const s = (neg ? '-' : '') + digits.slice(0, dotPos) + '.' + digits.slice(dotPos) + 'e' + expVal;

      const expected = parseFloat(s);
      const actual = parse(s);
      expect(
        Object.is(actual, expected),
        `Tier 2 Eisel-Lemire mismatch on "${s}": actual=${actual}, expected=${expected}`
      ).toBe(true);
    }
  });
});
