import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listTree, revision } from '../src/git.js';
import { analyzeTree } from '../src/analyze.js';
import { analyzeFiles, createSourceAnalyzer } from '../src/analysis.js';
import { buildGraph } from '../src/graph.js';
import { frameworkScope, markTestSupport } from '../src/test-scope.js';
import { initRepo } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** A repository of these files, scanned, with the scope its frameworks give it. `modules` links perch's own node_modules in. */
async function scoped(files, { modules = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perch-scope-'));
  cleanups.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await writeFile(join(root, '.gitignore'), 'node_modules\n.perch\n');
  if (modules) await symlink(resolve('node_modules'), join(root, 'node_modules'));
  await initRepo(root);
  const rev = await revision(root);
  const scan = await analyzeTree({ root, revision: rev, out: join(root, '.perch'), analyzer });
  const scope = await frameworkScope({ root, tree: await listTree(root, rev), scan, graph: buildGraph(scan.files) });
  const all = scan.files.map(file => file.path).sort();
  return { scope, tests: all.filter(path => scope?.test(path)), sources: all.filter(path => scope?.source(path)), out: all.filter(path => !scope?.test(path) && !scope?.source(path)) };
}

const add = 'export function add(a, b) {\n  return a + b;\n}\n';

describe('the code a run is about', () => {
  it('takes the tests Vitest runs and the code they import, minus what its coverage settings exclude', async () => {
    const { scope, tests, sources, out } = await scoped({
      'package.json': JSON.stringify({ name: 'scoped', type: 'module', devDependencies: { vitest: '*' } }),
      'vitest.config.mjs': "export default { test: { include: ['test/**/*.test.js'], coverage: { exclude: ['src/legacy/**'] } } };\n",
      'src/math.js': "import { old } from './legacy/old.js';\nexport function add(a, b) {\n  return old(a) + b;\n}\n",
      // Beside a file the tests import, so code no test reaches yet is still the suite's to cover.
      'src/untested.js': 'export function sub(a, b) {\n  return a - b;\n}\n',
      'src/legacy/old.js': 'export function old(a) {\n  return a;\n}\n',
      'scripts/release.js': 'export function release() {\n  return 1;\n}\n',
      'test/math.test.js': "import { it, expect } from 'vitest';\nimport { add } from '../src/math.js';\nit('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
      // A test file Vitest's include does not name is no test of this suite.
      'tools/release.test.js': "import { it } from 'vitest';\nimport { release } from '../scripts/release.js';\nit('releases', () => {\n  release();\n});\n",
    }, { modules: true });
    expect(scope.frameworks).toEqual([expect.objectContaining({ name: 'Vitest', config: 'vitest.config.mjs', error: null, tests: 1 })]);
    expect(tests).toEqual(['test/math.test.js']);
    expect(sources).toEqual(['src/math.js', 'src/untested.js']);
    expect(out).toEqual(['scripts/release.js', 'src/legacy/old.js', 'tools/release.test.js', 'vitest.config.mjs']);
  }, 60000);

  it("takes the tests Jest lists and its collectCoverageFrom, run from the package that names the config", async () => {
    // Jest as its CLI answers: --showConfig prints the resolved config, --listTests one test path a line.
    const jest = String.raw`
const { join } = require('node:path');
const root = process.cwd();
if (process.argv.includes('--showConfig')) {
  console.log(JSON.stringify({ configs: [{ rootDir: root, collectCoverageFrom: ['src/**/*.js', '!src/generated/**'], coveragePathIgnorePatterns: ['/src/legacy/'] }] }));
} else if (process.argv.includes('--listTests')) {
  console.log(join(root, 'test', 'math.test.js'));
}
`;
    const { scope, tests, sources, out } = await scoped({
      'package.json': JSON.stringify({ name: 'scoped', scripts: { test: 'jest --config scripts/jest.config.js' } }),
      'scripts/jest.config.js': 'module.exports = {};\n',
      'node_modules/jest/package.json': JSON.stringify({ name: 'jest', version: '29.7.0' }),
      'node_modules/jest/bin/jest.js': jest,
      'src/math.js': add,
      'src/generated/table.js': 'export function table() {\n  return [];\n}\n',
      'src/legacy/old.js': 'export function old() {\n  return 1;\n}\n',
      'test/math.test.js': "const { add } = require('../src/math.js');\ntest('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
      'tools/other.test.js': "test('other', () => {\n  expect(1).toBe(1);\n});\n",
    });
    expect(scope.frameworks).toEqual([expect.objectContaining({ name: 'Jest', version: '29.7.0', config: 'scripts/jest.config.js', error: null, tests: 1 })]);
    expect(tests).toEqual(['test/math.test.js']);
    expect(sources).toEqual(['src/math.js']);
    expect(out).toEqual(expect.arrayContaining(['src/generated/table.js', 'src/legacy/old.js', 'tools/other.test.js']));
  }, 60000);

  it('says why a config could not load, and reads the tests the parser found instead', async () => {
    const { scope, tests, out } = await scoped({
      'package.json': JSON.stringify({ name: 'scoped', type: 'module' }),
      'vitest.config.mjs': "throw new Error('this config cannot load');\n",
      'src/math.js': add,
      'test/math.test.js': "import { it, expect } from 'vitest';\nimport { add } from '../src/math.js';\nit('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
      'examples/demo.js': 'export function demo() {\n  return 1;\n}\n',
    }, { modules: true });
    expect(scope.frameworks[0]).toMatchObject({ name: 'Vitest', config: 'vitest.config.mjs', tests: null, error: expect.stringContaining('this config cannot load') });
    expect(tests).toEqual(['test/math.test.js']);
    expect(out).toEqual(['examples/demo.js', 'vitest.config.mjs']);
  }, 60000);

  it("reads pytest's testpaths and coverage.py's source and omit", async () => {
    const { tests, sources, out } = await scoped({
      'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.coverage.run]\nsource = ["shop"]\nomit = ["shop/generated/*"]\n',
      'shop/__init__.py': '',
      'shop/cart.py': 'def total(items):\n    return sum(items)\n',
      'shop/generated/lib.py': 'def helper():\n    return 1\n',
      'tests/test_cart.py': 'from shop.cart import total\n\ndef test_total():\n    assert total([1, 2]) == 3\n',
      'docs/conf.py': 'def setup(app):\n    return app\n',
      'bench/test_speed.py': 'def test_fast():\n    assert True\n',
    });
    expect(tests).toEqual(['tests/test_cart.py']);
    expect(sources).toEqual(['shop/__init__.py', 'shop/cart.py']);
    expect(out).toEqual(['bench/test_speed.py', 'docs/conf.py', 'shop/generated/lib.py']);
  });

  it('covers the Gradle module a test sits in, and leaves out a module with no tests', async () => {
    const { sources, out } = await scoped({
      'settings.gradle': "include 'lib', 'tool'\n",
      'lib/build.gradle': "plugins { id 'java' }\n",
      'lib/src/main/java/demo/Cart.java': 'package demo;\npublic class Cart {\n  public int total(int a) { return a; }\n}\n',
      'lib/src/test/java/demo/CartTest.java': 'package demo;\nimport org.junit.jupiter.api.Test;\nclass CartTest {\n  @Test\n  void totals() { new Cart().total(1); }\n}\n',
      'tool/build.gradle': "plugins { id 'java' }\n",
      'tool/src/main/java/demo/Release.java': 'package demo;\npublic class Release {\n  public int run() { return 1; }\n}\n',
    });
    expect(sources).toContain('lib/src/main/java/demo/Cart.java');
    expect(out).toContain('tool/src/main/java/demo/Release.java');
    expect(out).not.toContain('lib/src/main/java/demo/Cart.java');
  });

  it('loads no config under a path perch.yaml ignores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-scope-'));
    cleanups.push(root);
    const files = { 'src/math.js': add, 'test/math.test.js': "import { add } from '../src/math.js';\ntest('adds', () => {\n  add(1, 2);\n});\n",
      'fixtures/app/package.json': JSON.stringify({ devDependencies: { jest: '*' } }), 'fixtures/app/a.test.js': "test('x', () => {\n  x();\n});\n" };
    for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
    await initRepo(root);
    const rev = await revision(root);
    const scan = await analyzeTree({ root, revision: rev, out: join(root, '.perch'), analyzer });
    const scope = await frameworkScope({ root, tree: await listTree(root, rev), scan, graph: buildGraph(scan.files), ignored: path => path.startsWith('fixtures/') });
    expect(scope.frameworks.map(framework => framework.config)).not.toContain('fixtures/app/package.json');
  });

  it('narrows nothing in a repository with no tests', async () => {
    const { scope } = await scoped({ 'src/math.js': add });
    expect(scope).toBe(null);
  });

  it('takes test code that holds no test from each tool\'s own rules, not from its name', async () => {
    const text = {
      'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["checks"]\n',
      'shop/cart.py': 'def total(items):\n    return sum(items)\n',
      'shop/testing.py': 'def make_cart():\n    return []\n',
      'checks/test_cart.py': 'from shop.cart import total\nfrom shop.testing import make_cart\n\ndef test_total():\n    assert total(make_cart()) == 0\n',
      'checks/factories.py': 'def items():\n    return [1]\n',
      'conftest.py': 'import pytest\n\n@pytest.fixture\ndef cart():\n    return []\n',
      'lib/build.gradle': "plugins { id 'java' }\n",
      'lib/src/main/java/demo/Cart.java': 'package demo;\npublic class Cart {\n  public int total() { return 1; }\n}\n',
      'lib/src/test/java/demo/Carts.java': 'package demo;\nclass Carts {\n  static Cart empty() { return new Cart(); }\n}\n',
      'lib/src/test/java/demo/CartTest.java': 'package demo;\nimport org.junit.jupiter.api.Test;\nclass CartTest {\n  @Test\n  void totals() { Carts.empty().total(); }\n}\n',
      'crate/Cargo.toml': '[package]\nname = "crate"\n',
      'crate/src/lib.rs': 'pub fn one() -> i64 {\n    1\n}\n',
      'crate/tests/common/mod.rs': 'pub fn setup() {}\n',
      'crate/tests/one.rs': 'mod common;\n\n#[test]\nfn is_one() {\n    common::setup();\n    assert_eq!(crate::one(), 1);\n}\n',
      'native/src/cart.cpp': 'int total() { return 1; }\n',
      'native/tests/matchers.h': 'inline bool positive(int n) { return n > 0; }\n',
      'native/tests/cart_test.cpp': '#include <gtest/gtest.h>\n#include "matchers.h"\n\nTEST(Cart, Totals) {\n  EXPECT_TRUE(positive(1));\n}\n',
      'native/third_party/gtest-all.cc': '#include "gtest/gtest.h"\nint registered() { return 0; }\n',
      'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n',
      'spec/stubs.js': "import sinon from 'sinon';\nexport function stubbed() {\n  return sinon.stub();\n}\n",
      'spec/build.js': 'export function numbers() {\n  return [1, 2];\n}\n',
      'spec/math.spec.js': "import { add } from '../src/math.js';\nimport { stubbed } from './stubs.js';\nimport { numbers } from './build.js';\nit('adds', () => {\n  stubbed();\n  add(...numbers());\n});\n",
    };
    const root = await mkdtemp(join(tmpdir(), 'perch-support-'));
    cleanups.push(root);
    for (const [path, body] of Object.entries(text)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), body); }
    const sources = Object.keys(text).filter(path => /\.(py|java|rs|js|cpp|cc|h)$/.test(path));
    const scan = await analyzeFiles(sources.map(path => ({ type: 'blob', path })), { analyzer, readSource: file => text[file.path] });
    await markTestSupport({ root, paths: Object.keys(text), files: scan.files });
    const tests = scan.files.filter(file => file.test).map(file => file.path).sort();
    // Imported only by a test, and still the code under test: shop/testing.py ships, and src/math.js is what the test is about.
    expect(tests).toEqual(['checks/factories.py', 'checks/test_cart.py', 'conftest.py', 'crate/tests/common/mod.rs', 'crate/tests/one.rs',
      'lib/src/test/java/demo/CartTest.java', 'lib/src/test/java/demo/Carts.java', 'native/tests/cart_test.cpp', 'native/tests/matchers.h',
      'native/third_party/gtest-all.cc', 'spec/build.js', 'spec/math.spec.js', 'spec/stubs.js']);
  });
});
