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
import { computeCoverage, coverageRepository, diffReports, judgeTests } from '../src/coverage.js';
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
 * What each method answers about each mutant: whether it matters, and per test reaching it, how likely that test is to fail
 * against it, by the mutant's kind. Chosen by hand against the fixture's methods. apply_discount: its two boundaries (`<` to
 * `<=`, `>` to `>=`) survive every test, since none passes 0 or 100; the negated conditions and the arithmetic are killed by
 * the two discount tests, and the negative test, which raises before the arithmetic, kills only the conditions.
 * total: the negative-price test kills both, the plain one only the negated condition, and checkout's test kills neither.
 */
const METHODS = {
  apply_discount: { matters: 0.9, kills: {
    test_discount_10: { boundary: 0.1, condition: 0.95, arithmetic: 0.9 },
    test_discount_20: { boundary: 0.1, condition: 0.95, arithmetic: 0.9 },
    test_discount_negative: { boundary: 0.1, condition: 0.9, arithmetic: 0.05 },
  } },
  total: { matters: 0.85, kills: { 'cart > adds prices': { boundary: 0.1, condition: 0.95 }, 'cart > rejects a negative price': { boundary: 0.9, condition: 0.9 }, 'cart > checks out': { boundary: 0.05, condition: 0.05 } } },
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
    id: 'scripted-jev', limits: TOKEN_LIMITS, calls,
    async ask(state, questions) {
      const name = state.test?.name ?? state.method?.name;
      calls.push({ name, state, questions });
      if (fail.has(name)) throw error(name);
      const script = state.test ? tests[name] ?? TESTS[name] : methods[name] ?? METHODS[name];
      if (!script) throw new Error(`no script for ${name}`);
      const answers = {};
      // The tests a mutant is asked over are the graph's nodes noted test 1, test 2 and so on, in that order.
      const shown = (state.graph?.nodes ?? []).filter(node => /^test \d+$/.test(node.note ?? '')).map(node => node.id.split('::').at(-1));
      for (const id of Object.keys(questions)) {
        if (id in NOUL_DEFAULTS) answers[id] = noul(script[id] ?? NOUL_DEFAULTS[id]);
        else if (id === 'matters') answers[id] = noul(script.matters ?? 0.9);
        else if (id.startsWith('kills_')) {
          const given = script.kills?.[shown[Number(id.slice('kills_'.length)) - 1]];
          answers[id] = noul(typeof given === 'number' ? given : given?.[state.method.mutation.kind] ?? script.kill ?? 0.9);
        } else throw new Error(`no script for ${id} about ${name}`);
      }
      return { model: 'scripted-jev', answers, usage: { input_tokens: 100, output_tokens: 0 } };
    },
  };
}

const run = (repo, systemOne, extra = {}) => coverageRepository({ root: repo.root, revision: repo.revision, out: repo.out, analyzer, systemOne, ...extra });
const byId = list => new Map(list.map(item => [item.id, item]));
const kinds = report => report.findings.map(finding => `${finding.kind} ${finding.unit}`).sort();

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

  it('stops at mocks, test files and the depth limit', async () => {
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
    // One call deep, round_money is out of reach.
    const shallow = byId(computeCoverage({ scan, graph, depth: 1 }).tests);
    expect(shallow.get('tests/test_cart.py::test_discount_10').reach).toEqual([{ id: 'cart.py::apply_discount', depth: 1 }]);
  });
});

describe('perch coverage', () => {
  it('judges every test and method', async () => {
    const repo = await repository();
    const systemOne = scripted();
    const report = await run(repo, systemOne);
    expect(report.failed).toEqual([]);
    // Only the test with a network call in reach is asked anything; three of the reached methods are asked about each mutant
    // (apply_discount has seven, total two, fetch_rate one; item_count, round_money, checkout and save have no line the table
    // can change), and restock, which no test reaches, is asked nothing.
    const asked = systemOne.calls.map(call => call.name);
    expect(asked.filter(name => name in TESTS)).toEqual(['test_rate']);
    expect(asked.filter(name => name === 'apply_discount')).toHaveLength(7);
    expect(asked.filter(name => name === 'total')).toHaveLength(2);
    expect(asked.filter(name => name === 'fetch_rate')).toHaveLength(1);
    expect(asked).not.toContain('restock');
    // One request per mutant: the method as written, the one line changed, and a yes-or-no per test reaching it.
    const boundary = systemOne.calls.find(call => call.name === 'apply_discount' && call.state.method.mutation.kind === 'boundary');
    expect(boundary.state.method.mutation).toEqual({ kind: 'boundary', original: 'if percent < 0:', mutated: 'if percent <= 0:' });
    expect(boundary.state.method.source).toContain('if percent < 0:');
    expect(boundary.state.graph.nodes.map(node => [node.id, node.note])).toEqual([
      ['tests/test_cart.py::test_discount_10', 'test 1'], ['tests/test_cart.py::test_discount_20', 'test 2'], ['tests/test_cart.py::test_discount_negative', 'test 3']]);
    expect(Object.keys(boundary.questions)).toEqual(['matters', 'kills_1', 'kills_2', 'kills_3']);
    expect(boundary.questions.kills_2.instructions).toMatch(/^This question is about test 2, `tests\/test_cart.py::test_discount_20`\./);

    const tests = byId(report.tests);
    const twenty = tests.get('tests/test_cart.py::test_discount_20');
    // Kills exactly the mutants test_discount_10 kills: one test written twice.
    expect(twenty).toMatchObject({ useful: false, redundant_with: 'tests/test_cart.py::test_discount_10', asked: 7 });
    expect(twenty.kills).toHaveLength(5);
    expect(tests.get('tests/test_cart.py::test_discount_10').useful).toBe(true);
    // Kills the two negated conditions and not the arithmetic: a different test.
    expect(tests.get('tests/test_cart.py::test_discount_negative')).toMatchObject({ useful: true, redundant_with: null });
    expect(tests.get('tests/test_cart.py::test_discount_negative').kills).toHaveLength(2);
    // Kills neither mutant of total: it checks nothing.
    expect(tests.get('test/cart.test.ts::cart > checks out')).toMatchObject({ useful: false, asked: 2, kills: [] });
    // Reaches only item_count, which has no line to change: nothing to judge it by.
    expect(tests.get('tests/test_cart.py::test_count_mocked')).toMatchObject({ useful: true, asked: 0 });
    expect(tests.get('test/cart.test.ts::cart > adds prices').name).toBe('adds prices');
    expect(tests.get('test/cart.test.ts::cart > adds prices').suite).toEqual(['cart']);

    const findings = byId(report.findings);
    expect(kinds(report)).toEqual([
      'checks_nothing test/cart.test.ts::cart > checks out',
      'infra tests/test_cart.py::test_rate',
      'redundant tests/test_cart.py::test_discount_20',
      'survived cart.py::apply_discount',
      'survived cart.py::apply_discount',
    ]);
    const find = (kind, unit) => report.findings.filter(finding => finding.kind === kind && finding.unit === unit);
    // As likely as test_discount_10 is to kill the mutant it is least sure of among those test_discount_20 kills.
    expect(find('redundant', 'tests/test_cart.py::test_discount_20')[0]).toMatchObject({ probability: 0.9, note: 'Kills the same mutants as test_discount_10 at line 9, and no others.' });
    // The chance it misses both: 0.95 twice.
    expect(find('checks_nothing', 'test/cart.test.ts::cart > checks out')[0]).toMatchObject({ probability: 0.95 * 0.95, note: 'Kills none of the 2 mutants in the code it reaches.' });
    // That no test reaches restock is the call graph's alone, and the call graph alone lists no problem.
    expect(find('survived', 'cart.py::restock')).toEqual([]);
    // The two boundaries: each survives all three tests at 0.9, and matters at 0.9.
    const uncaught = find('survived', 'cart.py::apply_discount');
    expect(uncaught.map(finding => [finding.line, finding.note])).toEqual([
      [5, 'With `<=` instead of `<`, none of the 3 tests reaching it fails.'],
      [7, 'With `>=` instead of `>`, none of the 3 tests reaching it fails.'],
    ]);
    for (const finding of uncaught) expect(finding.probability).toBeCloseTo(0.9 ** 3 * 0.9);
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
    expect(discount).toMatchObject({ killed: 5, useful: ['tests/test_cart.py::test_discount_10', 'tests/test_cart.py::test_discount_negative'] });
    expect(discount.mutants.map(mutant => [mutant.kind, mutant.line, mutant.killed, mutant.killed_by.length])).toEqual([
      ['boundary', 5, false, 0], ['boundary', 7, false, 0], ['condition', 5, true, 3], ['condition', 7, true, 3],
      ['arithmetic', 9, true, 2], ['arithmetic', 9, true, 2], ['arithmetic', 9, true, 2]]);
    expect(discount.mutants[0]).toMatchObject({ id: '5:15:<><=', from: '<', to: '<=', original: '    if percent < 0:', mutated: '    if percent <= 0:', asked: discount.tests.map(item => item.id) });
    expect(discount.mutants[0].survives).toBeCloseTo(0.9 ** 3);
    // The negative-price test kills both mutants of total, so both are killed, by it.
    expect(methods.get('src/cart.ts::total')).toMatchObject({ killed: 2 });
    expect(methods.get('src/cart.ts::total').mutants.map(mutant => mutant.killed_by)).toEqual([['test/cart.test.ts::cart > rejects a negative price'], ['test/cart.test.ts::cart > adds prices', 'test/cart.test.ts::cart > rejects a negative price']]);
    expect(methods.get('rates.py::fetch_rate')).toMatchObject({ killed: 1 });
    expect(methods.get('rates.py::fetch_rate').mutants).toHaveLength(1);
    expect(methods.get('cart.py::item_count')).toMatchObject({ killed: 0, mutants: [], tests: [{ id: 'tests/test_cart.py::test_count_mocked', depth: 1 }] });
    expect(methods.get('cart.py::restock')).toMatchObject({ killed: 0, mutants: [], tests: [] });

    expect(report.totals).toMatchObject({ methods: 8, reached: 7, useful_reached: 6, mutants: 10, killed: 8, score: 0.8, survived: 2, tests: 10, useful: 8, redundant: 1, weak: 1, infra: 1,
      drop: { count: 2 } });
    // checks out is the only test reaching checkout, and it is dropped for checking nothing.
    expect(report.totals.drop.unreached).toEqual(['src/cart.ts::checkout']);
    const cartFile = report.files.find(file => file.path === 'cart.py');
    expect(cartFile.kind).toBe('source');
    expect(cartFile.totals).toMatchObject({ methods: 3, reached: 2, useful_reached: 2, mutants: 7, killed: 5, survived: 2 });
    expect(cartFile.totals.score).toBeCloseTo(5 / 7);
    expect(cartFile.lines[4]).toBe('    if percent < 0:');
    expect(report.files.find(file => file.path === 'tests/test_cart.py').totals).toMatchObject({ tests: 6, useful: 5, redundant: 1, weak: 0, infra: 1 });

    // Saved where the next run and the page read it.
    // A line of everything but the lists, then a line per item, so a report of any size is written and read a line at a time.
    const [header, ...items] = (await readFile(join(repo.out, 'coverage', 'latest.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(header).toMatchObject({ revision: report.revision, findings: [], methods: [] });
    expect(items.filter(([list]) => list === 'findings').map(([, finding]) => finding)).toEqual(report.findings);
    expect(items.filter(([list]) => list === 'methods')).toHaveLength(report.methods.length);
    expect(await readdir(join(repo.out, 'coverage', 'reports'))).toHaveLength(1);
    // One test and ten mutants.
    expect(systemOne.calls).toHaveLength(11);
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

  it('shows the model a macro the test checks through', async () => {
    const repo = await repository({
      'src/add.h': 'inline int add(int a, int b) {\n  return a + b;\n}\n',
      'test/add_test.cc': '#include <gtest/gtest.h>\n#include "../src/add.h"\n\n#define CHECK_SUM(actual, expected) \\\n  EXPECT_EQ(actual, expected)\n\nTEST(Add, Sums) {\n  CHECK_SUM(add(1, 2), 3);\n}\n',
    });
    const systemOne = scripted({ methods: { add: { matters: 0.9, kill: 0.9 } }, tests: { 'Add.Sums': {} } });
    await run(repo, systemOne);
    const { state } = systemOne.calls.find(call => call.state.method?.name === 'add');
    // The assertion is inside the macro, which no call graph reaches: without it the test reads as asserting nothing. It is
    // shown after the test, as part of the test's node in the graph.
    expect(state.graph.nodes.map(node => [node.id, node.note])).toEqual([['test/add_test.cc::Add.Sums', 'test 1'], ['test/add_test.cc::CHECK_SUM', 'a macro the test uses, which may hold its assertions']]);
    expect(state.graph.nodes[1]).toMatchObject({ path: 'test/add_test.cc', source: '#define CHECK_SUM(actual, expected) \\\n  EXPECT_EQ(actual, expected)' });
  });

  it('calls a test empty only above the floor', async () => {
    // checks out is scripted to miss both mutants of total at 0.95: the chance it misses both is 0.9. At 0.3 each it is 0.49, under the floor.
    const missing = { kills: { 'cart > adds prices': { boundary: 0.1, condition: 0.95 }, 'cart > rejects a negative price': { boundary: 0.9, condition: 0.9 }, 'cart > checks out': 0.3 } };
    const under = await run(await repository(), scripted({ methods: { total: { ...METHODS.total, ...missing } } }));
    const checks = under.tests.find(test => test.id === 'test/cart.test.ts::cart > checks out');
    expect(under.findings.filter(finding => finding.unit === checks.id).map(finding => finding.kind)).toEqual([]);
    expect(checks.useful).toBe(true);
    const over = await run(await repository(), scripted());
    expect(over.findings.filter(finding => finding.unit === checks.id).map(finding => finding.kind)).toEqual(['checks_nothing']);
    expect(over.tests.find(test => test.id === checks.id).useful).toBe(false);
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
    expect(discount.mutants.slice(0, 2).map(mutant => [mutant.line, mutant.original.trim()])).toEqual([[8, 'if percent < 0:'], [10, 'if percent > 100:']]);
    expect(second.findings.filter(finding => finding.kind === 'survived').map(finding => finding.line)).toEqual([8, 10]);
  });

  it('records units it could not ask about', async () => {
    const repo = await repository();
    const report = await run(repo, scripted({ fail: new Set(['cart > rejects a negative price', 'total']) }));
    // The test is never asked, having no live service in reach, so only the method fails: once per mutant.
    expect(report.failed.map(unit => [unit.subject, unit.unit])).toEqual([
      ['method', 'src/cart.ts::total'],
      ['method', 'src/cart.ts::total'],
    ]);
    expect(report.failed[0].error).toBe('scripted failure for total');
    const rejects = report.tests.find(test => test.id === 'test/cart.test.ts::cart > rejects a negative price');
    // With total's mutants unasked, nothing says whether it kills anything, so it is kept.
    expect(rejects).toMatchObject({ infra: null, useful: true, asked: 0 });
    const total = report.methods.find(method => method.id === 'src/cart.ts::total');
    expect(total).toMatchObject({ killed: 0, mutants: [] });
    expect(total.useful).toEqual(['test/cart.test.ts::cart > adds prices', 'test/cart.test.ts::cart > rejects a negative price', 'test/cart.test.ts::cart > checks out']);
    // Both of total's mutants failed, once each; the failures are listed by the method.
    expect(report.failed.filter(unit => unit.unit === 'src/cart.ts::total')).toHaveLength(2);
    expect(report.totals).toMatchObject({ useful: 9, mutants: 8 });
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
    // Four mutants of restock once a test reaches it; its boundary survives that test.
    expect(methods.get('cart.py::restock')).toMatchObject({ before: { reached: false, mutants: 0, killed: 0 }, after: { reached: true, mutants: 4, killed: 3 } });
    expect(methods.get('pricing.py::tax')).toMatchObject({ before: null, after: { reached: false, mutants: 0 } });
    expect(methods.has('cart.py::apply_discount')).toBe(false);
    expect(diff.findings.fixed).toEqual([]);
    expect(diff.findings.new.map(finding => `${finding.kind} ${finding.unit}`)).toEqual(['survived cart.py::restock']);
    expect(diff.totals.score).toEqual({ before: 0.8, after: 11 / 14 });
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
    expect(stub).toMatchObject({ useful: true, asked: 0, kills: [] });
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

describe('perch coverage from the command line', () => {
  it('asks, prints, and writes the page', async () => {
    const repo = await repository();
    const endpoint = await answeringEndpoint();
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(repo.root);
      const out = [], err = [];
      const io = { stdout: text => out.push(text), stderr: text => err.push(text), env: { PERCH_BASE_URL: endpoint.url, PERCH_API_KEY: 'local', HOME: repo.root } };
      const code = await main(['coverage', '--html', 'out/index.html'], io);
      expect(err.join('\n')).not.toContain('perch:');
      expect(code).toBe(3);
      // The source table's rows, before the problem blocks below it name the same files as headings.
      const table = out.join('\n').split('\n\n')[0].split('\n').map(line => line.trim().split(/\s{2,}/));
      const rows = Object.fromEntries(table.map(([path, ...cells]) => [path, cells]));
      // The endpoint answers 0.9 to every yes-or-no, so both mutants of total are killed; save has no line to change.
      expect(rows['src/cart.ts']).toEqual(['2 of 2', '100% (2 of 2)', '0']);
      expect(rows['src/db.ts']).toEqual(['1 of 1', '-', '0']);
      const page = await readFile(join(repo.root, 'out', 'index.html'), 'utf8');
      expect(page).toMatch(/^<!doctype html>/);
      expect(page).toContain('Run details');
    } finally {
      vi.restoreAllMocks();
      await endpoint.close();
    }
  });
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
    // The changed code's problems: total's two mutants are killed, so there are none on it; item_count and checkout have no mutants.
    const onBranch = report.findings.filter(finding => report.branch.findings.includes(finding.id)).map(finding => `${finding.kind} ${finding.unit}`).sort();
    expect(onBranch).toEqual([]);
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
  // Two tests for each of 20,000 methods, asked about the same three mutants, killing the same two: the second repeats the first.
  for (let index = 0; index < 20000; index++) {
    const ids = [0, 1].map(copy => `test/t${index}.test.js::t${copy}`);
    for (const [copy, id] of ids.entries()) tests.push({ id, node: { path: `test/t${index}.test.js`, line: copy + 1 } });
    mutants.set(`src/m${index}.js::m`, [0, 1, 2].map(at => ({ mutant: { line: at + 1, column: 0, from: '<', to: '<=' }, matters: 0.9, kills: ids.map(id => [id, at < 2 ? 0.9 : 0.1]) })));
  }
  const started = performance.now();
  const { redundantWith, pairProbability, useful, checksNothing } = judgeTests(tests, mutants, 0.5);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(useful.size).toBe(20000);
  expect(checksNothing.size).toBe(0);
  expect(redundantWith.get('test/t3.test.js::t1')).toBe('test/t3.test.js::t0');
  expect(pairProbability.get('test/t3.test.js::t1')).toBe(0.9);
});
