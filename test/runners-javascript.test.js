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

async function repository(files, { modules = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perch-js-runner-'));
  cleanups.push(root);
  for (const [path, text] of Object.entries({ ...files, '.gitignore': 'node_modules\n' })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  // perch's own installed Vitest stands in for the repository's.
  if (modules) await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'));
  await initRepo(root);
  return root;
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
