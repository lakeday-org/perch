/** Human-readable summaries of scan, hunt, fix, and issue records. */
import { flagged, needsDesign } from './questions.js';

const short = revision => revision?.slice(0, 12) ?? '?';
const quoteArg = value => /^[\w./@:+-]+$/.test(value) ? value : "'" + String(value).replaceAll("'", "'\\''") + "'";

/** Rows rendered as aligned columns: text columns left-aligned, numeric columns right-aligned. */
function table(header, rows, align) {
  const all = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...all.map(row => String(row[column]).length)));
  return all.map(row => row.map((cell, column) => align[column] === 'left' ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column])).join('  ').trimEnd());
}

const number = value => value === null || value === undefined ? '-' : Math.round(value);
const relative = path => path.startsWith(process.cwd() + '/') ? path.slice(process.cwd().length + 1) : path;

export function formatScan(scan, shown = TOP) {
  const candidates = scan.candidates ?? [];
  const methods = new Map((scan.files ?? []).flatMap(file => file.methods.map(method => [method.id, { ...method, path: file.path }])));
  const lines = [`Scanned ${relative(scan.target)} at commit ${scan.revision?.slice(0, 7) ?? '?'}`];
  if (scan.coverage) {
    const listed = Math.min(shown, candidates.length);
    lines.push(`${scan.coverage.parsed} source files, ${scan.functions} methods. ${candidates.length} methods qualify for hunting${candidates.length > listed ? `; the ${listed} riskiest are listed, --all for every one` : ''}.`);
    if (scan.coverage.parse_failures) lines.push(`${scan.coverage.parse_failures} files could not be parsed and were skipped.`);
  }
  if (candidates.length) {
    const rows = candidates.slice(0, shown).map(candidate => {
      const method = methods.get(candidate.id), metrics = method?.metrics ?? {};
      return [method?.qualified_name ?? candidate.id, `${method?.path}:${method?.line}`, number(candidate.score), number(metrics.maintainability_index), number(metrics.cyclomatic_complexity), number(metrics.max_nesting), number(metrics.sloc)];
    });
    lines.push('', ...table(['Method', 'File', 'Risk', 'Maintainability', 'Complexity', 'Nesting', 'Lines'], rows, ['left', 'left']), '',
      'Risk 0-100, higher is riskier. Maintainability 0-100, higher is better. Lines exclude blanks and comments.');
  }
  lines.push('', `Full results: ${relative(scan.out)}/scan.json`);
  return lines.join('\n');
}

const percent = value => `${Math.round(value * 100)}%`;
const words = kind => kind.replaceAll('_', ' ');
const shortId = id => id.split('::').at(-1);
export const TOP = 10;

/** How a proven fix moved the defect probability: "90% -> 8%". */
const fixed = fix => `${percent(fix.verification.before.has_bug)} -> ${percent(fix.verification.after.has_bug)}`;
const fixCell = finding => (!finding.fix ? '-' : finding.fix.status === 'ready' ? `proven, ${fixed(finding.fix)}` : 'discarded');

/** Aligned rows of likely defects. */
function defectTable(findings) {
  const rows = findings.map(finding => [finding.id, finding.name, `${finding.path}:${finding.where.line}`, percent(finding.has_bug), words(finding.kind.kind), finding.severity.level, fixCell(finding)]);
  return table(['ID', 'Method', 'Location', 'Bug', 'Kind', 'Severity', 'Fixed'], rows, ['left', 'left', 'left', 'right', 'left', 'left', 'left']);
}

/** Aligned rows of methods needing design work. */
function designTable(findings) {
  const rows = findings.map(finding => {
    const refactor = finding.refactor?.refactor;
    return [finding.id, finding.name, `${finding.path}:${finding.line}`, refactor && refactor !== 'none' ? words(refactor) : '-', refactor && refactor !== 'none' ? percent(finding.refactor.probabilities?.[refactor] ?? 0) : '-',
      finding.does_what_it_claims === undefined ? '-' : percent(finding.does_what_it_claims), finding.misdocumented === undefined ? '-' : percent(finding.misdocumented)];
  });
  return table(['ID', 'Method', 'Location', 'Refactor', 'Confidence', 'Does what it claims', 'Misdocumented'], rows, ['left', 'left', 'left', 'left', 'right', 'right', 'right']);
}

const footer = 'perch issues <id> for detail, perch fix <id> for a patch.';

export function formatHunt(hunt, shown = TOP) {
  const hunted = (hunt.visited ?? []).filter(visit => visit.status === 'hunted');
  const findings = hunted.filter(visit => flagged(visit)).sort((a, b) => b.has_bug - a.has_bug);
  const design = hunted.filter(visit => needsDesign(visit));
  const lines = [`Hunted ${hunted.length} methods in ${relative(hunt.target)} at commit ${hunt.revision?.slice(0, 7) ?? '?'}${hunt.status === 'complete' ? '' : ` (${hunt.status})`}.`];
  if (hunt.error) lines.push(`Error: ${hunt.error}`);
  const parts = [];
  if (findings.length) parts.push(`${findings.length} look defective`);
  if (design.length) parts.push(`${design.length} need design work`);
  if (hunted.length - findings.length) parts.push(`${hunted.length - findings.length} look free of defects`);
  if (hunt.skipped) parts.push(`${hunt.skipped} skipped as unchanged since an earlier hunt`);
  if (hunt.remaining) parts.push(`${hunt.remaining} of ${hunt.methods} not reached yet`);
  if (parts.length) lines.push(`${parts.join(', ')}.`);
  if (findings.length) lines.push('', ...defectTable(findings.slice(0, shown)), ...(findings.length > shown ? [`${findings.length - shown} more; --all for every one.`] : []));
  if (design.length) lines.push('', 'Design work:', '', ...designTable(design.slice(0, shown)), ...(design.length > shown ? [`${design.length - shown} more; --all for every one.`] : []));
  lines.push('', footer);
  return lines.join('\n');
}

const listed = (count, shown, what) => `${count} methods ${what}${count > shown ? `; the ${shown} strongest are listed, --all for every one` : ''}.`;

export function formatIssues(findings, min, shown = TOP) {
  if (!findings.length) return `No hunted method looks defective at ${percent(min)} or more.`;
  return [listed(findings.length, shown, `look defective at ${percent(min)} or more`), '', ...defectTable(findings.slice(0, shown)), '', footer].join('\n');
}

export function formatDesign(findings, min, shown = TOP) {
  if (!findings.length) return `No hunted method needs design work at ${percent(min)} or more.`;
  return [listed(findings.length, shown, `need design work at ${percent(min)} or more`), '', ...designTable(findings.slice(0, shown)), '', 'perch design <id> for detail.'].join('\n');
}

/** Everything the model answered about one method. */
export function formatFinding(finding) {
  const probabilities = object => Object.entries(object).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${words(key)} ${percent(value)}`).join(', ');
  const lines = [
    `${finding.id}  ${finding.name}  ${finding.path}:${finding.line}-${finding.end_line}  hunted at commit ${finding.revision.slice(0, 7)} on ${finding.at.slice(0, 10)}`,
    `Reachable defect: ${percent(finding.has_bug)}. Points at line ${finding.where.line} (confidence ${percent(finding.where.confidence)}):`,
    `    ${finding.where.line}| ${finding.where.text ?? ''}`,
    `Kind: ${probabilities(finding.kinds ?? { [finding.kind.kind]: finding.kind.probability ?? 0 })}`,
    `Severity: ${finding.severity.level} (score ${finding.severity.score.toFixed(2)}, confidence ${percent(finding.severity.confidence)})`,
  ];
  if (finding.does_what_it_claims !== undefined) lines.push(`Does what it claims: ${percent(finding.does_what_it_claims)}. Misdocumented: ${percent(finding.misdocumented)}. Refactor: ${probabilities(finding.refactor.probabilities ?? {})}`);
  if (finding.misuse?.length) lines.push(`Misuses a callee: ${finding.misuse.map(item => `${shortId(item.callee)} ${percent(item.probability)}`).join(', ')}`);
  if (finding.misused_by?.length) lines.push(`Misused by a caller: ${finding.misused_by.map(item => `${shortId(item.caller)} ${percent(item.probability)}`).join(', ')}`);
  lines.push(`Follow next: ${finding.follow.method ? `${shortId(finding.follow.method)} (${percent(finding.follow.confidence)})` : 'none'}`);
  if (finding.callees?.length) lines.push(`Calls: ${finding.callees.map(shortId).join(', ')}`);
  if (finding.callers?.length) lines.push(`Called by: ${finding.callers.map(shortId).join(', ')}`);
  if (finding.fix?.status === 'ready') lines.push(`Fixed: proven by ${finding.fix.test_path} on ${finding.fix.at.slice(0, 10)}; reachable defect ${fixed(finding.fix)}${finding.fix.summary ? ` — ${finding.fix.summary}` : ''}`, `    patch: ${finding.fix.patch_path}`);
  else if (finding.fix) lines.push(`Discarded: no fix could be proven in ${finding.fix.attempts} attempts on ${finding.fix.at.slice(0, 10)}; last rejection: ${(finding.fix.error ?? '').split('\n')[0]}`);
  if (finding.description) lines.push(`Filed as: ${finding.description.title}`);
  if (finding.github_url) lines.push(`GitHub: ${finding.github_url}${finding.github_status ? ` (${finding.github_status})` : ''}`);
  if (finding.pr_url) lines.push(`Pull request: ${finding.pr_url}`);
  return lines.join('\n');
}

/** What publish did for one finding. */
export function formatPublished(finding) {
  const lines = [];
  if (finding.github_status === 'discarded') lines.push(`${finding.id}  discarded: no fix could be proven, and no issue was open to close`);
  else if (finding.github_status === 'closed') lines.push(`${finding.id}  discarded: no fix could be proven; closed ${finding.github_url}`);
  else if (finding.github_url) lines.push(`${finding.id}  ${finding.description?.title ?? ''}`.trimEnd(), `${finding.id}  issue: ${finding.github_url}  (${finding.github_status ?? 'existing'})`);
  if (finding.pr_url) lines.push(`${finding.id}  pull request: ${finding.pr_url}  (${finding.pr_status ?? 'existing'})`);
  return lines.join('\n');
}

export function formatFix(fix) {
  const lines = [`perch fix ${fix.id} (${fix.status})${fix.summary ? ` — ${fix.summary}` : ''}`, `  finding: ${fix.finding_id}  ${fix.method}  ${fix.path} @ ${short(fix.revision)}`];
  if (fix.status === 'ready') {
    const { kind, before, after } = fix.verification;
    const failing = fix.proof.baseline_failures ?? [];
    const existing = (fix.proof.existing_tests.length ? `${fix.proof.existing_tests.length} existing ${fix.proof.existing_tests.length === 1 ? 'test' : 'tests'} still pass` : 'no existing test reaches the method')
      + (failing.length ? ` (${failing.join(', ')} already failed on the original and did not count)` : '');
    const shift = (from, to) => (from === null ? percent(to) : `${percent(from)} -> ${percent(to)}`);
    lines.push(`  proof: ${fix.test_path} fails on the original with an assertion and passes on the patch; ${existing}`,
      `  verified by ${fix.verifier}: reachable defect ${shift(before.has_bug, after.has_bug)}${after.kind !== null ? `, ${words(kind)} ${shift(before.kind, after.kind)}` : ''}, collateral change ${percent(after.collateral_change)}`,
      `  patch: ${fix.patch_path}`, `  apply: git -C ${quoteArg(fix.root)} apply ${quoteArg(fix.patch_path)}`);
    if (fix.attempts.length > 1) lines.push(`  attempts: ${fix.attempts.length}; ${fix.attempts.slice(0, -1).map(attempt => `attempt ${attempt.attempt} rejected: ${attempt.rejected?.split('\n')[0]}`).join('; ')}`);
  }
  if (fix.error) lines.push(`  error: ${fix.error}`);
  if (fix.workspace) lines.push(`  workspace kept: ${fix.workspace}`);
  lines.push(`  results: ${fix.out}`);
  return lines.join('\n');
}
