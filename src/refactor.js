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
import { discoverProject } from './project.js';
import { COMMAND_MS, workspaceEnv } from './workspace.js';
import { identity, openStore, readJson, writeJson } from './store.js';
import { refactorPrompt } from './prompts.js';
import { command, dirtyPaths, MAX_VERIFICATIONS, methodContext, methodLines, tail, testsTouching, underPath, workingBranch } from './fix.js';
import { DEFAULT_BUDGET } from './hunt.js';
import { DEFAULT_EFFORT, describeRun, tool } from './model.js';
import { FAIL, OK, plainUi } from './ui.js';

/** Methods at or above this risk score are refactor candidates by default. */
export const DEFAULT_MIN_RISK = 70;
/** Bumped whenever how a refactor is made or judged changes, so a rejection recorded by an older pipeline is never reused. */
export const REFACTOR_VERSION = 3;
/** Test runs one refactor may spend; each runs every check. */
export const MAX_TEST_RUNS = 6;
export const refactorIdentity = ({ method, model }) => identity('refactor', REFACTOR_VERSION, method.id, method.hash, model);

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
    before: trim(target.metrics), status: 'running', created_at: new Date().toISOString() };
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

    // The safety net: every test that reaches the method, or the whole suite when none does. Nothing runs until the model asks; a test
    // that fails on the rewrite is then run on the original once, and one that already fails there is ignored rather than blamed.
    const treePaths = (await listTree(root, revision)).map(item => item.path);
    const existingTests = testsTouching({ graph, files: scan.files, node });
    const project = await discoverProject({ root, revision, out, paths: treePaths, systemOne, log: debug });
    const runFile = file => shell.run(command(project.single, file), { cwd: root, timeoutMs: COMMAND_MS, env: workspaceEnv() });
    const runSuite = () => shell.run(project.suite, { cwd: root, timeoutMs: 4 * COMMAND_MS, env: workspaceEnv() });
    const checks = project.single ? existingTests.map(path => ({ name: path, run: () => runFile(path) })) : [];
    if (!checks.length && project.suite) checks.push({ name: project.suite, run: runSuite });
    if (!checks.length) throw new Error(`No test reaches ${node.qualified_name} and no suite command was found, so a refactor cannot be checked`);
    const ignored = new Set();
    Object.assign(record, { existing_tests: existingTests, checks: checks.map(check => check.name), region: { start, end } });
    await writeJson(recordPath, record);

    const place = async text => { await mkdir(dirname(join(root, node.path)), { recursive: true }); await writeFile(join(root, node.path), text); placed = true; };
    const restore = async () => { await git(['checkout', '--', node.path], root); placed = false; };
    const shift = (from, to) => `risk ${Math.round(from.risk_score)} -> ${Math.round(to.risk_score)}, complexity ${from.cyclomatic_complexity} -> ${to.cyclomatic_complexity}, nesting ${from.max_nesting} -> ${to.max_nesting}`;
    const splice = source => [...fileLines.slice(0, start - 1), ...methodLines(source), ...fileLines.slice(end)];

    // The verifiers, as tools. Each remembers what it passed, keyed by the exact source, so submit can insist on all three.
    const passed = { measure: new Map(), tests: new Map() };
    let testRuns = 0;
    const measure = async ({ source }) => {
      if (!source.trim() || source.trim() === region.trim()) return { ok: false, error: 'the source is unchanged' };
      const replacement = methodLines(source);
      const patchedLines = splice(source);
      const after = await analyzer.analyzeSource(patchedLines.join('\n'), language);
      if (after.parser_status !== 'parsed') return { ok: false, error: `the rewritten file does not parse: ${after.parser_message ?? 'syntax error'}` };
      const regionEnd = start + replacement.length - 1;
      const inRegion = after.declarations.filter(declaration => declaration.line >= start && declaration.line <= regionEnd && declaration.name !== '<anonymous>');
      const kept = inRegion.find(declaration => declaration.qualified_name === node.qualified_name);
      if (!kept) return { ok: false, error: `the rewrite must keep a method named ${node.qualified_name} in lines ${start}-${regionEnd}; found ${inRegion.map(declaration => declaration.qualified_name).join(', ') || 'none'}` };
      const metrics = trim(kept.metrics);
      const detail = { method: shift(before, metrics), file: shift(base, after.metrics) };
      if (!improves(before, metrics)) return { ok: false, error: `${node.qualified_name} must come out less risky with complexity and nesting no higher`, ...detail };
      if (!withinRefactorGate(base, after.metrics)) return { ok: false, error: 'the file as a whole may not get more complex, deeper, or more than a point riskier', ...detail };
      passed.measure.set(source, { kept, metrics, inRegion: inRegion.map(declaration => ({ line: declaration.line, end_line: declaration.end_line })), replacementLength: replacement.length });
      return { ok: true, ...detail };
    };
    const runTests = async ({ source }) => {
      if (!passed.measure.has(source)) return { ok: false, error: 'run measure on this exact source first' };
      if (++testRuns > MAX_TEST_RUNS) return { ok: false, error: `no more than ${MAX_TEST_RUNS} test runs per refactor` };
      const patched = splice(source).join('\n');
      await place(patched);
      try {
        for (const check of checks) {
          if (ignored.has(check.name)) continue;
          const result = await check.run();
          if (result.exit_code === 0) continue;
          // Before the rewrite takes the blame: does this test pass on the original at all?
          await restore();
          const control = await check.run();
          await place(patched);
          if (control.exit_code !== 0) { ignored.add(check.name); continue; }
          return { ok: false, error: `${check.name} fails on the rewrite and passes on the original`, output: tail(result) };
        }
        const changed = (await dirtyPaths(root)).filter(path => !dirtyBefore.includes(path));
        if (changed.join('\n') !== node.path) throw new Error(`The test run changed files other than ${node.path}: ${changed.join(', ') || 'none'}`);
      } finally { await restore(); }
      const ran = checks.map(check => check.name).filter(name => !ignored.has(name));
      if (!ran.length) return { ok: false, error: 'every test that reaches the method already fails on the original, so nothing can check the rewrite' };
      passed.tests.set(source, ran);
      return { ok: true, checks: ran, ...(ignored.size ? { ignored_already_failing: [...ignored] } : {}) };
    };
    let accepted = null;
    const submit = async ({ source, summary }) => {
      for (const [name, map] of [['measure', passed.measure], ['run_tests', passed.tests]]) if (!map.has(source)) return { ok: false, error: `${name} has not passed this exact source` };
      if (!summary.trim()) return { ok: false, error: 'summary is required: one sentence, as a commit message' };
      accepted = { source, summary, metrics: passed.measure.get(source).metrics, checks: passed.tests.get(source) };
      return { ok: true, done: true };
    };
    const tools = [
      tool('measure', `Splice the rewrite over lines ${start}-${end} and measure it with tree-sitter: it must parse, keep a method named ${node.qualified_name}, make that method less risky with complexity and nesting no higher, and not make the file deeper, more complex, or more than a point riskier. Call this on every version you write.`, { source: { type: 'string', description: 'the complete replacement for the region: comment, method, any helpers' } }, measure),
      tool('run_tests', `Run the tests that reach ${node.qualified_name} (${checks.map(check => check.name).join(', ')}) against the rewrite. Requires measure to have passed this exact source.`, { source: { type: 'string' } }, runTests),
      tool('submit', 'Finish with the rewrite. Refused unless measure and run_tests have both passed this exact source.', { source: { type: 'string' }, summary: { type: 'string', description: 'one sentence: what the change does, as a commit message' } }, submit),
    ];

    const effort = model.effort ?? DEFAULT_EFFORT;
    const running = ui.task(`${model.id} simplifying ${node.qualified_name}: thinking (effort ${effort})`);
    let current = null;
    const onEvent = event => {
      if (event.type === 'tool_call') current = ui.task(`${model.id} ▸ ${event.name}${event.arguments?.summary ? ` — ${event.arguments.summary}` : ''}`);
      else if (event.type === 'tool_result' && current) { const r = event.result ?? {}; const detail = r.error ?? r.method ?? (r.checks ? `${r.checks.length} pass${r.ignored_already_failing ? ` (${r.ignored_already_failing.join(', ')} already failing on the original, ignored)` : ''}` : ''); (r.ok ? current.ok : current.fail)(detail); current = null; running.update(`${model.id} simplifying ${node.qualified_name}: thinking (turn ${event.turn}, effort ${effort})`); }
    };
    const run = await model.run({ prompt: refactorPrompt({ node, metrics: before, state: step.state, region, start, end }), tools, effort, onEvent });
    Object.assign(record, { trace: run.trace, usage: run.usage, turns: run.turns });
    if (!accepted) {
      running.fail(`no accepted submit in ${run.turns} turns (${describeRun(run)})`);
      const lastError = [...run.trace].reverse().find(item => item.type === 'tool_result' && item.result?.error)?.result.error ?? 'the model never submitted a verified rewrite';
      await event({ status: 'rejected', attempts: run.turns, error: lastError });
      return await finish('rejected', { error: lastError });
    }
    running.ok(`${accepted.summary} (${describeRun(run)})`);

    await place(splice(accepted.source).join('\n'));
    await git(['add', '--', node.path], root);
    const patch = await git(['diff', '--cached', '--', node.path], root);
    await git(['commit', '-q', '-m', accepted.summary, '-m', `perch refactor ${node.id}`, '--', node.path], root);
    placed = false;
    const commit = await gitRevision(root);
    ui.say(`${OK} committed ${commit.slice(0, 7)} on ${branch}: ${accepted.summary} (${shift(before, accepted.metrics)})`);
    const patchPath = join(dir, 'refactor.patch');
    await writeFile(patchPath, patch);
    const result = { summary: accepted.summary, commit, patch_path: patchPath, after: accepted.metrics, proof: { checks: accepted.checks } };
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
