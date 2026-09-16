/**
 * `perch fix`: for one finding, get a corrected method and a regression test from a generative model, check the test with System One,
 * prove it in a worktree of its own (fails on the original with an assertion, passes on the patch, the existing tests that touch the method
 * still pass), question the patched method again, and write the patch. The proof is recorded in the events log so issues shows it.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { git, listTree } from './git.js';
import { languageOf, testFile } from './analysis.js';
import { runScan } from './scan.js';
import { buildGraph, resolveModule } from './graph.js';
import { huntStep, patchCheck, readPatchCheck, soundTest, testCheck, testObjections } from './questions.js';
import { discoverProject } from './project.js';
import { COMMAND_MS, INSTALL_MS, openWorkspace } from './workspace.js';
import { identity, openStore, readJson, writeJson } from './store.js';
import { fixPrompt } from './prompts.js';

export const MAX_ATTEMPTS = 3;

export function fixIdentity({ finding, model }) {
  return identity('fix', finding.id, finding.hash, model);
}

/** Output that says a test ran and an assertion failed, as the common runners print it. */
const assertionFailure = /AssertionError|assertion `?left|assertion failed|assert(ion)? (error|failed)|expected .+ (to|but)|\bFAILED\b|^\s*FAIL\b|✕|✗|not ok|--- FAIL|panicked at|Tests?:\s+\d+ failed|\d+ failed\b/ms;
/** Output that says the test never ran: the file did not load, compile, or find its imports. */
const loadFailure = /Cannot find (module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ModuleNotFoundError|ImportError|SyntaxError|cannot find package|no such file or directory|error\[E\d+\]|undefined: \w+|is not defined|is not a function/;
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const tail = result => (result.stdout + result.stderr).trim().slice(-1500);

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
const command = (template, file) => template.replaceAll('{file}', quote(file)).replaceAll('{dir}', quote(dirname(file) === '.' ? '.' : `./${dirname(file)}`));
const methodLines = method => method.replace(/\n$/, '').split('\n');

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

/** The finding's method at its commit with the same neighborhood the hunt showed: file lines, callees, callers, imports, and the hunt step built from them. */
export async function methodContext({ finding, root, out, analyzer, log = () => {} }) {
  const { revision } = finding;
  const scan = await runScan({ root, revision, out, analyzer, log });
  const graph = buildGraph(scan.files);
  const node = graph.nodes.get(finding.method);
  if (!node) throw new Error(`${finding.method} no longer exists at ${revision.slice(0, 12)}`);
  const sources = new Map();
  const linesOf = async member => { if (!sources.has(member.path)) sources.set(member.path, (await git(['show', `${revision}:${member.path}`], root)).split('\n')); return sources.get(member.path); };
  const callees = [], callers = [];
  for (const calleeId of graph.callees(node.id)) { const callee = graph.nodes.get(calleeId); callees.push({ node: callee, lines: await linesOf(callee), calls: graph.callees(calleeId) }); }
  for (const callerId of graph.callers(node.id)) { const caller = graph.nodes.get(callerId); callers.push({ node: caller, lines: await linesOf(caller), site: graph.site(callerId, node.id) }); }
  const imports = graph.files.get(node.path).file.imports;
  const fileLines = await linesOf(node);
  const step = huntStep({ node, lines: fileLines, imports, callees, callers });
  const method = fileLines.slice(node.line - 1, node.end_line).join('\n');
  return { scan, graph, node, fileLines, method, callees, callers, imports, step };
}

export async function runFix({ finding, root, out, model, systemOne, analyzer, shell, keepWorkspace = false, log = () => {} }) {
  const store = openStore(out);
  const id = fixIdentity({ finding, model: model.id });
  const dir = store.fixDir(id), fixPath = join(dir, 'fix.json');
  const existing = await readJson(fixPath, null);
  if (existing && ['ready', 'rejected'].includes(existing.status)) {
    log(`fix ${id} already ${existing.status}; reusing ${fixPath}`);
    return existing;
  }
  await store.exclude(root);
  const workspaceDir = join(out, 'workspaces', id);
  const fix = { id, finding_id: finding.id, method: finding.method, path: finding.path, root, revision: finding.revision, model: model.id, verifier: systemOne.id, out: dir,
    workspace: keepWorkspace ? workspaceDir : null, status: 'running', attempts: [], created_at: new Date().toISOString() };
  await writeJson(fixPath, fix);
  const finish = async (status, extra) => {
    Object.assign(fix, { status, completed_at: new Date().toISOString(), ...extra });
    await writeJson(fixPath, fix);
    log(`${finding.path}: fix ${status}${fix.error ? `: ${fix.error}` : ''}`);
    return fix;
  };

  let workspace = null;
  try {
    // The same context the hunt showed the System One model, rebuilt from the scan at the finding's commit.
    const { revision } = finding;
    const { scan, graph, node, fileLines, method, callees, callers, imports, step } = await methodContext({ finding, root, out, analyzer, log });
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
    const project = await discoverProject({ root, revision, out, paths: treePaths, systemOne, log });
    if (!project.single) throw new Error('Could not tell how this project runs one test file; no manifest, CI workflow, or test directory was recognized');
    Object.assign(fix, { existing_tests: existingTests, project: { install: project.install, single: project.single } });
    await writeJson(fixPath, fix);

    // One worktree for this fix alone, removed with it unless asked to keep it.
    workspace = await openWorkspace({ root, revision, dir: workspaceDir, shell, log });
    if (project.install && !workspace.linked.length) {
      log(`installing dependencies: ${project.install}`);
      const install = await workspace.run(project.install, INSTALL_MS);
      if (install.exit_code !== 0) throw new Error(`Dependency install failed (${project.install}):\n${tail(install)}`);
    }
    const run = file => workspace.run(command(project.single, file), COMMAND_MS);
    const place = async (path, text) => { await mkdir(dirname(join(workspace.dir, path)), { recursive: true }); await writeFile(join(workspace.dir, path), text); };
    const restore = async testPath => {
      await git(['checkout', '--', node.path], workspace.dir);
      if (testPath && treePaths.includes(testPath)) await git(['checkout', '--', testPath], workspace.dir);
      else if (testPath) await rm(join(workspace.dir, testPath), { force: true });
    };

    // Baseline: an existing test that already fails on the original cannot be blamed on the patch, so only the passing ones count.
    const baseline = { passing: [], failing: [] };
    for (const path of existingTests) {
      log(`running existing test ${path} on the original`);
      const result = await run(path);
      if (result.exit_code === 0) baseline.passing.push(path);
      else { baseline.failing.push(path); log(`${path} already fails on the original (exit ${result.exit_code}); it will not count`); }
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
      log(`asking ${model.id} for a fix and a regression test (attempt ${attempt})`);
      const proposal = await model.ask(`fix-${attempt}`, fixPrompt({ finding, state: step.state, method, exampleTest, project, feedback, suggestedTestPath: moduleTest ? null : suggestTestName(node.path, examplePath) }));
      const testPath = proposal.test_path, extending = treePaths.includes(testPath);
      const record = { attempt, summary: proposal.summary, test_path: testPath, test_mode: extending ? 'extended' : 'new', method: proposal.method, test: proposal.test };
      fix.attempts.push(record);
      const reject = async (reason, restorePath) => { record.rejected = reason; feedback = reason; log(`attempt ${attempt} rejected: ${reason.split('\n')[0]}`); await writeJson(fixPath, fix); if (restorePath !== undefined) await restore(restorePath); };

      // 1. Splice by line range and gate on the AST; the test must land where the project keeps its tests.
      if (!proposal.method.trim() || proposal.method.trim() === method.trim()) { await reject(`the method was returned unchanged: ${proposal.summary || 'no reason given'}`); continue; }
      if (!safePath(testPath) || !proposal.test.trim() || (extending && !testFile(testPath))) { await reject(`test_path must be a test file inside the repository; ${JSON.stringify(testPath)} is not`); continue; }
      if (moduleTest && testPath !== moduleTest) { await reject(`${moduleTest} already tests this module; add the new case to that file and return its complete content, rather than creating ${testPath}`); continue; }
      if (extending && !moduleTest && !related.includes(testPath)) { await reject(`${testPath} is not one of the files that test this module (${related.join(', ') || 'none'}); extend one of those or add a new file named like them`); continue; }
      if (extending && baseline.failing.includes(testPath)) { await reject(`${testPath} already fails on the original, so a case added to it proves nothing; put the test in a new file named after the module`); continue; }
      if (!extending && !namedAfter(testPath, node.path, examplePath)) { await reject(`a new test file must be named after the module it tests, the way this project names its tests (for ${node.path}, something like ${suggestTestName(node.path, examplePath)}); ${testPath} is not`); continue; }
      if (extending) {
        const removed = removedLines(await testSourceOf(testPath), proposal.test);
        if (removed.length) { await reject(`extending ${testPath} may only add lines; these were changed or removed:\n${removed.slice(0, 8).join('\n')}`); continue; }
      }
      const patchedLines = [...fileLines.slice(0, node.line - 1), ...methodLines(proposal.method), ...fileLines.slice(node.end_line)];
      const patchedFile = patchedLines.join('\n');
      const after = await analyzer.analyzeSource(patchedFile, language);
      if (after.parser_status !== 'parsed') { await reject(`the patched file does not parse: ${after.parser_message ?? 'syntax error'}`); continue; }
      if (!withinQualityGate(base, after.metrics)) { await reject(`the patch adds nesting, more than one branch, or more than one point of risk (risk ${base.risk_score.toFixed(1)} -> ${after.metrics.risk_score.toFixed(1)}, complexity ${base.cyclomatic_complexity} -> ${after.metrics.cyclomatic_complexity}, nesting ${base.max_nesting} -> ${after.metrics.max_nesting})`); continue; }

      // 2. System One reads the test before a run is spent on it.
      log(`asking ${systemOne.id} whether the test is sound`);
      const check = testCheck({ finding, method, test: proposal.test, testPath: proposal.test_path, callers: step.state.called_by });
      const { answers: testAnswers } = await systemOne.ask(check.state, check.questions);
      record.test_check = Object.fromEntries(Object.entries(testAnswers).map(([key, answer]) => [key, answer.noul]));
      if (!soundTest(testAnswers)) { await reject(testObjections(testAnswers)); continue; }

      // 3. Proof: the test fails on the original with an assertion, passes on the patch, and the existing tests still pass.
      await place(proposal.test_path, proposal.test);
      const before = await run(proposal.test_path);
      record.before = { exit_code: before.exit_code, output: tail(before) };
      const beforeText = before.stdout + before.stderr;
      if (before.exit_code === 0) { await reject(`the test passes on the original, so it does not demonstrate the defect:\n${tail(before)}`, proposal.test_path); continue; }
      if (loadFailure.test(beforeText) || !assertionFailure.test(beforeText)) { await reject(`the test did not fail with an assertion on the original (exit ${before.exit_code}${before.timed_out ? ', timed out' : ''}):\n${tail(before)}`, proposal.test_path); continue; }
      await place(node.path, patchedFile);
      const afterRun = await run(proposal.test_path);
      record.after = { exit_code: afterRun.exit_code, output: tail(afterRun) };
      if (afterRun.exit_code !== 0) { await reject(`the test file still fails on the patched method${extending ? ' (an existing case may have broken)' : ''}:\n${tail(afterRun)}`, proposal.test_path); continue; }
      let regression = null;
      for (const path of baseline.passing.filter(path => path !== testPath)) { const result = await run(path); if (result.exit_code !== 0) { regression = `${path}:\n${tail(result)}`; break; } }
      record.existing_tests = regression ? 'failed' : `${baseline.passing.length} passed`;
      if (regression) { await reject(`an existing test broke on the patch: ${regression}`, proposal.test_path); continue; }
      const expected = extending ? [node.path, testPath].sort() : [node.path];
      const changed = (await git(['diff', '--name-only'], workspace.dir)).trim().split('\n').filter(Boolean).sort();
      if (changed.join('\n') !== expected.join('\n')) throw new Error(`The test run changed tracked files other than ${expected.join(' and ')}: ${changed.join(', ') || 'none'}`);

      // 4. The hunt's questions again over the patched method, so a patch that games the test is caught.
      const patchedNode = { ...node, end_line: node.line + methodLines(proposal.method).length - 1 };
      const patchedStep = huntStep({ node: patchedNode, lines: patchedLines, imports, callees, callers });
      const verify = patchCheck({ step: patchedStep, original: method, summary: proposal.summary });
      log(`asking ${systemOne.id} about the patched method`);
      const { answers } = await systemOne.ask(verify.state, verify.questions);
      const { verification, objections } = readPatchCheck({ finding, answers, calledBy: patchedStep.calledBy });
      record.verification = verification;
      if (objections.length) { await reject(objections.join('; '), proposal.test_path); continue; }

      if (!extending) await git(['add', '-N', '--', testPath], workspace.dir);
      const patch = await git(['diff', '--', node.path, testPath], workspace.dir);
      if (!patch) throw new Error(`Patch for ${node.path} could not be captured`);
      accepted = { proposal, record, patch };
    }
    if (!accepted) {
      await store.appendEvent({ type: 'fixed', at: new Date().toISOString(), id: finding.id, fix_id: id, method: finding.method, revision, status: 'rejected', attempts: fix.attempts.length, error: feedback });
      return await finish('rejected', { error: feedback });
    }

    const patchPath = join(dir, 'fix.patch');
    await writeFile(patchPath, accepted.patch);
    const verification = { kind: finding.kind.kind, before: { has_bug: finding.has_bug, kind: finding.kind.probability ?? null }, after: accepted.record.verification };
    const proof = { fails_on_original: true, passes_on_patch: true, test_mode: accepted.record.test_mode, existing_tests: baseline.passing, baseline_failures: baseline.failing, command: command(project.single, accepted.proposal.test_path) };
    await store.appendEvent({ type: 'fixed', at: new Date().toISOString(), id: finding.id, fix_id: id, method: finding.method, revision, status: 'ready', summary: accepted.proposal.summary,
      patch_path: patchPath, test_path: accepted.proposal.test_path, verification, proof });
    return await finish('ready', { summary: accepted.proposal.summary, test_path: accepted.proposal.test_path, patch_path: patchPath, verification, proof });
  } catch (error) {
    fix.status = 'failed';
    fix.error = error.message;
    await writeJson(fixPath, fix).catch(() => {});
    throw error;
  } finally {
    if (workspace && !keepWorkspace) await workspace.close().catch(() => {});
  }
}
