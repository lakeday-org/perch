import { ConfigError } from './errors.js';
import { isPlainObject } from './merge.js';

/** `${NAME}`, `${NAME:-fallback}`, or `$$` for a literal dollar sign. */
const PATTERN = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * `text` with each variable replaced from `env`. A variable that is unset or empty takes its fallback; with none, it is an error
 * naming the key it was found in.
 */
export function interpolate(text, env, where = 'value') {
  return text.replace(PATTERN, (match, name, fallback) => {
    if (match === '$$') return '$';
    const value = env[name];
    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${where} refers to \${${name}}, which is not set`, { key: where });
  });
}

/** Every string in a configuration tree, interpolated, as a new tree. */
export function interpolateAll(value, env, path = []) {
  if (typeof value === 'string') return interpolate(value, env, path.join('.') || 'value');
  if (Array.isArray(value)) return value.map((item, i) => interpolateAll(item, env, [...path, String(i)]));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = interpolateAll(item, env, [...path, key]);
    return out;
  }
  return value;
}
