/**
 * `perch fix issues` / `perch fix design`: for each selected finding, get a corrected method and a regression test from a generative
 * model, check the test with System One, prove it in the operator's checkout (fails on the original with an assertion, passes on the
 * patch, the existing tests that touch the method still pass), question the patched method again, and commit it on the current
 * branch. A rejected attempt leaves the checkout as it was. The proof is recorded in the events log so issues shows it.
 */
import { DEFAULT_BUDGET } from './hunt.js';
import { visibleFindings } from './report.js';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { git, listTree, revision as gitRevision } from './git.js';
import { languageOf, testFile } from './analysis.js';
import { runScan } from './scan.js';
import { buildGraph, resolveModule } from './graph.js';
import { flagged, huntStep, patchCheck, reachCheck, readPatchCheck, soundTest, SURE, testCheck, testObjections } from './questions.js';
import { discoverProject } from './project.js';
import { COMMAND_MS, workspaceEnv } from './workspace.js';
import { identity, openStore, readJson, writeJson } from './store.js';
import { fixPrompt } from './prompts.js';
import { describeCall, effortForAttempt } from './model.js';
import { FAIL, OK, plainUi } from './ui.js';

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

export function fixIdentity({ finding, model }) {
  return identity('fix', finding.id, finding.hash, model);
}

/** Open defects with no fix record yet, most likely first, capped at `budget`. */
export function pendingFixes(findings, budget = DEFAULT_BUDGET) {
  return visibleFindings(findings).filter(finding => flagged(finding) && !finding.fix).slice(0, budget);
}

/**
 * Findings whose method still reads at HEAD as it did when hunted, and the rest. A finding for a method that moved, changed, or went
 * away cannot be fixed from its record; the hunt has to see the method again first.
 */
export function splitStale(findings, scan) {
  const live = new Map((scan.files ?? []).flatMap(file => file.methods.map(method => [method.id, method.hash])));
  const current = [], stale = [];
  for (const finding of findings) (live.get(finding.method) === finding.hash ? current : stale).push(finding);
  return { current, stale };
}

/** Output that says a test ran and an assertion failed, as the common runners print it. */
const assertionFailure = /AssertionError|assertion `?left|assertion failed|assert(ion)? (error|failed)|expected .+ (to|but)|\bFAILED\b|^\s*FAIL\b|✕|✗|not ok|--- FAIL|panicked at|Tests?:\s+\d+ failed|\d+ failed\b/ms;
/** Output that says the test never ran: the file did not load, compile, or find its imports. */
const loadFailure = /Cannot find (module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ModuleNotFoundError|ImportError|SyntaxError|cannot find package|no such file or directory|error\[E\d+\]|undefined: \w+|is not defined|is not a function/;
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export const tail = result => (result.stdout + result.stderr).trim().slice(-1500);

/**
 * A patched file passes when it parses, adds no nesting, adds at most one branch (a missing guard is one branch), and moves the file's risk
 * score by at most one point. Enough room for a fix; not enough for a rewrite.
 */
export const MAX_EXTRA_BRANCHES = 1, MAX_EXTRA_RISK = 1;
export const withinQualityGate = (base, changed) => Boolean(changed) && changed.risk_score <= base.risk_score + MAX_EXTRA_RISK &&
  (changed.cyclomatic_complexity ?? 0) <= (base.cyclomatic_complexity ?? 0) + MAX_EXTRA_BRANCHES && (changed.max_nesting ?? 0) <= (base.max_nesting ?? 0);

const safePath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').some(part => ['..', '.', '.git', ''].includes(part));
const stem = path => basename(path).replace(/\.[^.]+$/, '');
const tokens = name => name.toLowerCase().split(/[._-]+/).filter(Boolean);
const testMarkers = new Set(['test', 'tests', 'spec', 'specs']);
/** Words that name the process rather than the module; a test file carrying one was named by the fixer, not by the project. */
const inventedSuffixes = new Set(['regression', 'regressions', 'regress', 'bug', 'bugs', 'bugfix', 'fix', 'fixes', 'fixed', 'hotfix', 'patch', 'defect', 'issue', 'perch', 'repro', 'reproduce', 'null', 'undefined', 'guard', 'handling', 'edge', 'edgecase', 'fail', 'failure', 'error', 'errors', 'check', 'verify', 'new']);
/**
 * A test file is named after a module when its name starts with the module's name, then optionally a topic the project would use
 * (command.action.test.js), then test markers: target.test.js, test_target.py, target_test.go. Suffixes that name the fixing process
 * (clamp.regression.test.js, cli-null.test.js) do not count. When the project's example test carries a marker, so must the new file.
 */
export function namedAfter(testPath, modulePath, examplePath = null) {
  const own = tokens(stem(modulePath).replace(/\.(test|spec)$/, ''));
  const found = tokens(stem(testPath).replace(/\.d$/, ''));
  const body = found.filter(token => !testMarkers.has(token));
  const marked = body.length < found.length;
  const exampleMarked = examplePath ? tokens(stem(examplePath)).some(token => testMarkers.has(token)) : false;
  return own.every((token, index) => body[index] === token) && body.every(token => !inventedSuffixes.has(token)) && (marked || !exampleMarked);
}
/** A conventional test file name for a module, modeled on an example test path from the same project. */
export function suggestTestName(modulePath, examplePath) {
  const name = stem(modulePath), ext = extname(modulePath);
  if (!examplePath) return `test/${name}.test${ext}`;
  const exampleStem = stem(examplePath);
  const marker = tokens(exampleStem).find(token => testMarkers.has(token));
  const exampleName = tokens(exampleStem).filter(token => !testMarkers.has(token)).join('-') || exampleStem;
  const replaced = marker ? exampleStem.replace(exampleName, name) : name;
  return `${dirname(examplePath)}/${replaced}${extname(examplePath)}`;
}
/** Lines of the original file that the proposed file no longer contains in order. */
export function removedLines(original, proposed) {
  const wanted = proposed.split('\n');
  let cursor = 0;
  const missing = [];
  for (const line of original.replace(/\n$/, '').split('\n')) {
    const at = wanted.indexOf(line, cursor);
    if (at < 0) missing.push(line); else cursor = at + 1;
  }
  return missing;
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
 * callers, imports, and the hunt step built from them. The method must still read as it did when hunted; its line may have moved.
 */
export async function methodContext({ finding, root, out, analyzer, revision = finding.revision, log = () => {} }) {
  const scan = await runScan({ root, revision, out, analyzer, log });
  const graph = buildGraph(scan.files);
  const node = graph.nodes.get(finding.method);
  if (!node) throw new Error(`${finding.method} no longer exists at ${revision.slice(0, 12)}; hunt again`);
  if (finding.hash && node.hash !== finding.hash) throw new Error(`${finding.method} has changed since it was hunted at ${finding.revision.slice(0, 12)}; hunt again`);
  const sources = new Map();
  const linesOf = async member => { if (!sources.has(member.path)) sources.set(member.path, (await git(['show', `${revision}:${member.path}`], root)).split('\n')); return sources.get(member.path); };
  const callees = [], callers = [];
  for (const calleeId of graph.callees(node.id)) { const callee = graph.nodes.get(calleeId); callees.push({ node: callee, lines: await linesOf(callee), calls: graph.callees(calleeId) }); }
  for (const callerId of graph.callers(node.id)) { const caller = graph.nodes.get(callerId); callers.push({ node: caller, lines: await linesOf(caller), site: graph.site(callerId, node.id) }); }
  const { imports, methods } = graph.files.get(node.path).file;
  const fileLines = await linesOf(node);
  const step = huntStep({ node, lines: fileLines, imports, methods, callees, callers });
  const method = fileLines.slice(node.line - 1, node.end_line).join('\n');
  return { scan, graph, node, fileLines, method, callees, callers, imports, methods, step };
}

/** The existing test file with one new case appended: what the model returns when extending, placed by perch. */
export const appendCase = (file, testCase) => `${file.replace(/\s*$/, '')}\n\n${testCase.trim()}\n`;
/** Lines of the returned case that already sit in the file verbatim (imports, existing cases): the model sent the whole file back. */
export const repeatedLines = (file, testCase) => { const have = new Set(file.split('\n').map(line => line.trim()).filter(line => line.length > 12)); return testCase.split('\n').map(line => line.trim()).filter(line => have.has(line)); };

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
    ui.say(`${status === 'ready' ? OK : FAIL} ${hunted.name}: fix ${status}${fix.error ? ` — ${fix.error.split('\n')[0]}` : ''}`);
    return fix;
  };
  const pct = value => `${Math.round(value * 100)}%`;

  let placed = null;
  try {
    // The same context the hunt showed the System One model, rebuilt from a scan of HEAD. The method may have moved; the finding's line moves with it.
    const { scan, graph, node, fileLines, method, callees, callers, imports, methods, step } = await methodContext({ finding: hunted, root, out, analyzer, revision, log: debug });
    const finding = { ...hunted, line: node.line, end_line: node.end_line, where: { ...hunted.where, line: hunted.where.line + node.line - hunted.line } };
    const dirtyBefore = await dirtyPaths(root);
    if (dirtyBefore.includes(node.path)) throw new Error(`${node.path} has uncommitted changes; commit or stash them before perch fix touches it`);
    const dirtyTests = testsTouching({ graph, files: scan.files, node }).filter(path => dirtyBefore.includes(path));
    if (dirtyTests.length) throw new Error(`${dirtyTests.join(', ')} ${dirtyTests.length === 1 ? 'has' : 'have'} uncommitted changes; the tests that reach ${node.qualified_name} must be committed before perch fix runs them`);

    const reaching = ui.task(`${systemOne.id}: can a caller reach ${finding.path}:${finding.where.line}?`);
    const reach = reachCheck({ finding, state: step.state });
    const { answers: reachAnswers } = await systemOne.ask(reach.state, reach.questions);
    fix.reach_check = { reachable: reachAnswers.reachable.noul };
    if (reachAnswers.reachable.noul < SURE) {
      const error = `the flagged defect is not clearly reachable (${pct(reachAnswers.reachable.noul)}); an earlier guard likely excludes it`;
      reaching.fail(`reachable ${pct(reachAnswers.reachable.noul)}; discarding`);
      await store.appendEvent({ type: 'fixed', at: new Date().toISOString(), id: finding.id, fix_id: id, method: finding.method, hash: hunted.hash, revision, status: 'rejected', attempts: 0, error });
      return await finish('rejected', { error });
    }
    reaching.ok(`reachable ${pct(reachAnswers.reachable.noul)}`);
    const language = languageOf(node.path);
    const base = (await analyzer.analyzeSource(fileLines.join('\n'), language)).metrics;
    if (!base) throw new Error(`${node.path} does not parse at ${revision.slice(0, 12)}`);

    // The existing tests are the ones the graph says reach this method. The new case goes into the module's own test file when it has one;
    // otherwise into a new file named the way the project names its tests, with the nearest test file as the example.
    const treePaths = (await listTree(root, revision)).map(item => item.path);
    const existingTests = testsTouching({ graph, files: scan.files, node });
    const nearTests = [...callees, ...callers].flatMap(neighbor => testsTouching({ graph, files: scan.files, node: neighbor.node }));
    const byDistance = (a, b) => (b.startsWith(dirname(node.path) + '/') ? 1 : 0) - (a.startsWith(dirname(node.path) + '/') ? 1 : 0) || a.length - b.length;
    // Candidates to extend, exact name first (clamp.test.js before clamp.broken.test.js); the choice waits for the baseline below.
    const moduleCandidates = existingTests.filter(path => namedAfter(path, node.path)).sort((a, b) => tokens(stem(a)).length - tokens(stem(b)).length);
    const testSources = new Map();
    const testSourceOf = async path => { if (!testSources.has(path)) testSources.set(path, await git(['show', `${revision}:${path}`], root)); return testSources.get(path); };
    const project = await discoverProject({ root, revision, out, paths: treePaths, systemOne, log: debug });
    if (!project.single) throw new Error('Could not tell how this project runs one test file; no manifest, CI workflow, or test directory was recognized');
    Object.assign(fix, { existing_tests: existingTests, project: { install: project.install, single: project.single } });
    await writeJson(fixPath, fix);

    // Tests run in the checkout itself, with perch's own keys withheld. Files a rejected attempt wrote are put back from HEAD.
    const run = file => shell.run(command(project.single, file), { cwd: root, timeoutMs: COMMAND_MS, env: workspaceEnv() });
    const place = async (path, text) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); placed = { testPath: path === node.path ? placed?.testPath ?? null : path }; };
    const restore = async testPath => {
      await git(['checkout', '--', node.path], root);
      if (testPath && treePaths.includes(testPath)) await git(['checkout', '--', testPath], root);
      else if (testPath) await rm(join(root, testPath), { force: true });
      placed = null;
    };

    // Baseline: an existing test that already fails on the original cannot be blamed on the patch, so only the passing ones count.
    const baseline = { passing: [], failing: [] };
    for (const path of existingTests) {
      const running = ui.task(`${path} on the original`);
      const result = await run(path);
      if (result.exit_code === 0) { baseline.passing.push(path); running.ok('passes'); }
      else { baseline.failing.push(path); running.note(`already fails (exit ${result.exit_code}); will not count`); }
    }
    fix.baseline_failures = baseline.failing;
    // One file named exactly after the module must be extended. Several topic files (command.action.test.js, ...) leave the model a choice:
    // extend the fitting one or add a sibling named the same way.
    const related = moduleCandidates.filter(path => !baseline.failing.includes(path));
    const moduleTokens = tokens(stem(node.path)).length;
    const moduleTest = related.find(path => tokens(stem(path)).filter(token => !testMarkers.has(token)).length === moduleTokens) ?? (related.length === 1 ? related[0] : null);
    const examplePath = moduleTest ?? related[0] ?? nearTests[0] ?? scan.files.filter(file => file.test && file.language === node.language).map(file => file.path).sort(byDistance)[0] ?? null;
    const exampleTest = examplePath ? { path: examplePath, text: (await testSourceOf(examplePath)).slice(0, moduleTest || related.length ? 32 * 1024 : 4096), extend: Boolean(moduleTest), related: moduleTest ? [] : related } : null;
    Object.assign(fix, { module_test: moduleTest, related_tests: related, example_test: examplePath });
    await writeJson(fixPath, fix);

    let feedback = null, accepted = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !accepted; attempt++) {
      const effort = effortForAttempt(attempt, model.effort);
      const asking = ui.task(`attempt ${attempt} of ${MAX_ATTEMPTS}: ${model.id} writing the fix and a regression test${feedback ? ', with the rejection fed back' : ''} (effort ${effort})`);
      const proposal = await model.ask(`fix-${attempt}`, fixPrompt({ finding, state: step.state, method, exampleTest, project, feedback, suggestedTestPath: moduleTest ? null : suggestTestName(node.path, examplePath) }), { effort });
      asking.ok(`${proposal.summary || 'no summary'} (${describeCall(model.last)})`);
      const testPath = proposal.test_path, extending = treePaths.includes(testPath);
      const record = { attempt, effort, summary: proposal.summary, test_path: testPath, test_mode: extending ? 'extended' : 'new', method: proposal.method, test: proposal.test, model_call: model.last };
      fix.attempts.push(record);
      const reject = async (reason, restorePath) => { record.rejected = reason; feedback = reason; ui.say(`${FAIL} attempt ${attempt} rejected: ${reason.split('\n')[0]}`); await writeJson(fixPath, fix); if (restorePath !== undefined) await restore(restorePath); };

      // 1. Splice by line range and gate on the AST; the test must land where the project keeps its tests.
      if (!proposal.method.trim() || proposal.method.trim() === method.trim()) { await reject(`the method was returned unchanged: ${proposal.summary || 'no reason given'}`); continue; }
      if (!safePath(testPath) || !proposal.test.trim() || (extending && !testFile(testPath))) { await reject(`test_path must be a test file inside the repository; ${JSON.stringify(testPath)} is not`); continue; }
      if (moduleTest && testPath !== moduleTest) { await reject(`${moduleTest} already tests this module; add the new case there rather than creating ${testPath}`); continue; }
      if (extending && !moduleTest && !related.includes(testPath)) { await reject(`${testPath} is not one of the files that test this module (${related.join(', ') || 'none'}); extend one of those or add a new file named like them`); continue; }
      if (extending && baseline.failing.includes(testPath)) { await reject(`${testPath} already fails on the original, so a case added to it proves nothing; put the test in a new file named after the module`); continue; }
      if (!extending && !namedAfter(testPath, node.path, examplePath)) { await reject(`a new test file must be named after the module it tests, the way this project names its tests (for ${node.path}, something like ${suggestTestName(node.path, examplePath)}); ${testPath} is not`); continue; }
      // When extending, the model sends only the new case and perch appends it; a case that repeats the file's own lines is the whole file sent back.
      let testSource = proposal.test;
      if (extending) {
        const existingSource = await testSourceOf(testPath);
        const repeated = repeatedLines(existingSource, proposal.test);
        if (repeated.length > 1) { await reject(`test must be only the new test case, which is appended to ${testPath}; these lines are already in the file:\n${repeated.slice(0, 6).join('\n')}`); continue; }
        testSource = appendCase(existingSource, proposal.test);
      }
      const patchedLines = [...fileLines.slice(0, node.line - 1), ...methodLines(proposal.method), ...fileLines.slice(node.end_line)];
      const patchedFile = patchedLines.join('\n');
      const after = await analyzer.analyzeSource(patchedFile, language);
      if (after.parser_status !== 'parsed') { await reject(`the patched file does not parse: ${after.parser_message ?? 'syntax error'}`); continue; }
      if (!withinQualityGate(base, after.metrics)) { await reject(`the patch adds nesting, more than one branch, or more than one point of risk (risk ${base.risk_score.toFixed(1)} -> ${after.metrics.risk_score.toFixed(1)}, complexity ${base.cyclomatic_complexity} -> ${after.metrics.cyclomatic_complexity}, nesting ${base.max_nesting} -> ${after.metrics.max_nesting})`); continue; }

      // 2. System One reads the test before a run is spent on it.
      const reading = ui.task(`${systemOne.id} reading the test`);
      const check = testCheck({ finding, state: step.state, test: testSource, testPath });
      const { answers: testAnswers } = await systemOne.ask(check.state, check.questions);
      record.test_check = Object.fromEntries(Object.entries(testAnswers).map(([key, answer]) => [key, answer.noul]));
      if (!soundTest(testAnswers)) { reading.fail(testObjections(testAnswers)); await reject(testObjections(testAnswers)); continue; }
      reading.ok(`sound (targets defect ${pct(testAnswers.targets_defect.noul)}, would pass on original ${pct(testAnswers.passes_on_original.noul)})`);

      // 3. Proof: the test fails on the original with an assertion, passes on the patch, and the existing tests still pass.
      await place(testPath, testSource);
      const onOriginal = ui.task(`${testPath} on the original`);
      const before = await run(testPath);
      record.before = { exit_code: before.exit_code, output: tail(before) };
      const beforeText = before.stdout + before.stderr;
      if (before.exit_code === 0) { onOriginal.fail('passes; does not demonstrate the defect'); await reject(`the test passes on the original, so it does not demonstrate the defect:\n${tail(before)}`, testPath); continue; }
      if (loadFailure.test(beforeText) || !assertionFailure.test(beforeText)) { onOriginal.fail(`exit ${before.exit_code} without an assertion failure${before.timed_out ? ' (timed out)' : ''}`); await reject(`the test did not fail with an assertion on the original (exit ${before.exit_code}${before.timed_out ? ', timed out' : ''}):\n${tail(before)}`, testPath); continue; }
      onOriginal.ok('fails with an assertion, as it should');
      await place(node.path, patchedFile);
      const onPatch = ui.task(`${testPath} on the patch`);
      const afterRun = await run(testPath);
      record.after = { exit_code: afterRun.exit_code, output: tail(afterRun) };
      if (afterRun.exit_code !== 0) { onPatch.fail(`still fails (exit ${afterRun.exit_code})`); await reject(`the test file still fails on the patched method${extending ? ' (an existing case may have broken)' : ''}:\n${tail(afterRun)}`, testPath); continue; }
      onPatch.ok('passes');
      let regression = null;
      const others = baseline.passing.filter(path => path !== testPath);
      if (others.length) {
        const existingRun = ui.task(`${others.length} existing ${others.length === 1 ? 'test' : 'tests'} on the patch`);
        for (const path of others) {
          existingRun.update(`${path} on the patch`);
          const result = await run(path);
          if (result.exit_code === 0) continue;
          // Before the patch takes the blame, the same test runs on the original again: a checkout that changed under us is not a regression.
          await git(['checkout', '--', node.path], root);
          const control = await run(path);
          await place(node.path, patchedFile);
          if (control.exit_code !== 0) { existingRun.fail(`${path} now fails on the original too`); await restore(testPath); throw new Error(`${path} passed on the original before the attempt and fails on it now; the checkout changed while perch fix was running. Commit or stash your work and run it again`); }
          regression = `${path}:\n${tail(result)}`;
          break;
        }
        if (regression) existingRun.fail(regression.split('\n')[0]); else existingRun.ok('all pass');
      }
      record.existing_tests = regression ? 'failed' : `${baseline.passing.length} passed`;
      if (regression) { await reject(`an existing test broke on the patch: ${regression}`, testPath); continue; }
      const expected = [node.path, testPath].sort();
      const changed = (await dirtyPaths(root)).filter(path => !dirtyBefore.includes(path)).sort();
      if (changed.join('\n') !== expected.join('\n')) throw new Error(`The test run changed files other than ${expected.join(' and ')}: ${changed.join(', ') || 'none'}`);

      // 4. The hunt's questions again over the patched method, so a patch that games the test is caught.
      const patchedNode = { ...node, end_line: node.line + methodLines(proposal.method).length - 1 };
      const patchedStep = huntStep({ node: patchedNode, lines: patchedLines, imports, methods, callees, callers });
      const verify = patchCheck({ step: patchedStep, original: method, summary: proposal.summary });
      const verifying = ui.task(`${systemOne.id} comparing the patched method (defect was ${pct(finding.has_bug)})`);
      const { answers } = await systemOne.ask(verify.state, verify.questions);
      const { verification, objections } = readPatchCheck({ finding, answers, calledBy: patchedStep.calledBy });
      record.verification = verification;
      if (objections.length) { verifying.fail(objections.join('; ')); await reject(objections.join('; '), testPath); continue; }
      verifying.ok(`defect ${pct(finding.has_bug)} -> ${pct(verification.has_bug)}, collateral ${pct(verification.collateral_change)}`);

      // 5. Commit the method and its test on the current branch, with the model's summary as the message.
      await git(['add', '--', node.path, testPath], root);
      const patch = await git(['diff', '--cached', '--', node.path, testPath], root);
      if (!patch) throw new Error(`Patch for ${node.path} could not be captured`);
      await git(['commit', '-q', '-m', proposal.summary, '-m', `perch ${finding.id}`, '--', node.path, testPath], root);
      placed = null;
      const commit = await gitRevision(root);
      ui.say(`${OK} committed ${commit.slice(0, 7)} on ${branch}: ${proposal.summary}`);
      accepted = { proposal, record, patch, commit };
    }
    if (!accepted) {
      await store.appendEvent({ type: 'fixed', at: new Date().toISOString(), id: finding.id, fix_id: id, method: finding.method, hash: hunted.hash, revision, status: 'rejected', attempts: fix.attempts.length, error: feedback });
      return await finish('rejected', { error: feedback });
    }

    const patchPath = join(dir, 'fix.patch');
    await writeFile(patchPath, accepted.patch);
    const verification = { kind: finding.kind.kind, before: { has_bug: finding.has_bug, kind: finding.kind.probability ?? null }, after: accepted.record.verification };
    const proof = { fails_on_original: true, passes_on_patch: true, test_mode: accepted.record.test_mode, existing_tests: baseline.passing, baseline_failures: baseline.failing, command: command(project.single, accepted.proposal.test_path) };
    await store.appendEvent({ type: 'fixed', at: new Date().toISOString(), id: finding.id, fix_id: id, method: finding.method, hash: hunted.hash, revision, status: 'ready', summary: accepted.proposal.summary,
      commit: accepted.commit, branch, patch_path: patchPath, test_path: accepted.proposal.test_path, verification, proof });
    return await finish('ready', { summary: accepted.proposal.summary, test_path: accepted.proposal.test_path, commit: accepted.commit, patch_path: patchPath, verification, proof });
  } catch (error) {
    fix.status = 'failed';
    fix.error = error.message;
    await writeJson(fixPath, fix).catch(() => {});
    throw error;
  } finally {
    // Whatever an interrupted attempt left in the checkout goes back to HEAD.
    if (placed) {
      await git(['checkout', '--', hunted.path], root).catch(() => {});
      if (placed.testPath) { if ((await git(['ls-files', '--error-unmatch', '--', placed.testPath], root).then(() => true, () => false))) await git(['checkout', '--', placed.testPath], root).catch(() => {}); else await rm(join(root, placed.testPath), { force: true }).catch(() => {}); }
    }
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
    if (stale.length) ui.say(`${stale.length} ${stale.length === 1 ? 'finding is' : 'findings are'} for methods that have changed or moved since the hunt; hunt again to refresh them`);
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
