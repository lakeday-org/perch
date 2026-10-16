import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from '../src';
import type { ArrayFormat, QueryObject } from '../src';

/** What comes back from writing a value and reading it again. */
function roundTrip(value: QueryObject, arrayFormat?: ArrayFormat): QueryObject {
  return parse(stringify(value, { arrayFormat }), { arrayFormat });
}

const cases: Array<{ name: string; value: QueryObject; arrayFormat?: ArrayFormat }> = [
  { name: 'a flat object', value: { a: '1', b: 'two' } },
  { name: 'a nested object', value: { user: { name: 'ada', langs: ['en', 'fr'] } } },
  { name: 'an array in brackets', value: { tag: ['x', 'y'] } },
  { name: 'an array by index', value: { tag: ['x', 'y'] }, arrayFormat: 'indices' },
  { name: 'reserved characters', value: { q: 'a&b=c d/é' } },
];

describe('stringify', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a flat object', () => {
    expect(stringify({ a: 1, b: 'two', c: true })).toBe('a=1&b=two&c=true');
  });

  it('drops undefined values', () => {
    expect(stringify({ a: undefined, b: '1' })).toBe('b=1');
  });

  it('writes null as a bare key unless skipNull is set', () => {
    expect(stringify({ flag: null, x: 1 })).toBe('flag&x=1');
    expect(stringify({ flag: null, x: 1 }, { skipNull: true })).toBe('x=1');
  });

  it('sorts keys when asked', () => {
    expect(stringify({ b: 1, a: 2, c: 3 }, { sort: true })).toBe('a=2&b=1&c=3');
    expect(stringify({ b: 1, a: 2, c: 3 }, { sort: (x, y) => y.localeCompare(x) })).toBe('c=3&b=1&a=2');
  });

  it('encodes reserved characters in keys and values', () => {
    expect(stringify({ 'a b': 'c&d', 'filter[name]': "o'neil" })).toBe('a%20b=c%26d&filter[name]=o%27neil');
  });

  it('writes arrays in each format', () => {
    const value = { a: ['1', '2'] };
    expect(stringify(value, { arrayFormat: 'brackets' })).toBe('a[]=1&a[]=2');
    expect(stringify(value, { arrayFormat: 'indices' })).toBe('a[0]=1&a[1]=2');
    expect(stringify(value, { arrayFormat: 'comma' })).toBe('a=1,2');
    expect(stringify(value, { arrayFormat: 'repeat' })).toBe('a=1&a=2');
  });

  it('warns about a legacy array format name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(stringify({ a: ['1'] }, { arrayFormat: 'bracket' as ArrayFormat })).toBe('a[]=1');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('rejects an unknown array format', () => {
    expect(() => stringify({ a: '1' }, { arrayFormat: 'semicolon' as ArrayFormat })).toThrow(TypeError);
  });

  describe('round trip', () => {
    for (const t of cases) {
      it(t.name + ' survives a round trip', () => {
        expect(roundTrip(t.value, t.arrayFormat)).toEqual(t.value);
      });
    }
  });
});
