/**
 * Rust, run by perch with mutant schemata: every mutant written into the crate once behind a switch, the crate's tests built once,
 * and each mutant run by starting the built test binaries with PERCH_MUTANT set. A mutant the compiler rejects, a value a constant
 * needs at compile time, is taken out and the crate built again; it is invalid, as Stryker.NET counts a compile error.
 *
 * Which test reaches which mutant is recorded by the switches: libtest runs each test on a thread named after it, so a switch
 * reached during the suite run is put down to the test whose thread reached it.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { mutantId } from '../mutants.js';
import { startDriver } from './driver.js';
import { instrument } from './schemata.js';

const run = promisify(execFile);

export const name = 'cargo';
export const languages = new Set(['rust']);
/** One copy: mutants are switched on at run time and never written again. */
export const copiesFor = () => 1;

/** The switch each crate gets as a module of its root, called as `crate::__perch::on(17)`. */
const SWITCH = `
#[doc(hidden)]
#[allow(dead_code, unused, clippy::all)]
pub mod __perch {
    use std::collections::HashSet;
    use std::io::Write;
    use std::sync::{Mutex, OnceLock};
    static ACTIVE: OnceLock<i64> = OnceLock::new();
    static HITS: OnceLock<Option<Mutex<(HashSet<(String, u32)>, std::fs::File)>>> = OnceLock::new();
    pub fn on(id: u32) -> bool {
        let active = *ACTIVE.get_or_init(|| std::env::var("PERCH_MUTANT").ok().and_then(|value| value.parse().ok()).unwrap_or(-1));
        let hits = HITS.get_or_init(|| {
            std::env::var("PERCH_HITS").ok()
                .and_then(|path| std::fs::OpenOptions::new().append(true).create(true).open(path).ok())
                .map(|file| Mutex::new((HashSet::new(), file)))
        });
        if let Some(hits) = hits {
            let test = std::thread::current().name().unwrap_or("").to_string();
            if let Ok(mut guard) = hits.lock() {
                if guard.0.insert((test.clone(), id)) {
                    let _ = writeln!(guard.1, "{}\\t{}", id, test);
                }
            }
        }
        active == id as i64
    }
}
`;

/** `test NAME ... ok` lines, as libtest prints them: each test's name and whether it passed. */
function readResults(output) {
  const results = new Map();
  for (const match of output.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)/gm)) if (match[2] !== 'ignored') results.set(match[1], match[2] === 'ok' ? 'passed' : 'failed');
  return results;
}

/** The module path a file is at under its crate's root directory: `src/tests.rs` is `tests`, `src/a/mod.rs` is `a`. */
const modulePath = (file, rootFile) => {
  if (file === rootFile) return [];
  const parts = relative(dirname(rootFile), file).replace(/\.rs$/, '').split('/');
  if (parts.at(-1) === 'mod') parts.pop();
  return parts;
};

let ids = new Map(), keys = new Map(), unplaced = new Map(), binaries = [], names = new Map(), testOfNode = new Map();

export async function available({ root }) {
  if (!existsSync(join(root, 'Cargo.toml'))) return { reason: 'there is no Cargo.toml at the repository\'s root' };
  try { await run('cargo', ['--version']); } catch { return { reason: 'cargo is not on PATH' }; }
  return { root };
}

/**
 * The copy made ready: each crate root given the switch, every mutant written into its file, and the tests built, again without
 * whatever the compiler rejects, until they build.
 */
export async function prepare({ copies: [copy], generated, graph }) {
  ids = new Map(); keys = new Map(); unplaced = new Map(); binaries = []; names = new Map(); testOfNode = new Map();
  const target = join(copy.scratch, 'target');
  const { stdout } = await run('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: copy.dir, maxBuffer: 1 << 26 });
  const metadata = JSON.parse(stdout);
  const roots = metadata.packages.flatMap(item => item.targets.filter(entry => entry.kind.some(kind => ['lib', 'bin', 'proc-macro'].includes(kind)))
    .map(entry => ({ file: relative(copy.dir, entry.src_path), dir: relative(copy.dir, dirname(item.manifest_path)) })));
  for (const { file } of roots) {
    const path = join(copy.dir, file);
    await writeFile(path, `${await readFile(path, 'utf8')}\n${SWITCH}`);
  }
  // Each test by its function's name, with its file's module path under its crate root: libtest names it by that path, any
  // modules inside the file, and the function.
  for (const node of graph.nodes.values()) {
    if (!node.case || graph.files.get(node.path)?.file.language !== 'rust') continue;
    const root = roots.filter(item => node.path === item.file || node.path.startsWith(`${dirname(item.file)}/`)).sort((a, b) => b.file.length - a.file.length)[0];
    const fn = node.qualified_name.split(/::|\./).at(-1);
    if (!names.has(fn)) names.set(fn, []);
    names.get(fn).push({ id: node.id, module: modulePath(node.path, root?.file ?? node.path) });
  }
  const byFile = new Map();
  let next = 0;
  for (const [methodId, mutants] of generated) {
    const node = graph.nodes.get(methodId);
    if (!byFile.has(node.path)) byFile.set(node.path, []);
    for (const mutant of mutants) {
      const key = `${methodId}#${mutantId(mutant)}`, id = next++;
      ids.set(key, id);
      keys.set(id, { key, mutant, path: node.path });
      byFile.get(node.path).push({ id, mutant });
    }
  }
  const sources = new Map();
  for (const path of byFile.keys()) sources.set(path, await readFile(join(copy.dir, path), 'utf8'));
  for (let round = 0; ; round++) {
    const placed = new Map();
    for (const [path, mutants] of byFile) {
      const result = instrument({ source: sources.get(path), language: 'rust', mutants: mutants.filter(item => !unplaced.has(item.id)) });
      for (const { id, reason } of result.unplaced) unplaced.set(id, reason);
      placed.set(path, result);
      await writeFile(join(copy.dir, path), result.text);
    }
    let output;
    try {
      ({ stdout: output } = await run('cargo', ['test', '--no-run', '--message-format=json', '--quiet'], { cwd: copy.dir, env: { ...process.env, CARGO_TARGET_DIR: target }, maxBuffer: 1 << 28 }));
    } catch (error) { output = error.stdout ?? ''; }
    const messages = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const errors = messages.filter(item => item.reason === 'compiler-message' && item.message.level === 'error');
    if (!errors.length) {
      binaries = messages.filter(item => item.reason === 'compiler-artifact' && item.profile?.test && item.executable)
        .map(item => ({ path: item.executable, cwd: dirname(metadata.packages.find(entry => entry.id === item.package_id)?.manifest_path ?? join(copy.dir, 'Cargo.toml')) }));
      if (!binaries.length) throw new Error('cargo built no test binaries');
      return;
    }
    const rejected = new Map();
    for (const error of errors) {
      for (const span of error.message.spans.filter(item => item.is_primary)) {
        const result = placed.get(relative(copy.dir, join(copy.dir, span.file_name)));
        for (const id of result?.locate(span.line_start, span.column_start) ?? []) if (!rejected.has(id)) rejected.set(id, error.message.message);
      }
    }
    if (!rejected.size || round > 20) throw new Error(`the crate does not build: ${errors[0].message.rendered?.trim().split('\n').slice(0, 6).join(' | ')}`);
    for (const [id, message] of rejected) unplaced.set(id, `the compiler rejects it: ${message}`);
  }
}

/** Each built test binary once, every switch recording which test's thread reached it. */
export async function coverageRun({ copy, scratch }) {
  const hits = join(scratch, 'hits.tsv');
  await writeFile(hits, '');
  const started = Date.now();
  const driver = await startDriver({ scratch, writable: [copy, scratch] });
  const results = new Map();
  // The test whose file's module path the name starts with, and the longest such: `tests::deeper::nested` is `nested` in a
  // file whose module is `tests` or the crate root.
  const idOf = name => {
    const parts = name.split('::');
    const fits = (names.get(parts.at(-1)) ?? []).filter(item => item.module.every((part, at) => parts[at] === part) && item.module.length < parts.length);
    const longest = Math.max(...fits.map(item => item.module.length));
    const best = fits.filter(item => item.module.length === longest);
    return best.length === 1 ? best[0].id : `rust::${name}`;
  };
  try {
    for (const [at, binary] of binaries.entries()) {
      const began = Date.now();
      const ran = await driver.exec(binary.path, [], { cwd: binary.cwd, env: { PERCH_COVERAGE: '1', PERCH_HITS: hits } });
      const found = readResults(ran.output);
      const each = (Date.now() - began) / 1000 / Math.max(1, found.size);
      for (const [test, status] of found) { results.set(`${at}\0${test}`, { test: idOf(test), status, time: each }); testOfNode.set(`${at}\0${test}`, idOf(test)); }
    }
  } finally { await driver.close(); }
  const reached = new Map(), executed = new Map();
  for (const line of (await readFile(hits, 'utf8')).split('\n').filter(Boolean)) {
    const [id, thread] = line.split('\t');
    const test = idOf(thread);
    if (!reached.has(test)) { reached.set(test, new Set()); executed.set(test, new Map()); }
    const { key, mutant, path } = keys.get(Number(id));
    reached.get(test).add(key);
    const lines = executed.get(test);
    if (!lines.has(path)) lines.set(path, new Set());
    for (const item of mutant.statements.length ? mutant.statements : [mutant.line]) lines.get(path).add(item);
  }
  const hitMethods = new Set([...keys.values()].map(({ key }) => key.slice(0, key.lastIndexOf('#'))));
  return { executed, hits: reached, hitMethods, unplaced: new Set([...unplaced.keys()].map(id => keys.get(id).key)), results, seconds: (Date.now() - started) / 1000 };
}

/** Each mutant run by starting the test binaries that hold its tests, with its number set and only those tests named. */
export async function session({ copies: [copy] }) {
  const driver = await startDriver({ scratch: copy.scratch, writable: [copy.dir, copy.scratch] });
  return {
    async run({ mutant, method, nodes, timeout }) {
      const id = ids.get(`${method.id}#${mutantId(mutant)}`);
      if (unplaced.has(id)) return { status: 'invalid', error: unplaced.get(id) };
      const byBinary = Map.groupBy(nodes, node => node.split('\0')[0]);
      const results = new Map();
      for (const [at, group] of byBinary) {
        const binary = binaries[Number(at)];
        const ran = await driver.exec(binary.path, ['--exact', ...group.map(node => node.split('\0')[1])], { cwd: binary.cwd, env: { PERCH_MUTANT: String(id) }, timeout });
        if (ran.timedOut) return { status: 'timeout' };
        const found = readResults(ran.output);
        // A panic outside any test, or a crash, ends the binary before it says how its tests did: every test it was running failed.
        for (const node of group) {
          const name = node.split('\0')[1];
          results.set(node, { test: testOfNode.get(node), status: found.get(name) ?? (ran.code === 0 ? 'passed' : 'failed') });
        }
      }
      return { status: 'ran', results };
    },
    close: () => driver.close(),
  };
}
