/**
 * What `perch coverage` prints: a coverage report as tables, the problems under them, and the lines that go to stderr. Every number
 * here is read off the report it is given or counted from it. Nothing is worked out again, so the terminal, the HTML and the JSON
 * cannot disagree about what a run found.
 */
import { BELIEVED } from './questions.js';
import { bold, COLOR, dim, keepEnd, keepStart, percent, relative, sureness, table, TOP, WIDTH } from './report.js';
import { methodAdvice } from './coverage-advice.js';

/** Every kind of problem a coverage report can list, and so everything `--filter kind=` accepts. */
export const COVERAGE_KINDS = ['survived', 'redundant', 'checks_nothing', 'mocked', 'infra'];

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
/** The mutation score, killed of every mutant, as a share and a count: `67% (4 of 6)`, or a dash for a file with no mutants. */
const scoreCell = totals => (totals.mutants ? `${percent(totals.killed / totals.mutants)} (${totals.killed} of ${totals.mutants})` : '-');

/**
 * `--filter kind=survived,redundant` as clauses. Coverage findings have one thing to filter on, the kind of problem, so any other key
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
  return report.findings.filter(finding => (finding.probability === null || finding.probability >= min)
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
  const score = totals => (totals.mutants ? totals.killed / totals.mutants : 1);
  // Worst first: the lowest score, then the most mutants no test reaches, then the path, so the files to work on head the table.
  const files = report.files.filter(file => file.kind === 'source' && file.totals.methods)
    .sort((a, b) => score(a.totals) - score(b.totals) || b.totals.no_coverage - a.totals.no_coverage || a.path.localeCompare(b.path));
  if (!files.length) return '';
  // The mutation score is the mutants some test failed against, of every mutant but the equivalent ones, the ones no test runs
  // included, as Stryker and PIT count it. Survived is counted from the problems listed under the table, at the same floor, so
  // the two agree; no coverage is the mutants on lines no test ran, which nothing was run or asked about.
  const header = ['Source files', 'Mutation score', 'Survived', 'No coverage'];
  const gaps = onList.filter(finding => finding.kind === 'survived');
  const gapsIn = Map.groupBy(gaps, finding => finding.path);
  const survived = path => (path === null ? gaps.length : gapsIn.get(path)?.length ?? 0);
  const row = (name, totals, path) => [name, scoreCell(totals), survived(path), totals.no_coverage];
  const rows = files.map(file => row(relative(file.path), file.totals, file.path));
  rows.push(row('All source', report.totals, null));
  return painted(fitted(header, rows, ['left', 'right', 'right', 'right'], { width }), color, true).join('\n');
}

/** The test files with something to fix, most first; the ones with nothing to fix are one line. */
function testTable(report, { width, color }) {
  const all = report.files.filter(file => file.kind === 'test' && file.totals.tests);
  if (!all.length) return '';
  const toFix = totals => totals.tests - totals.useful + totals.infra;
  const files = all.filter(file => toFix(file.totals)).sort((a, b) => toFix(b.totals) - toFix(a.totals) || a.path.localeCompare(b.path));
  const fine = all.length - files.length;
  const nothing = fine ? `${fine === all.length ? 'All ' : ''}${plural(fine, 'test file has', 'test files have')} nothing to fix.` : '';
  if (!files.length) return nothing;
  // Quality is the tests worth keeping, of all of them; the next three are why the rest are not, or what they touch.
  const header = ['Test files', 'Quality', 'Duplicates', 'Checks nothing', 'Live services'];
  const row = (name, totals) => [name, `${percent(totals.useful / totals.tests)} (${totals.useful} of ${totals.tests})`, totals.redundant, totals.weak, totals.infra];
  const rows = files.map(file => row(relative(file.path), file.totals));
  rows.push(row('All tests', report.totals));
  return [painted(fitted(header, rows, ['left', 'right', 'right', 'right', 'right'], { width }), color, true).join('\n'), nothing].filter(Boolean).join('\n');
}

/** Text wrapped at a width, each line indented, for a sentence that has to be read whole. */
function wrapped(text, width, indent) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map(part => `${indent}${part}`);
}

/**
 * The methods to add a test to, most survived mutants first: a line of numbers for each, the way a scan lists a method, and under
 * it the test to add, from its surest survived mutant, written out whole. A tie goes to the method fewer tests reach, then to the
 * file and line. The survived mutants themselves, with the ids `perch close` takes, are listed by file with --all.
 */
function methodBlock(report, findings, { width, color, all }) {
  const survived = findings.filter(finding => finding.kind === 'survived');
  if (!survived.length) return '';
  const methods = new Map(report.methods.map(method => [method.id, method]));
  const entries = [...Map.groupBy(survived, finding => finding.unit)].map(([id, list]) => ({ method: methods.get(id),
    list: [...list].sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0) || (a.line ?? 0) - (b.line ?? 0)) }))
    .filter(entry => entry.method)
    .sort((a, b) => b.list.length - a.list.length || testsOf(a.method) - testsOf(b.method) || a.method.path.localeCompare(b.method.path) || a.method.line - b.method.line);
  const shown = all ? entries : entries.slice(0, TOP);
  const HEAD = ['Method', 'Where', 'Killed', 'Survived', 'Tests'];
  const rows = shown.map(({ method, list }) => ({ cells: [method.name, `${relative(method.path)}:${method.line}`, `${method.killed} of ${method.mutants.length - method.equivalent - method.invalid}`, String(list.length), String(testsOf(method))],
    advice: methodAdvice(list.map(finding => method.mutants.find(mutant => mutant.id === finding.mutant)).filter(Boolean)) }));
  const widths = HEAD.map((name, column) => Math.max(name.length, ...rows.map(row => row.cells[column].length)));
  const pad = (cells, aligns) => cells.map((cell, column) => (aligns[column] === 'right' ? cell.padStart(widths[column]) : cell.padEnd(widths[column]))).join('  ').trimEnd();
  const aligns = ['left', 'left', 'right', 'right', 'right'];
  const lines = [bold('Where to add tests', color), dim(`  ${pad(HEAD, aligns)}`, color)];
  for (const row of rows) lines.push(`  ${pad(row.cells, aligns)}`, ...wrapped(row.advice, Math.max(40, width - 4), '    '));
  return lines.join('\n');
}

/** The tests run against a method's mutants: the ones that ran its lines and passed before anything was changed. */
const testsOf = method => method.asked_tests;

/** How many methods have a survived mutant among the findings. */
const methodsWithSurvivors = findings => new Set(findings.filter(finding => finding.kind === 'survived').map(finding => finding.unit)).size;

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
 * What a coverage run prints on stdout: the source files worst first, the test files with something to fix, the methods to add a
 * test to, then the test problems by file. An unasked-for list is cut to the top ten; `--all` or a filter is the asking, and gets
 * every method and every survived mutant with its id. With --since it is what the branch changed and the problems in it instead,
 * and the whole repository is one line on stderr.
 */
export function formatCoverage(report, { min = BELIEVED, filters = [], all = false, width = WIDTH(), color = COLOR() } = {}) {
  const listed = listedFindings(report, { min, filters });
  const every = all || filters.length > 0;
  const others = listed.filter(finding => finding.kind !== 'survived');
  const blocks = [methodBlock(report, listed, { width, color, all: every }),
    findingBlocks(every ? [...others, ...listed.filter(finding => finding.kind === 'survived')] : ranked(others).slice(0, TOP), { width, color })];
  if (report.branch) return listed.length ? blocks.filter(Boolean).join('\n\n') : `No problems in code changed since ${report.branch.ref}.`;
  const parts = [sourceTable(report, listedFindings(report, { min }), { width, color }), testTable(report, { width, color }), ...blocks];
  const text = parts.filter(Boolean).join('\n\n');
  return text || 'No source files or tests found.';
}

/** A file's counts in the diff table: the number now and how it moved, or the number it had when it is gone. */
function diffCells(before, after) {
  const now = after ?? before;
  const moved = (key, show = value => value) => (after && before ? `${show(after[key])}${change(before[key], after[key])}` : show(now[key]));
  return [moved('mutants'), after && before ? `${ratio(after.score)}${change(points(before.score), points(after.score))}` : ratio(now.score), moved('no_coverage'),
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
  const header = [since, 'Mutants', 'Mutation score', 'No coverage', 'Tests', 'Keep', 'Redundant', 'Checks nothing', ''];
  const rows = [...diff.files].sort((a, b) => a.path.localeCompare(b.path)).map(file => [relative(file.path), ...diffCells(file.before, file.after),
    !file.before ? 'added' : !file.after ? 'removed' : '']);
  const totals = diff.totals;
  const pair = key => ({ before: totals[key]?.before ?? null, after: totals[key]?.after ?? null });
  const count = key => `${pair(key).after ?? '-'}${change(pair(key).before, pair(key).after)}`;
  rows.push(['All', count('mutants'),
    `${ratio(pair('score').after)}${change(points(pair('score').before), points(pair('score').after))}`, count('no_coverage'),
    count('tests'), count('useful'), count('redundant'), count('weak'), '']);
  return painted(fitted(header, rows, ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left'], { width }), color, true).join('\n');
}

/**
 * The one line for stderr, the shape `perch scan` ends with: what was read at which commit, and how many problems, with how many
 * are on the screen and how to see the rest. On a branch, the problems are the ones in code it changed and the rest are counted
 * apart.
 */
export function coverageCount(report, { min = BELIEVED, filters = [], all = false } = {}) {
  const totals = report.totals;
  const listed = listedFindings(report, { min, filters }).length;
  const parts = [plural(totals.methods ?? 0, 'method'), plural(totals.tests ?? 0, 'test')];
  if (report.branch) {
    const others = listedFindings({ ...report, branch: null }, { min, filters }).length - listed;
    parts.push(`${plural(listed, 'problem')} in changed code${others ? `, ${others} elsewhere` : ''}`);
  } else parts.push(plural(listed, 'problem'));
  // Without --all, the methods past the top ten and every survived mutant's id are off the screen.
  const survived = listedFindings(report, { min, filters }), methods = methodsWithSurvivors(survived);
  if (!all && !filters.length && methods > TOP) parts.push(`${TOP} of ${plural(methods, 'method')} shown, --all for the rest`);
  else if (!all && !filters.length && (methods || survived.length - methods > TOP)) parts.push('--all for every mutant');
  const failed = report.failed.length;
  if (failed) parts.push(`${failed} could not be asked (--json)`);
  // A config that would not load means every test the parser found was read instead, which changes what is counted.
  for (const framework of report.scope?.frameworks ?? []) if (framework.error) parts.push(`${framework.config} did not load (--verbose)`);
  return `${relative(report.target ?? report.root ?? '.')} at commit ${report.revision?.slice(0, 7) ?? '?'}: ${parts.join(', ')}`;
}

/** What --verbose adds: how many files no framework covers, something to check when a number looks wrong. */
export function coverageDetails(report) {
  return report.scope?.left_out ? [`${plural(report.scope.left_out, 'file')} no test framework covers left out`] : [];
}
