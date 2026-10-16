import { checkType, coerceType } from './types.js';
import { setPath } from '../env.js';
import { ValidationError } from '../errors.js';

/**
 * What a configuration must look like. A definition nests like the configuration, and each leaf says its `type`, and may say
 * `required`, a `default`, an `enum` of allowed values and a `doc` line.
 */
export class Schema {
  constructor(definition) {
    if (!definition || typeof definition !== 'object') throw new TypeError('a schema is an object of keys');
    this.keys = flatten(definition);
  }

  /** A copy of `config` with defaults filled in and strings coerced, or a ValidationError listing every problem. */
  validate(config) {
    const out = structuredClone(config);
    const problems = [];

    for (const [key, rule] of Object.entries(this.keys)) {
      let value = getPath(out, key);
      if (value === undefined && 'default' in rule) value = rule.default;
      if (value === undefined) {
        if (rule.required) problems.push({ key, message: 'is required' });
        continue;
      }

      value = coerceType(rule.type, value);
      if (!checkType(rule.type, value)) {
        problems.push({ key, message: `must be ${article(rule.type)}, got ${JSON.stringify(value)}` });
      } else if (rule.enum && !rule.enum.includes(value)) {
        problems.push({ key, message: `must be one of ${rule.enum.join(', ')}, got ${JSON.stringify(value)}` });
      }
      setPath(out, key.split('.'), value);
    }

    if (problems.length) throw new ValidationError(problems);
    return out;
  }

  /** The configuration the defaults alone make. */
  defaults() {
    const out = {};
    for (const [key, rule] of Object.entries(this.keys)) {
      if ('default' in rule) setPath(out, key.split('.'), rule.default);
    }
    return out;
  }

  /** One row per key, for documentation. */
  describe() {
    return Object.entries(this.keys).map(([key, rule]) => ({
      key,
      type: rule.type,
      required: Boolean(rule.required),
      default: rule.default,
      doc: rule.doc ?? '',
    }));
  }
}

function flatten(definition, prefix = '') {
  const keys = {};
  for (const [name, rule] of Object.entries(definition)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (rule && typeof rule.type === 'string') keys[key] = rule;
    else Object.assign(keys, flatten(rule, key));
  }
  return keys;
}

function getPath(obj, key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), obj);
}

function article(type) {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}
