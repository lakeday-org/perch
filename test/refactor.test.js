import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { runHunt } from '../src/hunt.js';
import { regionStart, runRefactor, withinRefactorGate } from '../src/refactor.js';
import { createShell } from '../src/shell.js';
import { openStore } from '../src/store.js';
import { formatFinding, formatFix, formatIssues } from '../src/report.js';
import { buggySource, documentedSource, fixtureOptions, makeFixture, scriptedModel, scriptedSystemOne } from './helpers.js';

const analyzer = createSourceAnalyzer();
const shell = createShell();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** The clamp fixture hunted once with no defect but a documentation and a refactor issue. */
async function hunted() {
  const root = await makeFixture();
  cleanups.push(root);
  const repo = { root, revision: await revision(root), out: join(root, '.perch') };
  const hunt = await runHunt(fixtureOptions(repo, { analyzer, systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.2, misdocumented: 0.8, refactor: 'simplify_conditions' } }) }));
  return { repo, finding: hunt.visited[0] };
}
const options = (repo, finding, extra) => ({ finding, root: repo.root, out: repo.out, analyzer, shell, systemOne: scriptedSystemOne(), model: scriptedModel(), ...extra });

describe('perch refactor', () => {
  it('finds the comment block above a method and gates on file metrics', () => {
    expect(regionStart(['// a', '// b', 'function f() {}'], 3)).toBe(1);
    expect(regionStart(['x', '', 'function f() {}'], 3)).toBe(3);
    expect(withinRefactorGate({ risk_score: 50, cyclomatic_complexity: 10, max_nesting: 3 }, { risk_score: 50.5, cyclomatic_complexity: 10, max_nesting: 2 })).toBe(true);
    expect(withinRefactorGate({ risk_score: 50, cyclomatic_complexity: 10, max_nesting: 3 }, { risk_score: 50, cyclomatic_complexity: 11, max_nesting: 3 })).toBe(false);
  });

  it('lists design issues alongside defects, rewrites the method region, keeps its tests green, and commits on the current branch', async () => {
    const { repo, finding } = await hunted();
    const store = openStore(repo.out);
    expect(await store.findings()).toEqual([]);
    const [issue] = await store.issues();
    expect(issue.id).toBe(finding.id);
    expect(formatIssues([issue], 0.5)).toContain('simplify conditions 80%, misdocumented 80%');
    expect(formatIssues([issue], 0.5)).toMatch(/src\/clamp.js:1 .*- +open/);

    const model = scriptedModel(), systemOne = scriptedSystemOne();
    const record = await runRefactor(options(repo, finding, { model, systemOne }));
    expect(record.status).toBe('ready');
    expect(record.kind).toBe('refactor');
    expect(record.issues.map(item => item.type).sort()).toEqual(['misdocumented', 'refactor']);
    expect(record.checks).toEqual(['test/clamp.test.js']);
    expect(record.region).toEqual({ start: 1, end: 5 });
    expect(record.branch).toBe('work');
    expect(record.commit).toBe(await revision(repo.root));
    expect((await git(['log', '-1', '--format=%s%n%n%b'], repo.root)).trim()).toBe(`Document what clamp returns at each bound.\n\nperch ${finding.id}`);
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toBe(documentedSource + '\n');
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');

    // The model saw the issues, the region, and the neighborhood; System One compared the two versions with the same neighborhood.
    expect(model.calls.map(call => call.id)).toEqual(['refactor-1']);
    expect(model.calls[0].prompt).toContain('WHAT NEEDS IMPROVING: simplify conditions (80%); misdocumented (80%)');
    expect(model.calls[0].prompt).toContain('ORIGINAL, lines 1-5');
    expect(model.calls[0].prompt).toContain('"called_by"');
    const check = systemOne.calls.at(-1);
    expect(check.state.original_source).toBe(buggySource.trimEnd());
    expect(check.state.method.source).toContain('L0002| export function clamp(v, lo, hi) {');
    expect(check.state.method.leading_comment).toContain('Clamp v into [lo, hi]');
    expect(Object.keys(check.questions).sort()).toEqual(['collateral_change', 'does_what_it_claims', 'has_bug', 'misdocumented', 'refactor']);

    const [listed] = await store.issues();
    expect(listed.refactored).toMatchObject({ id: record.id, status: 'ready', commit: record.commit });
    expect(formatFinding(listed)).toContain('Refactored: Document what clamp returns at each bound.');
    expect(formatFix(record)).toContain(`committed: ${record.commit.slice(0, 7)} on work`);
    expect(formatFix(record)).toContain('checked by: test/clamp.test.js');
    expect((await runRefactor(options(repo, finding, { model: scriptedModel() }))).id).toBe(record.id);
  });

  it('rejects an unchanged region, a rewrite that breaks a test, and one System One says changes behavior or reads no better, leaving the checkout as it was', async () => {
    const { repo, finding } = await hunted();
    const attempt = (name, extra) => runRefactor(options(repo, finding, { ...extra, model: { ...(extra.model ?? scriptedModel()), id: name } }));

    const unchanged = await attempt('unchanged', { model: scriptedModel({ refactor: () => ({ source: buggySource.trimEnd(), summary: 'nothing to do' }) }) });
    expect(unchanged.status).toBe('rejected');
    expect(unchanged.error).toBe('the source was returned unchanged: nothing to do');

    const broken = await attempt('broken', { model: scriptedModel({ refactor: () => ({ source: documentedSource.replace('if (v < lo) return lo;', 'if (v < lo) return v;'), summary: 'oops' }) }) });
    expect(broken.error).toMatch(/^a test broke on the rewrite: test\/clamp.test.js/);

    const renamed = await attempt('renamed', { model: scriptedModel({ refactor: () => ({ source: documentedSource.replace('function clamp', 'function clip'), summary: 'rename' }) }) });
    expect(renamed.error).toBe('the rewrite must keep a method named clamp in lines 1-6; found clip');

    const behavior = await attempt('behavior', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { collateral_change: 0.8 } }) });
    expect(behavior.error).toBe('the rewrite may change behavior (80%)');
    const noBetter = await attempt('nobetter', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { misdocumented: 0.85, refactor: 'simplify_conditions' } }) });
    expect(noBetter.error).toBe('the method still looks like it needs simplify conditions (80% -> 80%); the method looks no better documented (80% -> 85%)');

    const store = openStore(repo.out);
    expect((await store.readEvents()).filter(event => event.type === 'refactored').map(event => event.status)).toEqual(Array(5).fill('rejected'));
    const [discarded] = await store.issues();
    expect(discarded.refactored).toMatchObject({ status: 'rejected', attempts: 3 });
    expect(formatIssues([discarded], 0.5)).toBe('No open issues at 50% or more. 1 closed; --closed to list them.');
    expect(formatFinding(discarded)).toContain('Refactor discarded: after 3 attempts');
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toBe(buggySource);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
  }, 60_000);

  it('refuses a protected branch and a method with no design issue', async () => {
    const { repo, finding } = await hunted();
    await git(['checkout', '-q', 'main'], repo.root);
    await expect(runRefactor(options(repo, finding, {}))).rejects.toThrow('main is protected');
    await git(['checkout', '-q', 'work'], repo.root);
    await expect(runRefactor(options(repo, { ...finding, misdocumented: 0.1, refactor: { refactor: 'none', probabilities: {} } }, {}))).rejects.toThrow('no design issue');
  });
});
