import { describe, expect, it, test } from '@jest/globals';
import { divide, toFraction } from '../src';
import type { RoundingMode } from '../src';

describe('divide', () => {
  test.each<[RoundingMode, bigint, bigint]>([
    ['half-even', 25n, 2n],
    ['half-even', 35n, 4n],
    ['half-up', 25n, 3n],
    ['half-down', 25n, 2n],
    ['up', 21n, 3n],
    ['down', 29n, 2n],
    ['ceiling', -21n, -2n],
    ['floor', -21n, -3n],
  ])('rounds %s: %p / 10 is %p', (mode, numerator, want) => {
    expect(divide(numerator, 10n, mode)).toBe(want);
  });

  it('rejects a denominator that is not positive', () => {
    expect(() => divide(1n, 0n)).toThrow(RangeError);
  });
});

describe('toFraction', () => {
  it.each<[number, [bigint, bigint]]>([
    [0.1, [1n, 10n]],
    [-2.5, [-25n, 10n]],
    [1.5e-7, [15n, 100000000n]],
    [3e21, [3000000000000000000000n, 1n]],
  ])('reads %p exactly', (value, want) => {
    expect(toFraction(value)).toEqual(want);
  });

  it('rejects infinity', () => {
    expect(() => toFraction(Infinity)).toThrow(RangeError);
  });
});
