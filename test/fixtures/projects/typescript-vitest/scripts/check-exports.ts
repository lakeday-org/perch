/** Fails the release when the built package stops exporting a name the docs promise. */
import { readFileSync } from 'node:fs';

const PROMISED = ['parse', 'stringify', 'encode', 'decode', 'SearchParams', 'Url', 'PathTemplate', 'joinPaths', 'normalizePath', 'QueryError'];

export function missingExports(source: string): string[] {
  return PROMISED.filter(name => !new RegExp(`\\b${name}\\b`).test(source));
}

const built = readFileSync(new URL('../dist/index.d.ts', import.meta.url), 'utf8');
const missing = missingExports(built);
if (missing.length) {
  console.error(`dist/index.d.ts does not export: ${missing.join(', ')}`);
  process.exit(1);
}
