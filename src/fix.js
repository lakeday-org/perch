/**
 * `perch fix`: for each open defect, System One first confirms a caller can reach the flagged line; a generative model then returns
 * the corrected method (and only the method); the patch must parse without growing; and System One, asked the hunt's questions
 * again, must find the defect less likely and nothing else changed. No test is run: the judge is System One and the metrics. Each
 * accepted fix is one commit on the current branch. A rejected attempt leaves the checkout as it was.
 */
import { DEFAULT_BUDGET, huntedEvent, questionMethod } from './hunt.js';
import { visibleFindings } from './report.js';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git, revision as gitRevision } from './git.js';
import { languageOf } from './analysis.js';
import { runScan } from './scan.js';
import { buildGraph, resolveModule } from './graph.js';
import { flagged, huntStep, patchCheck, reachCheck, readPatchCheck, SURE } from './questions.js';
import { identity, openStore, readJson, writeJson } from './store.js';
import { fixPrompt } from './prompts.js';
import { describeCall, effortForAttempt } from './model.js';
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
/** Findings under a repository-relative path (a file or a directory). */
export const underPath = (findings, path) => (path ? findings.filter(finding => finding.path === path || finding.path.startsWith(path.replace(/\/$/, '') + '/')) : findings);

export const MAX_ATTEMPTS = 3;
/** Bumped whenever how a fix is made or judged changes, so a rejection recorded by an older pipeline is never reused. */
export const FIX_VERSION = 2;

export function fixIdentity({ finding, model }) {
  return identity('fix', FIX_VERSION, finding.id, finding.hash, model);
}

/** Open defects with no fix record yet, most likely first, capped at `budget`. */
export function pendingFixes(findings, budget = DEFAULT_BUDGET) {
  return visibleFindings(findings).filter(finding => flagged(finding) && !finding.fix).slice(0, budget);
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

/**
 * A patched file passes when it parses, adds no nesting, adds at most one branch (a missing guard is one branch), and moves the file's risk
 * score by at most one point. Enough room for a fix; not enough for a rewrite.
 */
export const MAX_EXTRA_BRANCHES = 1, MAX_EXTRA_RISK = 1;
export const withinQualityGate = (base, changed) => Boolean(changed) && changed.risk_score <= base.risk_score + MAX_EXTRA_RISK &&
  (changed.cyclomatic_complexity ?? 0) <= (base.cyclomatic_complexity ?? 0) + MAX_EXTRA_BRANCHES && (changed.max_nesting ?? 0) <= (base.max_nesting ?? 0);

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
  const scan = await runScan({ root, revision, out, analyzer, log });
  const graph = buildGraph(scan.files);
  const node = graph.nodes.get(finding.method);
  if (!node) throw new Error(`${finding.method} no longer exists at ${revision.slice(0, 12)}; hunt again`);
  const sources = new Map();
  const linesOf = async member => { if (!sources.has(member.path)) sources.set(member.path, (await git(['show', `${revision}:${member.path}`], root)).split('\n')); return sources.get(member.path); };
  const callees = [], callers = [];
  const calleeIds = graph.callees(node.id), callerIds = graph.callers(node.id);
  for (const calleeId of calleeIds) { const callee = graph.nodes.get(calleeId); callees.push({ node: callee, lines: await linesOf(callee), calls: graph.callees(calleeId) }); }
  for (const callerId of callerIds) { const caller = graph.nodes.get(callerId); callers.push({ node: caller, lines: await linesOf(caller), site: graph.site(callerId, node.id) }); }
  const { imports, methods } = graph.files.get(node.path).file;
  const fileLines = await linesOf(node);
  const step = huntStep({ node, lines: fileLines, imports, methods, callees, callers });
  const method = fileLines.slice(node.line - 1, node.end_line).join('\n');
  return { scan, graph, node, fileLines, method, callees, callers, calleeIds, callerIds, imports, methods, step, changed: Boolean(finding.hash) && node.hash !== finding.hash };
}

export async function runFix({ finding: hunted, root, out, model, systemOne, analyzer, shell, ui = plainUi(), log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  const id = fixIdentity({ finding: hunted, model: model.id });
  const dir = store.fixDir(id), fixPath = join(dir, 'fix.json');
  const existing = await readJson(fixPath, null);
  if (existing && ['ready', 'rejected'].includes(existing.status)) {
    ui.say(`${hunted.id} ${hunted.path}::${hunted.name}: already ${existing.status} by ${model.id}; reusing`);
    return existing;
  }
  ui.say(`${hunted.id}  ${hunted.name}  ${hunted.path}:${hunted.where.line}  ${(hunted.kind?.kind ?? 'defect').replaceAll('_', ' ')} ${Math.round(hunted.has_bug * 100)}%`);
  await store.exclude(root);
  // The fix is made and committed in the operator's checkout, on whatever branch is checked out; never on a protected one.
  const branch = await workingBranch(root, 'fix');
  const revision = await gitRevision(root);
  const fix = { id, finding_id: hunted.id, method: hunted.method, path: hunted.path, root, branch, revision, hunted_at: hunted.revision, model: model.id, verifier: systemOne.id, out: dir,
    status: 'running', attempts: [], created_at: new Date().toISOString() };
  await writeJson(fixPath, fix);
  const finish = async (status, extra) => {
    Object.assign(fix, { status, completed_at: new Date().toISOString(), ...extra });
    await writeJson(fixPath, fix);
    const mark = status === 'ready' ? OK : status === 'closed' ? NOTE : FAIL;
    ui.say(`${mark} ${hunted.name}: ${status === 'closed' ? `closed — ${fix.reason}` : `fix ${status}${fix.error ? ` — ${fix.error.split('\n')[0]}` : ''}`}`);
    return fix;
  };
  /** The finding is closed without a fix: System One no longer sees a reachable defect. Recorded so issues drops it. */
  const close = async reason => {
    await store.appendEvent({ type: 'fixed', at: new Date().toISOString(), id: finding.id, fix_id: id, method: finding.method, hash: finding.hash, revision, status: 'closed', attempts: 0, reason });
    return finish('closed', { reason });
  };
  const pct = value => `${Math.round(value * 100)}%`;
  // The finding being fixed: the hunted one, or the fresh answers when the method changed since. Events carry its hash so the store attaches them to it.
  let finding = hunted;
  const rejectedEvent = (attempts, error) => store.appendEvent({ type: 'fixed', at: new Date().toISOString(), id: finding.id, fix_id: id, method: finding.method, hash: finding.hash, revision, status: 'rejected', attempts, error });

  let placed = false;
  try {
    // The same context the hunt showed System One, rebuilt from a scan of HEAD. The method may have moved; the finding's line moves with it.
    const { node, fileLines, method, callees, callers, calleeIds, callerIds, imports, methods, step, changed } = await methodContext({ finding: hunted, root, out, analyzer, revision, log: debug });
    finding = { ...hunted, line: node.line, end_line: node.end_line, where: { ...hunted.where, line: hunted.where.line + node.line - hunted.line } };
    if (changed) {
      // The method reads differently than when it was hunted, so its answers are about code that is gone: ask again, now, and go on from the fresh ones.
      const asking = ui.task(`${systemOne.id} re-reading ${node.qualified_name}, changed since the hunt`);
      const { response, answers } = await questionMethod({ systemOne, node, step, lines: fileLines, debug });
      const event = huntedEvent({ node, answers, response, root, github: hunted.github ?? null, revision, calleeIds, callerIds });
      await store.appendEvent(event);
      finding = event;
      if (!flagged(finding)) {
        asking.note(`defect ${pct(finding.has_bug)}${finding.reachable !== undefined ? `, reachable ${pct(finding.reachable)}` : ''}`);
        return await close(`no reachable defect in the method as it reads now (defect ${pct(finding.has_bug)}${finding.reachable !== undefined ? `, reachable ${pct(finding.reachable)}` : ''})`);
      }
      asking.ok(`still looks defective: ${finding.kind.kind.replaceAll('_', ' ')} ${pct(finding.has_bug)} at line ${finding.where.line}`);
      ui.say(`${finding.id}  ${finding.name}  ${finding.path}:${finding.where.line}  ${finding.kind.kind.replaceAll('_', ' ')} ${pct(finding.has_bug)}`);
    }
    const dirtyBefore = await dirtyPaths(root);
    if (dirtyBefore.includes(node.path)) throw new Error(`${node.path} has uncommitted changes; commit or stash them before perch fix touches it`);

    // 1. Before anything is generated: can a real caller execute the flagged line at all?
    const reaching = ui.task(`${systemOne.id}: can a caller reach ${finding.path}:${finding.where.line}?`);
    const reach = reachCheck({ finding, state: step.state });
    const { answers: reachAnswers } = await systemOne.ask(reach.state, reach.questions);
    const reachable = reachAnswers.reachable.noul;
    fix.reach_check = { reachable };
    if (reachable < SURE) {
      reaching.note(`reachable ${pct(reachable)}`);
      return await close(`no caller can reach the flagged line (${pct(reachable)}); an earlier guard excludes it`);
    }
    reaching.ok(`reachable ${pct(reachable)}`);
    const language = languageOf(node.path);
    const base = (await analyzer.analyzeSource(fileLines.join('\n'), language)).metrics;
    if (!base) throw new Error(`${node.path} does not parse at ${revision.slice(0, 12)}`);

    const place = async text => { await writeFile(join(root, node.path), text); placed = true; };
    const restore = async () => { await git(['checkout', '--', node.path], root); placed = false; };

    let feedback = null, accepted = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !accepted; attempt++) {
      const effort = effortForAttempt(attempt, model.effort);
      const asking = ui.task(`attempt ${attempt} of ${MAX_ATTEMPTS}: ${model.id} writing the fix${feedback ? ', with the rejection fed back' : ''} (effort ${effort})`);
      const proposal = await model.ask(`fix-${attempt}`, fixPrompt({ finding, reachable, state: step.state, method, feedback }), { effort });
      asking.ok(`${proposal.summary || 'no summary'} (${describeCall(model.last)})`);
      const record = { attempt, effort, summary: proposal.summary, method: proposal.method, model_call: model.last };
      fix.attempts.push(record);
      const reject = async (reason, undo = false) => { record.rejected = reason; feedback = reason; ui.say(`${FAIL} attempt ${attempt} rejected: ${reason.split('\n')[0]}`); await writeJson(fixPath, fix); if (undo) await restore(); };

      // 2. Splice by line range and gate on the AST.
      if (!proposal.method.trim() || proposal.method.trim() === method.trim()) { await reject(`the method was returned unchanged: ${proposal.summary || 'no reason given'}`); continue; }
      const patchedLines = [...fileLines.slice(0, node.line - 1), ...methodLines(proposal.method), ...fileLines.slice(node.end_line)];
      const patchedFile = patchedLines.join('\n');
      const after = await analyzer.analyzeSource(patchedFile, language);
      if (after.parser_status !== 'parsed') { await reject(`the patched file does not parse: ${after.parser_message ?? 'syntax error'}`); continue; }
      if (!withinQualityGate(base, after.metrics)) { await reject(`the patch adds nesting, more than one branch, or more than one point of risk (risk ${base.risk_score.toFixed(1)} -> ${after.metrics.risk_score.toFixed(1)}, complexity ${base.cyclomatic_complexity} -> ${after.metrics.cyclomatic_complexity}, nesting ${base.max_nesting} -> ${after.metrics.max_nesting})`); continue; }

      // 3. The hunt's questions again over the patched method: the defect must look less likely, nothing else changed, no caller newly misused.
      const patchedNode = { ...node, end_line: node.line + methodLines(proposal.method).length - 1 };
      const patchedStep = huntStep({ node: patchedNode, lines: patchedLines, imports, methods, callees, callers });
      const verify = patchCheck({ step: patchedStep, original: method, summary: proposal.summary });
      const verifying = ui.task(`${systemOne.id} comparing the patched method (defect was ${pct(finding.has_bug)})`);
      const { answers } = await systemOne.ask(verify.state, verify.questions);
      const { verification, objections } = readPatchCheck({ finding, answers, calledBy: patchedStep.calledBy });
      record.verification = verification;
      if (objections.length) { verifying.fail(objections.join('; ')); await reject(objections.join('; '), true); continue; }
      verifying.ok(`defect ${pct(finding.has_bug)} -> ${pct(verification.has_bug)}, ${finding.kind.kind.replaceAll('_', ' ')} ${pct(finding.kind.probability ?? 0)} -> ${pct(verification.kind ?? 0)}, collateral ${pct(verification.collateral_change)}`);

      // 4. Commit on the current branch, with the model's summary as the message.
      await place(patchedFile);
      await git(['add', '--', node.path], root);
      const patch = await git(['diff', '--cached', '--', node.path], root);
      if (!patch) throw new Error(`Patch for ${node.path} could not be captured`);
      await git(['commit', '-q', '-m', proposal.summary, '-m', `perch ${finding.id}`, '--', node.path], root);
      placed = false;
      const commit = await gitRevision(root);
      ui.say(`${OK} committed ${commit.slice(0, 7)} on ${branch}: ${proposal.summary}`);
      accepted = { proposal, record, patch, commit };
    }
    if (!accepted) {
      await rejectedEvent(fix.attempts.length, feedback);
      return await finish('rejected', { error: feedback });
    }

    const patchPath = join(dir, 'fix.patch');
    await writeFile(patchPath, accepted.patch);
    const verification = { kind: finding.kind.kind, before: { has_bug: finding.has_bug, kind: finding.kind.probability ?? null, reachable }, after: accepted.record.verification };
    await store.appendEvent({ type: 'fixed', at: new Date().toISOString(), id: finding.id, fix_id: id, method: finding.method, hash: finding.hash, revision, status: 'ready', summary: accepted.proposal.summary,
      commit: accepted.commit, branch, patch_path: patchPath, verification });
    return await finish('ready', { summary: accepted.proposal.summary, commit: accepted.commit, patch_path: patchPath, verification });
  } catch (error) {
    fix.status = 'failed';
    fix.error = error.message;
    await writeJson(fixPath, fix).catch(() => {});
    throw error;
  } finally {
    // Whatever an interrupted attempt left in the checkout goes back to HEAD.
    if (placed) await git(['checkout', '--', hunted.path], root).catch(() => {});
  }
}

/**
 * Work open defects, most likely first, until `budget` have been tried; each proven fix is one commit on the current branch.
 * Findings whose method no longer reads as hunted are set aside and counted, not attempted.
 */
export async function runFixQueue({ findings, budget = DEFAULT_BUDGET, root, out, model, systemOne, analyzer, shell, ui = plainUi(), log = () => {}, debug = () => {} }) {
  const pending = pendingFixes(findings, Infinity);
  let current = pending, stale = [];
  if (root && pending.length) {
    const scan = await runScan({ root, revision: await gitRevision(root), out, analyzer, log: debug, debug });
    ({ current, stale } = splitStale(pending, scan));
    if (stale.length) ui.say(`${stale.length} ${stale.length === 1 ? 'finding is' : 'findings are'} for methods that no longer exist under that name; hunt again to see what replaced them`);
  }
  const selected = current.slice(0, budget);
  const fixes = [];
  for (const [index, finding] of selected.entries()) {
    ui.say(`\n[${index + 1}/${selected.length}]`);
    const findingRoot = finding.root ?? root;
    try {
      if (!findingRoot) throw new Error(`finding ${finding.id} has no repository recorded; hunt again`);
      fixes.push(await runFix({ finding, root: findingRoot, out, model, systemOne, analyzer, shell, ui, log, debug }));
    } catch (error) {
      ui.say(`${FAIL} ${finding.id} failed: ${error.message.split('\n')[0]}`);
      fixes.push({ id: null, finding_id: finding.id, method: finding.method, path: finding.path, root: findingRoot, revision: finding.revision, out, status: 'failed', error: error.message });
    }
  }
  return { kind: 'fix', budget, open: current.length, stale: stale.length, attempted: fixes.length, remaining: Math.max(0, current.length - selected.length), fixes };
}
