/** Keys that would reach Object.prototype through a merge. */
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/** An object literal or Object.create(null): something a config layer is made of, not an instance of a class. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Merges each source into `target`, deeply, and returns `target`. A later source wins; `undefined` never overwrites. Arrays are
 * replaced, or concatenated when `arrays` is "concat".
 */
export function mergeWith({ arrays = 'replace' } = {}, target, ...sources) {
  for (const source of sources) {
    if (source == null) continue;
    if (!isPlainObject(source)) throw new TypeError(`cannot merge ${kindOf(source)} into a configuration object`);

    for (const key of Object.keys(source)) {
      if (UNSAFE.has(key)) continue;
      const incoming = source[key];
      const current = target[key];

      if (isPlainObject(incoming)) {
        target[key] = mergeWith({ arrays }, isPlainObject(current) ? current : {}, incoming);
      } else if (arrays === 'concat' && Array.isArray(incoming) && Array.isArray(current)) {
        target[key] = [...current, ...incoming];
      } else if (incoming !== undefined) {
        target[key] = Array.isArray(incoming) ? [...incoming] : incoming;
      }
    }
  }
  return target;
}

export default function merge(target, ...sources) {
  return mergeWith({}, target, ...sources);
}

function kindOf(value) {
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? `a ${value.constructor?.name ?? 'object'}` : `a ${typeof value}`;
}
