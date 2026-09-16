/** Human-readable summaries of scans, issues, and the work done on them. */
import { isDesign, issuesOf, label } from './questions.js';

const short = revision => revision?.slice(0, 12) ?? '?';

/** Rows rendered as aligned columns: text columns left-aligned, numeric columns right-aligned. */
function table(header, rows, align) {
  const all = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...all.map(row => String(row[column]).length)));
  return all.map(row => row.map((cell, column) => align[column] === 'left' ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column])).join('  ').trimEnd());
}

const number = value => value === null || value === undefined ? '-' : Math.round(value);
const relative = path => path.startsWith(process.cwd() + '/') ? path.slice(process.cwd().length + 1) : path;

const percent = value => `${Math.round(value * 100)}%`;
const words = label;
const shortId = id => id.split('::').at(-1);
export const TOP = 10;


/** How a finding is worked: a defect by the fix agent, anything else by bringing the file's score down. */
export const workFor = (finding, min = 0.5) => (issuesOf(finding, min).some(issue => !isDesign(issue)) ? 'defect' : 'simplify');
/** The record of the work done on a finding, whichever kind it was. */
export const workOn = finding => (workFor(finding) === 'defect' ? finding.fix : finding.refactored) ?? null;
/** A finding is closed once its work was closed (nothing to do) or every attempt at it was rejected. */
export const issueStatus = finding => { const work = workOn(finding); return work && (work.status === 'rejected' || work.status === 'closed') ? 'closed' : 'open'; };
/** The commit that worked a finding, for the table, or `-`. */
const commitRef = finding => { const work = workOn(finding); return work?.status === 'ready' ? work.commit?.slice(0, 7) ?? 'done' : '-'; };
const statusRow = finding => [issueStatus(finding), commitRef(finding)];
const issueCell = (finding, min) => issuesOf(finding, min).map(issue => issue.text).join(', ');
const locationOf = (finding, min) => `${finding.path}:${issuesOf(finding, min)[0]?.type === 'defect' ? finding.where.line : finding.line}`;

/** Aligned rows of methods with issues: everything the scan raised about each, defects and design alike. */
function issueTable(findings, min = 0.5) {
  const rows = findings.map(finding => [finding.id, finding.name, locationOf(finding, min), issueCell(finding, min), workFor(finding, min) === 'defect' ? finding.severity?.level ?? '-' : '-', ...statusRow(finding)]);
  return table(['ID', 'Method', 'Location', 'Issues', 'Severity', 'Status', 'Commit'], rows, ['left', 'left', 'left', 'left', 'left', 'left', 'left']);
}

const footer = 'perch fix works these in this order. perch fix <id> works one. perch issues <id> shows everything about one.';

/** What one scan did, then the open issues as `perch issues` lists them. */
export function formatScanRun(hunt, issues, shown = TOP) {
  const hunted = (hunt.visited ?? []).filter(visit => visit.status === 'hunted');
  const lines = [`Scanned ${relative(hunt.target)} at commit ${hunt.revision?.slice(0, 7) ?? '?'}: ${hunt.methods} methods; System One read ${hunted.length}${hunt.skipped ? `, skipped ${hunt.skipped} unchanged since an earlier scan` : ''}${hunt.remaining ? `, ${hunt.remaining} not reached yet (--budget)` : ''}.${hunt.status === 'complete' ? '' : ` (${hunt.status})`}`];
  if (hunt.error) lines.push(`Error: ${hunt.error}`);
  lines.push('', formatIssues(issues, 0.5, shown));
  return lines.join('\n');
}

/** "115 open issues, 10 shown (--all for the rest). 6 closed (--closed)." */
const listed = (open, closed, shown, includeClosed, min) => {
  const rows = includeClosed ? open + closed : open;
  const threshold = min !== 0.5 ? ` at ${percent(min)} or more` : '';
  const count = includeClosed ? `${open} open and ${closed} closed issues${threshold}` : `${open} open ${open === 1 ? 'issue' : 'issues'}${threshold}`;
  const cut = rows > shown ? `, ${shown} shown (--all for the rest)` : '';
  const hidden = !includeClosed && closed ? ` ${closed} closed (--closed).` : '';
  if (!open && !includeClosed) return `No open issues${threshold}.${hidden}`;
  return `${count}${cut}.${hidden}`;
};

/** Findings to print: closed ones stay off the list unless asked for. */
export function visibleFindings(findings, { closed = false } = {}) {
  return closed ? findings : findings.filter(finding => issueStatus(finding) === 'open');
}

export function formatIssues(findings, min, shown = TOP, { closed = false, gone = 0 } = {}) {
  const goneNote = gone ? ` ${gone} ${gone === 1 ? 'is' : 'are'} for ${gone === 1 ? 'a method' : 'methods'} that no longer exist and ${gone === 1 ? 'is' : 'are'} not listed.` : '';
  const hidden = findings.filter(finding => issueStatus(finding) === 'closed').length;
  const rows = visibleFindings(findings, { closed });
  const head = listed(findings.length - hidden, hidden, shown, closed, min) + goneNote;
  if (!rows.length) return head;
  return [head, '', ...issueTable(rows.slice(0, shown), min), '', footer].join('\n');
}

/** Everything known about one method: System One's answers when it has read it, the metrics always, and the work done on it. */
export function formatFinding(finding) {
  const probabilities = object => Object.entries(object).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${words(key)} ${percent(value)}`).join(', ');
  const lines = [`${finding.id}  ${finding.name}  ${finding.path}:${finding.line}-${finding.end_line}  at commit ${finding.revision.slice(0, 7)}${finding.unread ? ' (not yet read by System One)' : ` read on ${finding.at.slice(0, 10)}`}`];
  lines.push(`Issues: ${issueCell(finding) || 'none at 50%'}`);
  if (finding.metrics) lines.push(`Metrics: risk ${number(finding.metrics.risk_score)}, maintainability ${number(finding.metrics.maintainability_index)}, complexity ${number(finding.metrics.cyclomatic_complexity)}, nesting ${number(finding.metrics.max_nesting)}, ${number(finding.metrics.sloc)} lines${finding.file ? `; file risk ${number(finding.file.risk_score)}` : ''}`);
  if (finding.has_bug !== undefined) {
    lines.push(`Defect: ${percent(finding.has_bug)}${finding.reachable === undefined ? '' : `; line reachable ${percent(finding.reachable)}`}. Points at line ${finding.where.line} (confidence ${percent(finding.where.confidence)}):`, `    ${finding.where.line}| ${finding.where.text ?? ''}`,
      `Kind: ${probabilities(finding.kinds ?? { [finding.kind.kind]: finding.kind.probability ?? 0 })}`, `Severity: ${finding.severity.level} (score ${finding.severity.score.toFixed(2)}, confidence ${percent(finding.severity.confidence)})`);
    if (finding.does_what_it_claims !== undefined) lines.push(`Does what it claims: ${percent(finding.does_what_it_claims)}. Misdocumented: ${percent(finding.misdocumented)}. Refactor: ${probabilities(finding.refactor.probabilities ?? {})}`);
    if (finding.misuse?.length) lines.push(`Misuses a callee: ${finding.misuse.map(item => `${shortId(item.callee)} ${percent(item.probability)}`).join(', ')}`);
    if (finding.misused_by?.length) lines.push(`Misused by a caller: ${finding.misused_by.map(item => `${shortId(item.caller)} ${percent(item.probability)}`).join(', ')}`);
    if (finding.callees?.length) lines.push(`Calls: ${finding.callees.map(shortId).join(', ')}`);
    if (finding.callers?.length) lines.push(`Called by: ${finding.callers.map(shortId).join(', ')}`);
  }
  lines.push(`Status: ${issueStatus(finding)}`);
  const work = workOn(finding);
  if (work?.status === 'ready') lines.push(`${workFor(finding) === 'defect' ? 'Fixed' : 'Simplified'}: ${work.summary ?? ''}${work.file_before && work.file_after ? ` (file ${metricShift(work.file_before, work.file_after)})` : work.verification ? ` (defect ${percent(work.verification.before?.has_bug ?? finding.has_bug)} -> ${percent(work.verification.after?.has_bug ?? 0)})` : ''}`.trimEnd(), `    commit ${work.commit?.slice(0, 7) ?? '?'}${work.branch ? ` on ${work.branch}` : ''}  ${work.patch_path}`);
  else if (work?.status === 'closed') lines.push(`Closed on ${work.at.slice(0, 10)}: ${work.reason}`);
  else if (work) lines.push(`No fix on ${work.at.slice(0, 10)} after ${work.attempts} model turns; last rejection: ${(work.error ?? '').split('\n')[0]}`);
  return lines.join('\n');
}

export function formatFixes(batch) {
  const stale = batch.stale ? ` ${batch.stale} ${batch.stale === 1 ? 'finding is' : 'findings are'} for methods that no longer exist under that name; scan again to see what replaced them.` : '';
  if (!batch.fixes.length) return `No open issues to work.${stale}`;
  const left = batch.remaining ? `, ${batch.remaining} left` : '';
  const committed = batch.fixes.filter(fix => fix.status === 'ready').length;
  return [`Worked ${batch.fixes.length} ${batch.fixes.length === 1 ? 'issue' : 'issues'} (budget ${batch.budget}${left}); ${committed} committed.${stale}`, ...batch.fixes.flatMap(fix => ['', formatFix(fix)])].join('\n');
}

/** "risk 91 -> 74, maintainability 12 -> 30, complexity 48 -> 20, nesting 4 -> 3, lines 180 -> 120". */
const metricShift = (before, after) => [['risk', 'risk_score'], ['maintainability', 'maintainability_index'], ['complexity', 'cyclomatic_complexity'], ['nesting', 'max_nesting'], ['lines', 'sloc']]
  .map(([label, key]) => `${label} ${number(before?.[key])} -> ${number(after?.[key])}`).join(', ');

/** One refactor record: the method's metrics before and after, what checked it, and the commit. */
function formatRefactor(record) {
  const lines = [`perch refactor ${record.id ?? record.method} (${record.status})${record.summary ? ` — ${record.summary}` : ''}`, `  method: ${record.name ?? record.method}  ${record.path} @ ${short(record.revision)}`];
  if (record.file_before) lines.push(`  file before: risk ${number(record.file_before.risk_score)}, maintainability ${number(record.file_before.maintainability_index)}, complexity ${number(record.file_before.cyclomatic_complexity)}, nesting ${number(record.file_before.max_nesting)}, ${number(record.file_before.sloc)} lines`);
  if (record.status === 'ready') {
    lines.push(`  file after:  ${metricShift(record.file_before, record.file_after)}`, `  method:      ${metricShift(record.before, record.after)}`, `  checked by: ${(record.proof?.checks ?? []).join(', ') || 'nothing'}`,
      `  committed: ${record.commit?.slice(0, 7) ?? '?'} on ${record.branch ?? '?'}  (patch: ${record.patch_path})`);
    if (record.turns) lines.push(`  agent: ${record.turns} ${record.turns === 1 ? 'turn' : 'turns'}, ${(record.trace ?? []).filter(event => event.type === 'tool_call').length} tool calls`);
  }
  if (record.error) lines.push(`  error: ${record.error}`);
  lines.push(`  results: ${record.out}`);
  return lines.join('\n');
}

export function formatFix(fix) {
  if (fix.kind === 'refactor') return formatRefactor(fix);
  if (fix.status === 'closed') return `${fix.finding_id}  ${fix.method}  closed: ${fix.reason}`;
  const lines = [`perch fix ${fix.id ?? fix.finding_id} (${fix.status})${fix.summary ? ` — ${fix.summary}` : ''}`, `  finding: ${fix.finding_id}  ${fix.method}  ${fix.path} @ ${short(fix.revision)}`];
  if (fix.status === 'ready') {
    const { kind, before, after } = fix.verification;
    const shift = (from, to) => (from === null || from === undefined ? percent(to) : `${percent(from)} -> ${percent(to)}`);
    lines.push(`  verified by ${fix.verifier}: reachable ${percent(before.reachable ?? 1)}; defect ${shift(before.has_bug, after.has_bug)}${after.kind !== null ? `, ${words(kind)} ${shift(before.kind, after.kind)}` : ''}`,
      `  committed: ${fix.commit?.slice(0, 7) ?? '?'} on ${fix.branch ?? '?'}  (patch: ${fix.patch_path})`);
    if (fix.turns) lines.push(`  agent: ${fix.turns} ${fix.turns === 1 ? 'turn' : 'turns'}, ${(fix.trace ?? []).filter(event => event.type === 'tool_call').length} tool calls`);
  }
  if (fix.error) lines.push(`  error: ${fix.error}`);
  lines.push(`  results: ${fix.out}`);
  return lines.join('\n');
}
