import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));
const git = async args => (await promisify(execFile)('git', args, { cwd: root })).stdout.trim();

/**
 * The release this was built from, or DEVELOPMENT. A build sitting exactly on the v tag for the version in package.json, with
 * nothing uncommitted, is that release and says so. Anything else is somebody's working copy: it carries the same number in
 * package.json, and letting it answer `perch --version` with that number makes a bug report describe code that was never
 * published. The commit comes with it, since the whole point of asking is to know what is running.
 */
async function stamp() {
  try {
    const [tag, dirty, head] = await Promise.all([
      git(['describe', '--exact-match', '--tags', 'HEAD']).catch(() => ''),
      git(['status', '--porcelain']),
      git(['rev-parse', '--short', 'HEAD']),
    ]);
    return tag === `v${version}` && !dirty ? version : `DEVELOPMENT (${head})`;
  } catch {
    // No git at all: a tarball someone unpacked and built. Not a release, and nothing to say about which commit.
    return 'DEVELOPMENT';
  }
}

await build({
  define: { PERCH_VERSION: JSON.stringify(await stamp()) },
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
