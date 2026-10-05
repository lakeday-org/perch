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
 * What each test answers, by the name the state gives it: whether it calls a live service, and what it costs. Written here, not
 * derived from anything perch computes.
 */
const TESTS = {
  test_discount_10: {}, test_discount_20: {}, test_discount_negative: {}, test_count_mocked: {},
  test_rate: { infra: 0.9, cost: 3 }, test_rate_mocked: {},
  'cart > adds prices': {}, 'cart > rejects a negative price': {}, 'cart > checks out': {},
  'saves an order': { infra: 0.1, cost: 2 }, test_restock: {},
};
/** What a test answers to the yes-or-no questions when its script does not say. */
const NOUL_DEFAULTS = { infra: 0.05 };
/**
 * What each method answers about each planted bug: whether it matters, and per test reaching it, how likely that test is to
 * fail with it in, by the bug's kind. Chosen by hand against the fixture's methods. apply_discount: its two boundaries (`<`
 * to `<=`, `>` to `>=`) escape every test, since none passes 0 or 100; the negated conditions and the arithmetic are caught
 * by the two discount tests, and the negative test, which raises before the arithmetic, catches only the conditions.
 * total: the negative-price test catches both, the plain one only the negated condition, and checkout's test catches neither.
 */
const METHODS = {
  apply_discount: { matters: 0.9, catches: {
    test_discount_10: { boundary: 0.1, condition: 0.95, arithmetic: 0.9 },
    test_discount_20: { boundary: 0.1, condition: 0.95, arithmetic: 0.9 },
    test_discount_negative: { boundary: 0.1, condition: 0.9, arithmetic: 0.05 },
  } },
  total: { matters: 0.85, catches: { 'cart > adds prices': { boundary: 0.1, condition: 0.95 }, 'cart > rejects a negative price': { boundary: 0.9, condition: 0.9 }, 'cart > checks out': { boundary: 0.05, condition: 0.05 } } },
  fetch_rate: { matters: 0.8, catches: { test_rate: 0.9, test_rate_mocked: 0.9 } },
  restock: { matters: 0.9, catches: { test_restock: { boundary: 0.1, condition: 0.9, boolean: 0.9 } } },
};

/**
 * A scripted System One standing in for the model. It answers each question in the shape the real one does, from the test's or
 * the method's name in the state, and throws for any name in `fail`. `tests` and `methods` replace the scripts above by name.
 */
function scripted({ fail = new Set(), error = name => new Error(`scripted failure for ${name}`), tests = {}, methods = {}, needs = {} } = {}) {
  const calls = [];
  const score = (question, given) => {
    const probabilities = Object.fromEntries(question.criteria.map((_, level) => [String(level), given[level] ?? 0]));
    return { type: 'score', probabilities, confidence: 0.8, score: Object.entries(probabilities).reduce((total, [level, p]) => total + Number(level) * p, 0) };
  };
  const tier = level => Object.fromEntries([0, 1, 2, 3].map(index => [index, index === level ? 0.85 : 0.05]));
  const noul = p => ({ type: 'noul', noul: p });
  return {
    id: 'scripted-jev', limits: TOKEN_LIMITS, calls,
    async ask(state, questions) {
      const name = state.test?.name ?? state.method?.name;
      calls.push({ name, state, questions });
      if (fail.has(name)) throw error(name);
      // Asked only of a method no test runs: whether it needs a test. Unscripted, it does.
      if (questions.needs_test) return { model: 'scripted-jev', answers: { needs_test: noul(needs[name] ?? 0.9) }, usage: { input_tokens: 100, output_tokens: 0 } };
      const script = state.test ? tests[name] ?? TESTS[name] : methods[name] ?? METHODS[name];
      if (!script) throw new Error(`no script for ${name}`);
      const answers = {};
      // The tests a planted bug is asked over are the graph's nodes noted test 1, test 2 and so on, in that order.
      const shown = (state.graph?.nodes ?? []).filter(node => /^test \d+$/.test(node.note ?? '')).map(node => node.id.split('::').at(-1));
      for (const [id, question] of Object.entries(questions)) {
        if (id in NOUL_DEFAULTS) answers[id] = noul(script[id] ?? NOUL_DEFAULTS[id]);
        else if (id === 'cost') answers[id] = score(question, tier(script.cost ?? 0));
        else if (id === 'matters') answers[id] = noul(script.matters ?? 0.9);
        else if (id.startsWith('catches_')) {
          const given = script.catches?.[shown[Number(id.slice('catches_'.length)) - 1]];
          answers[id] = noul(typeof given === 'number' ? given : given?.[state.method.mutation.kind] ?? script.catch ?? 0.9);
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
    // Ten tests asked what they cost, three of the reached methods asked about each planted bug (apply_discount has seven, total
    // two, fetch_rate one; item_count, round_money, checkout and save have no line the table can change), and restock, which
    // no test reaches, asked only whether it needs a test.
    const asked = systemOne.calls.map(call => call.name);
    expect(asked.filter(name => name in TESTS).sort()).toEqual(Object.keys(TESTS).filter(name => name !== 'test_restock').sort());
    expect(asked.filter(name => name === 'apply_discount')).toHaveLength(7);
    expect(asked.filter(name => name === 'total')).toHaveLength(2);
    expect(asked.filter(name => name === 'fetch_rate')).toHaveLength(1);
    expect(Object.keys(systemOne.calls.find(call => call.name === 'restock').questions)).toEqual(['needs_test']);
    // One request per planted bug: the method as written, the one line changed, and a yes-or-no per test reaching it.
    const boundary = systemOne.calls.find(call => call.name === 'apply_discount' && call.state.method.mutation.kind === 'boundary');
    expect(boundary.state.method.mutation).toEqual({ kind: 'boundary', original: 'if percent < 0:', mutated: 'if percent <= 0:' });
    expect(boundary.state.method.source).toContain('if percent < 0:');
    expect(boundary.state.graph.nodes.map(node => [node.id, node.note])).toEqual([
      ['tests/test_cart.py::test_discount_10', 'test 1'], ['tests/test_cart.py::test_discount_20', 'test 2'], ['tests/test_cart.py::test_discount_negative', 'test 3']]);
    expect(Object.keys(boundary.questions)).toEqual(['matters', 'catches_1', 'catches_2', 'catches_3']);
    expect(boundary.questions.catches_2.instructions).toMatch(/^This question is about test 2, `tests\/test_cart.py::test_discount_20`\./);

    const tests = byId(report.tests);
    const twenty = tests.get('tests/test_cart.py::test_discount_20');
    // Catches exactly the bugs test_discount_10 catches: one test written twice.
    expect(twenty).toMatchObject({ useful: false, redundant_with: 'tests/test_cart.py::test_discount_10', asked: 7 });
    expect(twenty.kills).toHaveLength(5);
    expect(tests.get('tests/test_cart.py::test_discount_10').useful).toBe(true);
    // Catches the two negated conditions and not the arithmetic: a different test.
    expect(tests.get('tests/test_cart.py::test_discount_negative')).toMatchObject({ useful: true, redundant_with: null });
    expect(tests.get('tests/test_cart.py::test_discount_negative').kills).toHaveLength(2);
    // Catches neither bug planted in total: it checks nothing.
    expect(tests.get('test/cart.test.ts::cart > checks out')).toMatchObject({ useful: false, asked: 2, kills: [] });
    // Reaches only item_count, which has no line to change: nothing to judge it by.
    expect(tests.get('tests/test_cart.py::test_count_mocked')).toMatchObject({ useful: true, asked: 0 });
    expect(tests.get('tests/test_cart.py::test_rate').cost.tier).toBe(3);
    expect(tests.get('test/cart.test.ts::cart > adds prices').name).toBe('adds prices');
    expect(tests.get('test/cart.test.ts::cart > adds prices').suite).toEqual(['cart']);

    const findings = byId(report.findings);
    expect(kinds(report)).toEqual([
      'checks_nothing test/cart.test.ts::cart > checks out',
      'infra tests/test_cart.py::test_rate',
      'redundant tests/test_cart.py::test_discount_20',
      'uncaught cart.py::apply_discount',
      'uncaught cart.py::apply_discount',
      'untested cart.py::restock',
    ]);
    const find = (kind, unit) => report.findings.filter(finding => finding.kind === kind && finding.unit === unit);
    // As likely as test_discount_10 is to catch the bug it is least sure of among those test_discount_20 catches.
    expect(find('redundant', 'tests/test_cart.py::test_discount_20')[0]).toMatchObject({ probability: 0.9, note: 'Catches the same planted bugs as test_discount_10 at line 9, and no others.' });
    // The chance it misses both: 0.95 twice.
    expect(find('checks_nothing', 'test/cart.test.ts::cart > checks out')[0]).toMatchObject({ probability: 0.95 * 0.95, note: 'Passes with every one of the 2 bugs planted in the code it reaches.' });
    // That no test reaches restock is the call graph's; how much that matters is the answer's.
    expect(find('untested', 'cart.py::restock')[0].probability).toBe(0.9);
    // The two boundaries: each escapes all three tests at 0.9, and matters at 0.9.
    const uncaught = find('uncaught', 'cart.py::apply_discount');
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
    expect('infra' in systemOne.calls.find(call => call.name === 'saves an order').questions).toBe(false);
    expect(find('infra', 'test/db.test.ts::saves an order')).toEqual([]);
    expect(twenty.findings.map(id => findings.get(id).kind)).toEqual(['redundant']);

    const methods = byId(report.methods);
    const discount = methods.get('cart.py::apply_discount');
    expect(discount).toMatchObject({ planted: 7, caught: 5, useful: ['tests/test_cart.py::test_discount_10', 'tests/test_cart.py::test_discount_negative'] });
    expect(discount.bugs.map(bug => [bug.kind, bug.line, bug.caught, bug.caught_by.length])).toEqual([
      ['boundary', 5, false, 0], ['boundary', 7, false, 0], ['condition', 5, true, 3], ['condition', 7, true, 3],
      ['arithmetic', 9, true, 2], ['arithmetic', 9, true, 2], ['arithmetic', 9, true, 2]]);
    expect(discount.bugs[0]).toMatchObject({ id: '5:15:<><=', from: '<', to: '<=', original: '    if percent < 0:', mutated: '    if percent <= 0:', asked: discount.tests.map(item => item.id) });
    expect(discount.bugs[0].survives).toBeCloseTo(0.9 ** 3);
    // The negative-price test catches both bugs in total, so both are caught, by it.
    expect(methods.get('src/cart.ts::total')).toMatchObject({ planted: 2, caught: 2 });
    expect(methods.get('src/cart.ts::total').bugs.map(bug => bug.caught_by)).toEqual([['test/cart.test.ts::cart > rejects a negative price'], ['test/cart.test.ts::cart > adds prices', 'test/cart.test.ts::cart > rejects a negative price']]);
    expect(methods.get('rates.py::fetch_rate')).toMatchObject({ planted: 1, caught: 1 });
    expect(methods.get('cart.py::item_count')).toMatchObject({ planted: 0, caught: 0, bugs: [], tests: [{ id: 'tests/test_cart.py::test_count_mocked', depth: 1 }] });
    expect(methods.get('cart.py::restock')).toMatchObject({ planted: 0, untested: true });

    expect(report.totals).toMatchObject({ methods: 8, reached: 7, useful_reached: 6, planted: 10, caught: 8, score: 0.8, uncaught: 2, tests: 10, useful: 8, redundant: 1, weak: 1, infra: 1,
      untested: 1, cost: { 0: 8, 1: 0, 2: 1, 3: 1 }, drop: { count: 2, cost: { 0: 2, 1: 0, 2: 0, 3: 0 } } });
    // checks out is the only test reaching checkout, and it is dropped for checking nothing.
    expect(report.totals.drop.unreached).toEqual(['src/cart.ts::checkout']);
    const cartFile = report.files.find(file => file.path === 'cart.py');
    expect(cartFile.kind).toBe('source');
    expect(cartFile.totals).toMatchObject({ methods: 3, reached: 2, useful_reached: 2, planted: 7, caught: 5, uncaught: 2 });
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
    // Ten tests, ten planted bugs, and restock asked whether it needs a test.
    expect(systemOne.calls).toHaveLength(21);
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
    const systemOne = scripted({ methods: { add: { matters: 0.9, catch: 0.9 } }, tests: { 'Add.Sums': {} } });
    await run(repo, systemOne);
    const { state } = systemOne.calls.find(call => call.state.method?.name === 'add');
    // The assertion is inside the macro, which no call graph reaches: without it the test reads as asserting nothing. It is
    // shown after the test, as part of the test's node in the graph.
    expect(state.graph.nodes.map(node => [node.id, node.note])).toEqual([['test/add_test.cc::Add.Sums', 'test 1'], ['test/add_test.cc::CHECK_SUM', 'a macro the test uses, which may hold its assertions']]);
    expect(state.graph.nodes[1]).toMatchObject({ path: 'test/add_test.cc', source: '#define CHECK_SUM(actual, expected) \\\n  EXPECT_EQ(actual, expected)' });
  });

  it('calls a test empty only above the floor', async () => {
    // checks out is scripted to miss both bugs in total at 0.95: the chance it misses both is 0.9. At 0.3 each it is 0.49, under the floor.
    const missing = { catches: { 'cart > adds prices': { boundary: 0.1, condition: 0.95 }, 'cart > rejects a negative price': { boundary: 0.9, condition: 0.9 }, 'cart > checks out': 0.3 } };
    const under = await run(await repository(), scripted({ methods: { total: { ...METHODS.total, ...missing } } }));
    const checks = under.tests.find(test => test.id === 'test/cart.test.ts::cart > checks out');
    expect(under.findings.filter(finding => finding.unit === checks.id).map(finding => finding.kind)).toEqual([]);
    expect(checks.useful).toBe(true);
    const over = await run(await repository(), scripted());
    expect(over.findings.filter(finding => finding.unit === checks.id).map(finding => finding.kind)).toEqual(['checks_nothing']);
    expect(over.tests.find(test => test.id === checks.id).useful).toBe(false);
  });

  it('keeps an uncaught bug on its own line when code above the method moves it down', async () => {
    const repo = await repository();
    await run(repo, scripted());
    // Three lines above every method in cart.py: each one's text and its neighbours' are what they were, only the lines move.
    await writeFile(join(repo.root, 'cart.py'), FILES['cart.py'].replace('import pricing\n', 'import pricing\n\n# Prices are in cents.\nCURRENCY = "USD"\n'));
    await commitAll(repo.root, 'a constant above the methods');
    const second = await run({ ...repo, revision: await revision(repo.root) }, scripted());
    // The planted bugs still point at their own lines, which moved with them, and their problems keep their ids.
    const discount = second.methods.find(method => method.id === 'cart.py::apply_discount');
    expect(discount.bugs.slice(0, 2).map(bug => [bug.line, bug.original.trim()])).toEqual([[8, 'if percent < 0:'], [10, 'if percent > 100:']]);
    expect(second.findings.filter(finding => finding.kind === 'uncaught').map(finding => finding.line)).toEqual([8, 10]);
  });

  it('records units it could not ask about', async () => {
    const repo = await repository();
    const report = await run(repo, scripted({ fail: new Set(['cart > rejects a negative price', 'total']) }));
    expect(report.failed.map(unit => [unit.subject, unit.unit])).toEqual([
      ['test', 'test/cart.test.ts::cart > rejects a negative price'],
      ['method', 'src/cart.ts::total'],
      ['method', 'src/cart.ts::total'],
    ]);
    expect(report.failed[0].error).toBe('scripted failure for cart > rejects a negative price');
    const rejects = report.tests.find(test => test.id === 'test/cart.test.ts::cart > rejects a negative price');
    // Not asked what it costs; and with total's bugs unasked, nothing says whether it catches anything, so it is kept.
    expect(rejects).toMatchObject({ infra: null, cost: null, useful: true, asked: 0 });
    const total = report.methods.find(method => method.id === 'src/cart.ts::total');
    expect(total).toMatchObject({ planted: 0, caught: 0, bugs: [] });
    expect(total.useful).toEqual(['test/cart.test.ts::cart > adds prices', 'test/cart.test.ts::cart > rejects a negative price', 'test/cart.test.ts::cart > checks out']);
    // Both of total's bugs failed, once each; the failures are listed by the method.
    expect(report.failed.filter(unit => unit.unit === 'src/cart.ts::total')).toHaveLength(2);
    expect(report.totals).toMatchObject({ useful: 9, planted: 8 });
  });

  it('stops on rejected credentials', async () => {
    const repo = await repository();
    const refused = scripted({ fail: new Set(['test_discount_10']), error: () => new AuthenticationError(401, 'bad key') });
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
    // Four bugs planted in restock once a test reaches it; its boundary escapes that test.
    expect(methods.get('cart.py::restock')).toMatchObject({ before: { reached: false, planted: 0, caught: 0 }, after: { reached: true, planted: 4, caught: 3 } });
    expect(methods.get('pricing.py::tax')).toMatchObject({ before: null, after: { reached: false, planted: 0 } });
    expect(methods.has('cart.py::apply_discount')).toBe(false);
    expect(diff.findings.fixed.map(finding => `${finding.kind} ${finding.unit}`)).toEqual(['untested cart.py::restock']);
    expect(diff.findings.new.map(finding => `${finding.kind} ${finding.unit}`).sort()).toEqual(['uncaught cart.py::restock', 'untested pricing.py::tax']);
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
    TESTS['charges the stubbed amount'] = { cost: 0 };
    const systemOne = scripted();
    const report = await run(repo, systemOne);
    delete TESTS['charges the stubbed amount'];
    expect(systemOne.calls.map(call => call.name)).toContain('charges the stubbed amount');
    expect(report.failed).toEqual([]);
    const stub = report.tests.find(test => test.name === 'charges the stubbed amount');
    expect(stub.direct).toEqual([]);
    // A chained call such as expect(...).toBe is recorded as dynamic and named by nothing, and it() belongs to the file.
    expect(stub.unresolved).toEqual(['charge', 'expect', 'vi.fn']);
    // Reaching no method, no planted bug is asked over it, so nothing says it checks nothing: it is kept, and asked only its cost.
    expect(stub).toMatchObject({ useful: true, asked: 0, kills: [] });
    expect(report.findings.filter(finding => finding.unit === stub.id)).toEqual([]);
    expect(Object.keys(systemOne.calls.find(call => call.name === 'charges the stubbed amount').questions)).toEqual(['cost']);
  });
});

/**
 * What CI's test run wrote, by hand, in each format's documented shape: pytest's and Vitest's JUnit XML, Vitest's LCOV,
 * coverage.py's JSON with test contexts, and a Cobertura XML. The numbers are chosen here, line by line, against the sources in
 * FILES: cart.py's apply_discount is lines 4-9, item_count 12-13 and restock 16-20; src/cart.ts's total is 3-10 and checkout
 * 12-16; src/db.ts's save is 3-5.
 */
const REPORTS = {
  'reports/junit.xml': `<?xml version="1.0" encoding="utf-8"?>
<testsuites name="all">
  <testsuite name="pytest" tests="7" failures="2" skipped="1">
    <testcase classname="tests.test_cart" name="test_discount_10" time="0.25"/>
    <testcase classname="tests.test_cart" name="test_discount_20" time="0.5"/>
    <testcase classname="tests.test_cart" name="test_discount_negative[-1]" time="0.125"/>
    <testcase classname="tests.test_cart" name="test_discount_negative[-5]" time="0.125"><failure message="DID NOT RAISE">assert False</failure></testcase>
    <testcase classname="tests.test_cart" name="test_count_mocked" time="0.0625"/>
    <testcase classname="tests.test_cart" name="test_rate" time="2.0"><failure message="ConnectionError">no network</failure></testcase>
    <testcase classname="tests.test_cart" name="test_removed_last_week" time="0.5"><skipped message="gone"/></testcase>
  </testsuite>
  <testsuite name="test/cart.test.ts" tests="2">
    <testcase classname="test/cart.test.ts" name="cart &gt; adds prices" time="0.25"/>
    <testcase classname="test/cart.test.ts" name="cart &gt; rejects a negative price" time="0.125"/>
  </testsuite>
</testsuites>
`,
  'reports/lcov.info': `TN:
SF:src/cart.ts
BRDA:5,0,0,3
BRDA:5,0,1,2
BRDA:6,1,0,1
BRDA:6,1,1,0
BRF:4
BRH:3
DA:4,3
DA:5,3
DA:6,4
DA:7,3
DA:9,2
DA:13,0
DA:14,0
DA:15,0
LF:8
LH:5
end_of_record
TN:
SF:src/db.ts
DA:4,0
LF:1
LH:0
end_of_record
`,
  'reports/coverage.json': JSON.stringify({
    meta: { format: 3, version: '7.6.1', timestamp: '2026-09-28T10:00:00', branch_coverage: true, show_contexts: true },
    files: {
      'cart.py': {
        executed_lines: [1, 4, 5, 6, 7, 9, 12, 16, 17, 18, 20],
        missing_lines: [8, 13, 19],
        excluded_lines: [],
        executed_branches: [[5, 6], [5, 7], [7, 9], [17, 18], [17, 20], [18, 17]],
        missing_branches: [[7, 8], [18, 19]],
        contexts: {
          1: [''], 4: [''], 12: [''], 16: [''],
          5: ['tests/test_cart.py::test_discount_10|run', 'tests/test_cart.py::test_discount_20|run', 'tests/test_cart.py::test_discount_negative|run',
            'tests/test_cart.py::test_gone|run'],
          6: ['tests/test_cart.py::test_discount_negative|run'],
          7: ['tests/test_cart.py::test_discount_10|run', 'tests/test_cart.py::test_discount_20|run'],
          9: ['tests/test_cart.py::test_discount_10|setup', 'tests/test_cart.py::test_discount_10|run', 'tests/test_cart.py::test_discount_20|run'],
          17: ['tests/test_cart.py::test_count_mocked|run'], 18: ['tests/test_cart.py::test_count_mocked|run'], 20: ['tests/test_cart.py::test_count_mocked|run'],
        },
      },
    },
  }, null, 2),
  'reports/cobertura.xml': `<?xml version="1.0" ?>
<coverage version="7.6.1" timestamp="1790000000000" lines-valid="6" lines-covered="5" line-rate="0.8333" branches-covered="0" branches-valid="0" branch-rate="0" complexity="0">
  <sources><source>.</source></sources>
  <packages>
    <package name="." line-rate="0.8333" branch-rate="0" complexity="0">
      <classes>
        <class name="pricing.py" filename="pricing.py" complexity="0" line-rate="1" branch-rate="0">
          <methods/>
          <lines><line number="1" hits="1"/><line number="2" hits="2"/></lines>
        </class>
        <class name="rates.py" filename="rates.py" complexity="0" line-rate="1" branch-rate="0">
          <methods/>
          <lines><line number="1" hits="1"/><line number="4" hits="1"/><line number="5" hits="1"/></lines>
        </class>
        <class name="cart.py" filename="cart.py" complexity="0" line-rate="1" branch-rate="0">
          <methods/>
          <lines><line number="13" hits="5"/></lines>
        </class>
        <class name="gen.py" filename="build/gen.py" complexity="0" line-rate="0" branch-rate="0">
          <methods/>
          <lines><line number="1" hits="0"/></lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
`,
};
const ALL_REPORTS = { junit: ['reports/junit.xml'], lcov: ['reports/lcov.info'], cobertura: ['reports/cobertura.xml'], contexts: ['reports/coverage.json'] };
/** Answers for the run with reports: the same as without, and save, which only writes what it is given to a file, is said not to need a test of its own. */
const MEASURED_TESTS = {};
const MEASURED_NEEDS = { save: 0.2 };
const MEASURED_METHODS = {};

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
  it('reads the reports named by flags, asks, prints, and writes the page', async () => {
    const repo = await repository();
    await write(repo.root, REPORTS);
    const endpoint = await answeringEndpoint();
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(repo.root);
      const out = [], err = [];
      const io = { stdout: text => out.push(text), stderr: text => err.push(text), env: { PERCH_BASE_URL: endpoint.url, PERCH_API_KEY: 'local', HOME: repo.root } };
      // A brace in a path is a glob's, so the comma inside it does not split the list.
      const code = await main(['coverage', '--junit', 'reports/junit.xml', '--lcov', 'reports/{lcov,missing}.info,reports/lcov.info', '--html', 'out/index.html'], io);
      expect(err.join('\n')).not.toContain('perch:');
      expect(code).toBe(3);
      // Read off reports/lcov.info by hand: src/cart.ts has 8 DA lines, 5 of them hit, and 4 BRDA arms, 3 of them taken; checkout's
      // lines 13-15 never ran, so one of its two methods is tested. src/db.ts's one line never ran.
      // The source table's rows, before the problem blocks below it name the same files as headings.
      const table = out.join('\n').split('\n\n')[0].split('\n').map(line => line.trim().split(/\s{2,}/));
      const rows = Object.fromEntries(table.map(([path, ...cells]) => [path, cells]));
      // The endpoint answers 0.9 to every yes-or-no, so both bugs planted in total are caught; save has no line to change.
      expect(rows['src/cart.ts']).toEqual(['1 of 2', '63%', '100% (2 of 2)', '0']);
      expect(rows['src/db.ts']).toEqual(['0 of 1', '0%', '-', '0']);
      const page = await readFile(join(repo.root, 'out', 'index.html'), 'utf8');
      expect(page).toMatch(/^<!doctype html>/);
      expect(page).toContain('Run details');
    } finally {
      vi.restoreAllMocks();
      await endpoint.close();
    }
  });
});

describe('perch coverage with test reports', () => {
  const measuredRun = async (reportFlags = ALL_REPORTS, extra = {}) => {
    const repo = await repository();
    await write(repo.root, REPORTS);
    const systemOne = scripted({ tests: MEASURED_TESTS, methods: MEASURED_METHODS, needs: MEASURED_NEEDS });
    const report = await run(repo, systemOne, { reportFlags, cwd: repo.root, ...extra });
    return { repo, systemOne, report };
  };

  it('matches runs by framework names', async () => {
    const { report } = await measuredRun();
    const tests = byId(report.tests);
    expect(tests.get('tests/test_cart.py::test_discount_10').run).toEqual({ time: 0.25, status: 'passed', cases: 1 });
    // Two parametrized cases of one test: their times add up, and the test is as good as its worst case.
    expect(tests.get('tests/test_cart.py::test_discount_negative').run).toEqual({ time: 0.25, status: 'failed', cases: 2 });
    expect(tests.get('tests/test_cart.py::test_rate').run).toEqual({ time: 2, status: 'failed', cases: 1 });
    expect(tests.get('test/cart.test.ts::cart > adds prices').run).toEqual({ time: 0.25, status: 'passed', cases: 1 });
    expect(tests.get('tests/test_cart.py::test_rate_mocked').run).toBe(null);
    expect(tests.get('test/cart.test.ts::cart > checks out').run).toBe(null);
    expect(report.unmatched_runs).toEqual([
      { path: 'reports/junit.xml', classname: 'tests.test_cart', name: 'test_removed_last_week' },
      { path: 'reports/coverage.json', classname: 'tests/test_cart.py', name: 'test_gone' },
    ]);
    expect(report.unmatched_paths).toEqual([{ path: 'reports/cobertura.xml', reported: 'build/gen.py' }]);
    expect(report.inputs).toEqual([
      { kind: 'junit', path: 'reports/junit.xml', runs: 9 },
      { kind: 'lcov', path: 'reports/lcov.info', files: 2 },
      // cart.py is in coverage.json as well, and one run reported twice is read once: from coverage.json.
      { kind: 'cobertura', path: 'reports/cobertura.xml', files: 4, replaced_by: [{ path: 'cart.py', by: ['reports/coverage.json'] }] },
      { kind: 'contexts', path: 'reports/coverage.json', files: 1 },
    ]);
    expect(report.totals.suite).toEqual({ seconds: 3.9375, runs: 9, failed: 2, skipped: 1 });
  });

  it('measures lines and branches per method', async () => {
    const { report } = await measuredRun();
    const methods = byId(report.methods);
    expect(methods.get('cart.py::apply_discount')).toMatchObject({ measured: { lines: { hit: 4, total: 5 }, branches: { hit: 3, total: 4 } }, executed: true, untested: false });
    // Reached by test_count_mocked in the call graph, and not one of its lines ran.
    expect(methods.get('cart.py::item_count')).toMatchObject({ measured: { lines: { hit: 0, total: 1 }, branches: { hit: 0, total: 0 } }, executed: false, untested: true });
    expect(methods.get('cart.py::item_count').tests).toEqual([{ id: 'tests/test_cart.py::test_count_mocked', depth: 1 }]);
    // No test reaches restock in the call graph, and the report shows it ran.
    expect(methods.get('cart.py::restock')).toMatchObject({ tests: [], measured: { lines: { hit: 3, total: 4 }, branches: { hit: 3, total: 4 } }, executed: true, untested: false });
    expect(methods.get('pricing.py::round_money')).toMatchObject({ measured: { lines: { hit: 1, total: 1 }, branches: { hit: 0, total: 0 } } });
    expect(methods.get('src/cart.ts::total')).toMatchObject({ measured: { lines: { hit: 5, total: 5 }, branches: { hit: 3, total: 4 } } });
    expect(methods.get('src/cart.ts::checkout')).toMatchObject({ measured: { lines: { hit: 0, total: 3 } }, executed: false, untested: true });
    // Three methods never ran, and that stays their coverage whatever is asked. Whether each is a problem is the answer's: save is
    // said not to need a test, so it is not listed.
    const untested = report.findings.filter(finding => finding.kind === 'untested');
    expect(untested.map(finding => finding.unit).sort()).toEqual(['cart.py::item_count', 'src/cart.ts::checkout']);
    expect(untested.find(finding => finding.unit === 'cart.py::item_count')).toMatchObject({ probability: 0.9,
      note: 'None of its lines ran. 1 test calls it.' });
    expect(methods.get('src/db.ts::save')).toMatchObject({ untested: true, executed: false });
    expect(report.totals.untested).toBe(3);
    expect(report.totals.measured).toEqual({ lines: { hit: 14, total: 21 }, branches: { hit: 9, total: 12 } });
    expect(report.measured_by).toEqual(['cobertura', 'contexts', 'lcov']);
    const cartFile = report.files.find(file => file.path === 'cart.py');
    expect(cartFile.totals.measured).toEqual({ lines: { hit: 7, total: 10 }, branches: { hit: 6, total: 8 } });
    expect(cartFile.hits.lines).toEqual([[1, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 0], [9, 1], [12, 1], [13, 0], [16, 1], [17, 1], [18, 1], [19, 0], [20, 1]]);
    expect(cartFile.hits.branches).toEqual([[5, 2, 2], [7, 1, 2], [17, 2, 2], [18, 1, 2]]);
  });

  it('asks only what the reports leave open', async () => {
    const { systemOne, report } = await measuredRun();
    // The three that never ran are asked only whether they need a test, told how perch knows.
    const needCalls = systemOne.calls.filter(call => call.questions.needs_test);
    expect(needCalls.map(call => call.name).sort()).toEqual(['checkout', 'item_count', 'save']);
    for (const call of needCalls) expect(call.state.method.note).toBe('The coverage report shows none of its lines ran.');
    // A test the report timed is not asked what it costs, and one with no live service in reach is not asked about that: a
    // timed test with nothing else to ask is not asked at all.
    const testCalls = Object.fromEntries(systemOne.calls.filter(call => call.state.test).map(call => [call.name, Object.keys(call.questions).sort()]));
    expect(testCalls).toEqual({ test_rate: ['infra'], test_rate_mocked: ['cost'], 'cart > checks out': ['cost'], 'saves an order': ['cost'] });
    const tests = byId(report.tests);
    expect(tests.get('tests/test_cart.py::test_rate').cost).toEqual({ seconds: 2, basis: 'measured' });
    expect(tests.get('tests/test_cart.py::test_rate_mocked').cost).toMatchObject({ tier: 0, basis: 'estimated' });
    expect(tests.get('test/db.test.ts::saves an order').cost).toMatchObject({ tier: 2, basis: 'estimated' });
    // Only the three untimed tests have a tier.
    expect(report.totals.cost).toEqual({ 0: 2, 1: 0, 2: 1, 3: 0 });
  });

  it('compares measured totals with the last run', async () => {
    const { repo } = await measuredRun();
    await write(repo.root, { 'pricing.py': `${FILES['pricing.py']}\n# later\n` });
    await commitAll(repo.root, 'later');
    const after = await run({ ...repo, revision: await revision(repo.root) }, scripted({ tests: MEASURED_TESTS, methods: MEASURED_METHODS, needs: MEASURED_NEEDS }),
      { reportFlags: { junit: ['reports/junit.xml'], lcov: ['reports/lcov.info'] }, cwd: repo.root });
    // Before: 14 of 21 lines and 9 of 12 branches over all eight methods. After, LCOV alone: total, checkout and save.
    expect(after.diff.totals.measured_lines).toEqual({ before: 14 / 21, after: 5 / 9 });
    expect(after.diff.totals.measured_branches).toEqual({ before: 0.75, after: 0.75 });
    expect(after.diff.totals.suite_seconds).toEqual({ before: 3.9375, after: 3.9375 });
    const methods = byId(after.diff.methods);
    // Before, the report showed restock ran, which is reached whatever the call graph says; after, nothing measured it and no
    // test reaches it.
    expect(methods.get('cart.py::restock')).toMatchObject({ before: { reached: true, executed: true, measured: { lines: { hit: 3, total: 4 } } },
      after: { reached: false, executed: null, measured: null } });
    expect(methods.has('src/cart.ts::checkout')).toBe(false);
  });

  it('reports changed code with --since', async () => {
    const { repo } = await measuredRun();
    // On the branch: one line of total that ran and one of checkout that did not, item_count's return, which did not, a line of a
    // test, and a file that is not source. The coverage reports are the same run's, so their lines still line up.
    const edit = (text, from, to) => { expect(text).toContain(from); return text.replace(from, to); };
    await write(repo.root, {
      'src/cart.ts': edit(edit(FILES['src/cart.ts'], 'sum += price;', 'sum += price * 1;'), 'save(amount);', 'save(amount * 1);'),
      'cart.py': edit(FILES['cart.py'], 'return len(items)', 'return len(list(items))'),
      'test/db.test.ts': edit(FILES['test/db.test.ts'], 'expect(true).toBe(true);', 'expect(1).toBe(1);'),
      'NOTES.md': 'Not source.\n',
      // A script with no methods of its own, new on the branch, so no coverage report has it.
      'src/main.ts': "import { total } from './cart';\n\nconsole.log(total([1, 2]));\n",
    });
    await commitAll(repo.root, 'branch');
    const systemOne = scripted({ tests: MEASURED_TESTS, methods: MEASURED_METHODS, needs: MEASURED_NEEDS });
    const report = await run({ ...repo, revision: await revision(repo.root) }, systemOne, { reportFlags: ALL_REPORTS, cwd: repo.root, since: 'main' });
    // The run on main was saved, and it is not compared with: the branch point already says what the branch did.
    expect(report.baseline).toBe(null);
    expect(report.diff).toBe(null);
    expect(report.branch).toMatchObject({ ref: 'main', base: await revision(repo.root, 'main'), patch: { hit: 1, total: 3 } });
    expect(report.branch.files).toEqual([
      // Which changed lines of code did not run: item_count's return, and checkout's call to save.
      { path: 'cart.py', changed: 1, patch: { hit: 0, total: 1 }, missed: [13] },
      { path: 'src/cart.ts', changed: 2, patch: { hit: 1, total: 2 }, missed: [14] },
      { path: 'src/main.ts', changed: 3, patch: null },
    ]);
    expect(report.branch.units).toEqual(['cart.py::item_count', 'src/cart.ts::checkout', 'src/cart.ts::total', 'test/db.test.ts::saves an order']);
    const onBranch = report.findings.filter(finding => report.branch.findings.includes(finding.id)).map(finding => `${finding.kind} ${finding.unit}`).sort();
    expect(onBranch).toEqual([
      'untested cart.py::item_count',
      'untested src/cart.ts::checkout',
    ]);
    // The whole repository was still read and asked about: the branch's tests and what they reach are mostly elsewhere.
    expect(report.findings.some(finding => finding.unit === 'tests/test_cart.py::test_discount_20')).toBe(true);
  });

  it('fails fast on an unknown --since ref', async () => {
    const repo = await repository();
    const systemOne = scripted();
    await expect(run(repo, systemOne, { since: 'no-such-branch' })).rejects.toThrow(/no-such-branch/);
    expect(systemOne.calls).toEqual([]);
  });

  it('reads reports from perch.yaml, flags first', async () => {
    const repo = await repository({ ...FILES, 'perch.yaml': `coverage_reports:
  junit: [reports/junit.xml]
  lcov: [reports/lcov-from-last-month.info]
rules: []
` });
    await write(repo.root, REPORTS);
    const report = await run(repo, scripted({ tests: MEASURED_TESTS, methods: MEASURED_METHODS, needs: MEASURED_NEEDS }), { reportFlags: { lcov: ['reports/lcov.info'] }, cwd: repo.root });
    expect(report.inputs).toEqual([{ kind: 'junit', path: 'reports/junit.xml', runs: 9 }, { kind: 'lcov', path: 'reports/lcov.info', files: 2 }]);
    // Measured by LCOV alone, which covers the TypeScript; the Python is Jev's and the graph's, and says so.
    const methods = byId(report.methods);
    expect(methods.get('src/cart.ts::checkout')).toMatchObject({ executed: false, untested: true });
    expect(methods.get('cart.py::apply_discount')).toMatchObject({ measured: null, executed: null });
    expect(methods.get('cart.py::restock')).toMatchObject({ measured: null, untested: true });
  });

  it('fails fast on a missing report or unknown kind', async () => {
    const repo = await repository();
    await write(repo.root, REPORTS);
    const systemOne = scripted();
    await expect(run(repo, systemOne, { reportFlags: { junit: ['reports/junit.xml', 'reports/nope.xml'] }, cwd: repo.root }))
      .rejects.toThrow('reports/nope.xml: no such JUnit XML report');
    await write(repo.root, { 'perch.yaml': 'coverage_reports:\n  lcove: [coverage/lcov.info]\nrules: []\n' });
    await expect(run(repo, systemOne)).rejects.toThrow('perch.yaml: coverage_reports has lcove, which is not one of junit, lcov, cobertura, jacoco, contexts');
    expect(systemOne.calls).toEqual([]);
  });

  // One JUnit file per suite, as Surefire and Gradle write one per class, and a file beside them that is not a report.
  const SHARDS = {
    'reports/junit/TEST-pytest.xml': `<testsuite name="pytest" tests="2">
  <testcase classname="tests.test_cart" name="test_discount_10" time="0.25"/>
  <testcase classname="tests.test_cart" name="test_discount_20" time="0.5"/>
</testsuite>
`,
    'reports/junit/TEST-vitest.xml': `<testsuite name="test/cart.test.ts" tests="1">
  <testcase classname="test/cart.test.ts" name="cart &gt; adds prices" time="0.125"/>
</testsuite>
`,
    'reports/junit/summary.txt': 'not a report\n',
  };

  it('expands report globs in name order', async () => {
    const repo = await repository({ ...FILES, 'perch.yaml': 'coverage_reports:\n  junit: [reports/junit/*.xml]\nrules: []\n' });
    await write(repo.root, SHARDS);
    const shards = [{ kind: 'junit', path: 'reports/junit/TEST-pytest.xml', runs: 2 }, { kind: 'junit', path: 'reports/junit/TEST-vitest.xml', runs: 1 }];
    const configured = await run(repo, scripted());
    expect(configured.inputs).toEqual(shards);
    const tests = byId(configured.tests);
    expect(tests.get('tests/test_cart.py::test_discount_20').run).toEqual({ time: 0.5, status: 'passed', cases: 1 });
    expect(tests.get('test/cart.test.ts::cart > adds prices').run).toEqual({ time: 0.125, status: 'passed', cases: 1 });
    // A flag's comma splits paths, and one inside a {a,b} list is part of the pattern.
    const flagged = await run(repo, scripted(), { reportFlags: { junit: ['reports/junit/TEST-{vitest,pytest}.xml'] }, cwd: repo.root });
    expect(flagged.inputs).toEqual(shards);
  });

  it('fails fast on a glob that matches nothing', async () => {
    const repo = await repository();
    await write(repo.root, SHARDS);
    const systemOne = scripted();
    await expect(run(repo, systemOne, { reportFlags: { jacoco: ['build/jacoco/*.xml'] }, cwd: repo.root }))
      .rejects.toThrow('build/jacoco/*.xml: no JaCoCo XML report matches this pattern');
    await write(repo.root, { 'perch.yaml': 'coverage_reports:\n  lcov: [reports/junit/*.info]\nrules: []\n' });
    await expect(run(repo, systemOne)).rejects.toThrow('reports/junit/*.info: no LCOV report matches this pattern');
    expect(systemOne.calls).toEqual([]);
  });
});

describe('a JaCoCo report', () => {
  const source = lines => `${lines.join('\n')}\n`;
  // JaCoCo names a file by the package its classes are in and the source file's name, never by where it sits in the repository.
  // Pricing.java declares package shop from a directory called app; legacy/shop/Cart.java ends in shop/Cart.java and declares
  // legacy.shop; two files declare util and are called Strings.java.
  const JAVA = {
    'src/main/java/shop/Cart.java': source(['package shop;', '', 'public class Cart {', '    public static int total(int a) {', '        if (a > 100) {',
      '            return 100;', '        }', '        return a;', '    }', '}']),
    'app/Pricing.java': source(['package shop;', '', 'public class Pricing {', '    public static int price(int a) {', '        return Cart.total(a) * 2;', '    }', '}']),
    'legacy/shop/Cart.java': source(['package legacy.shop;', '', 'public class Cart {', '    public static int total(int a) {', '        return a;', '    }', '}']),
    'a/Strings.java': source(['package util;', '', 'public class Strings {', '    public static String trim(String s) {', '        return s.trim();', '    }', '}']),
    'b/Strings.java': source(['package util;', '', 'public class Strings {', '    public static String pad(String s) {', '        return s + " ";', '    }', '}']),
    'src/test/java/shop/CartTest.java': source(['package shop;', '', 'import org.junit.jupiter.api.Test;', '', 'class CartTest {', '    @Test',
      '    void capsTheTotal() {', '        Cart.total(500);', '    }', '}']),
  };
  // Written by hand in report.dtd's shape. Cart.total's lines 5-8: the if on line 5 took one of its two branches, and line 8 never
  // ran. Pricing.price's line 5 ran.
  const REPORT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">'
    + '<report name="shop"><sessioninfo id="ci" start="1727520000000" dump="1727520001000"/>'
    + '<package name="shop">'
    + '<sourcefile name="Cart.java"><line nr="3" mi="3" ci="0" mb="0" cb="0"/><line nr="5" mi="0" ci="3" mb="1" cb="1"/>'
    + '<line nr="6" mi="0" ci="2" mb="0" cb="0"/><line nr="8" mi="2" ci="0" mb="0" cb="0"/></sourcefile>'
    + '<sourcefile name="Pricing.java"><line nr="5" mi="0" ci="6" mb="0" cb="0"/></sourcefile>'
    + '<sourcefile name="Gone.java"><line nr="4" mi="2" ci="0" mb="0" cb="0"/></sourcefile></package>'
    + '<package name="util"><sourcefile name="Strings.java"><line nr="5" mi="0" ci="4" mb="0" cb="0"/></sourcefile></package>'
    + '</report>';

  it('places files by declared package', async () => {
    const repo = await repository(JAVA);
    await write(repo.root, { 'build/jacoco.xml': REPORT });
    const scan = await analyzeTree({ root: repo.root, revision: repo.revision, out: repo.out, analyzer });
    const reports = await readReports({ root: repo.root, files: [{ kind: 'jacoco', path: join(repo.root, 'build/jacoco.xml') }], paths: new Set(Object.keys(JAVA)) });
    const coverage = computeCoverage({ scan, graph: buildGraph(scan.files), reports });
    expect(coverage.measurement.inputs).toEqual([{ kind: 'jacoco', path: 'build/jacoco.xml', files: 4 }]);
    expect(coverage.measurement.tools).toEqual(['jacoco']);
    expect(coverage.measurement.unmatched_paths).toEqual([
      { path: 'build/jacoco.xml', reported: 'shop/Gone.java' },
      { path: 'build/jacoco.xml', reported: 'util/Strings.java' },
    ]);
    const methods = byId(coverage.methods);
    expect(methods.get('src/main/java/shop/Cart.java::Cart.total')).toMatchObject({ measured: { lines: { hit: 2, total: 3 }, branches: { hit: 1, total: 2 } } });
    expect(methods.get('app/Pricing.java::Pricing.price').measured).toEqual({ lines: { hit: 1, total: 1 }, branches: { hit: 0, total: 0 } });
    for (const id of ['legacy/shop/Cart.java::Cart.total', 'a/Strings.java::Strings.trim', 'b/Strings.java::Strings.pad']) expect(methods.get(id).measured, id).toBe(null);
  });
});

it('finds duplicate tests among 40,000 in about linear time', () => {
  const planted = new Map(), tests = [];
  // Two tests for each of 20,000 methods, asked about the same three planted bugs, catching the same two: the second repeats the first.
  for (let index = 0; index < 20000; index++) {
    const ids = [0, 1].map(copy => `test/t${index}.test.js::t${copy}`);
    for (const [copy, id] of ids.entries()) tests.push({ id, node: { path: `test/t${index}.test.js`, line: copy + 1 } });
    planted.set(`src/m${index}.js::m`, [0, 1, 2].map(at => ({ mutant: { line: at + 1, column: 0, from: '<', to: '<=' }, matters: 0.9, catches: ids.map(id => [id, at < 2 ? 0.9 : 0.1]) })));
  }
  const started = performance.now();
  const { redundantWith, pairProbability, useful, checksNothing } = judgeTests(tests, planted, 0.5);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(useful.size).toBe(20000);
  expect(checksNothing.size).toBe(0);
  expect(redundantWith.get('test/t3.test.js::t1')).toBe('test/t3.test.js::t0');
  expect(pairProbability.get('test/t3.test.js::t1')).toBe(0.9);
});
