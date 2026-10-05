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

/** What each test and method answers, by the name the state gives it. Written here, not derived from anything perch computes. */
const TESTS = {
  test_discount_10: { decides: ['happy_path', 0.9] },
  test_discount_20: { decides: ['happy_path', 0.8] },
  test_discount_negative: { decides: ['error_path', 0.85] },
  test_count_mocked: { decides: ['happy_path', 0.6], smell: ['asserts_mock', 0.8] },
  test_rate: { decides: ['happy_path', 0.7], infra: 0.9, cost: 3 },
  test_rate_mocked: { decides: ['invalid_input', 0.7] },
  'cart > adds prices': { decides: ['happy_path', 0.9] },
  'cart > rejects a negative price': { decides: ['error_path', 0.9] },
  'cart > checks out': { decides: ['happy_path', 0.75] },
  'saves an order': { decides: ['nothing', 0.7], infra: 0.1, cost: 2 },
  test_restock: { decides: ['happy_path', 0.8] },
};
/** What a test answers to the yes-or-no questions when its script does not say. */
const NOUL_DEFAULTS = { infra: 0.05, tests_nothing_here: 0.8, repeats: 0.8 };
const METHODS = {
  apply_discount: { exercised: { 2: 0.2, 3: 0.8 }, gap_line: ['line_4', 0.7], gap_kind: ['boundary', 0.6] },
  total: { exercised: { 4: 1 }, gap_line: ['none', 0.9], gap_kind: ['boundary', 0.4] },
  restock: { exercised: { 3: 1 }, gap_line: ['none', 0.8], gap_kind: ['boundary', 0.4] },
};

/**
 * A scripted System One standing in for the model. It answers each question in the shape the real one does, from the test's or
 * the method's name in the state, and throws for any name in `fail`. `tests` and `methods` replace the scripts above by name.
 */
function scripted({ fail = new Set(), error = name => new Error(`scripted failure for ${name}`), tests = {}, methods = {}, needs = {} } = {}) {
  const calls = [];
  const choice = (question, [pick, p]) => {
    const keys = Object.keys(question.criteria);
    if (!keys.includes(pick)) throw new Error(`${pick} is not offered: ${keys.join(', ')}`);
    return { type: 'choice', choice: pick, confidence: p, probabilities: Object.fromEntries(keys.map(key => [key, key === pick ? p : (1 - p) / (keys.length - 1)])) };
  };
  const score = (question, given) => {
    const probabilities = Object.fromEntries(question.criteria.map((_, level) => [String(level), given[level] ?? 0]));
    return { type: 'score', probabilities, confidence: 0.8, score: Object.entries(probabilities).reduce((total, [level, p]) => total + Number(level) * p, 0) };
  };
  const tier = level => Object.fromEntries([0, 1, 2, 3].map(index => [index, index === level ? 0.85 : 0.05]));
  return {
    id: 'scripted-jev', cacheKey: 'scripted-jev', limits: TOKEN_LIMITS, calls,
    async ask(state, questions) {
      const name = state.test?.name ?? state.method?.name;
      calls.push({ name, state, questions });
      if (fail.has(name)) throw error(name);
      // Asked only of a method no test runs: whether it needs a test. Unscripted, it does.
      if (questions.needs_test) return { model: 'scripted-jev', answers: { needs_test: { type: 'noul', noul: needs[name] ?? 0.9 } }, usage: { input_tokens: 100, output_tokens: 0 } };
      const script = state.test ? tests[name] ?? TESTS[name] : methods[name] ?? METHODS[name];
      if (!script) throw new Error(`no script for ${name}`);
      const answers = {};
      for (const [id, question] of Object.entries(questions)) {
        if (id === 'decides') answers[id] = choice(question, script.decides);
        else if (id === 'smell') answers[id] = choice(question, script.smell ?? ['none', 0.9]);
        else if (id in NOUL_DEFAULTS) answers[id] = { type: 'noul', noul: script[id] ?? NOUL_DEFAULTS[id] };
        else if (id === 'cost') answers[id] = score(question, tier(script.cost ?? 0));
        else if (id === 'exercised') answers[id] = score(question, script.exercised);
        else answers[id] = choice(question, script[id]);
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
    // Ten tests, the two methods with branches that a useful test reaches, and restock, which no test reaches, asked only whether
    // it needs a test.
    // test_discount_20 is asked a second time, beside test_discount_10, whether it checks a case that one does not.
    expect(systemOne.calls.map(call => call.name).sort()).toEqual([...Object.keys(TESTS).filter(name => name !== 'test_restock'), 'test_discount_20', 'apply_discount', 'total', 'restock'].sort());
    expect(systemOne.calls.find(call => call.questions.repeats)).toMatchObject({ name: 'test_discount_20', state: { graph: { nodes: [{ id: 'tests/test_cart.py::test_discount_10' }] } } });
    expect(Object.keys(systemOne.calls.find(call => call.name === 'restock').questions)).toEqual(['needs_test']);

    const tests = byId(report.tests);
    const twenty = tests.get('tests/test_cart.py::test_discount_20');
    expect(twenty.useful).toBe(false);
    expect(twenty.redundant_with).toBe('tests/test_cart.py::test_discount_10');
    expect(tests.get('tests/test_cart.py::test_discount_10').useful).toBe(true);
    // Same direct method, a different behavior decided: not the same test.
    expect(tests.get('tests/test_cart.py::test_discount_negative').redundant_with).toBe(null);
    expect(tests.get('tests/test_cart.py::test_discount_negative').useful).toBe(true);
    expect(tests.get('tests/test_cart.py::test_count_mocked').useful).toBe(false);
    expect(tests.get('test/db.test.ts::saves an order').useful).toBe(false);
    expect(tests.get('tests/test_cart.py::test_rate').cost.tier).toBe(3);
    expect(tests.get('test/cart.test.ts::cart > adds prices').name).toBe('adds prices');
    expect(tests.get('test/cart.test.ts::cart > adds prices').suite).toEqual(['cart']);

    const findings = byId(report.findings);
    expect(kinds(report)).toEqual([
      'asserts_mock tests/test_cart.py::test_count_mocked',
      'checks_nothing test/db.test.ts::saves an order',
      'edge_case cart.py::apply_discount',
      'infra tests/test_cart.py::test_rate',
      'redundant tests/test_cart.py::test_discount_20',
      'untested cart.py::restock',
    ]);
    const find = (kind, unit) => report.findings.find(finding => finding.kind === kind && finding.unit === unit);
    expect(find('redundant', 'tests/test_cart.py::test_discount_20').probability).toBe(0.8);
    expect(find('redundant', 'tests/test_cart.py::test_discount_20').note).toBe('Same checks and calls as test_discount_10 at line 9.');
    // The chance of some smell: the scripted answer gives asserts_mock 0.8 and splits 0.2 over the other seven options.
    expect(find('asserts_mock', 'tests/test_cart.py::test_count_mocked').probability).toBeCloseTo(1 - 0.2 / 7);
    // That no test reaches restock is the call graph's; how much that matters is the answer's.
    expect(find('untested', 'cart.py::restock').probability).toBe(0.9);
    expect(find('edge_case', 'cart.py::apply_discount')).toMatchObject({ line: 7, probability: 0.7 });
    expect(find('infra', 'tests/test_cart.py::test_rate').probability).toBe(0.9);
    // Said to decide nothing, at 0.7: no change to what it calls would make it fail.
    expect(find('checks_nothing', 'test/db.test.ts::saves an order')).toMatchObject({ probability: 0.7, note: 'Passes whatever the code it calls does.' });
    // The call graph finds save writing a file with nothing mocking it, and the answer says that is not a problem: the fact stays
    // on the test, and no problem is listed.
    expect(tests.get('test/db.test.ts::saves an order').touches).toEqual(['filesystem']);
    expect(find('infra', 'test/db.test.ts::saves an order')).toBe(undefined);
    expect(tests.get('tests/test_cart.py::test_discount_20').findings.map(id => findings.get(id).kind).sort()).toEqual(['redundant']);

    const methods = byId(report.methods);
    expect(methods.get('cart.py::apply_discount').exercised).toBeCloseTo(0.7);
    expect(methods.get('cart.py::apply_discount').gap).toEqual({ line: 7, text: 'if percent > 100:', kind: 'boundary', probability: 0.7 });
    expect(methods.get('cart.py::apply_discount').useful).toEqual(['tests/test_cart.py::test_discount_10', 'tests/test_cart.py::test_discount_negative']);
    expect(methods.get('src/cart.ts::total').exercised).toBe(1);
    expect(methods.get('src/cart.ts::total').gap).toBe(null);
    expect(methods.get('pricing.py::round_money').exercised).toBe(1);
    expect(methods.get('src/cart.ts::checkout').exercised).toBe(1);
    // Reached only by a smelly test, or only by one that decides nothing: reached, and none of it exercised.
    expect(methods.get('cart.py::item_count')).toMatchObject({ exercised: 0, useful: [] });
    expect(methods.get('cart.py::item_count').tests).toEqual([{ id: 'tests/test_cart.py::test_count_mocked', depth: 1 }]);
    expect(methods.get('src/db.ts::save').exercised).toBe(0);
    expect(methods.get('cart.py::restock').exercised).toBe(0);

    expect(report.totals).toMatchObject({ methods: 8, reached: 7, useful_reached: 5, tests: 10, useful: 7, redundant: 1, smelly: 2, infra: 1,
      untested: 1, edge_cases: 1, cost: { 0: 8, 1: 0, 2: 1, 3: 1 }, drop: { count: 3, cost: { 0: 2, 1: 0, 2: 1, 3: 0 } } });
    expect(report.totals.exercised).toBeCloseTo(4.7 / 8);
    // test_count_mocked is dropped for asserting its own value, and it is the only test that reaches item_count; saves an order,
    // dropped for checking nothing, is the only one that reaches save.
    expect(report.totals.drop.unreached).toEqual(['cart.py::item_count', 'src/db.ts::save']);
    const cartFile = report.files.find(file => file.path === 'cart.py');
    expect(cartFile.kind).toBe('source');
    expect(cartFile.totals).toMatchObject({ methods: 3, reached: 2, useful_reached: 1 });
    expect(cartFile.totals.exercised).toBeCloseTo(0.7 / 3);
    expect(cartFile.lines[4]).toBe('    if percent < 0:');
    expect(report.files.find(file => file.path === 'tests/test_cart.py').totals).toMatchObject({ tests: 6, useful: 4, redundant: 1, smelly: 1, infra: 1 });

    // Saved where the next run and the page read it.
    // A line of everything but the lists, then a line per item, so a report of any size is written and read a line at a time.
    const [header, ...items] = (await readFile(join(repo.out, 'coverage', 'latest.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(header).toMatchObject({ revision: report.revision, findings: [], methods: [] });
    expect(items.filter(([list]) => list === 'findings').map(([, finding]) => finding)).toEqual(report.findings);
    expect(items.filter(([list]) => list === 'methods')).toHaveLength(report.methods.length);
    expect(await readdir(join(repo.out, 'coverage', 'reports'))).toHaveLength(1);
    const rows = (await readFile(join(repo.out, 'coverage', 'answers.jsonl'), 'utf8')).trim().split('\n');
    // Ten tests, test_discount_20 asked whether it repeats test_discount_10, two methods asked about their branches, and restock
    // asked whether it needs a test.
    expect(rows).toHaveLength(14);
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

  it('calls a test empty only above the floor', async () => {
    // saves an order is scripted as deciding nothing at 0.7; at 0.45 it is under the floor.
    const under = await run(await repository(), scripted({ tests: { 'saves an order': { decides: ['nothing', 0.45], infra: 0.1, cost: 2 } } }));
    const saves = under.tests.find(test => test.id === 'test/db.test.ts::saves an order');
    expect(under.findings.filter(finding => finding.unit === saves.id).map(finding => finding.kind)).toEqual([]);
    expect(saves.useful).toBe(true);
    const over = await run(await repository(), scripted());
    expect(over.findings.filter(finding => finding.unit === saves.id).map(finding => finding.kind)).toEqual(['checks_nothing']);
    expect(over.tests.find(test => test.id === saves.id).useful).toBe(false);
  });

  it('reuses answers when nothing changed', async () => {
    const repo = await repository();
    const first = await run(repo, scripted());
    const again = scripted();
    const second = await run(repo, again);
    expect(again.calls).toEqual([]);
    expect(second.findings).toEqual(first.findings);
    expect(second.methods).toEqual(first.methods);
  });

  it('reuses answers when code above a method moves it down', async () => {
    const repo = await repository();
    await run(repo, scripted());
    // Three lines above every method in cart.py: each one's text and its neighbours' are what they were, only the lines move.
    await writeFile(join(repo.root, 'cart.py'), FILES['cart.py'].replace('import pricing\n', 'import pricing\n\n# Prices are in cents.\nCURRENCY = "USD"\n'));
    await commitAll(repo.root, 'a constant above the methods');
    const again = scripted();
    const second = await run({ ...repo, revision: await revision(repo.root) }, again);
    expect(again.calls).toEqual([]);
    // A gap still points at its own line, which moved with it.
    const discount = second.methods.find(method => method.id === 'cart.py::apply_discount');
    expect(discount.gap).toMatchObject({ line: 10, text: 'if percent > 100:' });
  });

  it('records units it could not ask about', async () => {
    const repo = await repository();
    const report = await run(repo, scripted({ fail: new Set(['cart > rejects a negative price', 'total']) }));
    expect(report.failed.map(unit => [unit.subject, unit.unit])).toEqual([
      ['test', 'test/cart.test.ts::cart > rejects a negative price'],
      ['method', 'src/cart.ts::total'],
    ]);
    expect(report.failed[0].error).toBe('scripted failure for cart > rejects a negative price');
    const rejects = report.tests.find(test => test.id === 'test/cart.test.ts::cart > rejects a negative price');
    expect(rejects).toMatchObject({ decides: null, smell: null, infra: null, cost: null, useful: false });
    const total = report.methods.find(method => method.id === 'src/cart.ts::total');
    expect(total.exercised).toBe(null);
    expect(total.useful).toEqual(['test/cart.test.ts::cart > adds prices', 'test/cart.test.ts::cart > checks out']);
    expect(report.totals.useful).toBe(6);
    expect(report.totals.exercised).toBeCloseTo(3.7 / 7);
    // Nothing was saved for either, so the next run asks both again and carries the rest.
    const retry = scripted();
    await run(repo, retry);
    expect(retry.calls.map(call => call.name).sort()).toEqual(['cart > rejects a negative price', 'total']);
  });

  it('stops on rejected credentials', async () => {
    const repo = await repository();
    const refused = scripted({ fail: new Set(['test_discount_10']), error: () => new AuthenticationError(401, 'bad key') });
    await expect(run(repo, refused)).rejects.toThrow(/HTTP 401/);
  });

  it('keeps a test the call graph pairs with another when it checks a case the other does not', async () => {
    const repo = await repository();
    const report = await run(repo, scripted({ tests: { test_discount_20: { ...TESTS.test_discount_20, repeats: 0.1 } } }));
    const twenty = byId(report.tests).get('tests/test_cart.py::test_discount_20');
    expect(twenty).toMatchObject({ useful: true, redundant_with: null });
    expect(kinds(report)).not.toContain('redundant tests/test_cart.py::test_discount_20');
  });

  it('keeps the answers a stopped run was given', async () => {
    const repo = await repository();
    const first = scripted();
    await run(repo, first);
    const units = first.calls.length;
    await rm(join(repo.out, 'coverage'), { recursive: true });
    // One at a time, so the units answered before the refusal are known: every test before the last one.
    const last = first.calls.filter(call => call.state.test).at(-1).name;
    const refused = scripted({ fail: new Set([last]), error: () => new AuthenticationError(401, 'bad key') });
    await expect(run(repo, refused, { parallel: 1 })).rejects.toThrow(/HTTP 401/);
    const retry = scripted();
    await run(repo, retry);
    expect(retry.calls.length).toBe(units - (refused.calls.length - 1));
    expect(retry.calls.map(call => call.name)).toContain(last);
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
    expect(methods.get('cart.py::restock')).toMatchObject({ before: { reached: false, exercised: 0 }, after: { reached: true, exercised: 0.75 } });
    expect(methods.get('pricing.py::tax')).toMatchObject({ before: null, after: { reached: false, exercised: 0 } });
    expect(methods.has('cart.py::apply_discount')).toBe(false);
    expect(diff.findings.fixed.map(finding => `${finding.kind} ${finding.unit}`)).toEqual(['untested cart.py::restock']);
    expect(diff.findings.new.map(finding => `${finding.kind} ${finding.unit}`)).toEqual(['untested pricing.py::tax']);
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
    TESTS['charges the stubbed amount'] = { decides: ['nothing', 0.8], smell: ['asserts_mock', 0.9] };
    const systemOne = scripted();
    const report = await run(repo, systemOne);
    delete TESTS['charges the stubbed amount'];
    expect(systemOne.calls.map(call => call.name)).toContain('charges the stubbed amount');
    expect(report.failed).toEqual([]);
    const stub = report.tests.find(test => test.name === 'charges the stubbed amount');
    expect(stub.direct).toEqual([]);
    // A chained call such as expect(...).toBe is recorded as dynamic and named by nothing, and it() belongs to the file.
    expect(stub.unresolved).toEqual(['charge', 'expect', 'vi.fn']);
    expect(stub.useful).toBe(false);
    const own = report.findings.filter(finding => finding.unit === stub.id).map(finding => [finding.kind, finding.probability]);
    // asserts_mock at 0.9 leaves 0.1 over the other seven smells, one of them none: some smell is 1 - 0.1 / 7.
    expect(own.map(([kind]) => kind)).toEqual(['asserts_mock', 'unresolved']);
    expect(own[0][1]).toBeCloseTo(1 - 0.1 / 7);
    // That none of its calls resolve is the call graph's; whether it tests nothing here is the answer's.
    expect(own[1][1]).toBe(0.8);
    expect('tests_nothing_here' in systemOne.calls.find(call => call.name === 'charges the stubbed amount').questions).toBe(true);
    expect(report.totals.unresolved).toBe(1);
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
/**
 * Answers for the run with reports. test_discount_negative and the negative-price test are said to decide the ordinary result
 * here, so each shares a label and a directly called method with another test, and the reports are what tells them apart.
 */
const MEASURED_TESTS = { test_discount_negative: { decides: ['happy_path', 0.85] }, 'cart > rejects a negative price': { decides: ['happy_path', 0.75] } };
/** save only writes what it is given to a file, and is said not to need a test of its own. */
const MEASURED_NEEDS = { save: 0.2 };
const MEASURED_METHODS = {
  total: { gap_line: ['line_4', 0.8], gap_kind: ['error_path', 0.7] },
  restock: { gap_line: ['line_3', 0.65], gap_kind: ['invalid_input', 0.6] },
};

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
      expect(rows['src/cart.ts']).toEqual(['1 of 2', '63%', '75%', '1']);
      expect(rows['src/db.ts']).toEqual(['0 of 1', '0%', '0%', '0']);
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
    expect(methods.get('cart.py::apply_discount')).toMatchObject({ measured: { lines: { hit: 4, total: 5 }, branches: { hit: 3, total: 4 } }, executed: true,
      exercised: 0.75, exercised_basis: 'measured', untaken: [7], untested: false });
    // Reached by test_count_mocked in the call graph, and not one of its lines ran.
    expect(methods.get('cart.py::item_count')).toMatchObject({ measured: { lines: { hit: 0, total: 1 }, branches: { hit: 0, total: 0 } }, executed: false,
      exercised: 0, exercised_basis: 'measured', untested: true });
    expect(methods.get('cart.py::item_count').tests).toEqual([{ id: 'tests/test_cart.py::test_count_mocked', depth: 1 }]);
    // No test reaches restock in the call graph, and the report shows it ran.
    expect(methods.get('cart.py::restock')).toMatchObject({ tests: [], measured: { lines: { hit: 3, total: 4 }, branches: { hit: 3, total: 4 } }, executed: true,
      exercised: 0.75, untested: false });
    expect(methods.get('pricing.py::round_money')).toMatchObject({ measured: { lines: { hit: 1, total: 1 }, branches: { hit: 0, total: 0 } }, exercised: 1, exercised_basis: 'measured' });
    expect(methods.get('src/cart.ts::total')).toMatchObject({ measured: { lines: { hit: 5, total: 5 }, branches: { hit: 3, total: 4 } }, exercised: 0.75, untaken: [6] });
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
    expect(cartFile.totals.exercised_basis).toBe('measured');
    expect(cartFile.hits.lines).toEqual([[1, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 0], [9, 1], [12, 1], [13, 0], [16, 1], [17, 1], [18, 1], [19, 0], [20, 1]]);
    expect(cartFile.hits.branches).toEqual([[5, 2, 2], [7, 1, 2], [17, 2, 2], [18, 1, 2]]);
  });

  it('asks only what the reports leave open', async () => {
    const { systemOne, report } = await measuredRun();
    const methodCalls = systemOne.calls.filter(call => call.state.method && !call.questions.needs_test);
    // item_count, checkout and save never ran; round_money and fetch_rate took every branch they have.
    expect(methodCalls.map(call => call.name).sort()).toEqual(['apply_discount', 'restock', 'total']);
    // The three that never ran are asked only whether they need a test, told how perch knows.
    const needCalls = systemOne.calls.filter(call => call.questions.needs_test);
    expect(needCalls.map(call => call.name).sort()).toEqual(['checkout', 'item_count', 'save']);
    for (const call of needCalls) expect(call.state.method.note).toBe('The coverage report shows none of its lines ran.');
    for (const call of methodCalls) expect(Object.keys(call.questions).sort()).toEqual(['gap_kind', 'gap_line']);
    const offered = name => Object.keys(methodCalls.find(call => call.name === name).questions.gap_line.criteria).sort();
    expect(offered('apply_discount')).toEqual(['line_4', 'none']);
    expect(offered('restock')).toEqual(['line_3', 'none']);
    // total's branch lines are 5 and 6; the report shows both sides of 5 taken.
    expect(offered('total')).toEqual(['line_4', 'none']);
    const asksCost = Object.fromEntries(systemOne.calls.filter(call => call.state.test).map(call => [call.name, 'cost' in call.questions]));
    expect(asksCost).toEqual({ test_discount_10: false, test_discount_20: false, test_discount_negative: false, test_count_mocked: false, test_rate: false,
      test_rate_mocked: true, 'cart > adds prices': false, 'cart > rejects a negative price': false, 'cart > checks out': true, 'saves an order': true });
    const methods = byId(report.methods);
    expect(methods.get('src/cart.ts::total').gap).toEqual({ line: 6, text: "if (price < 0) throw new Error('negative price');", kind: 'error_path', probability: 0.8 });
    expect(methods.get('cart.py::apply_discount').gap).toMatchObject({ line: 7, kind: 'boundary', probability: 0.7 });
    const edge = report.findings.find(finding => finding.kind === 'edge_case' && finding.unit === 'src/cart.ts::total');
    // Said of the method, as the case no test covers.
    expect(edge.note).toBe('Untested case: total failing.');
    const tests = byId(report.tests);
    expect(tests.get('tests/test_cart.py::test_rate').cost).toEqual({ seconds: 2, basis: 'measured' });
    expect(tests.get('tests/test_cart.py::test_rate_mocked').cost).toMatchObject({ tier: 0, basis: 'estimated' });
    expect(tests.get('test/db.test.ts::saves an order').cost).toMatchObject({ tier: 2, basis: 'estimated' });
    // Only the three untimed tests have a tier.
    expect(report.totals.cost).toEqual({ 0: 2, 1: 0, 2: 1, 3: 0 });
  });

  it('finds duplicates by lines run, else by calls', async () => {
    const { report } = await measuredRun();
    const tests = byId(report.tests);
    // Same label, same lines of apply_discount: one test written twice.
    expect(tests.get('tests/test_cart.py::test_discount_20')).toMatchObject({ redundant_with: 'tests/test_cart.py::test_discount_10', redundant_basis: 'measured' });
    const redundant = report.findings.find(finding => finding.kind === 'redundant' && finding.unit === 'tests/test_cart.py::test_discount_20');
    expect(redundant.note).toBe('Same checks and lines as test_discount_10 at line 9.');
    // Same label and the same method called, but it ran line 6 where the others ran 7 and 9: not the same test.
    expect(tests.get('tests/test_cart.py::test_discount_negative')).toMatchObject({ redundant_with: null, redundant_basis: null, useful: true });
    expect(tests.get('tests/test_cart.py::test_discount_negative').executed_methods).toEqual(['cart.py::apply_discount']);
    expect(tests.get('tests/test_cart.py::test_count_mocked').executed_methods).toEqual(['cart.py::restock']);
    // Vitest wrote no per-test lines, so the two tests calling only total with one label are compared on that.
    expect(tests.get('test/cart.test.ts::cart > adds prices').executed_methods).toBe(null);
    expect(tests.get('test/cart.test.ts::cart > rejects a negative price')).toMatchObject({ redundant_with: 'test/cart.test.ts::cart > adds prices', redundant_basis: 'static' });
    // Dropped: test_count_mocked for its smell, saves an order for checking nothing, and the two redundant tests. All but saves an
    // order were timed.
    expect(report.totals.drop).toMatchObject({ count: 4, seconds: 0.6875, timed: 3 });
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
      'checks_nothing test/db.test.ts::saves an order',
      'edge_case src/cart.ts::total',
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
    expect(methods.get('cart.py::apply_discount')).toMatchObject({ measured: null, executed: null, exercised_basis: 'estimated' });
    expect(methods.get('cart.py::restock')).toMatchObject({ measured: null, exercised: 0, exercised_basis: 'static', untested: true });
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
    expect(methods.get('src/main/java/shop/Cart.java::Cart.total')).toMatchObject({ measured: { lines: { hit: 2, total: 3 }, branches: { hit: 1, total: 2 } }, untaken: [5] });
    expect(methods.get('app/Pricing.java::Pricing.price').measured).toEqual({ lines: { hit: 1, total: 1 }, branches: { hit: 0, total: 0 } });
    for (const id of ['legacy/shop/Cart.java::Cart.total', 'a/Strings.java::Strings.trim', 'b/Strings.java::Strings.pad']) expect(methods.get(id).measured, id).toBe(null);
  });
});

it('finds duplicate tests among 40,000 in about linear time', () => {
  const answered = new Map(), tests = [];
  const said = { smell: { choice: 'none', probabilities: { none: 1 } }, decides: { choice: 'happy_path', probability: 0.9, probabilities: { happy_path: 0.9 } } };
  // Two tests for each method: the second repeats the first. Every tenth pair has a record of what ran, and those match on it.
  for (let index = 0; index < 20000; index++) for (const copy of [0, 1]) {
    const id = `test/t${index}.test.js::t${copy}`;
    tests.push({ id, node: { path: `test/t${index}.test.js`, line: copy + 1 }, direct: [`src/m${index}.js::m`], executed_key: index % 10 ? undefined : `[["src/m${index}.js",[1]]]` });
    answered.set(id, { answers: said });
  }
  const started = performance.now();
  const { redundantWith, redundantBasis, useful } = judgeTests(tests, answered, 0.5);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(useful.size).toBe(20000);
  expect(redundantWith.get('test/t3.test.js::t1')).toBe('test/t3.test.js::t0');
  expect(redundantBasis.get('test/t3.test.js::t1')).toBe('static');
  expect(redundantBasis.get('test/t10.test.js::t1')).toBe('measured');
});
