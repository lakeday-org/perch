import { describe, expect, it } from 'vitest';
import { QueryError, Url } from '../src';

describe('Url', () => {
  const base = new Url('https://api.example.com:443/v1/users/?page=2#top');

  it('splits a URL into its parts', () => {
    expect(base.protocol).toBe('https');
    expect(base.hostname).toBe('api.example.com');
    expect(base.port).toBe('');
    expect(base.pathname).toBe('/v1/users/');
    expect(base.searchParams.get('page')).toBe('2');
    expect(base.hash).toBe('#top');
  });

  it('keeps a port that is not the default', () => {
    expect(new Url('http://localhost:8080/').host).toBe('localhost:8080');
  });

  it('resolves a relative path against a base', () => {
    expect(new Url('../teams?x=1', 'https://api.example.com/v1/users/42').toString()).toBe('https://api.example.com/v1/teams?x=1');
  });

  it('replaces query parameters and leaves the original alone', () => {
    const next = base.withQuery({ page: 3, sort: 'name' });
    expect(next.search).toBe('?page=3&sort=name');
    expect(base.search).toBe('?page=2');
  });

  it('removes a parameter set to undefined', () => {
    expect(base.withQuery({ page: undefined }).toString()).toBe('https://api.example.com/v1/users/#top');
  });

  it('appends path segments', () => {
    expect(base.withPath('42', 'posts').pathname).toBe('/v1/users/42/posts');
  });

  it('compares URLs after normalizing them', () => {
    expect(new Url('HTTPS://API.example.com:443/a/./b/../c').equals('https://api.example.com/a/c')).toBe(true);
  });

  it('throws on a relative URL with no base', () => {
    expect(() => new Url('/users')).toThrow(QueryError);
  });

  it('throws on a port that is not a number', () => {
    expect(() => new Url('http://example.com:http/')).toThrow(QueryError);
  });

  it.skip('converts an internationalized host to punycode', () => {
    expect(new Url('https://bücher.example/').hostname).toBe('xn--bcher-kva.example');
  });
});
