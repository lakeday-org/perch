import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { runScan } from '../src/scan.js';
import { improves, refactorCandidates, regionStart, runRefactor, runRefactorQueue } from '../src/refactor.js';
import { moduleScope } from '../src/questions.js';
import { createShell } from '../src/shell.js';
import { openStore } from '../src/store.js';
import { formatFix, formatFixes } from '../src/report.js';
import { createUi } from '../src/ui.js';
import { buggySource, commitAll, documentedSource, fixtureOptions, leanerSource, makeFixture, scriptedModel, scriptedSystemOne } from './helpers.js';

const analyzer = createSourceAnalyzer();
const shell = createShell();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** The clamp fixture scanned, with clamp as the method to work on. */
async function scanned() {
  const root = await makeFixture();
  cleanups.push(root);
  const repo = { root, revision: await revision(root), out: join(root, '.perch') };
  const scan = await runScan(fixtureOptions(repo, { analyzer }));
  const [method] = refactorCandidates(scan, { min: 0 });
  expect(method.id).toBe('src/clamp.js::clamp');
  return { repo, scan, method };
}
const options = (repo, method, extra) => ({ method, root: repo.root, out: repo.out, analyzer, shell, systemOne: scriptedSystemOne(), model: scriptedModel(), ...extra });

describe('perch refactor', () => {
  it('finds the comment block above a method, picks candidates by file risk, and gates on the file score', async () => {
    expect(regionStart(['// a', '// b', 'function f() {}'], 3)).toBe(1);
    expect(regionStart(['x', '', 'function f() {}'], 3)).toBe(3);
    expect(improves({ risk_score: 50, cyclomatic_complexity: 3, max_nesting: 1 }, { risk_score: 40, cyclomatic_complexity: 3, max_nesting: 1 })).toBe(true);
    expect(improves({ risk_score: 50, cyclomatic_complexity: 3, max_nesting: 1 }, { risk_score: 50, cyclomatic_complexity: 2, max_nesting: 1 })).toBe(false);
    expect(improves({ risk_score: 50, cyclomatic_complexity: 3, max_nesting: 1 }, { risk_score: 40, cyclomatic_complexity: 4, max_nesting: 1 })).toBe(false);
    const { scan } = await scanned();
    expect(refactorCandidates(scan, { min: 99 })).toEqual([]);
    expect(refactorCandidates(scan, { min: 0, path: 'test' })).toEqual([]);
    expect(refactorCandidates(scan, { min: 0, path: 'src' }).map(method => method.id)).toEqual(['src/clamp.js::clamp']);
    expect(refactorCandidates(scan, { min: 0 })[0].file.risk_score).toBeTypeOf('number');
    // Candidates follow the file ranking, then the method's own risk within the file.
    const ranked = refactorCandidates({ files: [
      { path: 'a.js', test: false, metrics: { risk_score: 40 }, methods: [{ id: 'a.js::x', metrics: { risk_score: 90 } }] },
      { path: 'b.js', test: false, metrics: { risk_score: 80 }, methods: [{ id: 'b.js::y', metrics: { risk_score: 10 } }, { id: 'b.js::z', metrics: { risk_score: 30 } }] },
    ], candidates: [{ id: 'a.js::x' }, { id: 'b.js::z' }, { id: 'b.js::y' }] }, { min: 0 });
    expect(ranked.map(method => method.id)).toEqual(['b.js::z', 'b.js::y', 'a.js::x']);
    expect(refactorCandidates({ files: ranked.length ? [] : [], candidates: [] }, { min: 70 })).toEqual([]);
    // Module scope is the file outside its methods: constants and the like, never imports, blanks, or comments.
    expect(moduleScope(['import x from "y";', 'const LIMIT = 3;', '// note', '', 'function f() {', '  return LIMIT;', '}'], [{ line: 5, end_line: 7 }])).toBe('L0002| const LIMIT = 3;');
    expect(moduleScope(['function f() {}'], [{ line: 1, end_line: 1 }])).toBeNull();
  });

  it('simplifies a method by its metrics, keeps its tests green, and commits on the current branch', async () => {
    const { repo, method } = await scanned();
    const model = scriptedModel(), systemOne = scriptedSystemOne();
    const lines = [];
    const ui = createUi({ live: false, log: text => lines.push(text) });
    const record = await runRefactor(options(repo, method, { model, systemOne, ui }));
    expect(record.status).toBe('ready');
    expect(record.kind).toBe('refactor');
    expect(record.before.cyclomatic_complexity).toBe(3);
    expect(record.after.cyclomatic_complexity).toBe(2);
    expect(record.file_before.cyclomatic_complexity).toBe(3);
    expect(record.file_after.cyclomatic_complexity).toBe(2);
    expect(record.file_after.risk_score).toBeLessThan(record.file_before.risk_score);
    expect(record.checks).toEqual(['test/clamp.test.js']);
    expect(record.proof).toEqual({ checks: ['test/clamp.test.js'] });
    expect(record.region).toEqual({ start: 1, end: 5 });
    expect(record.turns).toBe(1);
    expect(record.branch).toBe('work');
    expect(record.commit).toBe(await revision(repo.root));
    expect((await git(['log', '-1', '--format=%s%n%n%b'], repo.root)).trim()).toBe(`Drop the branch that returns v unchanged\n\nperch refactor src/clamp.js::clamp`);
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toBe(leanerSource + '\n');
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');

    // The model ran as an agent over the region with the metrics and the neighborhood; it measured, ran the tests, and submitted one source. No test ran before it asked.
    expect(model.calls.map(call => call.name)).toEqual(['measure', 'run_tests', 'submit']);
    expect(systemOne.calls).toEqual([]);
    expect(model.calls.every(call => call.arguments.source === leanerSource)).toBe(true);
    expect(model.calls[0].prompt).toContain('using the tools: measure every version you write');
    expect(model.calls[0].prompt).toContain('cyclomatic complexity 3, max nesting 1, 5 lines');
    expect(model.calls[0].prompt).toContain('ORIGINAL, lines 1-5');
    expect(model.calls[0].prompt).toContain('"called_by"');
    expect(record.trace.find(event => event.type === 'tool_result' && event.name === 'measure').result).toMatchObject({ ok: true, file: expect.stringMatching(/^risk \d+ -> \d+, complexity 3 -> 2, nesting 1 -> 1, maintainability \d+ -> \d+, lines 5 -> 4$/), method: expect.stringMatching(/complexity 3 -> 2/) });
    expect(model.calls[0].prompt).toContain('THE MEASURE: the file\'s tree-sitter score');
    expect(model.calls[0].prompt).toMatch(/The file today: risk score \d+ \(0-100, lower is better\)/);
    // Each step was reported as the model's call; the record prints its metrics and commit.
    expect(lines.some(line => /on the original/.test(line))).toBe(false);
    expect(lines.some(line => /^scripted-model working on clamp \(effort max\)/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ scripted-model ▸ tree-sitter measure — file risk \d+ -> \d+, complexity 3 -> 2, nesting 1 -> 1/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ scripted-model ▸ tests — 1 pass/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ [0-9a-f]{7} Drop the branch that returns v unchanged  \(file risk/.test(line))).toBe(true);
    const text = formatFix(record);
    expect(text).toContain('perch refactor');
    expect(text).toContain('file after:  risk');
    expect(text).toContain('complexity 3 -> 2');
    expect(text).toContain(`committed: ${record.commit.slice(0, 7)} on work`);

    // The store knows the method was refactored, and a rerun reuses the record.
    expect((await openStore(repo.out).listRefactors()).map(item => item.status)).toEqual(['ready']);
    const again = scriptedModel();
    expect((await runRefactor(options(repo, method, { model: again }))).id).toBe(record.id);
    expect(again.calls).toHaveLength(0);
  });

  it('rejects an unchanged region, a rewrite that does not measure better, one that breaks a test, and one that drops the method; a test already failing on the original is ignored; the checkout is left as it was', async () => {
    const { repo, method } = await scanned();
    const attempt = (name, extra) => runRefactor(options(repo, method, { ...extra, model: { ...(extra.model ?? scriptedModel()), id: name } }));

    const unchanged = await attempt('unchanged', { model: scriptedModel({ refactor: () => ({ source: buggySource.trimEnd(), summary: 'nothing to do' }) }) });
    expect(unchanged.status).toBe('rejected');
    expect(unchanged.error).toBe('the source is unchanged');
    expect(unchanged.turns).toBe(3);

    const noBetter = await attempt('nobetter', { model: scriptedModel({ refactor: () => ({ source: documentedSource, summary: 'comment only' }) }) });
    expect(noBetter.error).toMatch(/^the file's score must come down: risk lower, complexity and nesting no higher\./);
    expect(noBetter.trace.at(-1).result.file).toMatch(/complexity 3 -> 3, nesting 1 -> 1/);

    const broken = await attempt('broken', { model: scriptedModel({ refactor: () => ({ source: leanerSource.replace('if (v < lo) return lo;', 'if (v < lo) return v;'), summary: 'oops' }) }) });
    expect(broken.error).toBe('test/clamp.test.js fails on the rewrite and passes on the original');
    expect(broken.trace.at(-1).result.output).toMatch(/not ok|AssertionError/);

    const renamed = await attempt('renamed', { model: scriptedModel({ refactor: () => ({ source: leanerSource.replace('function clamp', 'function clip'), summary: 'rename' }) }) });
    expect(renamed.error).toBe('the rewrite must keep a method named clamp in lines 1-5; found clip');

    // A test that already fails on the original is not the rewrite's fault: it is ignored, and the others still have to pass.
    await writeFile(join(repo.root, 'test', 'clamp.broken.test.js'), `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { clamp } from '../src/clamp.js';\ntest('wrong on purpose', () => { assert.strictEqual(clamp(1, 0, 10), 2); });\n`);
    await commitAll(repo.root, 'a broken test');
    const rescan = await runScan(fixtureOptions({ ...repo, revision: await revision(repo.root) }, { analyzer }));
    const [again] = refactorCandidates(rescan, { min: 0 });
    const tolerant = await runRefactor(options(repo, again, { model: { ...scriptedModel(), id: 'tolerant' } }));
    expect(tolerant.status).toBe('ready');
    expect(tolerant.proof.checks).toEqual(['test/clamp.test.js']);
    expect(tolerant.trace.find(event => event.type === 'tool_result' && event.name === 'run_tests').result).toEqual({ ok: true, checks: ['test/clamp.test.js'], ignored_already_failing: ['test/clamp.broken.test.js'] });
    await git(['reset', '-q', '--hard', 'HEAD~1'], repo.root);
    await git(['reset', '-q', '--hard', 'HEAD~1'], repo.root);

    expect((await openStore(repo.out).readEvents()).filter(event => event.type === 'refactored').map(event => event.status)).toEqual([...Array(4).fill('rejected'), 'ready']);
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toBe(buggySource);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
  }, 60_000);

  it('works the riskiest methods from the scan, up to the budget and under a path, skipping ones already done', async () => {
    const { repo } = await scanned();
    const shared = { root: repo.root, out: repo.out, analyzer, shell, systemOne: scriptedSystemOne(), model: scriptedModel() };
    const none = await runRefactorQueue({ ...shared, min: 99 });
    expect(none).toMatchObject({ kind: 'refactor', open: 0, attempted: 0, fixes: [] });
    expect(formatFixes(none)).toBe('No methods at risk 99 or more left to refactor.');
    const elsewhere = await runRefactorQueue({ ...shared, min: 0, path: 'test' });
    expect(elsewhere.attempted).toBe(0);
    // A model that cannot improve it leaves a rejected record, and the same method under the same model is not retried.
    const stubborn = scriptedModel({ refactor: () => ({ source: buggySource.trimEnd(), summary: 'no' }) });
    const rejected = await runRefactorQueue({ ...shared, min: 0, path: 'src', budget: 5, model: stubborn });
    expect(rejected.attempted).toBe(1);
    expect(rejected.fixes[0].status).toBe('rejected');
    expect((await runRefactorQueue({ ...shared, min: 0, path: 'src', budget: 5, model: stubborn })).attempted).toBe(0);
    // Another model gets its turn; once the method is committed simpler, its new shape is a new candidate.
    const batch = await runRefactorQueue({ ...shared, min: 0, path: 'src', budget: 5, model: { ...scriptedModel(), id: 'better-model' } });
    expect(batch.attempted).toBe(1);
    expect(batch.fixes[0].status).toBe('ready');
    expect(formatFixes(batch)).toMatch(/^Simplified 1 methods \(budget 5\); 1 committed\./);
  }, 60_000);

  it('refuses a protected branch, a dirty file, and a method with no passing test to check against', async () => {
    const { repo, method } = await scanned();
    await git(['checkout', '-q', 'main'], repo.root);
    await expect(runRefactor(options(repo, method, {}))).rejects.toThrow('main is protected');
    await git(['checkout', '-q', 'work'], repo.root);
    await writeFile(join(repo.root, 'src', 'clamp.js'), buggySource + '\n');
    await expect(runRefactor(options(repo, method, { model: { ...scriptedModel(), id: 'dirty' } }))).rejects.toThrow('uncommitted changes');
    await git(['checkout', '--', 'src/clamp.js'], repo.root);
    await rm(join(repo.root, 'test', 'clamp.test.js'));
    await writeFile(join(repo.root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' }) + '\n');
    await commitAll(repo.root, 'no tests');
    const rescan = await runScan(fixtureOptions({ ...repo, revision: await revision(repo.root) }, { analyzer }));
    const [bare] = refactorCandidates(rescan, { min: 0 });
    await expect(runRefactor(options(repo, bare, { model: { ...scriptedModel(), id: 'untested' } }))).rejects.toThrow('No test reaches clamp and no suite command');
  });
});
