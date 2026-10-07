/**
 * The HTML coverage report. One file that opens from disk with nothing fetched, laid out like the coverage reports people already
 * read (a table of files, then each file's source tinted line by line), with what System One said written under the lines it is
 * about. Every number and sentence on the page is read off the report object; this module only lays them out.
 */
import { createHash } from 'node:crypto';
import { WORDMARK, WORDMARK_LIGHT } from './brand.js';

/** Source text and names come from the repository being read, so every one of them is escaped before it becomes markup. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ESCAPES[character]);

const percent = value => (value === null || value === undefined ? '–' : `${Math.round(value * 100)}%`);
const ratio = (part, whole) => (whole ? part / whole : null);
const short = revision => String(revision ?? '').slice(0, 7);
/** A label the report stores as an identifier (happy_path) is shown as the words it is made of. */
const words = label => String(label ?? '').replaceAll('_', ' ');
/** Each kind of problem by the name the page gives it. */
const PROBLEM_NAMES = {
  survived: 'Survived mutant', redundant: 'Duplicate test', checks_nothing: 'Checks nothing', mocked: 'Mocks what it tests', infra: 'Live service',
};
const problemName = kind => PROBLEM_NAMES[kind] ?? words(kind);
/** A saved report's ISO timestamp, to the minute. Seconds and milliseconds only make two dates harder to compare by eye. */
const when = stamp => String(stamp ?? '').replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');

/** A count of something as "n thing" or "n things". */
const counted = (count, one, many = `${one}s`) => `${escape(count)} ${count === 1 ? one : many}`;

/**
 * The colour a percentage is drawn in. The bands are the ones Istanbul draws, so a page that looks like a coverage report reads
 * like one too. They colour a number the report gave; they do not grade anything the number does not already say.
 */
const band = value => (value === null || value === undefined ? 'none' : value < 0.5 ? 'low' : value < 0.8 ? 'mid' : 'high');

/**
 * A link to a line of a file: a section of this page, or with `page`, the page of its own that file was written to. The path
 * goes through encodeURIComponent so a path with `&` or `#` in it is still one path when the page reads the hash back, and is
 * escaped again for the attribute it sits in.
 */
const linkTo = page => (path, line) => escape(`${page ? page(path) : ''}#file=${encodeURIComponent(path)}${line ? `&line=${line}` : ''}`);

/** The name a file's own page is written under in files/: flat, readable, and unique however long or odd the path. */
const pageName = path => `${path.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)}-${createHash('sha256').update(path).digest('hex').slice(0, 8)}.html`;

/** A test's name with the suites it sits in, the way the parser joins them for JavaScript. */
const testName = test => [...(Array.isArray(test.suite) ? test.suite : test.suite ? [test.suite] : []), test.name].join(' > ');

/**
 * A change as a phrase with its unit, "−8 methods" or "+3 pts", or nothing when there was none: a card lists what moved, and a
 * zero did not.
 */
function delta(before, after, { unit = '', points = false, better = 'up', show = null } = {}) {
  if (before === null || before === undefined || after === null || after === undefined) return '';
  const moved = points ? Math.round(after * 100) - Math.round(before * 100) : after - before;
  const size = show ? show(Math.abs(moved)) : String(Math.abs(moved));
  if (!moved || size === show?.(0)) return '';
  const good = better === 'up' ? moved > 0 : moved < 0;
  // A unit is written in the plural, and one of it is singular: "+1 method", "+2 methods". A unit that is not a noun stays.
  const noun = unit && Math.abs(moved) === 1 && /[^s]s$/.test(unit) ? unit.slice(0, -1) : unit;
  const label = points ? ' pts' : noun ? ` ${noun}` : '';
  return `<span class="delta ${good ? 'good' : 'bad'}">${moved > 0 ? '+' : '−'}${escape(size)}${label}</span>`;
}

/** A bar, its percentage and a count, in fixed columns so every row of a table lines up whatever it holds. */
const cell = (share, { inner = null, count = '' } = {}) => `<span class="cell">${bar(share, inner)}`
  + `<span class="${band(share)}-text pc">${percent(share)}</span><span class="muted ct">${count}</span></span>`;

/** A bar for a share, with a darker inner share when there is one (methods reached by a kept test inside methods reached). */
function bar(value, inner = null, tone = band(value)) {
  const width = share => Math.max(0, Math.min(100, Math.round((share ?? 0) * 100)));
  return `<span class="bar"><span class="fill ${tone}" style="width:${width(value)}%"></span>${inner === null ? '' : `<span class="fill inner ${tone}" style="width:${width(inner)}%"></span>`}</span>`;
}

/** The report's units by id, and each file's findings counted by kind, so every section reads them without searching. */
function lookups(report, page = null) {
  const methods = new Map(report.methods.map(method => [method.id, method]));
  const tests = new Map(report.tests.map(test => [test.id, test]));
  const findings = new Map(report.findings.map(finding => [finding.id, finding]));
  const counted = new Map(), inFile = new Map();
  for (const finding of report.findings) {
    if (!inFile.has(finding.path)) inFile.set(finding.path, []);
    inFile.get(finding.path).push(finding);
    if (!counted.has(finding.path)) counted.set(finding.path, {});
    const kinds = counted.get(finding.path);
    kinds[finding.kind] = (kinds[finding.kind] ?? 0) + 1;
  }
  const diffFiles = new Map((report.diff?.files ?? []).map(entry => [entry.path, entry]));
  return { methods, tests, findings, counted, diffFiles, kinds: path => counted.get(path) ?? {}, findingsIn: path => inFile.get(path) ?? [], href: linkTo(page), home: '' };
}

/** A link to a method or a test by id, named as the report names it. An id the report does not hold is shown as the id. */
function unitLink(id, index) {
  const unit = index.methods.get(id) ?? index.tests.get(id);
  if (!unit) return `<code>${escape(id)}</code>`;
  const name = index.tests.has(id) ? testName(unit) : unit.name;
  return `<a href="${index.href(unit.path, unit.line)}" title="${escape(`${unit.path}:${unit.line}`)}">${escape(name)}</a>`;
}

/** The run in one line: which repository, which commit, when, and which run it is compared with. The rest is under Run details. */
function header(report, home = '') {
  const diff = report.diff;
  const name = String(report.target ?? report.root ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  return `<header class="top"><div class="wrap"><a class="brand" href="${home}#view=summary" aria-label="perch coverage"><span class="logo-dark">${WORDMARK}</span><span class="logo-light">${WORDMARK_LIGHT}</span></a><span class="tag">coverage</span>`
    + `<span class="where"><b>${escape(name)}</b><code title="${escape(report.revision)}">${escape(short(report.revision))}</code>`
    + `<span class="muted">${escape(when(report.created_at))}</span>`
    + (diff ? `<span class="muted">compared with</span><code title="${escape(diff.from.revision)}">${escape(short(diff.from.revision))}</code>` : '')
    + '</span><button type="button" class="theme" data-theme-toggle title="Light or dark" aria-label="Switch between light and dark">'
    + '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg></button></div></header>';
}

/**
 * Four numbers, each linking to the view that breaks it down: how many methods have a test, the mutation score and how many
 * mutants survived, and how many tests are worth keeping.
 */
function headline(report) {
  const totals = report.totals, moved = report.diff?.totals ?? {};
  const was = metric => moved[metric]?.before, now = metric => moved[metric]?.after;
  // What moved since the compared run, with its unit, then which run; or that nothing did. A zero is not a change.
  const changed = parts => {
    if (!report.diff) return '';
    const shown = parts.filter(Boolean);
    const since = `since ${escape(short(report.diff.from.revision))}`;
    return `<div class="changes">${shown.length ? `${shown.join(' ')} <span class="since">${since}</span>` : `<span class="since">unchanged ${since}</span>`}</div>`;
  };
  const moving = (metric, unit, options = {}) => delta(was(metric), now(metric), { unit, ...options });
  const tile = (view, title, big, sub, extra = '', hint = '') => `<a class="card" href="#view=${view}"><div class="card-title"${hint ? ` title="${escape(hint)}"` : ''}>${title}</div><div class="big">${big}</div><div class="sub">${sub}</div>${extra}</a>`;
  const share = value => `<span class="${band(value)}-text">${percent(value)}</span>`;
  const tiles = [];
  const reached = ratio(totals.reached, totals.methods);
  tiles.push(tile('sources', 'Methods tested', share(reached), `${escape(totals.reached)} of ${escape(totals.methods)} have a test`,
    changed([moving('reached', 'methods')]) + bar(reached), `Methods a test calls, directly or within ${report.depth} calls, of all methods.`));
  // The mutation score, mutants killed of all mutants: the number a test suite is judged by, and the survivors are what to act on.
  if (totals.mutants) {
    const score = ratio(totals.killed, totals.mutants);
    tiles.push(tile('sources', 'Mutation score', share(score), `${escape(totals.killed)} of ${escape(totals.mutants)} mutants killed`,
      changed([moving('score', '', { points: true })]) + bar(score), 'Mutants some test is predicted to fail against, of every mutant in the methods tests reach. A mutant is one line changed: a comparison moved to its boundary, a condition negated, an operator swapped.'));
    tiles.push(tile('problems', 'Survived', `${escape(totals.survived)}<span class="of"> of ${escape(totals.mutants)}</span>`, 'mutants no test kills',
      changed([moving('survived', 'mutants', { better: 'down' })]), 'Mutants no test reaching the method is predicted to fail against, that would change what a caller sees. Each is listed with the edit and the tests that miss it.'));
  }
  const drop = totals.drop ?? { count: 0 };
  // The tests that repeat another or check nothing: the number a person acts on. More is worse, so the bar is toned by the
  // share that stays.
  const saving = drop.count ? `${counted(drop.count, 'test')} could go` : 'Every test is worth keeping';
  const cut = side => (moved.redundant?.[side] ?? null) === null || (moved.weak?.[side] ?? null) === null ? null : moved.redundant[side] + moved.weak[side];
  const going = ratio(drop.count, totals.tests);
  tiles.push(tile('tests', 'Redundant tests', `${escape(drop.count)}<span class="of"> of ${escape(totals.tests)}</span>`, saving,
    changed([delta(cut('before'), cut('after'), { unit: 'tests', better: 'down' })]) + bar(going, null, band(going === null ? null : 1 - going)),
    'The number of tests that are duplicates or check nothing, out of the total number of tests.'));
  return `<section class="cards">${tiles.join('')}</section>`;
}


/** Before → after for one number of a file or method, or a dash for the side the unit was not in. */
const fromTo = (before, after, show = value => escape(value)) =>
  `<span class="was">${before === null || before === undefined ? '—' : show(before)}</span> → <b>${after === null || after === undefined ? '—' : show(after)}</b>`;
/** Whether a method in the diff is reached, as a word. */
const reachedWord = reached => (reached ? 'yes' : 'no');

/** Changes since the compared report, per file, per method, per test and per finding, as the diff lists them. */
function changes(report, index) {
  const diff = report.diff;
  if (!diff) return '';
  const fileRows = diff.files.map(entry => {
    const before = entry.before ?? {}, after = entry.after ?? {};
    const name = entry.after ? `<a href="${index.href(entry.path)}">${escape(entry.path)}</a>` : escape(entry.path);
    return `<tr><td class="path">${name}</td><td>${fromTo(entry.before && before.methods, entry.after && after.methods)}</td>`
      + `<td>${fromTo(entry.before && before.reached, entry.after && after.reached)}</td>`
      + `<td>${fromTo(entry.before && before.score, entry.after && after.score, percent)}</td>`
      + `<td>${fromTo(entry.before && before.tests, entry.after && after.tests)}</td><td>${fromTo(entry.before && before.useful, entry.after && after.useful)}</td></tr>`;
  }).join('');
  const methodRows = diff.methods.map(entry => `<tr><td>${index.methods.has(entry.id) ? unitLink(entry.id, index) : escape(entry.name)}</td>`
    + `<td class="path">${escape(entry.path)}</td><td>${fromTo(entry.before?.reached, entry.after?.reached, reachedWord)}</td>`
    + `<td>${fromTo(entry.before && `${entry.before.killed}/${entry.before.mutants}`, entry.after && `${entry.after.killed}/${entry.after.mutants}`)}</td></tr>`).join('');
  const added = diff.tests.added.map(id => `<li>${unitLink(id, index)}</li>`).join('');
  const removed = diff.tests.removed.map(id => `<li><code>${escape(id)}</code></li>`).join('');
  const block = (title, count, body) => `<details class="change" ${count ? 'open' : ''}><summary><h3>${title}</h3><span class="count">${count}</span></summary>${body}</details>`;
  return view('changes', `Changes since <code>${escape(short(diff.from.revision))}</code>`, ''
    // Problems that went away are a count, not a list: nothing in the list asks for anything, and renaming or deleting code makes
    // every problem it had go away as well.
    + (diff.findings.fixed.length ? `${counted(diff.findings.fixed.length, 'problem')} from that run ${diff.findings.fixed.length === 1 ? 'is' : 'are'} gone.` : ''), '<section id="changes" class="panel">'
    + block('New problems', diff.findings.new.length, diff.findings.new.length ? actionTable(diff.findings.new, index) : '<p class="muted">None.</p>')
    + block('Files', diff.files.length, diff.files.length ? `<div class="scroll"><table class="grid"><thead><tr><th>File</th><th>Methods</th><th>Reached</th><th>Mutation score</th><th>Tests</th><th>Kept</th></tr></thead><tbody>${fileRows}</tbody></table></div>` : '<p class="muted">None.</p>')
    + block('Methods that moved', diff.methods.length, diff.methods.length ? `<div class="scroll"><table class="grid"><thead><tr><th>Method</th><th>File</th><th>Reached</th><th>Killed</th></tr></thead><tbody>${methodRows}</tbody></table></div>` : '<p class="muted">None.</p>')
    + block('Tests added', diff.tests.added.length, added ? `<ul class="ids">${added}</ul>` : '<p class="muted">None.</p>')
    + block('Tests removed', diff.tests.removed.length, removed ? `<ul class="ids">${removed}</ul>` : '<p class="muted">None.</p>')
    + '</section>');
}

/** The kinds of problem that say a test is not worth its keep. */
const WEAK = new Set(['checks_nothing', 'mocked']);

/**
 * What a problem is about and what perch found, for the rows and notes that show it: the test or method it is on, and one fact.
 * The fact is the report's; only the wording is fixed.
 */
function problemFacts(finding, index) {
  const method = index.methods.get(finding.unit), test = index.tests.get(finding.unit);
  const subject = escape(test ? testName(test) : method?.name ?? finding.name);
  let fact = escape(finding.note);
  if (finding.kind === 'redundant' && test?.redundant_with) fact = `Kills the same mutants as ${unitLink(test.redundant_with, index)}, and no others.`;
  return { subject, fact: `${fact}${unsure(finding.probability)}` };
}

/** One problem in a table row: its name and what it is on, where it is, and the fact, with its buttons. */
function actionCells(finding, index, fresh = false) {
  const { subject, fact } = problemFacts(finding, index);
  // Two lines at most for each, so a long test name or a long list of files does not make one row a screen tall.
  return `<td class="act"><span class="clamp">${fresh ? '<span class="new-badge">new</span>' : ''}<b>${escape(problemName(finding.kind))}</b> <span class="subject">${subject}</span></span>${acts()}</td>`
    + `<td class="path"><a href="${index.href(finding.path, finding.line)}">${escape(finding.path)}:${escape(finding.line)}</a></td><td class="why"><span class="clamp">${fact}</span></td>`;
}

/**
 * What can be done about one problem from the page: copy a prompt that tells a coding agent what to fix and where, or dismiss it.
 * The prompts are on the page once, and a button reads its problem's when pressed.
 */
const acts = () => '<div class="acts"><button type="button" data-copy>Copy prompt</button></div>';
/** Dismiss, as a close mark at the end of a problem's row or in the corner of its note. */
const dismissMark = '<button type="button" class="x" data-dismiss title="Dismiss" aria-label="Dismiss">×</button>';
/** A button in a list's heading that copies one prompt for every problem the list is showing. */
const copyAll = ' <button type="button" class="copy-all" data-copy-all>Copy prompt</button>';

/** Problems as a table of actions: do this, where, why. */
const actionTable = (findings, index) => `<div class="scroll"><table class="grid"><thead><tr><th>Problem</th><th>Where</th><th>Details</th><th class="x-cell"></th></tr></thead>`
  + `<tbody>${findings.map(finding => `<tr data-finding="${escape(finding.id)}">${actionCells(finding, index)}<td class="x-cell">${dismissMark}</td></tr>`).join('')}</tbody></table></div>`;

/**
 * A first review, in two short lists: the methods with a survived mutant, riskiest first, and the tests that could go or that
 * reach outside the process. Each is ranked by what it costs to leave, and shows a few rows
 * with a link to every one of them under All problems. The rankings are counted from the report; nothing is added to it. With
 * --since the same lists hold only the problems in code the branch changed.
 */
function actionsView(report, index) {
  const TOP = 8;
  const risk = id => index.methods.get(id)?.risk ?? 0;
  const onBranch = report.branch ? new Set(report.branch.findings) : null;
  const scoped = onBranch ? report.findings.filter(finding => onBranch.has(finding.id)) : report.findings;
  const changedOnly = onBranch ? '&amp;changed=1' : '';
  const all = (kinds, count) => `<a class="more" href="#view=problems&amp;kind=${kinds.join(',')}${changedOnly}">See all ${escape(count)} under All problems →</a>`;
  const table = (heads, rows) => `<div class="scroll"><table class="grid"><thead><tr>${heads}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const section = (title, lede, body, more) => (body
    ? `<section class="panel group"><div class="panel-head"><h3>${title}</h3>${lede ? `<p class="lede">${lede}</p>` : ''}</div>${body}${more ? `<div class="panel-foot">${more}</div>` : ''}</section>` : '');
  const of = kinds => scoped.filter(finding => kinds.includes(finding.kind));
  // What the changes since the compared run brought in is marked new and put first in its list: it is what the person reading
  // this is working on now. With --since, the lists are the branch's already, and nothing is marked.
  const fresh = new Set(report.branch ? [] : (report.diff?.findings?.new ?? []).map(finding => finding.id));
  const newFirst = (a, b) => Number(fresh.has(b.id)) - Number(fresh.has(a.id));

  // Survived mutants, one row per method, riskiest first.
  const missing = of(['survived']);
  const perMethod = new Map();
  for (const finding of missing) if (!perMethod.has(finding.unit)) perMethod.set(finding.unit, finding);
  const riskiest = [...perMethod.values()].sort((a, b) => newFirst(a, b) || risk(b.unit) - risk(a.unit) || a.path.localeCompare(b.path));
  const methodRows = riskiest.slice(0, TOP).map(finding => `<tr data-finding="${escape(finding.id)}">${actionCells(finding, index, fresh.has(finding.id))}`
    + `<td class="num">${escape(Math.round(risk(finding.unit)))}</td><td class="x-cell">${dismissMark}</td></tr>`);
  const methodsSection = section(`Survived mutants <span class="count">${escape(missing.length)}</span>${copyAll}`, '',
    methodRows.length ? table('<th>Problem</th><th>Where</th><th>Details</th><th class="num" title="How complex and hard to maintain the method is, 0 to 100.">Risk</th><th class="x-cell"></th>', methodRows) : '',
    missing.length > TOP ? all(['survived'], missing.length) : '');

  // Test problems: duplicates, tests that check nothing, and tests that call a live service, the surest first.
  const testKinds = ['redundant', ...WEAK, 'infra'];
  const testProblems = of(testKinds).sort((a, b) => newFirst(a, b) || (b.probability ?? 2) - (a.probability ?? 2) || a.path.localeCompare(b.path));
  const testRows = testProblems.slice(0, TOP).map(finding => `<tr data-finding="${escape(finding.id)}">${actionCells(finding, index, fresh.has(finding.id))}<td class="x-cell">${dismissMark}</td></tr>`);
  const testsSection = section(`Test problems <span class="count">${escape(testProblems.length)}</span>${copyAll}`, '',
    testRows.length ? table('<th>Problem</th><th>Where</th><th>Details</th><th class="x-cell"></th>', testRows) : '',
    testProblems.length > TOP ? all(testKinds, testProblems.length) : '');

  const lists = methodsSection + testsSection;
  if (report.branch) {
    const ref = escape(report.branch.ref);
    return view('summary', 'Summary', '',
      lists || `<p class="empty">No problems in code changed since ${ref}.</p>`);
  }
  return view('summary', 'Summary', '', lists || '<p class="empty">No problems.</p>');
}

/** One view of the summary: its title, one sentence saying what it shows, and its content. */
const view = (id, title, lede, body) => `<section class="view" data-view="${id}" id="view-${id}"><div class="view-head"><h2>${title}</h2>${lede ? `<p class="lede">${lede}</p>` : ''}</div>${body}</section>`;

/** A sortable header cell. `numeric` sorts by the cell's data-v rather than its text; a column of bars lines up on the left. */
const th = (name, numeric = true, bars = false, title = '') => `<th data-sort="${numeric ? 'number' : 'text'}"${bars ? ' class="bars"' : numeric ? ' class="num"' : ''}${title ? ` title="${escape(title)}"` : ''}>${name}</th>`;

/** The mutation score as a bar cell: killed over mutants, or nothing for a file with no mutants. */
const scoreCell = totals => (totals.mutants ? cell(totals.killed / totals.mutants, { count: `${escape(totals.killed)}/${escape(totals.mutants)}` }) : cell(null));
const scoreValue = totals => (totals.mutants ? totals.killed / totals.mutants : null);

/** The source files, lcov-report's shape: a row per file, worst first, bars for methods tested and the mutation score. */
function sourceTable(report, index) {
  const files = report.files.filter(file => file.kind === 'source');
  const worst = (a, b) => (scoreValue(a.totals) ?? 1) - (scoreValue(b.totals) ?? 1)
    || (ratio(a.totals.reached, a.totals.methods) ?? 1) - (ratio(b.totals.reached, b.totals.methods) ?? 1) || a.path.localeCompare(b.path);
  const rows = [...files].sort(worst).map(file => {
    // What changed in a file since the last run is the Changes view's to say; this table says where things stand.
    const totals = file.totals, survived = index.kinds(file.path).survived ?? 0;
    const reached = ratio(totals.reached, totals.methods);
    return `<tr data-path="${escape(file.path)}"><td class="path" data-v="${escape(file.path)}"><a href="${index.href(file.path)}">${escape(file.path)}</a></td>`
      + `<td class="bars" data-v="${reached ?? -1}">${cell(reached, { inner: ratio(totals.useful_reached, totals.methods), count: `${escape(totals.reached)}/${escape(totals.methods)}` })}</td>`
      + `<td class="bars" data-v="${scoreValue(totals) ?? -1}">${scoreCell(totals)}</td>`
      + `<td class="num${survived ? '' : ' zero'}" data-v="${survived}">${survived}</td></tr>`;
  }).join('');
  const totals = report.totals, reached = ratio(totals.reached, totals.methods);
  const foot = `<tr><td>All source files</td>`
    + `<td class="bars">${cell(reached, { inner: ratio(totals.useful_reached, totals.methods), count: `${escape(totals.reached)}/${escape(totals.methods)}` })}</td>`
    + `<td class="bars">${scoreCell(totals)}</td><td class="num">${escape(totals.survived)}</td></tr>`;
  const heads = th('File', false) + th('Methods tested', true, true, `Methods a test calls within ${report.depth} calls. The darker part is methods a test worth keeping reaches.`)
    + th('Mutation score', true, true, 'Mutants some test is predicted to fail against, of every mutant in the file\'s reached methods.')
    + th('Survived', true, false, 'Mutants no test kills, listed under All problems.');
  return view('sources', 'Source files', '',
    `<div class="filter"><input type="search" class="filter-files" placeholder="Filter files" aria-label="Filter files"></div>`
    + `<section class="panel" id="sources"><div class="scroll"><table class="grid sortable files"><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody><tfoot>${foot}</tfoot></table></div></section>`);
}

/** The test files: how many tests each has, how many are worth keeping, and why the rest are not. */
function testTable(report, index) {
  const files = report.files.filter(file => file.kind === 'test');
  const notKept = file => file.totals.tests - file.totals.useful;
  const rows = [...files].sort((a, b) => notKept(b) - notKept(a) || a.path.localeCompare(b.path)).map(file => {
    const totals = file.totals;
    const kept = ratio(totals.useful, totals.tests);
    const count = value => `<td class="num${value ? '' : ' zero'}" data-v="${value ?? 0}">${escape(value ?? 0)}</td>`;
    return `<tr data-path="${escape(file.path)}"><td class="path" data-v="${escape(file.path)}"><a href="${index.href(file.path)}">${escape(file.path)}</a></td>`
      + `<td class="bars" data-v="${kept ?? -1}">${cell(kept, { count: `${escape(totals.useful)}/${escape(totals.tests)}` })}</td>`
      + count(totals.redundant) + count(totals.weak) + count(totals.infra) + '</tr>';
  }).join('');
  const heads = th('File', false) + th('Quality', true, true, 'Tests worth keeping, of all the file\'s tests: ones that check something and repeat no other test.')
    + th('Duplicates', true, false, 'Tests that check the same thing with the same code as an earlier test.')
    + th('Checks nothing', true, false, 'Tests that would pass whatever the code they call does.')
    + th('Live services', true, false, 'Tests that call a real network service or database with nothing mocked.');
  return view('tests', 'Tests', '',
    `<section class="panel" id="tests"><div class="scroll"><table class="grid sortable files"><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table></div></section>`);
}

/** Every problem, filterable by kind, each linking to the line it is about. */
function findingTable(report, index) {
  if (!report.findings.length) return '';
  const kinds = [...new Set(report.findings.map(finding => finding.kind))];
  const sorted = [...report.findings].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const onBranch = report.branch ? new Set(report.branch.findings) : null;
  const rows = sorted.map(finding => `<tr data-finding="${escape(finding.id)}" data-kind="${escape(finding.kind)}"${onBranch ? ` data-changed="${onBranch.has(finding.id) ? 1 : 0}"` : ''}>`
    + `<td class="path" data-v="${escape(finding.path)}:${String(finding.line).padStart(6, '0')}"><a href="${index.href(finding.path, finding.line)}">${escape(finding.path)}:${escape(finding.line)}</a></td>`
    + `<td data-v="${escape(problemName(finding.kind))}"><span class="kind k-${escape(finding.kind)}">${escape(problemName(finding.kind))}</span></td>`
    + `<td><span class="clamp" title="${escape(finding.name)}">${escape(finding.name)}</span></td><td class="note-cell"><span class="clamp" title="${escape(finding.note)}">${escape(finding.note)}</span>${acts()}</td>`
    + `<td class="num" data-v="${finding.probability ?? 2}">${finding.probability === null ? '<span class="muted">not asked</span>' : percent(finding.probability)}</td><td class="x-cell">${dismissMark}</td></tr>`).join('');
  const chips = kinds.map(kind => `<button class="chip on" data-kind="${escape(kind)}"><span class="kind k-${escape(kind)}">${escape(problemName(kind))}</span> ${report.findings.filter(finding => finding.kind === kind).length}</button>`).join('');
  return view('problems', 'All problems', '',
    `<section class="panel" id="findings"><div class="panel-head"><div class="chips">${chips}</div>`
    + (onBranch ? `<label class="scope"><input type="checkbox" id="changed-only"> Only code changed since ${escape(report.branch.ref)} (${escape(onBranch.size)})</label>` : '') + copyAll + '</div>'
    + `<div class="scroll"><table class="grid sortable problems"><thead><tr>${th('Where', false)}${th('Problem', false)}${th('Test or method', false)}${th('Note', false)}${th('Sure', true, false, 'How sure the model is that this needs fixing.')}<th class="x-cell"></th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div></section>`);
}

/**
 * How the run was made: the model, how deep it followed calls, its floor, which frameworks decided what counts, and what it
 * could not read. None of it is a finding about the code; it says how far the rest of the page can be trusted.
 */
function details(report) {
  const facts = [
    ['Repository', `<code>${escape(report.root)}</code>`],
    ['Revision', `<code>${escape(report.revision)}</code> <span class="muted">${escape(when(report.created_at))}</span>`],
    ...(report.diff ? [['Compared with', `<code>${escape(report.diff.from.revision)}</code> <span class="muted">${escape(when(report.diff.from.created_at))}</span>`]] : []),
    ['Model', escape(report.model)],
    ['Call depth', `${escape(report.depth)} <span class="muted">calls followed from each test</span>`],
    ['Floor', `${escape(Math.round(report.min * 100))}% <span class="muted">problems less sure than this are not listed</span>`],
  ];
  return view('details', 'Run details', '',
    `<section class="panel"><dl class="facts-list">${facts.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl></section>`
    + scopeView(report) + failures(report));
}

/** Which test frameworks decided the scope, from which config, and the files no framework covers, which this run leaves out. */
function scopeView(report) {
  const scope = report.scope;
  if (!scope) return '';
  const rows = scope.frameworks.map(framework => `<tr><td>${escape(framework.name)}${framework.version ? ` <span class="muted">${escape(framework.version)}</span>` : ''}</td>`
    + `<td class="path">${escape(framework.config ?? '–')}</td><td class="num">${framework.tests === null ? '–' : escape(framework.tests)}</td><td>${framework.error ? `Could not load it: ${escape(framework.error)}` : ''}</td></tr>`).join('');
  const sample = scope.left_out_sample?.length ? `<p class="lede">Left out, for example: ${scope.left_out_sample.slice(0, 8).map(path => `<code>${escape(path)}</code>`).join(', ')}</p>` : '';
  return `<section class="panel" id="scope"><div class="panel-head"><h3>Test frameworks <span class="count">${scope.frameworks.length}</span></h3>`
    + `<p class="lede">${escape(scope.tests)} test files and ${escape(scope.sources)} source files are in scope. ${escape(scope.left_out)} files no framework covers are left out.</p>${sample}</div>`
    + `<div class="scroll"><table class="grid"><thead><tr><th>Framework</th><th>Config</th><th class="num">Test files</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

/** Units perch could not read, with the reason it recorded. A failure is part of the result, so it is on the page. */
function failures(report) {
  if (!report.failed.length) return '';
  const rows = report.failed.map(item => `<tr><td>${escape(item.subject)}</td><td>${escape(item.name)}</td><td class="path">${escape(item.path)}</td><td>${escape(item.error)}</td></tr>`).join('');
  return `<section class="panel" id="failed"><div class="panel-head"><h3>Could not read <span class="count">${report.failed.length}</span></h3><p class="lede">They count as neither covered nor worth keeping.</p></div>`
    + `<div class="scroll"><table class="grid"><thead><tr><th>Unit</th><th>Name</th><th>File</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

/** What a source method's lines are tinted as: green when every mutant is killed, amber when one survived, red when no test reaches it. */
function methodState(method) {
  return !method.tests.length ? 'none' : method.killed === method.mutants.length ? 'full' : 'part';
}

/** A method's survived mutants that are listed problems: one under the floor has nothing to act on. */
const listedMutants = (method, index) => method.findings.map(id => index.findings.get(id)).filter(finding => finding?.kind === 'survived');

/** Tint, branch markers and the survived mutants for each line of a file, innermost method last so a nested function wins its lines. */
function lineMarks(file, index) {
  const marks = file.lines.map(() => ({ state: '', branch: false, gap: false, starts: [] }));
  const at = line => marks[line - 1];
  const units = file.kind === 'test' ? file.tests.map(id => index.tests.get(id)) : file.methods.map(id => index.methods.get(id));
  const spans = units.filter(Boolean).sort((a, b) => (b.end_line - b.line) - (a.end_line - a.line));
  for (const unit of spans) {
    // A test is tinted only when something is wrong with it; the ones worth keeping read as plain code.
    const state = file.kind === 'test' ? (unit.useful && !unit.findings?.length ? '' : 'weak') : methodState(unit);
    for (let line = unit.line; line <= unit.end_line; line++) if (at(line)) at(line).state = state;
  }
  for (const unit of units.filter(Boolean)) {
    at(unit.line)?.starts.push(unit);
    if (file.kind === 'test') continue;
    for (const line of unit.branches) if (at(line)) at(line).branch = true;
    for (const finding of listedMutants(unit, index)) if (at(finding.line)) at(finding.line).gap = true;
  }
  return marks;
}

/** The tests nearest a method, the ones calling it directly first. Past `REACH_SHOWN`, a count stands for the rest. */
const REACH_SHOWN = 50;
function reachedBy(method, index) {
  const useful = new Set(method.useful);
  const nearest = [...method.tests].sort((a, b) => a.depth - b.depth);
  const rest = nearest.length - REACH_SHOWN;
  return nearest.slice(0, REACH_SHOWN).map(({ id, depth }) =>
    `<li>${unitLink(id, index)}${depth > 1 ? ` <span class="muted">through ${escape(depth - 1)} ${depth === 2 ? 'call' : 'calls'}</span>` : ''}${useful.has(id) ? '' : ' <span class="tag weak">not worth keeping</span>'}</li>`).join('')
    + (rest > 0 ? `<li class="muted">${escape(rest)} more ${rest === 1 ? 'test' : 'tests'}</li>` : '');
}

/** The line above a method: its name, how many of its mutants its tests kill, and how many tests reach it, with the tests one click away. */
function methodBar(method, index) {
  const ran = method.mutants.length ? `${escape(method.killed)} of ${escape(method.mutants.length)} mutants killed` : '';
  const count = method.tests.length;
  const tests = count
    ? `<details><summary>${count} ${count === 1 ? 'test reaches' : 'tests reach'} it${method.useful.length !== count ? `, ${method.useful.length} worth keeping` : ''}</summary><ul class="reach">${reachedBy(method, index)}</ul></details>`
    : '<span class="unran">No test reaches it</span>';
  return `<div class="mbar ${methodState(method)}" id="${escape(`m:${method.id}`)}"><b>${escape(method.name)}</b>${ran ? `<span>${ran}</span>` : ''}${tests}</div>`;
}

/** "a", "a and b", "a, b and c". */
const listed = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
/** How sure perch is, said only when it is not very: a verdict at 95% needs no number, one at 63% does. */
const unsure = probability => (typeof probability === 'number' && probability < 0.8 ? ` <span class="unsure">${escape(percent(probability))} sure</span>` : '');

/** The note under a survived mutant: the line as written and as changed, and which tests miss it, with its buttons. */
function mutantNote(method, finding, index) {
  const mutant = method.mutants.find(item => item.id === finding.mutant);
  const diff = mutant ? `<pre class="diff"><del>- ${escape(mutant.original.trim())}</del>\n<ins>+ ${escape(mutant.mutated.trim())}</ins></pre>` : '';
  const missed = mutant ? mutant.asked.filter(id => !mutant.killed_by.includes(id)).map(id => unitLink(id, index)) : [];
  return `<div class="note gap" data-finding="${escape(finding.id)}"><div class="problem"><p class="verdict bad"><b>${escape(problemName('survived'))}</b> `
    + `${escape(finding.note)}${unsure(finding.probability)}</p><div class="problem-acts">${acts()}${dismissMark}</div></div>${diff}`
    + (missed.length ? `<ul class="facts"><li>Still passes: ${listed(missed)}.</li></ul>` : '') + '</div>';
}

/** One problem in a note under the code: its name and the fact, with Copy prompt and the close mark on the right. */
function problemLine(finding, index) {
  return `<div class="problem" data-finding="${escape(finding.id)}"><p class="verdict bad"><b>${escape(problemName(finding.kind))}</b> ${problemFacts(finding, index).fact}</p>`
    + `<div class="problem-acts">${acts()}${dismissMark}</div></div>`;
}

/** The order a test's problems are said in: what to cut first, then what to fix, then what to mock. */
const PROBLEM_ORDER = ['redundant', ...WEAK, 'infra'];

/**
 * The note under a test with something wrong: each problem as the change it asks for, then what it mocks.
 * A test worth keeping with no problem gets no note: there is nothing to do about it.
 */
function testNote(test, findings, index) {
  const lines = [...findings].sort((a, b) => PROBLEM_ORDER.indexOf(a.kind) - PROBLEM_ORDER.indexOf(b.kind)).map(finding => problemLine(finding, index));
  if (!lines.length) return null;
  const facts = [test.cuts?.length ? `Mocks out ${listed(test.cuts.map(id => unitLink(id, index)))}.` : ''].filter(Boolean);
  const run = facts.length ? `<ul class="facts">${facts.map(fact => `<li>${fact}</li>`).join('')}</ul>` : '';
  return `<div class="note test weak"><div class="note-head"><b>${escape(testName(test))}</b></div>${lines.join('')}${run}</div>`;
}

/**
 * The notes that go under each line of a file. A gap's note carries the method's edge-case findings and a test's note carries
 * the test's findings; any finding neither holds goes under its own line, so every finding in the report is on the page once.
 */
function notesOf(file, index, report) {
  const notes = new Map(), placed = new Set();
  const add = (line, html) => { if (!notes.has(line)) notes.set(line, []); notes.get(line).push(html); };
  const owned = ids => ids.map(id => index.findings.get(id)).filter(Boolean);
  if (file.kind === 'test') {
    for (const test of file.tests.map(id => index.tests.get(id)).filter(Boolean)) {
      const findings = owned(test.findings);
      findings.forEach(finding => placed.add(finding.id));
      const note = testNote(test, findings, index);
      if (note) add(test.line, note);
    }
  } else {
    for (const method of file.methods.map(id => index.methods.get(id)).filter(Boolean)) {
      for (const finding of listedMutants(method, index)) { placed.add(finding.id); add(finding.line, mutantNote(method, finding, index)); }
    }
  }
  for (const finding of report.findings) {
    if (finding.path !== file.path || placed.has(finding.id)) continue;
    add(finding.line, `<div class="note plain" data-finding="${escape(finding.id)}"><div class="problem"><p class="verdict bad"><b>${escape(problemName(finding.kind))}</b> ${problemFacts(finding, index).fact}</p><div class="problem-acts">${acts()}${dismissMark}</div></div></div>`);
  }
  return notes;
}

/** Counts shown at the top of a file's view, the same ones its row in the summary table has. */
function fileStats(file) {
  const totals = file.totals;
  const stat = (name, value, hint = '') => `<div class="stat"${hint ? ` title="${escape(hint)}"` : ''}><b>${value}</b><span>${name}</span></div>`;
  if (file.kind === 'test') {
    const quality = ratio(totals.useful, totals.tests);
    return stat('quality', `<span class="${band(quality)}-text">${percent(quality)}</span> <small>${escape(totals.useful)}/${escape(totals.tests)}</small>`,
      'Tests worth keeping, of all the file\'s tests: ones that check something and repeat no other test.')
      + stat('live services', escape(totals.infra), 'Tests that call a real network service or database with nothing mocked.');
  }
  const reached = ratio(totals.reached, totals.methods);
  const score = scoreValue(totals);
  return stat('methods tested', `<span class="${band(reached)}-text">${percent(reached)}</span> <small>${escape(totals.reached)}/${escape(totals.methods)}</small>`,
    'Methods a test calls, of all the file\'s methods.')
    + (score === null ? '' : stat('mutation score', `<span class="${band(score)}-text">${percent(score)}</span> <small>${escape(totals.killed)}/${escape(totals.mutants)}</small>`, 'Mutants some test is predicted to fail against, of every mutant in the file\'s reached methods.'))
    + stat('survived', escape(totals.survived), 'Mutants no test kills, listed below.');
}

/** A file's problems at the top of its page, each linking to its line, so they are read without scrolling the source. */
function fileProblems(file, report, index) {
  const own = [...index.findingsIn(file.path)].sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  return own.length ? `<div class="panel group file-problems"><div class="panel-head"><h3>Problems <span class="count">${escape(own.length)}</span>${copyAll}</h3></div>${actionTable(own, index)}</div>` : '';
}

/** One file's page: its numbers, a legend, and every line of it with tint, markers and the notes that belong under each. */
function fileView(file, index, report) {
  const marks = lineMarks(file, index), notes = notesOf(file, index, report);
  const methods = file.methods.map(id => index.methods.get(id)).filter(Boolean);
  const legend = file.kind === 'test'
    ? '<span><i class="sw weak"></i>a test with a problem</span>'
    : (methods.length ? '<span><i class="sw full"></i>every mutant killed</span><span><i class="sw part"></i>a mutant survived</span><span><i class="sw none"></i>not reached</span>' : '')
      + '<span><i class="mk">◆</i>branch</span><span><i class="mk gapmk">▲</i>survived mutant</span>';
  const rows = file.lines.map((text, at) => {
    const line = at + 1, mark = marks[at];
    const bars = file.kind === 'source' ? mark.starts.map(method => methodBar(method, index)).join('') : '';
    const gutter = mark.gap ? '<i class="mk gapmk">▲</i>' : mark.branch ? '<i class="mk">◆</i>' : '';
    const classes = ['l', mark.state, mark.gap ? 'gapline' : ''].filter(Boolean).join(' ');
    const under = (notes.get(line) ?? []).join('');
    return `${bars}<div class="${classes}" data-n="${line}"><span class="n">${line}</span><span class="g">${gutter}</span><code>${escape(text) || ' '}</code></div>${under}`;
  }).join('');
  return `<section class="file" data-path="${escape(file.path)}" hidden><div class="file-head"><a class="back" href="${index.home}#view=${file.kind === 'test' ? 'tests' : 'sources'}">← ${file.kind === 'test' ? 'Tests' : 'Source files'}</a>`
    + `<h2><code>${escape(file.path)}</code></h2><span class="tag">${escape(file.kind)}</span><span class="muted">${escape(file.language)}</span>`
    + `<label class="toggle"><input type="checkbox" class="notes-toggle" checked> notes</label></div>`
    + `<div class="stats">${fileStats(file)}</div>${fileProblems(file, report, index)}<div class="legend">${legend}</div>`
    + `<div class="code"><div class="rows">${rows}</div></div></section>`;
}

/**
 * The prompt the Copy fix prompt button copies: which problem, where, the evidence perch has for it, and the change it asks for.
 * The agent reads the code itself, so no source is copied in. Every fact in it is the report's.
 */
export function fixPrompt(finding, report, index) {
  return [`perch coverage found a problem in ${repoName(report)}.`, ...fixSteps(finding, index), 'Change only what this needs.'].join('\n');
}

/** The repository a prompt names: its GitHub owner and name, or the folder it was run in. */
const repoName = report => (report.github ? `${report.github.owner}/${report.github.repo}` : String(report.root ?? '').split('/').filter(Boolean).at(-1));

/** One problem's part of a prompt: what is wrong, where, the evidence, the change it asks for, and how to check it. */
function fixSteps(finding, index) {
  const method = index.methods.get(finding.unit), test = index.tests.get(finding.unit);
  const at = unit => `${unit.path}:${unit.line}`;
  const lines = [];
  if (test) {
    const name = `"${testName(test)}" (${at(test)})`;
    if (finding.kind === 'redundant' && test.redundant_with) {
      const kept = index.tests.get(test.redundant_with);
      lines.push(`The test ${name} kills the same mutants as "${kept ? testName(kept) : test.redundant_with}"${kept ? ` (${at(kept)})` : ''}, and no others.`,
        'Compare the two. Delete this one if it asserts nothing the other does not; otherwise move what differs into the other and delete this one.');
    } else if (finding.kind === 'mocked') {
      lines.push(`The test ${name} mocks every method it calls, so it tests its own mocks: ${finding.note}`, 'Call the real code under test and keep mocks only for what leaves the process: the network, the database, the clock. Delete the test if nothing it checks is worth keeping.');
    } else if (WEAK.has(finding.kind)) {
      lines.push(`The test ${name} has a problem: ${finding.note}`, 'Make it drive the code under test and assert on what that code returns. Delete it if nothing it checks is worth keeping.');
    } else if (finding.kind === 'infra') {
      lines.push(`The unit test ${name} leaves the process: ${finding.note}`, 'Replace those calls with fakes or mocks in the style the test file already uses, so it runs in memory. Do not change the code under test.');
    } else lines.push(`The test ${name}: ${finding.note}`);
    lines.push('Run that test file afterwards and make sure it passes.');
  } else {
    const name = `${method?.name ?? finding.name} (${method ? at(method) : `${finding.path}:${finding.line}`})`;
    const reaching = (method?.useful ?? []).map(id => index.tests.get(id)).filter(Boolean).slice(0, 3).map(item => `"${testName(item)}" (${at(item)})`);
    if (finding.kind === 'survived') {
      const mutant = (method?.mutants ?? []).find(item => item.id === finding.mutant);
      lines.push(`A mutant of ${name} survives every test. ${finding.note}${mutant ? ` Line ${finding.line} reads \`${mutant.original.trim()}\`; the mutant reads \`${mutant.mutated.trim()}\`.` : ''}`,
        `Add a test with an input for which that change gives a different result, and assert on the result.${reaching.length ? ` Tests that already reach it: ${reaching.join(', ')}. Follow their style.` : ''}`);
    } else lines.push(`${name}: ${finding.note}`);
    lines.push('Run the test file afterwards and make sure it passes.');
  }
  return lines;
}

/**
 * Each problem's steps, which the page script puts together into a prompt for one problem or for a list, the repository the
 * prompts name, and the one its dismissals are kept under.
 */
function fixData(report, index, findings = report.findings) {
  const data = { root: report.root ?? null, repo: repoName(report),
    steps: Object.fromEntries(findings.map(finding => [finding.id, fixSteps(finding, index).join('\n')])) };
  // Inside a script element, only "</" can end it early; escaping every "<" rules that out.
  return `<script type="application/json" id="perch-fixes">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

/**
 * More source than this and each file gets a page of its own. Every line of every file is markup on the page, and one page
 * holding all of a 50,000-file repository was longer than any string Node can build, and more than a browser would open.
 */
export const ONE_PAGE_SOURCE = 8 * 1024 * 1024;

/** The report as one HTML document: nothing it needs is fetched, so it opens the same from disk, from CI artifacts or from a mail. */
export function renderCoverageHtml(report) {
  return renderCoverageSite(report, { budget: Infinity }).index.join('');
}

/**
 * The report as the pages to write: index.html in parts, and for a repository with more source than `budget`, a page per file under
 * files/ with the style and script beside them in report.css and report.js. `pages` renders each page as it is read, so the
 * files are never all in memory at once. Nothing is fetched from anywhere but beside the page.
 */
export function renderCoverageSite(report, { budget = ONE_PAGE_SOURCE } = {}) {
  const size = report.files.reduce((sum, file) => sum + file.lines.reduce((total, line) => total + line.length + 1, 0), 0);
  const split = size > budget;
  const index = lookups(report, split ? path => `files/${pageName(path)}` : null);
  const title = `Coverage · ${String(report.root ?? '').split('/').filter(Boolean).at(-1) ?? ''} · ${short(report.revision)}`;
  const tabs = [['summary', 'Summary', null], ['sources', 'Source files', report.files.filter(file => file.kind === 'source').length],
    ['tests', 'Tests', report.totals.tests], ...(report.diff ? [['changes', 'Changes', report.diff.findings.new.length || null]] : []), ['problems', 'All problems', report.findings.length], ['details', 'Run details', null]];
  const nav = `<nav class="tabs" role="tablist">${tabs.map(([id, name, count]) => `<a href="#view=${id}" role="tab" data-tab="${id}">${name}${count === null ? '' : ` <span class="count">${escape(count)}</span>`}</a>`).join('')}</nav>`;
  // The summary in parts, each its own string: a large repository's tables and prompts together were too long to be one.
  const summary = () => [`<main id="summary" class="wrap">${headline(report)}${nav}`, actionsView(report, index), sourceTable(report, index), testTable(report, index),
    changes(report, index), findingTable(report, index), `${details(report)}</main>`];
  const parts = (name, body, assets) => [`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="color-scheme" content="dark light"><link rel="icon" href="data:,"><title>${escape(name)}</title>`
    + `${assets === null ? `<style>${STYLE}</style>` : `<link rel="stylesheet" href="${assets}report.css">`}</head><body>`,
    ...body, `${assets === null ? `<script>${SCRIPT}</script>` : `<script src="${assets}report.js"></script>`}</body></html>\n`];
  const page = (name, body, assets) => parts(name, [body], assets).join('');
  if (!split) {
    const files = `<div class="wrap wide">${report.files.map(file => fileView(file, index, report)).join('')}</div>`;
    return { index: parts(title, [header(report), ...summary(), files, fixData(report, index)], null), assets: [], pages: [] };
  }
  const inFiles = { ...index, href: linkTo(pageName), home: '../index.html' };
  const pages = (function* () {
    for (const file of report.files) {
      const view = fileView(file, inFiles, report).replace('<section class="file" data-path="' + escape(file.path) + '" hidden>', `<section class="file" data-path="${escape(file.path)}">`);
      const own = index.findingsIn(file.path);
      yield { name: `files/${pageName(file.path)}`, html: page(`${file.path} · ${title}`, `${header(report, '../index.html')}<div class="wrap wide">${view}</div>${fixData(report, inFiles, own)}`, '../') };
    }
  })();
  return { index: parts(title, [header(report), ...summary(), fixData(report, index)], ''), assets: [{ name: 'report.css', text: STYLE }, { name: 'report.js', text: SCRIPT }], pages };
}

const STYLE = String.raw`
/* perch's palette and type, as perchscan.com sets them for dark, and as its light wordmark implies for light. The page follows
   the system setting until the header's toggle picks one. */
:root{--bg:#08090c;--panel:#0d0f15;--raised:#12151d;--line:#1e2230;--soft:#171a24;--ink:#e7e9f0;--body:#cdd2df;--muted:#9aa2b6;--faint:#6b7286;
--accent:#ffb454;--accent-soft:#3a2a12;--high:#6ee7a8;--mid:#ffcc66;--low:#ff6b6b;--low-ink:#ff9b9b;--none:#6b7286;--cyan:#7fd1de;
--t-full:rgba(110,231,168,.07);--t-part:rgba(255,204,102,.08);--t-none:rgba(255,107,107,.09);--t-weak:rgba(255,204,102,.07);
--hover:rgba(255,255,255,.02);--shadow:0 24px 60px -24px #000;color-scheme:dark;
--mono:"JetBrains Mono",ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
--sans:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;--radius:12px}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]){--bg:#f6f7f9;--panel:#ffffff;--raised:#f1f3f6;--line:#dfe3ea;--soft:#eceff3;--ink:#1f2328;--body:#353b46;--muted:#5b6475;--faint:#8a93a6;
--accent:#b45f06;--accent-soft:#fdebd3;--high:#1a7f37;--mid:#9a6700;--low:#cf222e;--low-ink:#b42318;--none:#8a93a6;--cyan:#0b6e80;
--t-full:rgba(26,127,55,.07);--t-part:rgba(191,135,0,.1);--t-none:rgba(207,34,46,.07);--t-weak:rgba(191,135,0,.08);
--hover:rgba(15,23,42,.03);--shadow:0 18px 40px -20px rgba(15,23,42,.35);color-scheme:light}}
:root[data-theme=light]{--bg:#f6f7f9;--panel:#ffffff;--raised:#f1f3f6;--line:#dfe3ea;--soft:#eceff3;--ink:#1f2328;--body:#353b46;--muted:#5b6475;--faint:#8a93a6;
--accent:#b45f06;--accent-soft:#fdebd3;--high:#1a7f37;--mid:#9a6700;--low:#cf222e;--low-ink:#b42318;--none:#8a93a6;--cyan:#0b6e80;
--t-full:rgba(26,127,55,.07);--t-part:rgba(191,135,0,.1);--t-none:rgba(207,34,46,.07);--t-weak:rgba(191,135,0,.08);
--hover:rgba(15,23,42,.03);--shadow:0 18px 40px -20px rgba(15,23,42,.35);color-scheme:light}
:root[data-theme=dark]{--bg:#08090c;--panel:#0d0f15;--raised:#12151d;--line:#1e2230;--soft:#171a24;--ink:#e7e9f0;--body:#cdd2df;--muted:#9aa2b6;--faint:#6b7286;
--accent:#ffb454;--accent-soft:#3a2a12;--high:#6ee7a8;--mid:#ffcc66;--low:#ff6b6b;--low-ink:#ff9b9b;--none:#6b7286;--cyan:#7fd1de;
--t-full:rgba(110,231,168,.07);--t-part:rgba(255,204,102,.08);--t-none:rgba(255,107,107,.09);--t-weak:rgba(255,204,102,.07);
--hover:rgba(255,255,255,.02);--shadow:0 24px 60px -24px #000;color-scheme:dark}
.logo-light{display:none}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]) .logo-dark{display:none}:root:not([data-theme=dark]) .logo-light{display:block}}
:root[data-theme=light] .logo-dark{display:none}:root[data-theme=light] .logo-light{display:block}
.theme{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--muted);cursor:pointer}
.theme:hover{color:var(--ink);border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.theme svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.55 var(--sans);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}
code{font-family:var(--mono);font-size:.92em}
b{font-weight:600}
[hidden]{display:none!important}
.muted{color:var(--muted)}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}
.wrap.wide{max-width:none;padding:0}

/* The top bar: wordmark, what this is, and which run. */
.top{position:sticky;top:0;z-index:10;border-bottom:1px solid var(--soft);background:var(--bg)}
.top .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-height:68px}
.brand{display:inline-flex;color:var(--ink)}.brand:hover{opacity:.85;text-decoration:none}
.brand svg{display:block;height:44px;width:auto}
.tag{display:inline-block;padding:1px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font:500 11.5px/1.6 var(--mono)}
.where{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-left:auto;font-size:13px;color:var(--muted)}
.where b{color:var(--ink);font-weight:600}.where code{color:var(--cyan)}

/* The numbers at the top. */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:24px 0 20px}
@media(min-width:720px){.cards{grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr)}}
.card{display:flex;flex-direction:column;gap:4px;padding:16px 18px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);color:var(--ink);transition:border-color .15s}
.card:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--line));text-decoration:none}
.card-title[title],.stat[title] span{cursor:help;text-decoration:underline dotted var(--faint);text-underline-offset:3px}
.card-title{color:var(--muted);font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.big{font-size:30px;font-weight:600;letter-spacing:-.02em;line-height:1.15}.big .of{font-size:15px;color:var(--muted);font-weight:500;letter-spacing:0}
.sub{color:var(--muted);font-size:13px}
.changes{font-size:12.5px;color:var(--faint)}.changes .since{color:var(--faint)}
.delta{font-weight:600;margin-right:4px}.delta.good{color:var(--high)}.delta.bad{color:var(--low)}
.card .bar{width:100%;height:4px;margin-top:auto}

/* Bars and shares. */
.bar{display:inline-block;position:relative;width:100%;height:6px;border-radius:3px;background:var(--soft);overflow:hidden}
.fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px}.fill.inner{opacity:1}
.fill:not(:only-child):not(.inner){opacity:.4}
.fill.high{background:var(--high)}.fill.mid{background:var(--mid)}.fill.low{background:var(--low)}.fill.none{background:var(--none)}
.high-text{color:var(--high)}.mid-text{color:var(--mid)}.low-text{color:var(--low)}.none-text{color:var(--faint)}
.cell{display:grid;grid-template-columns:minmax(40px,1fr) 40px auto;align-items:center;gap:10px}
.pc{text-align:right;font-weight:600}.ct{text-align:left;font-size:12.5px}

/* Tabs. */
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--soft);margin:0 0 22px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}
.tabs a{padding:10px 12px;color:var(--muted);font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tabs a:hover{color:var(--ink);text-decoration:none}.tabs a.on{color:var(--ink);border-bottom-color:var(--accent)}
.count{display:inline-block;min-width:20px;padding:0 6px;margin-left:4px;border-radius:999px;background:var(--raised);color:var(--muted);font-size:11.5px;font-weight:600;text-align:center;line-height:18px}
.count.new,[data-tab=changes] .count{background:color-mix(in srgb,var(--low) 16%,transparent);color:var(--low)}

/* Views and panels. */
.view-head{margin:0 0 16px}.view-head h2{margin:0;font-size:20px;font-weight:600;letter-spacing:-.015em}
.lede{margin:4px 0 0;color:var(--muted);font-size:13.5px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);margin:0 0 18px;overflow:hidden}
.panel-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:13px 18px;border-bottom:1px solid var(--soft)}
.panel-head h3{margin:0;font-size:15px;font-weight:600;display:flex;flex:1;align-items:center;gap:8px}
.panel-foot{display:flex;flex-wrap:wrap;gap:12px;padding:10px 18px;border-top:1px solid var(--soft);font-size:13px;color:var(--muted)}
.more{font-weight:500}
.empty,.pad{margin:0;padding:16px 18px;color:var(--muted)}
.group .sub-head{margin:0;padding:12px 18px 6px;font-size:14px;border-top:1px solid var(--soft)}
.group details.rest{border-top:1px solid var(--soft)}.group details.rest>summary{padding:10px 18px;cursor:pointer;font-weight:500;color:var(--accent)}

/* Tables, as the docs set them. */
.scroll{overflow-x:auto}
table.grid{width:100%;border-collapse:collapse;font-size:14px}
.grid th{padding:10px 14px;border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;text-align:left;white-space:nowrap;vertical-align:bottom}
.grid td{padding:10px 14px;border-bottom:1px solid var(--soft);color:var(--body);vertical-align:middle;white-space:nowrap}
.grid tbody tr:last-child td{border-bottom:0}
.grid tbody tr:hover td{background:var(--hover)}
.grid th:first-child,.grid td:first-child{padding-left:18px}.grid th:last-child,.grid td:last-child{padding-right:18px}
.grid .num{text-align:right}.grid .zero{color:var(--faint)}
.grid td.note-cell,.grid td.why,.grid td.act{white-space:normal}
.grid tfoot td{border-top:1px solid var(--line);color:var(--ink);font-weight:600}
.grid th[data-sort]{cursor:pointer}.grid th[data-sort]:hover{color:var(--ink)}
.grid th[aria-sort=ascending]::after{content:" ↑"}.grid th[aria-sort=descending]::after{content:" ↓"}
.grid th[title]{text-decoration:underline dotted var(--faint);text-underline-offset:3px}
.path,.path a{font-family:var(--mono);font-size:13px;color:var(--cyan)}
.new-badge{display:inline-block;margin-right:6px;padding:0 7px;border-radius:999px;background:color-mix(in srgb,var(--low) 16%,transparent);color:var(--low);font:600 10.5px/1.7 var(--mono);vertical-align:1px}
.grid td.act{min-width:240px}.act b{color:var(--ink);margin-right:6px}.subject{color:var(--body)}
table.problems td.note-cell{min-width:320px}
table.problems td:nth-child(3){white-space:normal;max-width:260px;overflow-wrap:anywhere}
.clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden}
.grid td.x-cell,.grid th.x-cell{width:1%;padding-left:4px;text-align:right}

/* Problem kinds, as pills. */
.kind{display:inline-block;padding:1px 8px;border-radius:999px;font:500 11.5px/1.7 var(--mono);white-space:nowrap;background:var(--raised);color:var(--muted)}
.k-survived{background:color-mix(in srgb,var(--low) 14%,transparent);color:var(--low-ink)}
.k-redundant,.k-checks_nothing{background:color-mix(in srgb,var(--mid) 13%,transparent);color:var(--mid)}
.k-infra{background:color-mix(in srgb,var(--cyan) 13%,transparent);color:var(--cyan)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:2px 10px 2px 3px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--muted);font:500 12px var(--sans);cursor:pointer}
.chip:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}.chip:not(.on){opacity:.4}
.scope{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--body);cursor:pointer}
.scope input{accent-color:var(--accent)}

/* Buttons. */
button{font:inherit}
.acts{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px}
.acts button,.copy-all,.pager button,.toast button{padding:3px 10px;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--muted);font:500 12px/1.4 var(--sans);cursor:pointer;transition:border-color .15s,color .15s}
.acts button:hover,.copy-all:hover,.pager button:hover:not(:disabled),.toast button:hover{color:var(--ink);border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.copy-all{margin-left:auto}
.acts .reason{flex:1;min-width:200px;padding:4px 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);font:13px var(--sans)}
.acts .reason:focus{outline:none;border-color:var(--accent)}
.x{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:7px;background:none;color:var(--faint);font-size:17px;line-height:1;cursor:pointer}
.x:hover{background:var(--raised);color:var(--ink)}


/* Filters and paging. */
.filter{margin:0 0 12px}.filter-files{width:min(320px,100%);padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:14px var(--sans)}
.filter-files:focus{outline:none;border-color:var(--accent)}
.pager{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:10px 18px;border-top:1px solid var(--soft);font-size:13px;color:var(--muted)}
.pager .pages{display:flex;align-items:center;gap:8px}.pager button:disabled{opacity:.35;cursor:default}
.pager select{padding:3px 8px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--body);font:12px var(--sans)}

/* Changes. */
details.change{border-top:1px solid var(--soft)}details.change:first-child{border-top:0}
details.change>summary{display:flex;align-items:center;gap:8px;padding:12px 18px;cursor:pointer;list-style:none}
details.change>summary::-webkit-details-marker{display:none}
details.change>summary::before{content:"›";color:var(--faint);transition:transform .15s}details.change[open]>summary::before{transform:rotate(90deg)}
details.change h3{margin:0;font-size:14.5px;font-weight:600}
.was{color:var(--faint)}
ul.ids{margin:0;padding:6px 18px 14px 36px;color:var(--body)}

/* Run details. */
.view[data-view=details] .grid td{white-space:normal;overflow-wrap:anywhere}
.facts-list{display:grid;grid-template-columns:max-content 1fr;gap:8px 20px;margin:0;padding:16px 18px}
.facts-list div{display:contents}.facts-list dt{color:var(--muted);font-size:13px}.facts-list dd{margin:0;color:var(--body)}

/* A file: its head, its problems, and its lines. */
section.file{padding:0 0 48px}
.file-head,.stats,.legend{max-width:1180px;margin:0 auto;padding-left:24px;padding-right:24px}
.file-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding-top:20px;padding-bottom:12px}
.file-head h2{margin:0;font-size:18px;font-weight:600}.file-head h2 code{font-size:17px;color:var(--ink)}
.back{font-size:13px}
.toggle{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--muted);font-size:13px;cursor:pointer}.toggle input{accent-color:var(--accent)}
.stats{display:flex;flex-wrap:wrap;gap:10px;padding-bottom:14px}
.stat{display:flex;flex-direction:column;min-width:96px;padding:10px 14px;background:var(--panel);border:1px solid var(--line);border-radius:10px}
.stat b{font-size:18px;font-weight:600}.stat b small{font-size:12px;color:var(--muted);font-weight:500}.stat span{color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.file-problems{width:calc(100% - 48px);max-width:1132px;margin:0 auto 16px}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;padding-bottom:10px;color:var(--muted);font-size:12px;align-items:center}
.sw{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin-right:6px;border:1px solid var(--line)}
.sw.full{background:var(--t-full);box-shadow:inset 2px 0 var(--high)}.sw.part{background:var(--t-part);box-shadow:inset 2px 0 var(--mid)}.sw.none{background:var(--t-none);box-shadow:inset 2px 0 var(--low)}
.sw.weak{background:var(--t-weak);box-shadow:inset 2px 0 var(--mid)}
.mk{font-style:normal;color:var(--faint);font-size:10px}.gapmk{color:var(--low)}
.code{width:calc(100% - 48px);max-width:1132px;margin:0 auto;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow-x:auto}
.rows{min-width:max-content;padding:8px 0}
.l{display:grid;grid-template-columns:56px 18px 1fr;align-items:baseline;font:12.5px/1.7 var(--mono);color:var(--body);border-left:2px solid transparent}
.l .n{text-align:right;padding-right:10px;color:var(--faint);user-select:none}.l .g{text-align:center}
.l code{white-space:pre;padding-right:24px;font-size:inherit}
.l.full{background:var(--t-full);border-left-color:color-mix(in srgb,var(--high) 55%,transparent)}
.l.part{background:var(--t-part);border-left-color:color-mix(in srgb,var(--mid) 55%,transparent)}
.l.none{background:var(--t-none);border-left-color:color-mix(in srgb,var(--low) 55%,transparent)}
.l.weak{background:var(--t-weak);border-left-color:color-mix(in srgb,var(--mid) 55%,transparent)}
.l.gapline code{text-decoration:underline wavy color-mix(in srgb,var(--low) 70%,transparent);text-underline-offset:4px}
.l.flash code{animation:flash 1.6s ease-out}@keyframes flash{0%{background:var(--accent-soft)}100%{background:transparent}}
.mbar{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:10px 16px 2px 76px;padding:6px 12px;border-radius:8px;background:var(--raised);font:13px var(--sans);color:var(--muted);max-width:900px}
.mbar b{color:var(--ink);font-family:var(--mono);font-size:12.5px}
.mbar details summary{cursor:pointer;color:var(--muted)}.mbar details[open] summary{color:var(--ink)}
.ran{color:var(--high);font-weight:600}.unran{color:var(--low);font-weight:600}
ul.reach{margin:6px 0 2px;padding-left:18px;font-size:13px}
.tag.weak{border-color:transparent;background:color-mix(in srgb,var(--mid) 13%,transparent);color:var(--mid)}

/* Notes under a line: a problem, named, with the fact and its buttons. */
.note{margin:6px 16px 10px 76px;padding:10px 14px;border:1px solid var(--line);border-left:2px solid var(--low);border-radius:8px;background:var(--raised);font:14px/1.5 var(--sans);white-space:normal;max-width:900px}
.note.test{border-left-color:var(--mid)}
.diff{margin:8px 0 0;padding:8px 12px;border-radius:6px;background:var(--panel);font:12px/1.5 var(--mono);white-space:pre-wrap}.diff del{color:var(--low-ink);text-decoration:none}.diff ins{color:var(--high);text-decoration:none}
.note-head{margin:0 0 6px;font-family:var(--mono);font-size:12.5px;color:var(--muted)}.note-head b{color:var(--ink);font-weight:500}
.problem{display:flex;align-items:flex-start;gap:12px}.problem+.problem{margin-top:6px;padding-top:6px;border-top:1px solid var(--soft)}
.problem>.verdict{flex:1;min-width:0;margin:3px 0}.problem-acts{display:flex;align-items:center;gap:2px;flex:none}.problem-acts .acts{margin:0}
.verdict{color:var(--body)}.verdict b{margin-right:6px}.verdict.bad b{color:var(--low-ink)}.note.test .verdict.bad b{color:var(--mid)}
.unsure{margin-left:6px;color:var(--faint);font-size:12.5px}
.facts{margin:6px 0 0;padding-left:18px;color:var(--muted);font-size:13px}
body.nonotes .note{display:none}
[data-dismissed]{display:none!important}

/* The toast that says what a button did. */
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:20;max-width:min(760px,calc(100% - 32px));padding:12px 16px;background:var(--raised);color:var(--body);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);font-size:13.5px}
.toast code{color:var(--accent);word-break:break-all}.toast button{margin-left:8px}
.toast .prompt-text{display:block;width:min(680px,calc(100vw - 64px));margin-top:8px;padding:8px 10px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;font:12px/1.5 var(--mono)}

@media (max-width:640px){.wrap{padding:0 16px}.top{position:static}.where{margin-left:0}.file-head,.stats,.legend{padding-left:16px;padding-right:16px}
.code,.file-problems{width:calc(100% - 32px)}.note,.mbar{margin-left:16px;margin-right:16px}}
`;

/**
 * The page's behaviour: hash routing between the summary and a file, sorting a table by a column, filtering, and hiding notes.
 * It reads paths back out of `data-path` attributes by comparing strings, never by building a selector, since a path is text from
 * the repository and a selector built from it would be one it wrote.
 */
const SCRIPT = String.raw`
(function () {
  var summary = document.getElementById('summary');
  var files = Array.prototype.slice.call(document.querySelectorAll('section.file'));
  var summaryScroll = 0, onSummary = true;
  var views = Array.prototype.slice.call(document.querySelectorAll('section.view'));
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));
  function route() {
    var params = new URLSearchParams(location.hash.slice(1));
    var path = params.get('file'), line = Number(params.get('line')) || 0, target = null;
    files.forEach(function (section) { if (path !== null && section.getAttribute('data-path') === path) target = section; });
    // A file's own page is that file and nothing else.
    if (!summary) target = files[0];
    if (onSummary && target) summaryScroll = window.scrollY;
    if (summary) summary.hidden = Boolean(target);
    files.forEach(function (section) { section.hidden = section !== target; });
    document.querySelectorAll('.flash').forEach(function (row) { row.classList.remove('flash'); });
    if (target) {
      onSummary = false;
      var row = line ? target.querySelector('[data-n="' + line + '"]') : null;
      if (row) { row.classList.add('flash'); row.scrollIntoView({ block: 'center' }); } else window.scrollTo(0, 0);
      return;
    }
    // One view at a time: the one the hash names, or the first. A link into All problems may name the kinds to show.
    var wanted = params.get('view');
    if (wanted === 'problems' && (params.get('kind') || params.get('changed'))) {
      if (window.showChanged) window.showChanged(params.get('changed') === '1');
      if (window.showOnlyKinds) window.showOnlyKinds(params.get('kind') ? params.get('kind').split(',') : null);
    }
    var shown = views.some(function (section) { return section.getAttribute('data-view') === wanted; }) ? wanted : views[0] && views[0].getAttribute('data-view');
    views.forEach(function (section) { section.hidden = section.getAttribute('data-view') !== shown; });
    tabs.forEach(function (tab) { var on = tab.getAttribute('data-tab') === shown; tab.classList.toggle('on', on); tab.setAttribute('aria-selected', on ? 'true' : 'false'); });
    if (!onSummary) window.scrollTo(0, summaryScroll);
    onSummary = true;
  }
  window.addEventListener('hashchange', route);

  document.addEventListener('click', function (event) {
    var number = event.target.closest && event.target.closest('.l .n');
    if (!number) return;
    var section = number.closest('section.file');
    location.hash = 'file=' + encodeURIComponent(section.getAttribute('data-path')) + '&line=' + number.textContent;
  });

  // Every table on the summary pages its rows. A filter marks a row out; render decides which rows show: the rows not out, one
  // page of them. A table no longer than a page has no pager, and still filters through render.
  var SIZES = [25, 50, 100, 0];
  function render(state) {
    var rows = Array.prototype.slice.call(state.table.tBodies[0].rows);
    var kept = rows.filter(function (row) { return !row.hasAttribute('data-out'); });
    var size = state.size || Math.max(kept.length, 1), pages = Math.max(1, Math.ceil(kept.length / size));
    state.page = Math.min(Math.max(1, state.page), pages);
    var from = (state.page - 1) * size, to = Math.min(from + size, kept.length);
    rows.forEach(function (row) { row.hidden = true; });
    kept.slice(from, to).forEach(function (row) { row.hidden = false; });
    if (rows.length <= SIZES[0]) { state.bar.hidden = true; return; }
    state.bar.hidden = false;
    var options = SIZES.map(function (value) { return '<option value="' + value + '"' + (value === state.size ? ' selected' : '') + '>' + (value ? value + ' per page' : 'All') + '</option>'; }).join('');
    state.bar.innerHTML = '<span class="range">' + (kept.length ? (from + 1) + '–' + to : '0') + ' of ' + kept.length + '</span>'
      + '<span class="pages"><button type="button" data-go="-1"' + (state.page <= 1 ? ' disabled' : '') + '>‹ Prev</button>'
      + '<span>Page ' + state.page + ' of ' + pages + '</span>'
      + '<button type="button" data-go="1"' + (state.page >= pages ? ' disabled' : '') + '>Next ›</button></span>'
      + '<select aria-label="Rows per page">' + options + '</select>';
  }
  function paged(table) {
    if (!table.tBodies[0]) return;
    var bar = document.createElement('div');
    bar.className = 'pager';
    var wrap = table.closest('.scroll') || table;
    wrap.parentNode.insertBefore(bar, wrap.nextSibling);
    var state = { table: table, page: 1, size: SIZES[0], bar: bar };
    bar.addEventListener('click', function (event) {
      var go = event.target.closest('[data-go]');
      if (!go || go.disabled) return;
      state.page += Number(go.getAttribute('data-go'));
      render(state);
    });
    bar.addEventListener('change', function (event) { state.size = Number(event.target.value); state.page = 1; render(state); });
    table.pager = state;
    render(state);
  }
  function refresh(table) { if (table.pager) { table.pager.page = 1; render(table.pager); } }
  document.querySelectorAll('#summary table.grid').forEach(paged);

  document.querySelectorAll('table.sortable').forEach(function (table) {
    var heads = Array.prototype.slice.call(table.querySelectorAll('thead th'));
    heads.forEach(function (head, column) {
      if (!head.hasAttribute('data-sort')) return;
      head.addEventListener('click', function () {
        var numeric = head.getAttribute('data-sort') === 'number';
        var ascending = head.getAttribute('aria-sort') !== 'ascending';
        heads.forEach(function (other) { other.removeAttribute('aria-sort'); });
        head.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
        var body = table.tBodies[0];
        var rows = Array.prototype.slice.call(body.rows);
        var key = function (row) { var cell = row.cells[column]; var value = cell.hasAttribute('data-v') ? cell.getAttribute('data-v') : cell.textContent; return numeric ? Number(value) : value.toLowerCase(); };
        rows.sort(function (a, b) { var x = key(a), y = key(b); var order = x < y ? -1 : x > y ? 1 : 0; return ascending ? order : -order; });
        rows.forEach(function (row) { body.appendChild(row); });
        refresh(table);
      });
    });
  });

  document.querySelectorAll('.filter-files').forEach(function (filter) { filter.addEventListener('input', function () {
    var text = filter.value.toLowerCase();
    document.querySelectorAll('table.files').forEach(function (table) {
      Array.prototype.slice.call(table.tBodies[0].rows).forEach(function (row) {
        if (text && row.getAttribute('data-path').toLowerCase().indexOf(text) < 0) row.setAttribute('data-out', ''); else row.removeAttribute('data-out');
      });
      refresh(table);
    });
  }); });

  // Which kinds of problem the All problems table shows: every kind, or the kinds a link from another view names.
  var shown = {};
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip[data-kind]'));
  var changedOnly = document.getElementById('changed-only');
  function showKinds() {
    chips.forEach(function (chip) { chip.classList.toggle('on', Boolean(shown[chip.getAttribute('data-kind')])); });
    var onlyChanged = Boolean(changedOnly && changedOnly.checked);
    document.querySelectorAll('table.problems').forEach(function (table) {
      Array.prototype.slice.call(table.tBodies[0].rows).forEach(function (row) {
        var out = !shown[row.getAttribute('data-kind')] || (onlyChanged && row.getAttribute('data-changed') !== '1') || row.hasAttribute('data-dismissed');
        if (out) row.setAttribute('data-out', ''); else row.removeAttribute('data-out');
      });
      refresh(table);
    });
  }
  chips.forEach(function (chip) {
    shown[chip.getAttribute('data-kind')] = true;
    chip.addEventListener('click', function () {
      var kind = chip.getAttribute('data-kind');
      shown[kind] = !shown[kind];
      showKinds();
    });
  });
  if (changedOnly) changedOnly.addEventListener('change', showKinds);
  // A link from the Summary says whether it means the changed code alone.
  window.showChanged = function (on) { if (changedOnly) { changedOnly.checked = on; showKinds(); } };
  window.showOnlyKinds = function (kinds) {
    chips.forEach(function (chip) { var kind = chip.getAttribute('data-kind'); shown[kind] = !kinds || kinds.indexOf(kind) >= 0; });
    showKinds();
  };

  // Copy prompt: a problem's prompt, or one for every problem a list shows, goes to the clipboard to paste into a coding agent.
  var fixData = JSON.parse(document.getElementById('perch-fixes').textContent);
  function promptFor(ids) {
    if (ids.length === 1) return 'perch coverage found a problem in ' + fixData.repo + '.\n' + fixData.steps[ids[0]] + '\nChange only what this needs.';
    return 'perch coverage found ' + ids.length + ' problems in ' + fixData.repo + '. Fix them one at a time.\n\n'
      + ids.map(function (id, at) { return (at + 1) + '. ' + fixData.steps[id].split('\n').join('\n   '); }).join('\n\n')
      + '\n\nChange only what each one needs.';
  }
  function shownIn(scope) {
    var ids = [];
    scope.querySelectorAll('[data-finding]').forEach(function (element) {
      var id = element.getAttribute('data-finding');
      if (element.getClientRects().length && fixData.steps[id] && ids.indexOf(id) < 0) ids.push(id);
    });
    return ids;
  }

  // Dismiss: the page cannot write to the repository, so it copies the perch close command that does, and hides the problem
  // here until the next run leaves it out.
  var dismissKey = 'perch-dismissed:' + fixData.root;
  function dismissedIds() { try { return JSON.parse(localStorage.getItem(dismissKey) || '[]'); } catch (error) { return []; } }
  function saveDismissed(ids) { try { localStorage.setItem(dismissKey, JSON.stringify(ids)); } catch (error) { /* private mode: hidden for this visit only */ } }
  function applyDismissed() {
    var ids = dismissedIds();
    document.querySelectorAll('[data-finding]').forEach(function (element) {
      if (ids.indexOf(element.getAttribute('data-finding')) >= 0) element.setAttribute('data-dismissed', ''); else element.removeAttribute('data-dismissed');
    });
    document.querySelectorAll('table.grid').forEach(function (table) {
      if (!table.tBodies[0]) return;
      Array.prototype.slice.call(table.tBodies[0].rows).forEach(function (row) { if (row.hasAttribute('data-dismissed')) row.setAttribute('data-out', ''); });
      refresh(table);
    });
  }
  var toast = document.createElement('div');
  toast.className = 'toast';
  toast.hidden = true;
  document.body.appendChild(toast);
  function say(html) { toast.innerHTML = html; toast.hidden = false; clearTimeout(say.timer); say.timer = setTimeout(function () { toast.hidden = true; }, 9000); }
  function quoted(text) { return "'" + text.replace(/'/g, "'\''") + "'"; }
  function escapeHtml(text) { return text.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  document.addEventListener('click', function (event) {
    var owner = event.target.closest('[data-finding]');
    if (event.target.closest('[data-copy]') && owner) { copyPrompt(promptFor([owner.getAttribute('data-finding')])); return; }
    var all = event.target.closest('[data-copy-all]');
    if (all) {
      var ids = shownIn(all.closest('.panel') || document);
      if (ids.length) copyPrompt(promptFor(ids), ids.length); else say('No problems shown here to copy.');
      return;
    }
    if (event.target.closest('[data-dismiss]') && owner) {
      var box = owner.querySelector('.acts');
      box.innerHTML = '<input type="text" class="reason" placeholder="Why is this not a problem?" aria-label="Why dismiss it"> <button type="button" data-close>Dismiss</button> <button type="button" data-cancel>Cancel</button>';
      box.querySelector('.reason').focus();
      return;
    }
    if (event.target.closest('[data-cancel]')) { event.target.closest('.acts').outerHTML = ACTS; return; }
    if (event.target.closest('[data-close]') && owner) close(owner, event.target.closest('.acts'));
    var undo = event.target.closest('[data-undo]');
    if (undo) { saveDismissed(dismissedIds().filter(function (id) { return id !== undo.getAttribute('data-undo'); })); applyDismissed(); toast.hidden = true; }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || !event.target.classList.contains('reason')) return;
    close(event.target.closest('[data-finding]'), event.target.closest('.acts'));
  });
  var ACTS = document.querySelector('.acts') ? document.querySelector('.acts').outerHTML : '';
  function copyPrompt(prompt, count) {
    var copying = navigator.clipboard ? navigator.clipboard.writeText(prompt) : Promise.reject(new Error('no clipboard'));
    copying.then(function () { say('Copied a prompt for ' + (count > 1 ? count + ' problems' : 'this problem') + '. Paste it into your coding agent.'); }, function () {
      // The browser would not write to the clipboard, so the prompt is shown selected, ready to copy by hand.
      say('Copy this into your coding agent: <textarea class="prompt-text" readonly rows="6"></textarea>');
      var area = toast.querySelector('.prompt-text');
      area.value = prompt;
      area.select();
    });
  }
  function close(owner, box) {
    var id = owner.getAttribute('data-finding'), reason = box.querySelector('.reason').value.trim();
    var command = 'perch close ' + id + (reason ? ' --reason ' + quoted(reason) : '');
    box.outerHTML = ACTS;
    saveDismissed(dismissedIds().concat([id]));
    applyDismissed();
    var shown = '<code>' + escapeHtml(command) + '</code> <button type="button" data-undo="' + id + '">Undo</button>';
    var copying = navigator.clipboard ? navigator.clipboard.writeText(command) : Promise.reject(new Error('no clipboard'));
    copying.then(function () { say('Copied. Run it in the repository to keep it dismissed: ' + shown); },
      function () { say('Run this in the repository to keep it dismissed: ' + shown); });
  }
  applyDismissed();

  // Light or dark: the system's until the toggle is pressed, then the one picked, remembered in this browser.
  var root = document.documentElement;
  try { var saved = localStorage.getItem('perch-theme'); if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved); } catch (error) { /* no storage: follow the system */ }
  document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
    button.addEventListener('click', function () {
      var current = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      var next = current === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('perch-theme', next); } catch (error) { /* no storage: this visit only */ }
    });
  });

  document.querySelectorAll('.notes-toggle').forEach(function (box) {
    box.addEventListener('change', function () {
      document.body.classList.toggle('nonotes', !box.checked);
      document.querySelectorAll('.notes-toggle').forEach(function (other) { other.checked = box.checked; });
    });
  });
  // Last, once every table and filter is ready to be set from the address.
  route();
})();
`;
