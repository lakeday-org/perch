import { isPlainObject } from './merge.js';

/** A string from the environment as the value it spells: true, false, null, a number, or itself. */
export function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(value) && Number.isSafeInteger(Math.trunc(Number(value)))) return Number(value);
  return value;
}

/** Sets `value` at the path `keys` in `target`, making the objects on the way. */
export function setPath(target, keys, value) {
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys.at(-1)] = value;
  return target;
}

/**
 * The variables named with `prefix` as a nested object: with prefix APP, `APP__DB__POOL_SIZE=5` is `{ db: { poolSize: 5 } }`.
 */
export function fromEnv(env, { prefix, separator = '__', camelCase = true } = {}) {
  const out = {};
  const head = prefix ? prefix + separator : '';

  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith(head) || name === head || raw === undefined) continue;
    const keys = name.slice(head.length).split(separator).map(key => (camelCase ? toCamel(key) : key));
    setPath(out, keys, coerce(raw));
  }
  return out;
}

function toCamel(key) {
  return key.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}
