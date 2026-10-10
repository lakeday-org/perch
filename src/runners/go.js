/**
 * Go, run by perch: `go test` over a copy of the module per worker. Go has no expression that chooses between two values of any
 * type, so a mutant cannot sit behind a switch the way it does in JavaScript or Rust; instead each mutant is written into a
 * worker's copy and its package built again, which Go's build cache makes a matter of recompiling one package and linking.
 *
 * Which test runs which line comes from Go's own coverage: each package's tests are built once with coverage on, and each test
 * and subtest run alone with a profile of its own.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { startDriver } from './driver.js';

const run = promisify(execFile);

const name = 'go';
const languages = new Set(['go']);
/** A copy per worker: each mutant is written into the file. */
const copiesFor = parallel => parallel;

/** A subtest Go names twice gets `#01`, `#02` after the second and later; perch names it once. */
const plain = test => test.replace(/#\d+(?=\/|$)/g, '');

/** A go runner: what one run found is its own, so two runs in one process keep theirs apart. */
export function goRunner() {
  const state = { packages: [], testIds: new Map(), cacheDirs: [], modulePath: '' };
  return { name, languages, copiesFor, available: args => available(state, args), prepare: args => prepare(state, args), coverageRun: args => coverageRun(state, args), session: args => session(state, args) };
}

/** Each test event in `go test -json` output: the package, the test, and what happened. */
function events(output) {
  return output.split('\n').filter(line => line.startsWith('{')).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

async function available(state, { root }) {
  if (!existsSync(join(root, 'go.mod'))) return { reason: 'there is no go.mod at the repository\'s root' };
  try {
    const { stdout } = await run('go', ['env', 'GOCACHE', 'GOMODCACHE'], { cwd: root });
    // Go's caches are written as Go writes them: a test run under the sandbox may build into them, and nothing else.
    state.cacheDirs = stdout.split('\n').filter(Boolean);
  } catch { return { reason: 'go is not on PATH' }; }
  return { root };
}

/**
 * The JSON objects `go list -json` prints one after another: each ends where its braces close outside a string, so a `} {` in a
 * package's doc line does not split it.
 */
function jsonValues(text) {
  const values = [];
  let depth = 0, start = -1, quoted = false, escaped = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') { if (depth++ === 0) start = at; }
    else if (char === '}' && --depth === 0) values.push(JSON.parse(text.slice(start, at + 1)));
  }
  return values;
}

/** The packages with tests, and each perch test by the name `go test` gives it in its package. */
async function prepare(state, { copies: [copy], graph }) {
  const { stdout } = await run('go', ['list', '-json', './...'], { cwd: copy.dir, maxBuffer: 1 << 26 });
  const listed = jsonValues(stdout);
  state.modulePath = (await readFile(join(copy.dir, 'go.mod'), 'utf8')).match(/^module\s+(\S+)/m)?.[1] ?? '';
  const packages = state.packages = listed.filter(item => (item.TestGoFiles?.length || item.XTestGoFiles?.length)).map(item => ({ importPath: item.ImportPath, dir: relative(copy.dir, item.Dir) }));
  const testIds = state.testIds = new Map();
  for (const node of graph.nodes.values()) {
    if (!node.case || graph.files.get(node.path)?.file.language !== 'go') continue;
    const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    const owner = packages.find(item => item.dir === dir);
    if (owner) testIds.set(`${owner.importPath}\0${node.qualified_name}`, node.id);
  }
}

/** A path in a coverage profile, written by import path, as the repository's. */
const repoPath = (file, modulePath) => (file.startsWith(`${modulePath}/`) ? file.slice(modulePath.length + 1) : null);

/**
 * Each package's tests built once with coverage on, and every test and subtest run alone with a profile of its own: what each
 * ran, by line, and its result.
 */
async function coverageRun({ packages, testIds, cacheDirs, modulePath }, { copy, scratch }) {
  const started = Date.now();
  const driver = await startDriver({ scratch, writable: [copy, scratch, ...cacheDirs] });
  const executed = new Map(), results = new Map();
  try {
    for (const [at, item] of packages.entries()) {
      const binary = join(scratch, `package-${at}.test`);
      const built = await driver.exec('go', ['test', '-c', '-cover', '-covermode=set', `-coverpkg=${modulePath}/...`, '-o', binary, `./${item.dir || '.'}`], { cwd: copy });
      if (built.code !== 0) throw new Error(`go test could not build ${item.importPath}: ${built.output.trim().split('\n').slice(-4).join(' | ')}`);
      const listed = await driver.exec(binary, ['-test.list', '.*'], { cwd: join(copy, item.dir) });
      if (listed.code !== 0) throw new Error(`go test could not list the tests of ${item.importPath}: ${listed.output.trim().split('\n').slice(-4).join(' | ')}`);
      const tops = listed.output.split('\n').map(line => line.trim()).filter(line => /^(Test|Example|Fuzz)\w*$/.test(line));
      const runOne = async (test, pattern) => {
        const profile = join(scratch, `profile-${at}-${results.size}.out`);
        const ran = await driver.exec(binary, ['-test.run', pattern, '-test.v', `-test.coverprofile=${profile}`], { cwd: join(copy, item.dir) });
        const lines = new Map();
        // A test that crashed before it ended writes no profile, and is known by its result to have failed.
        const text = await readFile(profile, 'utf8').catch(error => { if (error.code === 'ENOENT' && ran.code !== 0) return ''; throw error; });
        for (const row of text.split('\n').slice(1)) {
          const match = /^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/.exec(row);
          const path = match && repoPath(match[1], modulePath);
          if (!path || match[4] === '0') continue;
          if (!lines.has(path)) lines.set(path, new Set());
          for (let line = Number(match[2]); line <= Number(match[3]); line++) lines.get(path).add(line);
        }
        const id = testIds.get(`${item.importPath}\0${plain(test)}`) ?? `go::${item.importPath}::${test}`;
        const merged = executed.get(id) ?? new Map();
        for (const [path, set] of lines) { if (!merged.has(path)) merged.set(path, new Set()); for (const line of set) merged.get(path).add(line); }
        executed.set(id, merged);
        return ran;
      };
      for (const top of tops) {
        const ran = await runOne(top, `^${top}$`);
        for (const match of ran.output.matchAll(/^\s*--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+)s\)/gm)) {
          const test = match[2];
          if (match[1] === 'SKIP') continue;
          results.set(`${item.importPath}\0${test}`, { test: testIds.get(`${item.importPath}\0${plain(test)}`) ?? `go::${item.importPath}::${test}`, status: match[1] === 'PASS' ? 'passed' : 'failed', time: Number(match[3]) });
          // A subtest alone: its own lines, apart from its parent's.
          if (test.includes('/')) await runOne(test, test.split('/').map(part => `^${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).join('/'));
        }
      }
    }
  } finally { await driver.close(); }
  return { executed, results, seconds: (Date.now() - started) / 1000 };
}

/** Each mutant written into a free copy and its tests run by `go test`, then the file put back. */
async function session({ packages, testIds, cacheDirs }, { copies }) {
  const free = [...copies];
  const waiting = [];
  const take = () => (free.length ? Promise.resolve(free.pop()) : new Promise(resolve => waiting.push(resolve)));
  const give = copy => (waiting.length ? waiting.shift()(copy) : free.push(copy));
  const drivers = new Map();
  for (const copy of copies) drivers.set(copy, await startDriver({ scratch: copy.scratch, writable: [copy.dir, copy.scratch, ...cacheDirs] }));
  return {
    async run({ path, source, nodes, timeout, bail }) {
      const copy = await take();
      const file = join(copy.dir, path);
      const original = await readFile(file);
      try {
        await writeFile(file, source);
        const byPackage = Map.groupBy(nodes, node => node.split('\0')[0]);
        const tops = [...new Set(nodes.map(node => node.split('\0')[1].split('/')[0]))];
        const pattern = `^(${tops.map(test => test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
        const dirs = [...byPackage.keys()].map(importPath => `./${packages.find(item => item.importPath === importPath).dir || '.'}`);
        const ran = await drivers.get(copy).exec('go', ['test', '-count=1', '-json', '-run', pattern, ...(bail ? ['-failfast'] : []), ...dirs], { cwd: copy.dir, timeout });
        if (ran.timedOut) return { status: 'timeout' };
        const outcome = new Map();
        for (const event of events(ran.output)) {
          if (event.Test && (event.Action === 'pass' || event.Action === 'fail')) outcome.set(`${event.Package}\0${event.Test}`, event.Action === 'pass' ? 'passed' : 'failed');
        }
        // A mutant that stops its package building has no tests run against it: the edit broke the code.
        if (!nodes.some(node => outcome.has(node))) return { status: 'invalid', error: ran.output.trim().split('\n').slice(-3).join(' | ') };
        return { status: 'ran', results: new Map(nodes.filter(node => outcome.has(node)).map(node => [node, { test: testIds.get(`${node.split('\0')[0]}\0${plain(node.split('\0')[1])}`), status: outcome.get(node) }])) };
      } finally {
        await writeFile(file, original);
        give(copy);
      }
    },
    async close() { for (const driver of drivers.values()) await driver.close(); },
  };
}
