import { Url } from './url';

/** The shape Node's legacy `url.parse()` returns. */
export interface LegacyUrl {
  protocol?: string | null;
  auth?: string | null;
  hostname?: string | null;
  port?: string | null;
  pathname?: string | null;
  search?: string | null;
  hash?: string | null;
}

/** @deprecated Build a `Url` from its string instead. Kept for code written against urlkit 1.x. */
export function fromLegacy(legacy: LegacyUrl): Url {
  const protocol = (legacy.protocol ?? 'http:').replace(/:$/, '');
  const auth = legacy.auth ? `${legacy.auth}@` : '';
  const port = legacy.port ? `:${legacy.port}` : '';
  return new Url(`${protocol}://${auth}${legacy.hostname ?? ''}${port}${legacy.pathname ?? '/'}${legacy.search ?? ''}${legacy.hash ?? ''}`);
}

/** @deprecated Read the `Url`'s own fields instead. */
export function toLegacy(url: Url): LegacyUrl {
  return {
    protocol: `${url.protocol}:`,
    auth: url.username || null,
    hostname: url.hostname,
    port: url.port || null,
    pathname: url.pathname,
    search: url.search || null,
    hash: url.hash || null,
  };
}
