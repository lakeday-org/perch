import type { QueryObject, QueryValue } from '../types';

/**
 * A bracketed key as its path: `a[b][0]` is `['a', 'b', '0']`. Past `depth` levels the rest of the key stays on the last
 * segment as written, so `a[b][c]` at depth 1 is `['a', 'b[c]']`.
 */
export function splitKey(key: string, depth: number): string[] {
  const open = key.indexOf('[');
  if (open <= 0 || depth === 0) return [key];
  const parts = [key.slice(0, open)];
  const segment = /\[([^[\]]*)\]/g;
  segment.lastIndex = open;
  let end = open;
  let match: RegExpExecArray | null;
  while ((match = segment.exec(key)) && parts.length <= depth) {
    if (match.index !== end) break;
    parts.push(match[1]);
    end = segment.lastIndex;
  }
  if (end < key.length) parts[parts.length - 1] += key.slice(end);
  return parts;
}

/** Sets `value` at `path` inside `target`, making an array where the next segment is empty or a number. */
export function assignPath(target: QueryObject, path: string[], value: QueryValue): void {
  let node = target as Record<string, unknown> | unknown[];
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index];
    const next = path[index + 1];
    const container = node as Record<string, unknown>;
    if (container[segment] === null || typeof container[segment] !== 'object') container[segment] = next === '' || /^\d+$/.test(next) ? [] : {};
    node = container[segment] as Record<string, unknown> | unknown[];
  }
  const last = path[path.length - 1];
  if (Array.isArray(node)) {
    if (last === '') node.push(value);
    else node[Number(last)] = value;
  } else {
    node[last] = value;
  }
}

/** Every leaf of a nested object with its bracketed key: `{ a: { b: 1 } }` is `[['a[b]', 1]]`. Arrays are leaves. */
export function flatten(object: QueryObject, prefix = ''): Array<[string, QueryValue]> {
  const out: Array<[string, QueryValue]> = [];
  for (const [key, value] of Object.entries(object)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push(...flatten(value, name));
    else out.push([name, value]);
  }
  return out;
}
