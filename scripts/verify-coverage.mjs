/**
 * Live acceptance for perch coverage. Each fixture application gets a disposable git repository and real Jev requests.
 *
 * What the parser and the call graph decide is asserted exactly against test/fixtures/<app>/expected.json, which was written by
 * reading the fixtures, not by running perch. What Jev decides is a reading, so it is printed as agreement with those same
 * expectations rather than asserted: a model that disagrees about one test is information, and a threshold here would be a
 * number tuned until it passed.
 *
 * The second half commits a test for the branch none of the twelve reach, runs again, and checks the diff says so.
 */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expectations } from '../test/fixtures/expectations.mjs';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const cli = join(workspace, 'bin/perch.mjs');
if (!process.env.PERCH_API_KEY && !process.env.TYPESAFE_API_KEY) throw new Error('Export PERCH_API_KEY before running the live coverage checks.');
const expected = await expectations();
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'perch-coverage-')));
const artifacts = join(workspace, '.perch', 'coverage-verification');
await mkdir(artifacts, { recursive: true });
const git = (root, args) => promisify(execFile)('git', args, { cwd: root });
const only = process.argv.slice(2);

async function perch(root, label, args, allowed) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: process.env });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data);
  child.stderr.on('data', data => stderr += data);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await writeFile(join(artifacts, `${label}.stdout`), stdout);
  await writeFile(join(artifacts, `${label}.stderr`), stderr);
  assert(allowed.includes(code), `${label}: exit ${code}: ${stderr.slice(-1500)}`);
  return { code, stdout, stderr };
}

/**
 * One more test per application, for a path none of the twelve take: the discount at or above a hundred percent, or in the
 * Python application, whose discount has no branch, an out-of-stock item after an in-stock one. `at` is where it goes: the end
 * of the file, inside a Java class before its closing brace (the file's last), or before a marker such as a `__main__` guard.
 */
const branchTests = {
  'order-service': ['tests/test_order_service.py', 'end', '\n\ndef test_can_fulfil_rejects_a_later_item_out_of_stock():\n    items = [SimpleNamespace(sku="book", quantity=1), SimpleNamespace(sku="pen", quantity=2)]\n    assert checkout.can_fulfil(items, {"book": 4, "pen": 0}) is False\n'],
  'order-service-typescript': ['test/cart.test.ts', 'end', "\nit('is free at a hundred percent or more', () => {\n  expect(applyDiscount(200, 150)).toBe(0);\n});\n"],
  'order-service-frontend': ['src/cart.test.tsx', 'end', "\nit('is free at a hundred percent or more', () => {\n  expect(applyDiscount(200, 150)).toBe(0);\n});\n"],
  'order-service-rust': ['src/tests.rs', 'end', '\n#[test]\nfn is_free_at_a_hundred_percent_or_more() {\n    assert_eq!(apply_discount(200, 150), 0);\n}\n'],
  'order-service-java': ['test/example/CartTest.java', 'class', '    @Test\n    void isFreeAtAHundredPercentOrMore() {\n        assertEquals(0, Cart.applyDiscount(200, 150));\n    }\n'],
  'order-service-cpp': ['test/cart_test.cpp', 'end', '\nTEST(ApplyDiscount, IsFreeAtAHundredPercentOrMore) {\n    EXPECT_EQ(apply_discount(200, 150), 0);\n}\n'],
  'order-service-unittest': ['tests/test_order_service.py', 'before:if __name__', 'class LaterItemTest(unittest.TestCase):\n    def test_can_fulfil_rejects_a_later_item_out_of_stock(self):\n        items = [SimpleNamespace(sku="book", quantity=1), SimpleNamespace(sku="pen", quantity=2)]\n        self.assertIs(checkout.can_fulfil(items, {"book": 4, "pen": 0}), False)\n\n\n'],
  'order-service-jest': ['test/cart.test.ts', 'end', "\nit('is free at a hundred percent or more', () => {\n  expect(applyDiscount(200, 150)).toBe(0);\n});\n"],
  'order-service-frontend-jest': ['src/cart.test.tsx', 'end', "\nit('is free at a hundred percent or more', () => {\n  expect(applyDiscount(200, 150)).toBe(0);\n});\n"],
  'order-service-mocha': ['test/cart.test.ts', 'end', "\ndescribe('applyDiscount ceiling', () => {\n  it('is free at a hundred percent or more', () => {\n    assert.equal(applyDiscount(200, 150), 0);\n  });\n});\n"],
  'order-service-node-test': ['test/cart.test.ts', 'end', "\ndescribe('applyDiscount ceiling', () => {\n  it('is free at a hundred percent or more', () => {\n    assert.equal(applyDiscount(200, 150), 0);\n  });\n});\n"],
  'order-service-java-junit4': ['test/example/CartTest.java', 'class', '    @Test\n    public void isFreeAtAHundredPercentOrMore() {\n        assertEquals(0, Cart.applyDiscount(200, 150));\n    }\n'],
  'order-service-java-testng': ['test/example/CartTest.java', 'class', '    public void isFreeAtAHundredPercentOrMore() {\n        assertEquals(Cart.applyDiscount(200, 150), 0);\n    }\n'],
  'order-service-cpp-catch2': ['test/cart_test.cpp', 'end', '\nTEST_CASE("apply_discount is free at a hundred percent or more", "[apply_discount]") {\n    CHECK(apply_discount(200, 150) == 0);\n}\n'],
  'order-service-cpp-doctest': ['test/cart_test.cpp', 'end', '\nTEST_CASE("apply_discount is free at a hundred percent or more") {\n    CHECK(apply_discount(200, 150) == 0);\n}\n'],
};

async function addTest(root, [path, at, text]) {
  const file = join(root, path), source = await readFile(file, 'utf8');
  if (at === 'end') return writeFile(file, source + text);
  if (at.startsWith('before:')) {
    const marker = source.indexOf(at.slice('before:'.length));
    if (marker < 0) throw new Error(`${path} has no ${at.slice('before:'.length)} to add a test before`);
    return writeFile(file, source.slice(0, marker) + text + source.slice(marker));
  }
  const close = source.lastIndexOf('}');
  if (close < 0) throw new Error(`${path} has no closing brace to add a test before`);
  return writeFile(file, source.slice(0, close) + text + source.slice(close));
}

const agreement = [], measured = [];

/** Each runner's report flags: `[runner, ['--junit', 'a.xml,b.xml', '--lcov', ...]]`, paths relative to the app root. */
async function runnerSets(root) {
  const dir = join(root, 'reports');
  const runners = await readdir(dir, { withFileTypes: true }).then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(), () => []);
  const sets = [];
  for (const runner of runners) {
    const here = `reports/${runner}`, names = await readdir(join(root, here));
    const junit = names.includes('junit.xml') ? [`${here}/junit.xml`]
      : names.includes('junit') ? (await readdir(join(root, here, 'junit'))).filter(name => name.endsWith('.xml')).sort().map(name => `${here}/junit/${name}`) : [];
    const flags = [];
    if (junit.length) flags.push('--junit', junit.join(','));
    const coverage = names.includes('lcov.info') ? ['--lcov', `${here}/lcov.info`] : names.includes('jacoco.xml') ? ['--jacoco', `${here}/jacoco.xml`]
      : names.includes('cobertura.xml') ? ['--cobertura', `${here}/cobertura.xml`] : [];
    flags.push(...coverage);
    if (names.includes('coverage.json')) flags.push('--contexts', `${here}/coverage.json`);
    sets.push([runner, flags]);
  }
  return sets;
}
const apps = expected.filter(app => !only.length || only.includes(app.app));
for (const app of apps) {
  const root = join(scratch, app.app);
  await cp(join(workspace, 'test', 'fixtures', app.app), root, {
    recursive: true, filter: source => !['node_modules', 'dist', 'target', 'out', '.git', '.perch'].includes(basename(source)),
  });
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Coverage verification'],
    ['config', 'user.email', 'coverage@example.invalid'], ['add', '.'], ['commit', '-qm', 'fixture']]) await git(root, args);

  // The reports each of the app's runners wrote, the way CI would hand them over: reports/<runner>/. One coverage file per
  // run: a runner that wrote LCOV and Cobertura of the same run is read from LCOV alone, or it would be counted twice.
  const sets = await runnerSets(root);
  assert(sets.length, `${app.app}: no reports under reports/<runner>/`);
  let report;
  for (const [runner, flags] of sets) {
    const label = `${app.app}-${runner}`;
    const run = await perch(root, `${label}-coverage`, ['coverage', '--json', '--verbose', '--all', ...flags], [3]);
    const each = JSON.parse(run.stdout);
    assert.deepEqual(each.failed, [], `${label}: units failed: ${JSON.stringify(each.failed)}`);
    assert.deepEqual(each.unmatched_runs, [], `${label}: runs matched to no test`);
    assert.deepEqual(each.unmatched_paths, [], `${label}: report paths that are no file here`);
    for (const want of app.tests) {
      const test = each.tests.find(item => item.path === want.file && item.name === want.name);
      assert(test?.run, `${label} #${want.n} ${want.name}: no run matched`);
    }
    assert(each.totals.measured, `${label}: nothing measured`);
    measured.push({ app: label, lines: each.totals.measured.lines, branches: each.totals.measured.branches, suite: each.totals.suite, drop: each.totals.drop });
    report ??= each;
  }
  const reports = sets[0][1];
  for (const want of app.tests) {
    const test = report.tests.find(item => item.path === want.file && item.name === want.name);
    assert(test, `${app.app}: test ${want.file} ${want.name} was not found; found ${report.tests.map(item => `${item.path}::${item.name}`).join(', ')}`);
    assert.deepEqual([...test.direct].sort(), [...want.direct].sort(), `${app.app} #${want.n} ${want.name}: direct`);
    assert.deepEqual([...test.cuts].sort(), [...(want.cuts ?? [])].sort(), `${app.app} #${want.n} ${want.name}: cuts`);
    for (const category of want.touches ?? []) assert(test.touches.includes(category), `${app.app} #${want.n} ${want.name}: touches ${category}, has ${test.touches}`);
    agreement.push({ app: app.app, n: want.n, name: want.name,
      decides: [want.decides, test.decides?.choice ?? null], smell: [want.smell, test.smell?.choice ?? null],
      infra: [want.infra, test.infra === null ? null : test.infra > 0.5] });
  }
  assert(report.tests.length >= app.tests.length, `${app.app}: fewer tests than the fixture has`);

  // The same commit again asks nothing: every answer is cached under a key that has not changed.
  const again = await perch(root, `${app.app}-coverage-again`, ['coverage', '--json', ...reports], [3]);
  assert.deepEqual(JSON.parse(again.stdout).usage, {}, `${app.app}: an unchanged commit was asked again`);

  const branch = branchTests[app.app];
  if (!branch) continue;
  await addTest(root, branch);
  await git(root, ['commit', '-qam', 'test a path none of the twelve take']);
  // The reports are from the first commit's run, so the added test has no run of its own; that is what CI would hand over
  // if it had not rerun the suite, and the report says so rather than inventing one.
  const second = await perch(root, `${app.app}-coverage-diff`, ['coverage', '--json', ...reports], [3]);
  const after = JSON.parse(second.stdout);
  assert(after.diff, `${app.app}: no diff against the first report`);
  assert.equal(after.diff.tests.added.length, 1, `${app.app}: one test added`);
  // Whether the branch estimate moved is Jev's reading, so it is printed rather than asserted.
  console.log(`${app.app}: ${after.diff.methods.map(method => `${method.name} ${method.before?.exercised ?? '-'} -> ${method.after?.exercised ?? '-'}`).join(', ') || 'no method changed'}`);
}

const rows = agreement.map(row => [row.app, row.n, row.name,
  ...['decides', 'smell', 'infra'].map(key => row[key][0] === row[key][1] ? 'ok' : `${row[key][1]} (expected ${row[key][0]})`)]);
console.log(rows.map(row => row.join('\t')).join('\n'));
for (const key of ['decides', 'smell', 'infra']) {
  const same = agreement.filter(row => row[key][0] === row[key][1]).length;
  console.log(`${key}: Jev agreed on ${same} of ${agreement.length}`);
}
for (const row of measured) {
  const share = part => (part.total ? `${Math.round(100 * part.hit / part.total)}% (${part.hit}/${part.total})` : '-');
  console.log(`${row.app}: lines ${share(row.lines)}, branches ${share(row.branches)}, suite ${row.suite ? row.suite.seconds.toFixed(3) : "-"}s over ${row.suite?.runs ?? 0} runs, `
    + `dropping ${row.drop.count} saves ${row.drop.seconds === null ? "-" : row.drop.seconds.toFixed(3)}s (${row.drop.timed} timed)`);
}
console.log(`artifacts: ${artifacts}`);
