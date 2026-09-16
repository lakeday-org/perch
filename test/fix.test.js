import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { runHunt } from '../src/hunt.js';
import { namedAfter, pendingFixes, removedLines, runFix, runFixQueue, suggestTestName, underPath } from '../src/fix.js';
import { createShell, runScript } from '../src/shell.js';
import { openStore } from '../src/store.js';
import { formatFinding, formatFix, formatFixes, formatIssues } from '../src/report.js';
import { buggySource, commitAll, fixedMethod, fixedSource, fixtureOptions, makeFixture, regressionCase, regressionSource, scriptedModel, scriptedSystemOne } from './helpers.js';

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
const proposal = (method, test = regressionSource, test_path = 'test/clamp.test.js') => ({ method, test, test_path, summary: 'attempt' });

describe('perch fix', () => {
  it('queues open findings of one kind up to the budget, under a path when given', async () => {
    const defect = extra => ({ has_bug: 0.9, kind: { kind: 'boundary' }, ...extra });
    const design = extra => ({ has_bug: 0.1, refactor: { refactor: 'split', probabilities: { split: 0.8 } }, ...extra });
    const open = defect({ id: 'aaaa1111', path: 'src/a.js' });
    const ready = defect({ id: 'bbbb2222', path: 'src/b.js', fix: { status: 'ready' } });
    const rejected = defect({ id: 'cccc3333', path: 'src/c.js', fix: { status: 'rejected' } });
    const closed = defect({ id: 'dddd4444', path: 'src/d.js', github_status: 'closed' });
    const messy = design({ id: 'ffff6666', path: 'lib/f.js' });
    const later = defect({ id: 'eeee5555', path: 'lib/e.js' });
    expect(pendingFixes([open, ready, rejected, closed, messy, later], 1).map(finding => finding.id)).toEqual(['aaaa1111']);
    expect(pendingFixes([open, ready, messy, later], 5).map(finding => finding.id)).toEqual(['aaaa1111', 'eeee5555']);
    expect(pendingFixes([open, messy, design({ id: 'gggg7777', path: 'lib/g.js', refactored: { status: 'ready' } })], 5, 'refactor').map(finding => finding.id)).toEqual(['ffff6666']);
    expect(underPath([open, messy, later], 'lib').map(finding => finding.id)).toEqual(['ffff6666', 'eeee5555']);
    expect(underPath([open, messy, later], 'lib/e.js').map(finding => finding.id)).toEqual(['eeee5555']);
    expect(formatFixes({ kind: 'fix', budget: 5, remaining: 3, fixes: [] })).toBe('No open defects to fix.');
    expect(formatFixes({ kind: 'refactor', budget: 3, remaining: 0, fixes: [] })).toBe('No open design issues to refactor.');
    const queued = await runFixQueue({ findings: [defect({ id: 'a1', method: 'm', path: 'src/a.js', revision: 'r' }), defect({ id: 'b2', method: 'n', path: 'src/b.js', revision: 'r' })], budget: 1, root: null, out: '/tmp', model: { id: 'x' }, systemOne: { id: 'y' }, analyzer: {}, shell: {} });
    expect(queued.attempted).toBe(1);
    expect(queued.remaining).toBe(1);
    expect(queued.fixes[0]).toMatchObject({ finding_id: 'a1', status: 'failed', error: 'finding a1 has no repository recorded; hunt again' });
  });

  it('refuses to commit on a protected branch', async () => {
    const { repo, finding } = await huntedFixture();
    await git(['checkout', '-q', 'main'], repo.root);
    await expect(runFix(fixOptions(repo, finding, {}))).rejects.toThrow('main is protected');
  });

  it('proves a fix in its own worktree, verifies the patched method, records it, and reuses it on rerun', async () => {
    const { repo, finding } = await huntedFixture();
    const model = scriptedModel(), systemOne = scriptedSystemOne();
    const fix = await runFix(fixOptions(repo, finding, { model, systemOne }));

    expect(fix.status).toBe('ready');
    expect(fix.finding_id).toBe(finding.id);
    expect(fix.test_path).toBe('test/clamp.test.js');
    expect(fix.existing_tests).toEqual(['test/clamp.test.js']);
    expect(fix.module_test).toBe('test/clamp.test.js');
    expect(fix.example_test).toBe('test/clamp.test.js');
    expect(fix.project).toEqual({ install: null, single: 'node --test {file}' });
    expect(fix.proof).toMatchObject({ fails_on_original: true, passes_on_patch: true, test_mode: 'extended', existing_tests: ['test/clamp.test.js'], command: "node --test 'test/clamp.test.js'" });
    expect(fix.verification).toEqual({ kind: 'wrong_return', before: { has_bug: 0.9, kind: 0.9 }, after: { has_bug: 0.2, kind: 0.2, severity: 1, collateral_change: 0.2, misused_by: [] } });
    const [attempt] = fix.attempts;
    expect(fix.attempts).toHaveLength(1);
    expect(attempt.before.exit_code).not.toBe(0);
    expect(attempt.before.output).toMatch(/AssertionError|not ok/);
    expect(attempt.after.exit_code).toBe(0);
    expect(attempt.existing_tests).toBe('1 passed');
    expect(attempt.test_check).toEqual({ imports_real_method: 0.9, targets_defect: 0.9, reachable_by_callers: 0.9, asserts_behavior: 0.9, passes_on_original: 0.2 });

    // The generative model saw the finding, the project's test command, an example test, and the hunt's context; System One read the test, then the patched method.
    expect(model.calls.map(call => call.id)).toEqual(['fix-1']);
    expect(model.calls[0].prompt).toContain('most likely "wrong_return" (90%), pointing at line 3');
    expect(model.calls[0].prompt).toContain('HOW THIS PROJECT RUNS ONE TEST FILE: node --test {file}');
    expect(model.calls[0].prompt).toContain("THE MODULE'S EXISTING TEST FILE, test/clamp.test.js (extend this");
    expect(model.calls[0].prompt).toContain('test_path must be test/clamp.test.js');
    expect(model.calls[0].prompt).toContain('"call_graph"');
    expect(systemOne.calls.map(call => call.method)).toEqual(['src/clamp.js::clamp', 'test', 'src/clamp.js::clamp']);
    expect(systemOne.calls[0].questions.reachable).toBeDefined();
    expect(fix.reach_check).toEqual({ reachable: 0.9 });
    expect(systemOne.calls[1].state.test.source).toBe(regressionSource);
    expect(systemOne.calls[1].state.called_by).toEqual([]);
    expect(systemOne.calls[2].state.method.source).toContain('L0003|   if (v > hi) return hi;');
    expect(systemOne.calls[2].state.original_method).toBe(buggySource.trimEnd());
    expect(Object.keys(systemOne.calls[2].questions)).toEqual(expect.arrayContaining(['has_bug', 'kind_wrong_return', 'collateral_change']));
    expect(Object.keys(systemOne.calls[2].questions)).not.toEqual(expect.arrayContaining(['where', 'follow', 'refactor']));

    // The fix is one commit on the current branch carrying the method and the test; the checkout is clean, no worktree was made, and the patch on disk matches.
    expect(fix.branch).toBe('work');
    expect(fix.commit).toBe(await revision(repo.root));
    expect((await git(['log', '-1', '--format=%s%n%n%b'], repo.root)).trim()).toBe(`Return hi when v exceeds the upper bound.\n\nperch ${finding.id}`);
    expect((await git(['diff', '--name-only', 'HEAD~1', 'HEAD'], repo.root)).trim().split('\n').sort()).toEqual(['src/clamp.js', 'test/clamp.test.js']);
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toBe(fixedSource);
    expect(await readFile(join(repo.root, 'test', 'clamp.test.js'), 'utf8')).toBe(regressionSource);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect(existsSync(join(repo.out, 'workspaces'))).toBe(false);
    expect((await git(['worktree', 'list'], repo.root)).trim().split('\n')).toHaveLength(1);
    expect((await runScript('node --test test/clamp.test.js', { cwd: repo.root, timeoutMs: 30_000 })).exit_code).toBe(0);
    const patch = await readFile(fix.patch_path, 'utf8');
    expect(patch).toContain('diff --git a/src/clamp.js b/src/clamp.js');
    expect(patch).toContain('+  if (v > hi) return hi;');
    expect(patch).toContain("+test('clamp enforces the upper bound', () => {");
    expect(patch.slice(patch.indexOf('diff --git a/test/'))).not.toMatch(/^-[^-]/m);

    // The proof is in the events log, so issues shows the finding as fixed.
    const store = openStore(repo.out);
    const events = await store.readEvents();
    expect(events.at(-1)).toMatchObject({ type: 'fixed', id: finding.id, fix_id: fix.id, method: 'src/clamp.js::clamp', status: 'ready', test_path: 'test/clamp.test.js', commit: fix.commit, branch: 'work' });
    const [listed] = await store.findings();
    expect(listed.fix).toMatchObject({ id: fix.id, test_path: 'test/clamp.test.js', commit: fix.commit, verification: fix.verification });
    expect(formatIssues([listed], 0.5)).toMatch(/Status  PR\n.*open +-/);
    expect(formatIssues([listed], 0.5)).toContain('wrong return 90%');
    expect(formatFinding(listed)).toContain('Status: open');
    expect(formatFinding(listed)).toContain('Fixed: test/clamp.test.js fails on the original');
    expect(formatFinding(listed)).toContain(`commit ${fix.commit.slice(0, 7)} on work`);
    const text = formatFix(fix);
    expect(text).toContain('proof: test/clamp.test.js fails on the original with an assertion and passes on the patch; 1 existing test still pass');
    expect(text).toContain('verified by scripted-jev: reachable defect 90% -> 20%, wrong return 90% -> 20%, collateral change 20%');
    expect(text).toContain(`committed: ${fix.commit.slice(0, 7)} on work`);

    const again = scriptedModel();
    expect((await runFix(fixOptions(repo, finding, { model: again }))).id).toBe(fix.id);
    expect(again.calls).toHaveLength(0);
    expect((await store.listFixes()).map(item => item.status)).toEqual(['ready']);
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
    expect(systemOne.calls[0].questions.reachable).toBeDefined();
    expect(existsSync(join(repo.out, 'workspaces', fix.id))).toBe(false);
  });

  it('withholds perch\'s own keys from test runs and does not blame the patch for a test that already fails on the original', async () => {
    const root = await makeFixture();
    cleanups.push(root);
    // A test that reaches clamp and fails regardless, and one that would only fail if perch's key leaked into the run.
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

  it('creates a new test file only when no test covers the module, named after it, and rejects one that never loads', async () => {
    const root = await makeFixture();
    cleanups.push(root);
    await rm(join(root, 'test', 'clamp.test.js'));
    await writeFile(join(root, 'test', 'other.test.js'), `import test from 'node:test';\ntest('other', () => {});\n`);
    await commitAll(root, 'no clamp test');
    const repo = { root, revision: await revision(root), out: join(root, '.perch') };
    const hunt = await runHunt(fixtureOptions(repo, { analyzer, systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.9, where: 'L0003', kind_wrong_return: 0.9 } }) }));
    const [finding] = hunt.visited;
    const attempt = async (name, fix) => runFix(fixOptions(repo, finding, { model: { ...scriptedModel({ fix }), id: name } }));
    const standalone = `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { clamp } from '../src/clamp.js';\n${regressionCase}`;

    const misnamed = await attempt('misnamed', () => proposal(fixedMethod, standalone, 'test/clamp.regression.test.js'));
    expect(misnamed.error).toBe('a new test file must be named after the module it tests, the way this project names its tests (for src/clamp.js, something like test/clamp.test.js); test/clamp.regression.test.js is not');
    const missing = await attempt('missing', () => proposal(fixedMethod, standalone.replace('../src/clamp.js', '../src/nope.js'), 'test/clamp.test.js'));
    expect(missing.error).toMatch(/^the test did not fail with an assertion on the original/);

    const model = scriptedModel({ fix: () => proposal(fixedMethod, standalone, 'test/clamp.test.js') });
    const fix = await runFix(fixOptions(repo, finding, { model }));
    expect(fix.status).toBe('ready');
    expect(fix.module_test).toBeNull();
    expect(fix.example_test).toBe('test/other.test.js');
    expect(fix.existing_tests).toEqual([]);
    expect(fix.proof.test_mode).toBe('new');
    expect(model.calls[0].prompt).toContain('No test file covers this module yet');
    expect(model.calls[0].prompt).toContain('named after the module the way the example is named after its module: test/clamp.test.js');
    expect(await readFile(fix.patch_path, 'utf8')).toContain('diff --git a/test/clamp.test.js b/test/clamp.test.js');
    expect(formatFix(fix)).toContain('no existing test reaches the method');
  });

  it('knows which test names belong to a module and what lines an extension dropped', () => {
    expect(namedAfter('test/clamp.test.js', 'src/clamp.js')).toBe(true);
    expect(namedAfter('tests/test_clamp.py', 'pkg/clamp.py')).toBe(true);
    expect(namedAfter('pkg/clamp_test.go', 'pkg/clamp.go')).toBe(true);
    expect(namedAfter('test/my-module.spec.ts', 'src/my-module.ts')).toBe(true);
    expect(namedAfter('test/clamp.regression.test.js', 'src/clamp.js')).toBe(false);
    expect(namedAfter('test/cli-null.test.js', 'src/cli.js')).toBe(false);
    expect(namedAfter('test/other.test.js', 'src/clamp.js')).toBe(false);
    expect(namedAfter('test/target.js', 'src/target.js', 'test/cli.test.js')).toBe(false);
    expect(namedAfter('tests/command.name.test.js', 'lib/command.js', 'tests/command.action.test.js')).toBe(true);
    expect(namedAfter('tests/name.command.test.js', 'lib/command.js')).toBe(false);
    expect(namedAfter('tests/command.regression.test.js', 'lib/command.js')).toBe(false);
    expect(namedAfter('test/target.js', 'src/target.js', null)).toBe(true);
    expect(namedAfter('tests/target.rs', 'src/target.rs', 'tests/other.rs')).toBe(true);
    expect(suggestTestName('src/target.js', 'test/cli.test.js')).toBe('test/target.test.js');
    expect(suggestTestName('pkg/target.py', 'tests/test_scan.py')).toBe('tests/test_target.py');
    expect(suggestTestName('src/target.ts', null)).toBe('test/target.test.ts');
    expect(removedLines('a\nb\nc\n', 'a\nx\nb\nc\ny\n')).toEqual([]);
    expect(removedLines('a\nb\nc\n', 'a\nc\nb\n')).toHaveLength(1);
    expect(removedLines('a\nb\n', 'a\nB\n')).toEqual(['b']);
  });

  it('feeds a rejected attempt back to the model and accepts the next one', async () => {
    const { repo, finding } = await huntedFixture();
    const passing = regressionSource.replace('clamp(11, 0, 10), 10', 'clamp(5, 0, 10), 5');
    const model = scriptedModel({ fix: id => (id === 'fix-1' ? proposal(fixedMethod, passing) : proposal(fixedMethod)) });
    const fix = await runFix(fixOptions(repo, finding, { model }));
    expect(fix.status).toBe('ready');
    expect(fix.attempts.map(attempt => attempt.attempt)).toEqual([1, 2]);
    expect(fix.attempts[0].rejected).toMatch(/^the test passes on the original/);
    expect(fix.attempts[0].before.exit_code).toBe(0);
    expect(model.calls[1].prompt).toContain('YOUR PREVIOUS ATTEMPT WAS REJECTED: the test passes on the original');
    expect(formatFix(fix)).toContain('attempts: 2; attempt 1 rejected: the test passes on the original');
    expect(existsSync(join(repo.out, 'workspaces', fix.id))).toBe(false);
  });

  it('rejects an unchanged method, a test that edits existing cases or lands in the wrong file, an unsound test, a patch that breaks an existing case, and one System One still finds defective', async () => {
    const { repo, finding } = await huntedFixture();
    const attempt = async (name, extra) => runFix(fixOptions(repo, finding, { ...extra, model: { ...(extra.model ?? scriptedModel()), id: name } }));

    const unchanged = scriptedModel({ fix: () => ({ ...proposal(buggySource.trimEnd()), summary: 'no caller can pass v above hi' }) });
    const noop = await attempt('unchanged', { model: unchanged });
    expect(noop.status).toBe('rejected');
    expect(noop.error).toBe('the method was returned unchanged: no caller can pass v above hi');
    expect(unchanged.calls.map(call => call.id)).toEqual(['fix-1', 'fix-2', 'fix-3']);

    const nested = await attempt('nested', { model: scriptedModel({ fix: () => proposal(fixedMethod.replace('  if (v > hi) return hi;', '  if (v > hi) {\n    if (hi >= lo) return hi;\n  }')) }) });
    expect(nested.status).toBe('rejected');
    expect(nested.error).toMatch(/^the patch adds nesting, more than one branch, or more than one point of risk \(.*nesting 1 -> 2\)$/);
    expect(nested.attempts.every(item => item.test_check === undefined)).toBe(true);

    const unsound = await attempt('unsound', { systemOne: scriptedSystemOne({ test: { imports_real_method: 0.1, reachable_by_callers: 0.2, passes_on_original: 0.8 } }) });
    expect(unsound.status).toBe('rejected');
    expect(unsound.error).toBe('the test does not clearly import and call the real method (10%); it is not clear any real caller could pass the input the test constructs (20%), so it does not demonstrate a reachable defect; the test may pass on the original (80%), so it does not clearly demonstrate the defect');
    // A shrug is not proof: answers between 40% and 60% are rejected too.
    const shrug = await attempt('shrug', { systemOne: scriptedSystemOne({ test: { targets_defect: 0.55, passes_on_original: 0.45 } }) });
    expect(shrug.error).toBe('the test does not clearly exercise the described defect (55%); the test may pass on the original (45%), so it does not clearly demonstrate the defect');
    expect(unsound.attempts.every(item => item.before === undefined)).toBe(true);

    const edited = await attempt('edited', { model: scriptedModel({ fix: () => proposal(fixedMethod, regressionSource.replace('clamp(5, 0, 10), 5', 'clamp(5, 0, 10), 6')) }) });
    expect(edited.status).toBe('rejected');
    expect(edited.error).toBe('extending test/clamp.test.js may only add lines; these were changed or removed:\n  assert.strictEqual(clamp(5, 0, 10), 5);');

    const elsewhere = await attempt('elsewhere', { model: scriptedModel({ fix: () => proposal(fixedMethod, regressionSource, 'test/clamp.regression.test.js') }) });
    expect(elsewhere.error).toBe('test/clamp.test.js already tests this module; add the new case to that file and return its complete content, rather than creating test/clamp.regression.test.js');

    const breaking = await attempt('breaking', { model: scriptedModel({ fix: () => proposal(fixedMethod.replace('  return v;', '  return hi;')) }) });
    expect(breaking.status).toBe('rejected');
    expect(breaking.error).toMatch(/^the test file still fails on the patched method/);
    expect(breaking.attempts[0].after.exit_code).not.toBe(0);

    // The hunt rated the defect at 90%; a patch the model does not think lowered that, or that changes other behavior, is not a fix.
    const gamed = await attempt('gamed', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.9, collateral_change: 0.7 } }) });
    expect(gamed.status).toBe('rejected');
    expect(gamed.error).toBe('the patch did not lower the defect probability (90% -> 90%); the patch may change behavior beyond the defect (70%)');
    const worse = await attempt('worse', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.95, kind_wrong_return: 0.9 } }) });
    expect(worse.error).toBe('the patch did not lower the defect probability (90% -> 95%); the wrong return defect looks no less likely (90% -> 90%)');
    expect(gamed.attempts[0].after.exit_code).toBe(0);
    // A patch that lowers it, even to a number the model is unsure of, is one.
    const improved = await attempt('improved', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.46 } }) });
    expect(improved.status).toBe('ready');
    await git(['reset', '-q', '--hard', 'HEAD~1'], repo.root);

    // Every rejection was recorded, so issues shows the finding as discarded; no worktree was made, and the checkout is as it was.
    const store = openStore(repo.out);
    expect((await store.readEvents()).filter(event => event.type === 'fixed').map(event => event.status)).toEqual([...Array(9).fill('rejected'), 'ready']);
    await store.appendEvent({ type: 'fixed', at: new Date().toISOString(), id: finding.id, fix_id: worse.id, method: finding.method, hash: finding.hash, revision: finding.revision, status: 'rejected', attempts: 3, error: worse.error });
    const [discarded] = await store.findings();
    expect(discarded.fix).toMatchObject({ id: worse.id, status: 'rejected', attempts: 3, error: worse.error });
    expect(formatIssues([discarded], 0.5)).toBe('No open issues at 50% or more. 1 closed; --closed to list them.');
    expect(formatIssues([discarded], 0.5, 10, { closed: true })).toMatch(/Status  PR\n.*closed +-/);
    expect(formatFinding(discarded)).toContain('Status: closed');
    expect(formatFinding(discarded)).toContain('Fix discarded: no fix after 3 attempts');
    expect((await git(['worktree', 'list'], repo.root)).trim().split('\n')).toHaveLength(1);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toBe(buggySource);
  }, 60_000);
});
