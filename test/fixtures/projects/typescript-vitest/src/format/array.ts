import type { ArrayFormat } from '../types';

/** The `key=value` pairs one array is written as. Key and values arrive already encoded. */
export function formatArray(key: string, values: string[], format: ArrayFormat): string[] {
  switch (format) {
    case 'brackets':
      return values.map(value => `${key}[]=${value}`);
    case 'indices':
      return values.map((value, index) => `${key}[${index}]=${value}`);
    case 'comma':
      return values.length ? [`${key}=${values.join(',')}`] : [];
    case 'repeat':
      return values.map(value => `${key}=${value}`);
  }
}
