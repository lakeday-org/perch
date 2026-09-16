/**
 * `perch refactor`: a pass over the scan, not the hunt. The riskiest methods by tree-sitter metrics (risk score, maintainability,
 * complexity, nesting) are handed to a generative model to simplify; a rewrite is accepted only when the method's own metrics improve,
 * every test that reaches it still passes, and System One agrees behavior is unchanged. Each accepted rewrite is one commit on the
 * current branch. No System One question is asked before the rewrite exists; the metrics are the trigger.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git, listTree, revision as gitRevision } from './git.js';
import { languageOf } from './analysis.js';
import { runScan } from './scan.js';
import { huntStep, readRefactorCheck, refactorCheck } from './questions.js';
import { discoverProject } from './project.js';
import { COMMAND_MS, workspaceEnv } from './workspace.js';
import { identity, openStore, readJson, writeJson } from './store.js';
import { refactorPrompt } from './prompts.js';
import { command, dirtyPaths, MAX_ATTEMPTS, methodContext, methodLines, tail, testsTouching, underPath, workingBranch } from './fix.js';
import { DEFAULT_BUDGET } from './hunt.js';
import { describeCall, effortForAttempt } from './model.js';
import { FAIL, OK, plainUi } from './ui.js';

/** Methods at or above this risk score are refactor candidates by default. */
export const DEFAULT_MIN_RISK = 70;
export const refactorIdentity = ({ method, model }) => identity('refactor', method.id, method.hash, model);

const commentLine = /^\s*(\/\/|\/\*|\*|#|"""|''')/;
/** The first line of the comment block sitting directly above a method, or the method's own line when there is none. */
export function regionStart(lines, line) {
  let start = line;
  while (start > 1 && commentLine.test(lines[start - 2])) start--;
  return start;
}

const trim = metrics => (metrics ? { risk_score: metrics.risk_score, maintainability_index: metrics.maintainability_index, cyclomatic_complexity: metrics.cyclomatic_complexity, max_nesting: metrics.max_nesting, sloc: metrics.sloc } : null);
/** The method must come out less risky and no more complex or nested; the file as a whole may not get more complex, deeper, or more than a point riskier. */
export const improves = (before, after) => Boolean(after) && after.risk_score < before.risk_score && (after.cyclomatic_complexity ?? 0) <= (before.cyclomatic_complexity ?? 0) && (after.max_nesting ?? 0) <= (before.max_nesting ?? 0);
export const withinRefactorGate = (base, changed) => Boolean(changed) && changed.risk_score <= base.risk_score + 1 &&
  (changed.cyclomatic_complexity ?? 0) <= (base.cyclomatic_complexity ?? 0) && (changed.max_nesting ?? 0) <= (base.max_nesting ?? 0);

/** Scan methods worth refactoring: riskiest first, at or above `min`, under `path` when given; test methods are never candidates. */
export function refactorCandidates(scan, { path = null, min = DEFAULT_MIN_RISK } = {}) {
  const methods = new Map((scan.files ?? []).flatMap(file => file.methods.map(method => [method.id, { ...method, path: file.path }])));
  return underPath((scan.candidates ?? []).map(candidate => methods.get(candidate.id)).filter(method => method?.metrics && method.metrics.risk_score >= min), path);
}

export async function runRefactor({ method: target, root, out, model, systemOne, analyzer, shell, ui = plainUi(), log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  const id = refactorIdentity({ method: target, model: model.id });
  const dir = store.refactorDir(id), recordPath = join(dir, 'refactor.json');
  const existing = await readJson(recordPath, null);
  if (existing && ['ready', 'rejected'].includes(existing.status)) {
    ui.say(`${target.qualified_name} ${target.path}: already ${existing.status} by ${model.id}; reusing`);
    return existing;
  }
  ui.say(`${target.qualified_name}  ${target.path}:${target.line}  risk ${Math.round(target.metrics.risk_score)}, complexity ${target.metrics.cyclomatic_complexity}, nesting ${target.metrics.max_nesting}, ${target.metrics.sloc} lines`);
  await store.exclude(root);
  const branch = await workingBranch(root, 'refactor');
  const revision = await gitRevision(root);
  const record = { id, kind: 'refactor', method: target.id, name: target.qualified_name, path: target.path, root, branch, revision, hash: target.hash, model: model.id, verifier: systemOne.id, out: dir,
    before: trim(target.metrics), status: 'running', attempts: [], created_at: new Date().toISOString() };
  await writeJson(recordPath, record);
  const finish = async (status, extra) => {
    Object.assign(record, { status, completed_at: new Date().toISOString(), ...extra });
    await writeJson(recordPath, record);
    ui.say(`${status === 'ready' ? OK : FAIL} ${target.qualified_name}: refactor ${status}${record.error ? ` — ${record.error.split('\n')[0]}` : ''}`);
    return record;
  };
  const event = extra => store.appendEvent({ type: 'refactored', at: new Date().toISOString(), refactor_id: id, method: target.id, hash: target.hash, revision, ...extra });

  let placed = false;
  try {
    const { scan, graph, node, fileLines, callees, callers, imports, methods, step } = await methodContext({ finding: { method: target.id, hash: target.hash, revision }, root, out, analyzer, revision, log: debug });
    const before = trim(node.metrics);
    if (!before) throw new Error(`${node.id} has no metrics to improve`);
    const dirtyBefore = await dirtyPaths(root);
    if (dirtyBefore.includes(node.path)) throw new Error(`${node.path} has uncommitted changes; commit or stash them before perch refactor touches it`);
    const language = languageOf(node.path);
    const base = (await analyzer.analyzeSource(fileLines.join('\n'), language)).metrics;
    if (!base) throw new Error(`${node.path} does not parse at ${revision.slice(0, 12)}`);
    const start = regionStart(fileLines, node.line), end = node.end_line;
    const region = fileLines.slice(start - 1, end).join('\n');

    // The safety net: every test that reaches the method, or the whole suite when none does.
    const treePaths = (await listTree(root, revision)).map(item => item.path);
    const existingTests = testsTouching({ graph, files: scan.files, node });
    const project = await discoverProject({ root, revision, out, paths: treePaths, systemOne, log: debug });
    const runFile = file => shell.run(command(project.single, file), { cwd: root, timeoutMs: COMMAND_MS, env: workspaceEnv() });
    const runSuite = () => shell.run(project.suite, { cwd: root, timeoutMs: 4 * COMMAND_MS, env: workspaceEnv() });
    const checks = [];
    for (const path of existingTests) {
      if (!project.single) break;
      const running = ui.task(`${path} on the original`);
      if ((await runFile(path)).exit_code === 0) { checks.push({ name: path, run: () => runFile(path) }); running.ok('passes'); } else running.note('already fails; will not count');
    }
    if (!checks.length && project.suite) {
      const running = ui.task(`no passing test reaches ${node.qualified_name}; the suite (${project.suite}) on the original`);
      if ((await runSuite()).exit_code === 0) { checks.push({ name: project.suite, run: runSuite }); running.ok('passes'); } else { running.fail('already fails'); throw new Error(`The test suite (${project.suite}) already fails on the original, so a refactor cannot be checked against it`); }
    }
    if (!checks.length) throw new Error(`No passing test reaches ${node.qualified_name} and no suite command was found, so a refactor cannot be checked`);
    Object.assign(record, { existing_tests: existingTests, checks: checks.map(check => check.name), region: { start, end } });
    await writeJson(recordPath, record);

    const place = async text => { await mkdir(dirname(join(root, node.path)), { recursive: true }); await writeFile(join(root, node.path), text); placed = true; };
    const restore = async () => { await git(['checkout', '--', node.path], root); placed = false; };
    const shift = (from, to) => `risk ${Math.round(from.risk_score)} -> ${Math.round(to.risk_score)}, complexity ${from.cyclomatic_complexity} -> ${to.cyclomatic_complexity}, nesting ${from.max_nesting} -> ${to.max_nesting}`;

    let feedback = null, accepted = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !accepted; attempt++) {
      const effort = effortForAttempt(attempt, model.effort);
      const asking = ui.task(`attempt ${attempt} of ${MAX_ATTEMPTS}: ${model.id} simplifying ${node.qualified_name}${feedback ? ', with the rejection fed back' : ''} (effort ${effort})`);
      const proposal = await model.ask(`refactor-${attempt}`, refactorPrompt({ node, metrics: before, state: step.state, region, start, end, feedback }), { effort });
      asking.ok(`${proposal.summary || 'no summary'} (${describeCall(model.last)})`);
      const entry = { attempt, effort, summary: proposal.summary, source: proposal.source, model_call: model.last };
      record.attempts.push(entry);
      const reject = async (reason, undo = false) => { entry.rejected = reason; feedback = reason; ui.say(`${FAIL} attempt ${attempt} rejected: ${reason.split('\n')[0]}`); await writeJson(recordPath, record); if (undo) await restore(); };

      // 1. Splice the region and measure: it must parse, keep the method, and the method's own metrics must improve.
      if (!proposal.source.trim() || proposal.source.trim() === region.trim()) { await reject(`the source was returned unchanged: ${proposal.summary || 'no reason given'}`); continue; }
      const replacement = methodLines(proposal.source);
      const patchedLines = [...fileLines.slice(0, start - 1), ...replacement, ...fileLines.slice(end)];
      const patchedFile = patchedLines.join('\n');
      const after = await analyzer.analyzeSource(patchedFile, language);
      if (after.parser_status !== 'parsed') { await reject(`the rewritten file does not parse: ${after.parser_message ?? 'syntax error'}`); continue; }
      const regionEnd = start + replacement.length - 1;
      const inRegion = after.declarations.filter(declaration => declaration.line >= start && declaration.line <= regionEnd && declaration.name !== '<anonymous>');
      const kept = inRegion.find(declaration => declaration.qualified_name === node.qualified_name);
      if (!kept) { await reject(`the rewrite must keep a method named ${node.qualified_name} in lines ${start}-${regionEnd}; found ${inRegion.map(declaration => declaration.qualified_name).join(', ') || 'none'}`); continue; }
      const metrics = trim(kept.metrics);
      entry.after = metrics;
      if (!improves(before, metrics)) { await reject(`the rewrite does not make ${node.qualified_name} less risky without adding complexity or nesting (${shift(before, metrics)})`); continue; }
      if (!withinRefactorGate(base, after.metrics)) { await reject(`the rewrite makes the file as a whole more complex, deeper, or riskier (file ${shift(base, after.metrics)})`); continue; }
      ui.say(`${OK} measures better: ${shift(before, metrics)}`);

      // 2. The tests that reach the method still pass on the rewrite.
      await place(patchedFile);
      let broken = null;
      const testing = ui.task(`${checks.length} ${checks.length === 1 ? 'check' : 'checks'} on the rewrite`);
      for (const check of checks) { testing.update(`${check.name} on the rewrite`); const result = await check.run(); if (result.exit_code !== 0) { broken = `${check.name}:\n${tail(result)}`; break; } }
      entry.checks = broken ? 'failed' : `${checks.length} passed`;
      if (broken) testing.fail(broken.split('\n')[0]); else testing.ok('all pass');
      if (broken) { await reject(`a test broke on the rewrite: ${broken}`, true); continue; }
      const changed = (await dirtyPaths(root)).filter(path => !dirtyBefore.includes(path));
      if (changed.join('\n') !== node.path) throw new Error(`The test run changed files other than ${node.path}: ${changed.join(', ') || 'none'}`);

      // 3. System One compares the two versions with the same neighborhood: behavior unchanged, no defect picked up, name still true.
      const patchedNode = { ...node, line: kept.line, end_line: kept.end_line, metrics };
      const shifted = replacement.length - (end - start + 1);
      const patchedMethods = methods.filter(other => other.id !== node.id).map(other => (other.line > end ? { ...other, line: other.line + shifted, end_line: other.end_line + shifted } : other)).concat(inRegion.map(declaration => ({ line: declaration.line, end_line: declaration.end_line })));
      const patchedStep = huntStep({ node: patchedNode, lines: patchedLines, imports, methods: patchedMethods, callees, callers });
      const verify = refactorCheck({ step: patchedStep, original: region, summary: proposal.summary });
      const verifying = ui.task(`${systemOne.id} comparing the two versions`);
      const { answers } = await systemOne.ask(verify.state, verify.questions);
      const { verification, objections } = readRefactorCheck({ answers });
      entry.verification = verification;
      if (objections.length) { verifying.fail(objections.join('; ')); await reject(objections.join('; '), true); continue; }
      verifying.ok(`behavior change ${Math.round(verification.collateral_change * 100)}%, defect ${Math.round(verification.has_bug * 100)}%`);

      // 4. Commit on the current branch.
      await git(['add', '--', node.path], root);
      const patch = await git(['diff', '--cached', '--', node.path], root);
      await git(['commit', '-q', '-m', proposal.summary, '-m', `perch refactor ${node.id}`, '--', node.path], root);
      placed = false;
      const commit = await gitRevision(root);
      ui.say(`${OK} committed ${commit.slice(0, 7)} on ${branch}: ${proposal.summary}`);
      accepted = { proposal, entry, patch, commit };
    }
    if (!accepted) {
      await event({ status: 'rejected', attempts: record.attempts.length, error: feedback });
      return await finish('rejected', { error: feedback });
    }
    const patchPath = join(dir, 'refactor.patch');
    await writeFile(patchPath, accepted.patch);
    const result = { summary: accepted.proposal.summary, commit: accepted.commit, patch_path: patchPath, after: accepted.entry.after, verification: accepted.entry.verification, proof: { checks: checks.map(check => check.name) } };
    await event({ status: 'ready', branch, before, ...result });
    return await finish('ready', result);
  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    await writeJson(recordPath, record).catch(() => {});
    throw error;
  } finally {
    if (placed) await git(['checkout', '--', target.path], root).catch(() => {});
  }
}

/** Scan the checkout at HEAD and simplify its riskiest methods, up to `budget`, under `path` when given; each accepted rewrite is one commit. */
export async function runRefactorQueue({ root, out, path = null, budget = DEFAULT_BUDGET, min = DEFAULT_MIN_RISK, model, systemOne, analyzer, shell, ui = plainUi(), log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  const revision = await gitRevision(root);
  const scan = await runScan({ root, revision, out, analyzer, log: debug, debug });
  const done = new Set((await store.listRefactors()).filter(record => ['ready', 'rejected'].includes(record.status)).map(record => record.id));
  const candidates = refactorCandidates(scan, { path, min }).filter(method => !done.has(refactorIdentity({ method, model: model.id })));
  const selected = candidates.slice(0, budget);
  const fixes = [];
  ui.say(`${candidates.length} ${candidates.length === 1 ? 'method' : 'methods'} at risk ${min} or more${path ? ` under ${path}` : ''}; working ${selected.length}`);
  for (const [index, method] of selected.entries()) {
    ui.say(`\n[${index + 1}/${selected.length}]`);
    try { fixes.push(await runRefactor({ method, root, out, model, systemOne, analyzer, shell, ui, log, debug })); }
    catch (error) {
      ui.say(`${FAIL} ${method.id} failed: ${error.message.split('\n')[0]}`);
      fixes.push({ id: null, kind: 'refactor', method: method.id, name: method.qualified_name, path: method.path, root, revision, before: trim(method.metrics), out, status: 'failed', error: error.message });
    }
  }
  return { kind: 'refactor', budget, min, open: candidates.length, attempted: fixes.length, remaining: Math.max(0, candidates.length - selected.length), fixes };
}
