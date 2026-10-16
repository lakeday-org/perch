import { describe, expect, it } from 'vitest';
import { joinPaths, normalizePath, PathTemplate, QueryError } from '../src';

describe('joinPaths', () => {
  it.each([
    [['/api', 'users'], '/api/users'],
    [['/api/', '/users/'], '/api/users/'],
    [['api', '', 'v2'], '/api/v2'],
  ])('joins %j into %s', (segments, want) => {
    expect(joinPaths(...segments)).toBe(want);
  });
});

describe('normalizePath', () => {
  it('removes dot segments', () => {
    expect(normalizePath('/a/b/../c/./d')).toBe('/a/c/d');
  });

  it('collapses repeated slashes', () => {
    expect(normalizePath('//a///b')).toBe('/a/b');
  });

  it('upper-cases percent escapes', () => {
    expect(normalizePath('/caf%c3%a9')).toBe('/caf%C3%A9');
  });
});

describe('PathTemplate', () => {
  const template = new PathTemplate('/users/{id}/posts/{slug}');

  it('lists its parameter names', () => {
    expect(template.names).toEqual(['id', 'slug']);
  });

  it('matches a path and decodes its parameters', () => {
    expect(template.match('/users/42/posts/hello%20world')).toEqual({ id: '42', slug: 'hello world' });
  });

  it('does not match a path of another shape', () => {
    expect(template.match('/users/42')).toBeNull();
  });

  it('expands parameters into a path', () => {
    expect(template.expand({ id: 7, slug: 'a b' })).toBe('/users/7/posts/a%20b');
  });

  it('throws when a parameter is missing', () => {
    expect(() => template.expand({ id: 7 })).toThrow(QueryError);
  });

  it('matches the rest of a path with a star parameter', () => {
    const files = new PathTemplate('/files/{*path}');
    expect(files.match('/files/a/b/c.txt')).toEqual({ path: 'a/b/c.txt' });
    expect(files.expand({ path: 'a b/c' })).toBe('/files/a%20b/c');
  });

  it('rejects a star parameter that is not last', () => {
    expect(() => new PathTemplate('/{*rest}/x')).toThrow(QueryError);
  });
});
