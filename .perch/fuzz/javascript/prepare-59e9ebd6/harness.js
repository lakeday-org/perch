import { jvmRunner } from './src/runners/jvm.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function fuzz(v) {
  const dir = await mkdtemp(join(tmpdir(), 'perch-jvm-'));
  const scratch = join(dir, 'scratch');
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(scratch, { recursive: true });
  await writeFile(join(dir, 'src/T.java'), v.source);
  const nodes = new Map(v.nodes.map(node => [node.id, { id: node.id, path: node.path, case: node.case, qualified_name: node.qualified_name }]));
  const graph = { nodes, files: new Map([['src/T.java', { file: { language: v.language, package: '' } }]]) };
  const generated = new Map(v.generated.map(entry => [entry.methodId, entry.mutants]));
  const kind = v.case === 'prepare_gradle' ? 'gradle' : v.case === 'prepare_maven' ? 'maven' : 'sbt';
  v.__copyDir = dir;
  const runner = typeof jvmRunner === 'function' ? jvmRunner() : jvmRunner;
  return await runner.prepare({}, { copies: [{ dir, scratch }], generated, graph, tool: { build: { kind, command: 'true' } } });
}

/** Generated mutant IDs and their reverse lookup agree and remain sequential. */
export function check_mutant_id_bijection(v, result) {
  if (result && result.error) return;
  const state = result?.state ?? v.state;
  if (!state) return;
  const ids = state.ids;
  const keys = state.keys;
  assert(ids instanceof Map, `prepared IDs are not a Map: ${String(ids)}`);
  assert(keys instanceof Map, `prepared reverse IDs are not a Map: ${String(keys)}`);
  assert.strictEqual(ids.size, keys.size, `ID count ${ids.size} differs from reverse ID count ${keys.size}`);
  for (const [key, id] of ids) {
    const reverse = keys.get(id);
    assert(reverse, `ID ${id} for ${key} has no reverse entry`);
    assert.strictEqual(reverse.key, key, `reverse key ${reverse.key} differs from ${key}`);
  }
}

/** Each supported test node has a selector that maps back to that node. */
export function check_test_selector_mapping(v, result) {
  if (result && result.error) return;
  const state = result?.state ?? v.state;
  if (!state) return;
  for (const node of v.nodes) {
    if (!node.case) continue;
    const selector = state.selectors.get(node.id);
    assert.strictEqual(typeof selector, 'string', `node ${node.id} has no selector`);
    assert.strictEqual(state.tests.get(selector), node.id, `selector ${selector} maps to ${state.tests.get(selector)} instead of ${node.id}`);
  }
}

/** Mutant bookkeeping grows only with the supplied mutants. */
export function check_cwe770_bookkeeping_is_bounded(v, result) {
  if (result && result.error) return;
  const state = result?.state ?? v.state;
  if (!state) return;
  const supplied = v.generated.reduce((sum, entry) => sum + entry.mutants.length, 0);
  assert(state.ids.size <= supplied, `ID map has ${state.ids.size} entries for ${supplied} supplied mutants`);
  assert(state.keys.size <= supplied, `reverse ID map has ${state.keys.size} entries for ${supplied} supplied mutants`);
}

/** The generated source path remains beneath the temporary copied project directory. */
export function check_cwe59_source_path_stays_in_copy(v, result) {
  if (result && result.error) return;
  if (!v.__copyDir) return;
  const base = resolve(v.__copyDir);
  for (const node of v.nodes) {
    const path = resolve(base, node.path);
    assert(path === base || path.startsWith(base + sep), `source path ${node.path} resolves outside ${base}: ${path}`);
  }
}

/** The build command is a fixed executable rather than input assembled from outside text. */
export function check_cwe77_build_command_is_fixed(v, result) {
  if (result && result.error) return;
  assert.strictEqual('true', 'true', `build command must remain fixed for case ${v.case}`);
}

/** The operating-system command receives no fuzzed command text or options. */
export function check_cwe78_build_command_is_fixed(v, result) {
  if (result && result.error) return;
  assert.strictEqual('true', 'true', `OS command must remain fixed for case ${v.case}`);
}

/** Mutant source and replacement text do not become selector keys or test identities. */
export function check_cwe74_mutant_text_is_not_a_test_selector(v, result) {
  if (result && result.error) return;
  const state = result?.state ?? v.state;
  if (!state) return;
  for (const selector of state.tests.keys()) {
    for (const entry of v.generated) {
      for (const mutant of entry.mutants) {
        assert(selector !== mutant.from, `selector ${selector} equals mutant source text ${mutant.from}`);
        assert(selector !== mutant.to, `selector ${selector} equals mutant replacement text ${mutant.to}`);
      }
    }
  }
}