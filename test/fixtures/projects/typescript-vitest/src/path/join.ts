/** Joins path segments with one slash between each, keeping a trailing slash on the last. Empty segments are skipped. */
export function joinPaths(...segments: string[]): string {
  const parts: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    let part = segments[index];
    if (!part) continue;
    if (index > 0) part = part.replace(/^\/+/, '');
    if (index < segments.length - 1) part = part.replace(/\/+$/, '');
    if (part) parts.push(part);
  }
  const joined = parts.join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}
