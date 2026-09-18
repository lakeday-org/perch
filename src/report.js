/** Human-readable summaries of scans, issues, and the work done on them. */
import { join } from 'node:path';
import { RULES_FILE } from './units.js';
import { CORRECTNESS, labelsRaised, questionSet } from './ask.js';
import { alsoKnownAs, filterKeys, issuesFor, issuesOf, label, securities, SEVERITY_BANDS, severityName } from './questions.js';

/** Prose broken at `width` columns, each line indented; what a rule asked is the only paragraph perch prints. */
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



/** Closed is a judgement you made: every kind the issue was listing is one you set aside. */
export const issueStatus = finding => (finding.dismissed ? 'closed' : 'open');
/** Empty for a finding nobody has touched, which is what keeps the Status column off a list where nothing has been decided. */
const workedOn = finding => (finding.dismissed ? 'dismissed' : '');
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
/** A defect points at a line inside the method; everything else points at the method. A reading with no line located falls back
 * to the method's own, rather than throwing in the one place a person is looking at a list of what is wrong. */
const locationOf = (finding, issues) => `${finding.path}:${issues[0]?.type === 'defect' ? finding.where?.line ?? finding.line : finding.line}`;
/** Cut to `width`, keeping the end: a path's file and line say more than the crates/ it starts with. */
const keepEnd = (text, width) => (text.length <= width ? text : '…' + text.slice(text.length - width + 1));
const keepStart = (text, width) => (text.length <= width ? text : text.slice(0, width - 1) + '…');

/** The width to lay a table out in: the terminal's, or 100 when there isn't one (a pipe, a file, a test). */
export const WIDTH = () => (process.stdout.columns >= 60 ? process.stdout.columns : 100);

/**
 * Color, when there is a terminal to put it on. Piped output and NO_COLOR get none, so a redirect stays greppable and a log stays
 * readable. Padding happens before this is applied: escape codes have width nobody wants counted.
 */
let colored = false;
/**
 * Whether to paint. Told once by the command line rather than worked out here: what a terminal is and what NO_COLOR means are
 * the command line's business, and a formatter that reads the environment cannot be asked for plain text in a test.
 */
export const useColor = on => { colored = Boolean(on); };
export const COLOR = () => colored;
const paint = code => (text, on = COLOR()) => (on ? `\u001b[${code}m${text}\u001b[0m` : String(text));
export const bold = paint(1), dim = paint(2), red = paint(31), yellow = paint(33);
/** How sure, colored by how sure: the ones worth reading first look like it. */
export const sureness = (value, on) => (value >= 0.9 ? red(percent(value), on) : value >= 0.7 ? yellow(percent(value), on) : dim(percent(value), on));

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
      // The rubric is about the harm a caller would feel, which is what a vulnerability is ranked by too. Showing it only on a
      // defect was the list disagreeing with its own ordering.
      severity: issues.some(issue => CORRECTNESS.has(issue.type)) ? severityName(finding.severity) : '-', status: workedOn(finding) };
  });
  // Status is only a column when something has been set aside, which is only ever a --closed listing.
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


/**
 * What a scan prints: every file it had something to say about, and under it one line per problem. A run over a repository is a
 * run over a repository, so it reads the way every other tool that does that reads — the file, the line in it, how bad, and what
 * is wrong. Which method a line belongs to is the last column, the way a linter puts the rule it broke last.
 *
 * One line per problem, not per method: a method carrying five is five things to fix. `perch issues` is where a method is taken
 * as a whole and ranked against the others.
 */
/** The block a search rule's answer is listed under. Not a path, so it is not made relative to one. */
const SEARCHED = 'searched the repository';

export function formatScanReport(findings, { min = 0, width = WIDTH(), color = COLOR(), filters = [], summary = true, empty = 'Nothing to report.' } = {}) {
  const byFile = new Map();
  for (const finding of findings) {
    // A search is not about a file. It is recorded against the rule file so `perch issues` has a place to point at, and it gets
    // its own block here rather than a header that reads like a scanned file. Dropping it was worse: the tally and the exit code
    // read this, so a broken search rule was reported nowhere and failed nothing.
    const searched = String(finding.unit ?? '').startsWith('search:');
    const issues = shownIssues(finding, min, filters);
    if (!issues.length) continue;
    const line = issues[0]?.type === 'defect' ? finding.where?.line ?? finding.line : finding.line;
    const under = searched ? SEARCHED : finding.path;
    if (!byFile.has(under)) byFile.set(under, []);
    // A band is about a defect the method might have, so it is said on the rows that are about one and left off the rest.
    for (const issue of issues) byFile.get(under).push({ id: finding.id, line, type: issue.type, said: issue.label, sure: issue.probability,
      name: shortId(finding.name), severity: CORRECTNESS.has(issue.type) ? severityName(finding.severity) : '-' });
  }
  if (!byFile.size) return empty;

  // The id is on every row rather than once per method, so any row you are looking at is one you can act on without hunting up
  // the block for it: `perch issues <id>` opens it, and `perch close <id> --kind <problem>` sets that one problem aside.
  // How sure is its own column rather than a suffix on the problem: it is the number you sort by, argue with, and set a floor
  // against, and reading it means finding it in the same place on every row.
  const HEAD = ['ID', 'Line', 'Severity', 'Type', 'Confidence', 'Problem', 'Method'];
  const blocks = [];
  const paths = [...byFile.keys()].filter(key => key !== SEARCHED).sort();
  for (const path of [...paths, ...(byFile.has(SEARCHED) ? [SEARCHED] : [])]) {
    const rows = byFile.get(path).sort((a, b) => a.line - b.line || b.sure - a.sure);
    const widest = pick => Math.max(...rows.map(row => String(pick(row)).length));
    const ident = Math.max(HEAD[0].length, widest(row => row.id));
    const at = Math.max(HEAD[1].length, widest(row => row.line));
    const band = Math.max(HEAD[2].length, widest(row => row.severity));
    const type = Math.max(HEAD[3].length, widest(row => row.type));
    const sure = Math.max(HEAD[4].length, widest(row => percent(row.sure)));
    const said = Math.max(HEAD[5].length, widest(row => row.said));
    const named = Math.max(HEAD[6].length, Math.min(widest(row => row.name), Math.max(8, width - ident - at - band - type - sure - said - 14)));
    // Padded before it is painted: an escape sequence is not a column of anything, and counting it as one bends every row after.
    const lines = [bold(path === SEARCHED ? SEARCHED : relative(path), color),
      dim(`  ${HEAD[0].padEnd(ident)}  ${HEAD[1].padStart(at)}  ${HEAD[2].padEnd(band)}  ${HEAD[3].padEnd(type)}  ${HEAD[4].padStart(sure)}  ${HEAD[5].padEnd(said)}  ${HEAD[6]}`, color)];
    for (const row of rows) {
      const severity = row.severity.padEnd(band);
      lines.push(`  ${row.id.padEnd(ident)}  ${dim(String(row.line).padStart(at), color)}  ${row.severity === '-' ? dim(severity, color) : severity}  ${row.type.padEnd(type)}  ${sureness(row.sure, color).padStart(sure + (color ? 9 : 0))}  ${row.said.padEnd(said)}  ${dim(keepStart(row.name, named), color)}`.trimEnd());
    }
    blocks.push(lines.join('\n'));
  }
  return (summary ? [...blocks, scanTally(findings, min, color)] : blocks).join('\n\n');
}

/**
 * What fails the scan: every issue from a question that gates, above its own floor. A defect, a vulnerability and a broken rule
 * all say something is wrong; a method being large or undocumented does not. Where the question came from has nothing to do with
 * it, so perch's own and yours are read the same way.
 */
export function gating(findings, min = 0, questions = questionSet()) {
  const fails = failing(questions);
  return findings.flatMap(finding => shownIssues(finding, min).filter(issue => fails(issue))
    .map(issue => ({ ...issue, id: finding.id, path: finding.path, line: finding.line, name: finding.name })));
}

/**
 * Whether one issue fails the run. The question that raised it says so and travels on the issue as `from`. A finding read back
 * off a scan written by an older perch has no `from`, so the labels that question could have raised stand in for it.
 */
function failing(questions = questionSet()) {
  const gated = new Set(questions.filter(question => question.gate).map(question => question.name));
  const labels = new Set(questions.filter(question => question.gate).flatMap(question => labelsRaised(question, questions)));
  return issue => (issue.from ? gated.has(issue.from) : labels.has(issue.label));
}

/** "✖ 41 problems in 18 places in 2 files", the line a run ends on. */
export function scanTally(findings, min = 0, color = COLOR(), filters = []) {
  const kept = findings.map(finding => ({ path: finding.path, issues: shownIssues(finding, min, filters) })).filter(item => item.issues.length);
  const count = kept.reduce((total, item) => total + item.issues.length, 0);
  const files = new Set(kept.map(item => item.path)).size;
  // A filtered run that matched nothing is not a clean repository. Saying "nothing to report" after reading 412 methods and
  // finding plenty outside the filter is the report lying about what the run did.
  if (!count) {
    if (!filters.length) return '✓ nothing to report';
    const all = findings.reduce((total, finding) => total + shownIssues(finding, min).length, 0);
    const clause = filters.map(filter => `${filter.key}=${filter.value}`).join(', ');
    if (!all) return '✓ nothing to report';
    return `✓ nothing matching ${clause}, out of ${all} ${all === 1 ? 'problem' : 'problems'} found`;
  }
  // How many of them fail, since that is the number the exit code is: a run that says 24 problems and comes back 0 is a run
  // nobody can read. Everything else perch found is worth knowing and not worth stopping for.
  const fails = failing();
  const failed = kept.reduce((total, item) => total + item.issues.filter(fails).length, 0);
  // Two numbers, not three. How many problems and how many files they are in is what a person reads; how many methods carried
  // them is arithmetic nobody asked for.
  const where = `${count} ${count === 1 ? 'problem' : 'problems'} in ${files} ${files === 1 ? 'file' : 'files'}`;
  if (!failed) return `${yellow('!', color)} ${where}, none failing`;
  return `${red('✖', color)} ${where}, ${failed === count ? 'all' : failed} failing`;
}


/** What a run did, for stderr. */
export function scanCount(run) {
  const read = (run.visited ?? []).filter(visit => visit.status === 'read').length;
  const parts = [`${run.methods} methods`, `read ${read}`];
  if (run.carried) parts.push(`${run.carried} unchanged`);
  if (run.remaining) parts.push(`${run.remaining} unread`);
  if (run.failed?.length) parts.push(`${run.failed.length} could not be read (perch doctor)`);
  if (run.error) parts.push(`error: ${run.error}`);
  return `${relative(run.target)} at commit ${run.revision?.slice(0, 7) ?? '?'}: ${parts.join(', ')}`;
}

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
export function issueCount({ open, matched, from = 0, listed, size = Infinity, closed = 0, edited = 0, filtered = false }) {
  const total = filtered ? matched : open;
  const noun = count => `${count} open ${count === 1 ? 'issue' : 'issues'}`;
  if (!listed && from) {
    const pages = Math.max(1, Math.ceil(total / size));
    return `page ${Math.floor(from / size) + 1} is past the end. ${noun(total)}${filtered ? ` match, out of ${open}` : ''}, ${pages} ${pages === 1 ? 'page' : 'pages'}`;
  }
  const all = listed === total && !from;
  const head = all ? noun(total) : `${from + 1}-${from + listed} of ${noun(total)}`;
  // A method changed since the scan read it has no answers worth keeping, and the list is shorter for a reason worth naming.
  const since = edited ? ` ${edited} ${edited === 1 ? 'method' : 'methods'} changed since the scan, so ${edited === 1 ? 'it is' : 'they are'} not listed; perch scan reads ${edited === 1 ? 'it' : 'them'} again.` : '';
  const parts = [filtered && total !== open ? `${head}${all ? ' match' : ' matching'}, out of ${open}` : head];
  if (from + listed < total) parts.push(Number.isFinite(size) ? `--page ${Math.floor(from / size) + 2} for the next` : '--all for the rest');
  if (closed) parts.push(`${closed} closed, --closed to include`);
  return parts.join('. ') + since;
}

/** How long ago, in the largest unit that still says something. */
function since(at) {
  if (!at) return '';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/**
 * What to send when a run goes wrong: what it was doing, what it could not do, and the end of the log it wrote while doing it.
 * Facts in columns, not sentences: this is read to find the one line that explains a failure, and pasted into a bug report as it
 * stands. Everything here is a name, a path, a count or an error message, never source.
 */
export function formatDoctor({ versions, scan, run, out, checks = [], log = [], color = COLOR() }) {
  const lines = [`perch ${versions.perch}  node ${versions.node}  ${versions.platform}`];

  // Whether perch can run at all, first and always. A report about the last run is no use to someone who has never had one
  // because their key is missing: what they need is the sentence saying so and what to do.
  if (checks.length) {
    const named = Math.max(...checks.map(check => check.name.length));
    lines.push('', ...checks.map(check => `${check.ok ? '✓' : red('✗', color)} ${check.name.padEnd(named)}  ${check.found}`));
    const broken = checks.filter(check => !check.ok);
    if (broken.length) lines.push('', ...broken.map(check => `  ${check.name}: ${check.fix}`));
  }

  if (!run) return [...lines, '', 'No run yet. perch scan is what reads the code.'].join('\n');

  // Then what went wrong, and nothing else. What the run covered and which questions fired are the scan's own report; a person
  // opening doctor has something broken and wants the line that says so.
  const failed = run.failed ?? [];
  const where = relative(join(out, 'scan.log'));
  const ran = `${run.id?.slice(0, 8) ?? '?'}  ${run.status}  ${since(run.completed_at ?? run.created_at)}  ${short(run.revision)}`;
  lines.push('', ran);
  if (run.error) lines.push('', `${red('✗', color)} ${run.error}`);
  // A method the walk could not read is an error the report cannot show, because a finding was never written for it.
  if (failed.length) {
    const rows = failed.map(item => [item.name, `${relative(item.path)}:${item.line}`, item.error]);
    lines.push('', `${failed.length} could not be read`,
      ...table(['method', 'where', 'error'], rows, ['left', 'left', 'left']).map(line => `  ${line}`));
  }
  // The tree was parsed at one commit and read at another, so anything listed is about code that has moved since.
  const stale = scan && scan.revision !== run.revision;
  if (stale) lines.push('', `${red('✗', color)} parsed at ${short(scan.revision)}, read at ${short(run.revision)}; perch scan again`);
  if (log.length) lines.push('', where, ...log.map(line => `  ${line}`));
  else if (!run.error && !failed.length && !stale) lines.push('', `Nothing wrong. ${where} has the rest.`);
  return lines.join('\n');
}



/** One issue asked again: what it was, what it is now, and whether that is a fix. */
export function formatCheck(checked, { width = WIDTH(), color = COLOR() } = {}) {
  const head = `${relative(checked.path)}:${checked.line}  ${checked.name === checked.path ? '' : checked.name}`.trimEnd();
  // What was not asked is said out loud: a count of nothing reads as a clean bill of health for a method nothing was asked about.
  const unasked = checked.note ? `\n${dim(`The scan's questions were not asked: ${checked.note}.`, color)}` : '';
  // Said the same way whether or not anything broke, because a table on its own is a column of
  // percentages that could as easily mean the rule held.
  const asked = `${checked.checked} ${checked.checked === 1 ? 'check' : 'checks'}`;
  if (checked.clean) return `${head}\n${asked}, nothing to report.${unasked}`;

  const lines = [head, `${asked}, ${red(`${checked.broken.length} broken`, color)}.`];
  const rows = checked.broken.flatMap(item => {
    const said = wrap(String(item.said ?? '').replace(/\s+/g, ' ').trim(), Math.max(30, width - 34), '');
    return said.map((line, index) => [index ? '' : sureness(item.broken, color), index ? '' : item.rule, line]);
  });
  if (rows.length) lines.push('', ...table(['Confidence', 'Rule', 'Description'], rows, ['right', 'left', 'left']).map(line => `  ${line}`));
  // The scan's own questions are not rules and cannot be broken, so they are named rather than tabled beside them.
  if (checked.issues?.length) lines.push('', `  ${dim('Also raised:', color)} ${checked.issues.map(issue => issue.text).join(', ')}`);
  if (unasked) lines.push(unasked.trimStart());
  return lines.join('\n');
}

/**
 * Every question perch asks of this repository: the ones it ships with and the ones you wrote, in one list, because they are one
 * thing. `From` says which file to open, and a question this repository has turned off is listed as off rather than left out, so
 * what is asked and what is not are both answered here.
 */
export function formatRules(rules, { width = WIDTH(), own = new Set() } = {}) {
  if (!rules.length) return 'No questions. perch rules add <name> --ensure "..." --where "src/**/*.js" writes the first one.';
  // A question written out longhand rather than with `ensure` is listed under what it asks for, since that is what it is.
  // The floor is part of what a question asks for, so it is on the row rather than only in the file.
  const asks = rule => (rule.disabled ? 'off' : `${rule.kind ?? rule.type}${rule.min == null ? '' : ` >${rule.min}%`}`);
  const from = rule => (own.has(rule.name) ? RULES_FILE : 'builtin');
  // Whether an answer fails the run, which is the difference between a question you have to act on and one you can read later.
  const fails = rule => (rule.disabled ? '-' : rule.gate ? 'yes' : 'no');
  const named = Math.max(8, ...rules.map(rule => rule.name.length));
  const kind = Math.max(4, ...rules.map(rule => asks(rule).length));
  const source = Math.max(4, ...rules.map(rule => from(rule).length));
  const over = Math.max(4, ...rules.map(rule => String(rule.where ?? '').length));
  const room = Math.max(30, width - named - kind - source - over - 21);
  const rows = rules.flatMap(rule => {
    const said = wrap(String(rule.text ?? rule.ask ?? '').replace(/\s+/g, ' ').trim(), room, '');
    const lines = said.length ? said : [''];
    return lines.map((line, index) => [index ? '' : rule.name, index ? '' : from(rule), index ? '' : asks(rule),
      index ? '' : fails(rule), index ? '' : String(rule.where ?? ''), line]);
  });
  return table(['Question', 'From', 'Asks', 'Fails', 'Over', 'Description'], rows, ['left', 'left', 'left', 'left', 'left', 'left']).join('\n');
}

/** What `--filter` accepts, as a block a reader can copy from. */
/** What `--filter` accepts. A value that has another word for it says so, rather than leaving you to find out by being wrong. */
export const formatFilterKeys = (rules = []) => Object.entries(filterKeys(undefined, rules))
  .map(([key, values]) => `${key}\n${values.map(value => {
    const others = key === 'type' ? alsoKnownAs(value) : [];
    return `  ${value}${others.length ? ` (or ${others.join(', ')})` : ''}`;
  }).join('\n')}`).join('\n\n');

/**
 * The problems a listing shows for one finding. A filter narrows this to the problems it named, not just to the methods carrying
 * one of them, and a severity clause is about the method and has already kept or dropped it. Counted and printed from here both,
 * so the line that says how many there are is counting the ones on the screen.
 */
export function shownIssues(finding, min, filters = []) {
  // `rule` narrows to the one rule's issue, which is filed under the rule's own name, the same place `kind` looks.
  const named = filters.filter(clause => clause.key === 'type' || clause.key === 'kind' || clause.key === 'rule');
  return issuesOf(finding, min).filter(issue => !named.length
    || named.some(clause => (clause.key === 'type' ? issue.type : String(issue.label).toLowerCase().replace(/[_-]+/g, ' ')) === clause.value));
}

/** A distribution as a row: the ones worth reading, then a count of the tail. A list of sixteen percentages is not a reading. */
function spread(map, keep = 3) {
  const all = Object.entries(map ?? {}).sort((a, b) => b[1] - a[1]).filter(([, value]) => value > 0.005);
  const shown = all.slice(0, keep).map(([key, value]) => `${words(key)} ${percent(value)}`);
  return [...shown, ...(all.length > shown.length ? [`+${all.length - shown.length} more`] : [])].join('  ');
}

/**
 * One issue opened up. The same columns a run prints, so a row you picked out of a scan reads the same here with the working
 * shown under it: what was asked, what came back, and what it was asked over. Everything is a name, a number or a line of your
 * own code, laid out to be read down the page rather than across a sentence.
 */
export function formatFinding(finding, { width = WIDTH(), color = COLOR() } = {}) {
  const span = finding.end_line && finding.end_line !== finding.line ? `${finding.line}-${finding.end_line}` : finding.line;
  const when = finding.unread ? 'not read yet' : `read ${(finding.at ?? '').slice(0, 10)}`;
  const status = issueStatus(finding);
  const lines = [`${bold(finding.id, color)}  ${finding.name}  ${dim(`${relative(finding.path)}:${span}`, color)}`,
    dim([short(finding.revision), when, status].filter(Boolean).join('  '), color)];

  // What is wrong, in the columns a run prints it in, so the two listings read as one thing seen at two distances.
  const issues = issuesOf(finding);
  if (issues.length) {
    const rows = issues.map(issue => [percent(issue.probability), issue.type,
      CORRECTNESS.has(issue.type) ? severityName(finding.severity) : '-', words(issue.label)]);
    lines.push('', ...table(['Confidence', 'Type', 'Severity', 'Problem'], rows, ['right', 'left', 'left', 'left']).map(line => `  ${line}`));
  }

  // A broken rule is read by deciding whether to change the code, so what the rule wanted comes with the code it was asked about.
  if (finding.lint) {
    lines.push('', `  ${bold(finding.lint.rule, color)}  ${dim(`${percent(finding.lint.broken)} sure it is broken`, color)}`,
      ...wrap(finding.lint.said ?? '', Math.min(96, width - 4), '  '));
    if (finding.lint.source) lines.push('', finding.lint.source, ...(finding.lint.more ? [dim(`      ${finding.lint.more} more lines`, color)] : []));
    else if (finding.lint.text) lines.push('', `  ${dim(String(finding.line).padStart(5), color)}  ${finding.lint.text}`);
  }

  if (finding.has_bug !== undefined) {
    lines.push('', `  ${dim(String(finding.where?.line ?? finding.line).padStart(5), color)}  ${finding.where?.text ?? ''}`.trimEnd(),
      ...(finding.where ? [dim(`         the line it points at, ${percent(finding.where.confidence)} sure`, color)] : []));

    const said = [];
    const add = (name, value) => { if (value) said.push([name, value]); };
    add('Kind', spread(finding.kind?.probabilities));
    add('Severity', spread(Object.fromEntries(Object.entries(finding.severity?.probabilities ?? {}).map(([level, p]) => [SEVERITY_BANDS[Number(level)] ?? level, p])), 4));
    add('Exposed', finding.exposed === undefined ? '' : percent(finding.exposed));
    add('Vulnerability', spread(securities(finding)));
    add('Claims', finding.does_what_it_claims === undefined ? ''
      : `does what it claims ${percent(finding.does_what_it_claims)}  documented ${percent(finding.documented)}`);
    add('Refactor', spread(finding.refactor?.probabilities, 2));
    add('Calls', [...(finding.callees ?? []).map(shortId),
      ...(finding.misuse ?? []).filter(item => item.probability > 0.5).map(item => `misuses ${shortId(item.callee)} ${percent(item.probability)}`)].join('  '));
    add('Called by', [...(finding.callers ?? []).map(shortId),
      ...(finding.misused_by ?? []).filter(item => item.probability > 0.5).map(item => `misused by ${shortId(item.caller)} ${percent(item.probability)}`)].join('  '));
    if (finding.metrics) add('Code', `risk ${number(finding.metrics.risk_score)}  maintainability ${number(finding.metrics.maintainability_index)}  complexity ${number(finding.metrics.cyclomatic_complexity)}  nesting ${number(finding.metrics.max_nesting)}  ${number(finding.metrics.sloc)} lines`);
    const named = Math.max(...said.map(([name]) => name.length));
    lines.push('', ...said.map(([name, value]) => `  ${dim(name.padEnd(named), color)}  ${value}`));
  }

  // A method too long to send whole was read in part, which is worth saying rather than letting the answers read as the whole.
  if (finding.read) lines.push('', dim(`  Read in ${finding.read.passes} passes to line ${finding.read.to_line} of ${finding.read.of_line}; the rest was too long to send.`, color));
  if (finding.closed?.kinds?.length) lines.push('', `  ${dim('Closed', color)}  ${finding.closed.kinds.join(', ')}${finding.closed.at ? ` on ${finding.closed.at.slice(0, 10)}` : ''}${finding.closed.reason ? `, ${finding.closed.reason}` : ''}`);
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

