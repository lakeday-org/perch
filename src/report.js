/** Human-readable scan summaries and the `perch report` command. */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export function formatSummary(scan) {
  const lines = [];
  const issues = scan.issues ?? [], fixes = scan.fixes ?? [];
  lines.push(`perch scan ${scan.id} (${scan.status}) — ${scan.target} @ ${scan.revision?.slice(0, 12)}`);
  if (scan.error) lines.push(`  error: ${scan.error}`);
  if (scan.coverage) lines.push(`  files: ${scan.coverage.parsed} parsed, ${scan.coverage.parse_failures} parse failures, ${scan.coverage.excluded} skipped; ${scan.functions} functions`);
  if (scan.candidates?.length) lines.push(`  candidates: ${scan.candidates.map(candidate => `${candidate.path} (${candidate.score.toFixed(3)})`).join(', ')}`);
  if (scan.preparation) lines.push(`  setup: ${scan.preparation.setup}`, `  baseline: ${scan.preparation.baseline}`);
  lines.push(`  issues: ${issues.length}`);
  for (const issue of issues) {
    lines.push(`    [${issue.priority}] ${issue.title}`, `        file: ${issue.path}`, `        regression: ${issue.regression_path}`);
    if (issue.github_url) lines.push(`        github: ${issue.github_url}`);
  }
  if (scan.fix) {
    lines.push(`  fixes: ${fixes.length} (${fixes.filter(fix => fix.status === 'ready').length} ready)`);
    for (const fix of fixes) {
      lines.push(`    ${fix.status.toUpperCase()} ${fix.title}`);
      if (fix.patch_path) lines.push(`        patch: ${fix.patch_path}`);
      if (fix.status === 'ready') lines.push(`        apply: git -C ${quoteArg(scan.root)} apply ${quoteArg(fix.patch_path)}`);
      if (fix.error) lines.push(`        ${fix.error}`);
    }
  }
  if (scan.rejected?.length) lines.push(`  rejected investigations: ${scan.rejected.map(item => `${item.path} (${item.reason})`).join('; ')}`);
  lines.push(`  results: ${scan.out}`);
  if (scan.workspace) lines.push(`  workspace kept: ${scan.workspace}`);
  return lines.join('\n');
}

const quoteArg = value => /^[\w./@:+-]+$/.test(value) ? value : "'" + String(value).replaceAll("'", "'\\''") + "'";

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

/** Load a scan directory's records. */
export async function loadScan(dir) {
  const scan = await readJson(join(dir, 'scan.json'), null);
  if (!scan) return null;
  return { ...scan, issues: await readJson(join(dir, 'issues.json'), []), fixes: await readJson(join(dir, 'fixes.json'), []) };
}

/** The most recently written scan under an output directory. */
export async function latestScan(out) {
  const scansDir = join(out, 'scans');
  let names = [];
  try { names = await readdir(scansDir); } catch { return null; }
  let latest = null;
  for (const name of names) {
    const path = join(scansDir, name, 'scan.json');
    const info = await stat(path).catch(() => null);
    if (info && (!latest || info.mtimeMs > latest.mtimeMs)) latest = { dir: join(scansDir, name), mtimeMs: info.mtimeMs };
  }
  return latest ? loadScan(latest.dir) : null;
}
