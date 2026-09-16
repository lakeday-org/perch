/**
 * `perch fix`: one agent per method, every issue the scan raised about it as an objective. The generating model rewrites the method
 * (and the comment above it) with the verifiers as tools, and the decisive verifier is the scan itself run again over the rewrite:
 * tree-sitter and the full System One question set, with the same neighborhood. The rewrite is accepted only when every issue is
 * every issue gone and nothing new appeared, the tests that reach the method still pass, and the model submits that exact source.
 * Each accepted result is one commit on the current branch; a rejected run leaves the checkout as it was.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git, listTree, revision as gitRevision } from './git.js';
import { DEFAULT_FIX_BUDGET, huntedEvent, questionMethod } from './hunt.js';
import { formatFix, visibleFindings } from './report.js';
import { languageOf } from './analysis.js';
import { analyzeTree } from './scan.js';
import { buildGraph, resolveModule } from './graph.js';
import { ANSWERS_VERSION, expectedIssues, huntStep, issuesOf } from './questions.js';
import { identity, openStore, readJson, sha256, writeJson } from './store.js';
import { fixPrompt, goalOf } from './prompts.js';
import { Abort, DEFAULT_EFFORT, tool } from './model.js';
import { createMeter, metered } from './meter.js';
import { discoverProject } from './project.js';
import { COMMAND_MS, workspaceEnv } from './workspace.js';
import { FAIL, NOTE, OK, plainUi } from './ui.js';

export const PROTECTED_BRANCHES = ['main', 'master'];
/** Paths with uncommitted changes, untracked files included. */
export const dirtyPaths = async root => (await git(['status', '--porcelain', '--untracked-files=all', '-z'], root)).split('\0').filter(Boolean).map(entry => entry.slice(3).split(' -> ').at(-1));
/** The checked-out branch, refusing the protected ones: perch commits to it. */
export async function workingBranch(root, verb) {
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).trim();
  if (PROTECTED_BRANCHES.includes(branch)) throw new Error(`perch ${verb} commits to the current branch, and ${branch} is protected; check out a feature branch first`);
  return branch;
}
/** A commit line: one line, under 72 characters, starting with a word (no ticket-speak); trailing period dropped. */
export function plainSummary(summary) {
  const text = String(summary ?? '').trim().split('\n')[0].replace(/\.$/, '');
  if (!text) return { error: 'summary is required: the commit line, under 72 characters, imperative, plain words' };
  if (text.length > 72) return { error: `summary is ${text.length} characters; the commit line must be under 72, imperative, plain words` };
  return { text };
}
/** Marketing words and hedges that make a note unreadable; a rejected note names the one it used. */
const CLANKERESE = /\b(leverag\w+|robust|comprehensive|seamless\w*|streamlin\w+|utiliz\w+|holistic|synerg\w+|cutting-edge|best-in-class|delve[sd]?|underscor\w+|pivotal|myriad)\b/i;
/**
 * The note that ships with a fix: two or three plain sentences saying what was wrong, what changed, and why that is better.
 * A reviewer reads this instead of the diff, so it must be prose an engineer would write, not bullets and not marketing.
 */
export function plainNotes(notes) {
  const text = String(notes ?? '').trim().replace(/\s*\n\s*/g, ' ');
  if (!text) return { error: 'notes is required: two or three plain sentences saying what was wrong, what you changed, and why it is better' };
  if (text.length < 40) return { error: 'notes is too short to tell a reviewer anything; two or three sentences' };
  if (text.length > 600) return { error: `notes is ${text.length} characters; keep it under 600` };
  if (/^[-*\u2022]|\n[-*\u2022]/.test(notes.trim())) return { error: 'notes must be sentences, not bullets' };
  if (/^(this|the)\s+(commit|change|patch|pr|rewrite|refactor)\b/i.test(text)) return { error: 'start with what was wrong or what you did, not "This change"' };
  const filler = text.match(CLANKERESE);
  if (filler) return { error: `notes uses "${filler[0]}"; write it the way you would explain the change to the next engineer` };
  return { text };
}

/**
 * How much bigger the whole file may get. Splitting a method into helpers costs a few signatures and returns, so a little growth is
 * honest; a rewrite that inflates the file has moved the mess rather than removed it, whatever it did for the one method's score.
 *
 * Closing a hole means validating, bounding, or escaping something, and every one of those is a branch. So when a vulnerability is
 * among the objectives there is no complexity ceiling: refusing a security fix to hold a complexity number is the wrong trade, and
 * the line budget still stops a rewrite from turning into a rewrite of the file.
 */
export function fileBudget(base, { security = false } = {}) {
  return {
    // A split moves decisions, it does not create them; the slack is for a real error path the fix adds.
    cyclomatic_complexity: security ? Infinity : base.cyclomatic_complexity + Math.max(2, Math.round(base.cyclomatic_complexity * 0.05)),
    sloc: base.sloc + Math.max(25, Math.round(base.sloc * 0.1)),
  };
}
/** Why a rewrite that helps one method still leaves the file worse off. */
export function fileObjections(base, after, { security = false } = {}) {
  const limit = fileBudget(base, { security }), objections = [];
  if (after.cyclomatic_complexity > limit.cyclomatic_complexity) objections.push(`the file's complexity goes up too far, ${base.cyclomatic_complexity} -> ${after.cyclomatic_complexity}, and ${limit.cyclomatic_complexity} is the most this fix may leave`);
  if (after.sloc > limit.sloc) objections.push(`the file grows too much, ${base.sloc} -> ${after.sloc} lines, and ${limit.sloc} is the most this fix may leave`);
  return objections;
}

/** Findings under a repository-relative path (a file or a directory). */
export const underPath = (findings, path) => (path ? findings.filter(finding => finding.path === path || finding.path.startsWith(path.replace(/\/$/, '') + '/')) : findings);

/** Rescans and test runs one fix may spend. */
export const MAX_RESCANS = 12, MAX_TEST_RUNS = 6;
/** Bumped whenever how a fix is made or judged changes, so a rejection recorded by an older pipeline is never reused. */
export const FIX_VERSION = 6;

export function fixIdentity({ finding, model }) {
  return identity('fix', FIX_VERSION, finding.id, finding.hash, model);
}

/** Open issues nothing has worked yet, strongest first, capped at `budget`. */
export function pendingFixes(findings, budget = DEFAULT_FIX_BUDGET) {
  return visibleFindings(findings).filter(finding => !finding.fix).slice(0, budget);
}

/**
 * Findings whose method still exists at HEAD, and the rest. A changed method is re-questioned when its turn comes; one that is gone
 * (removed, renamed, or moved to another file) has nothing left to fix under that name.
 */
export function splitStale(findings, scan) {
  const live = new Set((scan.files ?? []).flatMap(file => file.methods.map(method => method.id)));
  const current = [], stale = [];
  for (const finding of findings) (live.has(finding.method) ? current : stale).push(finding);
  return { current, stale };
}

const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export const tail = result => (result.stdout + result.stderr).trim().slice(-1500);

const commentLine = /^\s*(\/\/|\/\*|\*|#|"""|''')/;
/** The first line of the comment block sitting directly above a method, or the method's own line when there is none. */
export function regionStart(lines, line) {
  let start = line;
  while (start > 1 && commentLine.test(lines[start - 2])) start--;
  return start;
}
/** The same lines in a different order, or the same text: a rewrite that changes nothing. */
export const sameLines = (before, after) => {
  const bag = text => text.split('\n').map(line => line.trim()).filter(Boolean).sort().join('\n');
  return bag(before) === bag(after);
};
const trim = metrics => (metrics ? { risk_score: metrics.risk_score, maintainability_index: metrics.maintainability_index, cyclomatic_complexity: metrics.cyclomatic_complexity, max_nesting: metrics.max_nesting, sloc: metrics.sloc } : null);
/**
 * Whether a rewrite resolved a method's issues: every prior issue is gone from the rescan
 * (below the listing threshold), a defect is gone even if a weaker signal remains, and nothing new appeared.
 * A 1% nudge on "too big" does not count.
 */
/**
 * Whether a rewrite is worth keeping, judged by how many problems each reading expects rather than by whether any number crossed a
 * line. Every answer contributes its own probability, so a defect at 90% falling to 40% counts for what it is instead of being
 * called "still open", and a refactor the scan names for the first time counts against the rewrite only as much as the model
 * believes it.
 *
 * Correctness and design are counted apart and neither may rise: a rewrite that closes a hole by making the method incoherent is
 * not an improvement, and nor is one that tidies the shape while introducing a bug. At least one of the two must fall, or nothing
 * happened. Cost in complexity is not counted at all; a fix that needs another branch is still a fix.
 */
export function improvement(before, after) {
  const round = value => Math.round(value * 100) / 100;
  const shift = { correctness: round(after.correctness - before.correctness), design: round(after.design - before.design) };
  // Pareto: neither kind may rise, and one must fall. A rewrite does not get to buy correctness with shape or shape with bugs.
  const objections = ['correctness', 'design'].filter(name => shift[name] > 0)
    .map(name => `${name} up ${shift[name].toFixed(2)}: the rewrite is expected to leave more problems of that kind than it found`);
  if (!objections.length && shift.correctness === 0 && shift.design === 0) objections.push('nothing the scan can see changed: the same problems are expected as before');
  return { objections, shift, better: !objections.length };
}

export const command = (template, file) => template.replaceAll('{file}', quote(file)).replaceAll('{dir}', quote(dirname(file) === '.' ? '.' : `./${dirname(file)}`));
export const methodLines = method => method.replace(/\n$/, '').split('\n');

/**
 * Test files that reach a method: test methods that call it in the graph, test files that import its file directly or through one
 * re-exporting module (an index.js), and for Go the tests of its package.
 */
export function testsTouching({ graph, files, node }) {
  const paths = new Set(files.map(file => file.path)), byPath = new Map(files.map(file => [file.path, file]));
  const importsOf = file => [...new Set(file.imports.map(item => resolveModule(file.path, item.module, file.language, paths)).filter(Boolean))];
  const reexporters = new Set(files.filter(file => !file.test && file.path !== node.path && importsOf(file).includes(node.path)).map(file => file.path));
  const touching = new Set(graph.callers(node.id).map(id => graph.nodes.get(id)).filter(caller => caller.test).map(caller => caller.path));
  for (const file of files) {
    if (!file.test || file.path === node.path || /(^|\/)(fixtures?|__fixtures__|helpers?|__mocks__|mocks|support)(\/|$)/.test(dirname(file.path))) continue;
    const imported = importsOf(file);
    if (imported.includes(node.path) || imported.some(path => reexporters.has(path) && byPath.has(path))) touching.add(file.path);
    else if (file.language === 'go' && node.language === 'go' && dirname(file.path) === dirname(node.path)) touching.add(file.path);
  }
  return [...touching].sort();
}

/**
 * The finding's method at `revision` (the checkout's HEAD by default) with the same neighborhood the hunt showed: file lines, callees,
 * callers, imports, and the hunt step built from them. `changed` says whether the method reads differently than when it was hunted.
 */
export async function methodContext({ finding, root, out, analyzer, revision = finding.revision, log = () => {} }) {
  const scan = await analyzeTree({ root, revision, out, analyzer, log });
  const graph = buildGraph(scan.files);
  const node = graph.nodes.get(finding.method);
  if (!node) throw new Error(`${finding.method} no longer exists at ${revision.slice(0, 12)}; hunt again`);
  const sources = new Map();
  const linesOf = async member => { if (!sources.has(member.path)) sources.set(member.path, (await git(['show', `${revision}:${member.path}`], root)).split('\n')); return sources.get(member.path); };
  const callees = [], callers = [];
  const calleeIds = graph.callees(node.id), callerIds = graph.callers(node.id);
  for (const calleeId of calleeIds) { const callee = graph.nodes.get(calleeId); callees.push({ node: callee, lines: await linesOf(callee), calls: graph.callees(calleeId) }); }
  for (const callerId of callerIds) { const caller = graph.nodes.get(callerId); callers.push({ node: caller, lines: await linesOf(caller), site: graph.site(callerId, node.id), handover: graph.isDynamic(callerId, node.id) }); }
  const { imports, methods } = graph.files.get(node.path).file;
  const fileLines = await linesOf(node);
  const step = huntStep({ node, lines: fileLines, imports, methods, callees, callers });
  const method = fileLines.slice(node.line - 1, node.end_line).join('\n');
  return { scan, graph, node, fileLines, method, callees, callers, calleeIds, callerIds, imports, methods, step, changed: Boolean(finding.hash) && node.hash !== finding.hash };
}

export async function fixMethod({ finding: hunted, root, out, model, systemOne: rawSystemOne, analyzer, shell, ui = plainUi(), meter = createMeter(), position = '', log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  const systemOne = metered(rawSystemOne, meter);
  const id = fixIdentity({ finding: hunted, model: model.id });
  const dir = store.fixDir(id), fixPath = join(dir, 'fix.json');
  const existing = await readJson(fixPath, null);
  if (existing && ['ready', 'rejected', 'closed'].includes(existing.status)) {
    ui.say(`${hunted.id}  ${hunted.name}  ${hunted.path}: already ${existing.status} by ${model.id}; reusing`);
    return existing;
  }
  await store.exclude(root);
  const branch = await workingBranch(root, 'fix');
  const revision = await gitRevision(root);
  const fix = { id, finding_id: hunted.id, method: hunted.method, path: hunted.path, line: hunted.line, root, branch, revision, hunted_at: hunted.revision, model: model.id, verifier: systemOne.id, out: dir, status: 'running', created_at: new Date().toISOString() };
  await writeJson(fixPath, fix);
  const pct = value => `${Math.round(value * 100)}%`;
  let finding = hunted;
  const finish = async (status, extra) => {
    Object.assign(fix, { status, completed_at: new Date().toISOString(), ...extra, usage: meter.toJSON() });
    await writeJson(fixPath, fix);
    await store.appendEvent({ type: 'fixed', at: fix.completed_at, id: finding.id, fix_id: id, method: finding.method, hash: finding.hash, revision, status, summary: fix.summary ?? null, notes: fix.notes ?? null, hash_after: fix.hash_after ?? null, commit: fix.commit ?? null, branch, patch_path: fix.patch_path ?? null, before: fix.before ?? null, after: fix.after ?? null, reason: fix.reason ?? null, error: fix.error ?? null, attempts: fix.turns ?? 0 });
    if (status !== 'ready') ui.say(`${status === 'closed' ? NOTE : FAIL} ${hunted.name}: ${status === 'closed' ? `closed — ${fix.reason}` : `no fix — ${(fix.error ?? '').split('\n')[0]}`}`);
    return fix;
  };

  let placed = false;
  try {
    // The method as it reads at HEAD, with the neighborhood the scan showed System One. If it changed since, System One reads it again first.
    const { scan, graph, node, fileLines, callees, callers, calleeIds, callerIds, imports, methods, step, changed } = await methodContext({ finding: hunted, root, out, analyzer, revision, log: debug });
    const fileOf = () => scan.files.find(file => file.path === node.path);
    finding = { ...hunted, line: node.line, end_line: node.end_line, metrics: node.metrics, file: fileOf()?.metrics ?? null, where: hunted.where ? { ...hunted.where, line: hunted.where.line + node.line - hunted.line } : hunted.where };
    const stale = finding.has_bug !== undefined && (finding.answers_version ?? 1) !== ANSWERS_VERSION;
    if (changed || stale || finding.has_bug === undefined) {
      const why = changed ? ', changed since the scan' : stale ? ', answered before the questions changed' : ' for the first time';
      const reading = ui.task(`${systemOne.id} reading ${node.qualified_name}${why}`);
      const { response, answers } = await questionMethod({ systemOne, node, step, lines: fileLines, debug });
      const event = huntedEvent({ node, answers, response, root, github: hunted.github ?? null, revision, calleeIds, callerIds });
      await store.appendEvent(event);
      finding = { ...event, metrics: node.metrics, file: finding.file };
      reading.ok(issuesOf(finding).map(issue => issue.text).join(', ') || 'no issues');
    }
    const before = issuesOf(finding);
    if (!before.length) return await finish('closed', { reason: 'no open issue on the method as it reads now' });
    const dirtyBefore = await dirtyPaths(root);
    if (dirtyBefore.includes(node.path)) throw new Error(`${node.path} has uncommitted changes; commit or stash them before perch fix touches it`);

    // The objectives, stated up front: one line naming the method, one naming everything that has to be gone. What each issue
    // asks for in words is in the model's prompt, where it does the work; --verbose repeats it here.
    ui.say(`${position}${finding.id}  ${finding.name}  ${finding.path}:${finding.line}`, `  Clear   ${before.map(issue => issue.text).join(', ')}`);
    for (const issue of before) debug(`${issue.text.padEnd(28)} -> ${goalOf(issue, systemOne.id)}`);

    fix.before = before;

    const language = languageOf(node.path);
    const base = (await analyzer.analyzeSource(fileLines.join('\n'), language)).metrics;
    if (!base) throw new Error(`${node.path} does not parse at ${revision.slice(0, 12)}`);
    const start = regionStart(fileLines, node.line), end = node.end_line;
    const region = fileLines.slice(start - 1, end).join('\n');
    const splice = source => [...fileLines.slice(0, start - 1), ...methodLines(source), ...fileLines.slice(end)];

    // The tests that reach the method, run only when the model asks; one already failing on the original is ignored, not blamed.
    const tracked = new Set((await listTree(root, revision)).map(item => item.path));
    const project = await discoverProject({ root, revision, out, paths: [...tracked], systemOne, log: debug });
    const reaching = testsTouching({ graph, files: scan.files, node });
    const runFile = file => shell.run(command(project.single, file), { cwd: root, timeoutMs: COMMAND_MS, env: workspaceEnv() });
    const checks = project.single ? reaching.map(path => ({ name: path, run: () => runFile(path) })) : [];
    if (!checks.length && project.suite) checks.push({ name: project.suite, run: () => shell.run(project.suite, { cwd: root, timeoutMs: 4 * COMMAND_MS, env: workspaceEnv() }) });
    const ignored = new Set();
    fix.checks = checks.map(check => check.name);

    /**
     * Replace the tracked method's file with candidate source for a test run.
     * The path must be in the revision being fixed; a successful write sets `placed`
     * so the caller's cleanup restores it, and a failed write leaves the checkout flag clear.
     */
    const place = async text => {
      if (!tracked.has(node.path)) throw new Abort(`refusing to write an untracked path: ${node.path}`);
      const target = join(root, node.path);
      try {
        await writeFile(target, text);
        placed = true;
      } catch (error) {
        placed = false;
        throw error;
      }
    };
    const restore = async () => { await git(['checkout', '--', node.path], root); placed = false; };
    // Only what moved: "risk 84 -> 62, complexity 55 -> 40". A number that did not change is not news.
    const shift = (from, to) => [['risk', 'risk_score'], ['complexity', 'cyclomatic_complexity'], ['nesting', 'max_nesting'], ['lines', 'sloc']]
      .filter(([, key]) => Math.round(from[key]) !== Math.round(to[key]))
      .map(([name, key]) => `${name} ${Math.round(from[key])} -> ${Math.round(to[key])}`).join(', ') || 'unchanged';

    // The verifiers, as tools. Each remembers the exact source it passed; submit insists on all that apply.
    const passed = { measure: new Map(), rescan: new Map(), tests: new Map() };
    let rescans = 0, testRuns = 0;
    const measure = async ({ source }) => {
      if (!source.trim() || sameLines(region, source)) return { ok: false, error: 'the source is the original, or the original\'s lines in another order; nothing changed' };
      const replacement = methodLines(source);
      const patchedLines = splice(source);
      const after = await analyzer.analyzeSource(patchedLines.join('\n'), language);
      if (after.parser_status !== 'parsed') return { ok: false, error: `the file does not parse: ${after.parser_message ?? 'syntax error'}` };
      const regionEnd = start + replacement.length - 1;
      const inRegion = after.declarations.filter(declaration => declaration.line >= start && declaration.line <= regionEnd && declaration.name !== '<anonymous>');
      const kept = inRegion.find(declaration => declaration.qualified_name === node.qualified_name);
      if (!kept) return { ok: false, error: `keep a method named ${node.qualified_name} in lines ${start}-${regionEnd}; found ${inRegion.map(declaration => declaration.qualified_name).join(', ') || 'none'}` };
      const fileMetrics = trim(after.metrics), metrics = trim(kept.metrics);
      const bloat = fileObjections(base, fileMetrics, { security: before.some(issue => issue.type === 'security') });
      if (bloat.length) return { ok: false, error: `${bloat.join('; ')}. Take code out of the file or cut it; do not add.`, file: shift(base, fileMetrics) };
      const detail = { file: shift(base, fileMetrics), method: shift(node.metrics ?? metrics, metrics), helpers: inRegion.filter(declaration => declaration.qualified_name !== node.qualified_name).map(declaration => declaration.qualified_name) };
      // measure only checks that the rewrite parses and keeps the method; rescan and the tests decide whether it improved.
      passed.measure.set(source, { kept, metrics, fileMetrics, inRegion: inRegion.map(declaration => ({ line: declaration.line, end_line: declaration.end_line, qualified_name: declaration.qualified_name })), replacementLength: replacement.length });
      return { ok: true, ...detail };
    };
    const rescan = async ({ source }) => {
      if (!passed.measure.has(source)) return { ok: false, error: 'run measure on this exact source first' };
      // Out of rescans with nothing that passed means there is no way left to finish, so the run ends here rather than turning over.
      if (++rescans > MAX_RESCANS) return passed.rescan.size
        ? { ok: false, error: `no more than ${MAX_RESCANS} rescans per fix; submit the source that already passed` }
        : { ok: false, done: true, error: `no rewrite cleared the issues in ${MAX_RESCANS} rescans` };
      const { kept, metrics, fileMetrics, inRegion, replacementLength } = passed.measure.get(source);
      const patchedLines = splice(source);
      const shifted = replacementLength - (end - start + 1);
      const patchedMethods = methods.filter(other => other.id !== node.id).map(other => (other.line > end ? { ...other, line: other.line + shifted, end_line: other.end_line + shifted } : other)).concat(inRegion);
      const patchedNode = { ...node, line: kept.line, end_line: kept.end_line, metrics };
      const patchedStep = huntStep({ node: patchedNode, lines: patchedLines, imports, methods: patchedMethods, callees, callers });
      const { answers } = await questionMethod({ systemOne, node: patchedNode, step: patchedStep, lines: patchedLines, debug });
      const reading = { ...answers, metrics, file: fileMetrics };
      const after = issuesOf(reading);
      const { objections, shift } = improvement(expectedIssues(finding, before), expectedIssues(reading, after));
      const result = { before: before.map(issue => issue.text), after: after.map(issue => issue.text), expected: shift };
      if (objections.length) return { ok: false, error: objections.join('; '), ...result };
      passed.rescan.set(source, { answers, after, shift });
      return { ok: true, ...result };
    };
    const runTests = async ({ source }) => {
      if (!passed.measure.has(source)) return { ok: false, error: 'run measure on this exact source first' };
      if (!checks.length) { passed.tests.set(source, []); return { ok: true, checks: [], note: 'no test reaches this method and no suite command was found' }; }
      if (++testRuns > MAX_TEST_RUNS) return passed.tests.size
        ? { ok: false, error: `no more than ${MAX_TEST_RUNS} test runs per fix; submit the source that already passed` }
        : { ok: false, done: true, error: `no rewrite passed the tests in ${MAX_TEST_RUNS} runs` };
      const patched = splice(source).join('\n');
      await place(patched);
      try {
        for (const check of checks) {
          if (ignored.has(check.name)) continue;
          const result = await check.run();
          if (result.exit_code === 0) continue;
          await restore();
          const control = await check.run();
          await place(patched);
          if (control.exit_code !== 0) { ignored.add(check.name); continue; }
          return { ok: false, error: `${check.name} fails on the rewrite and passes on the original`, output: tail(result) };
        }
        const changedPaths = (await dirtyPaths(root)).filter(path => !dirtyBefore.includes(path));
        if (changedPaths.join('\n') !== node.path) throw new Abort(`the checkout changed while perch fix was running (${changedPaths.filter(path => path !== node.path).join(', ') || 'unknown'}); commit or stash your work and run it again`);
      } finally { await restore(); }
      const ran = checks.map(check => check.name).filter(name => !ignored.has(name));
      passed.tests.set(source, ran);
      return { ok: true, checks: ran, ...(ignored.size ? { ignored_already_failing: [...ignored] } : {}) };
    };
    let accepted = null, refusedSubmits = 0;
    const submit = async ({ source, summary, notes }) => {
      for (const [name, map] of [['measure', passed.measure], ['rescan', passed.rescan], ['run_tests', passed.tests]]) {
        if (map.has(source)) continue;
        // Submitting again cannot make a check pass, so a model that keeps trying is looping, not working.
        if (++refusedSubmits >= 3) return { ok: false, done: true, error: `submitted ${refusedSubmits} times without ${name} passing that source` };
        return { ok: false, error: `${name} has not passed this exact source; run it, and if it rejects the source then change the source` };
      }
      const line = plainSummary(summary);
      if (line.error) return { ok: false, error: line.error };
      const note = plainNotes(notes);
      if (note.error) return { ok: false, error: note.error };
      accepted = { source, summary: line.text, notes: note.text, ...passed.measure.get(source), ...passed.rescan.get(source), checks: passed.tests.get(source) };
      return { ok: true, done: true };
    };
    const MAX_READ_LINES = 400;
    const read = async ({ path }) => {
      if (!tracked.has(path)) {
        const prefix = path.replace(/\/$/, '') + '/';
        const inside = [...tracked].filter(item => item.startsWith(prefix));
        if (inside.length) return { ok: true, path, directory: inside.slice(0, 200) };
        const near = [...tracked].filter(item => item.endsWith(`/${path.split('/').at(-1)}`)).slice(0, 5);
        return { ok: false, error: `${path} is not tracked at this revision${near.length ? `; did you mean ${near.join(', ')}?` : ''}` };
      }
      const lines = (await git(['show', `${revision}:${path}`], root)).split('\n');
      const shown = lines.slice(0, MAX_READ_LINES).map((text, index) => `${index + 1}| ${text}`).join('\n');
      return { ok: true, path, lines: lines.length, source: shown + (lines.length > MAX_READ_LINES ? `\n... ${lines.length - MAX_READ_LINES} more lines` : '') };
    };
    const tools = [
      tool('read', 'Read any file tracked at this revision, with line numbers, or list a directory, when the context below does not tell you enough: a caller you need to keep working, a callee\'s real contract, a test that covers this method, a sibling that already does what you are about to write.', { path: { type: 'string', description: 'repository-relative path' } }, read),
      tool('measure', `Splice the rewrite over lines ${start}-${end} of ${node.path} and measure with tree-sitter: it must parse and still contain ${node.qualified_name}. Sibling helpers in that range are fine. Returns the method and file metrics; improvement is judged by rescan, not here. Call this on every version you write.`, { source: { type: 'string', description: 'replacement for the region: comment, method, and any helpers it needs' } }, measure),
      tool('rescan', 'Run the scan again over the rewrite: the same System One questions with the same neighborhood, plus the metrics. Every issue the scan raised must be gone (no longer listed), a defect gone outright, and nothing new. A tiny probability drop is not enough. Requires measure to have passed this exact source.', { source: { type: 'string' } }, rescan),
      tool('run_tests', `Run the tests that reach ${node.qualified_name}${checks.length ? ` (${checks.map(check => check.name).join(', ')})` : ' (none found; passes trivially)'} against the rewrite. Requires measure to have passed this exact source.`, { source: { type: 'string' } }, runTests),
      tool('submit', 'Finish with the rewrite. Refused unless measure, rescan, and run_tests have all passed this exact source.',
        { source: { type: 'string' }, summary: { type: 'string', description: 'the commit line: imperative, under 72 characters' },
          notes: { type: 'string', description: 'two or three plain sentences for the reviewer: what was wrong, what you changed, why it is better. No bullets, no marketing words.' } }, submit),
    ];

    const effort = model.effort ?? DEFAULT_EFFORT;
    const names = { read: 'read', measure: 'measure', rescan: 'rescan', run_tests: 'tests', submit: 'submit' };
    const running = ui.task(`${model.id} working (effort ${effort})`);
    let current = null;
    /** What one tool call is worth saying: the method it moved, the issues it left, the file it read, the tests it ran. */
    const detailOf = r => r.error ?? (r.method ? `method ${r.method}${r.file && r.file !== 'unchanged' ? `, file ${r.file}` : ''}`
      : r.after ? (r.after.join(', ') || 'nothing left')
      : r.directory ? `${r.path}, ${r.directory.length} files` : r.source !== undefined ? `${r.path}, ${r.lines} lines`
      : r.checks ? (r.checks.length ? `${r.checks.length} pass${r.ignored_already_failing ? ` (${r.ignored_already_failing.join(', ')} already failing, ignored)` : ''}` : r.note ?? 'nothing to run') : '');
    const onEvent = event => {
      if (event.type === 'tool_call') current = ui.task(names[event.name] ?? event.name, { width: 7, indent: '  ' });
      else if (event.type === 'tool_result' && current) {
        const r = event.result ?? {};
        (r.ok ? current.ok : current.fail)(detailOf(r)); current = null;
        running.update(`${model.id} working (turn ${event.turn}, effort ${effort})`);
      }
    };
    const run = await model.run({ prompt: fixPrompt({ finding, before, fileMetrics: trim(base), budget: fileBudget(base, { security: before.some(issue => issue.type === 'security') }), state: step.state, region, start, end, checks: checks.map(check => check.name) }), tools, effort, onEvent });
    meter.add(model.id, run.usage, { turns: run.turns, requests: run.turns });
    Object.assign(fix, { trace: run.trace, turns: run.turns });
    if (!accepted) {
      running.update(`${model.id} gave up`);
      running.fail(`${run.turns} turns`);
      const lastError = [...run.trace].reverse().find(event => event.type === 'tool_result' && event.result?.error)?.result.error ?? 'the model never submitted a verified rewrite';
      return await finish('rejected', { error: lastError });
    }
    running.update(`${model.id} done`);
    running.ok(`${run.turns} ${run.turns === 1 ? 'turn' : 'turns'}`);

    await place(splice(accepted.source).join('\n'));
    await git(['add', '--', node.path], root);
    const patch = await git(['diff', '--cached', '--', node.path], root);
    if (!patch) throw new Error(`Patch for ${node.path} could not be captured`);
    await git(['commit', '-q', '-m', accepted.summary, '-m', `perch ${finding.id}`, '--', node.path], root);
    placed = false;
    const commit = await gitRevision(root);
    const patchPath = join(dir, 'fix.patch');
    await writeFile(patchPath, patch);
    ui.say(`${OK} ${commit.slice(0, 7)} ${accepted.summary}`);
    // The hash of the method as it now reads, so `issues` shows this fix against what it produced rather than what it replaced.
    const hashAfter = sha256(splice(accepted.source).slice(accepted.kept.line - 1, accepted.kept.end_line).join('\n'));
    return await finish('ready', { summary: accepted.summary, notes: accepted.notes, line: node.line, hash_after: hashAfter, commit, patch_path: patchPath, before, after: accepted.after, file_before: trim(base), file_after: accepted.fileMetrics, method_before: trim(node.metrics), method_after: accepted.metrics, expected: accepted.shift, checks: accepted.checks });
  } catch (error) {
    fix.status = 'failed';
    fix.error = error.message;
    await writeJson(fixPath, fix).catch(() => {});
    throw error;
  } finally {
    if (placed) await git(['checkout', '--', hunted.path], root).catch(() => {});
  }
}

/**
 * Work open issues, strongest first, until `budget` have been tried; each accepted result is one commit on the current branch.
 * Findings whose method no longer exists are set aside and counted, not attempted.
 */
export async function fixIssues({ findings, budget = DEFAULT_FIX_BUDGET, root, out, model, systemOne, analyzer, shell, ui = plainUi(), meter = createMeter(), log = () => {}, debug = () => {} }) {
  const pending = pendingFixes(findings, Infinity);
  let current = pending, stale = [];
  if (root && pending.length) {
    const scan = await analyzeTree({ root, revision: await gitRevision(root), out, analyzer, log: debug, debug });
    ({ current, stale } = splitStale(pending, scan));
    if (stale.length) ui.say(`${stale.length} ${stale.length === 1 ? 'finding is' : 'findings are'} for methods that no longer exist under that name; scan again to see what replaced them`);
  }
  const selected = current.slice(0, budget);
  const fixes = [];
  let stopped = null;
  for (const [index, finding] of selected.entries()) {
    ui.say('');
    const findingRoot = finding.root ?? root;
    try {
      if (!findingRoot) throw new Error(`finding ${finding.id} has no repository recorded; scan again`);
      const fix = await fixMethod({ finding, root: findingRoot, out, model, systemOne, analyzer, shell, ui, meter: createMeter(), position: `[${index + 1}/${selected.length}]  `, log, debug });
      fixes.push(fix);
      ui.say('', ...formatFix(fix).split('\n'));
    } catch (error) {
      ui.say(`${FAIL} ${finding.id} failed: ${error.message.split('\n')[0]}`);
      fixes.push({ id: null, finding_id: finding.id, method: finding.method, path: finding.path, root: findingRoot, revision: finding.revision, out, status: 'failed', error: error.message });
      // An Abort is not this finding's fault: the checkout is no longer one perch can work in, and it will not be for the next
      // finding either. Stopping here costs one wasted run instead of the whole budget.
      if (error instanceof Abort) { stopped = error; break; }
    }
  }
  if (stopped) ui.say(`${FAIL} stopped with ${selected.length - fixes.length} of ${selected.length} not attempted: ${stopped.message.split('\n')[0]}`);
  for (const fix of fixes) for (const [name, entry] of Object.entries(fix.usage ?? {})) meter.add(name, { input_tokens: entry.input, cached_tokens: entry.cached, output_tokens: entry.output, reasoning_tokens: entry.reasoning }, { turns: entry.turns, requests: entry.requests });
  return { budget, open: current.length, stale: stale.length, attempted: fixes.length, stopped: stopped?.message ?? null,
    remaining: Math.max(0, current.length - fixes.length), fixes, usage: meter.toJSON(), usage_lines: meter.lines() };
}
