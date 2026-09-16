/** Human-readable summaries of scan, hunt, fix, and issue records. */
import { hasIssue, isDesign, issuesOf } from './questions.js';

const short = revision => revision?.slice(0, 12) ?? '?';

/** Rows rendered as aligned columns: text columns left-aligned, numeric columns right-aligned. */
function table(header, rows, align) {
  const all = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...all.map(row => String(row[column]).length)));
  return all.map(row => row.map((cell, column) => align[column] === 'left' ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column])).join('  ').trimEnd());
}

const number = value => value === null || value === undefined ? '-' : Math.round(value);
const relative = path => path.startsWith(process.cwd() + '/') ? path.slice(process.cwd().length + 1) : path;

export function formatScan(scan, shown = TOP) {
  const files = (scan.files ?? []).filter(file => file.metrics).sort((a, b) => (b.metrics.risk_score ?? 0) - (a.metrics.risk_score ?? 0) || a.path.localeCompare(b.path));
  const lines = [`Scanned ${relative(scan.target)} at commit ${scan.revision?.slice(0, 7) ?? '?'}`];
  if (scan.coverage) {
    const listed = Math.min(shown, files.length);
    lines.push(`${scan.coverage.parsed} source files, ${scan.functions} methods. ${files.length} files ranked by risk${files.length > listed ? `; the ${listed} riskiest are listed, --all for every one` : ''}.`);
    if (scan.coverage.parse_failures) lines.push(`${scan.coverage.parse_failures} files could not be parsed and were skipped.`);
  }
  if (files.length) {
    const rows = files.slice(0, shown).map(file => {
      const metrics = file.metrics;
      return [file.path, number(metrics.risk_score), number(metrics.maintainability_index), number(metrics.cyclomatic_complexity), number(metrics.max_nesting), number(metrics.sloc)];
    });
    lines.push('', ...table(['File', 'Risk', 'Maintainability', 'Complexity', 'Nesting', 'Lines'], rows, ['left']), '',
      'Risk 0-100, higher is riskier. Maintainability 0-100, higher is better. Lines exclude blanks and comments.');
  }
  lines.push('', `Full results: ${relative(scan.out)}/scan.json`);
  return lines.join('\n');
}

const percent = value => `${Math.round(value * 100)}%`;
const words = kind => kind.replaceAll('_', ' ');
const shortId = id => id.split('::').at(-1);
export const TOP = 10;


/** A finding is closed once every attempt to fix its defect was rejected. */
export const issueStatus = finding => (finding.fix?.status === 'rejected' ? 'closed' : 'open');
/** What a fix did to a finding, for the table: the commit, or `-`. */
const fixRef = finding => (finding.fix?.status === 'ready' ? finding.fix.commit?.slice(0, 7) ?? 'fixed' : '-');
const statusRow = finding => [issueStatus(finding), fixRef(finding)];
const issueCell = (finding, min) => issuesOf(finding, min).map(issue => `${issue.label} ${percent(issue.probability)}`).join(', ');
const locationOf = (finding, min) => `${finding.path}:${issuesOf(finding, min)[0]?.type === 'defect' ? finding.where.line : finding.line}`;

/** Aligned rows of methods with issues: defects and design issues in one list, each row naming everything the hunt raised. */
function issueTable(findings, min = 0.5) {
  const rows = findings.map(finding => [finding.id, finding.name, locationOf(finding, min), issueCell(finding, min), issuesOf(finding, min).some(issue => !isDesign(issue)) ? finding.severity.level : '-', ...statusRow(finding)]);
  return table(['ID', 'Method', 'Location', 'Issues', 'Severity', 'Status', 'Commit'], rows, ['left', 'left', 'left', 'left', 'left', 'left', 'left']);
}

const footer = 'perch issues <id> for detail, perch fix to work the defects.';

export function formatHunt(hunt, shown = TOP) {
  const hunted = (hunt.visited ?? []).filter(visit => visit.status === 'hunted');
  const strength = visit => issuesOf(visit)[0]?.probability ?? 0;
  const findings = hunted.filter(visit => hasIssue(visit)).sort((a, b) => strength(b) - strength(a));
  const defects = findings.filter(visit => issuesOf(visit).some(issue => !isDesign(issue))).length;
  const lines = [`Hunted ${hunted.length} methods in ${relative(hunt.target)} at commit ${hunt.revision?.slice(0, 7) ?? '?'}${hunt.status === 'complete' ? '' : ` (${hunt.status})`}.`];
  if (hunt.error) lines.push(`Error: ${hunt.error}`);
  const parts = [];
  if (findings.length) parts.push(`${findings.length} have issues (${defects} ${defects === 1 ? 'defect' : 'defects'}, ${findings.length - defects} design only)`);
  if (hunted.length - findings.length) parts.push(`${hunted.length - findings.length} look clean`);
  if (hunt.skipped) parts.push(`${hunt.skipped} skipped as unchanged since an earlier hunt`);
  if (hunt.remaining) parts.push(`${hunt.remaining} of ${hunt.methods} not reached yet`);
  if (parts.length) lines.push(`${parts.join(', ')}.`);
  if (findings.length) lines.push('', ...issueTable(findings.slice(0, shown)), ...(findings.length > shown ? [`${findings.length - shown} more; --all for every one.`] : []));
  lines.push('', footer);
  return lines.join('\n');
}

const listed = (open, closed, shown, noun, includeClosed) => {
  const rows = includeClosed ? open + closed : open;
  const more = rows > shown ? `; the ${shown} strongest are listed, --all for every one` : '';
  if (includeClosed) return `${open} open, ${closed} closed ${noun}${more}.`;
  if (!open) return closed ? `No open ${noun}. ${closed} closed; --closed to list them.` : `No open ${noun}.`;
  return `${open} open ${noun}${more}.${closed ? ` ${closed} closed; --closed to list them.` : ''}`;
};

/** Findings to print: closed ones stay off the list unless asked for. */
export function visibleFindings(findings, { closed = false } = {}) {
  return closed ? findings : findings.filter(finding => issueStatus(finding) === 'open');
}

export function formatIssues(findings, min, shown = TOP, { closed = false } = {}) {
  if (!findings.length) return `No hunted method has an issue at ${percent(min)} or more.`;
  const hidden = findings.filter(finding => issueStatus(finding) === 'closed').length;
  const rows = visibleFindings(findings, { closed });
  const noun = `issues at ${percent(min)} or more`;
  if (!rows.length) return listed(0, hidden, shown, noun, closed);
  return [listed(findings.length - hidden, hidden, shown, noun, closed), '', ...issueTable(rows.slice(0, shown), min), '', footer].join('\n');
}

/** Everything the model answered about one method. */
export function formatFinding(finding) {
  const probabilities = object => Object.entries(object).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${words(key)} ${percent(value)}`).join(', ');
  const lines = [
    `${finding.id}  ${finding.name}  ${finding.path}:${finding.line}-${finding.end_line}  hunted at commit ${finding.revision.slice(0, 7)} on ${finding.at.slice(0, 10)}`,
    `Reachable defect: ${percent(finding.has_bug)}${finding.reachable === undefined ? '' : `; line reachable ${percent(finding.reachable)}`}. Points at line ${finding.where.line} (confidence ${percent(finding.where.confidence)}):`,
    `    ${finding.where.line}| ${finding.where.text ?? ''}`,
    `Kind: ${probabilities(finding.kinds ?? { [finding.kind.kind]: finding.kind.probability ?? 0 })}`,
    `Severity: ${finding.severity.level} (score ${finding.severity.score.toFixed(2)}, confidence ${percent(finding.severity.confidence)})`,
  ];
  lines.push(`Issues: ${issueCell(finding) || 'none at 50%'}`);
  if (finding.does_what_it_claims !== undefined) lines.push(`Does what it claims: ${percent(finding.does_what_it_claims)}. Misdocumented: ${percent(finding.misdocumented)}. Refactor: ${probabilities(finding.refactor.probabilities ?? {})}`);
  if (finding.misuse?.length) lines.push(`Misuses a callee: ${finding.misuse.map(item => `${shortId(item.callee)} ${percent(item.probability)}`).join(', ')}`);
  if (finding.misused_by?.length) lines.push(`Misused by a caller: ${finding.misused_by.map(item => `${shortId(item.caller)} ${percent(item.probability)}`).join(', ')}`);
  lines.push(`Follow next: ${finding.follow.method ? `${shortId(finding.follow.method)} (${percent(finding.follow.confidence)})` : 'none'}`);
  if (finding.callees?.length) lines.push(`Calls: ${finding.callees.map(shortId).join(', ')}`);
  if (finding.callers?.length) lines.push(`Called by: ${finding.callers.map(shortId).join(', ')}`);
  lines.push(`Status: ${issueStatus(finding)}`);
  if (finding.fix?.status === 'ready') lines.push(`Fixed: ${finding.fix.summary ?? ''} (defect ${percent(finding.fix.verification?.before?.has_bug ?? finding.has_bug)} -> ${percent(finding.fix.verification?.after?.has_bug ?? 0)})`.trimEnd(), `    commit ${finding.fix.commit?.slice(0, 7) ?? '?'}${finding.fix.branch ? ` on ${finding.fix.branch}` : ''}  ${finding.fix.patch_path}`);
  else if (finding.fix) lines.push(`Fix discarded: no fix after ${finding.fix.attempts} attempts on ${finding.fix.at.slice(0, 10)}; last rejection: ${(finding.fix.error ?? '').split('\n')[0]}`);
  if (finding.refactored?.status === 'ready') lines.push(`Refactored: ${finding.refactored.summary ?? ''}${finding.refactored.before && finding.refactored.after ? ` (${metricShift(finding.refactored.before, finding.refactored.after)})` : ''}`.trimEnd(), `    commit ${finding.refactored.commit?.slice(0, 7) ?? '?'}${finding.refactored.branch ? ` on ${finding.refactored.branch}` : ''}  ${finding.refactored.patch_path}`);
  else if (finding.refactored) lines.push(`Refactor discarded: after ${finding.refactored.attempts} attempts on ${finding.refactored.at.slice(0, 10)}; last rejection: ${(finding.refactored.error ?? '').split('\n')[0]}`);
  return lines.join('\n');
}

export function formatFixes(batch) {
  const refactor = batch.kind === 'refactor';
  const noun = refactor ? 'methods' : 'defects';
  const stale = batch.stale ? ` ${batch.stale} ${batch.stale === 1 ? 'finding is' : 'findings are'} for methods that changed since the hunt; hunt again to refresh them.` : '';
  if (!batch.fixes.length) return refactor ? `No methods at risk ${batch.min ?? '?'} or more left to refactor${batch.open === 0 ? '' : ' in that path'}.` : `No open defects to fix.${stale}`;
  const left = batch.remaining ? `, ${batch.remaining} left` : '';
  const committed = batch.fixes.filter(fix => fix.status === 'ready').length;
  return [`${refactor ? 'Simplified' : 'Investigated'} ${batch.fixes.length} ${noun} (budget ${batch.budget}${left}); ${committed} committed.${stale}`, ...batch.fixes.flatMap(fix => ['', formatFix(fix)])].join('\n');
}

/** "risk 91 -> 74, maintainability 12 -> 30, complexity 48 -> 20, nesting 4 -> 3, lines 180 -> 120". */
const metricShift = (before, after) => [['risk', 'risk_score'], ['maintainability', 'maintainability_index'], ['complexity', 'cyclomatic_complexity'], ['nesting', 'max_nesting'], ['lines', 'sloc']]
  .map(([label, key]) => `${label} ${number(before?.[key])} -> ${number(after?.[key])}`).join(', ');

/** One refactor record: the method's metrics before and after, what checked it, and the commit. */
function formatRefactor(record) {
  const lines = [`perch refactor ${record.id ?? record.method} (${record.status})${record.summary ? ` — ${record.summary}` : ''}`, `  method: ${record.name ?? record.method}  ${record.path} @ ${short(record.revision)}`];
  if (record.before) lines.push(`  before: risk ${number(record.before.risk_score)}, maintainability ${number(record.before.maintainability_index)}, complexity ${number(record.before.cyclomatic_complexity)}, nesting ${number(record.before.max_nesting)}, ${number(record.before.sloc)} lines`);
  if (record.status === 'ready') {
    lines.push(`  after:  ${metricShift(record.before, record.after)}`, `  checked by: ${(record.proof?.checks ?? []).join(', ') || 'nothing'}`,
      `  verified by ${record.verifier}: behavior change ${percent(record.verification?.collateral_change ?? 0)}, defect ${percent(record.verification?.has_bug ?? 0)}, does what it claims ${percent(record.verification?.does_what_it_claims ?? 0)}`,
      `  committed: ${record.commit?.slice(0, 7) ?? '?'} on ${record.branch ?? '?'}  (patch: ${record.patch_path})`);
    if (record.attempts?.length > 1) lines.push(`  attempts: ${record.attempts.length}; ${record.attempts.slice(0, -1).map(attempt => `attempt ${attempt.attempt} rejected: ${attempt.rejected?.split('\n')[0]}`).join('; ')}`);
  }
  if (record.error) lines.push(`  error: ${record.error}`);
  lines.push(`  results: ${record.out}`);
  return lines.join('\n');
}

export function formatFix(fix) {
  if (fix.kind === 'refactor') return formatRefactor(fix);
  const lines = [`perch fix ${fix.id ?? fix.finding_id} (${fix.status})${fix.summary ? ` — ${fix.summary}` : ''}`, `  finding: ${fix.finding_id}  ${fix.method}  ${fix.path} @ ${short(fix.revision)}`];
  if (fix.status === 'ready') {
    const { kind, before, after } = fix.verification;
    const shift = (from, to) => (from === null || from === undefined ? percent(to) : `${percent(from)} -> ${percent(to)}`);
    lines.push(`  verified by ${fix.verifier}: reachable ${percent(before.reachable ?? 1)}; defect ${shift(before.has_bug, after.has_bug)}${after.kind !== null ? `, ${words(kind)} ${shift(before.kind, after.kind)}` : ''}, collateral change ${percent(after.collateral_change)}`,
      `  committed: ${fix.commit?.slice(0, 7) ?? '?'} on ${fix.branch ?? '?'}  (patch: ${fix.patch_path})`);
    if (fix.attempts.length > 1) lines.push(`  attempts: ${fix.attempts.length}; ${fix.attempts.slice(0, -1).map(attempt => `attempt ${attempt.attempt} rejected: ${attempt.rejected?.split('\n')[0]}`).join('; ')}`);
  }
  if (fix.error) lines.push(`  error: ${fix.error}`);
  lines.push(`  results: ${fix.out}`);
  return lines.join('\n');
}
