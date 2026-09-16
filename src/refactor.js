/**
 * `perch refactor`: for a method the hunt says needs design work (a refactor, a name or comment that misdescribes it, missing
 * documentation), get a rewrite of the method and its comment from a generative model, keep every test that reaches the method
 * passing, have System One confirm it reads better and behaves the same, and commit it on the current branch. No bug is fixed here;
 * a refactor that changes behavior is rejected.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git, listTree, revision as gitRevision } from './git.js';
import { languageOf } from './analysis.js';
import { huntStep, isDesign, issuesOf, readRefactorCheck, refactorCheck, REFACTORS } from './questions.js';
import { discoverProject } from './project.js';
import { COMMAND_MS, workspaceEnv } from './workspace.js';
import { identity, openStore, readJson, writeJson } from './store.js';
import { refactorPrompt } from './prompts.js';
import { command, dirtyPaths, MAX_ATTEMPTS, methodContext, methodLines, tail, testsTouching, workingBranch } from './fix.js';

export const refactorIdentity = ({ finding, model }) => identity('refactor', finding.id, finding.hash, model);

const commentLine = /^\s*(\/\/|\/\*|\*|#|"""|''')/;
/** The first line of the comment block sitting directly above a method, or the method's own line when there is none. */
export function regionStart(lines, line) {
  let start = line;
  while (start > 1 && commentLine.test(lines[start - 2])) start--;
  return start;
}

/** A rewrite may not make the file deeper or more complex, and may move its risk score by at most one point; it usually does the reverse. */
export const withinRefactorGate = (base, changed) => Boolean(changed) && changed.risk_score <= base.risk_score + 1 &&
  (changed.cyclomatic_complexity ?? 0) <= (base.cyclomatic_complexity ?? 0) && (changed.max_nesting ?? 0) <= (base.max_nesting ?? 0);

export async function runRefactor({ finding: hunted, root, out, model, systemOne, analyzer, shell, log = () => {} }) {
  const store = openStore(out);
  const id = refactorIdentity({ finding: hunted, model: model.id });
  const dir = join(out, 'refactors', id), recordPath = join(dir, 'refactor.json');
  const existing = await readJson(recordPath, null);
  if (existing && ['ready', 'rejected'].includes(existing.status)) {
    log(`refactor ${id} already ${existing.status}; reusing ${recordPath}`);
    return existing;
  }
  await store.exclude(root);
  const branch = await workingBranch(root, 'refactor');
  const revision = await gitRevision(root);
  const record = { id, kind: 'refactor', finding_id: hunted.id, method: hunted.method, path: hunted.path, root, branch, revision, hunted_at: hunted.revision, model: model.id, verifier: systemOne.id, out: dir,
    status: 'running', attempts: [], created_at: new Date().toISOString() };
  await writeJson(recordPath, record);
  const finish = async (status, extra) => {
    Object.assign(record, { status, completed_at: new Date().toISOString(), ...extra });
    await writeJson(recordPath, record);
    log(`${hunted.path}: refactor ${status}${record.error ? `: ${record.error}` : ''}`);
    return record;
  };
  const event = extra => store.appendEvent({ type: 'refactored', at: new Date().toISOString(), id: hunted.id, refactor_id: id, method: hunted.method, hash: hunted.hash, revision, ...extra });

  let placed = false;
  try {
    const { scan, graph, node, fileLines, callees, callers, imports, step } = await methodContext({ finding: hunted, root, out, analyzer, revision, log });
    const finding = { ...hunted, line: node.line, end_line: node.end_line };
    const issues = issuesOf(finding).filter(isDesign);
    if (!issues.length) throw new Error(`${finding.method} has no design issue at 50% or more; nothing to refactor`);
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
    const project = await discoverProject({ root, revision, out, paths: treePaths, systemOne, log });
    const runFile = file => shell.run(command(project.single, file), { cwd: root, timeoutMs: COMMAND_MS, env: workspaceEnv() });
    const runSuite = () => shell.run(project.suite, { cwd: root, timeoutMs: 4 * COMMAND_MS, env: workspaceEnv() });
    const checks = [];
    for (const path of existingTests) {
      if (!project.single) break;
      log(`running existing test ${path} on the original`);
      if ((await runFile(path)).exit_code === 0) checks.push({ name: path, run: () => runFile(path) }); else log(`${path} already fails on the original; it will not count`);
    }
    if (!checks.length && project.suite) {
      log(`no passing test reaches ${node.qualified_name}; running the suite (${project.suite}) on the original`);
      if ((await runSuite()).exit_code === 0) checks.push({ name: project.suite, run: runSuite }); else throw new Error(`The test suite (${project.suite}) already fails on the original, so a refactor cannot be checked against it`);
    }
    if (!checks.length) throw new Error(`No passing test reaches ${node.qualified_name} and no suite command was found, so a refactor cannot be checked`);
    Object.assign(record, { issues, existing_tests: existingTests, checks: checks.map(check => check.name), region: { start, end } });
    await writeJson(recordPath, record);

    const place = async text => { await mkdir(dirname(join(root, node.path)), { recursive: true }); await writeFile(join(root, node.path), text); placed = true; };
    const restore = async () => { await git(['checkout', '--', node.path], root); placed = false; };
    const refactorDescription = finding.refactor?.refactor && finding.refactor.refactor !== 'none' ? REFACTORS[finding.refactor.refactor] : '';

    let feedback = null, accepted = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !accepted; attempt++) {
      log(`asking ${model.id} for a rewrite (attempt ${attempt})`);
      const proposal = await model.ask(`refactor-${attempt}`, refactorPrompt({ finding, issues, refactorDescription, state: step.state, region, start, end, feedback }));
      const entry = { attempt, summary: proposal.summary, source: proposal.source };
      record.attempts.push(entry);
      const reject = async (reason, undo = false) => { entry.rejected = reason; feedback = reason; log(`attempt ${attempt} rejected: ${reason.split('\n')[0]}`); await writeJson(recordPath, record); if (undo) await restore(); };

      // 1. Splice the region and gate on the AST: it must parse, keep the method, and not get deeper or more complex.
      if (!proposal.source.trim() || proposal.source.trim() === region.trim()) { await reject(`the source was returned unchanged: ${proposal.summary || 'no reason given'}`); continue; }
      const replacement = methodLines(proposal.source);
      const patchedLines = [...fileLines.slice(0, start - 1), ...replacement, ...fileLines.slice(end)];
      const patchedFile = patchedLines.join('\n');
      const after = await analyzer.analyzeSource(patchedFile, language);
      if (after.parser_status !== 'parsed') { await reject(`the rewritten file does not parse: ${after.parser_message ?? 'syntax error'}`); continue; }
      if (!withinRefactorGate(base, after.metrics)) { await reject(`the rewrite makes the file deeper, more complex, or riskier (risk ${base.risk_score.toFixed(1)} -> ${after.metrics.risk_score.toFixed(1)}, complexity ${base.cyclomatic_complexity} -> ${after.metrics.cyclomatic_complexity}, nesting ${base.max_nesting} -> ${after.metrics.max_nesting})`); continue; }
      const regionEnd = start + replacement.length - 1;
      const inRegion = after.declarations.filter(declaration => declaration.line >= start && declaration.line <= regionEnd && declaration.name !== '<anonymous>');
      const kept = inRegion.find(declaration => declaration.qualified_name === node.qualified_name);
      if (!kept) { await reject(`the rewrite must keep a method named ${node.qualified_name} in lines ${start}-${regionEnd}; found ${inRegion.map(declaration => declaration.qualified_name).join(', ') || 'none'}`); continue; }

      // 2. The tests that reach the method still pass on the rewrite.
      await place(patchedFile);
      let broken = null;
      for (const check of checks) { const result = await check.run(); if (result.exit_code !== 0) { broken = `${check.name}:\n${tail(result)}`; break; } }
      entry.checks = broken ? 'failed' : `${checks.length} passed`;
      if (broken) { await reject(`a test broke on the rewrite: ${broken}`, true); continue; }
      const changed = (await dirtyPaths(root)).filter(path => !dirtyBefore.includes(path));
      if (changed.join('\n') !== node.path) throw new Error(`The test run changed files other than ${node.path}: ${changed.join(', ') || 'none'}`);

      // 3. System One reads the rewrite with the same neighborhood: each issue must look less likely, behavior unchanged.
      const patchedNode = { ...node, line: kept.line, end_line: kept.end_line, metrics: kept.metrics ? { risk_score: kept.metrics.risk_score, maintainability_index: kept.metrics.maintainability_index, cyclomatic_complexity: kept.metrics.cyclomatic_complexity, max_nesting: kept.metrics.max_nesting, sloc: kept.metrics.sloc } : node.metrics };
      const patchedStep = huntStep({ node: patchedNode, lines: patchedLines, imports, callees, callers });
      const verify = refactorCheck({ step: patchedStep, original: region, summary: proposal.summary });
      log(`asking ${systemOne.id} whether the rewrite reads better and behaves the same`);
      const { answers } = await systemOne.ask(verify.state, verify.questions);
      const { verification, objections } = readRefactorCheck({ finding, issues, answers });
      entry.verification = verification;
      if (objections.length) { await reject(objections.join('; '), true); continue; }

      // 4. Commit on the current branch.
      await git(['add', '--', node.path], root);
      const patch = await git(['diff', '--cached', '--', node.path], root);
      await git(['commit', '-q', '-m', proposal.summary, '-m', `perch ${finding.id}`, '--', node.path], root);
      placed = false;
      const commit = await gitRevision(root);
      log(`committed ${commit.slice(0, 7)} on ${branch}: ${proposal.summary}`);
      accepted = { proposal, entry, patch, commit };
    }
    if (!accepted) {
      await event({ status: 'rejected', attempts: record.attempts.length, error: feedback });
      return await finish('rejected', { error: feedback });
    }
    const patchPath = join(dir, 'refactor.patch');
    await writeFile(patchPath, accepted.patch);
    const verification = { issues, after: accepted.entry.verification };
    const proof = { checks: checks.map(check => check.name) };
    await event({ status: 'ready', summary: accepted.proposal.summary, commit: accepted.commit, branch, patch_path: patchPath, verification, proof });
    return await finish('ready', { summary: accepted.proposal.summary, commit: accepted.commit, patch_path: patchPath, verification, proof });
  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    await writeJson(recordPath, record).catch(() => {});
    throw error;
  } finally {
    if (placed) await git(['checkout', '--', hunted.path], root).catch(() => {});
  }
}
