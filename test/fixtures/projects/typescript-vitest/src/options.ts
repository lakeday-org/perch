import type { ArrayFormat, ParseOptions, StringifyOptions } from './types';

const FORMATS: readonly string[] = ['brackets', 'indices', 'comma', 'repeat'];
/** The names 1.x took, kept working with a warning until 3.0. */
const LEGACY: Record<string, ArrayFormat> = { bracket: 'brackets', index: 'indices', none: 'repeat' };

export const PARSE_DEFAULTS: Required<ParseOptions> = { arrayFormat: 'brackets', depth: 5, decode: true, parseNumbers: false };

export interface ResolvedStringifyOptions {
  arrayFormat: ArrayFormat;
  encode: boolean;
  skipNull: boolean;
  sort: StringifyOptions['sort'];
}

export function resolveArrayFormat(format: string | undefined): ArrayFormat {
  if (format === undefined) return 'brackets';
  if (FORMATS.includes(format)) return format as ArrayFormat;
  if (format in LEGACY) {
    console.warn(`urlkit: arrayFormat "${format}" is deprecated; use "${LEGACY[format]}"`);
    return LEGACY[format];
  }
  throw new TypeError(`urlkit: unknown arrayFormat "${format}"`);
}

export function parseOptions(options: ParseOptions = {}): Required<ParseOptions> {
  const depth = options.depth ?? PARSE_DEFAULTS.depth;
  if (!Number.isInteger(depth) || depth < 0) throw new RangeError(`urlkit: depth must be a non-negative integer, got ${depth}`);
  return {
    arrayFormat: resolveArrayFormat(options.arrayFormat),
    depth,
    decode: options.decode ?? PARSE_DEFAULTS.decode,
    parseNumbers: options.parseNumbers ?? PARSE_DEFAULTS.parseNumbers,
  };
}

export function stringifyOptions(options: StringifyOptions = {}): ResolvedStringifyOptions {
  return {
    arrayFormat: resolveArrayFormat(options.arrayFormat),
    encode: options.encode ?? true,
    skipNull: options.skipNull ?? false,
    sort: options.sort ?? false,
  };
}
