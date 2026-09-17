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

/** Columns wide enough for their widest cell. Trailing space is trimmed so a row can be diffed and grepped. */
function table(header, rows, align) {
  const all = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...all.map(row => String(row[column]).length)));
  return all.map(row => row.map((cell, column) => align[column] === 'left' ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column])).join('  ').trimEnd());
}

const number = value => value === null || value === undefined ? '-' : Math.round(value);
/** Absolute paths push the columns that matter off the screen, so a path is said relative to where you are standing. */
const relative = path => (path === process.cwd() ? path.split('/').at(-1) : path.startsWith(process.cwd() + '/') ? path.slice(process.cwd().length + 1) : path);

const percent = value => `${Math.round(value * 100)}%`;
const words = label;
const shortId = id => id.split('::').at(-1);
const short = revision => (revision ?? '?').slice(0, 7);
export const TOP = 10;


/** The whole severity distribution, for `perch issues <id>`, where the argmax band alone would hide how close the call was. */
const severityDetail = severity => {
  const probabilities = severity?.probabilities;
  if (!probabilities) return '';
  const bands = Object.entries(probabilities).map(([level, p]) => [SEVERITY_BANDS[Number(level)] ?? level, p]).sort((a, b) => b[1] - a[1]);
  return ` (${bands.map(([band, p]) => `${band} ${percent(p)}`).join(', ')})`;
};

/** Closed covers both judgements: yours, when you set it aside, and the fixer's, when it gave up or found nothing to do. */
export const issueStatus = finding => (finding.dismissed || (finding.fix && finding.fix.status !== 'ready') ? 'closed' : 'open');
/** Empty for a finding nobody has touched, which is what keeps the Status column off a list where nothing has been worked. */
const workedOn = finding => (finding.dismissed ? 'dismissed' : !finding.fix ? '' : finding.fix.status === 'ready' ? finding.fix.commit?.slice(0, 7) ?? 'fixed' : finding.fix.status);
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


/** A scan ends by printing what `perch issues` would print, so the two never drift into showing the same findings differently. */
export function formatScanRun(hunt, issues, shown = TOP, min = 0) {
  return formatIssues(issues, min, shown);
}

/** What a scan did, for stderr. */
export function scanCount(hunt) {
  const hunted = (hunt.visited ?? []).filter(visit => visit.status === 'hunted').length;
  const parts = [`${hunt.methods} methods`, `read ${hunted}`];
  if (hunt.skipped) parts.push(`${hunt.skipped} unchanged`);
  if (hunt.remaining) parts.push(`${hunt.remaining} unread`);
  if (hunt.failed?.length) parts.push(`${hunt.failed.length} could not be read (perch doctor)`);
  if (hunt.error) parts.push(`error: ${hunt.error}`);
  return `${relative(hunt.target)} at commit ${hunt.revision?.slice(0, 7) ?? '?'}: ${parts.join(', ')}`;
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

/** "11-20 of 124 open issues match, --page 3 for the next": where you are in the list. Context, so it goes to stderr. */
export function issueCount({ open, matched, from = 0, listed, size = Infinity, closed = 0, filtered = false }) {
  const total = filtered ? matched : open;
  const noun = count => `${count} open ${count === 1 ? 'issue' : 'issues'}`;
  if (!listed && from) {
    const pages = Math.max(1, Math.ceil(total / size));
    return `page ${Math.floor(from / size) + 1} is past the end. ${noun(total)}${filtered ? ` match, out of ${open}` : ''}, ${pages} ${pages === 1 ? 'page' : 'pages'}`;
  }
  const all = listed === total && !from;
  const head = all ? noun(total) : `${from + 1}-${from + listed} of ${noun(total)}`;
  const parts = [filtered && total !== open ? `${head}${all ? ' match' : ' matching'}, out of ${open}` : head];
  if (from + listed < total) parts.push(Number.isFinite(size) ? `--page ${Math.floor(from / size) + 2} for the next` : '--all for the rest');
  if (closed) parts.push(`${closed} closed, --closed to include`);
  return parts.join('. ');
}

/**
 * What to send someone when their run went wrong. Versions, what the scan did, and every method it could not read with the
 * message it failed on. No source and no answers: a name, a path, and an error, which is what a bug report needs and all it needs.
 */
export function formatDoctor({ versions, scan, hunt, out, findings = 0 }) {
  const lines = [`perch ${versions.perch} on node ${versions.node} (${versions.platform})`, `results in ${relative(out)}`];
  if (scan) lines.push('', `scan ${scan.id} of ${relative(scan.target)} at commit ${short(scan.revision)}`,
    `  ${scan.files?.length ?? 0} files, ${scan.candidates?.length ?? 0} methods, ${scan.coverage?.excluded ?? 0} files excluded`);
  if (hunt) {
    const read = (hunt.visited ?? []).filter(visit => visit.status === 'hunted').length;
    lines.push('', `hunt ${hunt.id} ${hunt.status}${hunt.completed_at ? ` at ${hunt.completed_at.slice(0, 19)}` : ''}`,
      `  model ${hunt.model}, ${hunt.parallel} at a time${hunt.budget ? `, budget ${hunt.budget}` : ''}${hunt.force ? ', forced' : ''}`,
      `  ${hunt.methods} methods, read ${read}, ${hunt.skipped ?? 0} unchanged, ${hunt.remaining ?? 0} unread, ${hunt.failed?.length ?? 0} failed`,
      `  ${hunt.usage?.input_tokens ?? 0} tokens in / ${hunt.usage?.output_tokens ?? 0} out`);
    if (hunt.error) lines.push(`  the run stopped: ${hunt.error}`);
    const failed = hunt.failed ?? [];
    if (failed.length) {
      const byError = new Map();
      for (const item of failed) byError.set(item.error, [...(byError.get(item.error) ?? []), item]);
      lines.push('', `${failed.length} ${failed.length === 1 ? 'method' : 'methods'} could not be read:`);
      for (const [error, items] of [...byError].sort((a, b) => b[1].length - a[1].length)) {
        lines.push(`  ${items.length}x ${error}`);
        for (const item of items.slice(0, 5)) lines.push(`      ${item.name} at ${item.path}:${item.line}`);
        if (items.length > 5) lines.push(`      and ${items.length - 5} more`);
      }
    }
  }
  lines.push('', `${findings} open ${findings === 1 ? 'issue' : 'issues'}`);
  return lines.join('\n');
}

/**
 * One file's worth of lint, printed when that file is done. The percentage is the share of its checks that passed, so a clean file
 * reads 100% the way every other tool in a build reports itself. Under it, the checks that did not.
 */
export function formatLintFile({ path, checked, findings }) {
  const rate = checked ? Math.round(((checked - findings.length) / checked) * 100) : 100;
  const lines = [`${relative(path)}  ${rate}%  ${checked - findings.length} of ${checked} checks passed`];
  const width = Math.max(...findings.map(finding => String(finding.line).length), 1);
  for (const finding of findings) {
    lines.push(`  ${String(finding.line).padStart(width)}  ${finding.rule}${finding.name === finding.path ? '' : `  ${finding.name}`}${finding.cite ? `  cited: ${finding.cite}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * What a lint run adds up to. The rules that fired are spelled out underneath, because a rule name is an identifier and the
 * sentence it stands for is the actual complaint; printing that sentence against every row would drown the rows.
 */
export function formatLint(run, { width = WIDTH() } = {}) {
  const count = run.rules.length ?? run.rules;
  const passed = run.checked - run.findings.length;
  const rate = run.checked ? Math.round((passed / run.checked) * 100) : 100;
  if (!run.findings.length) return `${count} ${count === 1 ? 'rule' : 'rules'}, ${run.checked} checks, all passed`;
  const files = new Set(run.findings.map(finding => finding.path));
  const fired = run.rules.filter?.(rule => run.findings.some(finding => finding.rule === rule.name)) ?? [];
  const lines = [`${rate}%  ${passed} of ${run.checked} checks passed. ${run.findings.length} failed in ${files.size} ${files.size === 1 ? 'file' : 'files'}.`, ''];
  const label = Math.max(...fired.map(rule => rule.name.length), 0);
  for (const rule of fired) {
    const text = String(rule.ensure ?? rule.behaviour ?? '').replace(/\s+/g, ' ').trim();
    const body = wrap(text, Math.max(40, width - label - 6), '');
    lines.push(`  ${rule.name.padEnd(label)}  ${body[0] ?? ''}`.trimEnd());
    for (const line of body.slice(1)) lines.push(`  ${' '.repeat(label)}  ${line}`);
  }
  return lines.join('\n');
}

/** What `--filter` accepts, as a block a reader can copy from. */
export const formatFilterKeys = () => Object.entries(filterKeys()).map(([key, values]) => `${key}\n${values.map(value => `  ${value}`).join('\n')}`).join('\n\n');

/** The whole distribution for one method, since a row can only carry the top few and the shape of the rest is often the story. */
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
  if (finding.read) lines.push(`Read in ${finding.read.passes} passes to line ${finding.read.to_line} of ${finding.read.of_line}: the rest was too long to send`);
  lines.push(`Status: ${issueStatus(finding)}`);
  if (finding.dismissed) lines.push(`Dismissed on ${finding.dismissed.at.slice(0, 10)}${finding.dismissed.reason ? `: ${finding.dismissed.reason}` : ''}`);
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

/** One line per fix, because the full story of each was told as it ran and nobody wants it twice. */
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

/** A row is not the place for a tail of 9%s; everything answered is in `perch issues <id>`. */
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
 * A reviewer reads this instead of the diff, so the model's own words and the measured numbers are kept apart: the note is a
 * claim, and everything under it was observed by a tool perch ran.
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
