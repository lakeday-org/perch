/**
 * What `perch coverage` prints: a coverage report as tables, the problems under them, and the lines that go to stderr. Every number
 * here is read off the report it is given or counted from it. Nothing is worked out again, so the terminal, the HTML and the JSON
 * cannot disagree about what a run found.
 */
import { BELIEVED } from './questions.js';
import { bold, COLOR, dim, keepEnd, keepStart, percent, relative, sureness, table, TOP, WIDTH } from './report.js';

/** Every kind of problem a coverage report can list, and so everything `--filter kind=` accepts. */
export const COVERAGE_KINDS = ['untested', 'edge_case', 'redundant', 'checks_nothing', 'infra', 'unresolved'];

const plural = (count, noun, many = `${noun}s`) => `${count} ${count === 1 ? noun : many}`;
/** A 0..1 value as a whole percentage; null is a value nobody answered, which is a dash and not a zero. */
const ratio = value => (value === null || value === undefined ? '-' : percent(value));
const points = value => (value === null || value === undefined ? null : Math.round(value * 100));
/**
 * " (+4)" or " (-3)", and nothing when it did not move or either side is missing. Changes are taken between the whole numbers that
 * are printed, so the before, the after and the change always add up on the screen.
 */
const change = (before, after) => (before === null || after === null || before === undefined || after === undefined || before === after
  ? '' : ` (${after > before ? '+' : ''}${after - before})`);
const short = revision => String(revision ?? '?').slice(0, 7);
/** A measured part of a whole, `{ hit, total }`, as a percentage, or a dash when nothing was measured. */
const measuredShare = part => (part?.total ? percent(part.hit / part.total) : '-');
/** Lines or branches the tests kept ran, marked `est.` when any of it is from the call graph rather than per-test records. */
const effectiveShare = part => (part?.total ? `${percent(part.hit / part.total)}${part.basis === 'estimated' ? ' est.' : ''}` : '-');
/**
 * Branches as a coverage tool counts them, taken over all, when a report measured them; the same figure the HTML page shows.
 * Otherwise the average of each method's share, marked est. when any of it is Jev's estimate.
 */
const branchCell = totals => {
  if (totals.measured?.branches?.total) return measuredShare(totals.measured.branches);
  if (totals.exercised === null || totals.exercised === undefined) return '-';
  return `${percent(totals.exercised)}${totals.exercised_basis === 'measured' || totals.exercised_basis === 'static' ? '' : ' est.'}`;
};

/** Seconds as a person reads a test run's time: 350ms, 41.2s, 3m10s. */
export function duration(seconds) {
  if (seconds === null || seconds === undefined) return '-';
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
}

/**
 * `--filter kind=untested,redundant` as clauses. Coverage findings have one thing to filter on, the kind of problem, so any other key
 * is a mistake and says so with the list rather than filtering on nothing.
 */
export function parseCoverageFilters(text) {
  const filters = [];
  let key = null;
  for (const clause of String(text ?? '').split(',').map(part => part.trim()).filter(Boolean)) {
    const at = clause.indexOf('=');
    if (at !== -1) {
      key = clause.slice(0, at).trim().toLowerCase();
      if (key !== 'kind') throw new Error(`perch coverage filters on kind, not "${clause.slice(0, at).trim()}"; kind is one of ${COVERAGE_KINDS.join(', ')}`);
    }
    if (!key) throw new Error(`filter "${clause}" is written kind=<kind>; kind is one of ${COVERAGE_KINDS.join(', ')}`);
    const spelled = (at === -1 ? clause : clause.slice(at + 1)).trim();
    const value = spelled.toLowerCase().replace(/[\s-]+/g, '_');
    if (!COVERAGE_KINDS.includes(value)) throw new Error(`kind "${spelled}" is not one of ${COVERAGE_KINDS.join(', ')}`);
    filters.push({ key: 'kind', value });
  }
  return filters;
}

/**
 * The problems a run lists: sure enough to clear the floor, and of a kind the filter named. A finding with no probability is one
 * whose unit could not be asked, which no floor can judge, so it is listed with the failure. A run with --since lists only the
 * problems on methods and tests the branch changed, since those are the ones the branch is answerable for. This is what the exit
 * code counts.
 */
export function listedFindings(report, { min = BELIEVED, filters = [] } = {}) {
  const kinds = new Set(filters.filter(clause => clause.key === 'kind').map(clause => clause.value));
  const onBranch = report.branch ? new Set(report.branch.findings) : null;
  return (report.findings ?? []).filter(finding => (finding.probability === null || finding.probability >= min)
    && (!kinds.size || kinds.has(finding.kind)) && (!onBranch || onBranch.has(finding.id)));
}

/**
 * The top of the list, when it is cut to one. A fact from the call graph outranks any answer, and among answers the surer comes
 * first; ties go by where they are, so two runs over the same report cut in the same place.
 */
const ranked = findings => [...findings].sort((a, b) => (b.probability ?? 2) - (a.probability ?? 2)
  || String(a.path).localeCompare(String(b.path)) || (a.line ?? 0) - (b.line ?? 0));

/**
 * A table cut to the width it has. One column gives way, the one whose cells run longest, and the rest keep their widths: numbers
 * cut short are wrong numbers. `cut` says which end of that column to keep.
 */
function fitted(header, rows, align, { flex = 0, cut = keepEnd, width = WIDTH() } = {}) {
  const all = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...all.map(row => String(row[column]).length)));
  const others = widths.reduce((sum, value, column) => (column === flex ? sum : sum + value), 0) + 2 * (header.length - 1);
  const room = Math.max(String(header[flex]).length, 12, width - others);
  return table(header, rows.map(row => row.map((cell, column) => (column === flex ? cut(String(cell), room) : cell))), align);
}

/** A header dimmed and a total in bold, painted after padding so the escape codes are not counted as columns. */
const painted = (lines, color, total = false) => lines.map((line, index) => (index === 0 ? dim(line, color)
  : total && index === lines.length - 1 ? bold(line, color) : line));


function sourceTable(report, onList, { width, color }) {
  const files = (report.files ?? []).filter(file => file.kind === 'source' && file.totals?.methods)
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) return '';
  const header = ['Source files', 'Methods tested', 'Lines', 'Branches', 'Effective lines', 'Effective branches', 'Untested branches'];
  // Counted from the problems listed under the table, at the same floor, so the two agree.
  const gaps = onList.filter(finding => finding.kind === 'edge_case');
  const gapsIn = Map.groupBy(gaps, finding => finding.path);
  const untested = path => (path === null ? gaps.length : gapsIn.get(path)?.length ?? 0);
  const row = (name, totals, path) => [name, `${totals.reached} of ${totals.methods}`, measuredShare(totals.measured?.lines), branchCell(totals),
    effectiveShare(totals.effective?.lines), effectiveShare(totals.effective?.branches), untested(path)];
  const rows = files.map(file => row(relative(file.path), file.totals, file.path));
  rows.push(row('All source', report.totals ?? {}, null));
  return painted(fitted(header, rows, ['left', 'right', 'right', 'right', 'right', 'right', 'right'], { width }), color, true).join('\n');
}

function testTable(report, { width, color }) {
  const files = (report.files ?? []).filter(file => file.kind === 'test' && file.totals?.tests)
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) return '';
  // Quality is the tests worth keeping, of all of them; the next three are why the rest are not, or what they touch.
  // Time saved is what the duplicate tests and the tests that check nothing took, the time dropping them gives back.
  const header = ['Test files', 'Quality', 'Duplicates', 'Checks nothing', 'Live services', 'Time', 'Time saved'];
  const row = (name, totals) => [name, `${percent(totals.useful / totals.tests)} (${totals.useful} of ${totals.tests})`, totals.redundant, totals.weak, totals.infra,
    duration(totals.seconds), duration(totals.dropped_seconds || null)];
  const rows = files.map(file => row(relative(file.path), file.totals));
  rows.push(row('All tests', report.totals ?? {}));
  return painted(fitted(header, rows, ['left', 'right', 'right', 'right', 'right', 'right', 'right'], { width }), color, true).join('\n');
}

/**
 * The problems, one block per file and one line per problem, laid out the way `perch scan` lays out its own so the two read as one
 * tool. The note is the last column and the one that gives way to the terminal, since it is the longest and is a sentence the id
 * opens in full.
 */
function findingBlocks(findings, { width, color }) {
  const byFile = new Map();
  for (const finding of findings) {
    if (!byFile.has(finding.path)) byFile.set(finding.path, []);
    byFile.get(finding.path).push(finding);
  }
  const HEAD = ['ID', 'Line', 'Problem', 'Confidence', 'Test or method', 'Note'];
  const blocks = [];
  for (const path of [...byFile.keys()].sort()) {
    const rows = byFile.get(path).sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (b.probability ?? 2) - (a.probability ?? 2));
    const widest = (pick, floor) => Math.max(floor.length, ...rows.map(row => String(pick(row)).length));
    const ident = widest(row => row.id, HEAD[0]), at = widest(row => row.line ?? '', HEAD[1]), kind = widest(row => row.kind, HEAD[2]);
    const sure = widest(row => ratio(row.probability), HEAD[3]);
    // The name takes a share of what is left and the note the rest, so a long test name cannot push the sentence off the screen.
    const room = Math.max(24, width - 2 - ident - at - kind - sure - 10);
    const named = Math.min(widest(row => row.name, HEAD[4]), Math.max(HEAD[4].length, Math.round(room * 0.35)));
    const note = Math.max(12, room - named - 2);
    const lines = [bold(relative(path), color),
      dim(`  ${HEAD[0].padEnd(ident)}  ${HEAD[1].padStart(at)}  ${HEAD[2].padEnd(kind)}  ${HEAD[3].padStart(sure)}  ${HEAD[4].padEnd(named)}  ${HEAD[5]}`, color)];
    for (const row of rows) {
      // Padded before it is painted, for the same reason the scan's table is: an escape sequence has no width on the screen.
      const confidence = row.probability === null ? dim('-'.padStart(sure), color)
        : ' '.repeat(Math.max(0, sure - ratio(row.probability).length)) + sureness(row.probability, color);
      lines.push(`  ${row.id.padEnd(ident)}  ${dim(String(row.line ?? '').padStart(at), color)}  ${row.kind.padEnd(kind)}  ${confidence}  ${keepStart(String(row.name), named).padEnd(named)}  ${keepStart(String(row.note ?? ''), note)}`.trimEnd());
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * What --since puts first: each source file the branch changed, with how many lines it changed, how many of the changed lines that
 * are code ran, and that as a share, which is patch coverage. A file no coverage report covers has dashes, not zeros.
 */
function branchTable(report, { width, color }) {
  const branch = report.branch;
  if (!branch.files.length) return `No source files changed since ${branch.ref}.`;
  // Only the files with changed code the tests missed, most missed first, and ones no report covers; a file where every changed
  // line ran has nothing to look at.
  const missed = file => (file.patch ? file.patch.total - file.patch.hit : null);
  const listed = branch.files.filter(file => missed(file) !== 0).sort((a, b) => (missed(b) ?? -1) - (missed(a) ?? -1) || a.path.localeCompare(b.path));
  const header = [`Changed since ${branch.ref}`, 'Untested lines', 'Patch coverage'];
  const row = (name, count, patch) => [name, count === null ? 'not measured' : count, measuredShare(patch)];
  const rows = listed.map(file => row(relative(file.path), missed(file), file.patch));
  const total = branch.patch ? branch.patch.total - branch.patch.hit : null;
  rows.push(row('All changed source', total, branch.patch));
  return painted(fitted(header, rows, ['left', 'right', 'right'], { width }), color, true).join('\n');
}

/**
 * What a coverage run prints on stdout: the source files, the test files, then the problems grouped by file. An unasked-for list is
 * cut to the top ten; `--all` or a filter is the asking, and gets every one. With --since it is what the branch changed and the
 * problems in it instead, and the whole repository is one line on stderr.
 */
export function formatCoverage(report, { min = BELIEVED, filters = [], all = false, width = WIDTH(), color = COLOR() } = {}) {
  const listed = listedFindings(report, { min, filters });
  const shown = all || filters.length ? listed : ranked(listed).slice(0, TOP);
  if (report.branch) {
    const problems = shown.length ? findingBlocks(shown, { width, color }) : `No problems in code changed since ${report.branch.ref}.`;
    return [branchTable(report, { width, color }), problems].join('\n\n');
  }
  const parts = [sourceTable(report, listedFindings(report, { min }), { width, color }), testTable(report, { width, color }), findingBlocks(shown, { width, color })];
  const text = parts.filter(Boolean).join('\n\n');
  return text || 'No source files or tests found.';
}

/** A file's counts in the diff table: the number now and how it moved, or the number it had when it is gone. */
function diffCells(before, after) {
  const now = after ?? before;
  const moved = (key, show = value => value) => (after && before ? `${show(after[key])}${change(before[key], after[key])}` : show(now[key]));
  return [now.methods, moved('reached'), after && before ? `${ratio(after.exercised)}${change(points(before.exercised), points(after.exercised))}` : ratio(now.exercised),
    moved('tests'), moved('useful'), moved('redundant'), moved('weak')];
}

/**
 * What `--diff` adds: every file whose counts moved since the baseline, with the number now and the change beside it. Only files
 * the report says changed are listed, and a file that came or went says which.
 */
export function formatCoverageDiff(report, { width = WIDTH(), color = COLOR() } = {}) {
  const diff = report.diff;
  if (!diff) return '';
  const since = `Since ${short(diff.from?.revision)}`;
  if (!diff.files?.length) return `Nothing changed per file since ${short(diff.from?.revision)}.`;
  const header = [since, 'Methods', 'Reached', 'Branches', 'Tests', 'Keep', 'Redundant', 'Checks nothing', ''];
  const rows = [...diff.files].sort((a, b) => a.path.localeCompare(b.path)).map(file => [relative(file.path), ...diffCells(file.before, file.after),
    !file.before ? 'added' : !file.after ? 'removed' : '']);
  const totals = diff.totals ?? {};
  const pair = key => ({ before: totals[key]?.before ?? null, after: totals[key]?.after ?? null });
  const count = key => `${pair(key).after ?? '-'}${change(pair(key).before, pair(key).after)}`;
  rows.push(['All', pair('methods').after ?? '-', count('reached'),
    `${ratio(pair('exercised').after)}${change(points(pair('exercised').before), points(pair('exercised').after))}`,
    count('tests'), count('useful'), count('redundant'), count('weak'), '']);
  return painted(fitted(header, rows, ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left'], { width }), color, true).join('\n');
}

/**
 * The one line for stderr, the shape `perch scan` ends with: what was read at which commit, and how many problems, with how many
 * are on the screen and how to see the rest. On a branch, the problems are the ones in code it changed and the rest are counted
 * apart.
 */
export function coverageCount(report, { min = BELIEVED, filters = [], all = false } = {}) {
  const totals = report.totals ?? {};
  const listed = listedFindings(report, { min, filters }).length;
  const parts = [plural(totals.methods ?? 0, 'method'), plural(totals.tests ?? 0, 'test')];
  if (report.branch) {
    const others = listedFindings({ ...report, branch: null }, { min, filters }).length - listed;
    parts.push(`${plural(listed, 'problem')} in changed code${others ? `, ${others} elsewhere` : ''}`);
  } else parts.push(plural(listed, 'problem'));
  if (!all && !filters.length && listed > TOP) parts.push(`${TOP} shown, --all for the rest`);
  const failed = report.failed?.length ?? 0;
  if (failed) parts.push(`${failed} could not be asked (--json)`);
  // A config that would not load means every test the parser found was read instead, which changes what is counted.
  for (const framework of report.scope?.frameworks ?? []) if (framework.error) parts.push(`${framework.config} did not load (--verbose)`);
  return `${relative(report.target ?? report.root ?? '.')} at commit ${report.revision?.slice(0, 7) ?? '?'}: ${parts.join(', ')}`;
}

/**
 * What --verbose adds: how many files no framework covers, and what in the reports matched nothing here. Each is something to
 * check when a number looks wrong, and nothing to read on an ordinary run.
 */
export function coverageDetails(report) {
  const lines = [];
  if (report.scope?.left_out) lines.push(`${plural(report.scope.left_out, 'file')} no test framework covers left out`);
  for (const run of report.unmatched_runs ?? []) lines.push(`unmatched run in ${run.path}: ${run.classname ? `${run.classname} ` : ''}${run.name}`);
  for (const item of report.unmatched_paths ?? []) lines.push(`unmatched path in ${item.path}: ${item.reported}`);
  return lines;
}
