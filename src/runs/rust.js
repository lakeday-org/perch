/** libtest's and cargo-nextest's names for a test: its path inside the test binary, and which binary. */
import { projectRoots, under } from './paths.js';

export const family = 'rust';
export const languages = new Set(['rust']);
const ROOT_FILES = new Set(['Cargo.toml']);
export const roots = paths => projectRoots(paths, ROOT_FILES, false);

/**
 * A Rust file's place in its crate, the nearest directory above it with a Cargo.toml. Under the crate's `src/`, `lib.rs`,
 * `main.rs` and `bin/x.rs` are a crate root, `a/mod.rs` and `a.rs` are module `a`, and `a/b.rs` is `a::b`. A file under the
 * crate's `tests/` is a crate of its own, an integration test, whose target is named after `tests/x.rs` or `tests/x/main.rs`.
 * Null for a file in neither, or in no crate.
 */
function rustModule(path, crates) {
  const crate = crates.map(root => [root, under(root, path)]).filter(([, rel]) => rel !== null).sort(([a], [b]) => b.length - a.length)[0];
  if (!crate) return null;
  const parts = crate[1].split('/');
  if (parts[0] === 'tests' && parts.length > 1) {
    const target = parts.length === 2 ? parts[1].replace(/\.rs$/, '') : parts.length === 3 && parts[2] === 'main.rs' ? parts[1] : null;
    return { integration: true, target, modules: [] };
  }
  if (parts[0] !== 'src' || parts.length < 2) return null;
  const inside = parts.slice(1);
  if (inside[0] === 'bin') return { integration: false, modules: [] };
  const last = inside.at(-1).replace(/\.rs$/, '');
  return { integration: false, modules: [...inside.slice(0, -1), ...(['lib', 'main', 'mod'].includes(last) ? [] : [last])] };
}

/**
 * libtest's JUnit classname is the test's module path in its crate, `crate` at the root, and its name the function. A test
 * under tests/ is classname `integration`, named by its path in that crate. cargo-nextest names the same test by its path in the
 * binary, and an integration test also by its target, as `nextest\0<target>\0<path>`.
 */
export function testNames(node, { roots: found }) {
  const { case: test } = node, suite = test.suite ?? [];
  const module = rustModule(node.path, found.rust);
  if (module?.integration) {
    const path = [...suite, test.name].join('::');
    return { keys: [`rust\0integration\0${path}`, ...(module.target ? [`nextest\0${module.target}\0${path}`] : [])], full: [path] };
  }
  if (!module) return { keys: [], full: [] };
  const modules = [...module.modules, ...suite];
  return { keys: [`rust\0${modules.join('::') || 'crate'}\0${test.name}`], full: [[...modules, test.name].join('::')] };
}

/**
 * cargo-nextest's binary id: `<package>` for a library's unit tests, `<package>::bin/<name>` (or `example/`, `bench/`) for another
 * target's, and `<package>::<name>` for the integration test tests/<name>.rs. Cargo allows letters, digits, `-` and `_` in both.
 */
const BINARY_ID = /^[A-Za-z0-9_-]+(?:::(?:(?:bin|example|bench)\/([A-Za-z0-9_-]+)|([A-Za-z0-9_-]+)))?$/;

/**
 * A libtest testcase is classname and name as above, in a testsuite libtest always calls `test`, which Cargo does not allow as a
 * package name. A cargo-nextest testcase's classname is its binary id, and so is its testsuite's name; its name is the test's
 * path inside that binary, `tests::takes_ten_percent_off`. A unit test's path is its module path and function, which is what
 * libtest's classname and name hold, so it is matched the same way. The package in the binary id is the crate's name in its
 * Cargo.toml, which perch does not read: as with libtest, whose report names no crate, two crates with a test at the same path
 * make that run ambiguous, and it is listed as unmatched.
 */
export function runNames(run) {
  const binary = run.suite !== 'test' && run.suite === run.classname ? BINARY_ID.exec(run.classname ?? '') : null;
  if (!binary) return [`rust\0${run.classname ?? ''}\0${run.name}`];
  const integration = binary[2];
  if (integration) return [`nextest\0${integration}\0${run.name}`];
  const at = run.name.lastIndexOf('::');
  return [`rust\0${at === -1 ? 'crate' : run.name.slice(0, at)}\0${at === -1 ? run.name : run.name.slice(at + 2)}`];
}
