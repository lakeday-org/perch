/** What every fixture report generator shares: running a command, copying an application, and making its reports portable. */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspace = fileURLToPath(new URL('../../', import.meta.url));
export const fixtures = join(workspace, 'test/fixtures');
export const python = process.env.PERCH_FIXTURE_PYTHON || 'python3';
export const toolchain = `+${process.env.PERCH_FIXTURE_RUST_TOOLCHAIN || 'nightly'}`;
const fixtureVariables = ['ORDERS_TOKEN', 'ORDERS_DB', 'ORDERS_DB_PASSWORD', 'ORDERS_API_TOKEN', 'ORDERS_API_URL', 'PRICE_SERVICE_TOKEN'];
export const testEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !fixtureVariables.includes(name)));
const copied = new Set(['node_modules', 'target', 'dist', 'out', 'build', '.perch', 'reports']);

/** Runs a command and prints it. `tests` marks a test run, whose nonzero exit is the fixture's failing tests. */
export function run(command, args, { cwd, env = testEnv, tests = false } = {}) {
  console.log(`  $ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0 && !tests) throw new Error(`${command} exited ${result.status}:\n${(result.stderr || result.stdout).slice(-3000)}`);
  if (result.status !== 0) console.log(`    exited ${result.status}; the fixture's failing tests are expected to fail`);
  return result;
}

/** True when `command args` runs and exits 0. Used only to decide whether a toolchain is present. */
export function works(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return !result.error && result.status === 0;
}

export async function copyApp(scratch, app) {
  const root = join(scratch, app), out = join(scratch, `${app}-out`);
  await cp(join(fixtures, app), root, { recursive: true, filter: source => !copied.has(source.split('/').pop()) });
  await mkdir(out);
  return { root, real: await realpath(root), out };
}

/** The one post-processing step: the temporary copy's absolute path becomes relative to the application root. */
export function relative(text, copy) {
  for (const root of [...new Set([copy.real, copy.root])].sort((a, b) => b.length - a.length)) text = text.split(`${root}/`).join('').split(root).join('.');
  return text;
}

export async function report(copy, from) {
  if (!existsSync(from)) throw new Error(`the run did not write ${from}`);
  return relative(await readFile(from, 'utf8'), copy);
}
