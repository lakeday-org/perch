import { describe, expect, it } from 'vitest';
import { parse, QueryError } from '../src';

describe('parse', () => {
  it('reads a flat query', () => {
    expect(parse('a=1&b=two')).toEqual({ a: '1', b: 'two' });
  });

  it('ignores a leading question mark', () => {
    expect(parse('?a=1')).toEqual({ a: '1' });
  });

  it('keeps a key with no value as null', () => {
    expect(parse('flag&x=1')).toEqual({ flag: null, x: '1' });
  });

  it.each([
    ['a[]=1&a[]=2', 'brackets', { a: ['1', '2'] }],
    ['a[0]=1&a[1]=2', 'indices', { a: ['1', '2'] }],
    ['a=1,2', 'comma', { a: ['1', '2'] }],
    ['a=1&a=2', 'repeat', { a: ['1', '2'] }],
  ] as const)('parses %s as %s', (input, arrayFormat, want) => {
    expect(parse(input, { arrayFormat })).toEqual(want);
  });

  it('nests bracketed keys', () => {
    expect(parse('user[name]=ada&user[langs][]=en&user[langs][]=fr')).toEqual({ user: { name: 'ada', langs: ['en', 'fr'] } });
  });

  it('stops nesting past the depth limit', () => {
    expect(parse('a[b][c][d]=1', { depth: 2 })).toEqual({ a: { b: { 'c[d]': '1' } } });
  });

  it('rejects a negative depth', () => {
    expect(() => parse('a=1', { depth: -1 })).toThrow(RangeError);
  });

  it('turns numbers into numbers when asked', () => {
    expect(parse('page=2&ratio=-0.5&id=0x1f', { parseNumbers: true })).toEqual({ page: 2, ratio: -0.5, id: '0x1f' });
  });

  it('rejects an empty key', () => {
    expect(() => parse('=1')).toThrow(QueryError);
  });

  it('decodes plus signs and percent escapes', () => {
    expect(parse('q=hello+world%21')).toEqual({ q: 'hello world!' });
  });

  it('keeps a broken escape as written', () => {
    expect(parse('q=100%')).toEqual({ q: '100%' });
  });

  it('leaves escapes alone with decode off', () => {
    expect(parse('q=a%20b', { decode: false })).toEqual({ q: 'a%20b' });
  });
});
