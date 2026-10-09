import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revision } from '../src/git.js';
import { analyzeTree } from '../src/analyze.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { buildGraph } from '../src/graph.js';
import { AuthenticationError } from '../src/systemone.js';
import { TOKEN_LIMITS } from '../src/tokens.js';
import { computeCoverage, coverageRepository, diffReports, judgeTests, readReports } from '../src/coverage.js';
import { available } from '../src/runners/pytest.js';
import { main } from '../src/cli.js';
import { createServer } from 'node:http';
import { commitAll, initRepo } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** A small repository with Python and TypeScript sources and tests, laid out the way pytest and vitest find them. */
const FILES = {
  'cart.py': `import pricing


def apply_discount(total, percent):
    if percent < 0:
        raise ValueError("negative")
    if percent > 100:
        percent = 100
    return pricing.round_money(total * (100 - percent) / 100)


def item_count(items):
    return len(items)


def restock(items):
    for item in items:
        if item < 0:
            return False
    return True
`,
  'pricing.py': `def round_money(value):
    return round(value, 2)
`,
  'rates.py': `import requests


def fetch_rate(code):
    return requests.get("https://rates.example/" + code).json()
`,
  'tests/test_cart.py': `from unittest.mock import patch

import pytest

import cart
import rates


def test_discount_10():
    assert cart.apply_discount(200, 10) == 180


def test_discount_20():
    assert cart.apply_discount(200, 20) == 160


def test_discount_negative():
    with pytest.raises(ValueError):
        cart.apply_discount(200, -1)


def test_count_mocked():
    assert cart.item_count([1, 2]) == 2


def test_rate():
    assert rates.fetch_rate("EUR") > 0


@patch("rates.requests.get")
def test_rate_mocked(get):
    get.return_value.json.return_value = 1.1
    assert rates.fetch_rate("EUR") == 1.1
`,
  'src/cart.ts': `import { save } from './db';

export function total(prices: number[]): number {
  let sum = 0;
  for (const price of prices) {
    if (price < 0) throw new Error('negative price');
    sum += price;
  }
  return sum;
}

export function checkout(prices: number[]): number {
  const amount = total(prices);
  save(amount);
  return amount;
}
`,
  'src/db.ts': `import { writeFileSync } from 'node:fs';

export function save(amount: number): void {
  writeFileSync('/tmp/orders.txt', String(amount));
}
`,
  'test/cart.test.ts': `import { describe, it, expect, vi } from 'vitest';
import { total, checkout } from '../src/cart';

vi.mock('../src/db');

describe('cart', () => {
  it('adds prices', () => {
    expect(total([1, 2])).toBe(3);
  });

  it('rejects a negative price', () => {
    expect(() => total([-1])).toThrow();
  });

  it('checks out', () => {
    expect(checkout([2])).toBe(2);
  });
});
`,
  'test/db.test.ts': `import { it, expect } from 'vitest';
import { save } from '../src/db';

it('saves an order', () => {
  save(3);
  expect(true).toBe(true);
});
`,
};

async function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

async function repository(files = FILES) {
  const root = await mkdtemp(join(tmpdir(), 'perch-coverage-'));
  cleanups.push(root);
  await write(root, files);
  await initRepo(root);
  return { root, out: join(root, '.perch'), revision: await revision(root) };
}

/**
 * What each test answers, by the name the state gives it: whether it calls a live service. Written here, not derived from anything
 * perch computes.
 */
const TESTS = {
  test_discount_10: {}, test_discount_20: {}, test_discount_negative: {}, test_count_mocked: {},
  test_rate: { infra: 0.9 }, test_rate_mocked: {},
  'cart > adds prices': {}, 'cart > rejects a negative price': {}, 'cart > checks out': {},
  'saves an order': { infra: 0.1 }, test_restock: {},
};
/** What a test answers to the yes-or-no questions when its script does not say. */
const NOUL_DEFAULTS = { infra: 0.05 };
/**
 * Which tests fail against each method's mutants, standing in for running them: per test reaching the method, how likely it is
 * to fail, by the mutant's kind, with `*` for every other kind; at 0.7 or over it fails. And whether a survivor matters, which is
 * what the model is asked. Chosen by hand against the fixture's methods.
 * apply_discount: its two boundaries (`<` to `<=`, `>` to `>=`) survive every test, since none passes 0 or 100; everything else
 * is killed by the two discount tests, and the negative test, which raises before the arithmetic, kills none of that.
 * total: the negative-price test kills everything, the plain one everything but the boundary, and checkout's test nothing,
 * as it asserts only on what checkout returns; the same test misses the save that checkout makes, and the save test, which
 * asserts nothing, misses save's write.
 */
const METHODS = {
  apply_discount: { matters: 0.9, kills: {
    test_discount_10: { boundary: 0.1, condition: 0.95, arithmetic: 0.9 },
    test_discount_20: { boundary: 0.1, condition: 0.95, arithmetic: 0.9 },
    test_discount_negative: { boundary: 0.1, condition: 0.9, arithmetic: 0.05 },
  } },
  item_count: { matters: 0.9, kills: { test_count_mocked: 0.9 } },
  round_money: { matters: 0.9, kills: { test_discount_10: 0.9, test_discount_20: 0.9, test_discount_negative: 0.05 } },
  total: { matters: 0.85, kills: { 'cart > adds prices': { boundary: 0.1, condition: 0.95 }, 'cart > rejects a negative price': { boundary: 0.9, condition: 0.9 }, 'cart > checks out': { '*': 0.05 } } },
  checkout: { matters: 0.9, kills: { 'cart > checks out': { removal: 0.05, '*': 0.9 } } },
  save: { matters: 0.9, kills: { 'saves an order': 0.05 } },
  fetch_rate: { matters: 0.8, kills: { test_rate: 0.9, test_rate_mocked: 0.9 } },
  restock: { matters: 0.9, kills: { test_restock: { boundary: 0.1, condition: 0.9, boolean: 0.9 } } },
};

/**
 * A scripted System One standing in for the model. It answers each question in the shape the real one does, from the test's or
 * the method's name in the state, and throws for any name in `fail`. `tests` and `methods` replace the scripts above by name.
 */
function scripted({ fail = new Set(), error = name => new Error(`scripted failure for ${name}`), tests = {}, methods = {} } = {}) {
  const calls = [];
  const noul = p => ({ type: 'noul', noul: p });
  return {
    id: 'scripted-jev', limits: TOKEN_LIMITS, calls, tests, methods,
    async ask(state, questions) {
      const name = state.test?.name ?? state.method?.name;
      calls.push({ name, state, questions });
      if (fail.has(name)) throw error(name);
      const script = state.test ? tests[name] ?? TESTS[name] : methods[name] ?? METHODS[name];
      if (!script) throw new Error(`no script for ${name}`);
      const answers = {};
      for (const id of Object.keys(questions)) {
        if (id in NOUL_DEFAULTS) answers[id] = noul(script[id] ?? NOUL_DEFAULTS[id]);
        else if (id === 'matters') answers[id] = noul(script.matters ?? 0.9);
        else throw new Error(`no script for ${id} about ${name}`);
      }
      return { model: 'scripted-jev', answers, usage: { input_tokens: 100, output_tokens: 0 } };
    },
  };
}

/**
 * A test runner standing in for running the fixture's tests, which this machine may have no Python or Node toolchain for. Its
 * coverage run says each test ran every line of the methods the call graph has it reach, written as LCOV with one record per
 * test, as a runner that measures test by test writes it; `executed` replaces that. Against a mutant, a test fails when its
 * script above gives it 0.7 or more for the mutant's kind. Every test id is its own node, and every run takes no time.
 */
function scriptedRunner({ methods = {}, executed = null, languages = ['python', 'typescript', 'tsx', 'javascript'] } = {}) {
  const runs = [];
  return {
    name: 'scripted', languages: new Set(languages), runs,
    available: async () => ({}),
    async coverageRun({ copy, scratch, paths }) {
      const lcov = [...executed].flatMap(([test, files]) => [...files].flatMap(([path, lines]) =>
        [`TN:${test}`, `SF:${path}`, ...[...lines].map(line => `DA:${line},1`), 'end_of_record']));
      const file = join(scratch, 'lcov.info');
      await writeFile(file, `${lcov.join('\n')}\n`);
      const reports = await readReports({ root: copy, files: [{ kind: 'lcov', path: file }], paths });
      return { reports, results: new Map([...executed.keys()].map(test => [test, { test, status: 'passed', time: 0 }])), seconds: 0 };
    },
    async runTests({ nodes, mutant, method }) {
      const name = method.node.qualified_name, script = methods[name] ?? METHODS[name] ?? {};
      runs.push({ name, mutant, nodes });
      const fails = test => {
        const given = script.kills?.[test.split('::').at(-1)];
        return (typeof given === 'number' ? given : given?.[mutant.kind] ?? given?.['*'] ?? script.kill ?? 0.9) >= 0.7;
      };
      return { status: 'ran', results: new Map(nodes.map(test => [test, { test, status: fails(test) ? 'failed' : 'passed' }])) };
    },
  };
}

/** What each test runs by the call graph: every line of every method it reaches. */
async function reached(repo) {
  const scan = await analyzeTree({ root: repo.root, revision: repo.revision, out: repo.out, analyzer });
  const graph = buildGraph(scan.files);
  const executed = new Map();
  for (const test of computeCoverage({ scan, graph }).tests) {
    const files = new Map();
    for (const { id } of test.reach) {
      const node = graph.nodes.get(id);
      if (!files.has(node.path)) files.set(node.path, new Set());
      for (let line = node.line; line <= node.end_line; line++) files.get(node.path).add(line);
    }
    executed.set(test.id, files);
  }
  return executed;
}

// The tests perch runs are the scripted runner's: whether this machine could run the fixture's pytest and vitest suites is not
// these tests' to depend on. `runner` replaces the scripted one built from the model's method scripts.
const run = async (repo, systemOne, { runner, ...extra } = {}) => coverageRepository({ root: repo.root, revision: repo.revision, out: repo.out, analyzer, systemOne, parallel: 2,
  runner: runner ?? scriptedRunner({ methods: systemOne.methods, executed: await reached(repo) }), ...extra });
const byId = list => new Map(list.map(item => [item.id, item]));
const kinds = report => report.findings.map(finding => `${finding.kind} ${finding.unit}`).sort();

describe('the survivors of a run', () => {
  async function calculator() {
    const root = await mkdtemp(join(tmpdir(), 'perch-survivors-'));
    cleanups.push(root);
    await mkdir(join(root, 'shop'));
    await mkdir(join(root, 'tests'));
    await writeFile(join(root, 'shop', 'calc.py'), 'def add(a, b):\n    return a + b\n');
    const cases = Array.from({ length: 20 }, (_, at) => `def test_${String(at + 1).padStart(2, '0')}():\n    assert add(${at}, 1) is not None\n`);
    await writeFile(join(root, 'tests', 'test_calc.py'), `from shop.calc import add\n\n\n${cases.join('\n\n')}`);
    await initRepo(root);
    return { root, revision: await revision(root), out: join(root, '.perch') };
  }

  it('kills a mutant a test fails against, and asks only whether a survivor matters', async () => {
    // Test 17 of 20 fails against every mutant: each is killed by it, with all twenty run, and the model is asked nothing.
    const killed = scripted({ methods: { add: { matters: 0.9, kill: 0.1, kills: { test_17: 0.9 } } } });
    const report = await run(await calculator(), killed);
    const add = report.methods.find(method => method.id === 'shop/calc.py::add');
    expect(add.mutants.length).toBeGreaterThan(1);
    for (const mutant of add.mutants) {
      expect(mutant).toMatchObject({ killed: true, killed_by: ['tests/test_calc.py::test_17'] });
      expect(mutant.asked).toHaveLength(20);
    }
    expect(killed.calls).toEqual([]);

    // No test fails: every mutant survives all twenty, and is asked once whether a caller could see the change.
    const missed = scripted({ methods: { add: { matters: 0.9, kill: 0.1 } } });
    const quiet = await run(await calculator(), missed);
    const survived = quiet.findings.filter(finding => finding.kind === 'survived' && finding.unit === 'shop/calc.py::add');
    expect(survived).toHaveLength(add.mutants.length);
    for (const finding of survived) expect(finding).toMatchObject({ probability: 0.9, note: expect.stringMatching(/none of the 20 tests that run it fails\.$/) });
    expect(missed.calls.map(call => Object.keys(call.questions).join())).toEqual(add.mutants.map(() => 'matters'));
    // An edit no caller could observe is equivalent: nothing is listed, and the score leaves it out rather than count it against
    // the tests.
    const same = scripted({ methods: { add: { matters: 0.2, kill: 0.1 } } });
    const equivalent = await run(await calculator(), same);
    const plain = equivalent.methods.find(method => method.id === 'shop/calc.py::add');
    expect(plain.mutants.every(mutant => mutant.equivalent && !mutant.killed && mutant.asked.length === 20)).toBe(true);
    expect(plain.equivalent).toBe(plain.mutants.length);
    expect(equivalent.findings.filter(finding => finding.unit === 'shop/calc.py::add')).toEqual([]);
    expect(equivalent.totals).toMatchObject({ equivalent: plain.mutants.length, mutants: 0, killed: 0, score: null });
  });

  it('counts a run past its time limit as killed and an edit the tests cannot load as invalid', async () => {
    const outcomes = ['timeout', 'invalid'];
    const repo = await calculator();
    const runner = scriptedRunner({ executed: await reached(repo) });
    let at = 0;
    const report = await run(repo, scripted({ methods: { add: { matters: 0.9, kill: 0.1 } } }), { runner: { ...runner,
      runTests: async () => ({ status: outcomes[at++ % 2], results: new Map() }) } });
    const add = report.methods.find(method => method.id === 'shop/calc.py::add');
    const timedOut = add.mutants.filter(mutant => mutant.timeout), invalid = add.mutants.filter(mutant => mutant.invalid);
    expect(timedOut.length + invalid.length).toBe(add.mutants.length);
    expect(timedOut.every(mutant => mutant.killed)).toBe(true);
    expect(report.totals).toMatchObject({ killed: timedOut.length, invalid: invalid.length, mutants: timedOut.length });
    expect(report.findings.filter(finding => finding.kind === 'survived')).toEqual([]);
  });
});

describe('reach measured by the test run', () => {
  async function measuredRepo() {
    const root = await mkdtemp(join(tmpdir(), 'perch-measured-'));
    cleanups.push(root);
    await mkdir(join(root, 'shop'));
    await mkdir(join(root, 'tests'));
    await mkdir(join(root, 'reports'));
    await writeFile(join(root, 'shop', 'calc.py'), 'def add(a, b):\n    if a > 100:\n        return 0\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n');
    await writeFile(join(root, 'tests', 'test_calc.py'), 'from shop.calc import add, sub\n\n\ndef test_small():\n    assert add(1, 1) == 2\n\n\ndef test_large():\n    assert add(200, 1) == 0\n\n\ndef test_never():\n    if False:\n        sub(1, 1)\n');
    await initRepo(root);
    // What pytest-cov writes with --cov-context=test and `coverage json --show-contexts`: each line, and the tests that ran it.
    // test_small ran lines 2 and 4, test_large lines 2 and 3; sub's line 8 never ran; the def lines ran at import, under no test.
    const ran = name => `tests/test_calc.py::${name}|run`;
    const report = { meta: { format: 3, version: '7.6.1', timestamp: '2026-10-09T00:00:00', branch_coverage: false, show_contexts: true },
      files: { 'shop/calc.py': { executed_lines: [1, 2, 3, 4, 7], missing_lines: [8], excluded_lines: [],
        contexts: { 1: [''], 2: [ran('test_small'), ran('test_large')], 3: [ran('test_large')], 4: [ran('test_small')], 7: [''] } } } };
    await writeFile(join(root, 'reports', 'coverage.json'), JSON.stringify(report));
    return { root, revision: await revision(root), out: join(root, '.perch'), report: join(root, 'reports', 'coverage.json') };
  }

  /** A run whose coverage is the given file, as the runner's own test run would have written it. */
  async function measured(repo, systemOne, path) {
    const runner = { ...scriptedRunner({ methods: systemOne.methods }), async coverageRun({ copy, paths }) {
      const reports = await readReports({ root: copy, files: [{ kind: 'contexts', path }], paths });
      const results = new Map(['test_small', 'test_large', 'test_never'].map(name => [`tests/test_calc.py::${name}`, { test: `tests/test_calc.py::${name}`, status: 'passed', time: 0 }]));
      return { reports, results, seconds: 0 };
    } };
    return { report: await run(repo, systemOne, { runner }), runs: runner.runs };
  }

  it('runs a mutant only against the tests that ran its line, and calls a line no test ran no coverage', async () => {
    const repo = await measuredRepo();
    const systemOne = scripted({ methods: { add: { matters: 0.9, kill: 0.9 } } });
    const { report, runs } = await measured(repo, systemOne, repo.report);
    const add = report.methods.find(method => method.id === 'shop/calc.py::add'), sub = report.methods.find(method => method.id === 'shop/calc.py::sub');
    expect(add.measured_by).toBe('test');
    const asked = line => add.mutants.filter(mutant => mutant.line === line && !mutant.no_coverage).map(mutant => mutant.asked);
    // `return 0` on line 3 ran only under test_large, `a + b` on line 4 only under test_small; the condition on line 2 under both.
    for (const tests of asked(3)) expect(tests).toEqual(['tests/test_calc.py::test_large']);
    for (const tests of asked(4)) expect(tests).toEqual(['tests/test_calc.py::test_small']);
    for (const tests of asked(2)) expect([...tests].sort()).toEqual(['tests/test_calc.py::test_large', 'tests/test_calc.py::test_small']);
    expect(asked(4).length).toBeGreaterThan(0);
    // The graph reaches sub through test_never, but the run says its body never ran: every mutant of it has no coverage, and no
    // request was made about it.
    expect(sub.covered).toBe(false);
    expect(sub.mutants.length).toBeGreaterThan(0);
    expect(sub.mutants.every(mutant => mutant.no_coverage && !mutant.asked.length)).toBe(true);
    expect(runs.filter(item => item.name === 'sub')).toEqual([]);
    expect(report.totals.no_coverage).toBe(sub.mutants.length + add.mutants.filter(mutant => mutant.no_coverage).length);

    // coverage.py's own data file says the same in bitmaps and arcs, and is read the same way.
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = join(repo.root, 'reports', '.coverage');
    const db = new DatabaseSync(dbPath);
    db.exec('create table file (id integer primary key, path text); create table context (id integer primary key, context text);'
      + ' create table line_bits (file_id integer, context_id integer, numbits blob); create table arc (file_id integer, context_id integer, fromno integer, tono integer);');
    db.prepare('insert into file values (1, ?)').run('shop/calc.py');
    for (const [id, context] of [[1, ''], [2, 'tests/test_calc.py::test_small|run'], [3, 'tests/test_calc.py::test_large|run']]) db.prepare('insert into context values (?, ?)').run(id, context);
    // Lines 1 and 7 at import as bits; test_small's lines 2 and 4 as bits; test_large's lines 2 and 3 as arcs, with an exit arc.
    const bits = lines => { const bytes = new Uint8Array(2); for (const line of lines) bytes[line >> 3] |= 1 << (line & 7); return bytes; };
    db.prepare('insert into line_bits values (1, 1, ?)').run(bits([1, 7]));
    db.prepare('insert into line_bits values (1, 2, ?)').run(bits([2, 4]));
    for (const [from, to] of [[-1, 2], [2, 3], [3, -1]]) db.prepare('insert into arc values (1, 3, ?, ?)').run(from, to);
    db.close();
    const { report: again } = await measured(repo, scripted({ methods: { add: { matters: 0.9, kill: 0.9 } } }), dbPath);
    const asked2 = line => again.methods.find(method => method.id === 'shop/calc.py::add').mutants.filter(mutant => mutant.line === line && !mutant.no_coverage).map(mutant => mutant.asked);
    for (const line of [2, 3, 4]) expect(asked2(line)).toEqual(asked(line));
    expect(again.methods.find(method => method.id === 'shop/calc.py::sub').mutants.every(mutant => mutant.no_coverage)).toBe(true);
  });
});

const pytest = await available({ root: tmpdir() });
describe.skipIf(!pytest.python)('running the tests', () => {
  it('runs the suite with per-test coverage, runs each mutant against the tests that run it, and asks only about survivors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-pytest-'));
    cleanups.push(root);
    await mkdir(join(root, 'shop'));
    await mkdir(join(root, 'tests'));
    // add is checked exactly; scale only for running without error, so its arithmetic survives; untouched never runs.
    // bump's default is decided at import and used by a call; small's condition runs over three lines, which coverage.py records
    // by the lines it executes rather than the `if (` line.
    await writeFile(join(root, 'shop', 'calc.py'), 'def add(a, b):\n    return a + b\n\n\ndef scale(a, factor):\n    return a * factor\n\n\ndef untouched(a):\n    return a - 1\n\n\ndef bump(a, by=1):\n    return a + by\n\n\ndef small(a):\n    if (\n        a < 10\n    ):\n        return True\n    return False\n');
    await writeFile(join(root, 'tests', 'test_calc.py'), 'from shop.calc import add, bump, scale, small\n\n\ndef test_add():\n    assert add(2, 3) == 5\n\n\ndef test_scale_runs():\n    scale(2, 3)\n\n\ndef test_bump():\n    assert bump(1) == 2\n\n\ndef test_small():\n    assert small(9) is True\n    assert small(10) is False\n');
    await writeFile(join(root, 'pytest.ini'), '[pytest]\ntestpaths = tests\n');
    await initRepo(root);
    const systemOne = scripted({ methods: { scale: { matters: 0.9 } } });
    const report = await coverageRepository({ root, revision: await revision(root), out: join(root, '.perch'), analyzer, systemOne, parallel: 2 });
    expect(report.measured).toMatchObject({ runner: 'pytest', files: { test: 1, run: 0, none: 0 } });
    const method = name => report.methods.find(item => item.id === `shop/calc.py::${name}`);
    // add's mutants are killed by running test_add against them; nothing was asked about them.
    const arithmetic = method('add').mutants.find(mutant => mutant.kind === 'arithmetic');
    expect(arithmetic).toMatchObject({ killed: true, killed_by: ['tests/test_calc.py::test_add'], fails: [1] });
    expect(systemOne.calls.filter(call => call.name === 'add')).toEqual([]);
    // scale's arithmetic survives the test that runs it, for real, and only then is the model asked whether it matters.
    const survived = method('scale').mutants.find(mutant => mutant.kind === 'arithmetic');
    expect(survived).toMatchObject({ killed: false, asked: ['tests/test_calc.py::test_scale_runs'], fails: [0], matters: 0.9 });
    expect(report.findings.some(finding => finding.kind === 'survived' && finding.unit === 'shop/calc.py::scale')).toBe(true);
    expect(systemOne.calls.filter(call => call.name === 'scale').every(call => Object.keys(call.questions).join() === 'matters')).toBe(true);
    // untouched ran under no test: its mutants have no coverage, and nothing was run or asked about them.
    expect(method('untouched').mutants.every(mutant => mutant.no_coverage)).toBe(true);
    // The default `1` becoming `0` is caught by the test that calls bump; the boundary on small's middle line by test_small.
    expect(method('bump').mutants.find(mutant => mutant.kind === 'number')).toMatchObject({ killed: true, killed_by: ['tests/test_calc.py::test_bump'] });
    expect(method('small').mutants.find(mutant => mutant.kind === 'boundary')).toMatchObject({ killed: true, killed_by: ['tests/test_calc.py::test_small'] });
    // test_scale_runs kills nothing it runs: it checks nothing, from what really happened.
    expect(report.findings.some(finding => finding.kind === 'checks_nothing' && finding.unit === 'tests/test_calc.py::test_scale_runs')).toBe(true);
  }, 120000);
});

describe('test reach', () => {
  it('walks through a helper in the test file to the code it calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-helper-'));
    cleanups.push(root);
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'test'));
    await writeFile(join(root, 'src', 'cart.js'), 'export function total(items) {\n  return items.length;\n}\n');
    await writeFile(join(root, 'test', 'cart.test.js'), "import { total } from '../src/cart.js';\nfunction run(items) {\n  return total(items);\n}\ntest('totals', () => {\n  expect(run([1])).toBe(1);\n});\n");
    await initRepo(root);
    const scan = await analyzeTree({ root, revision: await revision(root), out: join(root, '.perch'), analyzer });
    const [test] = computeCoverage({ scan, graph: buildGraph(scan.files) }).tests;
    // run is the test's own code: walked through at the depth of the call to it, not itself reached, and shown with the test.
    expect(test.reach).toEqual([{ id: 'src/cart.js::total', depth: 1 }]);
    expect(test.helpers).toEqual(['test/cart.test.js::run']);
  });

  it('stops at mocks and test files, and nowhere else', async () => {
    const repo = await repository();
    const scan = await analyzeTree({ root: repo.root, revision: repo.revision, out: repo.out, analyzer });
    const graph = buildGraph(scan.files);
    const coverage = computeCoverage({ scan, graph });
    const tests = byId(coverage.tests);
    expect([...tests.keys()].sort()).toEqual([
      'test/cart.test.ts::cart > adds prices', 'test/cart.test.ts::cart > checks out', 'test/cart.test.ts::cart > rejects a negative price',
      'test/db.test.ts::saves an order',
      'tests/test_cart.py::test_count_mocked', 'tests/test_cart.py::test_discount_10', 'tests/test_cart.py::test_discount_20',
      'tests/test_cart.py::test_discount_negative', 'tests/test_cart.py::test_rate', 'tests/test_cart.py::test_rate_mocked',
    ]);
    const ten = tests.get('tests/test_cart.py::test_discount_10');
    expect(ten.reach).toEqual([{ id: 'cart.py::apply_discount', depth: 1 }, { id: 'pricing.py::round_money', depth: 2 }]);
    expect(ten.direct).toEqual(['cart.py::apply_discount']);
    expect(ten.touches).toEqual([]);
    // vi.mock('../src/db') at the top of the file cuts save out of every test in it.
    const checksOut = tests.get('test/cart.test.ts::cart > checks out');
    expect(checksOut.reach).toEqual([{ id: 'src/cart.ts::checkout', depth: 1 }, { id: 'src/cart.ts::total', depth: 2 }]);
    expect(checksOut.cuts).toEqual(['src/db.ts::save']);
    // The same save, unmocked, writes a file.
    const saves = tests.get('test/db.test.ts::saves an order');
    expect(saves.reach).toEqual([{ id: 'src/db.ts::save', depth: 1 }]);
    expect(saves.cuts).toEqual([]);
    expect(saves.touches).toEqual(['filesystem']);
    expect(tests.get('tests/test_cart.py::test_rate').touches).toEqual(['network']);
    // Patched where rates looks it up, requests.get no longer reaches the network.
    expect(tests.get('tests/test_cart.py::test_rate_mocked').touches).toEqual([]);
    const methods = byId(coverage.methods);
    expect(methods.get('cart.py::restock').tests).toEqual([]);
    expect(methods.get('cart.py::apply_discount').branches).toEqual([5, 7]);
    expect(methods.get('pricing.py::round_money').tests.map(item => item.depth)).toEqual([2, 2, 2]);
  });
});

describe('perch coverage', () => {
  it('judges every test and method', async () => {
    const repo = await repository();
    const systemOne = scripted();
    const runner = scriptedRunner({ executed: await reached(repo) });
    const report = await run(repo, systemOne, { runner });
    expect(report.failed).toEqual([]);
    // The model is asked about the test with a network call in reach, and about each mutant every test that runs it passed against:
    // apply_discount's two boundaries, the save checkout's test never checks, and save's three, which its test asserts nothing about.
    expect(systemOne.calls.map(call => [call.name, call.state.method?.mutation.kind ?? null, Object.keys(call.questions).join()])).toEqual([
      ['test_rate', null, 'infra'],
      ['apply_discount', 'boundary', 'matters'], ['apply_discount', 'boundary', 'matters'],
      ['checkout', 'removal', 'matters'],
      ['save', 'body', 'matters'], ['save', 'removal', 'matters'], ['save', 'string', 'matters'],
    ]);
    // Each is asked with the method as written, the edit in words and as code, and the method's callers.
    const boundary = systemOne.calls.find(call => call.name === 'apply_discount').state;
    expect(boundary.method.mutation).toEqual({ kind: 'boundary', edit: '`<=` instead of `<`', original: 'if percent < 0:', mutated: 'if percent <= 0:' });
    expect(boundary.method.source).toContain('if percent < 0:');
    const removal = systemOne.calls.find(call => call.name === 'checkout').state;
    expect(removal.method.mutation).toEqual({ kind: 'removal', edit: 'the call `save(amount);` removed', original: 'save(amount);', mutated: '' });
    // Every mutant of a method a test runs is run against those tests; restock's, which no test runs, against none.
    expect(runner.runs.filter(item => item.name === 'apply_discount')).toHaveLength(19);
    expect(runner.runs.filter(item => item.name === 'restock')).toEqual([]);

    const tests = byId(report.tests);
    const twenty = tests.get('tests/test_cart.py::test_discount_20');
    // Kills exactly the mutants test_discount_10 kills: one test written twice.
    expect(twenty).toMatchObject({ useful: false, redundant_with: 'tests/test_cart.py::test_discount_10', asked: 22 });
    expect(twenty.kills).toHaveLength(20);
    expect(tests.get('tests/test_cart.py::test_discount_10').useful).toBe(true);
    // Kills the two negated conditions and not the arithmetic: a different test.
    expect(tests.get('tests/test_cart.py::test_discount_negative')).toMatchObject({ useful: true, redundant_with: null });
    expect(tests.get('tests/test_cart.py::test_discount_negative').kills).toHaveLength(14);
    // Kills no mutant of total and only checkout's emptied body: a kill of its own, so it is kept.
    expect(tests.get('test/cart.test.ts::cart > checks out')).toMatchObject({ useful: true, asked: 10 });
    expect(tests.get('test/cart.test.ts::cart > checks out').kills).toHaveLength(1);
    // Asserts nothing, so it kills none of save's three mutants: it checks nothing.
    expect(tests.get('test/db.test.ts::saves an order')).toMatchObject({ useful: false, asked: 3, kills: [] });
    // Reaches only item_count, whose two mutants it kills.
    expect(tests.get('tests/test_cart.py::test_count_mocked')).toMatchObject({ useful: true, asked: 2 });
    expect(tests.get('tests/test_cart.py::test_count_mocked').kills).toHaveLength(2);
    expect(tests.get('test/cart.test.ts::cart > adds prices').name).toBe('adds prices');
    expect(tests.get('test/cart.test.ts::cart > adds prices').suite).toEqual(['cart']);

    const findings = byId(report.findings);
    expect(kinds(report)).toEqual([
      'checks_nothing test/db.test.ts::saves an order',
      'infra tests/test_cart.py::test_rate',
      'redundant tests/test_cart.py::test_discount_20',
      // test_rate and test_rate_mocked kill fetch_rate's two mutants alike, so the second repeats the first.
      'redundant tests/test_cart.py::test_rate_mocked',
      'survived cart.py::apply_discount',
      'survived cart.py::apply_discount',
      'survived src/cart.ts::checkout',
      'survived src/db.ts::save',
      'survived src/db.ts::save',
      'survived src/db.ts::save',
    ]);
    const find = (kind, unit) => report.findings.filter(finding => finding.kind === kind && finding.unit === unit);
    // Both failed against exactly the same mutants of the same code: certain, since both were run.
    expect(find('redundant', 'tests/test_cart.py::test_discount_20')[0]).toMatchObject({ probability: 1, note: 'Kills the same mutants as test_discount_10 at line 9, and no others.' });
    expect(find('checks_nothing', 'test/db.test.ts::saves an order')[0]).toMatchObject({ probability: 1, note: 'Kills none of the 3 mutants in the code it reaches.' });
    // The call checkout makes to save: removed, the one test still passes, since it asserts only on what checkout returns.
    expect(find('survived', 'src/cart.ts::checkout')[0]).toMatchObject({ line: 14, note: 'With the call `save(amount);` removed, the 1 test that runs it still passes.' });
    // Survived for certain, so listed at the chance a caller could see the change.
    expect(find('survived', 'src/cart.ts::checkout')[0].probability).toBe(0.9);
    // That no test reaches restock is the call graph's alone, and the call graph alone lists no problem.
    expect(find('survived', 'cart.py::restock')).toEqual([]);
    // The two boundaries: every test passes against each, and each matters at 0.9.
    const uncaught = find('survived', 'cart.py::apply_discount');
    expect(uncaught.map(finding => [finding.line, finding.note])).toEqual([
      [5, 'With `<=` instead of `<`, none of the 3 tests that run it fails.'],
      [7, 'With `>=` instead of `>`, none of the 3 tests that run it fails.'],
    ]);
    for (const finding of uncaught) expect(finding.probability).toBe(0.9);
    expect(new Set(uncaught.map(finding => finding.id)).size).toBe(2);
    expect(find('infra', 'tests/test_cart.py::test_rate')[0]).toMatchObject({ probability: 0.9, note: 'Calls a live service with nothing mocked: requests.get at rates.py:5.' });
    // The model is shown the call and where it is, and the method making it is in the graph it reads.
    const rate = systemOne.calls.find(call => call.name === 'test_rate').state;
    expect(rate.test.reachable_io).toEqual(['requests.get at rates.py:5']);
    expect(rate.graph.nodes.map(item => item.id)).toContain('rates.py::fetch_rate');
    // The call graph finds save writing a file with nothing mocking it. A test's disk is not a live service, so the fact stays on
    // the test, it is not asked about, and no problem is listed.
    expect(tests.get('test/db.test.ts::saves an order').touches).toEqual(['filesystem']);
    expect(systemOne.calls.find(call => call.name === 'saves an order')).toBe(undefined);
    expect(find('infra', 'test/db.test.ts::saves an order')).toEqual([]);
    expect(twenty.findings.map(id => findings.get(id).kind)).toEqual(['redundant']);

    const methods = byId(report.methods);
    const discount = methods.get('cart.py::apply_discount');
    expect(discount).toMatchObject({ killed: 17, useful: ['tests/test_cart.py::test_discount_10', 'tests/test_cart.py::test_discount_negative'] });
    expect(discount.mutants).toHaveLength(19);
    // The two boundaries survive; every condition is killed by all three tests, every arithmetic by the two discount tests.
    expect(discount.mutants.filter(mutant => !mutant.killed).map(mutant => [mutant.kind, mutant.line])).toEqual([['boundary', 5], ['boundary', 7]]);
    expect(discount.mutants.filter(mutant => mutant.kind === 'condition').map(mutant => mutant.killed_by.length)).toEqual([3, 3, 3, 3]);
    expect(discount.mutants.filter(mutant => mutant.kind === 'arithmetic').map(mutant => mutant.killed_by.length)).toEqual([2, 2, 2]);
    const first = discount.mutants.find(mutant => mutant.kind === 'boundary');
    expect(first).toMatchObject({ line: 5, column: 15, from: '<', to: '<=', original: '    if percent < 0:', mutated: '    if percent <= 0:', asked: discount.tests.map(item => item.id) });
    expect(first.id).toMatch(/^5:15:boundary:[0-9a-f]{8}$/);
    expect(first).toMatchObject({ survives: 1, matters: 0.9, fails: [0, 0, 0] });
    // The negative-price test kills every mutant of total; the plain one misses only the boundary.
    const total = methods.get('src/cart.ts::total');
    expect(total).toMatchObject({ killed: 8 });
    expect(total.mutants.every(mutant => mutant.killed_by.includes('test/cart.test.ts::cart > rejects a negative price'))).toBe(true);
    expect(total.mutants.filter(mutant => !mutant.killed_by.includes('test/cart.test.ts::cart > adds prices')).map(mutant => mutant.kind)).toEqual(['boundary']);
    expect(methods.get('rates.py::fetch_rate')).toMatchObject({ killed: 3 });
    expect(methods.get('rates.py::fetch_rate').mutants).toHaveLength(3);
    expect(methods.get('cart.py::item_count')).toMatchObject({ killed: 2, tests: [{ id: 'tests/test_cart.py::test_count_mocked', depth: 1 }] });
    expect(methods.get('cart.py::item_count').mutants.map(mutant => mutant.kind)).toEqual(['body', 'return']);
    // No test reaches restock: its eight mutants are made, asked about nothing, and have no coverage.
    expect(methods.get('cart.py::restock')).toMatchObject({ killed: 0, covered: false, tests: [] });
    expect(methods.get('cart.py::restock').mutants).toHaveLength(8);
    expect(methods.get('cart.py::restock').mutants.every(mutant => !mutant.killed && mutant.asked.length === 0 && mutant.survives === null && mutant.finding === null)).toBe(true);

    // The score counts restock's eight uncovered mutants against the tests, as Stryker does; the covered score leaves them out.
    expect(report.totals).toMatchObject({ methods: 8, covered: 7, useful_covered: 6, mutants: 48, killed: 34, no_coverage: 8, score: 34 / 48, covered_score: 34 / 40, survived: 6, tests: 10, useful: 7, redundant: 2, weak: 1, infra: 1,
      drop: { count: 3 } });
    // saves an order is the only test reaching save, and it is dropped for checking nothing.
    expect(report.totals.drop.unreached).toEqual(['src/db.ts::save']);
    const cartFile = report.files.find(file => file.path === 'cart.py');
    expect(cartFile.kind).toBe('source');
    expect(cartFile.totals).toMatchObject({ methods: 3, covered: 2, useful_covered: 2, mutants: 29, killed: 19, no_coverage: 8, survived: 2 });
    expect(cartFile.totals.score).toBeCloseTo(19 / 29);
    expect(cartFile.totals.covered_score).toBeCloseTo(19 / 21);
    expect(cartFile.lines[4]).toBe('    if percent < 0:');
    expect(report.files.find(file => file.path === 'tests/test_cart.py').totals).toMatchObject({ tests: 6, useful: 4, redundant: 2, weak: 0, infra: 1 });

    // Saved where the next run and the page read it.
    // A line of everything but the lists, then a line per item, so a report of any size is written and read a line at a time.
    const [header, ...items] = (await readFile(join(repo.out, 'coverage', 'latest.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(header).toMatchObject({ revision: report.revision, findings: [], methods: [] });
    expect(items.filter(([list]) => list === 'findings').map(([, finding]) => finding)).toEqual(report.findings);
    expect(items.filter(([list]) => list === 'methods')).toHaveLength(report.methods.length);
    expect(await readdir(join(repo.out, 'coverage', 'reports'))).toHaveLength(1);
    expect(report.baseline).toBe(null);
  });

  it('leaves out closed problems until reopened', async () => {
    const repo = await repository();
    const first = await run(repo, scripted());
    const repeat = first.findings.find(finding => finding.kind === 'redundant');
    expect(repeat.unit).toBe('tests/test_cart.py::test_discount_20');
    const out = [];
    const io = { stdout: text => out.push(text), stderr: text => out.push(text), env: {} };
    // An id perch coverage printed, or a unique prefix of it, is what perch close takes; the closure covers that one kind.
    const closedCode = await main(['close', repeat.id.slice(0, 6), '--reason', 'keeps the 20 percent case the docs quote', '--out', repo.out], io);
    expect(closedCode).toBe(0);
    expect(out).toEqual([`${repeat.id}  test_discount_20  tests/test_cart.py:13  closed  redundant`]);
    const [event] = (await readFile(join(repo.out, 'closed.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(event).toMatchObject({ type: 'dismissed', id: repeat.id, method: repeat.unit, path: 'tests/test_cart.py', kinds: ['redundant'], reason: 'keeps the 20 percent case the docs quote' });
    const closed = await run(repo, scripted());
    expect(closed.findings.map(finding => finding.id)).not.toContain(repeat.id);
    expect(closed.closed).toEqual([expect.objectContaining({ id: repeat.id, kind: 'redundant', reason: 'keeps the 20 percent case the docs quote' })]);
    // Set aside is not fixed.
    expect(diffReports(first, closed).findings.fixed.map(finding => finding.id)).not.toContain(repeat.id);
    // A test someone chose to keep is not one that could go.
    expect(closed.totals.drop.count).toBe(first.totals.drop.count - 1);
    // The judgment is unchanged: it still repeats the other test.
    expect(closed.tests.find(test => test.id === repeat.unit).redundant_with).toBe('tests/test_cart.py::test_discount_10');
    const reopenCode = await main(['reopen', repeat.id, '--out', repo.out], io);
    expect(out.at(-1)).toBe(`${repeat.id}  test_discount_20  tests/test_cart.py:13  reopened  redundant`);
    expect(reopenCode).toBe(0);
    const reopened = await run(repo, scripted());
    expect(reopened.findings.map(finding => finding.id)).toContain(repeat.id);
    expect(reopened.closed).toEqual([]);
  });

  it('keeps a survived mutant on its own line when code above the method moves it down', async () => {
    const repo = await repository();
    await run(repo, scripted());
    // Three lines above every method in cart.py: each one's text and its neighbours' are what they were, only the lines move.
    await writeFile(join(repo.root, 'cart.py'), FILES['cart.py'].replace('import pricing\n', 'import pricing\n\n# Prices are in cents.\nCURRENCY = "USD"\n'));
    await commitAll(repo.root, 'a constant above the methods');
    const second = await run({ ...repo, revision: await revision(repo.root) }, scripted());
    // The mutants still point at their own lines, which moved with them, and their problems keep their ids.
    const discount = second.methods.find(method => method.id === 'cart.py::apply_discount');
    expect(discount.mutants.filter(mutant => mutant.kind === 'boundary').map(mutant => [mutant.line, mutant.original.trim()])).toEqual([[8, 'if percent < 0:'], [10, 'if percent > 100:']]);
    expect(second.findings.filter(finding => finding.kind === 'survived' && finding.unit === 'cart.py::apply_discount').map(finding => finding.line)).toEqual([8, 10]);
  });

  it('records units it could not ask about', async () => {
    const repo = await repository();
    const report = await run(repo, scripted({ fail: new Set(['cart > rejects a negative price', 'apply_discount']) }));
    // The test is never asked, having no live service in reach; apply_discount is asked about its two survivors, and both fail.
    expect(report.failed.map(unit => [unit.subject, unit.unit])).toEqual(Array(2).fill(['method', 'cart.py::apply_discount']));
    expect(report.failed[0].error).toBe('scripted failure for apply_discount');
    // What the run found stands: the two survived, so they are listed, with nothing to say how much they matter.
    const discount = report.methods.find(method => method.id === 'cart.py::apply_discount');
    expect(discount).toMatchObject({ killed: 17 });
    expect(report.findings.filter(finding => finding.unit === 'cart.py::apply_discount').map(finding => [finding.line, finding.probability])).toEqual([[5, null], [7, null]]);
    expect(report.totals).toMatchObject({ mutants: 48, killed: 34 });
  });

  it('stops on rejected credentials', async () => {
    const repo = await repository();
    const refused = scripted({ fail: new Set(['apply_discount']), error: () => new AuthenticationError(401, 'bad key') });
    await expect(run(repo, refused)).rejects.toThrow(/HTTP 401/);
  });

  it('compares with the last run', async () => {
    const repo = await repository();
    const before = await run(repo, scripted());
    await write(repo.root, {
      'tests/test_cart.py': `${FILES['tests/test_cart.py']}

def test_restock():
    assert cart.restock([1, 2]) is True
`,
      'pricing.py': `${FILES['pricing.py']}

def tax(value):
    return value * 0.2
`,
    });
    await commitAll(repo.root, 'restock test, tax');
    const after = await run({ ...repo, revision: await revision(repo.root) }, scripted());
    expect(after.baseline).toEqual({ revision: before.revision, created_at: before.created_at });
    const { diff } = after;
    expect(diff.tests).toEqual({ added: ['tests/test_cart.py::test_restock'], removed: [] });
    const methods = byId(diff.methods);
    // restock's eight mutants had no coverage; once a test reaches it, seven are killed and its boundary survives.
    expect(methods.get('cart.py::restock')).toMatchObject({ before: { covered: false, mutants: 8, killed: 0 }, after: { covered: true, mutants: 8, killed: 7 } });
    expect(methods.get('pricing.py::tax')).toMatchObject({ before: null, after: { covered: false, mutants: 3, killed: 0 } });
    expect(methods.has('cart.py::apply_discount')).toBe(false);
    expect(diff.findings.fixed).toEqual([]);
    expect(diff.findings.new.map(finding => `${finding.kind} ${finding.unit}`)).toEqual(['survived cart.py::restock']);
    expect(diff.totals.score).toEqual({ before: 34 / 48, after: 41 / 51 });
    expect(diff.totals.no_coverage).toEqual({ before: 8, after: 3 });
    expect(diff.totals.methods).toEqual({ before: 8, after: 9 });
    expect(diff.totals.tests).toEqual({ before: 10, after: 11 });
    expect(diff.files.map(file => file.path)).toEqual(['cart.py', 'pricing.py', 'tests/test_cart.py']);

    // Named, the baseline is the run saved at that commit, whatever ran since.
    const named = await run({ ...repo, revision: await revision(repo.root) }, scripted(), { diff: before.revision });
    expect(named.baseline.revision).toBe(before.revision);
  });

  it('fails fast on an unsaved baseline', async () => {
    const repo = await repository();
    await write(repo.root, { 'pricing.py': `${FILES['pricing.py']}\n# later\n` });
    await commitAll(repo.root, 'later');
    const systemOne = scripted();
    await expect(run({ ...repo, revision: await revision(repo.root) }, systemOne, { diff: 'HEAD~1' })).rejects.toThrow(/no coverage report is saved at HEAD~1/);
    await expect(run(repo, systemOne, { diff: 'no-such-branch' })).rejects.toThrow(/--diff no-such-branch does not name a commit/);
    expect(systemOne.calls).toEqual([]);
  });
});

describe('a test that mocks what it tests', () => {
  it('is listed as a fact of the graph, asked nothing, and dropped', async () => {
    const repo = await repository({
      ...FILES,
      'test/db-mocked.test.ts': `import { it, expect, vi } from 'vitest';
import { save } from '../src/db';

vi.mock('../src/db');

it('saves through the mock', () => {
  save(3);
  expect(save).toHaveBeenCalledWith(3);
});
`,
    });
    TESTS['saves through the mock'] = {};
    const systemOne = scripted();
    const report = await run(repo, systemOne);
    delete TESTS['saves through the mock'];
    const test = report.tests.find(item => item.name === 'saves through the mock');
    // The call resolved to save, and the test's own vi.mock cuts it: both halves are the graph's, so no model is asked.
    expect(test).toMatchObject({ mocked: true, cuts: ['src/db.ts::save'], reach: [], useful: false, asked: 0 });
    expect(systemOne.calls.find(call => call.name === 'saves through the mock')).toBe(undefined);
    expect(report.findings.filter(finding => finding.unit === test.id)).toEqual([expect.objectContaining({ kind: 'mocked', probability: null, line: 6, note: 'Mocks every method it calls: save.' })]);
    expect(report.totals.weak).toBe(2);
    expect(report.totals.drop.count).toBe(4);
    // checks out mocks db too, but calls checkout, which is not mocked: it tests something real.
    expect(report.tests.find(item => item.id === 'test/cart.test.ts::cart > checks out').mocked).toBe(false);
  });
});

describe('a test that calls no repository code', () => {
  it('is asked about, not failed', async () => {
    const repo = await repository({
      ...FILES,
      'test/stub.test.ts': `import { it, expect, vi } from 'vitest';

it('charges the stubbed amount', () => {
  const charge = vi.fn().mockReturnValue(42);
  expect(charge(10)).toBe(42);
});
`,
    });
    TESTS['charges the stubbed amount'] = {};
    const systemOne = scripted();
    const report = await run(repo, systemOne);
    delete TESTS['charges the stubbed amount'];
    expect(report.failed).toEqual([]);
    const stub = report.tests.find(test => test.name === 'charges the stubbed amount');
    expect(stub.direct).toEqual([]);
    // A chained call such as expect(...).toBe is recorded as dynamic and named by nothing, and it() belongs to the file.
    expect(stub.unresolved).toEqual(['charge', 'expect', 'vi.fn']);
    // Reaching no method, no mutant is asked over it, so nothing says it checks nothing: it is kept, and never asked.
    expect(stub).toMatchObject({ useful: true, asked: 0, kills: [], mocked: false });
    expect(report.findings.filter(finding => finding.unit === stub.id)).toEqual([]);
    expect(systemOne.calls.find(call => call.name === 'charges the stubbed amount')).toBe(undefined);
  });
});

/**
 * A model endpoint on localhost that answers every question it is sent, by its type: the likeliest option, a probability, a level.
 * What `perch coverage` does with the answers is not what this is for; that it reads flags, asks, and writes its report is.
 */
async function answeringEndpoint() {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const { questions } = JSON.parse(body);
      const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
        if (question.type === 'choice') {
          const keys = Object.keys(question.criteria);
          return [id, { type: 'choice', choice: keys[0], confidence: 0.9, probabilities: Object.fromEntries(keys.map((key, at) => [key, at ? 0.1 / (keys.length - 1) : 0.9])) }];
        }
        if (question.type === 'score') return [id, { type: 'score', confidence: 0.8, score: 1, probabilities: Object.fromEntries(question.criteria.map((_, at) => [String(at), at === 1 ? 1 : 0])) }];
        return [id, { type: 'noul', noul: 0.9 }];
      }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'local', answers, usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1/systemone`, close: () => new Promise(resolve => server.close(resolve)) };
}

describe.skipIf(!pytest.python)('perch coverage from the command line', () => {
  it('runs the tests, asks, prints, and writes the page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-cli-'));
    cleanups.push(root);
    // add is checked exactly; scale only for running without error, so its arithmetic survives.
    await write(root, {
      'shop/calc.py': 'def add(a, b):\n    return a + b\n\n\ndef scale(a, factor):\n    return a * factor\n',
      'tests/test_calc.py': 'from shop.calc import add, scale\n\n\ndef test_add():\n    assert add(2, 3) == 5\n\n\ndef test_scale_runs():\n    scale(2, 3)\n',
      'pytest.ini': '[pytest]\ntestpaths = tests\n',
    });
    await initRepo(root);
    const endpoint = await answeringEndpoint();
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      const out = [], err = [];
      const io = { stdout: text => out.push(text), stderr: text => err.push(text), env: { PERCH_BASE_URL: endpoint.url, PERCH_API_KEY: 'local', HOME: root } };
      const code = await main(['coverage', '--html', 'out/index.html'], io);
      expect(err.join('\n')).not.toContain('perch:');
      expect(code).toBe(3);
      // The source table's rows, before the problem blocks below it name the same files as headings.
      const table = out.join('\n').split('\n\n')[0].split('\n').map(line => line.trim().split(/\s{2,}/));
      const rows = Object.fromEntries(table.map(([path, ...cells]) => [path, cells]));
      // add's three mutants are killed; scale's three survive, and the endpoint says each matters.
      expect(rows['shop/calc.py']).toEqual(['50% (3 of 6)', '3', '0']);
      const page = await readFile(join(root, 'out', 'index.html'), 'utf8');
      expect(page).toMatch(/^<!doctype html>/);
      expect(page).toContain('Run details');
    } finally {
      vi.restoreAllMocks();
      await endpoint.close();
    }
  }, 120000);
});

describe('perch coverage on a branch', () => {
  it('reports changed code with --since', async () => {
    const repo = await repository();
    await run(repo, scripted());
    // On the branch: a line of total and one of checkout, item_count's return, a line of a test, and a file that is not source.
    const edit = (text, from, to) => { expect(text).toContain(from); return text.replace(from, to); };
    await write(repo.root, {
      'src/cart.ts': edit(edit(FILES['src/cart.ts'], 'sum += price;', 'sum += price * 1;'), 'save(amount);', 'save(amount * 1);'),
      'cart.py': edit(FILES['cart.py'], 'return len(items)', 'return len(list(items))'),
      'test/db.test.ts': edit(FILES['test/db.test.ts'], 'expect(true).toBe(true);', 'expect(1).toBe(1);'),
      'NOTES.md': 'Not source.\n',
      // A script with no methods of its own, new on the branch.
      'src/main.ts': "import { total } from './cart';\n\nconsole.log(total([1, 2]));\n",
    });
    await commitAll(repo.root, 'branch');
    const report = await run({ ...repo, revision: await revision(repo.root) }, scripted(), { since: 'main' });
    // The run on main was saved, and it is not compared with: the branch point already says what the branch did.
    expect(report.baseline).toBe(null);
    expect(report.diff).toBe(null);
    expect(report.branch).toEqual({ ref: 'main', base: await revision(repo.root, 'main'),
      units: ['cart.py::item_count', 'src/cart.ts::checkout', 'src/cart.ts::total', 'test/db.test.ts::saves an order'], findings: report.branch.findings });
    // The changed code's problems: total's mutants are all killed and item_count's one too, so the branch answers for the save
    // checkout makes that its test never checks, with the `* 1` it put beside it, and for the save test that asserts nothing.
    const onBranch = report.findings.filter(finding => report.branch.findings.includes(finding.id)).map(finding => `${finding.kind} ${finding.unit}`).sort();
    expect([...new Set(onBranch)]).toEqual(['checks_nothing test/db.test.ts::saves an order', 'survived src/cart.ts::checkout']);
    // The whole repository was still read and asked about: the branch's tests and what they reach are mostly elsewhere.
    expect(report.findings.some(finding => finding.unit === 'tests/test_cart.py::test_discount_20')).toBe(true);
  });

  it('fails fast on an unknown --since ref', async () => {
    const repo = await repository();
    const systemOne = scripted();
    await expect(run(repo, systemOne, { since: 'no-such-branch' })).rejects.toThrow(/no-such-branch/);
    expect(systemOne.calls).toEqual([]);
  });

});

it('finds duplicate tests among 40,000 in about linear time', () => {
  const mutants = new Map(), tests = [];
  // Two tests for each of 20,000 methods, run against the same three mutants, failing against the same two: the second repeats
  // the first.
  for (let index = 0; index < 20000; index++) {
    const ids = [0, 1].map(copy => `test/t${index}.test.js::t${copy}`);
    for (const [copy, id] of ids.entries()) tests.push({ id, node: { path: `test/t${index}.test.js`, line: copy + 1 } });
    mutants.set(`src/m${index}.js::m`, [0, 1, 2].map(at => ({ mutant: { line: at + 1, column: 0, from: '<', to: '<=' }, matters: 0.9, kills: ids.map(id => [id, at < 2 ? 1 : 0]) })));
  }
  const started = performance.now();
  const { redundantWith, pairProbability, useful, checksNothing } = judgeTests(tests, mutants, 0.5);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(useful.size).toBe(20000);
  expect(checksNothing.size).toBe(0);
  expect(redundantWith.get('test/t3.test.js::t1')).toBe('test/t3.test.js::t0');
  expect(pairProbability.get('test/t3.test.js::t1')).toBe(1);
});
