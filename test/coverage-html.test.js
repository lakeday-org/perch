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

const edge = { id: 'e1e1e1e1', kind: 'edge_case', subject: 'method', unit: 'src/cart.py::apply_discount', path: 'src/cart.py', line: 6, name: 'apply_discount', probability: 0.82, note: 'Untested case: apply_discount with a percent over 100.' };
const untested = { id: 'u2u2u2u2', kind: 'untested', subject: 'method', unit: 'src/cart.py::total', path: 'src/cart.py', line: 14, name: 'total', probability: null, note: 'No test reaches total.' };
const redundant = { id: 'r3r3r3r3', kind: 'redundant', subject: 'test', unit: 'tests/test_cart.py::test_discount_20', path: 'tests/test_cart.py', line: 8, name: 'test_discount_20', probability: 0.88, note: 'Decides happy_path of apply_discount, like test_discount_10 at line 3.' };

/**
 * A report as buildReport writes one. With `measured`, CI's JUnit and LCOV files were read: apply_discount ran with half its
 * branches taken, total never ran, util.py was not in the coverage file, test_discount_20 has a time and per-test lines and
 * test_discount_10 has neither. Without it, no report file was read and every figure is static reach or Jev's estimate.
 */
function sampleReport({ diff = true, measured = true } = {}) {
  const on = (value, otherwise = null) => (measured ? value : otherwise);
  return {
    version: 1, revision: 'bbbbbbb2222222', root: '/work/shop', created_at: '2026-09-28T10:00:00.000Z', model: 'jev-1', depth: 3, min: 0.5,
    inputs: on([{ kind: 'junit', path: 'reports/junit.xml', runs: 4 }, { kind: 'lcov', path: 'coverage/lcov.info', files: 1 }], []),
    unmatched_runs: on([{ path: 'reports/junit.xml', classname: 'tests.test_gone', name: 'test_vanished' }], []),
    unmatched_paths: on([{ path: 'coverage/lcov.info', reported: '/ci/build/generated/parser.py' }], []),
    totals: { methods: 3, reached: 2, useful_reached: 2, exercised: 0.5, exercised_basis: 'estimated', tests: 2, useful: 1, redundant: 1, smelly: 0, infra: 0,
      untested: 1, edge_cases: 1, cost: { 0: on(1, 2), 1: 0, 2: 0, 3: 0 },
      drop: { count: 1, cost: { 0: on(0, 1), 1: 0, 2: 0, 3: 0 }, seconds: on(41.2), timed: on(1, 0) },
      measured: on({ lines: { hit: 6, total: 11 }, branches: { hit: 3, total: 6 } }),
      suite: on({ seconds: 190.4, runs: 4, failed: 1, skipped: 0 }) },
    files: [
      { path: 'src/cart.py', kind: 'source', language: 'python', lines: cartLines, methods: ['src/cart.py::apply_discount', 'src/cart.py::total'], tests: [],
        totals: { methods: 2, reached: 1, useful_reached: 1, exercised: 0.25, exercised_basis: on('measured', 'estimated'), tests: 0, useful: 0, redundant: 0, smelly: 0, infra: 0 } },
      { path: 'src/util.py', kind: 'source', language: 'python', lines: utilLines, methods: ['src/util.py::round_money'], tests: [],
        totals: { methods: 1, reached: 1, useful_reached: 1, exercised: 1, exercised_basis: 'estimated', tests: 0, useful: 0, redundant: 0, smelly: 0, infra: 0 } },
      { path: 'tests/test_cart.py', kind: 'test', language: 'python', lines: testLines, methods: [],
        tests: ['tests/test_cart.py::test_discount_10', 'tests/test_cart.py::test_discount_20'],
        totals: { methods: 0, reached: 0, useful_reached: 0, exercised: null, tests: 2, useful: 1, redundant: 1, smelly: 0, infra: 0 } },
    ],
    methods: [
      { id: 'src/cart.py::apply_discount', path: 'src/cart.py', name: 'apply_discount', line: 3, end_line: 11, risk: 12, branches: [4, 6, 9],
        tests: [{ id: 'tests/test_cart.py::test_discount_10', depth: 1 }, { id: 'tests/test_cart.py::test_discount_20', depth: 1 }],
        useful: ['tests/test_cart.py::test_discount_10'], exercised: 0.5, gap: { line: 6, text: '    if percent > 100:', kind: 'boundary', probability: 0.82 }, findings: [edge.id],
        measured: on({ lines: { hit: 6, total: 9 }, branches: { hit: 3, total: 6 } }), executed: on(true), exercised_basis: on('measured', 'estimated') },
      { id: 'src/cart.py::total', path: 'src/cart.py', name: 'total', line: 14, end_line: 15, risk: 2, branches: [], tests: [], useful: [], exercised: 0, gap: null, findings: [untested.id],
        measured: on({ lines: { hit: 0, total: 2 }, branches: { hit: 0, total: 0 } }), executed: on(false), exercised_basis: on('measured', 'static') },
      { id: 'src/util.py::round_money', path: 'src/util.py', name: 'round_money', line: 1, end_line: 2, risk: 1, branches: [],
        tests: [{ id: 'tests/test_cart.py::test_discount_10', depth: 2 }], useful: ['tests/test_cart.py::test_discount_10'], exercised: 1, gap: null, findings: [],
        measured: null, executed: null, exercised_basis: 'estimated' },
    ],
    tests: [
      { id: 'tests/test_cart.py::test_discount_10', path: 'tests/test_cart.py', name: 'test_discount_10', suite: [], line: 3, end_line: 4, framework: 'pytest',
        direct: ['src/cart.py::apply_discount'], reach: [{ id: 'src/cart.py::apply_discount', depth: 1 }, { id: 'src/util.py::round_money', depth: 2 }], cuts: [],
        touches: [], decides: { choice: 'happy_path', probability: 0.91 }, smell: { choice: 'none', probability: 0.93 }, infra: 0.04,
        cost: { tier: 0, probabilities: [0.9, 0.05, 0.03, 0.02], basis: 'estimated' }, useful: true, redundant_with: null, redundant_basis: null, findings: [],
        run: null, executed_methods: null },
      { id: 'tests/test_cart.py::test_discount_20', path: 'tests/test_cart.py', name: 'test_discount_20', suite: [], line: 8, end_line: 9, framework: 'pytest',
        direct: ['src/cart.py::apply_discount'], reach: [{ id: 'src/cart.py::apply_discount', depth: 1 }], cuts: [],
        touches: [], decides: { choice: 'happy_path', probability: 0.88 }, smell: { choice: 'none', probability: 0.9 }, infra: 0.03,
        cost: on({ seconds: 41.2, basis: 'measured' }, { tier: 0, probabilities: [0.92, 0.04, 0.02, 0.02], basis: 'estimated' }),
        useful: false, redundant_with: 'tests/test_cart.py::test_discount_10', redundant_basis: 'static', findings: [redundant.id],
        run: on({ time: 41.2, status: 'failed', cases: 3 }), executed_methods: on(['src/cart.py::apply_discount']) },
    ],
    findings: [edge, untested, redundant],
    failed: [],
    baseline: diff ? { revision: 'aaaaaaa1111111', created_at: '2026-09-20T10:00:00.000Z' } : null,
    diff: diff ? {
      from: { revision: 'aaaaaaa1111111', created_at: '2026-09-20T10:00:00.000Z' }, to: { revision: 'bbbbbbb2222222', created_at: '2026-09-28T10:00:00.000Z' },
      totals: { methods: { before: 3, after: 3 }, reached: { before: 1, after: 2 }, exercised: { before: 0.41, after: 0.5 }, tests: { before: 1, after: 2 },
        useful: { before: 1, after: 1 }, redundant: { before: 0, after: 1 }, smelly: { before: 0, after: 0 }, infra: { before: 0, after: 0 },
        untested: { before: 2, after: 1 }, edge_cases: { before: 1, after: 1 },
        ...(measured ? { measured_lines: { before: 0.4, after: 0.55 }, measured_branches: { before: 0.25, after: 0.5 }, suite_seconds: { before: 200.4, after: 190.4 } } : {}) },
      files: [{ path: 'src/cart.py', before: { methods: 2, reached: 0, useful_reached: 0, exercised: 0, tests: 0, useful: 0, redundant: 0, smelly: 0, infra: 0 },
        after: { methods: 2, reached: 1, useful_reached: 1, exercised: 0.25, tests: 0, useful: 0, redundant: 0, smelly: 0, infra: 0 } }],
      methods: [{ id: 'src/cart.py::apply_discount', path: 'src/cart.py', name: 'apply_discount',
        before: { reached: false, exercised: 0, executed: on(false), measured: on({ lines: { hit: 0, total: 9 }, branches: { hit: 0, total: 6 } }) },
        after: { reached: true, exercised: 0.5, executed: on(true), measured: on({ lines: { hit: 6, total: 9 }, branches: { hit: 3, total: 6 } }) } }],
      tests: { added: ['tests/test_cart.py::test_discount_20'], removed: ['tests/test_old.py::test_gone'] },
      findings: {
        fixed: [{ id: 'f4f4f4f4', kind: 'untested', subject: 'method', unit: 'src/cart.py::apply_discount', path: 'src/cart.py', line: 3, name: 'apply_discount', probability: null, note: 'No test reaches apply_discount.' }],
        new: [redundant],
      },
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

describe('coverage HTML report', () => {
  const html = renderCoverageHtml(sampleReport());
  const estimated = renderCoverageHtml(sampleReport({ measured: false }));

  it('puts notes under their lines', () => {
    // The branch note names the problem and says what a test would need, and no percentage when perch is sure (82% is sure enough).
    expect(under(html, 'src/cart.py', 6)).toContain('<b>Untested branch</b> Untested case: apply_discount with a percent over 100.</p>');
    expect(under(html, 'src/cart.py', 6)).not.toContain('% sure');
    // The tests that reach the method are listed once, in its bar above the code, not again in the gap's note.
    expect(under(html, 'src/cart.py', 6)).not.toContain('Reached by');
    expect(under(html, 'src/cart.py', 2)).toContain('test_discount_10');
    expect(under(html, 'src/cart.py', 5)).not.toContain('Untested branch');
    expect(under(html, 'src/cart.py', 7)).not.toContain('Untested branch');
    expect(under(html, 'src/cart.py', 14)).toContain(untested.note);
    // A redundant test's note is a verdict: delete it, and which test it repeats, as a link.
    expect(under(html, 'tests/test_cart.py', 8)).toContain('<b>Duplicate test</b> Same checks and calls as <a href="#file=tests%2Ftest_cart.py&amp;line=3" title="tests/test_cart.py:3">test_discount_10</a>.</p>');
    // A test worth keeping with no problem gets no note and no tint: there is nothing to do about it.
    expect(under(html, 'tests/test_cart.py', 3)).not.toContain('class="note');
    expect(lineClasses(html, 'tests/test_cart.py', 3)).toEqual(['l']);
    expect(lineClasses(html, 'tests/test_cart.py', 8)).toEqual(['l', 'weak']);
    // A test file opens on its problems, each linking to its line.
    const file = html.slice(html.indexOf('<section class="file" data-path="tests/test_cart.py"'));
    const problems = file.slice(file.indexOf('file-problems'), file.indexOf('class="legend"'));
    expect(problems).toContain('Problems <span class="count">1</span>');
    expect(problems).toContain('<a href="#file=tests%2Ftest_cart.py&amp;line=8">tests/test_cart.py:8</a>');
    expect(file.indexOf('file-problems')).toBeLessThan(file.indexOf('class="code"'));
  });

  it('names each problem on a test', () => {
    const report = sampleReport();
    const test = report.tests[1];
    Object.assign(test, { touches: ['filesystem'] });
    const infra = { id: 'i5i5i5i5', kind: 'infra', subject: 'test', unit: test.id, path: test.path, line: 8, name: test.name, probability: 0.62, note: 'Touches filesystem unmocked.' };
    test.findings = [...test.findings, infra.id];
    report.findings = [...report.findings, infra];
    const note = under(renderCoverageHtml(report), 'tests/test_cart.py', 8);
    // What to cut first, then what to mock; how sure perch is only when it is not very.
    expect(note.indexOf('<b>Duplicate test</b>')).toBeLessThan(note.indexOf('<b>Unmocked I/O</b>'));
    expect(note).toContain('<b>Unmocked I/O</b> Touches the disk. <span class="unsure">62% sure</span></p>');
    // Running through other files of this repository is not a problem, and not said.
    expect(note).not.toContain('runs through');
  });

  it('marks only listed untested branches', () => {
    // Under the floor, the edge case is not a finding: the method still has its gap, and the page says nothing about it.
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
    expect(html.match(/<script>/g)).toHaveLength(1);
    const hostile = sampleReport();
    hostile.tests[0].name = '<img src=x onerror=alert(1)>';
    hostile.unmatched_runs[0].name = '<img src=y onerror=alert(2)>';
    const page = renderCoverageHtml(hostile);
    expect(page).not.toContain('<img src=');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).toContain('&lt;img src=y onerror=alert(2)&gt;');
  });

  it('shows changes since the compared run', () => {
    expect(viewOf(html, 'changes')).toContain('Changes since <code>aaaaaaa</code>');
    // Reached went from 1 of 3 to 2 of 3: one phrase with its unit, then the commit.
    expect(card(html, 'Methods tested')).toContain('<span class="delta good">+1 method</span> <span class="since">since aaaaaaa</span>');
    expect(html).toContain('tests/test_old.py::test_gone');
    // A problem that went away is counted, not listed: nothing in such a list asks for anything.
    expect(viewOf(html, 'changes')).toContain('1 problem from that run is gone.');
    expect(html).not.toContain('No test reaches apply_discount.');
    // Without coverage files the branch tile is Jev's estimate, which went from 41% to 50%.
    expect(card(estimated, 'Branches taken')).toContain('<span class="delta good">+9 pts</span>');
    // The header says which run this is compared with; the model, depth and floor are under Run details.
    const top = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(top).toContain('compared with</span><code title="aaaaaaa1111111">aaaaaaa</code>');
    expect(top).not.toContain('jev-1');
    expect(viewOf(html, 'details')).toContain('jev-1');
  });

  it('shows measured changes per method', () => {
    const changes = viewOf(html, 'changes');
    expect(changes).not.toContain('Measured lines');
    expect(card(html, 'Lines run')).toContain('<span class="delta good">+15 pts</span>');
    expect(card(html, 'Branches taken')).toContain('<span class="delta good">+25 pts</span>');
    const row = changes.slice(changes.indexOf('<tr><td><a href="#file=src%2Fcart.py&amp;line=3"'));
    expect(row).toContain('<span class="was">never ran</span> → <b>ran</b>');
    expect(row).toContain('<span class="was">0/9</span> → <b>6/9</b>');
    // Nothing measured, so no method is shown as having run or not.
    expect(estimated).not.toContain('>never ran<');
    // The source table says where things stand; what moved is the Changes view's.
    expect(viewOf(html, 'sources')).not.toContain('class="delta');
  });

  it('labels measured numbers with their source', () => {
    // Four tiles, each linking to the view that breaks it down.
    const tiles = html.slice(html.indexOf('<section class="cards">'), html.indexOf('</section>', html.indexOf('<section class="cards">')));
    expect(tiles.match(/<a class="card" href="#view=/g)).toHaveLength(4);
    expect(html).not.toContain('class="counters"');
    const lines = card(html, 'Lines run');
    expect(lines).toContain('55%');
    expect(lines).toContain('6 of 11 <span class="msr" title="lcov coverage/lcov.info">measured</span>');
    const branches = card(html, 'Branches taken');
    expect(branches).toContain('50%');
    expect(branches).toContain('3 of 6 <span class="msr"');
    expect(branches).not.toContain('estimated');
    // The tests tile is how many tests could go and what cutting them saves, from the JUnit times.
    const tests = card(html, 'Redundant tests');
    // Every calculated number says how it is counted, on hover.
    expect(html).toMatch(/<div class="card-title" title="The number of tests that are duplicate or weak out of the total number of tests/);
    expect(tests).toContain('1<span class="of"> of 2</span>');
    expect(tests).toContain('Saves 41.2s of 3m10s');
    // One more redundant test than the compared run: a change for the worse.
    expect(tests).toContain('<span class="delta bad">+1 test</span>');
    expect(html).not.toContain('>Tests worth keeping</div>');
    // The reports read, with their full paths, are under Run details, not in the header.
    const details = viewOf(html, 'details');
    expect(details).toContain('<td class="path">coverage/lcov.info</td>');
    expect(details).toContain('<td class="path">reports/junit.xml</td>');
    expect(html.slice(html.indexOf('<header'), html.indexOf('</header>'))).not.toContain('lcov');
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
    expect([...summary.matchAll(/<h3>([^<]+?) </g)].map(match => match[1])).toEqual(['Untested code', 'Test problems']);
    // Untested code, riskiest first: apply_discount is risk 12, total 2.
    const untestedCode = summary.slice(summary.indexOf('<h3>Untested code '), summary.indexOf('<h3>Test problems '));
    expect(untestedCode.indexOf('<b>Untested branch</b> <span class="subject">apply_discount</span>')).toBeLessThan(untestedCode.indexOf('<b>No test</b> <span class="subject">total</span>'));
    // What a test needs, in words; the code is one click away, at the line.
    expect(untestedCode).toContain('<td class="why"><span class="clamp">Untested case: apply_discount with a percent over 100.</span></td>');
    expect(untestedCode).not.toContain('if percent');
    expect(untestedCode).toContain('<a href="#file=src%2Fcart.py&amp;line=6">src/cart.py:6</a>');
    // Test problems, with how long each test ran.
    const testProblems = summary.slice(summary.indexOf('<h3>Test problems '));
    expect(testProblems).toContain('<b>Duplicate test</b> <span class="subject">test_discount_20</span>');
    expect(testProblems).toContain('<td class="num">41.2s</td>');
    // The first review is short lists: each problem once, not every list again.
    expect(summary.split('No test reaches total.')).toHaveLength(2);
  });

  it('labels unmeasured numbers as estimates', () => {
    expect(card(estimated, 'Lines run')).toBeNull();
    expect(card(estimated, 'Redundant tests')).toContain('Time not measured');
    const branches = card(estimated, 'Branches taken');
    expect(branches).toContain('50%');
    expect(branches).toContain('estimated by Jev');
    expect(estimated).not.toContain('class="msr"');
    expect(estimated).not.toContain('measured by');
    expect(under(estimated, 'src/cart.py', 2)).toContain('of its branches tested <span class="est">estimate</span>');
    expect(lineClasses(estimated, 'src/cart.py', 4)).not.toContain('ms');
  });

  it('tints methods by measured or estimated coverage', () => {
    // apply_discount ran with 3 of its 6 branches taken; the bar above line 3 is in the markup that follows line 2.
    const discount = under(html, 'src/cart.py', 2);
    expect(discount).toContain('<span class="ran">Ran</span> 6/9 lines, 3/6 branches');
    expect(lineClasses(html, 'src/cart.py', 4)).toEqual(['l', 'part', 'ms']);
    expect(lineClasses(html, 'src/cart.py', 6)).toEqual(['l', 'part', 'ms', 'gapline']);
    expect(under(html, 'src/cart.py', 6)).toContain('<b>Untested branch</b>');
    // total never ran, whatever static reach says.
    expect(under(html, 'src/cart.py', 13)).toContain('<span class="unran">Never ran</span>');
    expect(lineClasses(html, 'src/cart.py', 15)).toEqual(['l', 'none', 'ms']);
    // util.py is not in the coverage file, so round_money is Jev's estimate and its lines carry no measured mark.
    const money = html.slice(html.indexOf('<section class="file" data-path="src/util.py"'));
    expect(money.slice(0, money.indexOf('data-n="1"'))).toContain('<span class="est">estimate</span>');
    expect(lineClasses(html, 'src/util.py', 2)).toEqual(['l', 'full']);
    // Each file's branches share carries the basis the report gives it: cart.py's methods were measured, util.py's estimated.
    const rows = html.slice(html.indexOf('id="sources"'), html.indexOf('</section>', html.indexOf('id="sources"')));
    const cartRow = rows.slice(rows.indexOf('<tr data-path="src/cart.py"'), rows.indexOf('</tr>', rows.indexOf('<tr data-path="src/cart.py"')));
    expect(cartRow).toContain('class="msr"');
    const utilRow = rows.slice(rows.indexOf('<tr data-path="src/util.py"'), rows.indexOf('</tr>', rows.indexOf('<tr data-path="src/util.py"')));
    expect(utilRow).toContain('class="est"');
  });

  it('notes a failed run, not a pass', () => {
    const failed = under(html, 'tests/test_cart.py', 8);
    expect(failed).toContain('<li><span class="unran">Failed</span> in 3 cases.</li>');
    // How long it took is in the tests table; what it runs is in the call graph and the Fix prompt. Neither is repeated here.
    expect(failed).not.toContain('41.2s');
    expect(failed).not.toContain('<details class="calls">');
    const passed = sampleReport();
    passed.tests[1].run = { time: 0.1, status: 'passed', cases: 1 };
    const note = under(renderCoverageHtml(passed), 'tests/test_cart.py', 8);
    expect(note).not.toContain('Passed');
    expect(note).not.toContain('class="facts"');
    expect(under(estimated, 'tests/test_cart.py', 8)).not.toContain('in memory');
  });

  it('marks new problems in place, first in their list', () => {
    const summary = viewOf(html, 'summary');
    // No second list of what is new: the problem is where it belongs, marked and first.
    expect(summary).not.toContain('New since');
    expect(summary).toContain('<span class="new-badge">new</span><b>Duplicate test</b> <span class="subject">test_discount_20</span>');
    expect(summary.split('test_discount_20</span>')).toHaveLength(2);
    // Changes opens on them too.
    const changes = viewOf(html, 'changes');
    expect(changes.indexOf('<h3>New problems</h3>')).toBeLessThan(changes.indexOf('<h3>Files</h3>'));
    // With nothing to compare with, nothing is new.
    expect(viewOf(renderCoverageHtml(sampleReport({ diff: false })), 'summary')).not.toContain('new-badge');
  });

  it('scopes the summary to changed code with --since', () => {
    const branch = { ref: 'origin/main', base: 'aaaaaaa1111111', patch: { hit: 2, total: 5 }, units: ['src/cart.py::total'], findings: [untested.id],
      files: [{ path: 'src/cart.py', changed: 5, patch: { hit: 1, total: 4 }, missed: [9, 10, 14] }, { path: 'src/util.py', changed: 1, patch: null },
        { path: 'src/main.py', changed: 2, patch: { hit: 0, total: 0 }, missed: [] }, { path: 'src/ok.py', changed: 3, patch: { hit: 1, total: 1 }, missed: [] }] };
    const page = renderCoverageHtml({ ...sampleReport(), branch });
    const summary = viewOf(page, 'summary');
    const start = summary.indexOf('Patch coverage <span class="muted">since origin/main</span>');
    expect(start).toBeGreaterThan(-1);
    expect(summary).not.toContain('new-badge');
    expect(start).toBeLessThan(summary.indexOf('<h3>Untested code '));
    const section = summary.slice(start, summary.indexOf('<h3>Untested code '));
    // Only files with changed code the tests missed, with how much, linking to the first such line; and one no report covers.
    expect(section).toContain('<a href="#file=src%2Fcart.py&amp;line=9" title="Open the file at the first one">3</a></td><td class="num"><span class="low-text">25%</span></td>');
    expect(section).toContain('<td class="num"><span class="muted" title="No coverage report covers this file.">not measured</span></td>');
    expect(section).not.toContain('src/ok.py');
    expect(section).not.toContain('src/main.py');
    // No footer: the lists below have their own links, and a file where everything ran has nothing to look at.
    expect(section).not.toContain('panel-foot');
    // The file view marks the changed lines that did not run.
    expect(lineClasses(page, 'src/cart.py', 14)).toContain('miss');
    expect(lineClasses(page, 'src/cart.py', 6)).not.toContain('miss');
    // The lists under it hold only the changed code's problems.
    const lists = summary.slice(summary.indexOf('<h3>Untested code '));
    expect(lists).toContain('<b>No test</b> <span class="subject">total</span>');
    expect(lists).not.toContain('apply_discount');
    expect(summary).not.toContain('test_discount_20');
    // All problems marks which rows are in changed code, and can show those alone.
    const problems = viewOf(page, 'problems');
    expect(problems).toContain('<input type="checkbox" id="changed-only"> Only code changed since origin/main (1)');
    expect(problems.match(/data-changed="1"/g)).toHaveLength(1);
    expect(problems.match(/data-changed="0"/g)).toHaveLength(2);
    // A branch with no problems in what it changed says so under the table.
    expect(viewOf(renderCoverageHtml({ ...sampleReport(), branch: { ...branch, findings: [] } }), 'summary')).toContain('No problems in code changed since origin/main.');
    // The first number is how much of the changed code ran.
    expect(page.indexOf('>Changed lines run</div>')).toBeLessThan(page.indexOf('>Methods tested</div>'));
    expect(card(page, 'Changed lines run')).toContain('2 of 5 changed since origin/main');
    // Without --since there is no such section, number or filter.
    expect(html).not.toContain('Patch coverage');
    expect(html).not.toContain('id="changed-only"');
    expect(card(html, 'Changed lines run')).toBe(null);
  });

  it('copies fix prompts and dismisses problems', () => {
    const data = page => JSON.parse(page.match(/<script type="application\/json" id="perch-fixes">(.*?)<\/script>/s)[1]);
    const fixes = data(html);
    expect(Object.keys(fixes.steps).sort()).toEqual([edge.id, redundant.id, untested.id].sort());
    expect(fixes).toMatchObject({ root: '/work/shop', repo: 'shop' });
    // Every place a problem shows carries its id, a Copy prompt button and a close mark: the summary, All problems, the file view.
    for (const id of [edge.id, redundant.id, untested.id]) expect(html.match(new RegExp(`data-finding="${id}"[^>]*>`, 'g')).length).toBeGreaterThanOrEqual(2);
    const row = viewOf(html, 'problems').match(new RegExp(`<tr data-finding="${redundant.id}".*?</tr>`, 's'))[0];
    expect(row).toContain('<div class="acts"><button type="button" data-copy>Copy prompt</button></div>');
    expect(row).toContain('<td class="x-cell"><button type="button" class="x" data-dismiss title="Dismiss" aria-label="Dismiss">×</button></td>');
    const buttons = '<div class="problem-acts"><div class="acts"><button type="button" data-copy>Copy prompt</button></div><button type="button" class="x" data-dismiss title="Dismiss" aria-label="Dismiss">×</button></div>';
    expect(under(html, 'tests/test_cart.py', 8)).toContain(`<div class="problem" data-finding="${redundant.id}">`);
    expect(under(html, 'tests/test_cart.py', 8)).toContain(buttons);
    expect(under(html, 'src/cart.py', 6)).toContain(`<div class="note gap" data-finding="${edge.id}">`);
    expect(under(html, 'src/cart.py', 6)).toContain(buttons);
    expect(html).not.toContain('class="dismiss"');
    // Each list of problems has one button for all of it: the file's Problems box, Risk, and All problems.
    const file = html.slice(html.indexOf('<section class="file" data-path="src/cart.py"'));
    expect(file.slice(file.indexOf('file-problems'), file.indexOf('class="legend"'))).toContain('<button type="button" class="copy-all" data-copy-all>Copy prompt</button>');
    expect(viewOf(html, 'summary')).toContain('<h3>Untested code <span class="count">2</span> <button type="button" class="copy-all" data-copy-all>Copy prompt</button></h3>');
    expect(viewOf(html, 'problems')).toContain('data-copy-all');
    // No app links: the prompt is copied, to paste into whichever agent you use.
    expect(html).not.toMatch(/claude-cli:|codex:\/\/|cursor:\/\//);
    // The page puts a problem's steps together into the same prompt fixPrompt writes, and a list's into one numbered prompt.
    const script = html.match(/function promptFor[\s\S]*?\n {2}}\n/)[0];
    const promptFor = new Function('fixData', `${script}return promptFor;`)(fixes);
    const index = { methods: new Map(sampleReport().methods.map(item => [item.id, item])), tests: new Map(sampleReport().tests.map(item => [item.id, item])) };
    for (const finding of [edge, redundant, untested]) expect(promptFor([finding.id])).toBe(fixPrompt(finding, sampleReport(), index));
    expect(promptFor([redundant.id])).toBe([
      'perch coverage found a problem in shop.',
      'The test "test_discount_20" (tests/test_cart.py:8) calls the same code and checks the same thing as "test_discount_10" (tests/test_cart.py:3).',
      'Compare the two. Delete this one if it asserts nothing the other does not; otherwise move what differs into the other and delete this one.',
      'Run that test file afterwards and make sure it passes.',
      'Change only what this needs.',
    ].join('\n'));
    const both = promptFor([untested.id, edge.id]);
    expect(both.startsWith('perch coverage found 2 problems in shop. Fix them one at a time.\n\n1. No test runs total (src/cart.py:14). No test reaches total.\n   Write a unit test')).toBe(true);
    expect(both).toContain('\n\n2. Untested case: apply_discount with a percent over 100. The branch is at src/cart.py:6 in apply_discount (src/cart.py:3): `if percent > 100:`.');
    expect(both).toContain('Add a test for that case. Tests that already reach it: "test_discount_10" (tests/test_cart.py:3).');
    expect(both.endsWith('\n\nChange only what each one needs.')).toBe(true);
    // Text from the report cannot end the script it sits in.
    const hostile = sampleReport();
    hostile.findings[0].note = '</script><script>alert(1)</script>';
    expect(data(renderCoverageHtml(hostile)).steps[edge.id]).toBeDefined();
    expect(renderCoverageHtml(hostile).match(/<script>/g)).toHaveLength(1);
  });

  it('lists unmatched runs and paths', () => {
    const runs = html.slice(html.indexOf('id="unmatched-runs"'), html.indexOf('</section>', html.indexOf('id="unmatched-runs"')));
    expect(runs).toContain('Unmatched runs');
    expect(runs).toContain('<td class="path">reports/junit.xml</td><td class="path">tests.test_gone</td><td class="path">test_vanished</td>');
    const paths = html.slice(html.indexOf('id="unmatched-paths"'), html.indexOf('</section>', html.indexOf('id="unmatched-paths"')));
    expect(paths).toContain('Unmatched paths');
    expect(paths).toContain('<td class="path">coverage/lcov.info</td><td class="path">/ci/build/generated/parser.py</td>');
    expect(estimated).not.toContain('Unmatched');
  });

  it('follows the system theme, with a toggle and a wordmark for each', () => {
    expect(html).toContain('<meta name="color-scheme" content="dark light">');
    expect(html).toContain('@media (prefers-color-scheme:light){:root:not([data-theme=dark]){--bg:#f6f7f9;');
    expect(html).toContain(':root[data-theme=light]{--bg:#f6f7f9;');
    expect(html).toContain('<span class="logo-dark"><svg');
    expect(html).toContain('<span class="logo-light"><svg');
    expect(html).toContain('data-theme-toggle');
  });

  it('breaks each test file down by why tests are not worth keeping, and each source file by untested branches', () => {
    const heads = view => [...viewOf(html, view).matchAll(/<th data-sort="[a-z]+"[^>]*>([^<]+)</g)].map(match => match[1]);
    expect(heads('tests')).toEqual(['File', 'Quality', 'Duplicates', 'Weak', 'Unmocked I/O', 'Time', 'Time saved']);
    expect(heads('sources')).toEqual(['File', 'Methods tested', 'Lines run', 'Branches taken', 'Untested branches']);
    // test_cart.py: one duplicate, test_discount_20.
    const row = viewOf(html, 'tests').match(/<tr data-path="tests\/test_cart.py">.*?<\/tr>/s)[0];
    expect(row).toContain('<td class="num" data-v="1">1</td><td class="num zero" data-v="0">0</td><td class="num zero" data-v="0">0</td>');
    // cart.py has the one untested branch.
    expect(viewOf(html, 'sources').match(/<tr data-path="src\/cart.py">.*?<\/tr>/s)[0]).toContain('<td class="num" data-v="1">1</td></tr>');
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
    expect(index.match(/<link\b[^>]*>|<script\b[^>]*>/g)).toEqual(['<link rel="icon" href="data:,">', '<link rel="stylesheet" href="report.css">', '<script type="application/json" id="perch-fixes">', '<script src="report.js">']);
    // A file's page shows that file, goes back to the index, and carries the prompts for its own problems only.
    expect(cart.html).toContain('<section class="file" data-path="src/cart.py">');
    expect(cart.html).toContain('href="../index.html#view=sources"');
    expect(cart.html).toContain('<script src="../report.js">');
    const steps = Object.keys(JSON.parse(cart.html.match(/id="perch-fixes">(.*?)<\/script>/)[1]).steps);
    expect(steps.sort()).toEqual(sampleReport().findings.filter(finding => finding.path === 'src/cart.py').map(finding => finding.id).sort());
    // One page as before when the source fits.
    expect(renderCoverageSite(sampleReport()).index.join('')).toBe(renderCoverageHtml(sampleReport()));
  });

  it('names the nearest fifty tests that reach a method and counts the rest', () => {
    const report = sampleReport();
    const method = report.methods.find(item => item.id === 'src/cart.py::apply_discount');
    const reaching = Array.from({ length: 53 }, (_, at) => ({ ...report.tests[0], id: `tests/test_cart.py::t${at}`, name: `t${at}` }));
    report.tests.push(...reaching);
    method.tests = reaching.map((test, at) => ({ id: test.id, depth: at < 3 ? 3 : 1 }));
    const bar = renderCoverageHtml(report).match(/<ul class="reach">(.*?)<\/ul>/s)[1];
    expect(bar.match(/<li>/g)).toHaveLength(50);
    expect(bar).not.toContain('>t0<');
    expect(bar).toContain('<li class="muted">3 more tests</li>');
  });
});
