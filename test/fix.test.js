import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { runHunt } from '../src/hunt.js';
import { pendingFixes, runFix, runFixQueue, splitStale, underPath } from '../src/fix.js';
import { huntAnswers } from '../src/prompts.js';
import { createShell, runScript } from '../src/shell.js';
import { openStore } from '../src/store.js';
import { formatFinding, formatFix, formatFixes, formatIssues } from '../src/report.js';
import { createUi } from '../src/ui.js';
import { buggySource, commitAll, fixedMethod, fixedSource, fixtureOptions, makeFixture, scriptedModel, scriptedSystemOne } from './helpers.js';

const analyzer = createSourceAnalyzer();
const shell = createShell();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** The clamp fixture hunted once, so it has a finding for clamp pointing at the upper-bound line. */
async function huntedFixture() {
  const root = await makeFixture();
  cleanups.push(root);
  const repo = { root, revision: await revision(root), out: join(root, '.perch') };
  const hunt = await runHunt(fixtureOptions(repo, { analyzer, systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.9, where: 'L0003', kind_wrong_return: 0.9, severity: 2 } }) }));
  return { repo, finding: hunt.visited[0] };
}

const fixOptions = (repo, finding, extra) => ({ finding, root: repo.root, out: repo.out, analyzer, shell, systemOne: scriptedSystemOne(), model: scriptedModel(), ...extra });
const proposal = (method, summary = 'attempt') => ({ method, summary });

describe('perch fix', () => {
  it('queues open defects up to the budget, under a path when given, and sets stale findings aside', async () => {
    const defect = extra => ({ has_bug: 0.9, kind: { kind: 'boundary' }, ...extra });
    const design = extra => ({ has_bug: 0.1, refactor: { refactor: 'split', probabilities: { split: 0.8 } }, ...extra });
    const open = defect({ id: 'aaaa1111', path: 'src/a.js' });
    const ready = defect({ id: 'bbbb2222', path: 'src/b.js', fix: { status: 'ready' } });
    const rejected = defect({ id: 'cccc3333', path: 'src/c.js', fix: { status: 'rejected' } });
    const messy = design({ id: 'ffff6666', path: 'lib/f.js' });
    const later = defect({ id: 'eeee5555', path: 'lib/e.js' });
    expect(pendingFixes([open, ready, rejected, messy, later], 1).map(finding => finding.id)).toEqual(['aaaa1111']);
    expect(pendingFixes([open, ready, messy, later], 5).map(finding => finding.id)).toEqual(['aaaa1111', 'eeee5555']);
    expect(underPath([open, messy, later], 'lib').map(finding => finding.id)).toEqual(['ffff6666', 'eeee5555']);
    expect(underPath([open, messy, later], 'lib/e.js').map(finding => finding.id)).toEqual(['eeee5555']);
    const scan = { files: [{ path: 'src/a.js', methods: [{ id: 'src/a.js::f', hash: 'same' }] }] };
    const { current, stale } = splitStale([{ method: 'src/a.js::f', hash: 'same' }, { method: 'src/a.js::f', hash: 'old' }, { method: 'gone.js::g', hash: 'x' }], scan);
    expect(current).toHaveLength(1);
    expect(stale).toHaveLength(2);
    expect(formatFixes({ kind: 'fix', budget: 5, remaining: 3, stale: 2, fixes: [] })).toBe('No open defects to fix. 2 findings are for methods that changed since the hunt; hunt again to refresh them.');
    const queued = await runFixQueue({ findings: [defect({ id: 'a1', method: 'm', path: 'src/a.js', revision: 'r' }), defect({ id: 'b2', method: 'n', path: 'src/b.js', revision: 'r' })], budget: 1, root: null, out: '/tmp', model: { id: 'x' }, systemOne: { id: 'y' }, analyzer: {}, shell: {} });
    expect(queued.attempted).toBe(1);
    expect(queued.remaining).toBe(1);
    expect(queued.fixes[0]).toMatchObject({ finding_id: 'a1', status: 'failed', error: 'finding a1 has no repository recorded; hunt again' });
  });

  it('tells the model everything System One answered, with probabilities', () => {
    const finding = { has_bug: 0.63, where: { line: 48, confidence: 0.71, text: 'return null;' }, kind: { kind: 'swallowed_error', probability: 0.6 }, kinds: { swallowed_error: 0.6, wrong_return: 0.4, boundary: 0.1 },
      severity: { level: 'major', confidence: 0.55 }, misuse: [{ callee: 'src/gh.js::gh', probability: 0.7 }], misused_by: [{ caller: 'src/cli.js::publish', probability: 0.3 }], does_what_it_claims: 0.8, misdocumented: 0.53, refactor: { refactor: 'split', probabilities: { split: 0.84, none: 0.1, flatten: 0.05 } } };
    const text = huntAnswers(finding, { reachable: 0.88 });
    expect(text).toContain('reachable behavioral defect: 63%; the flagged line is reachable by a real caller: 88%');
    expect(text).toContain('line 48 is where it is (confidence 71%): return null;');
    expect(text).toContain('defect kinds, most likely first: swallowed error 60%, wrong return 40%, boundary 10%');
    expect(text).toContain('severity if real: major (confidence 55%)');
    expect(text).toContain("misuses a callee's contract: gh 70%");
    expect(text).toContain('a caller misuses this method or relies on what it does not guarantee: publish 30%');
    expect(text).toContain('does what its name and comment claim: 80%; misdocumented: 53%');
    expect(text).toContain('refactor it most needs: split 84%, none 10%, flatten 5%');
  });

  it('refuses to commit on a protected branch', async () => {
    const { repo, finding } = await huntedFixture();
    await git(['checkout', '-q', 'main'], repo.root);
    await expect(runFix(fixOptions(repo, finding, {}))).rejects.toThrow('main is protected');
  });

  it('checks the fix by the tests that reach the method and by System One, commits it, records it, and reuses it on rerun', async () => {
    const { repo, finding } = await huntedFixture();
    const model = scriptedModel(), systemOne = scriptedSystemOne();
    const lines = [];
    const fix = await runFix(fixOptions(repo, finding, { model, systemOne, ui: createUi({ live: false, log: text => lines.push(text) }) }));

    expect(fix.status).toBe('ready');
    expect(fix.finding_id).toBe(finding.id);
    expect(fix.existing_tests).toEqual(['test/clamp.test.js']);
    expect(fix.project).toEqual({ single: 'node --test {file}' });
    expect(fix.reach_check).toEqual({ reachable: 0.9 });
    expect(fix.proof).toEqual({ existing_tests: ['test/clamp.test.js'], baseline_failures: [], command: 'node --test {file}' });
    expect(fix.verification).toEqual({ kind: 'wrong_return', before: { has_bug: 0.9, kind: 0.9, reachable: 0.9 }, after: { has_bug: 0.2, kind: 0.2, severity: 1, collateral_change: 0.2, misused_by: [] } });
    expect(fix.attempts).toHaveLength(1);
    expect(fix.attempts[0]).toMatchObject({ attempt: 1, effort: 'none', existing_tests: '1 passed', method: fixedMethod });

    // The model saw System One's answers and the hunt's neighborhood, and returned only the method; System One judged reachability first and the patch last.
    expect(model.calls.map(call => call.id)).toEqual(['fix-1']);
    expect(model.calls[0].prompt).toContain('Return {"method":string,"summary":string}');
    expect(model.calls[0].prompt).toContain('reachable behavioral defect: 90%; the flagged line is reachable by a real caller: 90%');
    expect(model.calls[0].prompt).toContain('defect kinds, most likely first: wrong return 90%');
    expect(model.calls[0].prompt).toContain('"called_by"');
    expect(model.calls[0].prompt).not.toContain('test_path');
    expect(systemOne.calls.map(call => call.method)).toEqual(['src/clamp.js::clamp', 'src/clamp.js::clamp']);
    expect(systemOne.calls[0].questions.reachable).toBeDefined();
    expect(systemOne.calls[0].state.module_scope).toBeNull();
    expect(systemOne.calls[1].state.method.source).toContain('L0003|   if (v > hi) return hi;');
    expect(systemOne.calls[1].state.original_method).toBe(buggySource.trimEnd());
    expect(Object.keys(systemOne.calls[1].questions)).toEqual(expect.arrayContaining(['has_bug', 'kind_wrong_return', 'collateral_change']));
    expect(Object.keys(systemOne.calls[1].questions)).not.toEqual(expect.arrayContaining(['where', 'follow', 'refactor']));

    // One commit on the current branch carrying the method; the checkout is clean, no worktree was made.
    expect(fix.branch).toBe('work');
    expect(fix.commit).toBe(await revision(repo.root));
    expect((await git(['log', '-1', '--format=%s%n%n%b'], repo.root)).trim()).toBe(`Return hi when v exceeds the upper bound.\n\nperch ${finding.id}`);
    expect((await git(['diff', '--name-only', 'HEAD~1', 'HEAD'], repo.root)).trim()).toBe('src/clamp.js');
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toBe(fixedSource);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect(existsSync(join(repo.out, 'workspaces'))).toBe(false);
    expect((await git(['worktree', 'list'], repo.root)).trim().split('\n')).toHaveLength(1);
    expect((await runScript('node --test test/clamp.test.js', { cwd: repo.root, timeoutMs: 30_000 })).exit_code).toBe(0);
    expect(await readFile(fix.patch_path, 'utf8')).toContain('+  if (v > hi) return hi;');

    // Every step was reported with a mark.
    expect(lines.some(line => /^✓ scripted-jev: can a caller reach src\/clamp.js:3\? — reachable 90%/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ test\/clamp.test.js on the original — passes/.test(line))).toBe(true);
    expect(lines.some(line => /^attempt 1 of 3: scripted-model writing the fix \(effort none\)/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ 1 test on the patch — all pass/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ scripted-jev comparing the patched method \(defect was 90%\) — defect 90% -> 20%, wrong return 90% -> 20%, collateral 20%/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ committed [0-9a-f]{7} on work: Return hi/.test(line))).toBe(true);

    // The record is in the events log, so issues shows the finding as fixed.
    const store = openStore(repo.out);
    expect((await store.readEvents()).at(-1)).toMatchObject({ type: 'fixed', id: finding.id, fix_id: fix.id, method: 'src/clamp.js::clamp', status: 'ready', commit: fix.commit, branch: 'work' });
    const [listed] = await store.findings();
    expect(listed.fix).toMatchObject({ id: fix.id, commit: fix.commit, verification: fix.verification });
    expect(formatIssues([listed], 0.5)).toMatch(new RegExp(`Status  Commit\\n.*open +${fix.commit.slice(0, 7)}`));
    expect(formatFinding(listed)).toContain('Fixed: Return hi when v exceeds the upper bound. (defect 90% -> 20%)');
    const text = formatFix(fix);
    expect(text).toContain('checked: 1 existing test still pass; reachable 90% before the fix');
    expect(text).toContain('verified by scripted-jev: defect 90% -> 20%, wrong return 90% -> 20%, collateral change 20%');
    expect(text).toContain(`committed: ${fix.commit.slice(0, 7)} on work`);

    const again = scriptedModel();
    expect((await runFix(fixOptions(repo, finding, { model: again }))).id).toBe(fix.id);
    expect(again.calls).toHaveLength(0);
  });

  it('discards an unreachable finding after a System One precheck, without calling the generative model', async () => {
    const { repo, finding } = await huntedFixture();
    const model = scriptedModel();
    const systemOne = scriptedSystemOne({ 'src/clamp.js::clamp': { reachable: 0.15 } });
    const fix = await runFix(fixOptions(repo, finding, { model, systemOne }));
    expect(fix.status).toBe('rejected');
    expect(fix.reach_check).toEqual({ reachable: 0.15 });
    expect(fix.error).toContain('not clearly reachable (15%)');
    expect(model.calls).toHaveLength(0);
    expect(systemOne.calls).toHaveLength(1);
  });

  it('withholds perch\'s own keys from test runs and does not blame the patch for a test that already fails on the original', async () => {
    const root = await makeFixture();
    cleanups.push(root);
    await writeFile(join(root, 'test', 'clamp.broken.test.js'), `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { clamp } from '../src/clamp.js';\ntest('wrong on purpose', () => { assert.strictEqual(clamp(1, 0, 10), 2); });\n`);
    await writeFile(join(root, 'test', 'clamp.env.test.js'), `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { clamp } from '../src/clamp.js';\ntest('no perch keys in the environment', () => { clamp(1, 0, 10); assert.strictEqual(process.env.OPENAI_API_KEY, undefined); assert.strictEqual(process.env.TYPESAFE_API_KEY, undefined); assert.strictEqual(process.env.PERCH_FIXTURE_MARKER, 'kept'); });\n`);
    await commitAll(root, 'more tests');
    const repo = { root, revision: await revision(root), out: join(root, '.perch') };
    const hunt = await runHunt(fixtureOptions(repo, { analyzer, systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.9, where: 'L0003', kind_wrong_return: 0.9 } }) }));
    const saved = { ...process.env };
    Object.assign(process.env, { OPENAI_API_KEY: 'sk-leak', TYPESAFE_API_KEY: 'ts-leak', PERCH_FIXTURE_MARKER: 'kept' });
    let fix;
    try { fix = await runFix(fixOptions(repo, hunt.visited[0], {})); }
    finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
    expect(fix.status).toBe('ready');
    expect(fix.existing_tests).toEqual(['test/clamp.broken.test.js', 'test/clamp.env.test.js', 'test/clamp.test.js']);
    expect(fix.baseline_failures).toEqual(['test/clamp.broken.test.js']);
    expect(fix.proof.existing_tests).toEqual(['test/clamp.env.test.js', 'test/clamp.test.js']);
    expect(fix.attempts[0].existing_tests).toBe('2 passed');
    expect(formatFix(fix)).toContain('2 existing tests still pass (test/clamp.broken.test.js already failed on the original and did not count)');
  });

  it('fixes a method no test reaches on System One and the metrics alone', async () => {
    const root = await makeFixture();
    cleanups.push(root);
    await rm(join(root, 'test', 'clamp.test.js'));
    await commitAll(root, 'no clamp test');
    const repo = { root, revision: await revision(root), out: join(root, '.perch') };
    const hunt = await runHunt(fixtureOptions(repo, { analyzer, systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.9, where: 'L0003', kind_wrong_return: 0.9 } }) }));
    const lines = [];
    const fix = await runFix(fixOptions(repo, hunt.visited[0], { ui: createUi({ live: false, log: text => lines.push(text) }) }));
    expect(fix.status).toBe('ready');
    expect(fix.existing_tests).toEqual([]);
    expect(lines.some(line => /no passing test reaches clamp; the patch is checked by its metrics and scripted-jev alone/.test(line))).toBe(true);
    expect(formatFix(fix)).toContain('no existing test reaches the method');
  });

  it('feeds a rejected attempt back to the model with more effort and accepts the next one', async () => {
    const { repo, finding } = await huntedFixture();
    const model = scriptedModel({ fix: id => (id === 'fix-1' ? proposal(buggySource.trimEnd(), 'nothing wrong here') : proposal(fixedMethod)) });
    const fix = await runFix(fixOptions(repo, finding, { model }));
    expect(fix.status).toBe('ready');
    expect(fix.attempts.map(attempt => attempt.attempt)).toEqual([1, 2]);
    expect(fix.attempts.map(attempt => attempt.effort)).toEqual(['none', 'low']);
    expect(fix.attempts[0].rejected).toBe('the method was returned unchanged: nothing wrong here');
    expect(model.calls[1].prompt).toContain('YOUR PREVIOUS ATTEMPT WAS REJECTED: the method was returned unchanged');
    expect(formatFix(fix)).toContain('attempts: 2; attempt 1 rejected: the method was returned unchanged');
  });

  it('rejects an unchanged method, one that adds nesting, one that breaks an existing test, and one System One does not think improved; the checkout is left as it was', async () => {
    const { repo, finding } = await huntedFixture();
    const attempt = async (name, extra) => runFix(fixOptions(repo, finding, { ...extra, model: { ...(extra.model ?? scriptedModel()), id: name } }));

    const unchanged = scriptedModel({ fix: () => proposal(buggySource.trimEnd(), 'no caller can pass v above hi') });
    const noop = await attempt('unchanged', { model: unchanged });
    expect(noop.status).toBe('rejected');
    expect(noop.error).toBe('the method was returned unchanged: no caller can pass v above hi');
    expect(unchanged.calls.map(call => call.id)).toEqual(['fix-1', 'fix-2', 'fix-3']);
    expect(noop.attempts.map(item => item.effort)).toEqual(['none', 'low', 'medium']);

    const nested = await attempt('nested', { model: scriptedModel({ fix: () => proposal(fixedMethod.replace('  if (v > hi) return hi;', '  if (v > hi) {\n    if (hi >= lo) return hi;\n  }')) }) });
    expect(nested.status).toBe('rejected');
    expect(nested.error).toMatch(/^the patch adds nesting, more than one branch, or more than one point of risk \(.*nesting 1 -> 2\)$/);

    const breaking = await attempt('breaking', { model: scriptedModel({ fix: () => proposal(fixedMethod.replace('  return v;', '  return hi;')) }) });
    expect(breaking.status).toBe('rejected');
    expect(breaking.error).toMatch(/^an existing test broke on the patch: test\/clamp.test.js/);
    expect(breaking.attempts[0].existing_tests).toBe('failed');

    // The hunt rated the defect at 90%; a patch the model does not think lowered that, or that changes other behavior, is not a fix.
    const gamed = await attempt('gamed', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.9, collateral_change: 0.7 } }) });
    expect(gamed.status).toBe('rejected');
    expect(gamed.error).toBe('the patch did not lower the defect probability (90% -> 90%); the patch may change behavior beyond the defect (70%)');
    const worse = await attempt('worse', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.95, kind_wrong_return: 0.9 } }) });
    expect(worse.error).toBe('the patch did not lower the defect probability (90% -> 95%); the wrong return defect looks no less likely (90% -> 90%)');
    // A patch that lowers it, even to a number the model is unsure of, is one.
    const improved = await attempt('improved', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.46 } }) });
    expect(improved.status).toBe('ready');
    await git(['reset', '-q', '--hard', 'HEAD~1'], repo.root);

    const store = openStore(repo.out);
    expect((await store.readEvents()).filter(event => event.type === 'fixed').map(event => event.status)).toEqual([...Array(5).fill('rejected'), 'ready']);
    await store.appendEvent({ type: 'fixed', at: new Date().toISOString(), id: finding.id, fix_id: worse.id, method: finding.method, hash: finding.hash, revision: finding.revision, status: 'rejected', attempts: 3, error: worse.error });
    const [discarded] = await store.findings();
    expect(discarded.fix).toMatchObject({ id: worse.id, status: 'rejected', attempts: 3, error: worse.error });
    expect(formatIssues([discarded], 0.5)).toBe('No open issues at 50% or more. 1 closed; --closed to list them.');
    expect(formatIssues([discarded], 0.5, 10, { closed: true })).toMatch(/Status  Commit\n.*closed +-/);
    expect(formatFinding(discarded)).toContain('Status: closed');
    expect(formatFinding(discarded)).toContain('Fix discarded: no fix after 3 attempts');
    expect((await git(['worktree', 'list'], repo.root)).trim().split('\n')).toHaveLength(1);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toBe(buggySource);
  }, 60_000);

  it('refuses a dirty method file or dirty reaching tests, and reports a checkout that changes under it instead of blaming the patch', async () => {
    const { repo, finding } = await huntedFixture();
    await writeFile(join(repo.root, 'test', 'clamp.test.js'), (await readFile(join(repo.root, 'test', 'clamp.test.js'), 'utf8')) + '\n');
    await expect(runFix(fixOptions(repo, finding, {}))).rejects.toThrow('test/clamp.test.js has uncommitted changes');
    await git(['checkout', '--', 'test/clamp.test.js'], repo.root);
    // A shell whose test run breaks the test file itself: the patch is not at fault, and perch says so.
    const sabotage = { run: async (script, options) => { await writeFile(join(repo.root, 'test', 'clamp.test.js'), 'throw new Error("changed under perch");\n'); return shell.run(script, options); } };
    const first = { run: shell.run };
    let calls = 0;
    const flaky = { run: (script, options) => (++calls <= 1 ? first.run(script, options) : sabotage.run(script, options)) };
    await expect(runFix(fixOptions(repo, finding, { shell: flaky, model: { ...scriptedModel(), id: 'flaky' } }))).rejects.toThrow('the checkout changed while perch fix was running');
    await git(['checkout', '--', 'test/clamp.test.js', 'src/clamp.js'], repo.root);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
  });
});
