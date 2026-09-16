#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const bundle = new URL('../dist/cli.mjs', import.meta.url);
if (!existsSync(fileURLToPath(bundle))) {
  console.error('perch is not built; run `npm run build` in the perch checkout');
  process.exit(2);
}
const { main } = await import(bundle.href);
process.exitCode = await main(process.argv.slice(2));
