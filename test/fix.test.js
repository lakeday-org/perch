import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { runHunt } from '../src/hunt.js';
import { pendingFixes, runFix, runFixQueue, splitStale, underPath } from '../src/fix.js';
import { huntAnswers } from '../src/prompts.js';
import { createShell } from '../src/shell.js';
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
    expect(current).toHaveLength(2);
    expect(stale).toHaveLength(1);
    expect(formatFixes({ kind: 'fix', budget: 5, remaining: 3, stale: 2, fixes: [] })).toBe('No open defects to fix. 2 findings are for methods that no longer exist under that name; hunt again to see what replaced them.');
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

  it('checks the fix by its metrics and System One, commits it, records it, and reuses it on rerun', async () => {
    const { repo, finding } = await huntedFixture();
    const model = scriptedModel(), systemOne = scriptedSystemOne();
    const lines = [];
    const fix = await runFix(fixOptions(repo, finding, { model, systemOne, ui: createUi({ live: false, log: text => lines.push(text) }) }));

    expect(fix.status).toBe('ready');
    expect(fix.finding_id).toBe(finding.id);
    expect(fix.reach_check).toEqual({ reachable: 0.9 });
    expect(fix.verification).toEqual({ kind: 'wrong_return', before: { has_bug: 0.9, kind: 0.9, reachable: 0.9 }, after: { has_bug: 0.2, kind: 0.2, severity: 1, misused_by: [] } });
    expect(fix.metrics).toMatchObject({ complexity: [3, 3], nesting: [1, 1] });
    expect(fix.turns).toBe(1);
    expect(fix.usage).toMatchObject({ input_tokens: 1000, cached_tokens: 0 });

    // The model ran as an agent: it checked, verified, and submitted the same source; the trace holds every call and result.
    expect(model.calls.map(call => call.name)).toEqual(['check_method', 'verify_with_system_one', 'submit']);
    expect(model.calls.every(call => call.arguments.method === fixedMethod)).toBe(true);
    expect(model.calls[0].prompt).toContain('using the tools: check_method every version you write');
    expect(model.calls[0].prompt).toContain('reachable behavioral defect: 90%; the flagged line is reachable by a real caller: 90%');
    expect(model.calls[0].prompt).toContain('defect kinds, most likely first: wrong return 90%');
    expect(model.calls[0].prompt).toContain('"called_by"');
    expect(fix.trace.filter(event => event.type === 'tool_result').map(event => event.result.ok)).toEqual([true, true, true]);
    expect(fix.trace.find(event => event.name === 'verify_with_system_one' && event.type === 'tool_result').result.system_one).toBe('defect 90% -> 20%, wrong return 90% -> 20%');
    expect(systemOne.calls.map(call => call.method)).toEqual(['src/clamp.js::clamp', 'src/clamp.js::clamp']);
    expect(systemOne.calls[0].questions.reachable).toBeDefined();
    expect(systemOne.calls[0].state.module_scope).toBeNull();
    expect(systemOne.calls[1].state.method.source).toContain('L0003|   if (v > hi) return hi;');
    expect(systemOne.calls[1].state.original_method).toBe(buggySource.trimEnd());
    expect(Object.keys(systemOne.calls[1].questions)).toEqual(expect.arrayContaining(['has_bug', 'kind_wrong_return']));
    expect(Object.keys(systemOne.calls[1].questions)).not.toContain('collateral_change');
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
    expect(await readFile(fix.patch_path, 'utf8')).toContain('+  if (v > hi) return hi;');

    // Every step was reported with a mark: the reach check, each tool call, the run, the commit.
    expect(lines.some(line => /^✓ scripted-jev: can a caller reach src\/clamp.js:3\? — reachable 90%/.test(line))).toBe(true);
    expect(lines.some(line => /^scripted-model fixing clamp: thinking \(effort max\)/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ scripted-model ▸ check_method — risk \d+ -> \d+, complexity 3 -> 3/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ scripted-model ▸ verify_with_system_one — Return hi when v exceeds the upper bound\. — defect 90% -> 20%/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ scripted-model ▸ submit/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ committed [0-9a-f]{7} on work: Return hi/.test(line))).toBe(true);

    // The record is in the events log, so issues shows the finding as fixed.
    const store = openStore(repo.out);
    expect((await store.readEvents()).at(-1)).toMatchObject({ type: 'fixed', id: finding.id, fix_id: fix.id, method: 'src/clamp.js::clamp', status: 'ready', commit: fix.commit, branch: 'work' });
    const [listed] = await store.findings();
    expect(listed.fix).toMatchObject({ id: fix.id, commit: fix.commit, verification: fix.verification });
    expect(formatIssues([listed], 0.5)).toMatch(new RegExp(`Status  Commit\\n.*open +${fix.commit.slice(0, 7)}`));
    expect(formatFinding(listed)).toContain('Fixed: Return hi when v exceeds the upper bound. (defect 90% -> 20%)');
    const text = formatFix(fix);
    expect(text).toContain('verified by scripted-jev: reachable 90%; defect 90% -> 20%, wrong return 90% -> 20%');
    expect(text).toContain(`committed: ${fix.commit.slice(0, 7)} on work`);
    expect(text).toContain('agent: 1 turn, 3 tool calls');

    const again = scriptedModel();
    expect((await runFix(fixOptions(repo, finding, { model: again }))).id).toBe(fix.id);
    expect(again.calls).toHaveLength(0);
  });

  it('discards an unreachable finding after a System One precheck, without calling the generative model', async () => {
    const { repo, finding } = await huntedFixture();
    const model = scriptedModel();
    const systemOne = scriptedSystemOne({ 'src/clamp.js::clamp': { reachable: 0.15 } });
    const fix = await runFix(fixOptions(repo, finding, { model, systemOne }));
    expect(fix.status).toBe('closed');
    expect(fix.reach_check).toEqual({ reachable: 0.15 });
    expect(fix.reason).toBe('no caller can reach the flagged line (15%); an earlier guard excludes it');
    expect(fix.error).toBeUndefined();
    expect(model.calls).toHaveLength(0);
    expect(systemOne.calls).toHaveLength(1);
    expect(formatFix(fix)).toBe(`${finding.id}  src/clamp.js::clamp  closed: no caller can reach the flagged line (15%); an earlier guard excludes it`);
    const store = openStore(repo.out);
    const [closed] = await store.findings();
    expect(closed.fix).toMatchObject({ status: 'closed', reason: fix.reason });
    expect(formatIssues([closed], 0.5)).toBe('No open issues at 50% or more. 1 closed; --closed to list them.');
    expect(formatFinding(closed)).toContain('Closed on');
    expect(formatIssues([], 0.5, 10, { gone: 2 })).toBe('No hunted method has an issue at 50% or more. 2 findings are for methods that no longer exist and are not listed.');
  });

  it('re-questions a method that changed since the hunt and goes on from the fresh answers, or drops it when no defect is left', async () => {
    const { repo, finding } = await huntedFixture();
    // The method changes in a way that leaves the bug: a comment inside it.
    await writeFile(join(repo.root, 'src', 'clamp.js'), buggySource.replace('  if (v > hi) return v;', '  // upper bound\n  if (v > hi) return v;'));
    await commitAll(repo.root, 'touch clamp');
    const lines = [];
    // The re-question (questions, then reachability) answers with the fresh finding; the patch check afterwards answers with the defaults.
    const fresh = scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.85, where: 'L0004', kind_wrong_return: 0.8 } }), plain = scriptedSystemOne();
    let calls = 0;
    const systemOne = { id: 'scripted-jev', calls: fresh.calls, ask: (state, questions) => (++calls <= 2 ? fresh : plain).ask(state, questions) };
    const fix = await runFix(fixOptions(repo, finding, { systemOne, ui: createUi({ live: false, log: text => lines.push(text) }) }));
    expect(fix.status).toBe('ready');
    expect(lines.some(line => /^✓ scripted-jev re-reading clamp, changed since the hunt — still looks defective: wrong return 85% at line 4/.test(line))).toBe(true);
    expect(fix.verification.before).toEqual({ has_bug: 0.85, kind: 0.8, reachable: 0.9 });
    const store = openStore(repo.out);
    const hunted = (await store.readEvents()).filter(event => event.type === 'hunted');
    expect(hunted).toHaveLength(2);
    expect(hunted[1]).toMatchObject({ id: finding.id, hunt_id: null, has_bug: 0.85, where: { line: 4, text: 'if (v > hi) return v;' } });
    expect((await store.findings())[0].fix).toMatchObject({ id: fix.id, status: 'ready' });

    // Changed again, and this time System One sees nothing: the finding leaves the list without a generative call.
    await writeFile(join(repo.root, 'src', 'clamp.js'), fixedSource.replace('  return v;', '  return v; // in range'));
    await commitAll(repo.root, 'touch clamp again');
    const model = scriptedModel();
    const gone = await runFix(fixOptions(repo, { ...finding, hash: 'stale' }, { model, systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.1 } }) }));
    expect(gone.status).toBe('closed');
    expect(gone.reason).toBe('no reachable defect in the method as it reads now (defect 10%)');
    expect(model.calls).toHaveLength(0);
    expect(await store.findings()).toEqual([]);
  });

  it('lets the model recover from a tool rejection inside the same run, and refuses submit for source the verifiers have not passed', async () => {
    const { repo, finding } = await huntedFixture();
    const model = scriptedModel({ fix: id => (id === 'fix-1' ? proposal(buggySource.trimEnd(), 'nothing wrong here') : proposal(fixedMethod)) });
    const fix = await runFix(fixOptions(repo, finding, { model }));
    expect(fix.status).toBe('ready');
    expect(fix.turns).toBe(2);
    expect(model.calls.map(call => call.name)).toEqual(['check_method', 'check_method', 'verify_with_system_one', 'submit']);
    expect(fix.trace.filter(event => event.type === 'tool_result')[0].result).toEqual({ ok: false, error: 'the method is unchanged' });
    expect(formatFix(fix)).toContain('agent: 2 turns, 4 tool calls');

    // A model that skips the verifiers is refused at submit.
    const { repo: other, finding: again } = await huntedFixture();
    const impatient = { id: 'impatient', effort: null, calls: [], async run({ tools }) { const submit = tools.find(item => item.name === 'submit'); const result = await submit.handler({ method: fixedMethod, summary: 'trust me' }); return { done: Boolean(result.done), turns: 1, usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1, reasoning_tokens: 0 }, trace: [{ type: 'tool_call', name: 'submit' }, { type: 'tool_result', name: 'submit', result }] }; } };
    const refused = await runFix(fixOptions(other, again, { model: impatient }));
    expect(refused.status).toBe('rejected');
    expect(refused.error).toBe('check_method has not passed this exact source');
    expect(await readFile(join(other.root, 'src', 'clamp.js'), 'utf8')).toBe(buggySource);
  });

  it('rejects an unchanged method, one that adds nesting, and one System One does not think improved; the checkout is left as it was', async () => {
    const { repo, finding } = await huntedFixture();
    const attempt = async (name, extra) => runFix(fixOptions(repo, finding, { ...extra, model: { ...(extra.model ?? scriptedModel()), id: name } }));

    const unchanged = scriptedModel({ fix: () => proposal(buggySource.trimEnd(), 'no caller can pass v above hi') });
    const noop = await attempt('unchanged', { model: unchanged });
    expect(noop.status).toBe('rejected');
    expect(noop.error).toBe('the method is unchanged');
    expect(unchanged.calls.map(call => call.id)).toEqual(['fix-1', 'fix-2', 'fix-3']);
    expect(noop.turns).toBe(3);

    const nested = await attempt('nested', { model: scriptedModel({ fix: () => proposal(fixedMethod.replace('  if (v > hi) return hi;', '  if (v > hi) {\n    if (hi >= lo) return hi;\n  }')) }) });
    expect(nested.status).toBe('rejected');
    expect(nested.error).toBe('the patch adds nesting, more than one branch, or more than one point of risk; change only what the defect requires');
    expect(nested.trace.at(-1).result.file_metrics_before_after.nesting).toEqual([1, 2]);

    // The hunt rated the defect at 90%; a patch the model does not think lowered that is not a fix.
    const gamed = await attempt('gamed', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.9 } }) });
    expect(gamed.status).toBe('rejected');
    expect(gamed.error).toBe('the patch did not lower the defect probability (90% -> 90%)');
    const worse = await attempt('worse', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.95, kind_wrong_return: 0.9 } }) });
    expect(worse.error).toBe('the patch did not lower the defect probability (90% -> 95%); the wrong return defect looks no less likely (90% -> 90%)');
    // A patch that lowers it, even to a number the model is unsure of, is one.
    const improved = await attempt('improved', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.46 } }) });
    expect(improved.status).toBe('ready');
    await git(['reset', '-q', '--hard', 'HEAD~1'], repo.root);

    const store = openStore(repo.out);
    expect((await store.readEvents()).filter(event => event.type === 'fixed').map(event => event.status)).toEqual([...Array(4).fill('rejected'), 'ready']);
    await store.appendEvent({ type: 'fixed', at: new Date().toISOString(), id: finding.id, fix_id: worse.id, method: finding.method, hash: finding.hash, revision: finding.revision, status: 'rejected', attempts: 3, error: worse.error });
    const [discarded] = await store.findings();
    expect(discarded.fix).toMatchObject({ id: worse.id, status: 'rejected', attempts: 3, error: worse.error });
    expect(formatIssues([discarded], 0.5)).toBe('No open issues at 50% or more. 1 closed; --closed to list them.');
    expect(formatIssues([discarded], 0.5, 10, { closed: true })).toMatch(/Status  Commit\n.*closed +-/);
    expect(formatFinding(discarded)).toContain('Status: closed');
    expect(formatFinding(discarded)).toContain('Fix discarded on');
    expect((await git(['worktree', 'list'], repo.root)).trim().split('\n')).toHaveLength(1);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toBe(buggySource);
  }, 60_000);
});
