import { beforeEach, describe, expect, it } from 'vitest';
import { SearchParams } from '../src';

describe('SearchParams', () => {
  let params: SearchParams;

  beforeEach(() => {
    params = new SearchParams('?tag=a&tag=b&page=2&q=hello+world');
  });

  it('reads the first value of a key', () => {
    expect(params.get('tag')).toBe('a');
    expect(params.get('missing')).toBeNull();
  });

  it('reads every value of a key', () => {
    expect(params.getAll('tag')).toEqual(['a', 'b']);
  });

  it('decodes what it reads', () => {
    expect(params.get('q')).toBe('hello world');
  });

  it('replaces every value of a key with set', () => {
    params.set('tag', 'c');
    expect(params.getAll('tag')).toEqual(['c']);
    expect(params.toString()).toBe('tag=c&page=2&q=hello%20world');
  });

  it('deletes one value or all of them', () => {
    params.delete('tag', 'a');
    expect(params.getAll('tag')).toEqual(['b']);
    params.delete('tag');
    expect(params.has('tag')).toBe(false);
  });

  it('sorts by key and keeps the order of equal keys', () => {
    params.append('a', 'z').sort();
    expect(params.toString()).toBe('a=z&page=2&q=hello%20world&tag=a&tag=b');
  });

  it('builds from an object of lists', () => {
    const built = new SearchParams({ a: ['1', '2'], b: '3' });
    expect(built.toString()).toBe('a=1&a=2&b=3');
    expect(built.size).toBe(3);
  });

  it('builds from entries', () => {
    const built = new SearchParams([['x', '1']]);
    expect(built.has('x', '1')).toBe(true);
    expect([...built]).toEqual([['x', '1']]);
  });
});
