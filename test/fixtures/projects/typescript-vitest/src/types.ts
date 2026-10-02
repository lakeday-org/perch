/** How an array is written in a query string. */
export type ArrayFormat = 'brackets' | 'indices' | 'comma' | 'repeat';

export type QueryScalar = string | number | boolean | null | undefined;
export type QueryValue = QueryScalar | QueryValue[] | { [key: string]: QueryValue };
export type QueryObject = { [key: string]: QueryValue };

export interface ParseOptions {
  /** How arrays are written. Defaults to `brackets`. */
  arrayFormat?: ArrayFormat;
  /** How many levels of `a[b][c]` are nested before the rest of the key is kept as written. Defaults to 5. */
  depth?: number;
  /** Whether keys and values are percent-decoded. Defaults to true. */
  decode?: boolean;
  /** Whether a value that is a decimal number is returned as one. Defaults to false. */
  parseNumbers?: boolean;
}

export interface StringifyOptions {
  arrayFormat?: ArrayFormat;
  encode?: boolean;
  /** Leave out keys whose value is null, rather than writing them bare. */
  skipNull?: boolean;
  /** Sort keys, alphabetically when true or with the comparator given. */
  sort?: boolean | ((a: string, b: string) => number);
}
