/** RFC 3986 section 5.2.4: `.` and `..` segments removed, so `/a/b/../c` is `/a/c`. */
export function removeDotSegments(path: string): string {
  const output: string[] = [];
  const segments = path.split('/');
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const last = index === segments.length - 1;
    if (segment === '.' || segment === '..') {
      if (segment === '..' && output.length > 1) output.pop();
      if (last) output.push('');
      continue;
    }
    output.push(segment);
  }
  return output.join('/');
}

/** A path with repeated slashes collapsed, dot segments removed and percent escapes upper-cased. */
export function normalizePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  const cleaned = removeDotSegments(collapsed.startsWith('/') ? collapsed : `/${collapsed}`);
  return cleaned.replace(/%[0-9a-f]{2}/gi, escape => escape.toUpperCase()) || '/';
}

/** Whether `child` is `parent` or a path under it. */
export function isSubpath(parent: string, child: string): boolean {
  const root = normalizePath(parent).replace(/\/$/, '');
  const path = normalizePath(child);
  return path === root || path.startsWith(`${root}/`);
}
