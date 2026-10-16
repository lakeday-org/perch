/** What each type a schema may name accepts. */
export const types = {
  string(value) {
    return typeof value === 'string';
  },
  number(value) {
    return typeof value === 'number' && Number.isFinite(value);
  },
  integer(value) {
    return Number.isInteger(value);
  },
  boolean(value) {
    return typeof value === 'boolean';
  },
  port(value) {
    return Number.isInteger(value) && value > 0 && value < 65536;
  },
  url(value) {
    return typeof value === 'string' && URL.canParse(value);
  },
  duration(value) {
    return (Number.isInteger(value) && value >= 0) || /^\d+(ms|s|m|h)$/.test(value);
  },
};

export function checkType(type, value) {
  const check = types[type];
  if (!check) throw new TypeError(`unknown type "${type}"; a schema names one of ${Object.keys(types).join(', ')}`);
  return check(value);
}

/** A string from the environment or a flag, read as the type the schema declares; anything else as it is. */
export function coerceType(type, value) {
  if (typeof value !== 'string') return value;

  switch (type) {
    case 'number':
    case 'integer':
    case 'port': {
      const number = Number(value);
      return value.trim() !== '' && !Number.isNaN(number) ? number : value;
    }
    case 'boolean':
      return value === 'true' ? true : value === 'false' ? false : value;
    default:
      return value;
  }
}

/** A duration in milliseconds: a number already is one, and "30s", "5m" or "2h" say their unit. */
export function parseDuration(value) {
  if (typeof value === 'number') return value;
  const [, amount, unit] = /^(\d+)(ms|s|m|h)$/.exec(value);
  return Number(amount) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
}
