/** Human-readable summaries of scans, issues, and the work done on them. */
import { filterKeys, isDesign, issuesOf, label, matchesFilters, SEVERITY_QUESTIONS, severityName } from './questions.js';

const short = revision => revision?.slice(0, 12) ?? '?';

/** Prose broken at `width` columns, each line indented; the note under a fix is the only paragraph perch prints. */
export function wrap(text, width = 92, indent = '  ') {
  const lines = [];
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (lines.length && (lines.at(-1) + ' ' + word).length <= width) lines[lines.length - 1] += ' ' + word;
    else lines.push(word);
  }
  return lines.map(line => indent + line);
}

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


/** What the severity bands came back as: "data or security 12%, normal use 71%, recoverable 64%". */
const severityDetail = severity => {
  const parts = Object.keys(SEVERITY_QUESTIONS).filter(key => severity?.[key] !== undefined)
    .map(key => `${label(key.replace('severe_', ''))} ${percent(severity[key])}`);
  return parts.length ? ` (${parts.join(', ')})` : severity?.score === undefined ? '' : ` (older reading, score ${severity.score.toFixed(2)})`;
};

/** A finding is closed once its fix was closed (nothing to do) or given up on. */
export const issueStatus = finding => (finding.fix && finding.fix.status !== 'ready' ? 'closed' : 'open');
/** The commit that fixed a finding, for the table, or `-`. */
const commitRef = finding => (finding.fix?.status === 'ready' ? finding.fix.commit?.slice(0, 7) ?? 'done' : '-');
const statusRow = finding => [issueStatus(finding), commitRef(finding)];
const issueCell = (finding, min) => issuesOf(finding, min).map(issue => issue.text).join(', ');
const locationOf = (finding, min) => `${finding.path}:${issuesOf(finding, min)[0]?.type === 'defect' ? finding.where.line : finding.line}`;

/** Aligned rows of methods with issues: everything the scan raised about each, defects and design alike. */
function issueTable(findings, min = 0.5) {
  // Severity is asked about a behavioral defect, so a method whose issues are all design or security has none to show.
  const rows = findings.map(finding => [finding.id, finding.name, locationOf(finding, min), issueCell(finding, min),
    issuesOf(finding, min).some(issue => issue.type === 'defect') ? severityName(finding.severity) : '-', ...statusRow(finding)]);
  return table(['ID', 'Method', 'Location', 'Issues', 'Severity', 'Status', 'Commit'], rows, ['left', 'left', 'left', 'left', 'left', 'left', 'left']);
}


/** What one scan did, then the open issues as `perch issues` lists them. */
export function formatScanRun(hunt, issues, shown = TOP) {
  return formatIssues(issues, 0.5, shown);
}

/** What a scan did, for stderr. */
export function scanCount(hunt) {
  const hunted = (hunt.visited ?? []).filter(visit => visit.status === 'hunted').length;
  const parts = [`${hunt.methods} methods`, `read ${hunted}`];
  if (hunt.skipped) parts.push(`${hunt.skipped} unchanged`);
  if (hunt.remaining) parts.push(`${hunt.remaining} unread`);
  if (hunt.error) parts.push(`error: ${hunt.error}`);
  return `${relative(hunt.target)} at ${hunt.revision?.slice(0, 7) ?? '?'}: ${parts.join(', ')}`;
}

/** "115 open issues, 10 shown (--all for the rest). 6 closed (--closed)." */

/** Findings to print: closed ones stay off the list unless asked for. */
export function visibleFindings(findings, { closed = false } = {}) {
  return closed ? findings : findings.filter(finding => issueStatus(finding) === 'open');
}

/** The table and nothing else. Counts and hints are progress, and go to stderr. */
export function formatIssues(findings, min, shown = TOP, { closed = false } = {}) {
  const rows = visibleFindings(findings, { closed });
  if (!rows.length) return 'Nothing matches.';
  return issueTable(rows.slice(0, shown), min).join('\n');
}

/** What `--filter` accepts, as a block a reader can copy from. */
export const formatFilterKeys = () => Object.entries(filterKeys()).map(([key, values]) => `${key}\n${values.map(value => `  ${value}`).join('\n')}`).join('\n\n');

/** Everything known about one method: System One's answers when it has read it, the metrics always, and the work done on it. */
export function formatFinding(finding) {
  const probabilities = object => Object.entries(object).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${words(key)} ${percent(value)}`).join(', ');
  const lines = [`${finding.id}  ${finding.name}  ${finding.path}:${finding.line}-${finding.end_line}  at commit ${finding.revision.slice(0, 7)}${finding.unread ? ' (not yet read by System One)' : ` read on ${finding.at.slice(0, 10)}`}`];
  lines.push(`Issues: ${issueCell(finding) || 'none at 50%'}`);
  if (finding.metrics) lines.push(`Metrics: risk ${number(finding.metrics.risk_score)}, maintainability ${number(finding.metrics.maintainability_index)}, complexity ${number(finding.metrics.cyclomatic_complexity)}, nesting ${number(finding.metrics.max_nesting)}, ${number(finding.metrics.sloc)} lines${finding.file ? `; file risk ${number(finding.file.risk_score)}` : ''}`);
  if (finding.has_bug !== undefined) {
    lines.push(`Defect: ${percent(finding.has_bug)}${finding.reachable === undefined ? '' : `; line reachable ${percent(finding.reachable)}`}. Points at line ${finding.where.line} (confidence ${percent(finding.where.confidence)}):`, `    ${finding.where.line}| ${finding.where.text ?? ''}`,
      `Kind: ${probabilities(finding.kinds ?? { [finding.kind.kind]: finding.kind.probability ?? 0 })}`, `Severity: ${severityName(finding.severity)}${severityDetail(finding.severity)}`);
    if (finding.securities) lines.push(`Exposed to outside input: ${percent(finding.exposed)}. Vulnerability: ${probabilities(finding.securities)}`);
  if (finding.does_what_it_claims !== undefined) lines.push(`Does what it claims: ${percent(finding.does_what_it_claims)}. Misdocumented: ${percent(finding.misdocumented)}. Refactor: ${probabilities(finding.refactor.probabilities ?? {})}`);
    if (finding.misuse?.length) lines.push(`Misuses a callee: ${finding.misuse.map(item => `${shortId(item.callee)} ${percent(item.probability)}`).join(', ')}`);
    if (finding.misused_by?.length) lines.push(`Misused by a caller: ${finding.misused_by.map(item => `${shortId(item.caller)} ${percent(item.probability)}`).join(', ')}`);
    if (finding.callees?.length) lines.push(`Calls: ${finding.callees.map(shortId).join(', ')}`);
    if (finding.callers?.length) lines.push(`Called by: ${finding.callers.map(shortId).join(', ')}`);
  }
  lines.push(`Status: ${issueStatus(finding)}`);
  const fix = finding.fix;
  if (fix?.status === 'ready') lines.push(`Fixed: ${fix.summary ?? ''}`.trimEnd(), ...(fix.notes ? wrap(fix.notes, 92, '    ') : []),
    `    before: ${(fix.before ?? []).map(issue => issue.text).join(', ') || '-'}`, `    after:  ${(fix.after ?? []).map(issue => issue.text).join(', ') || 'no issues'}`,
    `    commit ${fix.commit?.slice(0, 7) ?? '?'}${fix.branch ? ` on ${fix.branch}` : ''}  ${fix.patch_path}`);
  else if (fix?.status === 'closed') lines.push(`Closed on ${fix.at.slice(0, 10)}: ${fix.reason}`);
  else if (fix) lines.push(`No fix on ${fix.at.slice(0, 10)} after ${fix.attempts} model turns; last rejection: ${(fix.error ?? '').split('\n')[0]}`);
  return lines.join('\n');
}

/** What actually moved: "risk 84 -> 28, complexity 55 -> 9, 153 -> 41 lines". Numbers that did not change are left out. */
export function metricShift(before, after) {
  if (!before || !after) return '-';
  const parts = [];
  for (const [name, key] of [['risk', 'risk_score'], ['complexity', 'cyclomatic_complexity'], ['nesting', 'max_nesting']])
    if (number(before[key]) !== number(after[key])) parts.push(`${name} ${number(before[key])} -> ${number(after[key])}`);
  if (number(before.sloc) !== number(after.sloc)) parts.push(`${number(before.sloc)} -> ${number(after.sloc)} lines`);
  return parts.join(', ') || 'unchanged';
}

/** What one fix cost across every model it used. */
const spend = usage => {
  const entries = Object.values(usage ?? {});
  if (!entries.length || entries.some(entry => entry.cost === null || entry.cost === undefined)) return null;
  const total = entries.reduce((sum, entry) => sum + entry.cost, 0);
  return total < 0.01 ? `$${total.toFixed(4)}` : `$${total.toFixed(2)}`;
};

/** The batch: what was worked, then one line each. The full story for a fix was told as it ran. */
export function formatFixes(batch) {
  const stale = batch.stale ? ` ${batch.stale} ${batch.stale === 1 ? 'finding is' : 'findings are'} for methods that no longer exist under that name; scan again to see what replaced them.` : '';
  if (!batch.fixes.length) return `No open issues to work.${stale}`;
  const left = batch.remaining ? `, ${batch.remaining} left` : '';
  const committed = batch.fixes.filter(fix => fix.status === 'ready').length;
  const rows = batch.fixes.map(fix => [fix.finding_id ?? '?', shortId(fix.method ?? '?'),
    fix.status === 'ready' ? fix.commit?.slice(0, 7) ?? 'done' : fix.status,
    fix.status === 'ready' ? fix.summary ?? '' : fix.status === 'closed' ? fix.reason ?? '' : (fix.error ?? '').split('\n')[0]]);
  const lines = [`Worked ${batch.fixes.length} ${batch.fixes.length === 1 ? 'issue' : 'issues'} (budget ${batch.budget}${left}); ${committed} committed.${stale}`, '',
    ...table(['ID', 'Method', 'Result', 'What happened'], rows, ['left', 'left', 'left', 'left'])];
  if (batch.usage_lines?.length) lines.push('', 'Usage:', ...batch.usage_lines.map(line => `  ${line}`));
  return lines.join('\n');
}

/**
 * One fix, as a reviewer reads it: what was wrong, what the model wrote about the change, what measurably moved, and what proved it.
 * The note is the model's own two or three sentences; everything under it is measured, not claimed.
 */
export function formatFix(fix) {
  const where = `${fix.path ?? '?'}${fix.line ? `:${fix.line}` : ''}`;
  const outcome = fix.status === 'ready' ? `fixed in ${fix.commit?.slice(0, 7) ?? '?'} on ${fix.branch ?? '?'}` : fix.status === 'closed' ? 'closed, nothing to do' : 'no fix';
  const lines = [`${fix.finding_id ?? '?'}  ${shortId(fix.method ?? '?')}  ${where}  ${outcome}`, ''];
  const was = (fix.before ?? []).map(issue => issue.text).join(', ');
  if (fix.status === 'ready') {
    lines.push(`  Was    ${was || '-'}`, `  Now    ${(fix.after ?? []).map(issue => issue.text).join(', ') || 'clear'}`);
    if (fix.notes) lines.push('', ...wrap(fix.notes));
    // Only the numbers that moved: a defect fix often changes none, and printing "unchanged" twice says nothing.
    const rows = [];
    for (const [name, before, after] of [['Method', fix.method_before, fix.method_after], ['File', fix.file_before, fix.file_after]]) {
      const shift = before && after ? metricShift(before, after) : '-';
      if (shift !== 'unchanged' && shift !== '-') rows.push([name, shift]);
    }
    rows.push(['Tests', fix.checks?.length ? `${fix.checks.join(', ')} pass` : 'none reach this method']);
    const cost = spend(fix.usage);
    if (cost) rows.push(['Cost', cost]);
    lines.push('', ...rows.map(([name, text]) => `  ${name.padEnd(6)}  ${text}`));
  } else if (fix.status === 'closed') {
    lines.push(`  ${fix.reason ?? 'nothing to do'}`);
  } else {
    lines.push(`  Was    ${was || '-'}`, '', ...wrap(`After ${fix.turns ?? 0} ${fix.turns === 1 ? 'turn' : 'turns'} nothing passed every check. Last objection: ${(fix.error ?? 'unknown').split('\n')[0]}`));
    const cost = spend(fix.usage);
    if (cost) lines.push('', `  Cost    ${cost}`);
  }
  return lines.join('\n');
}
