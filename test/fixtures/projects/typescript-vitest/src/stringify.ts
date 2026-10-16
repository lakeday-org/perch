import { encodeComponent } from './encode';
import { formatArray } from './format/array';
import { flatten } from './format/nested';
import { stringifyOptions } from './options';
import type { QueryObject, QueryValue, StringifyOptions } from './types';

/** A bracketed key with each name encoded and the brackets kept: `a b[c]` is `a%20b[c]`. */
export function encodeKey(key: string): string {
  return key.replace(/[^[\]]+/g, name => encodeComponent(name));
}

function scalar(value: QueryValue, encode: boolean): string {
  const text = value === null || value === undefined ? '' : String(value);
  return encode ? encodeComponent(text) : text;
}

/** Writes an object as a query string, without a leading `?`. */
export function stringify(object: QueryObject, options?: StringifyOptions): string {
  const settings = stringifyOptions(options);
  let entries = flatten(object);
  if (settings.sort) {
    const compare = typeof settings.sort === 'function' ? settings.sort : (a: string, b: string) => a.localeCompare(b);
    entries = [...entries].sort(([a], [b]) => compare(a, b));
  }
  const parts: string[] = [];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if (value === null && settings.skipNull) continue;
    const name = settings.encode ? encodeKey(key) : key;
    if (Array.isArray(value)) {
      const values = value.filter(item => item !== undefined).map(item => scalar(item, settings.encode));
      parts.push(...formatArray(name, values, settings.arrayFormat));
    } else if (value === null) {
      parts.push(name);
    } else {
      parts.push(`${name}=${scalar(value, settings.encode)}`);
    }
  }
  return parts.join('&');
}
