import { describe, expect, it } from 'vitest';
import { fixPrompt, renderCoverageHtml, renderCoverageSite } from '../src/coverage-html.js';

const cartLines = [
  'from util import round_money',
  '',
  'def apply_discount(total, percent):',
  '    if percent < 0:',
  '        raise ValueError("negative")',
  '    if percent > 100:',
  '        percent = 100',
  '    # <script>alert(1)</script>',
  '    if total == 0:',
  '        return 0',
  '    return round_money(total * (100 - percent) / 100)',
  '',
  '',
  'def total(items):',
  '    return sum(item.price for item in items)',
];
const utilLines = ['def round_money(value):', '    return round(value, 2)'];
const testLines = [
  'from cart import apply_discount',
  '',
  'def test_discount_10():',
  '    assert apply_discount(100, 10) == 90',
  '',
  '',
  '',
  'def test_discount_20():',
  '    assert apply_discount(100, 20) == 80',
];

const edge = { id: 'e1e1e1e1', kind: 'survived', subject: 'method', unit: 'src/cart.py::apply_discount', mutant: '6:7:>>>=', path: 'src/cart.py', line: 6, name: 'apply_discount', probability: 0.82, note: 'With `>=` instead of `>`, none of the 2 tests reaching it fails.' };
const redundant = { id: 'r3r3r3r3', kind: 'redundant', subject: 'test', unit: 'tests/test_cart.py::test_discount_20', path: 'tests/test_cart.py', line: 8, name: 'test_discount_20', probability: 0.88, note: 'Kills the same mutants as test_discount_10 at line 3, and no others.' };
/** A mutant the compared run listed and this one does not. */
const gone = { id: 'f4f4f4f4', kind: 'survived', subject: 'method', unit: 'src/cart.py::apply_discount', mutant: '11:30:->+', path: 'src/cart.py', line: 11, name: 'apply_discount', probability: 0.7, note: 'With `+` instead of `-`, none of the 2 tests reaching it fails.' };

/**
 * A report as buildReport writes one: apply_discount is reached by two tests and has six mutants, one of them survived; total is
 * reached by nothing; util.py's round_money is reached but has no line to change.
 */
function sampleReport({ diff = true } = {}) {
  return {
    revision: 'bbbbbbb2222222', root: '/work/shop', created_at: '2026-09-28T10:00:00.000Z', model: 'jev-1', depth: 3, min: 0.5,
    totals: { methods: 3, covered: 2, useful_covered: 2, mutants: 6, killed: 3, no_coverage: 0, score: 0.5, covered_score: 0.5, survived: 1, tests: 2, useful: 1, redundant: 1, weak: 0, infra: 0,
      drop: { count: 1, unreached: [] } },
    files: [
      { path: 'src/cart.py', kind: 'source', language: 'python', lines: cartLines, methods: ['src/cart.py::apply_discount', 'src/cart.py::total'], tests: [],
        totals: { methods: 2, covered: 1, useful_covered: 1, mutants: 6, killed: 3, no_coverage: 0, score: 0.5, covered_score: 0.5, survived: 1, tests: 0, useful: 0, redundant: 0, weak: 0, infra: 0 } },
      { path: 'src/util.py', kind: 'source', language: 'python', lines: utilLines, methods: ['src/util.py::round_money'], tests: [],
        totals: { methods: 1, covered: 1, useful_covered: 1, mutants: 0, killed: 0, no_coverage: 0, score: null, covered_score: null, survived: 0, tests: 0, useful: 0, redundant: 0, weak: 0, infra: 0 } },
      { path: 'tests/test_cart.py', kind: 'test', language: 'python', lines: testLines, methods: [],
        tests: ['tests/test_cart.py::test_discount_10', 'tests/test_cart.py::test_discount_20'],
        totals: { methods: 0, covered: 0, useful_covered: 0, mutants: 0, killed: 0, no_coverage: 0, score: null, covered_score: null, survived: 0, tests: 2, useful: 1, redundant: 1, weak: 0, infra: 0 } },
    ],
    methods: [
      { id: 'src/cart.py::apply_discount', path: 'src/cart.py', name: 'apply_discount', line: 3, end_line: 11, risk: 12, branches: [4, 6, 9],
        tests: [{ id: 'tests/test_cart.py::test_discount_10', depth: 1 }, { id: 'tests/test_cart.py::test_discount_20', depth: 1 }],
        useful: ['tests/test_cart.py::test_discount_10'], findings: [edge.id], covered: true, killed: 3,
        // Six mutants: the boundary at line 6 survives both tests; the rest are killed by test_discount_10 (and the duplicate).
        mutants: [
          { id: '6:7:>>>=', kind: 'boundary', line: 6, column: 7, from: '>', to: '>=', original: '    if percent > 100:', mutated: '    if percent >= 100:', matters: 0.9, survives: 0.9, killed: false, killed_by: [], asked: ['tests/test_cart.py::test_discount_10', 'tests/test_cart.py::test_discount_20'], finding: edge.id },
          ...[['4:7:<><=', 4, '<', '<=', true], ['4:4:percent < 0>not (percent < 0)', 4, 'percent < 0', 'not (percent < 0)', true], ['6:4:percent > 100>not (percent > 100)', 6, 'percent > 100', 'not (percent > 100)', true], ['9:4:total == 0>not (total == 0)', 9, 'total == 0', 'not (total == 0)', false], ['11:30:->+', 11, '-', '+', false]]
            .map(([id, line, from, to, killed]) => ({ id, kind: 'condition', line, column: 4, from, to, original: '', mutated: '', matters: 0.9, survives: killed ? 0.05 : 0.6, killed, killed_by: killed ? ['tests/test_cart.py::test_discount_10', 'tests/test_cart.py::test_discount_20'] : [], asked: ['tests/test_cart.py::test_discount_10', 'tests/test_cart.py::test_discount_20'], finding: null })),
        ],
      },
      { id: 'src/cart.py::total', path: 'src/cart.py', name: 'total', line: 14, end_line: 15, risk: 2, branches: [], tests: [], useful: [], covered: false, killed: 0, mutants: [], findings: [] },
      { id: 'src/util.py::round_money', path: 'src/util.py', name: 'round_money', line: 1, end_line: 2, risk: 1, branches: [],
        tests: [{ id: 'tests/test_cart.py::test_discount_10', depth: 2 }], useful: ['tests/test_cart.py::test_discount_10'], covered: true, killed: 0, mutants: [], findings: [] },
    ],
    tests: [
      { id: 'tests/test_cart.py::test_discount_10', path: 'tests/test_cart.py', name: 'test_discount_10', suite: [], line: 3, end_line: 4, framework: 'pytest',
        direct: ['src/cart.py::apply_discount'], reach: [{ id: 'src/cart.py::apply_discount', depth: 1 }, { id: 'src/util.py::round_money', depth: 2 }], cuts: [],
        touches: [], infra: 0.04, asked: 6, kills: ['src/cart.py::apply_discount#4:7:<><=', 'src/cart.py::apply_discount#4:4:percent < 0>not (percent < 0)', 'src/cart.py::apply_discount#6:4:percent > 100>not (percent > 100)'],
        useful: true, redundant_with: null, findings: [] },
      { id: 'tests/test_cart.py::test_discount_20', path: 'tests/test_cart.py', name: 'test_discount_20', suite: [], line: 8, end_line: 9, framework: 'pytest',
        direct: ['src/cart.py::apply_discount'], reach: [{ id: 'src/cart.py::apply_discount', depth: 1 }], cuts: [],
        touches: [], infra: 0.03, asked: 6, kills: ['src/cart.py::apply_discount#4:7:<><=', 'src/cart.py::apply_discount#4:4:percent < 0>not (percent < 0)', 'src/cart.py::apply_discount#6:4:percent > 100>not (percent > 100)'],
        useful: false, redundant_with: 'tests/test_cart.py::test_discount_10', findings: [redundant.id] },
    ],
    findings: [edge, redundant],
    failed: [],
    baseline: diff ? { revision: 'aaaaaaa1111111', created_at: '2026-09-20T10:00:00.000Z' } : null,
    diff: diff ? {
      from: { revision: 'aaaaaaa1111111', created_at: '2026-09-20T10:00:00.000Z' }, to: { revision: 'bbbbbbb2222222', created_at: '2026-09-28T10:00:00.000Z' },
      totals: { methods: { before: 3, after: 3 }, covered: { before: 1, after: 2 }, mutants: { before: 6, after: 6 }, killed: { before: 2, after: 3 }, no_coverage: { before: 3, after: 0 }, score: { before: 0.41, after: 0.5 }, covered_score: { before: 0.6, after: 0.5 }, survived: { before: 2, after: 1 }, tests: { before: 1, after: 2 },
        useful: { before: 1, after: 1 }, redundant: { before: 0, after: 1 }, weak: { before: 0, after: 0 }, infra: { before: 0, after: 0 } },
      files: [{ path: 'src/cart.py', before: { methods: 2, covered: 0, useful_covered: 0, mutants: 6, killed: 0, no_coverage: 6, score: 0, covered_score: null, tests: 0, useful: 0, redundant: 0, weak: 0, infra: 0 },
        after: { methods: 2, covered: 1, useful_covered: 1, mutants: 6, killed: 3, no_coverage: 0, score: 0.5, covered_score: 0.5, tests: 0, useful: 0, redundant: 0, weak: 0, infra: 0 } }],
      methods: [{ id: 'src/cart.py::apply_discount', path: 'src/cart.py', name: 'apply_discount',
        before: { covered: false, mutants: 6, killed: 0 }, after: { covered: true, mutants: 6, killed: 3 } }],
      tests: { added: ['tests/test_cart.py::test_discount_20'], removed: ['tests/test_old.py::test_gone'] },
      findings: { fixed: [gone], new: [redundant] },
    } : null,
    usage: {},
  };
}

/** One of the big numbers at the top of the page, from its title to the next card. */
function card(html, title) {
  const found = new RegExp(`<div class="card-title"[^>]*>${title}</div>`).exec(html);
  if (!found) return null;
  const start = found.index;
  return html.slice(start, html.indexOf('</a>', start));
}

/** One view of the summary, from its section to the next view's. */
function viewOf(html, id) {
  const start = html.indexOf(`<section class="view" data-view="${id}"`);
  if (start === -1) return null;
  const next = html.indexOf('<section class="view"', start + 1);
  return html.slice(start, next === -1 ? html.indexOf('</main>', start) : next);
}

/** The classes on a line of a file's view, which carry its tint. */
function lineClasses(html, path, line) {
  const start = html.indexOf(`<section class="file" data-path="${path}"`);
  const section = html.slice(start, html.indexOf('</section>', start));
  return section.match(new RegExp(`<div class="([^"]*)" data-n="${line}">`))[1].split(' ');
}

/** The markup between one line of a file's view and the next: the line itself and whatever notes sit under it. */
function under(html, path, line) {
  const start = html.indexOf(`<section class="file" data-path="${path}"`);
  expect(start).toBeGreaterThan(-1);
  const section = html.slice(start, html.indexOf('</section>', start));
  const from = section.indexOf(`data-n="${line}"`);
  expect(from).toBeGreaterThan(-1);
  const to = section.indexOf(`data-n="${line + 1}"`, from);
  return section.slice(from, to === -1 ? undefined : to);
}

/** A script tag a browser would run, in any case: <SCRIPT> runs as readily as <script>. A JSON data block does not run. */
const RUNNABLE_SCRIPT = /<script\b(?![^>]*\btype="application\/json")/gi;

describe('coverage HTML report', () => {
  const html = renderCoverageHtml(sampleReport());

  it('puts notes under their lines', () => {
    // The line's note holds its survived mutants, folded until the mark in the gutter is pressed: each one's edit in words and the
    // line both ways; no percentage when perch is sure (82% is sure enough).
    const note = under(html, 'src/cart.py', 6);
    expect(note).toContain('<button type="button" class="mk gapmk" data-toggle-note="6" title="1 survived mutant: press for the edits">▲</button>');
    expect(note).toContain('<div class="note gap closed" data-line="6"><div class="note-head"><b>1 survived mutant</b> <span class="muted">on line 6</span></div>');
    expect(note).toContain('<p class="verdict bad">With `&gt;=` instead of `&gt;`, none of the 2 tests reaching it fails.</p>');
    expect(note).toContain('<pre class="diff"><del>- if percent &gt; 100:</del>\n<ins>+ if percent &gt;= 100:</ins></pre>');
    expect(note).not.toContain('% sure');
    // The tests that reach the method are listed once, in its bar above the code, not again under every mutant: a survived mutant
    // is one none of them kills, so a list of which still pass would be the same list.
    expect(note).not.toContain('Still passes');
    expect(note).not.toContain('Reached by');
    expect(under(html, 'src/cart.py', 2)).toContain('test_discount_10');
    // The bar above the method says what test to add, from its surest survived mutant.
    expect(under(html, 'src/cart.py', 2)).toContain('<span class="do">Add a test at the boundary of `&gt;` on line 6, where `&gt;` and `&gt;=` give different results.</span>');
    expect(under(html, 'src/cart.py', 5)).not.toContain('Survived mutant');
    expect(under(html, 'src/cart.py', 7)).not.toContain('Survived mutant');
    // A method no test reaches is said so above its code, and is not a problem: the call graph alone lists nothing.
    expect(under(html, 'src/cart.py', 13)).toContain('<span class="unran">No test reaches it</span>');
    expect(under(html, 'src/cart.py', 14)).not.toContain('class="note');
    // A redundant test's note is a verdict: delete it, and which test it repeats, as a link.
    expect(under(html, 'tests/test_cart.py', 8)).toContain('<b>Duplicate test</b> Kills the same mutants as <a href="#file=tests%2Ftest_cart.py&amp;line=3" title="tests/test_cart.py:3">test_discount_10</a>, and no others.</p>');
    // A test worth keeping with no problem gets no note and no tint: there is nothing to do about it.
    expect(under(html, 'tests/test_cart.py', 3)).not.toContain('class="note');
    expect(lineClasses(html, 'tests/test_cart.py', 3)).toEqual(['l']);
    expect(lineClasses(html, 'tests/test_cart.py', 8)).toEqual(['l', 'weak']);
    // A source file opens on the methods to add a test to, then its code; a test file opens on its code.
    const cart = html.slice(html.indexOf('<section class="file" data-path="src/cart.py"'), html.indexOf('<section class="file" data-path="src/util.py"'));
    const methods = cart.slice(cart.indexOf('file-methods'), cart.indexOf('class="legend"'));
    expect(methods).toContain('Where to add tests <span class="count">1</span>');
    expect(methods).toContain('<a class="name" href="#file=src%2Fcart.py&amp;line=3">apply_discount</a>');
    expect(cart.indexOf('file-methods')).toBeLessThan(cart.indexOf('class="code"'));
    expect(cart).not.toContain('file-problems');
    const tests = html.slice(html.indexOf('<section class="file" data-path="tests/test_cart.py"'));
    expect(tests.slice(0, tests.indexOf('class="code"'))).not.toContain('Where to add tests');
    // The toolbar: the legend, a way through the lines with survivors, and a switch to open every note.
    const legend = cart.slice(cart.indexOf('class="legend"'), cart.indexOf('class="code"'));
    expect(legend).toContain('<button type="button" data-gap="1" title="Next line with a survived mutant">↓ Next survived</button><span class="muted">1 line</span>');
    expect(legend).toContain('<input type="checkbox" class="notes-toggle"> open every note');
  });

  it('names each problem on a test', () => {
    const report = sampleReport();
    const test = report.tests[1];
    Object.assign(test, { touches: ['filesystem'] });
    const infra = { id: 'i5i5i5i5', kind: 'infra', subject: 'test', unit: test.id, path: test.path, line: 8, name: test.name, probability: 0.62, note: 'Calls a live service with nothing mocked: requests.get at src/cart.py:3.' };
    test.findings = [...test.findings, infra.id];
    report.findings = [...report.findings, infra];
    const note = under(renderCoverageHtml(report), 'tests/test_cart.py', 8);
    // What to cut first, then what to mock; how sure perch is only when it is not very.
    expect(note.indexOf('<b>Duplicate test</b>')).toBeLessThan(note.indexOf('<b>Live service</b>'));
    expect(note).toContain('<b>Live service</b> Calls a live service with nothing mocked: requests.get at src/cart.py:3. <span class="unsure">62% sure</span></p>');
    // Running through other files of this repository is not a problem, and not said.
    expect(note).not.toContain('runs through');
  });

  it('marks only listed survived mutants', () => {
    // Under the floor, the survived mutant is not a finding: the method still has the mutant, and the page says nothing about it.
    const quiet = sampleReport();
    quiet.findings = quiet.findings.filter(finding => finding.id !== edge.id);
    quiet.methods[0].findings = [];
    const page = renderCoverageHtml(quiet);
    expect(under(page, 'src/cart.py', 6)).not.toContain('No test takes');
    expect(lineClasses(page, 'src/cart.py', 6)).not.toContain('gapline');
    expect(lineClasses(html, 'src/cart.py', 6)).toContain('gapline');
  });

  it('escapes source text and names', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(under(html, 'src/cart.py', 8)).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.match(RUNNABLE_SCRIPT)).toHaveLength(1);
    const hostile = sampleReport();
    hostile.tests[0].name = '<img src=x onerror=alert(1)>';
    const page = renderCoverageHtml(hostile);
    expect(page).not.toContain('<img src=');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('shows changes since the compared run', () => {
    expect(viewOf(html, 'changes')).toContain('Changes since <code>aaaaaaa</code>');
    // No coverage went from 3 mutants to 0: one phrase with its unit, then the commit.
    expect(card(html, 'No coverage')).toContain('<span class="delta good">−3 mutants</span> <span class="since">since aaaaaaa</span>');
    expect(html).toContain('tests/test_old.py::test_gone');
    // A problem that went away is counted, not listed: nothing in such a list asks for anything.
    expect(viewOf(html, 'changes')).toContain('1 problem from that run is gone.');
    expect(html).not.toContain(gone.note);
    // The mutation score went from 41% to 50%.
    expect(card(html, 'Mutation score')).toContain('<span class="delta good">+9 pts</span>');
    // The header says which run this is compared with; the model, depth and floor are under Run details.
    const top = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(top).toContain('compared with</span><code title="aaaaaaa1111111">aaaaaaa</code>');
    expect(top).not.toContain('jev-1');
    expect(viewOf(html, 'details')).toContain('jev-1');
  });

  it('counts mutants in the tiles', () => {
    // Four tiles, each linking to the view that breaks it down.
    const tiles = html.slice(html.indexOf('<section class="cards">'), html.indexOf('</section>', html.indexOf('<section class="cards">')));
    expect(tiles.match(/<a class="card" href="#view=/g)).toHaveLength(4);
    expect(html).not.toContain('class="counters"');
    // The mutation score: mutants killed of all mutants.
    const score = card(html, 'Mutation score');
    expect(score).toContain('50%');
    expect(score).toContain('3 of 6 mutants killed, 50% on covered code');
    expect(card(html, 'No coverage')).toContain('0<span class="of"> of 6</span>');
    expect(card(html, 'Survived')).toContain('1<span class="of"> of 6</span>');
    const cartRow = viewOf(html, 'sources').match(/<tr data-path="src\/cart.py"[^>]*>.*?<\/tr>/s)[0];
    expect(cartRow).toContain('3/6');
    // The tests tile is how many tests could go.
    const tests = card(html, 'Redundant tests');
    // Every calculated number says how it is counted, on hover.
    expect(html).toMatch(/<div class="card-title" title="The number of tests that are duplicates or check nothing, out of the total number of tests/);
    expect(tests).toContain('1<span class="of"> of 2</span>');
    expect(tests).toContain('1 test could go');
    // One more redundant test than the compared run: a change for the worse.
    expect(tests).toContain('<span class="delta bad">+1 test</span>');
    expect(html).not.toContain('>Tests worth keeping</div>');
  });

  it('opens on the summary without ledes', () => {
    const tabs = html.slice(html.indexOf('<nav class="tabs"'), html.indexOf('</nav>'));
    expect([...tabs.matchAll(/data-tab="([a-z]+)"/g)].map(match => match[1])).toEqual(['summary', 'sources', 'tests', 'changes', 'problems', 'details']);
    expect(renderCoverageHtml(sampleReport({ diff: false }))).not.toContain('data-tab="changes"');
    // The first view is the one the page opens on. A heading and its table say what a view holds; the only sentence under one is
    // news the table does not carry, that problems from the compared run went away.
    expect(html.indexOf('data-view="summary"')).toBeLessThan(html.indexOf('data-view="sources"'));
    for (const id of ['summary', 'sources', 'tests', 'problems', 'details']) expect(viewOf(html, id)).not.toMatch(/<div class="view-head">.*?<p class="lede">.*?<\/div>/s);
    expect(viewOf(html, 'changes')).toContain('<p class="lede">1 problem from that run is gone.</p>');
    const summary = viewOf(html, 'summary');
    expect(summary).not.toContain('class="lede"');
    // Two lists and no per-file tables: those are the Source files and Tests tabs.
    expect([...summary.matchAll(/<h3>([^<]+?) </g)].map(match => match[1])).toEqual(['Where to add tests', 'Test problems']);
    // Methods to add a test to, one row each with the test to add. A method no test reaches is not in the list: the call graph
    // alone is not a problem.
    const methodList = summary.slice(summary.indexOf('<h3>Where to add tests '), summary.indexOf('<h3>Test problems '));
    expect(methodList).toContain('<a class="name" href="#file=src%2Fcart.py&amp;line=3">apply_discount</a><span class="path">src/cart.py:3</span>');
    expect(methodList).toContain('<td class="num">1</td><td class="num">2</td><td class="do"><span class="advice">Add a test at the boundary of `&gt;` on line 6, where `&gt;` and `&gt;=` give different results.</span>');
    expect(methodList).toContain('<button type="button" data-copy-ids>Copy prompt</button>');
    expect(methodList).not.toContain('>total<');
    // The mutants fold under the row, each in words with a link to its line; the code is there.
    expect(methodList).toContain(`<tr class="detail" data-detail-for="src/cart.py::apply_discount" hidden><td colspan="5"><ul class="edits"><li data-finding="${edge.id}"><a class="at" href="#file=src%2Fcart.py&amp;line=6">line 6</a> With \`&gt;=\` instead of \`&gt;\`, none of the 2 tests reaching it fails.</li></ul></td></tr>`);
    expect(methodList).not.toContain('if percent');
    const testProblems = summary.slice(summary.indexOf('<h3>Test problems '));
    expect(testProblems).toContain('<b>Duplicate test</b> <span class="subject">test_discount_20</span>');
    // The first review is short lists: each problem once, not every list again.
    expect(summary.split('none of the 2 tests reaching it fails.')).toHaveLength(2);
  });

  it('tints methods by what the mutants found', () => {
    // apply_discount has 3 of its 6 mutants killed; the bar above line 3 is in the markup that follows line 2.
    const discount = under(html, 'src/cart.py', 2);
    expect(discount).toContain('3 of 6 mutants killed');
    expect(lineClasses(html, 'src/cart.py', 4)).toEqual(['l', 'part']);
    expect(lineClasses(html, 'src/cart.py', 6)).toEqual(['l', 'part', 'gapline']);
    expect(under(html, 'src/cart.py', 6)).toContain('<b>1 survived mutant</b>');
    // No test reaches total.
    expect(under(html, 'src/cart.py', 13)).toContain('<span class="unran">No test reaches it</span>');
    expect(lineClasses(html, 'src/cart.py', 15)).toEqual(['l', 'none']);
    // round_money has no line to change: reached, with no mutant to kill.
    const money = html.slice(html.indexOf('<section class="file" data-path="src/util.py"'));
    expect(money.slice(0, money.indexOf('data-n="1"'))).not.toContain('mutants killed');
    expect(lineClasses(html, 'src/util.py', 2)).toEqual(['l', 'full']);
  });

  it('marks new problems in place, first in their list', () => {
    const summary = viewOf(html, 'summary');
    // No second list of what is new: the problem is where it belongs, marked and first.
    expect(summary).not.toContain('New since');
    expect(summary).toContain('<span class="new-badge">new</span><b>Duplicate test</b> <span class="subject">test_discount_20</span>');
    // A method whose survived mutant is new is marked too.
    const fresh = sampleReport();
    fresh.diff.findings.new = [edge];
    expect(viewOf(renderCoverageHtml(fresh), 'summary')).toContain('<span class="new-badge">new</span><a class="name" href="#file=src%2Fcart.py&amp;line=3">apply_discount</a>');
    expect(summary.split('test_discount_20</span>')).toHaveLength(2);
    // Changes opens on them too.
    const changes = viewOf(html, 'changes');
    expect(changes.indexOf('<h3>New problems</h3>')).toBeLessThan(changes.indexOf('<h3>Files</h3>'));
    // With nothing to compare with, nothing is new.
    expect(viewOf(renderCoverageHtml(sampleReport({ diff: false })), 'summary')).not.toContain('new-badge');
  });

  it('scopes the summary to changed code with --since', () => {
    const branch = { ref: 'origin/main', base: 'aaaaaaa1111111', units: ['src/cart.py::apply_discount'], findings: [edge.id] };
    const page = renderCoverageHtml({ ...sampleReport(), branch });
    const summary = viewOf(page, 'summary');
    expect(summary).not.toContain('new-badge');
    // The lists hold only the changed code's problems.
    const lists = summary.slice(summary.indexOf('<h3>Where to add tests '));
    expect(lists).toContain('<a class="name" href="#file=src%2Fcart.py&amp;line=3">apply_discount</a>');
    expect(summary).not.toContain('test_discount_20');
    // All problems marks which rows are in changed code, and can show those alone.
    const problems = viewOf(page, 'problems');
    expect(problems).toContain('<input type="checkbox" id="changed-only"> Only code changed since origin/main (1)');
    expect(problems.match(/data-changed="1"/g)).toHaveLength(1);
    expect(problems.match(/data-changed="0"/g)).toHaveLength(1);
    // A branch with no problems in what it changed says so under the table.
    expect(viewOf(renderCoverageHtml({ ...sampleReport(), branch: { ...branch, findings: [] } }), 'summary')).toContain('No problems in code changed since origin/main.');
    // Without --since there is no such filter.
    expect(html).not.toContain('id="changed-only"');
  });

  it('copies fix prompts and dismisses problems', () => {
    const data = page => JSON.parse(page.match(/<script type="application\/json" id="perch-fixes">(.*?)<\/script>/s)[1]);
    const fixes = data(html);
    expect(Object.keys(fixes.steps).sort()).toEqual([edge.id, redundant.id].sort());
    expect(fixes).toMatchObject({ root: '/work/shop', repo: 'shop' });
    // Every place a problem shows carries its id, a Copy prompt button and a close mark: the summary, All problems, the file view.
    for (const id of [edge.id, redundant.id]) expect(html.match(new RegExp(`data-finding="${id}"[^>]*>`, 'g')).length).toBeGreaterThanOrEqual(2);
    const row = viewOf(html, 'problems').match(new RegExp(`<tr data-finding="${redundant.id}".*?</tr>`, 's'))[0];
    expect(row).toContain('<div class="acts"><button type="button" data-copy>Copy prompt</button></div>');
    expect(row).toContain('<td class="x-cell"><button type="button" class="x" data-dismiss title="Dismiss" aria-label="Dismiss">×</button></td>');
    const buttons = '<div class="problem-acts"><div class="acts"><button type="button" data-copy>Copy prompt</button></div><button type="button" class="x" data-dismiss title="Dismiss" aria-label="Dismiss">×</button></div>';
    expect(under(html, 'tests/test_cart.py', 8)).toContain(`<div class="problem" data-finding="${redundant.id}">`);
    expect(under(html, 'tests/test_cart.py', 8)).toContain(buttons);
    expect(under(html, 'src/cart.py', 6)).toContain(`<div class="mutant" data-finding="${edge.id}">`);
    expect(under(html, 'src/cart.py', 6)).toContain(buttons);
    expect(html).not.toContain('class="dismiss"');
    // Each list of problems has one button for all of it: the file's methods, the summary's, and All problems.
    const file = html.slice(html.indexOf('<section class="file" data-path="src/cart.py"'));
    expect(file.slice(file.indexOf('file-methods'), file.indexOf('class="legend"'))).toContain('<button type="button" class="copy-all" data-copy-all>Copy prompt</button>');
    expect(viewOf(html, 'summary')).toContain('<h3>Where to add tests <span class="count">1</span> <button type="button" class="copy-all" data-copy-all>Copy prompt</button></h3>');
    expect(viewOf(html, 'problems')).toContain('data-copy-all');
    // No app links: the prompt is copied, to paste into whichever agent you use.
    expect(html).not.toMatch(/claude-cli:|codex:\/\/|cursor:\/\//);
    // The page puts a problem's steps together into the same prompt fixPrompt writes, and a list's into one numbered prompt.
    const script = html.match(/function promptFor[\s\S]*?\n {2}}\n/)[0];
    const promptFor = new Function('fixData', `${script}return promptFor;`)(fixes);
    const index = { methods: new Map(sampleReport().methods.map(item => [item.id, item])), tests: new Map(sampleReport().tests.map(item => [item.id, item])) };
    for (const finding of [edge, redundant]) expect(promptFor([finding.id])).toBe(fixPrompt(finding, sampleReport(), index));
    expect(promptFor([redundant.id])).toBe([
      'perch coverage found a problem in shop.',
      'The test "test_discount_20" (tests/test_cart.py:8) kills the same mutants as "test_discount_10" (tests/test_cart.py:3), and no others.',
      'Compare the two. Delete this one if it asserts nothing the other does not; otherwise move what differs into the other and delete this one.',
      'Run that test file afterwards and make sure it passes.',
      'Change only what this needs.',
    ].join('\n'));
    const both = promptFor([redundant.id, edge.id]);
    expect(both.startsWith('perch coverage found 2 problems in shop. Fix them one at a time.\n\n1. The test "test_discount_20" (tests/test_cart.py:8) kills the same mutants as "test_discount_10" (tests/test_cart.py:3), and no others.\n   Compare the two.')).toBe(true);
    expect(both).toContain('\n\n2. A mutant of apply_discount (src/cart.py:3) survives every test. With `>=` instead of `>`, none of the 2 tests reaching it fails. Line 6 reads `if percent > 100:`; the mutant reads `if percent >= 100:`.');
    expect(both).toContain('Add a test with an input for which that change gives a different result, and assert on the result. Tests that already reach it: "test_discount_10" (tests/test_cart.py:3).');
    expect(both.endsWith('\n\nChange only what each one needs.')).toBe(true);
    // Text from the report cannot end the script it sits in.
    const hostile = sampleReport();
    hostile.findings[0].note = '</script><script>alert(1)</script>';
    expect(data(renderCoverageHtml(hostile)).steps[edge.id]).toBeDefined();
    expect(renderCoverageHtml(hostile).match(RUNNABLE_SCRIPT)).toHaveLength(1);
  });

  it('follows the system theme, with a toggle and a wordmark for each', () => {
    expect(html).toContain('<meta name="color-scheme" content="dark light">');
    expect(html).toContain('@media (prefers-color-scheme:light){:root:not([data-theme=dark]){--bg:#f6f7f9;');
    expect(html).toContain(':root[data-theme=light]{--bg:#f6f7f9;');
    expect(html).toContain('<span class="logo-dark"><svg');
    expect(html).toContain('<span class="logo-light"><svg');
    expect(html).toContain('data-theme-toggle');
  });

  it('breaks each test file down by why tests are not worth keeping, and each source file by survived mutants', () => {
    const heads = view => [...viewOf(html, view).matchAll(/<th data-sort="[a-z]+"[^>]*>([^<]+)</g)].map(match => match[1]);
    expect(heads('tests')).toEqual(['File', 'Quality', 'Duplicates', 'Checks nothing', 'Live services']);
    expect(heads('sources')).toEqual(['Mutation score', 'Killed', 'Survived', 'No coverage']);
    // test_cart.py: one duplicate, test_discount_20.
    const row = viewOf(html, 'tests').match(/<tr data-path="tests\/test_cart.py">.*?<\/tr>/s)[0];
    expect(row).toContain('<td class="num" data-v="1">1</td><td class="num zero" data-v="0">0</td><td class="num zero" data-v="0">0</td>');
    // cart.py: three mutants killed, one survived, none without coverage.
    expect(viewOf(html, 'sources').match(/<tr data-path="src\/cart.py"[^>]*>.*?<\/tr>/s)[0]).toContain('<td class="num">3</td><td class="num">1</td><td class="num zero">0</td></tr>');
  });

  it('lays the source files out as a tree, worst first, and lists only the test files with something to fix', () => {
    const sources = viewOf(html, 'sources');
    // One directory, src, with its files' numbers summed: 3 of 6 killed, 1 survived; the worse file first.
    expect(sources).toContain('<tr class="dir" data-path="src" data-parent=""><td class="path" style="--depth:0"><button type="button" class="fold" data-toggle-dir aria-label="Open or close the directory">›</button>src/ <span class="muted">2</span></td>');
    expect(sources.match(/<tr class="dir" data-path="src"[^>]*>.*?<\/tr>/s)[0]).toContain('<td class="num">3</td><td class="num">1</td><td class="num zero">0</td>');
    const order = [...sources.matchAll(/<tr(?: class="dir")? data-path="([^"]+)" data-parent="([^"]*)"/g)].map(match => [match[1], match[2]]);
    expect(order).toEqual([['src', ''], ['src/cart.py', 'src'], ['src/util.py', 'src']]);
    expect(sources).toContain('<td class="path" style="--depth:1"><a href="#file=src%2Fcart.py" title="src/cart.py">cart.py</a></td>');
    expect(sources).toContain('<table class="grid tree files">');
    expect(sources).not.toContain('data-closed');
    // A chain of directories with nothing but the next in them is one row.
    const deep = sampleReport();
    deep.files[1].path = 'lib/shop/util/money.py';
    deep.methods[2].path = deep.files[1].path;
    expect(viewOf(renderCoverageHtml(deep), 'sources')).toContain('>lib/shop/util/ <span class="muted">1</span></td>');
    // Past two hundred files, every directory under the top starts folded.
    const many = sampleReport();
    many.files = [...many.files, ...Array.from({ length: 200 }, (_, at) => ({ ...many.files[1], path: `src/more/file${at}.py`, methods: [] }))];
    const big = viewOf(renderCoverageHtml(many), 'sources');
    expect(big).toContain('<tr class="dir" data-path="src/more" data-parent="src" data-closed>');
    expect(big).toContain('<tr class="dir" data-path="src" data-parent=""><td');
    // Test files with nothing to fix are rows kept out until asked for, and counted under the table.
    const fine = sampleReport();
    fine.files.push({ path: 'tests/test_util.py', kind: 'test', language: 'python', lines: ['def test_round(): pass'], methods: [], tests: [], totals: { tests: 1, useful: 1, redundant: 0, weak: 0, infra: 0, methods: 0, covered: 0, useful_covered: 0, mutants: 0, killed: 0, no_coverage: 0, score: null, covered_score: null, survived: 0 } });
    const tests = viewOf(renderCoverageHtml(fine), 'tests');
    expect(tests).toContain('<tr data-path="tests/test_util.py" data-fine data-out>');
    expect(tests).toContain('<tr data-path="tests/test_cart.py"><td');
    expect(tests).toContain('<div class="panel-foot"><span>1 test file has nothing to fix.</span><button type="button" class="copy-all" data-show-fine>Show them</button></div>');
    expect(viewOf(html, 'tests')).not.toContain('nothing to fix');
  });

  it('fetches nothing from anywhere', () => {
    expect(html).not.toMatch(/https?:\/\//);
    // url(#…) in the wordmark points at its own mask and gradients, inside the page.
    expect(html).not.toMatch(/@import|url\((?!#)|\bsrc=|\bfetch\(|XMLHttpRequest|sendBeacon/);
    // The one link is the page's icon, given inline so a browser does not ask a server for favicon.ico.
    expect(html.match(/<link\b[^>]*>/g)).toEqual(['<link rel="icon" href="data:,">']);
  });

  it('omits changes without a baseline', () => {
    const page = renderCoverageHtml(sampleReport({ diff: false }));
    expect(page).not.toContain('id="changes"');
    expect(page).not.toContain('Changes since');
    expect(page).not.toContain('class="delta');
  });

  it('gives each file a page of its own when the source is too much for one', () => {
    const site = renderCoverageSite(sampleReport(), { budget: 10 });
    const pages = [...site.pages];
    expect(site.assets.map(asset => asset.name)).toEqual(['report.css', 'report.js']);
    expect(pages.map(page => page.name)).toEqual(sampleReport().files.map(file => expect.stringMatching(new RegExp(`^files/${file.path.replace(/[^A-Za-z0-9._-]+/g, '_')}-[0-9a-f]{8}\\.html$`))));
    // The index holds no file's lines, and links each file to its page.
    const index = site.index.join('');
    expect(index).not.toContain('<section class="file"');
    const cart = pages.find(page => page.name.startsWith('files/src_cart.py-'));
    expect(index).toContain(`href="${cart.name}#file=src%2Fcart.py&amp;line=6"`);
    expect(index.match(/<link\b[^>]*>|<script\b[^>]*>/gi)).toEqual(['<link rel="icon" href="data:,">', '<link rel="stylesheet" href="report.css">', '<script type="application/json" id="perch-fixes">', '<script src="report.js">']);
    // A file's page shows that file, goes back to the index, and carries the prompts for its own problems only.
    expect(cart.html).toContain('<section class="file" data-path="src/cart.py">');
    expect(cart.html).toContain('href="../index.html#view=sources"');
    expect(cart.html).toContain('<script src="../report.js">');
    const steps = Object.keys(JSON.parse(cart.html.match(/id="perch-fixes">(.*?)<\/script\s*>/is)[1]).steps);
    expect(steps.sort()).toEqual(sampleReport().findings.filter(finding => finding.path === 'src/cart.py').map(finding => finding.id).sort());
    // One page as before when the source fits.
    expect(renderCoverageSite(sampleReport()).index.join('')).toBe(renderCoverageHtml(sampleReport()));
  });

  it('names the eight nearest tests that reach a method, the ones it asked, and counts the rest', () => {
    const report = sampleReport();
    const method = report.methods.find(item => item.id === 'src/cart.py::apply_discount');
    const reaching = Array.from({ length: 53 }, (_, at) => ({ ...report.tests[0], id: `tests/test_cart.py::t${at}`, name: `t${at}` }));
    report.tests.push(...reaching);
    method.tests = reaching.map((test, at) => ({ id: test.id, depth: at < 3 ? 3 : 1 }));
    const bar = renderCoverageHtml(report).match(/<ul class="reach">(.*?)<\/ul>/s)[1];
    expect(bar.match(/<li>/g)).toHaveLength(8);
    expect(bar).not.toContain('>t0<');
    expect(bar).toContain('<li class="muted">45 more tests</li>');
  });
});
