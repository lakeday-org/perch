import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { coverageRepository } from '../src/coverage.js';
import { TOKEN_LIMITS } from '../src/tokens.js';
import { initRepo } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** A model that says every survivor matters, and records what it was asked about. */
function model() {
  const calls = [];
  return { id: 'scripted', limits: TOKEN_LIMITS, calls, async ask(state, questions) {
    calls.push(state.method?.name ?? state.test?.name);
    return { model: 'scripted', answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0.9 }])), usage: { input_tokens: 1, output_tokens: 0 } };
  } };
}

async function repository(files, { modules = false, install = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perch-js-runner-'));
  cleanups.push(root);
  for (const [path, text] of Object.entries({ ...files, '.gitignore': 'node_modules\n' })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  // perch's own installed Vitest stands in for the repository's; any other framework is installed, as the repository's would be.
  if (modules) await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'));
  if (install) execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: root, stdio: 'ignore' });
  await initRepo(root);
  return root;
}

const CART = 'function applyDiscount(total, percent) {\n  if (percent < 0 || percent > 100) throw new Error(\'bad percent\');\n  return Math.round(total * (100 - percent)) / 100;\n}\n';
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].some(path => existsSync(path)) || Boolean(process.env.CHROME_BIN);

/** perch coverage on a repository, with what every installed framework's run must agree on: the discount's arithmetic killed. */
async function covered(root, runner, test) {
  const report = await coverageRepository({ root, revision: await revision(root), out: join(root, '.perch'), analyzer, systemOne: model(), parallel: 2 });
  expect(report.measured).toMatchObject({ runner, invalid: 0, unmatched_tests: 0 });
  const discount = report.methods.find(item => item.name === 'applyDiscount');
  expect(discount.mutants.find(mutant => mutant.kind === 'arithmetic')).toMatchObject({ killed: true, killed_by: [test] });
  return report;
}

const SOURCE = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function scale(a: number, factor: number): number {\n  return a * factor;\n}\n';

describe('running JavaScript tests', () => {
  it('runs Vitest with every mutant switched in, and knows which test reaches which mutant', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ name: 'shop', private: true, type: 'module', devDependencies: { vitest: '*' } }),
      'src/calc.ts': SOURCE,
      'test/calc.test.ts': "import { describe, expect, it } from 'vitest';\nimport { add, scale } from '../src/calc';\n\ndescribe('calc', () => {\n  it('adds', () => {\n    expect(add(2, 3)).toBe(5);\n  });\n  it('scales without checking', () => {\n    scale(2, 3);\n  });\n});\n",
    }, { modules: true });
    const systemOne = model();
    const report = await coverageRepository({ root, revision: await revision(root), out: join(root, '.perch'), analyzer, systemOne, parallel: 2 });
    expect(report.measured).toMatchObject({ runner: 'vitest', invalid: 0, unmatched_tests: 0 });
    const method = name => report.methods.find(item => item.id === `src/calc.ts::${name}`);
    // Each mutant of add is reached by the test that calls it, and only that one, and is killed by it.
    expect(method('add').mutants.find(mutant => mutant.kind === 'arithmetic')).toMatchObject({ killed: true, killed_by: ['test/calc.test.ts::calc > adds'], asked: ['test/calc.test.ts::calc > adds'] });
    // scale's arithmetic survives the test that runs it without checking, and only then is the model asked.
    expect(method('scale').mutants.find(mutant => mutant.kind === 'arithmetic')).toMatchObject({ killed: false, asked: ['test/calc.test.ts::calc > scales without checking'], matters: 0.9 });
    expect(systemOne.calls).not.toContain('add');
    expect(report.findings.some(finding => finding.kind === 'checks_nothing' && finding.unit === 'test/calc.test.ts::calc > scales without checking')).toBe(true);
  }, 120000);

  it('runs node:test the same way, with nothing installed', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ name: 'shop', private: true, type: 'module', scripts: { test: 'node --test' } }),
      'src/calc.js': SOURCE.replace(/: number/g, ''),
      'test/calc.test.js': "import assert from 'node:assert/strict';\nimport { describe, it } from 'node:test';\nimport { add, scale } from '../src/calc.js';\n\ndescribe('calc', () => {\n  it('adds', () => {\n    assert.equal(add(2, 3), 5);\n  });\n  it('scales without checking', () => {\n    scale(2, 3);\n  });\n});\n",
    });
    const report = await coverageRepository({ root, revision: await revision(root), out: join(root, '.perch'), analyzer, systemOne: model(), parallel: 2 });
    expect(report.measured).toMatchObject({ runner: 'node:test', invalid: 0, unmatched_tests: 0 });
    const add = report.methods.find(item => item.id === 'src/calc.js::add');
    expect(add.mutants.find(mutant => mutant.kind === 'arithmetic')).toMatchObject({ killed: true, killed_by: ['test/calc.test.js::calc > adds'] });
    expect(report.findings.some(finding => finding.kind === 'checks_nothing' && finding.unit === 'test/calc.test.js::calc > scales without checking')).toBe(true);
  }, 120000);

  it('runs Jest, Mocha and Jasmine kept loaded, each from its own install', async () => {
    const spec = "describe('applyDiscount', () => {\n  it('takes 10 percent off', () => {\n    if (applyDiscount(100, 10) !== 90) throw new Error('wrong');\n  });\n});\n";
    const jest = await repository({
      'package.json': JSON.stringify({ name: 'shop', private: true, devDependencies: { jest: '^30.0.0' } }),
      'src/cart.js': `${CART}module.exports = { applyDiscount };\n`,
      'test/cart.test.js': `const { applyDiscount } = require('../src/cart');\n${spec}`,
    }, { install: true });
    await covered(jest, 'jest', 'test/cart.test.js::applyDiscount > takes 10 percent off');
    const mocha = await repository({
      'package.json': JSON.stringify({ name: 'shop', private: true, scripts: { test: 'mocha test/' }, devDependencies: { mocha: '^11.0.0' } }),
      'src/cart.js': `${CART}module.exports = { applyDiscount };\n`,
      'test/cart.test.js': `const { applyDiscount } = require('../src/cart');\n${spec}`,
    }, { install: true });
    await covered(mocha, 'mocha', 'test/cart.test.js::applyDiscount > takes 10 percent off');
    const jasmine = await repository({
      'package.json': JSON.stringify({ name: 'shop', private: true, devDependencies: { jasmine: '^5.5.0' } }),
      'spec/support/jasmine.json': JSON.stringify({ spec_dir: 'spec', spec_files: ['**/*[sS]pec.js'] }),
      'src/cart.js': `${CART}module.exports = { applyDiscount };\n`,
      'spec/cart.spec.js': `const { applyDiscount } = require('../src/cart');\n${spec}`,
    }, { install: true });
    await covered(jasmine, 'jasmine', 'spec/cart.spec.js::applyDiscount > takes 10 percent off');
  }, 600000);

  it.skipIf(!chrome)('runs Karma in headless Chrome, its sources and tests read from the Karma config', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ name: 'shop', private: true, devDependencies: { karma: '^6.4.4', 'karma-jasmine': '^5.1.0', 'jasmine-core': '^5.5.0', 'karma-chrome-launcher': '^3.2.0' } }),
      'karma.conf.js': "module.exports = config => config.set({ frameworks: ['jasmine'], files: ['src/**/*.js', 'test/**/*.spec.js'], browsers: ['ChromeHeadless'], singleRun: true });\n",
      'src/cart.js': CART,
      'test/cart.spec.js': "describe('applyDiscount', () => {\n  it('takes 10 percent off', () => {\n    expect(applyDiscount(100, 10)).toBe(90);\n  });\n});\n",
    }, { install: true });
    await covered(root, 'karma', 'test/cart.spec.js::applyDiscount > takes 10 percent off');
  }, 600000);

  it('runs Cucumber, its scenarios the tests', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ name: 'shop', private: true, devDependencies: { '@cucumber/cucumber': '^11.0.0' } }),
      'src/cart.js': `${CART}module.exports = { applyDiscount };\n`,
      'features/discount.feature': 'Feature: Discounts\n  Scenario: Ten percent off\n    Given a total of 100\n    When I take 10 percent off\n    Then the total is 90\n',
      'features/step_definitions/steps.js': "const assert = require('node:assert/strict');\nconst { Given, When, Then } = require('@cucumber/cucumber');\nconst { applyDiscount } = require('../../src/cart');\n\nGiven('a total of {int}', function (total) { this.total = total; });\nWhen('I take {int} percent off', function (percent) { this.total = applyDiscount(this.total, percent); });\nThen('the total is {int}', function (expected) { assert.equal(this.total, expected); });\n",
    }, { install: true });
    await covered(root, 'cucumber', 'features/discount.feature::Discounts > Ten percent off');
  }, 600000);

  it('runs Cucumber beside Mocha, each mutant against the framework whose tests reach it', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ name: 'shop', private: true, scripts: { test: 'mocha test/' }, devDependencies: { mocha: '^11.0.0', '@cucumber/cucumber': '^11.0.0' } }),
      'src/cart.js': `${CART}function shipping(total) {\n  return total > 50 ? 0 : 5;\n}\nmodule.exports = { applyDiscount, shipping };\n`,
      'test/cart.test.js': "const { applyDiscount } = require('../src/cart');\ndescribe('applyDiscount', () => {\n  it('takes 10 percent off', () => {\n    if (applyDiscount(100, 10) !== 90) throw new Error('wrong');\n  });\n});\n",
      'features/shipping.feature': 'Feature: Shipping\n  Scenario: Small orders pay\n    Given a total of 20\n    Then shipping is 5\n',
      'features/step_definitions/steps.js': "const assert = require('node:assert/strict');\nconst { Given, Then } = require('@cucumber/cucumber');\nconst { shipping } = require('../../src/cart');\n\nGiven('a total of {int}', function (total) { this.total = total; });\nThen('shipping is {int}', function (expected) { assert.equal(shipping(this.total), expected); });\n",
    }, { install: true });
    const report = await covered(root, 'mocha and cucumber', 'test/cart.test.js::applyDiscount > takes 10 percent off');
    const shipping = report.methods.find(item => item.name === 'shipping');
    expect(shipping.mutants.find(mutant => mutant.kind === 'number' && mutant.to === '6')).toMatchObject({ killed: true, killed_by: ['features/shipping.feature::Shipping > Small orders pay'] });
  }, 600000);

  it('says what is missing when the framework is not installed', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ name: 'shop', private: true, devDependencies: { mocha: '*' } }),
      'src/calc.js': SOURCE.replace(/: number/g, '').replace(/export /g, ''),
      'test/calc.test.js': "describe('calc', () => {\n  it('adds', () => {});\n});\n",
    });
    await expect(coverageRepository({ root, revision: await revision(root), out: join(root, '.perch'), analyzer, systemOne: model() }))
      .rejects.toThrow('mocha cannot run here: mocha is not installed in node_modules; install the repository\'s dependencies first');
  });
});
