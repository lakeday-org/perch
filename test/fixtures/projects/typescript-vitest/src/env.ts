/** The page's origin in a browser, or null under Node, in a worker without a location, or on an opaque origin. */
export function currentOrigin(): string | null {
  const location = (globalThis as { location?: { origin?: string } }).location;
  if (!location?.origin || location.origin === 'null') return null;
  return location.origin;
}
