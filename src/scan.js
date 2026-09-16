/** One scan: analyze, prepare, triage, prove each bug with a regression, and optionally fix it. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { addWorktree, excludeFromStatus, listTree, removeWorktree, resetWorkspace } from './git.js';
import { openJournal } from './journal.js';
import { analyzeFiles, languageOf, sourceFile } from './analysis.js';
import { fixPrompt, preparationPrompt, reviewPrompt, triagePrompt } from './prompts.js';

export const sha256 = text => createHash('sha256').update(text).digest('hex');
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const assertionFailure = /AssertionError|assertion failed|expected .+ to |FAILED.*assert|test result: FAILED/s;
const PREPARATION_MS = 20 * 60_000, COMMAND_MS = 5 * 60_000;

export function scanIdentity({ revision, paths, candidates, fix, model }) {
  return sha256(JSON.stringify([revision, [...paths].sort(), candidates, Boolean(fix), model])).slice(0, 16);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, path);
}

/** Bounded, timestamp-free view of a command result for prompts and records. */
const outcome = result => result && ({ exit_code: result.exit_code, timed_out: result.timed_out, stdout: result.stdout, stderr: result.stderr });

export function inventoryScript(candidates) {
  const context = candidates.map(candidate => {
    const directory = candidate.path.includes('/') ? candidate.path.slice(0, candidate.path.lastIndexOf('/')) : '.';
    const parent = directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '.';
    const stem = candidate.path.split('/').at(-1).replace(/\.[^.]+$/, '');
    return String.raw`printf '\nINVESTIGATION SOURCE %s\n' ${quote(candidate.path)}; head -c 2000 ${quote(candidate.path)}
(d=${quote(directory)}; for depth in 1 2 3 4 5 6; do for name in package.json Cargo.toml pyproject.toml go.mod rust-toolchain.toml vite.config.ts vitest.config.ts; do test ! -f "$d/$name" || printf '%s\n' "$d/$name"; done; test "$d" != . || break; d=$(dirname "$d"); done) | head -4 | while IFS= read -r f; do printf '\nPROJECT CONFIG %s\n' "$f"; head -c 2000 "$f"; done
find ${quote(directory)} ${quote(parent)} -maxdepth 2 -type f \( -name ${quote('*' + stem + '*test*')} -o -name ${quote('*test*' + stem + '*')} \) 2>/dev/null | sort -u | head -2 | while IFS= read -r f; do printf '\nLOCAL TEST %s\n' "$f"; head -c 800 "$f"; done`;
  }).join('\n');
  return String.raw`printf 'TOOLS ON PATH:\n'
for tool in node npm pnpm yarn python3 pip3 cargo rustc rustup go make; do command -v "$tool" || printf 'NOT INSTALLED: %s\n' "$tool"; done
for tool in node python3 cargo go; do command -v "$tool" >/dev/null 2>&1 && { printf '%s: ' "$tool"; "$tool" --version 2>&1 | head -1; } || true; done
printf '\nMANIFESTS:\n'
find . -maxdepth 3 \( -name package.json -o -name pyproject.toml -o -name Cargo.toml -o -name go.mod -o -name AGENTS.md \) -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/.perch/*' | sort | head -30
find . -maxdepth 3 \( -name package.json -o -name Cargo.toml -o -name pyproject.toml -o -name go.mod \) -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/.perch/*' | sort | head -4 | while IFS= read -r f; do printf '\nFILE %s\n' "$f"; head -c 1000 "$f"; done
` + context + "\nprintf '\\nINVENTORY END\\n'";
}

function validFinding(finding, candidate) {
  return [finding.title, finding.reason, finding.regression, finding.regression_path, finding.command].every(value => typeof value === 'string' && value.length) &&
    !finding.regression_path.startsWith('/') && !finding.regression_path.split('/').some(part => ['..', '.', '.git', ''].includes(part)) &&
    finding.regression_path !== candidate.path && finding.regression.length <= 128 * 1024;
}

export async function runScan(options) {
  const { root, revision, model, shell, analyzer, out, label = root, github = null,
    fix: automatedFixes = false, paths = [], candidates: candidateLimit = 4, keepWorkspace = false, log = () => {} } = options;
  const id = scanIdentity({ revision, paths, candidates: candidateLimit, fix: automatedFixes, model: model.id });
  const scanDir = join(out, 'scans', id);
  const files = { scan: join(scanDir, 'scan.json'), issues: join(scanDir, 'issues.json'), fixes: join(scanDir, 'fixes.json'), patches: join(scanDir, 'patches') };
  if (existsSync(files.scan)) {
    const existing = JSON.parse(await readFile(files.scan, 'utf8'));
    if (existing.status === 'complete') {
      log(`scan ${id} already complete; reusing ${files.scan}`);
      return { ...existing, issues: JSON.parse(await readFile(files.issues, 'utf8')), fixes: JSON.parse(await readFile(files.fixes, 'utf8')) };
    }
  }
  await mkdir(files.patches, { recursive: true });
  if (out.startsWith(root + '/')) await excludeFromStatus(root, '/' + out.slice(root.length + 1).split('/')[0] + '/');
  const journal = await openJournal(join(scanDir, 'journal.json'));
  const workspace = join(out, 'workspaces', id);
  const scan = { id, status: 'running', target: label, github, root, revision, model: model.id, fix: automatedFixes, paths, candidate_limit: candidateLimit,
    out: scanDir, workspace: keepWorkspace ? workspace : null, created_at: new Date().toISOString() };
  await writeJson(files.scan, scan);

  log(`checking out ${revision.slice(0, 12)} into ${workspace}`);
  await addWorktree(root, workspace, revision);
  const command = (name, script, timeoutMs = COMMAND_MS) => journal.memo(`command:${name}`, sha256(script), async () => {
    log(`running ${name}`);
    return shell.run(script, { cwd: workspace, timeoutMs });
  });
  const inference = (name, prompt, maxOutputTokens = 16384) => journal.memo(name, sha256(prompt), async () => {
    log(`asking ${model.id} for ${name}`);
    return model.ask(name, prompt, { maxOutputTokens });
  });
  const reset = () => resetWorkspace(workspace, revision);
  const readWorkspace = path => readFile(join(workspace, path), 'utf8');
  const writeWorkspace = async (path, text) => { await mkdir(dirname(join(workspace, path)), { recursive: true }); await writeFile(join(workspace, path), text); };

  try {
    // 1. Tracked source files, filtered and analyzed.
    const tree = await listTree(workspace, revision);
    const sources = tree.filter(sourceFile).filter(file => !paths.length || paths.some(path => file.path === path || file.path.startsWith(path.replace(/\/$/, '') + '/')));
    if (!sources.length) throw new Error('No supported source files in this repository');
    log(`analyzing ${sources.length} source files`);
    const analysis = await analyzeFiles(sources, { analyzer, readSource: file => readWorkspace(file.path), limit: candidateLimit, log });
    const candidates = analysis.candidates;
    scan.coverage = { ...analysis.coverage, excluded: tree.filter(item => item.type === 'blob').length - sources.length };
    scan.functions = analysis.functions;
    scan.candidates = candidates.map(candidate => ({ path: candidate.path, blob: candidate.blob, score: candidate.score }));
    if (!candidates.length) throw new Error('No candidate files with functions to investigate');

    // 2. Environment preparation: setup and baseline scripts from the model, validated locally.
    const inventory = await command('inventory', inventoryScript(candidates));
    if (inventory.exit_code !== 0 || !inventory.stdout.endsWith('INVENTORY END\n')) throw new Error('Preparation inventory was incomplete');
    let preparation = null, failure = null, baseline = null;
    for (let attempt = 0; attempt < 3 && !baseline; attempt++) {
      const value = await inference(`preparation-${attempt}`, preparationPrompt({ workspace, inventory: inventory.stdout, candidates, previous: preparation, failure }));
      preparation = { setup: value.setup, baseline: value.baseline };
      const setup = await command(`dependencies-${attempt}`, preparation.setup, PREPARATION_MS);
      if (setup.exit_code !== 0) {
        failure = { stage: 'setup', ...outcome(setup) };
        if (attempt === 2) throw new Error(`Dependency setup failed after three attempts:\n${setup.stderr.slice(-2000)}`);
        continue;
      }
      const result = await command(`baseline-${attempt}`, preparation.baseline, PREPARATION_MS);
      if (result.exit_code !== 0 || !(result.stdout + result.stderr).trim()) {
        failure = { stage: 'baseline', ...outcome(result) };
        if (attempt === 2) throw new Error(`Baseline project checks failed after three attempts:\n${(result.stdout + result.stderr).slice(-2000)}`);
        continue;
      }
      baseline = result;
    }
    scan.preparation = preparation;
    scan.baseline = outcome(baseline);
    await writeJson(files.scan, scan);

    // 3. Per candidate: triage, prove, and optionally fix.
    const issues = [], fixes = [], rejected = [];
    for (const [index, candidate] of candidates.entries()) {
      const finding = await inference(`triage-${index}`, triagePrompt({ workspace, preparation, candidate }));
      if (!finding.found) { log(`${candidate.path}: no bug found`); continue; }
      if (!validFinding(finding, candidate)) { rejected.push({ path: candidate.path, reason: 'Investigator returned an invalid regression', finding }); continue; }
      await reset();
      const frozen = sha256(finding.regression);
      await writeWorkspace(finding.regression_path, finding.regression);
      const before = await command(`regression-base-${index}`, finding.command);
      if (before.exit_code === 0 || !assertionFailure.test(before.stdout + before.stderr)) {
        log(`${candidate.path}: regression did not demonstrate a behavioral failure`);
        rejected.push({ path: candidate.path, reason: 'Regression did not demonstrate a behavioral failure', title: finding.title, before: outcome(before) });
        await reset();
        continue;
      }
      const baseIntegrity = await command(`base-integrity-${index}`, 'git -c core.hooksPath=/dev/null diff --name-only');
      if (baseIntegrity.exit_code !== 0 || baseIntegrity.stdout.trim() || sha256(await readWorkspace(finding.regression_path)) !== frozen || sha256(await readWorkspace(candidate.path)) !== sha256(candidate.source))
        throw new Error(`Regression for ${candidate.path} changed tracked source or existing tests on the base`);
      const issue = { id: sha256(`${candidate.path}:${finding.title}`).slice(0, 16), scan_id: id, kind: 'bug', status: 'open', title: finding.title, summary: finding.reason,
        priority: ['P1', 'P2', 'P3'].includes(finding.priority) ? finding.priority : 'P2', path: candidate.path, revision, regression_path: finding.regression_path,
        regression: finding.regression, command: finding.command, frozen_regression_sha256: frozen, created_at: new Date().toISOString(),
        evidence: [{ path: finding.regression_path, quote: (before.stdout + before.stderr).slice(-16_000) }] };
      issues.push(issue);
      log(`${candidate.path}: ${issue.priority} ${issue.title}`);
      await writeJson(files.issues, issues);
      if (!automatedFixes) { await reset(); continue; }

      // Fix inference against the native AST quality gate.
      const base = candidate.analysis.metrics;
      let accepted = null, rejection = null, quality = null;
      for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
        const proposal = await inference(`fix-${index}-${attempt}`, fixPrompt({ candidate, finding, before: outcome(before), rejection }));
        if (typeof proposal.source !== 'string' || proposal.source === candidate.source) {
          rejection = { reason: 'Fix agent did not return a source change', source: proposal.source };
          continue;
        }
        const after = await analyzer.analyzeSource(proposal.source, languageOf(candidate.path));
        const changed = after.metrics;
        const passes = after.parser_status === 'parsed' && changed && changed.risk_score <= base.risk_score + 0.01 &&
          (changed.cyclomatic_complexity ?? 0) <= (base.cyclomatic_complexity ?? 0) && (changed.max_nesting ?? 0) <= (base.max_nesting ?? 0);
        if (passes) { accepted = proposal; quality = { base, changed, accepted: true }; }
        else rejection = { reason: 'Native AST quality gate rejected the fix', base, changed, parser_status: after.parser_status, source: proposal.source };
      }
      const fixId = `${id}-${index}`;
      if (!accepted) {
        fixes.push({ id: fixId, issue_id: issue.id, status: 'rejected', title: finding.title, path: candidate.path, created_at: new Date().toISOString(), error: rejection.reason, quality: rejection });
        await writeJson(files.fixes, fixes);
        await reset();
        continue;
      }
      await writeWorkspace(candidate.path, accepted.source);
      const after = await command(`regression-fix-${index}`, finding.command);
      const checks = await command(`project-fix-${index}`, preparation.baseline, PREPARATION_MS);
      if (after.exit_code !== 0 || checks.exit_code !== 0) {
        fixes.push({ id: fixId, issue_id: issue.id, status: 'rejected', title: finding.title, path: candidate.path, created_at: new Date().toISOString(),
          error: after.exit_code !== 0 ? 'Fix did not make the regression pass' : 'Fix failed the project checks', summary: accepted.summary, quality, evidence: { before: outcome(before), after: outcome(after), checks: outcome(checks) } });
        await writeJson(files.fixes, fixes);
        await reset();
        continue;
      }
      const integrity = await command(`integrity-${index}`, `git -c core.hooksPath=/dev/null diff --name-only -- . ${quote(':!' + candidate.path)}`);
      if (integrity.exit_code !== 0 || integrity.stdout.trim() || sha256(await readWorkspace(finding.regression_path)) !== frozen || sha256(await readWorkspace(candidate.path)) !== sha256(accepted.source))
        throw new Error(`Tests or source changed while validating the fix for ${candidate.path}`);
      const review = await inference(`review-${index}`, reviewPrompt({ candidate, fix: accepted, finding, before: outcome(before), after: outcome(after), checks: outcome(checks) }), 8192);
      const patch = await command(`patch-${index}`, `git -c core.hooksPath=/dev/null add -N -- ${quote(finding.regression_path)} && git -c core.hooksPath=/dev/null diff -- ${quote(candidate.path)} ${quote(finding.regression_path)}`);
      if (patch.exit_code !== 0 || !patch.stdout) throw new Error(`Validated patch for ${candidate.path} could not be captured`);
      const patchPath = join(files.patches, `${index}.patch`);
      await writeFile(patchPath, patch.stdout);
      fixes.push({ id: fixId, issue_id: issue.id, status: review.approved ? 'ready' : 'rejected', title: finding.title, summary: accepted.summary, path: candidate.path,
        regression_path: finding.regression_path, revision, created_at: new Date().toISOString(), patch_path: patchPath, test_status: 'passed', quality, review,
        frozen_regression_sha256: frozen, error: review.approved ? undefined : `Review rejected the fix: ${review.reason}`,
        evidence: { before: outcome(before), after: outcome(after), checks: outcome(checks) } });
      log(`${candidate.path}: fix ${review.approved ? 'ready' : 'rejected by review'}`);
      await writeJson(files.fixes, fixes);
      await reset();
    }
    await reset();
    Object.assign(scan, { status: 'complete', completed_at: new Date().toISOString(), rejected, issue_count: issues.length, fix_count: fixes.length,
      ready_fix_count: fixes.filter(fix => fix.status === 'ready').length });
    await writeJson(files.issues, issues);
    await writeJson(files.fixes, fixes);
    await writeJson(files.scan, scan);
    return { ...scan, issues, fixes };
  } catch (error) {
    scan.status = 'failed';
    scan.error = error.message;
    await writeJson(files.scan, scan).catch(() => {});
    throw error;
  } finally {
    if (!keepWorkspace) await removeWorktree(root, workspace).catch(() => {});
  }
}
