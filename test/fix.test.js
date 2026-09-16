import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { scanRepository } from '../src/hunt.js';
import { fileBudget, fileObjections, fixIssues, fixMethod, improvement, plainNotes, pendingFixes, regionStart, sameLines, splitStale, underPath } from '../src/fix.js';
import { huntAnswers } from '../src/prompts.js';
import { createMeter, money } from '../src/meter.js';
import { createShell } from '../src/shell.js';
import { openStore } from '../src/store.js';
import { ANSWERS_VERSION, issuesOf } from '../src/questions.js';
import { formatFinding, formatFix, formatFixes, formatIssues } from '../src/report.js';
import { createUi } from '../src/ui.js';
import { buggySource, commitAll, documentedSource, fixedMethod, fixedSource, fixtureOptions, leanerSource, makeFixture, scriptedModel, scriptedSystemOne } from './helpers.js';

const analyzer = createSourceAnalyzer();
const shell = createShell();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** The clamp fixture scanned once, with a defect on clamp pointing at the upper-bound line. */
async function scanned(answers = { has_bug: 0.9, where: 'L0003', kind: 'wrong_return', severity: 2 }) {
  const root = await makeFixture();
  cleanups.push(root);
  const repo = { root, revision: await revision(root), out: join(root, '.perch') };
  const scan = await scanRepository(fixtureOptions(repo, { analyzer, systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': answers }) }));
  const [finding] = await openStore(repo.out).issues();
  return { repo, scan, finding };
}
const options = (repo, finding, extra) => ({ finding, root: repo.root, out: repo.out, analyzer, shell, systemOne: scriptedSystemOne(), model: scriptedModel(), ...extra });
const proposal = (source, summary = 'Change the method') => ({ source, summary, notes: 'The method returned the wrong value on one branch and the comment did not say what callers get. Both are corrected here.' });
const captured = () => { const lines = []; return { lines, ui: createUi({ live: false, log: text => lines.push(text) }) }; };

describe('perch fix', () => {
  it('queues every open issue up to the budget, under a path when given, and sets aside methods that no longer exist', async () => {
    const defect = extra => ({ has_bug: 0.9, kind: { kind: 'boundary' }, ...extra });
    const design = extra => ({ has_bug: 0.1, refactor: { refactor: 'split', probabilities: { split: 0.8 } }, ...extra });
    const open = defect({ id: 'aaaa1111', path: 'src/a.js' });
    const fixed = defect({ id: 'bbbb2222', path: 'src/b.js', fix: { status: 'ready' } });
    const closed = defect({ id: 'cccc3333', path: 'src/c.js', fix: { status: 'rejected' } });
    const messy = design({ id: 'ffff6666', path: 'lib/f.js' });
    const later = defect({ id: 'eeee5555', path: 'lib/e.js' });
    const complex = { id: 'hhhh8888', path: 'lib/h.js', metrics: { risk_score: 80 } };
    expect(pendingFixes([open, fixed, closed, messy, later, complex], 1).map(finding => finding.id)).toEqual(['aaaa1111']);
    expect(pendingFixes([open, fixed, closed, messy, later, complex], 9).map(finding => finding.id)).toEqual(['aaaa1111', 'ffff6666', 'eeee5555', 'hhhh8888']);
    expect(underPath([open, messy, later], 'lib').map(finding => finding.id)).toEqual(['ffff6666', 'eeee5555']);
    expect(underPath([open, messy, later], 'lib/e.js').map(finding => finding.id)).toEqual(['eeee5555']);
    const { current, stale } = splitStale([{ method: 'src/a.js::f' }, { method: 'gone.js::g' }], { files: [{ path: 'src/a.js', methods: [{ id: 'src/a.js::f', hash: 'h' }] }] });
    expect(current).toHaveLength(1);
    expect(stale).toHaveLength(1);
    expect(formatFixes({ budget: 5, remaining: 3, stale: 2, fixes: [] })).toBe('No open issues to work. 2 findings are for methods that no longer exist under that name; scan again to see what replaced them.');
    const queued = await fixIssues({ findings: [defect({ id: 'a1', method: 'm', path: 'src/a.js', revision: 'r' }), defect({ id: 'b2', method: 'n', path: 'src/b.js', revision: 'r' })], budget: 1, root: null, out: '/tmp', model: { id: 'x' }, systemOne: { id: 'y' }, analyzer: {}, shell: {} });
    expect(queued.attempted).toBe(1);
    expect(queued.remaining).toBe(1);
    expect(queued.fixes[0]).toMatchObject({ finding_id: 'a1', status: 'failed', error: 'finding a1 has no repository recorded; scan again' });
  });

  it('keeps a rewrite only when neither kind of problem rises and one falls', () => {
    const at = (correctness, design) => ({ correctness, design });
    // Halving a defect counts for what it is: no line to cross, just less expected trouble than before.
    expect(improvement(at(0.9, 0.8), at(0.4, 0.8)).better).toBe(true);
    expect(improvement(at(0.9, 0.8), at(0.4, 0.3)).shift).toEqual({ correctness: -0.5, design: -0.5 });
    // Neither kind may rise: closing a hole by making the method incoherent is not an improvement, nor the reverse.
    expect(improvement(at(0.9, 0.2), at(0.4, 0.8)).objections).toEqual(['design up 0.60: the rewrite is expected to leave more problems of that kind than it found']);
    expect(improvement(at(0.2, 0.9), at(0.5, 0.4)).objections).toEqual(['correctness up 0.30: the rewrite is expected to leave more problems of that kind than it found']);
    expect(improvement(at(0.9, 0.8), at(0.9, 0.8)).objections).toEqual(['nothing the scan can see changed: the same problems are expected as before']);
    expect(sameLines('a\n  b\nc', 'c\nb\n\n a')).toBe(true);
    expect(sameLines('a\nb', 'a\nb\nc')).toBe(false);
    expect(regionStart(['// a', '// b', 'function f() {}'], 3)).toBe(1);
    expect(regionStart(['x', '', 'function f() {}'], 3)).toBe(3);
    expect(money(0.0031)).toBe('$0.0031');
    expect(money(1.2)).toBe('$1.20');
    const meter = createMeter();
    meter.add('jev-latest', { input_tokens: 1_000_000, output_tokens: 10 }, { requests: 3 });
    meter.add('gpt-5.6-luna', { input_tokens: 100_000, input_tokens_details: { cached_tokens: 50_000 }, output_tokens: 10_000 }, { turns: 2 });
    expect(meter.cost('jev-latest')).toBeCloseTo(0.042);
    expect(meter.cost('gpt-5.6-luna')).toBeCloseTo(0.05 * 0.2 + 0.05 * 0.02 + 0.01 * 1.2);
    const [jev, luna, total] = meter.lines();
    expect(jev).toMatch(/^jev-latest {4}3 requests {2}1\.0M in \/ 10 out +\$0\.04$/);
    expect(luna).toMatch(/^gpt-5\.6-luna {2}2 turns {5}100k in \(50k cached\) \/ 10k out {2}\$0\.02$/);
    expect(total).toMatch(/^total +\$0\.07$/);
  });

  it('lists a hole that stands on its own even when nothing outside is said to reach the method', async () => {
    const { securityOf } = await import('../src/questions.js');
    const answers = { exposed: 0.46, securities: { use_after_free: 0.95, injection: 0.99, buffer_overflow: 0.2 } };
    // injection is only as likely as something from outside reaching the method; a value freed twice is wrong whoever calls it.
    expect(securityOf(answers)).toEqual({ kind: 'use_after_free', probability: 0.95 });
    expect(securityOf({ ...answers, exposed: 0.99 }).kind).toBe('injection');
    expect(issuesOf(answers).find(issue => issue.type === 'security').text).toBe('use after free 95%');
  });


  it('lets a split cost a few lines but refuses a rewrite that inflates the file', () => {
    const base = { risk_score: 100, cyclomatic_complexity: 139, max_nesting: 7, sloc: 319 };
    expect(fileBudget(base)).toEqual({ cyclomatic_complexity: 146, sloc: 351 });
    expect(fileObjections(base, { ...base, sloc: 340, cyclomatic_complexity: 142 })).toEqual([]);
    // The run that started this: the method's own score improved while the file grew by a third.
    expect(fileObjections(base, { ...base, cyclomatic_complexity: 142, sloc: 436 })).toEqual(['the file grows too much, 319 -> 436 lines, and 351 is the most this fix may leave']);
    expect(fileObjections(base, { ...base, cyclomatic_complexity: 160 })).toEqual(['the file\'s complexity goes up too far, 139 -> 160, and 146 is the most this fix may leave']);
    // Closing a hole means validating, and every check is a branch: a complexity ceiling would refuse the fix.
    expect(fileBudget(base, { security: true }).cyclomatic_complexity).toBe(Infinity);
    expect(fileObjections(base, { ...base, cyclomatic_complexity: 200 }, { security: true })).toEqual([]);
    // The line budget still applies, so a security fix cannot become a rewrite of the file.
    expect(fileObjections(base, { ...base, cyclomatic_complexity: 200, sloc: 436 }, { security: true }))
      .toEqual(['the file grows too much, 319 -> 436 lines, and 351 is the most this fix may leave']);

    // Extracting a helper raises a small file's risk on its own, and that must not block the split "too big" asks for.
    const small = { risk_score: 26.47, cyclomatic_complexity: 3, max_nesting: 1, sloc: 5 };
    expect(fileObjections(small, { risk_score: 40, cyclomatic_complexity: 3, max_nesting: 1, sloc: 12 })).toEqual([]);
  });

  it('insists the note is prose a reviewer can read', () => {
    const good = 'The upper bound was returned as the value the caller passed in, so clamp(11, 0, 10) gave back 11. The branch now returns hi.';
    expect(plainNotes(good)).toEqual({ text: good });
    expect(plainNotes('')).toMatchObject({ error: expect.stringContaining('notes is required') });
    expect(plainNotes('Fixed it.')).toMatchObject({ error: expect.stringContaining('too short') });
    expect(plainNotes('This change fixes the upper bound branch so that callers get the right value back every time.')).toMatchObject({ error: expect.stringContaining('not "This change"') });
    expect(plainNotes('- the bound was wrong\n- it is right now, which callers depend on for every clamped value')).toMatchObject({ error: 'notes must be sentences, not bullets' });
    expect(plainNotes('Leveraged a robust approach to the upper bound so that every caller gets a correct value back.')).toMatchObject({ error: expect.stringContaining('"Leveraged"') });
  });

  it('tells the model everything System One answered, with probabilities', () => {
    const finding = { has_bug: 0.63, where: { line: 48, confidence: 0.71, text: 'return null;' }, kind: { kind: 'swallowed_error', probability: 0.6 }, kinds: { swallowed_error: 0.6, wrong_return: 0.4, boundary: 0.1 },
      severity: { level: 'P1', confidence: 0.55 }, misuse: [{ callee: 'src/gh.js::gh', probability: 0.7 }], misused_by: [{ caller: 'src/cli.js::publish', probability: 0.3 }], does_what_it_claims: 0.8, misdocumented: 0.53, refactor: { refactor: 'split', probabilities: { split: 0.84, none: 0.1, flatten: 0.05 } } };
    const text = huntAnswers(finding, { reachable: 0.88 });
    expect(text).toContain('reachable behavioral defect: 63%');
    expect(text).toContain('defect kinds, most likely first: error ignored 60%, wrong return value 40%, off by one 10%');
    expect(text).toContain('refactor it most needs: too big 84%, none 10%, too nested 5%');
    expect(huntAnswers({ metrics: { risk_score: 80 } })).toBe('System One has not read this method; the issues come from the metrics.');
  });

  it('states the objectives, lets the model rewrite with the scan as the judge, commits, records, and reuses the record', async () => {
    const { repo, finding } = await scanned();
    const model = scriptedModel(), systemOne = scriptedSystemOne();
    const { lines, ui } = captured();
    const fix = await fixMethod(options(repo, finding, { model, systemOne, ui }));

    expect(fix.status).toBe('ready');
    expect(fix.before[0].text).toBe('wrong return value 90%');
    expect(fix.after.every(issue => issue.probability < 0.3)).toBe(true);
    expect(fix.expected.correctness).toBeLessThan(0);
    expect(fix.checks).toEqual(['test/clamp.test.js']);
    expect(fix.file_before.cyclomatic_complexity).toBe(3);
    expect(fix.turns).toBe(1);
    expect(Object.keys(fix.usage).sort()).toEqual(['scripted-jev', 'scripted-model']);
    expect(fix.usage['scripted-jev'].requests).toBe(1);

    // The model saw the objectives and everything System One answered; it measured, rescanned, ran the tests, and submitted one source.
    expect(model.calls.map(call => call.name)).toEqual(['measure', 'rescan', 'run_tests', 'submit']);
    expect(model.calls.every(call => call.arguments.source === fixedMethod)).toBe(true);
    const prompt = model.calls[0].prompt;
    expect(prompt).toContain('OBJECTIVES:\n- wrong return value 90%: System One must no longer see this defect when it reads the rewrite');
    expect(prompt).toContain('rescan runs the same scan over your rewrite');
    expect(prompt).toContain('and any sibling helpers it needs in that range');
    expect(prompt).toContain('reachable behavioral defect: 90%');
    expect(prompt).toContain('ORIGINAL, lines 1-5');
    expect(prompt).toContain('"called_by"');
    // System One was asked twice: is the line reachable, then the whole question set over the rewrite.
    expect(systemOne.calls.map(call => Object.keys(call.questions)[0])).toEqual(['has_bug']);
    expect(systemOne.calls.at(-1).state.method.source).toContain('L0003|   if (v > hi) return hi;');
    expect(fix.trace.find(event => event.type === 'tool_result' && event.name === 'rescan').result.expected.correctness).toBeLessThan(0);

    // One commit on the current branch; the checkout is clean.
    expect(fix.branch).toBe('work');
    expect(fix.commit).toBe(await revision(repo.root));
    expect((await git(['log', '-1', '--format=%s%n%n%b'], repo.root)).trim()).toBe(`Return hi when v exceeds the upper bound\n\nperch ${finding.id}`);
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toBe(fixedSource);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect(existsSync(join(repo.out, 'workspaces'))).toBe(false);
    expect(await readFile(fix.patch_path, 'utf8')).toContain('+  if (v > hi) return hi;');

    // What was printed: the objectives, each tool call as the model's, the result, and the usage.
    expect(lines).toContainEqual(`${finding.id}  clamp  src/clamp.js:1`);
    expect(lines.some(line => /^ {2}wrong return value \d+% +→ scripted-jev must no longer see this defect when it reads the rewrite$/.test(line))).toBe(true);
    // Returning hi instead of v moves no metric, and the line says so rather than printing three numbers that did not change.
    expect(lines.some(line => /^✓ scripted-model ▸ tree-sitter — file unchanged/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ scripted-model ▸ scripted-jev rescan — now: /.test(line))).toBe(true);
    expect(lines.some(line => /^✓ scripted-model ▸ tests — 1 pass/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ scripted-model done — 1 turn/.test(line))).toBe(true);
    expect(lines.some(line => /^✓ [0-9a-f]{7} Return hi when v exceeds the upper bound$/.test(line))).toBe(true);
    // The run tells the story once: the objectives, the steps, and the commit. The report is printed by whoever asked for the fix.
    expect(lines.filter(line => line.startsWith('  Was') || line.startsWith('  Now'))).toEqual([]);
    expect(fix.usage['scripted-jev'].requests).toBe(1);
    expect(fix.usage['scripted-model'].turns).toBe(1);

    // The record is in the events log, so issues shows the finding fixed with its commit.
    const store = openStore(repo.out);
    expect((await store.readEvents()).at(-1)).toMatchObject({ type: 'fixed', id: finding.id, fix_id: fix.id, status: 'ready', commit: fix.commit, branch: 'work' });
    const [listed] = await store.issues();
    expect(listed.fix).toMatchObject({ id: fix.id, status: 'ready', commit: fix.commit });
    expect(formatIssues([listed], 0.5)).toMatch(new RegExp(`Status  Commit\\n.*open +${fix.commit.slice(0, 7)}`));
    expect(formatFinding(listed)).toContain('Fixed: Return hi when v exceeds the upper bound');
    const text = formatFix(fix);
    expect(text).toContain(`${finding.id}  clamp  src/clamp.js:1  fixed in ${fix.commit.slice(0, 7)} on work`);
    expect(text).toContain('Was    wrong return value 90%');
    expect(text).toMatch(/Now {4}inverted condition 20%/);
    expect(text).toContain('The upper bound was returned as the caller');
    expect(text).toContain('Tests   test/clamp.test.js pass');
    expect(fix.usage['scripted-model'].input).toBe(1000);

    const again = scriptedModel();
    expect((await fixMethod(options(repo, finding, { model: again }))).id).toBe(fix.id);
    expect(again.calls).toHaveLength(0);
  });


  it('reads a method again when it changed since the scan, and a method System One never read, before working it', async () => {
    const { repo, finding } = await scanned();
    await writeFile(join(repo.root, 'src', 'clamp.js'), buggySource.replace('  if (v > hi) return v;', '  // upper bound\n  if (v > hi) return v;'));
    await commitAll(repo.root, 'touch clamp');
    const fresh = scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.85, where: 'L0004', kind: 'wrong_return' } }), plain = scriptedSystemOne();
    let calls = 0;
    const systemOne = { id: 'scripted-jev', calls: fresh.calls, ask: (state, questions) => (++calls <= 2 ? fresh : plain).ask(state, questions) };
    const { lines, ui } = captured();
    const fix = await fixMethod(options(repo, finding, { systemOne, ui }));
    expect(fix.status).toBe('ready');
    expect(fix.before[0].text).toBe('wrong return value 85%');
    expect(lines.some(line => /^✓ scripted-jev reading clamp, changed since the scan — /.test(line))).toBe(true);
    const store = openStore(repo.out);
    expect((await store.readEvents()).filter(event => event.type === 'hunted')).toHaveLength(2);
    expect((await store.issues())[0].fix).toMatchObject({ id: fix.id, status: 'ready' });

    // A method only the metrics know about is read first, then worked on what System One finds.
    const unread = { id: 'zzzz9999', method: 'src/clamp.js::clamp', path: 'src/clamp.js', name: 'clamp', line: 1, end_line: 5, metrics: { risk_score: 80 }, revision: await revision(repo.root), root: repo.root, at: new Date().toISOString(), unread: true };
    const model = scriptedModel({ fix: () => proposal(fixedMethod, 'Return hi above the range') });
    const worked = await fixMethod(options(repo, { ...unread, hash: undefined }, { model, systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.7, where: 'L0003', kind: 'wrong_return' } }) }));
    expect(['ready', 'rejected']).toContain(worked.status);
  });

  it('reads a method again when its answers predate the question set', async () => {
    // Answers from an older set cannot hold a kind that did not exist yet, so every rewrite would look as though it
    // introduced one and nothing the model wrote could pass. The finding is read again before it is worked.
    const { repo, finding } = await scanned();
    const { lines, ui } = captured();
    // The re-reading and the reachability check see the defect; the rescan over the rewrite sees it gone.
    const fresh = scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.9, where: 'L0003', kind: 'wrong_return', severity: 2 } }), clean = scriptedSystemOne();
    let asked = 0;
    const systemOne = { id: 'scripted-jev', calls: fresh.calls, ask: (state, questions) => (++asked <= 1 ? fresh : clean).ask(state, questions) };
    const fix = await fixMethod(options(repo, { ...finding, answers_version: 1 }, { ui, systemOne }));
    expect(lines.some(line => /^✓ scripted-jev reading clamp, answered before the questions changed/.test(line))).toBe(true);
    if (fix.status !== 'ready') throw new Error(`${fix.status}: ${fix.error ?? fix.reason}`);
    expect((await openStore(repo.out).readEvents()).filter(event => event.type === 'hunted').at(-1).answers_version).toBe(ANSWERS_VERSION);
  });

  it('refuses submit for source the verifiers have not passed, and lets the model recover from a rejection in the same run', async () => {
    const { repo, finding } = await scanned();
    const model = scriptedModel({ fix: id => (id === 'fix-1' ? proposal(buggySource.trimEnd(), 'nothing wrong here') : proposal(fixedMethod)) });
    const fix = await fixMethod(options(repo, finding, { model }));
    expect(fix.status).toBe('ready');
    expect(fix.turns).toBe(2);
    expect(model.calls.map(call => call.name)).toEqual(['measure', 'measure', 'rescan', 'run_tests', 'submit']);
    expect(fix.trace.filter(event => event.type === 'tool_result')[0].result.error).toBe("the source is the original, or the original's lines in another order; nothing changed");

    const { repo: other, finding: again } = await scanned();
    const impatient = { id: 'impatient', effort: null, calls: [], async run({ tools }) { const result = await tools.find(item => item.name === 'submit').handler({ source: fixedMethod, summary: 'trust me' }); return { done: Boolean(result.done), turns: 1, usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1, reasoning_tokens: 0 }, trace: [{ type: 'tool_call', name: 'submit' }, { type: 'tool_result', name: 'submit', result }] }; } };
    const refused = await fixMethod(options(other, again, { model: impatient }));
    expect(refused.status).toBe('rejected');
    expect(refused.error).toContain('measure has not passed this exact source');
    expect(await readFile(join(other.root, 'src', 'clamp.js'), 'utf8')).toBe(buggySource);
  });

  it('rejects a reordering, a rewrite the rescan does not see improved, one that adds an issue, and one that breaks a test; the checkout is left as it was', async () => {
    const { repo, finding } = await scanned();
    const attempt = async (name, extra) => fixMethod(options(repo, finding, { ...extra, model: { ...(extra.model ?? scriptedModel()), id: name } }));

    const shuffled = await attempt('shuffled', { model: scriptedModel({ fix: () => proposal(buggySource.trimEnd().split('\n').reverse().join('\n'), 'Reorder') }) });
    expect(shuffled.status).toBe('rejected');
    expect(shuffled.error).toBe("the source is the original, or the original's lines in another order; nothing changed");

    // A rewrite the scan reads exactly as it read the original has not done anything.
    const unchanged = await attempt('unchanged', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.9, kind: 'wrong_return', severity: 2 } }) });
    expect(unchanged.error).toBe('nothing the scan can see changed: the same problems are expected as before');
    // A rewrite the scan reads as more likely to be wrong than the original is a regression, whatever else it tidied.
    const brought = await attempt('brought', { systemOne: scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.99, kind: 'missing_null_handling', misdocumented: 0.05 } }) });
    expect(brought.error ?? '').toMatch(/correctness up/);
    const breaking = await attempt('breaking', { model: scriptedModel({ fix: () => proposal(fixedMethod.replace('  return v;', '  return hi;')) }) });
    expect(breaking.error).toBe('test/clamp.test.js fails on the rewrite and passes on the original');

    expect(breaking.trace.at(-1).result.output).toMatch(/not ok|AssertionError/);

    const store = openStore(repo.out);
    expect((await store.readEvents()).filter(event => event.type === 'fixed').map(event => event.status)).toEqual(Array(4).fill('rejected'));
    const [discarded] = await store.issues();
    expect(discarded.fix).toMatchObject({ status: 'rejected', attempts: 3 });
    expect(formatIssues([discarded], 0.5)).toBe('Nothing matches.');
    expect(formatFinding(discarded)).toContain('No fix on');
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toBe(buggySource);
  }, 60_000);

  it('counts a design issue at what the model believes rather than vetoing on it', async () => {
    const { repo, finding } = await scanned();
    const systemOne = scriptedSystemOne({ 'src/clamp.js::clamp': { has_bug: 0.05 } });
    const fix = await fixMethod(options(repo, finding, { systemOne }));
    if (fix.status !== 'ready') throw new Error(`${fix.status}: ${fix.error ?? fix.reason}`);
    expect(fix.expected.correctness).toBeLessThan(0);
  });

  it('lets measure pass a split that adds sibling helpers in the replacement region', async () => {
    const { repo, finding } = await scanned({ has_bug: 0.9, where: 'L0003', kind: 'wrong_return', refactor: 'split', severity: 2 });
    const split = `function above(v, hi) {\n  return v > hi;\n}\n\nexport function clamp(v, lo, hi) {\n  if (v < lo) return lo;\n  if (above(v, hi)) return hi;\n  return v;\n}`;
    const model = scriptedModel({ fix: () => proposal(split, 'Extract the upper-bound check') });
    const fix = await fixMethod(options(repo, finding, { model }));
    expect(fix.status).toBe('ready');
    expect(model.calls.find(call => call.name === 'measure').arguments.source).toContain('function above');
    expect(fix.trace.find(event => event.type === 'tool_result' && event.name === 'measure').result.helpers).toEqual(['above']);
    expect(await readFile(join(repo.root, 'src', 'clamp.js'), 'utf8')).toContain('function above');
  });

  it('refuses a protected branch and a dirty method file, and ignores a test that already fails on the original', async () => {
    const { repo, finding } = await scanned();
    await git(['checkout', '-q', 'main'], repo.root);
    await expect(fixMethod(options(repo, finding, {}))).rejects.toThrow('main is protected');
    await git(['checkout', '-q', 'work'], repo.root);
    await writeFile(join(repo.root, 'src', 'clamp.js'), buggySource + '\n');
    await expect(fixMethod(options(repo, finding, { model: { ...scriptedModel(), id: 'dirty' } }))).rejects.toThrow('uncommitted changes');
    await git(['checkout', '--', 'src/clamp.js'], repo.root);
    await writeFile(join(repo.root, 'test', 'clamp.broken.test.js'), `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { clamp } from '../src/clamp.js';\ntest('wrong on purpose', () => { assert.strictEqual(clamp(1, 0, 10), 2); });\n`);
    await commitAll(repo.root, 'a broken test');
    const fix = await fixMethod(options(repo, finding, { model: { ...scriptedModel(), id: 'tolerant' } }));
    expect(fix.status).toBe('ready');
    expect(fix.checks).toEqual(['test/clamp.test.js']);
    expect(fix.trace.find(event => event.type === 'tool_result' && event.name === 'run_tests').result).toEqual({ ok: true, checks: ['test/clamp.test.js'], ignored_already_failing: ['test/clamp.broken.test.js'] });
  });
});
