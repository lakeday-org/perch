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
import { dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { mutantId } from '../mutants.js';
import { startDriver } from './driver.js';
import { startWorkers, WORKER_IO } from './workers.js';
import { instrument, PRELUDE, SCHEMATA_LANGUAGES, TS_HEAD } from './schemata.js';

const run = promisify(execFile);

/**
 * The state every hook and every instrumented file shares, made by whichever loads first. What a suite's own hooks reach, a
 * `before` that builds the app every test then uses, is put down to the file: the name `''` stands for every test in it.
 */
const STATE = `const __perch_env = (globalThis.process && globalThis.process.env) || {};
const __perch_state = globalThis.__perch_state || (globalThis.__perch_state = { active: __perch_env.PERCH_MUTANT === undefined ? -1 : Number(__perch_env.PERCH_MUTANT), test: '', file: '', hits: __perch_env.PERCH_COVERAGE ? new Map() : null });
const __perch_enter = file => { __perch_state.file = file || ''; __perch_state.test = file ? JSON.stringify([file, '']) : ''; };
const __perch_flush = () => {
  if (__perch_state.hits && __perch_env.PERCH_HITS) {
    for (const [test, seen] of __perch_state.hits) if (test) __perch_fs.appendFileSync(__perch_env.PERCH_HITS, JSON.stringify([test, [...seen]]) + '\\n');
    __perch_state.hits.clear();
  }
  __perch_enter(__perch_state.file);
};`;

/**
 * Mocha kept loaded: the repository's own config and the test script's flags read once by Mocha's own loader, its requires and
 * root hooks loaded once, and each mutant a fresh Mocha over the files it needs, ES modules among them loaded again under a query
 * of their own. Each test's result comes from the runner's events; a hook that fails fails the tests it was for.
 */
const MOCHA_WORKER = `${WORKER_IO}
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(process.env.PERCH_ROOT + '/package.json');
const Mocha = require('mocha');
const { loadOptions } = require('mocha/lib/cli/options');
const { handleRequires } = require('mocha/lib/cli/run-helpers');
globalThis.__perch_state = { active: -1, test: '', hits: null };
const { spec, reporter, reporterOption, reporterOptions, grep, fgrep, watch, parallel, jobs, ...options } = loadOptions(JSON.parse(process.env.PERCH_FLAGS));
const rootHooks = await handleRequires(options.require || []);
class Silent { constructor(runner) { this.runner = runner; } }
__perch_ready();
let round = 0;
const testsOf = suite => [...suite.tests, ...suite.suites.flatMap(testsOf)];
for await (const line of __perch_commands) {
  const { id, mutant, files, pattern, bail } = JSON.parse(line);
  globalThis.__perch_state.active = mutant;
  const mocha = new Mocha({ ...options, rootHooks, reporter: Silent, bail: Boolean(bail), ...(pattern ? { grep: new RegExp(pattern) } : {}) });
  for (const file of files) mocha.addFile(resolve(file));
  const n = round++;
  const results = [];
  const record = (test, status) => { if (test && test.file) results.push([test.file, test.titlePath().join(' > '), status]); };
  try {
    await mocha.loadFilesAsync({ esmDecorator: file => file + '?perch=' + n });
    await new Promise(done => {
      const runner = mocha.run(() => done());
      runner.on('pass', test => record(test, 'passed'));
      runner.on('fail', test => {
        if (test.type !== 'hook') return record(test, 'failed');
        const tests = test.ctx && test.ctx.currentTest ? [test.ctx.currentTest] : testsOf(test.parent);
        for (const item of tests) record(item, 'failed');
      });
    });
  } catch (error) { results.push(['', '', 'crashed', String(error && error.stack || error)]); }
  try { mocha.unloadFiles(); mocha.dispose(); } catch {}
  // The repository's own modules load again for the next mutant: state one left in them is not the next one's. Its
  // dependencies stay loaded.
  for (const key of Object.keys(require.cache)) if (key.startsWith(process.env.PERCH_ROOT + '/') && !key.includes('/node_modules/')) delete require.cache[key];
  await __perch_done({ id, results });
}
`;

/**
 * Jest kept loaded: runCLI called again for each mutant, in band, over the files it needs. Each test file gets a fresh
 * environment, which reads the mutant from PERCH_MUTANT as it starts.
 */
const JEST_WORKER = `${WORKER_IO}
import { createRequire } from 'node:module';
const require = createRequire(process.env.PERCH_ROOT + '/package.json');
const { runCLI } = require('jest');
__perch_ready();
for await (const line of __perch_commands) {
  const { id, mutant, files, pattern } = JSON.parse(line);
  process.env.PERCH_MUTANT = String(mutant);
  const results = [];
  try {
    const { results: run } = await runCLI({ _: files, $0: 'jest', ...(pattern ? { testNamePattern: pattern } : {}), runInBand: true, ci: true, silent: true, watchman: false, reporters: [], passWithNoTests: true }, [process.cwd()]);
    for (const file of run.testResults) {
      for (const item of file.testResults) if (item.status === 'passed' || item.status === 'failed') results.push([file.testFilePath, [...item.ancestorTitles, item.title].join(' > '), item.status]);
      if (file.testExecError) results.push([file.testFilePath, '', 'crashed', String(file.testExecError.message)]);
    }
  } catch (error) { results.push(['', '', 'error', String(error && error.stack || error)]); }
  await __perch_done({ id, results });
}
`;

/**
 * Vitest kept loaded: one Vitest made with the repository's config, and each mutant a run of the test files it needs, the mutant
 * named in the worker's own file, which the hooks read. Vitest's API has moved between versions: 2 globs and runs files, 3 and
 * later test specifications, and the name filter moved from an override to a setter.
 */
const VITEST_WORKER = `${WORKER_IO}
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(process.env.PERCH_ROOT + '/package.json');
const api = await import(pathToFileURL(require.resolve('vitest/node')).href);
// Vitest's caches go to perch's scratch directory: the repository's node_modules is linked in to be read, not written.
const vitest = await api.createVitest('test', { watch: false, reporters: [{ onInit() {} }], cache: false }, { cacheDir: process.env.PERCH_CACHE });
const specs = vitest.getRelevantTestSpecifications ? await vitest.getRelevantTestSpecifications() : vitest.globTestSpecifications ? await vitest.globTestSpecifications() : await vitest.globTestFiles();
const fileOf = spec => spec.moduleId ?? spec[1];
const titles = task => { const names = []; for (let at = task; at && at.filepath === undefined; at = at.suite) if (at.name) names.unshift(at.name); return names; };
__perch_ready();
for await (const line of __perch_commands) {
  const { id, mutant, files, pattern } = JSON.parse(line);
  writeFileSync(process.env.PERCH_ACTIVE, String(mutant));
  const wanted = new Set(files.map(file => resolve(file)));
  const chosen = specs.filter(spec => wanted.has(fileOf(spec)));
  if (vitest.setGlobalTestNamePattern) vitest.setGlobalTestNamePattern(pattern ? new RegExp(pattern) : /.*/); else vitest.configOverride.testNamePattern = pattern ? new RegExp(pattern) : undefined;
  const results = [];
  try {
    const run = vitest.runTestSpecifications ? await vitest.runTestSpecifications(chosen, false) : (await vitest.runFiles(chosen, false), null);
    const tasks = run && run.testModules ? run.testModules.map(module => module.task) : vitest.state.getFiles().filter(file => wanted.has(file.filepath));
    const walk = task => {
      if (task.type === 'test' && task.result && (task.result.state === 'pass' || task.result.state === 'fail')) results.push([task.file.filepath, titles(task).join(' > '), task.result.state === 'pass' ? 'passed' : 'failed']);
      for (const child of task.tasks || []) walk(child);
      if (task.filepath && task.result && task.result.state === 'fail' && !(task.tasks || []).length) results.push([task.filepath, '', 'crashed', JSON.stringify(task.result.errors || [])]);
    };
    for (const task of tasks) walk(task);
  } catch (error) { results.push(['', '', 'error', String(error && error.stack || error)]); }
  await __perch_done({ id, results });
}
`;

/** Each framework: how it is run, the hooks that name the test running, and how it reports what passed. */
const FRAMEWORKS = {
  vitest: {
    bin: 'vitest', module: 'esm', results: 'json',
    // A warm worker names the mutant to run in a file of its own, read as the test file loads and before its tests: a worker
    // Vitest keeps between runs would not see a variable set after it started.
    hooks: `import { afterAll, beforeAll, beforeEach, afterEach, expect } from 'vitest';
import * as __perch_fs from 'node:fs';
${STATE}
const __perch_active = () => { if (__perch_env.PERCH_ACTIVE) { try { __perch_state.active = Number(__perch_fs.readFileSync(__perch_env.PERCH_ACTIVE, 'utf8')); } catch {} } };
__perch_active();
// What runs while the test file loads, an app built in a describe's body, is the file's.
try { __perch_enter(expect.getState().testPath); } catch {}
beforeAll(() => { __perch_active(); __perch_enter(expect.getState().testPath); });
beforeEach(() => { const state = expect.getState(); __perch_state.test = JSON.stringify([state.testPath, state.currentTestName]); });
afterEach(__perch_flush);
afterAll(__perch_flush);`,
    args: ({ files, pattern, out, bail }) => ['run', ...files, ...(pattern ? ['-t', pattern] : []), '--reporter=json', `--outputFile=${out}`, ...(bail ? ['--bail=1'] : [])],
  },
  jest: {
    bin: 'jest', module: 'cjs', results: 'json',
    hooks: `const __perch_fs = require('node:fs');
${STATE}
try { __perch_enter(expect.getState().testPath); } catch {}
module.exports = { enter: __perch_enter };
beforeAll(() => __perch_enter(expect.getState().testPath));
beforeEach(() => { const state = expect.getState(); __perch_state.test = JSON.stringify([state.testPath, state.currentTestName]); });
afterEach(__perch_flush);
afterAll(__perch_flush);`,
    // Jest's --bail ends the process before its JSON report is written, so a Jest run always runs every test it was given.
    args: ({ files, pattern, out }) => [...files, ...(pattern ? ['-t', pattern] : []), '--json', `--outputFile=${out}`, '--runInBand', '--ci', '--silent'],
  },
  mocha: {
    bin: 'mocha', module: 'cjs', results: 'hooks',
    hooks: `const __perch_fs = require('node:fs');
${STATE}
module.exports = { enter: __perch_enter };
if (!globalThis.__perch_hooked) {
  globalThis.__perch_hooked = true;
  // A suite's before and after hooks run with no test current: what they reach is the file's.
  const Hook = require('mocha').Hook, run = Hook.prototype.run;
  Hook.prototype.run = function (...args) {
    if (/^"(before|after) all" hook/.test(this.title)) __perch_enter(this.file || (this.parent && this.parent.file));
    return run.apply(this, args);
  };
  beforeEach(function () { __perch_state.test = JSON.stringify([this.currentTest.file, this.currentTest.titlePath().join(' > ')]); });
  afterEach(function () {
    if (__perch_env.PERCH_RESULTS) __perch_fs.appendFileSync(__perch_env.PERCH_RESULTS, JSON.stringify([__perch_state.test, this.currentTest.state === 'failed' ? 'failed' : this.currentTest.state === 'passed' ? 'passed' : 'skipped', (this.currentTest.duration || 0) / 1000]) + '\\n');
    __perch_flush();
  });
}`,
    args: ({ files, pattern, bail, flags }) => [...flags, ...files, ...(pattern ? ['--grep', pattern] : []), '--reporter', 'dot', ...(bail ? ['--bail'] : [])],
  },
  jasmine: {
    bin: 'jasmine', module: 'cjs', results: 'hooks',
    // Jasmine tells a reporter, not a hook, which spec is running; its suites are the ones started and not yet done.
    hooks: `const __perch_fs = require('node:fs');
${STATE}
module.exports = { enter: __perch_enter };
if (!globalThis.__perch_hooked) {
  globalThis.__perch_hooked = true;
  const suites = [];
  jasmine.getEnv().addReporter({
    suiteStarted: result => { suites.push(result.description); __perch_enter(result.filename); },
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
  // Cucumber's tests are the scenarios of its feature files, named in its own Before hook, which perch adds to the step
  // definitions; a scenario is filtered by its name alone.
  cucumber: {
    bin: 'cucumber-js', module: 'cjs', results: 'hooks',
    hooks: `const __perch_fs = require('node:fs');
${STATE}
module.exports = { enter: __perch_enter };
if (!globalThis.__perch_hooked) {
  globalThis.__perch_hooked = true;
  const { Before, After, AfterAll } = require('@cucumber/cucumber');
  Before(function ({ pickle, gherkinDocument }) { __perch_state.test = JSON.stringify([gherkinDocument.uri, gherkinDocument.feature.name + ' > ' + pickle.name]); });
  After(function ({ result }) {
    const status = result && result.status === 'PASSED' ? 'passed' : result && result.status === 'FAILED' ? 'failed' : 'skipped';
    if (__perch_env.PERCH_RESULTS) __perch_fs.appendFileSync(__perch_env.PERCH_RESULTS, JSON.stringify([__perch_state.test, status, result && result.duration ? (result.duration.seconds || 0) + (result.duration.nanos || 0) / 1e9 : 0]) + '\\n');
    __perch_flush();
  });
  AfterAll(__perch_flush);
}`,
    args: ({ files, pattern, bail }) => [...files, ...(pattern ? ['--name', pattern] : []), ...(bail ? ['--fail-fast'] : [])],
  },
  // Karma runs the tests in a browser, which can write no file: the hooks, loaded first, print what they record as marked console
  // lines, which Karma passes back. The mutant and the name filter go in as client arguments, read as the page loads.
  karma: {
    bin: 'karma', module: 'browser', results: 'console',
    hooks: `(function () {
  var karma = globalThis.__karma__, args = (karma && karma.config && karma.config.args) || [];
  var arg = function (name) { for (var at = 0; at < args.length; at++) if (String(args[at]).indexOf(name + '=') === 0) return String(args[at]).slice(name.length + 1); return null; };
  var state = globalThis.__perch_state = { active: Number(arg('--perch-mutant') || -1), test: '', file: '', hits: args.indexOf('--perch-coverage') >= 0 ? new Map() : null };
  // Base64, which Karma prints as it is, in the quotes it puts around a logged string.
  var say = function (record) { console.log('@@perch' + btoa(unescape(encodeURIComponent(JSON.stringify(record))))); };
  var flush = function () {
    if (state.hits) { state.hits.forEach(function (seen, test) { if (test) say({ hits: test, ids: Array.from(seen) }); }); state.hits.clear(); }
    state.test = JSON.stringify(['', '']);
  };
  state.test = JSON.stringify(['', '']);
  if (globalThis.jasmine) {
    var suites = [];
    jasmine.getEnv().addReporter({
      suiteStarted: function (result) { suites.push(result.description); },
      suiteDone: function () { suites.pop(); },
      specStarted: function (result) { state.test = JSON.stringify(['', suites.concat([result.description]).join(' > ')]); },
      specDone: function (result) { say({ result: state.test, status: result.status === 'failed' ? 'failed' : result.status === 'passed' ? 'passed' : 'skipped', time: (result.duration || 0) / 1000 }); flush(); },
    });
  } else if (globalThis.mocha) {
    beforeEach(function () { state.test = JSON.stringify(['', this.currentTest.titlePath().join(' > ')]); });
    afterEach(function () { say({ result: state.test, status: this.currentTest.state === 'failed' ? 'failed' : this.currentTest.state === 'passed' ? 'passed' : 'skipped', time: (this.currentTest.duration || 0) / 1000 }); flush(); });
  }
})();`,
    args: ({ config }) => ['start', config],
  },
  'node:test': {
    bin: null, module: 'esm', results: 'reporter',
    hooks: `import { after, before, beforeEach, afterEach } from 'node:test';
import * as __perch_fs from 'node:fs';
${STATE}
__perch_enter(process.argv[1]);
before(() => __perch_enter(process.argv[1]));
beforeEach(context => { __perch_state.test = JSON.stringify([context.filePath || process.argv[1], context.fullName]); });
afterEach(__perch_flush);
after(__perch_flush);`,
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

/**
 * A title perch read as a template, as a regular expression for the titles the run gives it: `should include ${method}` and
 * Jest's and Vitest's `.each` placeholders, `adds %d and $b`, match whatever the run put there. A plain title matches itself.
 */
const PLACEHOLDER = /\$\{[^}]*\}|%[sdifjoOpc#]|\$[A-Za-z_][\w.]*/g;
const titlePattern = title => {
  let out = '', at = 0;
  for (const match of title.matchAll(PLACEHOLDER)) { out += `${escape(title.slice(at, match.index))}.*?`; at = match.index + match[0].length; }
  return out + escape(title.slice(at));
};

/**
 * Each Cucumber scenario as a test the graph knows: a feature file's scenarios and scenario outlines, named `Feature > Scenario`
 * as the hooks name them, with the lines each spans. The parser reads no Gherkin, so these are added for the coverage run alone.
 */
async function scenarios(dir, graph) {
  const { stdout } = await run('find', [dir, '-name', '*.feature', '-not', '-path', '*/node_modules/*'], { maxBuffer: 1 << 24 });
  for (const absolute of stdout.split('\n').filter(Boolean)) {
    const path = relative(dir, absolute), lines = (await readFile(absolute, 'utf8')).split('\n');
    const feature = lines.map(line => /^\s*Feature:\s*(.+?)\s*$/.exec(line)?.[1]).find(Boolean) ?? '';
    const starts = lines.map((line, at) => ({ at: at + 1, name: /^\s*(?:Scenario|Scenario Outline|Scenario Template|Example):\s*(.+?)\s*$/.exec(line)?.[1] })).filter(item => item.name);
    const methods = starts.map((item, index) => {
      const qualified = `${feature} > ${item.name}`;
      return { id: `${path}::${qualified}`, node: null, name: item.name, qualified_name: qualified, line: item.at, end_line: (starts[index + 1]?.at ?? lines.length + 1) - 1,
        test: { name: item.name, suite: [feature], framework: 'cucumber' } };
    });
    const file = { path, language: 'gherkin', test: true, methods, calls: [], imports: [], mocks: [] };
    graph.files.set(path, { file, byQualified: new Map(), sameName: new Map() });
    for (const method of methods) graph.nodes.set(method.id, { ...method, path, language: 'gherkin', test: true, case: method.test });
  }
}

/** The project's own Karma config, by the names Karma looks for. */
async function karmaConfig(dir) {
  for (const name of ['karma.conf.js', 'karma.conf.cjs', '.config/karma.conf.js']) if (existsSync(join(dir, name))) return `./${name}`;
  throw new Error('karma is a dependency but there is no karma.conf.js');
}

/**
 * The config perch runs Karma with: the project's own, with perch's hooks loaded before its files, headless Chrome run once, and
 * the browser's console passed back, the mutant, the coverage flag and the name filter given to the page as client arguments.
 */
const KARMA_CONFIG = base => `const path = require('path');
const base = require(${JSON.stringify(base)});
module.exports = function (config) {
  base(config);
  const env = process.env, args = ['--perch-mutant=' + (env.PERCH_MUTANT || '-1')];
  if (env.PERCH_COVERAGE) args.push('--perch-coverage');
  // karma-jasmine and karma-mocha read a filter in slashes as a regular expression, and any other as plain text.
  if (env.PERCH_GREP) args.push('--grep=/' + env.PERCH_GREP + '/');
  const client = config.client || {};
  // Karma finds its plugins beside itself, which, linked in from the repository, is not where it looks: they are named here.
  const modules = path.join(__dirname, 'node_modules');
  const plugins = config.plugins && config.plugins.some(item => item !== 'karma-*') ? config.plugins
    : require('fs').readdirSync(modules).filter(name => name.startsWith('karma-')).map(name => require(path.join(modules, name)));
  // Chrome runs inside perch's sandbox, which already holds what it may write; its own cannot start inside that one, and its crash
  // reports go to the temporary directory rather than the user's.
  const crashes = path.join(require('os').tmpdir(), 'perch-chrome-crashes');
  config.set({
    plugins,
    files: [path.join(__dirname, '.perch-hooks.js')].concat(config.files || []),
    customLaunchers: Object.assign({}, config.customLaunchers, { PerchChrome: { base: 'ChromeHeadless', flags: ['--no-sandbox', '--disable-crash-reporter', '--disable-breakpad', '--crash-dumps-dir=' + crashes] } }),
    browsers: ['PerchChrome'], singleRun: true, autoWatch: false, reporters: ['dots'],
    client: Object.assign({}, client, { args: (client.args || []).concat(args), captureConsole: true }),
    browserConsoleLogOptions: { level: 'log', format: '%m', terminal: true },
  });
};
`;

/** The node_modules directories of the repository, outside any other: a workspace has one per package beside the root's. */
async function installed(root) {
  const { stdout } = await run('find', [root, '-maxdepth', '4', '-name', 'node_modules', '-type', 'd', '-prune', '-not', '-path', '*/.git/*'], { maxBuffer: 1 << 24 });
  return stdout.split('\n').filter(Boolean).map(path => relative(root, path)).filter(path => !path.split('/').slice(0, -1).includes('node_modules'));
}

/** Flags of the command that take the next word as their value. */
const VALUED = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--ui', '-u', '--timeout', '-t', '--slow', '-s', '--file', '--extension', '--config', '--spec']);
/** Flags perch sets itself, or that would change how a run reports or stops. */
const OWN = /^(--test(-|$)|--watch|--reporter|-R$|--reporter-option|-O$|--grep|-g$|--fgrep|-f$|--bail|-b$|--parallel|-p$|--jobs|-j$|--forbid-only|--exit$)/;

/**
 * The flags the package's own test script gives the framework's command: `node --test --experimental-test-module-mocks` keeps
 * the flag, `mocha --require test/support/env --check-leaks test/` keeps both and not the directory.
 */
async function scriptFlags(root, command) {
  const script = JSON.parse(await readFile(join(root, 'package.json'), 'utf8').catch(() => '{}')).scripts?.test ?? '';
  const words = script.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  const start = words.findIndex(word => word === command || word.endsWith(`/${command}`));
  if (start < 0) return [];
  const flags = [];
  for (let at = start + 1; at < words.length && !['&&', '||', ';', '|'].includes(words[at]); at++) {
    const word = words[at];
    if (!word.startsWith('-')) continue;
    const valued = VALUED.has(word.split('=')[0]) && !word.includes('=');
    if (OWN.test(word)) { if (valued || ['--reporter', '-R', '--reporter-option', '-O', '--grep', '-g', '--fgrep', '-f', '--jobs', '-j'].includes(word)) at++; continue; }
    flags.push(word);
    if (valued && words[at + 1]) flags.push(words[++at].replace(/^['"]|['"]$/g, ''));
  }
  return flags;
}

/** A runner for one framework. */
export function javascriptRunner(framework) {
  const spec = FRAMEWORKS[framework];
  let ids = new Map(), keys = new Map(), unplaced = new Map(), tests = new Map(), templates = new Map(), suffixes = new Map(), inFile = new Map(), testFiles = [], flags = [], hooksFile = null, reporter = null, root = null;

  /** Each hook-named test, `[file, name]`, as perch's id: the file from the root, then the names, joined as perch joins them. */
  const idOf = (copy, raw) => {
    const [file, name] = JSON.parse(raw);
    return resolve(file ? (isAbsolute(file) ? relative(copy, file) : file) : '', name);
  };
  /**
   * The perch test a run's name in a file is: the same name, Jest's spaced one, or the one template that fits it. Failing those,
   * the test whose names end the run's: a test written in a helper that suites call, or under a suite called through a
   * condition, `(skip ? describe.skip : describe)(...)`, is named by the parser without the suites the run puts it in. The
   * longest such ending, when one test has it.
   */
  const resolve = (path, name) => {
    // A browser knows no file: the one test in any file the name is.
    if (path === '') {
      const found = [...new Set([...inFile.keys()].map(file => resolve(file, name)).filter(id => tests.has(id)))];
      return found.length === 1 ? found[0] : `::${name}`;
    }
    const direct = `${path}::${name}`;
    if (tests.has(direct)) return direct;
    if (tests.has(`${path}\0${name}`)) return tests.get(`${path}\0${name}`);
    const fits = (templates.get(path) ?? []).filter(item => item.pattern.test(name));
    if (fits.length === 1) return fits[0].id;
    const ending = (suffixes.get(path) ?? []).filter(item => item.pattern.test(name));
    const longest = Math.max(...ending.map(item => item.length));
    const best = ending.filter(item => item.length === longest);
    return best.length === 1 ? best[0].id : direct;
  };
  /** Records a Karma run printed, `@@perch` and the record in base64. */
  const printed = output => [...output.matchAll(/@@perch([A-Za-z0-9+/=]+)/g)].map(match => JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')));
  /** A results file, or the printed records of a run in a browser, as each test's result, by perch's id. */
  const readResults = async (copy, out, covering, output = '') => {
    const results = new Map();
    if (spec.results === 'console') {
      const records = printed(output).filter(record => record.result);
      if (!records.length) return null;
      for (const record of records) {
        if (record.status === 'skipped') continue;
        const id = idOf(copy, record.result);
        results.set(id, { test: id, status: results.get(id)?.status === 'failed' ? 'failed' : record.status, time: record.time });
      }
      return results;
    }
    if (spec.results === 'json') {
      const text = await readFile(out, 'utf8').catch(() => null);
      if (text === null) return null;
      for (const file of JSON.parse(text).testResults ?? []) {
        const path = relative(copy, file.name);
        for (const item of file.assertionResults ?? []) {
          if (!['passed', 'failed'].includes(item.status)) continue;
          const id = resolve(path, [...item.ancestorTitles, item.title].join(' > '));
          // A template's cases are one test: it fails if any case does, and takes as long as all of them.
          const had = results.get(id);
          results.set(id, { test: id, status: had?.status === 'failed' ? 'failed' : item.status, time: (had?.time ?? 0) + (item.duration ?? 0) / 1000 });
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

  const runner = {
    name: framework,
    languages: framework === 'cucumber' ? new Set([...SCHEMATA_LANGUAGES, 'gherkin']) : SCHEMATA_LANGUAGES,
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
        const placed = instrument({ source: await readFile(file, 'utf8'), language: graph.files.get(path).file.language, mutants, prelude: PRELUDE, head: TS_HEAD });
        for (const { id, reason } of placed.unplaced) unplaced.set(id, reason);
        await writeFile(file, placed.text);
      }
      hooksFile = join(copy.dir, `.perch-hooks.${spec.module === 'esm' ? 'mjs' : spec.module === 'browser' ? 'js' : 'cjs'}`);
      await writeFile(hooksFile, spec.hooks);
      if (framework === 'karma') await writeFile(join(copy.dir, '.perch-karma.conf.js'), KARMA_CONFIG(await karmaConfig(copy.dir)));
      tests = new Map();
      testFiles = [];
      if (framework === 'cucumber') await scenarios(copy.dir, graph);
      for (const [path, { file }] of graph.files) {
        // Cucumber's hooks go into its step definitions, which declare no test; its tests are the feature files'.
        if (framework === 'cucumber') {
          if (file.language === 'gherkin') { testFiles.push(path); continue; }
          if (!SCHEMATA_LANGUAGES.has(file.language) || !/@cucumber\/cucumber/.test(await readFile(join(copy.dir, path), 'utf8'))) continue;
        } else if (!SCHEMATA_LANGUAGES.has(file.language) || !file.methods.some(method => method.test)) continue;
        else testFiles.push(path);
        // Karma loads the hooks itself, first, from the config perch wraps around the project's.
        if (framework === 'karma') continue;
        const full = join(copy.dir, path);
        const text = await readFile(full, 'utf8');
        const specifier = `./${relative(dirname(full), hooksFile)}`.replace(/^\.\/\.\.\//, '../');
        const esm = /^\s*(import|export)\s/m.test(text);
        // A CommonJS test file names itself as it loads, so what loading it runs, an example app it requires, is its tests'.
        const line = esm ? `import ${JSON.stringify(specifier)};` : spec.module === 'cjs' ? `require(${JSON.stringify(specifier)}).enter(__filename);` : `require(${JSON.stringify(specifier)});`;
        const bang = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
        await writeFile(full, `${text.slice(0, bang)}${line}\n${text.slice(bang)}`);
      }
      templates = new Map();
      suffixes = new Map();
      inFile = new Map();
      for (const node of graph.nodes.values()) {
        if (!node.case || !runner.languages.has(graph.files.get(node.path)?.file.language)) continue;
        tests.set(node.id, node);
        if (!inFile.has(node.path)) inFile.set(node.path, []);
        inFile.get(node.path).push(node.id);
        const titles = node.id.slice(node.path.length + 2).split(' > ');
        tests.set(`${node.path}\0${titles.join(' ')}`, node.id);
        if (node.case.parametrized) {
          if (!templates.has(node.path)) templates.set(node.path, []);
          templates.get(node.path).push({ id: node.id, pattern: new RegExp(`^${titles.map(titlePattern).join('(?: > | )')}$`) });
        }
        if (!suffixes.has(node.path)) suffixes.set(node.path, []);
        suffixes.get(node.path).push({ id: node.id, length: titles.length, pattern: new RegExp(`(?:^|> | )${titles.map(titlePattern).join('(?: > | )')}$`) });
      }
      flags = await scriptFlags(root, framework === 'node:test' ? 'node' : spec.bin);
      if (framework === 'node:test') {
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
        ran = await driver.exec(command(tool), spec.args({ files: ['vitest', 'jest'].includes(framework) ? [] : testFiles, out, flags, reporter, config: join(copy, '.perch-karma.conf.js') }),
          { cwd: copy, env: { PERCH_COVERAGE: '1', PERCH_HITS: hits, PERCH_RESULTS: out, FORCE_COLOR: '0' }, whole: spec.results === 'console' });
      } finally { await driver.close(); }
      const results = await readResults(copy, out, null, ran.output);
      // A browser prints the switches each test reached rather than writing them.
      if (spec.results === 'console') await writeFile(hits, printed(ran.output).filter(record => record.hits).map(record => `${JSON.stringify([record.hits, record.ids])}\n`).join(''));
      if (!results) throw new Error(`${framework} did not run the suite (exit ${ran.code}): ${ran.output.trim().split('\n').slice(-5).join(' | ')}`);
      const reached = new Map(), executed = new Map();
      for (const line of (await readFile(hits, 'utf8')).split('\n').filter(Boolean)) {
        const [raw, seen] = JSON.parse(line);
        const [file, name] = JSON.parse(raw);
        // What a file's suite hooks reached is every test in that file's.
        const owners = name === '' ? (inFile.get(relative(copy, file)) ?? []) : [idOf(copy, raw)];
        for (const test of owners) {
          if (!reached.has(test)) { reached.set(test, new Set()); executed.set(test, new Map()); }
          for (const id of seen) {
            const { key, mutant, path } = keys.get(id);
            reached.get(test).add(key);
            const lines = executed.get(test);
            if (!lines.has(path)) lines.set(path, new Set());
            for (const item of mutant.statements.length ? mutant.statements : [mutant.line]) lines.get(path).add(item);
          }
        }
      }
      const hitMethods = new Set([...keys.values()].map(({ key }) => key.slice(0, key.lastIndexOf('#'))));
      return { executed, hits: reached, hitMethods, unplaced: new Set([...unplaced.keys()].map(id => keys.get(id).key)), results, seconds: (Date.now() - started) / 1000 };
    },

    /**
     * Each mutant run with its number set, over the files of the tests that run it and only those tests: in a worker that keeps
     * Mocha or Jest loaded, or by starting Vitest, Jasmine or node:test.
     */
    async session({ copies: [copy], parallel = 1 }) {
      const warm = { mocha: MOCHA_WORKER, jest: JEST_WORKER, vitest: VITEST_WORKER }[framework];
      const workers = warm ? await startWorkers({ script: warm, count: parallel, scratch: copy.scratch, writable: [copy.dir, copy.scratch], cwd: copy.dir,
        env: index => ({ PERCH_ROOT: copy.dir, PERCH_FLAGS: JSON.stringify(flags), PERCH_ACTIVE: join(copy.scratch, `active-${index}`), PERCH_CACHE: join(copy.scratch, `cache-${index}`), FORCE_COLOR: '0' }) }) : null;
      const driver = warm ? null : await startDriver({ scratch: copy.scratch, writable: [copy.dir, copy.scratch] });
      let count = 0;
      /** The run's results by perch's id, or null when nothing ran: what a crash or an error before any test leaves. */
      const runWarm = async ({ id, files, pattern, bail, timeout }) => {
        const reply = await workers.run({ id: count++, mutant: id, files, pattern, bail }, timeout);
        if (reply.timedOut) return { timedOut: true };
        if (reply.crashed) return { code: 1, results: null, output: reply.output };
        const results = new Map();
        let crashed = null;
        for (const [file, name, status, error] of reply.results) {
          // The framework itself failing is perch's environment, not the mutant: the run stops and says so.
          if (status === 'error') throw new Error(`${framework} failed running a mutant: ${String(error).split('\n').slice(0, 4).join(' | ')}`);
          if (status === 'crashed') { crashed = error; continue; }
          const test = resolve(relative(copy.dir, file), name);
          results.set(test, { test, status: results.get(test)?.status === 'failed' ? 'failed' : status });
        }
        return { code: crashed ? 1 : 0, results: results.size ? results : null, output: crashed ?? '' };
      };
      const runCold = async ({ id, files, pattern, bail, timeout, nodes }) => {
        const out = join(copy.scratch, `run-${count++}.${spec.results === 'json' ? 'json' : 'jsonl'}`);
        if (spec.results !== 'json') await writeFile(out, '');
        const ran = await driver.exec(command({ root }), spec.args({ files, pattern, out, bail, flags, reporter, config: join(copy.dir, '.perch-karma.conf.js') }),
          { cwd: copy.dir, env: { PERCH_MUTANT: String(id), PERCH_RESULTS: out, PERCH_GREP: pattern ?? '', FORCE_COLOR: '0' }, timeout, whole: spec.results === 'console' });
        if (ran.timedOut) return { timedOut: true };
        const results = await readResults(copy.dir, out, nodes, ran.output);
        await rm(out, { force: true });
        return { code: ran.code, results, output: ran.output };
      };
      return {
        async run({ mutant, method, nodes, timeout, bail = false }) {
          const id = ids.get(`${method.id}#${mutantId(mutant)}`);
          if (unplaced.has(id)) return { status: 'invalid', error: unplaced.get(id) };
          const files = [...new Set(nodes.map(test => test.split('::')[0]))];
          // Each framework matches a test's name with its suites before it: Jest, Mocha, Jasmine and Vitest 2 joined by spaces,
          // Vitest 3 on by ` > `. node:test is run by file.
          const names = nodes.map(test => test.slice(test.indexOf('::') + 2));
          // A name is matched by its ending, as resolve matches it: a test the parser named without all its suites runs under them.
          const pattern = framework === 'node:test' ? null : framework === 'cucumber' ? `^(?:${names.map(name => titlePattern(name.split(' > ').at(-1))).join('|')})$`
            : `(?:^|> | )(?:${names.map(name => name.split(' > ').map(titlePattern).join('(?: > | )')).join('|')})$`;
          const ran = await (warm ? runWarm : runCold)({ id, files, pattern, bail, timeout, nodes });
          if (ran.timedOut) return { status: 'timeout' };
          const { results } = ran;
          if (!results || !nodes.some(test => results.has(test))) {
            // The run ended in an error before any test said how it did: the mutant crashed loading the tests, which they notice
            // as surely as a failed assertion. The same command ran the suite clean before anything was switched on. A run that
            // reported its tests as skipped did not crash; it ran nothing it was asked to.
            if (ran.code !== 0 && !results) return { status: 'ran', results: new Map(nodes.map(test => [test, { test, status: 'failed' }])) };
            return { status: 'invalid', error: ran.output.trim().split('\n').slice(-3).join(' | ') };
          }
          return { status: 'ran', results: new Map([...results].filter(([test]) => nodes.includes(test))) };
        },
        close: async () => { await workers?.close(); await driver?.close(); },
      };
    },
  };
  return runner;
}

