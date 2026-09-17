/** Human-readable summaries of scans, issues, and the work done on them. */
import { filterKeys, issuesFor, issuesOf, label, SEVERITY_BANDS, severityName } from './questions.js';

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


/** What the score put on each band: "P1 62%, P2 24%, P0 9%, P3 5%". */
const severityDetail = severity => {
  const probabilities = severity?.probabilities;
  if (!probabilities) return '';
  const bands = Object.entries(probabilities).map(([level, p]) => [SEVERITY_BANDS[Number(level)] ?? level, p]).sort((a, b) => b[1] - a[1]);
  return ` (${bands.map(([band, p]) => `${band} ${percent(p)}`).join(', ')})`;
};

/** A finding is closed once its fix was closed (nothing to do) or given up on. */
export const issueStatus = finding => (finding.fix && finding.fix.status !== 'ready' ? 'closed' : 'open');
/** What was done to a finding, for the rows that have had anything done to them: the commit it was fixed in, or why it was not. */
const workedOn = finding => (!finding.fix ? '' : finding.fix.status === 'ready' ? finding.fix.commit?.slice(0, 7) ?? 'fixed' : finding.fix.status);
/** The three the model believes most. Everything it answered is in `perch issues <id>`; a row is not the place for a tail of 9%s. */
export const SHOWN_PER_ROW = 3;
/** Whatever fits, whole issues only, then a count of the rest. Cutting a row mid-percentage helps nobody. */
const issueCell = (issues, width = Infinity) => {
  const shown = [];
  for (const issue of issues.slice(0, SHOWN_PER_ROW)) {
    const rest = issues.length - shown.length - 1;
    const line = [...shown, issue.text, ...(rest > 0 ? [`+${rest} more`] : [])].join(', ');
    if (shown.length && line.length > width) break;
    shown.push(issue.text);
  }
  const left = issues.length - shown.length;
  return [...shown, ...(left > 0 ? [`+${left} more`] : [])].join(', ');
};
const locationOf = (finding, issues) => `${finding.path}:${issues[0]?.type === 'defect' ? finding.where.line : finding.line}`;
/** Cut to `width`, keeping the end: a path's file and line say more than the crates/ it starts with. */
const keepEnd = (text, width) => (text.length <= width ? text : '…' + text.slice(text.length - width + 1));
const keepStart = (text, width) => (text.length <= width ? text : text.slice(0, width - 1) + '…');

/** The width to lay a table out in: the terminal's, or 100 when there isn't one (a pipe, a file, a test). */
export const WIDTH = () => (process.stdout.columns >= 60 ? process.stdout.columns : 100);

/**
 * Aligned rows of methods with issues. A real repository has method names and paths long enough to wrap every row twice, so the
 * three columns that vary are given a share of whatever the terminal has and cut to it: the method from the end, the path from
 * the front (its file and line matter more than the crate it lives in), and the issues by dropping the weakest.
 */
function issueTable(findings, min = 0, filters = [], { width = WIDTH() } = {}) {
  const cells = findings.map(finding => {
    const issues = issuesFor(finding, min, filters);
    // Severity is asked about a behavioral defect, so a method whose issues are all design or security has none to show.
    return { id: finding.id, method: shortId(finding.name), location: locationOf(finding, issues), type: issues[0]?.type ?? '-', issues,
      severity: issues.some(issue => issue.type === 'defect') ? severityName(finding.severity) : '-', status: workedOn(finding) };
  });
  // Status is only a column when something has been worked. On a list where every row is open and unfixed it says nothing.
  const worked = cells.some(cell => cell.status);
  const header = ['ID', 'Method', 'Location', 'Type', 'Kind', 'Severity', ...(worked ? ['Status'] : [])];
  const longest = (key, floor) => Math.max(floor, ...cells.map(cell => String(cell[key]).length));
  // What the three variable columns have to share, once the id, the type, the severity and the gaps have taken theirs.
  const room = Math.max(34, width - 8 - longest('type', 4) - longest('severity', 8) - (worked ? longest('status', 6) : 0) - 2 * (header.length - 1));
  // The issues are the point of the row, so the other two take a quarter each at most and the rest is theirs.
  const method = Math.min(longest('method', 6), Math.max(10, Math.round(room * 0.25)));
  const location = Math.min(longest('location', 8), Math.max(12, Math.round(room * 0.25)));
  const kind = Math.max(12, room - method - location);
  const rows = cells.map(cell => [cell.id, keepStart(cell.method, method), keepEnd(cell.location, location), cell.type,
    keepStart(issueCell(cell.issues, kind), kind), cell.severity, ...(worked ? [cell.status] : [])]);
  // Every column a filter reads is named after it. Type is the class the row leads with, which is the one `--filter type=` ranks by.
  return table(header, rows, header.map(() => 'left'));
}


/** What one scan did, then the open issues as `perch issues` lists them. */
export function formatScanRun(hunt, issues, shown = TOP, min = 0) {
  return formatIssues(issues, min, shown);
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
export function formatIssues(findings, min, shown = TOP, { closed = false, filters = [], width = WIDTH() } = {}) {
  const rows = visibleFindings(findings, { closed });
  if (!rows.length) return 'Nothing matches.';
  return issueTable(rows.slice(0, shown), min, filters, { width }).join('\n');
}

/** "10 of 240 open, --all for the rest": how much of the list you are looking at. Context, so it goes to stderr under the table. */
export function issueCount({ open, matched, listed, closed = 0, filtered = false }) {
  const noun = total => `${total} open ${total === 1 ? 'issue' : 'issues'}`;
  const parts = [filtered ? `${matched} of ${noun(open)} match` : listed < open ? `${listed} of ${noun(open)}, --all for the rest` : noun(open)];
  if (closed) parts.push(`${closed} closed, --closed to include`);
  return parts.join('. ');
}

/** What `--filter` accepts, as a block a reader can copy from. */
export const formatFilterKeys = () => Object.entries(filterKeys()).map(([key, values]) => `${key}\n${values.map(value => `  ${value}`).join('\n')}`).join('\n\n');

/** Everything known about one method: System One's answers when it has read it, the metrics always, and the work done on it. */
export function formatFinding(finding) {
  const probabilities = object => Object.entries(object).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${words(key)} ${percent(value)}`).join(', ');
  const lines = [`${finding.id}  ${finding.name}  ${finding.path}:${finding.line}-${finding.end_line}  at commit ${finding.revision.slice(0, 7)}${finding.unread ? ' (not yet read by System One)' : ` read on ${finding.at.slice(0, 10)}`}`];
  lines.push(`Issues: ${issueCell(issuesOf(finding)) || 'none'}`);
  if (finding.metrics) lines.push(`Metrics: risk ${number(finding.metrics.risk_score)}, maintainability ${number(finding.metrics.maintainability_index)}, complexity ${number(finding.metrics.cyclomatic_complexity)}, nesting ${number(finding.metrics.max_nesting)}, ${number(finding.metrics.sloc)} lines${finding.file ? `; file risk ${number(finding.file.risk_score)}` : ''}`);
  if (finding.has_bug !== undefined) {
    lines.push(`Defect: ${percent(finding.has_bug)}. Points at line ${finding.where.line} (confidence ${percent(finding.where.confidence)}):`, `    ${finding.where.line}| ${finding.where.text ?? ''}`,
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
  if (!batch.fixes.length) return `No open issues to work.${stale}${batch.stopped ? ` Stopped: ${batch.stopped.split('\n')[0]}` : ''}`;
  const left = batch.remaining ? `, ${batch.remaining} left` : '';
  const committed = batch.fixes.filter(fix => fix.status === 'ready').length;
  const rows = batch.fixes.map(fix => [fix.finding_id ?? '?', shortId(fix.method ?? '?'),
    fix.status === 'ready' ? fix.commit?.slice(0, 7) ?? 'done' : fix.status,
    fix.status === 'ready' ? fix.summary ?? '' : fix.status === 'closed' ? fix.reason ?? '' : (fix.error ?? '').split('\n')[0]]);
  const lines = [`Worked ${batch.fixes.length} ${batch.fixes.length === 1 ? 'issue' : 'issues'} (budget ${batch.budget}${left}); ${committed} committed.${stale}${batch.stopped ? ` Stopped early: ${batch.stopped.split('\n')[0]}` : ''}`, '',
    ...table(['ID', 'Method', 'Result', 'What happened'], rows, ['left', 'left', 'left', 'left'])];
  if (batch.usage_lines?.length) lines.push('', 'Usage:', ...batch.usage_lines.map(line => `  ${line}`));
  return lines.join('\n');
}

/** The three the model believes most, the rest counted. */
const strongest = (issues = []) => {
  const shown = issues.slice(0, SHOWN_PER_ROW).map(issue => issue.text);
  return [...shown, ...(issues.length > shown.length ? [`+${issues.length - shown.length} more`] : [])].join(', ');
};

/**
 * What became of each objective. Printing the issues before and the issues after leaves the reader to diff two lists in their head;
 * the useful reading is which ones went, which ones are still there and by how much, and which ones the rewrite introduced.
 */
export function issueOutcome(before = [], after = []) {
  const byLabel = new Map(after.map(issue => [issue.label, issue]));
  const gone = before.filter(issue => !byLabel.has(issue.label));
  const left = before.filter(issue => byLabel.has(issue.label)).map(issue => ({ ...issue, now: byLabel.get(issue.label).probability }));
  const seen = new Set(before.map(issue => issue.label));
  return { gone, left, added: after.filter(issue => !seen.has(issue.label)) };
}

/**
 * One fix, as a reviewer reads it: what was wrong, what the model wrote about the change, what measurably moved, and what proved it.
 * The note is the model's own two or three sentences; everything under it is measured, not claimed.
 */
export function formatFix(fix) {
  const where = `${fix.path ?? '?'}${fix.line ? `:${fix.line}` : ''}`;
  const outcome = fix.status === 'ready' ? `fixed in ${fix.commit?.slice(0, 7) ?? '?'} on ${fix.branch ?? '?'}` : fix.status === 'closed' ? 'closed, nothing to do' : 'no fix';
  const lines = [`${fix.finding_id ?? '?'}  ${shortId(fix.method ?? '?')}  ${where}  ${outcome}`, ''];
  const was = strongest(fix.before);
  if (fix.status === 'ready') {
    if (fix.notes) lines.push(...wrap(fix.notes), '');
    const { gone, left, added } = issueOutcome(fix.before, fix.after);
    const rows = [];
    if (gone.length) rows.push(['Cleared', gone.map(issue => issue.text).join(', ')]);
    if (left.length) rows.push(['Left', left.map(issue => `${issue.label} ${percent(issue.probability)} -> ${percent(issue.now)}`).join(', ')]);
    if (added.length) rows.push(['Added', added.map(issue => issue.text).join(', ')]);
    if (!rows.length) rows.push(['Cleared', 'nothing the scan can see']);
    // Only the numbers that moved: a defect fix often changes none, and printing "unchanged" twice says nothing.
    for (const [name, before, after] of [['Method', fix.method_before, fix.method_after], ['File', fix.file_before, fix.file_after]]) {
      const shift = before && after ? metricShift(before, after) : '-';
      if (shift !== 'unchanged' && shift !== '-') rows.push([name, shift]);
    }
    rows.push(['Tests', fix.checks?.length ? `${fix.checks.join(', ')} pass` : 'none reach this method']);
    const cost = spend(fix.usage);
    if (cost) rows.push(['Cost', cost]);
    const width = Math.max(...rows.map(([name]) => name.length));
    lines.push(...rows.map(([name, text]) => `  ${name.padEnd(width)}  ${text}`));
  } else if (fix.status === 'closed') {
    lines.push(`  ${fix.reason ?? 'nothing to do'}`);
  } else {
    lines.push(`  Wanted  ${was || '-'}`, '', ...wrap(`After ${fix.turns ?? 0} ${fix.turns === 1 ? 'turn' : 'turns'} nothing passed every check. Last objection: ${(fix.error ?? 'unknown').split('\n')[0]}`));
    const cost = spend(fix.usage);
    if (cost) lines.push('', `  Cost    ${cost}`);
  }
  return lines.join('\n');
}
