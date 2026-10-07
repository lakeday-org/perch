import { decodeComponent } from './encode';
import { QueryError } from './errors';
import { assignPath, splitKey } from './format/nested';
import { parseOptions } from './options';
import type { ParseOptions, QueryObject, QueryValue } from './types';

/** `key=value` split at its first `=`; a pair with none has a null value, as `flag` in `?flag&x=1`. */
export function splitPair(pair: string): [string, string | null] {
  const at = pair.indexOf('=');
  return at === -1 ? [pair, null] : [pair.slice(0, at), pair.slice(at + 1)];
}

function coerce(value: string, numbers: boolean): QueryValue {
  if (numbers && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Reads a query string, with or without its leading `?`, into an object. */
export default function parse(input: string, options?: ParseOptions): QueryObject {
  const settings = parseOptions(options);
  const query = input.startsWith('?') ? input.slice(1) : input;
  const result: QueryObject = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [rawKey, rawValue] = splitPair(pair);
    const key = settings.decode ? decodeComponent(rawKey) : rawKey;
    if (!key) throw new QueryError('empty key in query', input);
    if (rawValue === null) {
      result[key] = null;
      continue;
    }
    const text = settings.decode ? decodeComponent(rawValue) : rawValue;
    if (settings.arrayFormat === 'comma' && text.includes(',')) {
      result[key] = text.split(',').map(part => coerce(part, settings.parseNumbers));
      continue;
    }
    const value = coerce(text, settings.parseNumbers);
    const path = splitKey(key, settings.depth);
    if (path.length > 1) {
      assignPath(result, path, value);
      continue;
    }
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[key] = [existing, value];
  }
  return result;
}
