import { describe, expect, it } from '@jest/globals';
import { allocateMinor } from '../src';

describe('allocateMinor', () => {
  it('gives the remainder to the earliest of equal shares', () => {
    expect(allocateMinor(100n, [1, 1, 1])).toEqual([34n, 33n, 33n]);
  });

  it('splits by uneven ratios', () => {
    expect(allocateMinor(1000n, [70, 20, 10])).toEqual([700n, 200n, 100n]);
  });

  it('splits a negative total', () => {
    expect(allocateMinor(-100n, [1, 1, 1])).toEqual([-34n, -33n, -33n]);
  });

  it('rejects ratios that are all zero', () => {
    expect(() => allocateMinor(5n, [0, 0])).toThrow(RangeError);
  });
});
