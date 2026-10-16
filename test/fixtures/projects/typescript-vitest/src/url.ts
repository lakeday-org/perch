import { currentOrigin } from './env';
import { QueryError } from './errors';
import { joinPaths } from './path/join';
import { normalizePath } from './path/normalize';
import { SearchParams } from './search-params';

const ABSOLUTE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;
const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443', ws: '80', wss: '443' };

/** An absolute URL, normalized: lower-case scheme and host, no default port, no dot segments in the path. */
export class Url {
  readonly protocol: string;
  readonly username: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly searchParams: SearchParams;
  readonly hash: string;

  /** A relative `input` is resolved against `base`, or in a browser against the page's origin. */
  constructor(input: string, base?: string) {
    let match = ABSOLUTE.exec(input.trim());
    if (!match) {
      const origin = base ?? currentOrigin();
      if (!origin) throw new QueryError('relative URL with no base', input);
      match = ABSOLUTE.exec(Url.resolve(origin, input.trim()));
      if (!match) throw new QueryError('invalid base URL', origin);
    }
    const [, scheme, authority, path, search, fragment] = match;
    const at = authority.lastIndexOf('@');
    const hostPort = at === -1 ? authority : authority.slice(at + 1);
    const colon = hostPort.lastIndexOf(':');
    const host = colon === -1 ? hostPort : hostPort.slice(0, colon);
    const port = colon === -1 ? '' : hostPort.slice(colon + 1);
    if (!host) throw new QueryError('URL has no host', input);
    if (port && !/^\d+$/.test(port)) throw new QueryError('port is not a number', input);
    this.protocol = scheme.toLowerCase();
    this.username = at === -1 ? '' : authority.slice(0, at);
    this.hostname = host.toLowerCase();
    this.port = port === DEFAULT_PORTS[this.protocol] ? '' : port;
    this.pathname = normalizePath(path || '/');
    this.searchParams = new SearchParams(search ?? '');
    this.hash = fragment ?? '';
  }

  /** `input` resolved against the absolute URL `base`, as RFC 3986 section 5.2 does it. */
  static resolve(base: string, input: string): string {
    const root = new Url(base);
    if (input.startsWith('//')) return `${root.protocol}:${input}`;
    if (input.startsWith('?')) return `${root.origin}${root.pathname}${input}`;
    if (input.startsWith('#')) return `${root.origin}${root.pathname}${root.search}${input}`;
    const directory = input.startsWith('/') ? '/' : root.pathname.slice(0, root.pathname.lastIndexOf('/') + 1);
    return `${root.origin}${joinPaths(directory, input)}`;
  }

  get host(): string {
    return this.port ? `${this.hostname}:${this.port}` : this.hostname;
  }

  get origin(): string {
    return `${this.protocol}://${this.host}`;
  }

  get search(): string {
    const query = this.searchParams.toString();
    return query ? `?${query}` : '';
  }

  /** A copy with each parameter given set, or removed when it is undefined. */
  withQuery(params: Record<string, string | number | undefined>): Url {
    const copy = new Url(this.toString());
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) copy.searchParams.delete(key);
      else copy.searchParams.set(key, value);
    }
    return copy;
  }

  /** A copy with `segments` appended to the path. */
  withPath(...segments: string[]): Url {
    return new Url(`${this.origin}${joinPaths(this.pathname, ...segments)}${this.search}${this.hash}`);
  }

  equals(other: Url | string): boolean {
    return this.toString() === (typeof other === 'string' ? new Url(other) : other).toString();
  }

  toString(): string {
    const user = this.username ? `${this.username}@` : '';
    return `${this.protocol}://${user}${this.host}${this.pathname}${this.search}${this.hash}`;
  }

  toJSON(): string {
    return this.toString();
  }
}
