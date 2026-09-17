import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const { version } = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));
await build({
  define: { PERCH_VERSION: JSON.stringify(version) },
  entryPoints: ['src/cli.js'],
  outfile: 'dist/cli.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Grammar and parser wasm files are read from node_modules at run time.
  external: ['web-tree-sitter', 'tree-sitter-wasm'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
