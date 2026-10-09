/**
 * Vitest, Jest, Mocha and node:test, run by perch with mutant schemata: every mutant of every JavaScript and TypeScript file is
 * written into one copy of the repository once, behind a switch, and a mutant is run by starting the framework with
 * PERCH_MUTANT set to its number. Nothing is written or transformed again between mutants, so each framework's own transform
 * cache stays warm across the whole run.
 *
 * Which test reaches which mutant is recorded by the switches themselves: the suite runs once with PERCH_COVERAGE set, and a
 * hook perch adds to each test file names the test running, so every switch a test reaches is put down to it. That is the
 * coverage Stryker calls per test, and it is exact to the mutant rather than the line.
 *
 * The copy has no dependencies of its own: the repository's installed node_modules are linked into it, read but never written.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { mutantId } from '../mutants.js';
import { startDriver } from './driver.js';
import { instrument, PRELUDE, SCHEMATA_LANGUAGES } from './schemata.js';

const run = promisify(execFile);

/** The state every hook and every instrumented file shares, made by whichever loads first. */
const STATE = `const __perch_env = (globalThis.process && globalThis.process.env) || {};
const __perch_state = globalThis.__perch_state || (globalThis.__perch_state = { active: __perch_env.PERCH_MUTANT === undefined ? -1 : Number(__perch_env.PERCH_MUTANT), test: '', hits: __perch_env.PERCH_COVERAGE ? new Map() : null });
const __perch_flush = () => {
  if (__perch_state.hits && __perch_env.PERCH_HITS && __perch_state.test) {
    const seen = __perch_state.hits.get(__perch_state.test);
    __perch_fs.appendFileSync(__perch_env.PERCH_HITS, JSON.stringify([__perch_state.test, [...(seen || [])]]) + '\\n');
    __perch_state.hits.delete(__perch_state.test);
  }
  __perch_state.test = '';
};`;

/** Each framework: how it is run, the hooks that name the test running, and how it reports what passed. */
const FRAMEWORKS = {
  vitest: {
    bin: 'vitest', module: 'esm', results: 'json',
    hooks: `import { beforeEach, afterEach, expect } from 'vitest';
import * as __perch_fs from 'node:fs';
${STATE}
beforeEach(() => { const state = expect.getState(); __perch_state.test = JSON.stringify([state.testPath, state.currentTestName]); });
afterEach(__perch_flush);`,
    args: ({ files, pattern, out, bail }) => ['run', ...files, ...(pattern ? ['-t', pattern] : []), '--reporter=json', `--outputFile=${out}`, ...(bail ? ['--bail=1'] : [])],
  },
  jest: {
    bin: 'jest', module: 'cjs', results: 'json',
    hooks: `const __perch_fs = require('node:fs');
${STATE}
beforeEach(() => { const state = expect.getState(); __perch_state.test = JSON.stringify([state.testPath, state.currentTestName]); });
afterEach(__perch_flush);`,
    // Jest's --bail ends the process before its JSON report is written, so a Jest run always runs every test it was given.
    args: ({ files, pattern, out }) => [...files, ...(pattern ? ['-t', pattern] : []), '--json', `--outputFile=${out}`, '--runInBand', '--ci', '--silent'],
  },
  mocha: {
    bin: 'mocha', module: 'cjs', results: 'hooks',
    hooks: `const __perch_fs = require('node:fs');
${STATE}
if (!globalThis.__perch_hooked) {
  globalThis.__perch_hooked = true;
  beforeEach(function () { __perch_state.test = JSON.stringify([this.currentTest.file, this.currentTest.titlePath().join(' > ')]); });
  afterEach(function () {
    if (__perch_env.PERCH_RESULTS) __perch_fs.appendFileSync(__perch_env.PERCH_RESULTS, JSON.stringify([__perch_state.test, this.currentTest.state === 'failed' ? 'failed' : this.currentTest.state === 'passed' ? 'passed' : 'skipped', (this.currentTest.duration || 0) / 1000]) + '\\n');
    __perch_flush();
  });
}`,
    args: ({ files, pattern, bail }) => [...files, ...(pattern ? ['--grep', pattern] : []), '--reporter', 'dot', ...(bail ? ['--bail'] : [])],
  },
  jasmine: {
    bin: 'jasmine', module: 'cjs', results: 'hooks',
    // Jasmine tells a reporter, not a hook, which spec is running; its suites are the ones started and not yet done.
    hooks: `const __perch_fs = require('node:fs');
${STATE}
if (!globalThis.__perch_hooked) {
  globalThis.__perch_hooked = true;
  const suites = [];
  jasmine.getEnv().addReporter({
    suiteStarted: result => suites.push(result.description),
    suiteDone: () => suites.pop(),
    specStarted: result => { __perch_state.test = JSON.stringify([result.filename || '', [...suites, result.description].join(' > ')]); },
    specDone: result => {
      if (__perch_env.PERCH_RESULTS) __perch_fs.appendFileSync(__perch_env.PERCH_RESULTS, JSON.stringify([__perch_state.test, result.status === 'failed' ? 'failed' : result.status === 'passed' ? 'passed' : 'skipped', (result.duration || 0) / 1000]) + '\\n');
      __perch_flush();
    },
  });
}`,
    args: ({ files, pattern, bail }) => [...files, ...(pattern ? [`--filter=${pattern}`] : []), ...(bail ? ['--fail-fast'] : [])],
  },
  'node:test': {
    bin: null, module: 'esm', results: 'reporter',
    hooks: `import { beforeEach, afterEach } from 'node:test';
import * as __perch_fs from 'node:fs';
${STATE}
beforeEach(context => { __perch_state.test = JSON.stringify([context.filePath || process.argv[1], context.fullName]); });
afterEach(__perch_flush);`,
    args: ({ files, pattern, out, flags, reporter }) => [...flags, '--test', `--test-reporter=${reporter}`, `--test-reporter-destination=${out}`, ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files],
  },
};

/**
 * node:test's results, as a reporter module: each test's file, its name with its suites before it, and whether it passed. A
 * suite is a test that holds tests, so a name is put together from the tests started above it at lower nesting.
 */
const NODE_REPORTER = `export default async function* perch(source) {
  const open = new Map();
  for await (const event of source) {
    const data = event.data || {};
    const key = data.file || '';
    if (event.type === 'test:start') { const stack = open.get(key) || []; stack.length = data.nesting; stack.push(data.name); open.set(key, stack); }
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      if (data.details && data.details.type === 'suite') continue;
      const stack = (open.get(key) || []).slice(0, data.nesting);
      const status = event.type === 'test:fail' ? 'failed' : data.skip || data.todo ? 'skipped' : 'passed';
      yield JSON.stringify([JSON.stringify([key, [...stack, data.name].join(' > ')]), status, (data.details && data.details.duration_ms || 0) / 1000]) + '\\n';
    }
  }
}
`;

const escape = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The node_modules directories of the repository, outside any other: a workspace has one per package beside the root's. */
async function installed(root) {
  const { stdout } = await run('find', [root, '-maxdepth', '4', '-name', 'node_modules', '-type', 'd', '-prune', '-not', '-path', '*/.git/*'], { maxBuffer: 1 << 24 });
  return stdout.split('\n').filter(Boolean).map(path => relative(root, path)).filter(path => !path.split('/').slice(0, -1).includes('node_modules'));
}

/** node:test's flags from the package's own test script: `node --test --experimental-test-module-mocks 'test/*.ts'` keeps the flag. */
async function nodeFlags(root) {
  const script = JSON.parse(await readFile(join(root, 'package.json'), 'utf8').catch(() => '{}')).scripts?.test ?? '';
  const words = script.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  const flags = [];
  for (let at = 0; at < words.length; at++) {
    const word = words[at];
    if (!word.startsWith('-') || /^--test(-|$)/.test(word) || word === '--watch') continue;
    flags.push(word);
    if (['--import', '--require', '-r', '--loader', '--experimental-loader'].includes(word) && words[at + 1]) flags.push(words[++at].replace(/^['"]|['"]$/g, ''));
  }
  return flags;
}

/** A runner for one framework. */
export function javascriptRunner(framework) {
  const spec = FRAMEWORKS[framework];
  let ids = new Map(), keys = new Map(), unplaced = new Map(), tests = new Map(), testFiles = [], flags = [], hooksFile = null, reporter = null, root = null;

  /** Each hook-named test, `[file, name]`, as perch's id: the file from the root, then the names, joined as perch joins them. */
  const idOf = (copy, raw) => {
    const [file, name] = JSON.parse(raw);
    const path = relative(copy, file);
    const direct = `${path}::${name}`;
    if (tests.has(direct)) return direct;
    // Jest names a test by its suites and title joined with spaces.
    return tests.get(`${path}\0${name}`) ?? direct;
  };
  /** A results file as each test's result, by perch's id. */
  const readResults = async (copy, out, covering) => {
    const results = new Map();
    if (spec.results === 'json') {
      const text = await readFile(out, 'utf8').catch(() => null);
      if (text === null) return null;
      for (const file of JSON.parse(text).testResults ?? []) {
        const path = relative(copy, file.name);
        for (const item of file.assertionResults ?? []) {
          if (!['passed', 'failed'].includes(item.status)) continue;
          const id = `${path}::${[...item.ancestorTitles, item.title].join(' > ')}`;
          results.set(id, { test: id, status: item.status, time: (item.duration ?? 0) / 1000 });
        }
        // A file that failed to load fails every test in it it was asked to run.
        if (file.status === 'failed' && !(file.assertionResults ?? []).some(item => item.status === 'failed')) {
          for (const id of covering ?? []) if (id.startsWith(`${path}::`) && !results.has(id)) results.set(id, { test: id, status: 'failed', time: 0 });
        }
      }
      return results;
    }
    const text = await readFile(out, 'utf8').catch(() => null);
    if (text === null) return null;
    for (const line of text.split('\n').filter(Boolean)) {
      const [raw, status, time] = JSON.parse(line);
      if (status === 'skipped') continue;
      const id = idOf(copy, raw);
      results.set(id, { test: id, status: results.get(id)?.status === 'failed' ? 'failed' : status, time });
    }
    return results;
  };
  const command = tool => (spec.bin ? join(tool.root, 'node_modules', '.bin', spec.bin) : process.execPath);

  return {
    name: framework,
    languages: SCHEMATA_LANGUAGES,
    copiesFor: () => 1,

    async available({ root: repository }) {
      if (spec.bin && !existsSync(join(repository, 'node_modules', '.bin', spec.bin))) {
        return { reason: `${spec.bin} is not installed in node_modules; install the repository's dependencies first` };
      }
      if (!spec.bin && Number(process.versions.node.split('.')[0]) < 22) return { reason: `node:test names tests by their suites from Node 22; this is ${process.version}` };
      return { root: repository };
    },

    /**
     * The copy made ready: dependencies linked in, every mutant written into its file behind a switch, and a hook at the top of
     * every test file.
     */
    async prepare({ copies: [copy], generated, graph, tool }) {
      root = tool.root;
      for (const path of await installed(root)) await symlink(join(root, path), join(copy.dir, path)).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const byFile = new Map();
      let next = 0;
      for (const [methodId, mutants] of generated) {
        const node = graph.nodes.get(methodId);
        if (!SCHEMATA_LANGUAGES.has(graph.files.get(node.path)?.file.language)) continue;
        if (!byFile.has(node.path)) byFile.set(node.path, []);
        for (const mutant of mutants) {
          const key = `${methodId}#${mutantId(mutant)}`, id = next++;
          ids.set(key, id);
          keys.set(id, { key, mutant, path: node.path });
          byFile.get(node.path).push({ id, mutant });
        }
      }
      for (const [path, mutants] of byFile) {
        const file = join(copy.dir, path);
        const placed = instrument({ source: await readFile(file, 'utf8'), language: graph.files.get(path).file.language, mutants, prelude: PRELUDE });
        for (const { id, reason } of placed.unplaced) unplaced.set(id, reason);
        await writeFile(file, placed.text);
      }
      hooksFile = join(copy.dir, `.perch-hooks.${spec.module === 'esm' ? 'mjs' : 'cjs'}`);
      await writeFile(hooksFile, spec.hooks);
      tests = new Map();
      testFiles = [];
      for (const [path, { file }] of graph.files) {
        if (!SCHEMATA_LANGUAGES.has(file.language) || !file.methods.some(method => method.test)) continue;
        testFiles.push(path);
        const full = join(copy.dir, path);
        const text = await readFile(full, 'utf8');
        const specifier = `./${relative(dirname(full), hooksFile)}`.replace(/^\.\/\.\.\//, '../');
        const esm = /^\s*(import|export)\s/m.test(text);
        const line = esm ? `import ${JSON.stringify(specifier)};` : `require(${JSON.stringify(specifier)});`;
        const bang = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
        await writeFile(full, `${text.slice(0, bang)}${line}\n${text.slice(bang)}`);
      }
      for (const node of graph.nodes.values()) {
        if (!node.case || !SCHEMATA_LANGUAGES.has(graph.files.get(node.path)?.file.language)) continue;
        tests.set(node.id, node);
        tests.set(`${node.path}\0${node.id.slice(node.path.length + 2).split(' > ').join(' ')}`, node.id);
      }
      if (framework === 'node:test') {
        flags = await nodeFlags(root);
        reporter = join(copy.scratch, 'perch-node-reporter.mjs');
        await writeFile(reporter, NODE_REPORTER);
      }
    },

    /** The suite once, every switch recording which test reached it: what each test ran, by mutant and by line, and each result. */
    async coverageRun({ copy, scratch, tool }) {
      const hits = join(scratch, 'hits.jsonl'), out = join(scratch, spec.results === 'json' ? 'coverage.json' : 'coverage.jsonl');
      await rm(hits, { force: true });
      await writeFile(hits, '');
      const started = Date.now();
      const driver = await startDriver({ scratch, writable: [copy, scratch] });
      let ran;
      try {
        ran = await driver.exec(command(tool), spec.args({ files: framework === 'node:test' ? testFiles : [], out, flags, reporter }),
          { cwd: copy, env: { PERCH_COVERAGE: '1', PERCH_HITS: hits, PERCH_RESULTS: out, FORCE_COLOR: '0' } });
      } finally { await driver.close(); }
      const results = await readResults(copy, out, null);
      if (!results) throw new Error(`${framework} did not run the suite (exit ${ran.code}): ${ran.output.trim().split('\n').slice(-5).join(' | ')}`);
      const reached = new Map(), executed = new Map();
      for (const line of (await readFile(hits, 'utf8')).split('\n').filter(Boolean)) {
        const [raw, seen] = JSON.parse(line);
        const test = idOf(copy, raw);
        if (!reached.has(test)) { reached.set(test, new Set()); executed.set(test, new Map()); }
        for (const id of seen) {
          const { key, mutant, path } = keys.get(id);
          reached.get(test).add(key);
          const lines = executed.get(test);
          if (!lines.has(path)) lines.set(path, new Set());
          for (const item of mutant.statements.length ? mutant.statements : [mutant.line]) lines.get(path).add(item);
        }
      }
      const hitMethods = new Set([...keys.values()].map(({ key }) => key.slice(0, key.lastIndexOf('#'))));
      return { executed, hits: reached, hitMethods, unplaced: new Set([...unplaced.keys()].map(id => keys.get(id).key)), results, seconds: (Date.now() - started) / 1000 };
    },

    /** Each mutant run by starting the framework with its number set, over the files of the tests that run it and only those tests. */
    async session({ copies: [copy] }) {
      const driver = await startDriver({ scratch: copy.scratch, writable: [copy.dir, copy.scratch] });
      let count = 0;
      return {
        async run({ mutant, method, nodes, timeout, bail = false }) {
          const id = ids.get(`${method.id}#${mutantId(mutant)}`);
          if (unplaced.has(id)) return { status: 'invalid', error: unplaced.get(id) };
          const files = [...new Set(nodes.map(test => test.split('::')[0]))];
          // Each framework matches a test's name with its suites before it: Jest, Mocha, Jasmine and Vitest 2 joined by spaces,
          // Vitest 3 on by ` > `. node:test is run by file.
          const names = nodes.map(test => test.slice(test.indexOf('::') + 2));
          const pattern = framework === 'node:test' ? null : `^(${names.map(name => name.split(' > ').map(escape).join('(?: > | )')).join('|')})$`;
          const out = join(copy.scratch, `run-${count++}.${spec.results === 'json' ? 'json' : 'jsonl'}`);
          await writeFile(out, '').catch(() => {});
          if (spec.results === 'json') await rm(out, { force: true });
          const ran = await driver.exec(command({ root }), spec.args({ files, pattern, out, bail, flags, reporter }),
            { cwd: copy.dir, env: { PERCH_MUTANT: String(id), PERCH_RESULTS: out, FORCE_COLOR: '0' }, timeout });
          if (ran.timedOut) return { status: 'timeout' };
          const results = await readResults(copy.dir, out, nodes);
          await rm(out, { force: true });
          if (!results || !nodes.some(test => results.has(test))) return { status: 'invalid', error: ran.output.trim().split('\n').slice(-3).join(' | ') };
          return { status: 'ran', results: new Map([...results].filter(([test]) => nodes.includes(test))) };
        },
        close: () => driver.close(),
      };
    },
  };
}

