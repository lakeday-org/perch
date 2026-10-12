import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { coverageCount, coverageDetails, formatCoverage, formatCoverageDiff, listedFindings, parseCoverageFilters } from '../src/coverage-report.js';

/**
 * A report written out by hand, in the shape the contract gives it, so the formatting is checked against numbers chosen here rather
 * than numbers the engine happened to produce. Two source files, one test file, and findings of three kinds.
 */
const totalsOf = values => ({ methods: 0, covered: 0, useful_covered: 0, mutants: 0, killed: 0, no_coverage: 0, score: null, covered_score: null, survived: 0, tests: 0, useful: 0, redundant: 0, weak: 0, infra: 0, ...values });
const report = {
  revision: '9f8e7d6c5b4a', root: '/repo', created_at: '2026-09-28T10:00:00.000Z', model: 'jev-1', depth: 3, min: 50,
  totals: { methods: 6, covered: 4, useful_covered: 4, mutants: 15, killed: 8, no_coverage: 0, score: 8 / 15, covered_score: 8 / 15, survived: 3,
    tests: 5, useful: 3, redundant: 1, weak: 1, infra: 0, drop: { count: 2, unreached: [] } },
  files: [
    { path: 'src/tax.py', kind: 'source', language: 'python', lines: [], methods: ['m4', 'm5', 'm6'], tests: [],
      totals: totalsOf({ methods: 3, covered: 1, useful_covered: 1, mutants: 3, killed: 1, score: 1 / 3, survived: 2 }) },
    { path: 'src/cart.py', kind: 'source', language: 'python', lines: [], methods: ['m1', 'm2', 'm3'], tests: [],
      totals: totalsOf({ methods: 3, covered: 3, useful_covered: 3, mutants: 12, killed: 7, score: 7 / 12, survived: 1 }) },
    { path: 'tests/test_cart.py', kind: 'test', language: 'python', lines: [], methods: [], tests: ['t1', 't2', 't3', 't4', 't5'],
      totals: totalsOf({ tests: 5, useful: 3, redundant: 1, weak: 1, infra: 0 }) },
  ],
  // The methods the survived mutants are on, with the mutant each finding names, as buildReport writes them.
  methods: [
    { id: 'm1', path: 'src/cart.py', name: 'apply_discount', line: 12, end_line: 20, tests: [{ id: 't1', depth: 1 }, { id: 't2', depth: 1 }], useful: ['t1'], covered: true, killed: 5, equivalent: 0, invalid: 0, asked_tests: 2, findings: ['d4e5f6a7'],
      mutants: [{ id: '17:7:>>>=', kind: 'boundary', line: 17, column: 7, from: '>', to: '>=', original: '', mutated: '' }, { id: '50:9:&&>||', kind: 'logic', line: 50, column: 9, from: '&&', to: '||', original: '', mutated: '' }] },
    { id: 'm4', path: 'src/tax.py', name: 'rate_for', line: 5, end_line: 12, tests: [{ id: 't1', depth: 2 }], useful: ['t1'], covered: true, killed: 1, equivalent: 0, invalid: 0, asked_tests: 1, findings: ['c0ffee11'],
      mutants: [{ id: '9:7:<><=', kind: 'boundary', line: 9, column: 7, from: '<', to: '<=', original: '', mutated: '' }, { id: '10:4:x', kind: 'return', line: 10, column: 4, from: 'rate', to: 'None', original: '', mutated: '' }] },
    { id: 'm5', path: 'src/tax.py', name: 'round_tax', line: 28, end_line: 32, tests: [{ id: 't1', depth: 3 }], useful: ['t1'], covered: true, killed: 0, equivalent: 0, invalid: 0, asked_tests: 1, findings: ['b7d31e22'],
      mutants: [{ id: '30:11:*>/', kind: 'arithmetic', line: 30, column: 11, from: '*', to: '/', original: '', mutated: '' }] },
  ],
  tests: [
    { id: 't1', path: 'tests/test_cart.py' },
    { id: 't2', path: 'tests/test_cart.py' },
  ],
  findings: [
    { id: 'a91c2e0f', kind: 'redundant', subject: 'test', unit: 't2', path: 'tests/test_cart.py', line: 41, name: 'test_discount_20',
      probability: 0.88, note: 'Decides happy_path of apply_discount, like test_discount_10 at line 12.' },
    // One whose method could not be asked, so it carries no probability and no floor can judge it.
    { id: 'b7d31e22', kind: 'survived', subject: 'method', unit: 'm5', mutant: '30:11:*>/', path: 'src/tax.py', line: 30, name: 'round_tax',
      probability: null, note: 'With `/` instead of `*`, the 1 test reaching it still passes.' },
    { id: 'c0ffee11', kind: 'survived', subject: 'method', unit: 'm4', mutant: '9:7:<><=', path: 'src/tax.py', line: 9, name: 'rate_for',
      probability: 0.65, note: 'With `<=` instead of `<`, the 1 test reaching it still passes.' },
    { id: 'd4e5f6a7', kind: 'survived', subject: 'method', unit: 'm1', mutant: '17:7:>>>=', path: 'src/cart.py', line: 17, name: 'apply_discount',
      probability: 0.72, note: 'With `>=` instead of `>`, none of the 2 tests reaching it fails.' },
    // Under the floor, so it is on the report and off the list.
    { id: 'e1e2e3e4', kind: 'survived', subject: 'method', unit: 'm2', mutant: '50:9:&&>||', path: 'src/cart.py', line: 50, name: 'total',
      probability: 0.31, note: 'With `||` instead of `&&`, none of the 2 tests reaching it fails.' },
  ],
  failed: [{ unit: 'm9', subject: 'method', path: 'src/tax.py', name: 'legacy', error: 'too long to send' }],
  baseline: { revision: '1a2b3c4d5e6f', created_at: '2026-09-20T10:00:00.000Z' },
  diff: {
    from: { revision: '1a2b3c4d5e6f', created_at: '2026-09-20T10:00:00.000Z' },
    to: { revision: '9f8e7d6c5b4a', created_at: '2026-09-28T10:00:00.000Z' },
    totals: { methods: { before: 6, after: 6 }, covered: { before: 4, after: 4 }, mutants: { before: 13, after: 15 }, no_coverage: { before: 2, after: 0 }, score: { before: 0.45, after: 0.54 },
      tests: { before: 3, after: 5 }, useful: { before: 2, after: 3 }, redundant: { before: 0, after: 1 }, weak: { before: 1, after: 1 },
      infra: { before: 0, after: 0 }, survived: { before: 4, after: 3 } },
    files: [
      { path: 'src/cart.py', before: totalsOf({ methods: 3, covered: 2, mutants: 10, no_coverage: 2, score: 0.3 }), after: totalsOf({ methods: 3, covered: 3, mutants: 12, score: 0.41 }) },
      { path: 'tests/test_cart.py', before: totalsOf({ tests: 3, useful: 2, weak: 1 }), after: totalsOf({ tests: 5, useful: 3, redundant: 1, weak: 1 }) },
      { path: 'src/old.py', before: totalsOf({ methods: 1, covered: 1, mutants: 3, killed: 3, score: 1 }), after: null },
    ],
    methods: [],
    tests: { added: ['t4', 't5'], removed: [] },
    findings: { fixed: [{}, {}, {}], new: [{}] },
  },
  usage: {},
};

const plain = { width: 160, color: false };
const rowOf = (text, start) => text.split('\n').find(line => line.startsWith(start));

describe('coverage report', () => {
  it('prints source and test tables with totals', () => {
    const text = formatCoverage(report, { min: 0.5, ...plain });
    const source = text.split('\n\n')[0].split('\n');
    expect(source[0]).toMatch(/^Source files\s+Mutation score\s+Survived\s+No coverage$/);
    // Worst first: tax.py at 33% before cart.py at 58%, whatever order the report had them in.
    expect(source.slice(1).map(line => line.split(/\s{2,}/)[0])).toEqual(['src/tax.py', 'src/cart.py', 'All source']);
    // Of cart.py's 12 mutants, 7 are killed, and one survivor is over the floor.
    expect(rowOf(text, 'src/cart.py').split(/\s{2,}/)).toEqual(['src/cart.py', '58% (7 of 12)', '1', '0']);
    // tax.py's two listed survivors: one over the floor, one whose method could not be asked.
    expect(rowOf(text, 'src/tax.py').split(/\s{2,}/)).toEqual(['src/tax.py', '33% (1 of 3)', '2', '0']);
    expect(rowOf(text, 'All source').split(/\s{2,}/)).toEqual(['All source', '53% (8 of 15)', '3', '0']);
    // A file with no mutants is a dash and not a zero; mutants no test reaches are counted apart.
    const bare = { ...report, files: [{ ...report.files[0], totals: totalsOf({ methods: 3, covered: 1, useful_covered: 1 }) }, { ...report.files[1], totals: totalsOf({ methods: 3, covered: 1, mutants: 12, killed: 7, no_coverage: 4, score: 7 / 12 }) }], findings: [] };
    expect(rowOf(formatCoverage(bare, { min: 0.5, ...plain }), 'src/tax.py').split(/\s{2,}/)).toEqual(['src/tax.py', '-', '0', '0']);
    expect(rowOf(formatCoverage(bare, { min: 0.5, ...plain }), 'src/cart.py').split(/\s{2,}/)).toEqual(['src/cart.py', '58% (7 of 12)', '0', '4']);
    // Quality is the tests worth keeping, of all of them; then why the rest are not, and what the tests touch.
    expect(rowOf(text, 'Test files').split(/\s{2,}/)).toEqual(['Test files', 'Quality', 'Duplicates', 'Checks nothing', 'Live services']);
    expect(rowOf(text, 'tests/test_cart.py ').split(/\s{2,}/)).toEqual(['tests/test_cart.py', '60% (3 of 5)', '1', '1', '0']);
    expect(rowOf(text, 'All tests').split(/\s{2,}/)).toEqual(['All tests', '60% (3 of 5)', '1', '1', '0']);
    // A test file with nothing to fix is not a row; it is counted under the table, and alone it is the whole table.
    const fine = { path: 'tests/test_tax.py', kind: 'test', language: 'python', lines: [], methods: [], tests: ['t6'], totals: totalsOf({ tests: 1, useful: 1 }) };
    const withFine = formatCoverage({ ...report, files: [...report.files, fine] }, { min: 0.5, ...plain });
    expect(withFine).not.toContain('tests/test_tax.py');
    expect(withFine.split('\n\n')[1].split('\n').at(-1)).toBe('1 test file has nothing to fix.');
    const allFine = formatCoverage({ ...report, files: [report.files[0], report.files[1], fine] }, { min: 0.5, ...plain });
    expect(allFine.split('\n\n')[1]).toBe('All 1 test file has nothing to fix.');
  });

  it('ranks the methods to add a test to, and says what to add', () => {
    const text = formatCoverage(report, { min: 0.5, ...plain });
    const block = text.split('\n\n')[2].split('\n');
    expect(block[0]).toBe('Where to add tests');
    expect(block[1]).toMatch(/^ {2}Method\s+Where\s+Killed\s+Survived\s+Tests$/);
    // One survivor each, so the method fewer tests reach comes first, then by file and line: rate_for, round_tax, apply_discount.
    // Each is a line of numbers and, under it, the test to add, whole.
    expect(block.slice(2)).toEqual([
      '  rate_for        src/tax.py:5    1 of 2         1      1',
      '    Add a test at the boundary of `<` on line 9, where `<` and `<=` give different results.',
      '  round_tax       src/tax.py:28   0 of 1         1      1',
      '    Add a test that asserts on the arithmetic at line 30, where `*` can become `/`.',
      '  apply_discount  src/cart.py:12  5 of 2         1      2',
      '    Add a test at the boundary of `>` on line 17, where `>` and `>=` give different results.',
    ]);
    // A method with several survivors names the surest and counts the rest; a narrow terminal wraps the sentence rather than cut it.
    const two = { ...report, findings: [...report.findings, { ...report.findings[3], id: 'f0f0f0f0', mutant: '50:9:&&>||', line: 50, probability: 0.6 }] };
    const narrow = formatCoverage(two, { min: 0.5, width: 60, color: false }).split('\n\n')[2].split('\n');
    expect(narrow.slice(2, 5)).toEqual([
      '  apply_discount  src/cart.py:12  5 of 2         2      2',
      '    Add a test at the boundary of `>` on line 17, where `>`',
      '    and `>=` give different results. 1 more edit survives.',
    ]);
    expect(narrow[5]).toMatch(/^ {2}rate_for/);
    expect(narrow.every(line => line.length <= 60)).toBe(true);
  });

  it('lists test problems by file, and every survived mutant with its id under --all', () => {
    const text = formatCoverage(report, { min: 0.5, ...plain });
    // Without --all, the survived mutants are the methods table; the test problems are listed by file after it.
    expect(text.split('\n\n').slice(3).map(block => block.split('\n')[0])).toEqual(['tests/test_cart.py']);
    expect(text).not.toContain('d4e5f6a7');
    const blocks = formatCoverage(report, { min: 0.5, all: true, ...plain }).split('\n\n').slice(3);
    expect(blocks.map(block => block.split('\n')[0])).toEqual(['src/cart.py', 'src/tax.py', 'tests/test_cart.py']);
    expect(blocks[0].split('\n')[1]).toMatch(/^ {2}ID\s+Line\s+Problem\s+Confidence\s+Test or method\s+Note$/);
    expect(blocks[0]).toContain('d4e5f6a7');
    expect(blocks[0]).not.toContain('e1e2e3e4');
    // Within a file, by line.
    expect(blocks[1].split('\n').slice(2).map(line => line.trim().split(/\s+/)[0])).toEqual(['c0ffee11', 'b7d31e22']);
    expect(rowOf(blocks[1], '  c0ffee11').split(/\s{2,}/).slice(1)).toEqual(['c0ffee11', '9', 'survived', '65%', 'rate_for', 'With `<=` instead of `<`, the 1 test reaching it still passes.']);
    expect(rowOf(blocks[1], '  b7d31e22').split(/\s{2,}/).slice(1)).toEqual(['b7d31e22', '30', 'survived', '-', 'round_tax', 'With `/` instead of `*`, the 1 test reaching it still passes.']);
    expect(rowOf(blocks[2], '  a91c2e0f').split(/\s{2,}/).slice(1)).toEqual(['a91c2e0f', '41', 'redundant', '88%', 'test_discount_20',
      'Decides happy_path of apply_discount, like test_discount_10 at line 12.']);
    expect(listedFindings(report, { min: 0.5 }).map(finding => finding.id)).toEqual(['a91c2e0f', 'b7d31e22', 'c0ffee11', 'd4e5f6a7']);
    // --min 0 lists the one under the floor as well.
    expect(formatCoverage(report, { min: 0, all: true, ...plain })).toContain('e1e2e3e4');
  });

  it('cuts long notes to the terminal width', () => {
    const text = formatCoverage(report, { min: 0.5, width: 70, color: false });
    const row = rowOf(text, '  a91c2e0f');
    expect(row.length).toBeLessThanOrEqual(70);
    expect(row.endsWith('…')).toBe(true);
  });

  it('filters problems by kind', () => {
    const filters = parseCoverageFilters('kind=redundant');
    expect(filters).toEqual([{ key: 'kind', value: 'redundant' }]);
    const text = formatCoverage(report, { min: 0.5, filters, ...plain });
    expect(text).toContain('a91c2e0f');
    expect(text).not.toContain('c0ffee11');
    expect(text).not.toContain('b7d31e22');
    expect(text).not.toContain('d4e5f6a7');
    expect(rowOf(text, 'src/cart.py').split(/\s{2,}/)).toEqual(['src/cart.py', '58% (7 of 12)', '1', '0']);
    // A second value is another alternative for the same key, and a spelling with a space or a hyphen is the same kind.
    expect(parseCoverageFilters('kind=checks nothing,redundant')).toEqual([{ key: 'kind', value: 'checks_nothing' }, { key: 'kind', value: 'redundant' }]);
    expect(() => parseCoverageFilters('kind=bogus')).toThrow(/kind "bogus" is not one of survived, redundant, checks_nothing, mocked, infra/);
    expect(() => parseCoverageFilters('type=defect')).toThrow(/filters on kind, not "type"/);
  });

  it('ends with one count line, the way a scan does', () => {
    // Three problems over the floor, and one on a method that could not be asked, which no floor can judge.
    // Survived mutants are on the screen as methods; their ids, which perch close takes, want --all.
    expect(coverageCount(report, { min: 0.5 })).toBe('/repo at commit 9f8e7d6: 6 methods, 5 tests, 4 problems, --all for every mutant, 1 could not be asked (--json)');
    const many = { ...report, failed: [], findings: Array.from({ length: 12 }, (_, at) => ({ ...report.findings[1], id: `f${at}`, unit: `m${at}` })) };
    expect(coverageCount(many, { min: 0.5 })).toBe('/repo at commit 9f8e7d6: 6 methods, 5 tests, 12 problems, 10 of 12 methods shown, --all for the rest');
    expect(coverageCount({ ...report, failed: [], findings: [report.findings[0]] }, { min: 0.5 })).toBe('/repo at commit 9f8e7d6: 6 methods, 5 tests, 1 problem');
    expect(coverageCount(many, { min: 0.5, all: true })).toBe('/repo at commit 9f8e7d6: 6 methods, 5 tests, 12 problems');
    const broken = { ...many, scope: { frameworks: [{ name: 'Jest', config: 'jest.config.js', error: 'no jest' }], left_out: 0 } };
    expect(coverageCount(broken, { min: 0.5, all: true })).toBe('/repo at commit 9f8e7d6: 6 methods, 5 tests, 12 problems, jest.config.js did not load (--verbose)');
  });

  it('keeps what no framework covers for --verbose', () => {
    const scoped = { ...report, scope: { frameworks: [{ name: 'Vitest', version: '2.1.9', config: 'vitest.config.js', tests: 40 }], left_out: 3 } };
    expect(coverageDetails(scoped)).toEqual(['3 files no test framework covers left out']);
    expect(coverageDetails(report)).toEqual([]);
  });

  it('prints per-file changes for --diff', () => {
    const lines = formatCoverageDiff(report, plain).split('\n');
    expect(lines[0].split(/\s{2,}/)).toEqual(['Since 1a2b3c4', 'Mutants', 'Mutation score', 'No coverage', 'Tests', 'Keep', 'Redundant', 'Checks nothing']);
    expect(rowOf(lines.join('\n'), 'src/cart.py').split(/\s{2,}/)).toEqual(['src/cart.py', '12 (+2)', '41% (+11)', '0 (-2)', '0', '0', '0', '0']);
    expect(rowOf(lines.join('\n'), 'src/old.py').split(/\s{2,}/)).toEqual(['src/old.py', '3', '100%', '0', '0', '0', '0', '0', 'removed']);
    expect(rowOf(lines.join('\n'), 'tests/test_cart.py').split(/\s{2,}/)).toEqual(['tests/test_cart.py', '0', '-', '0', '5 (+2)', '3 (+1)', '1 (+1)', '1']);
    expect(lines.at(-1).split(/\s{2,}/)).toEqual(['All', '15 (+2)', '54% (+9)', '0 (-2)', '5 (+2)', '3 (+1)', '1 (+1)', '1']);
    expect(formatCoverageDiff({ ...report, diff: null })).toBe('');
  });
});

describe('coverage report with --since', () => {
  // The branch changed apply_discount and total. The problems on what it changed are the survivor on apply_discount and one under
  // the floor.
  const branch = { ref: 'origin/main', base: '1a2b3c4d5e6f', units: ['m1', 'm2'], findings: ['d4e5f6a7', 'e1e2e3e4'] };
  const onBranch = { ...report, diff: null, failed: [], branch, totals: { ...report.totals, drop: { count: 0 } } };

  it("prints the changed code's problems", () => {
    const text = formatCoverage(onBranch, { min: 0.5, ...plain });
    const [methods, ...rest] = text.split('\n\n');
    expect(rest).toEqual([]);
    expect(methods.split('\n')[0]).toBe('Where to add tests');
    expect(methods.split('\n').slice(2).filter((line, at) => at % 2 === 0).map(line => line.trim().split(/\s{2,}/)[0])).toEqual(['apply_discount']);
    const problems = formatCoverage(onBranch, { min: 0.5, all: true, ...plain }).split('\n\n')[1];
    expect(problems.split('\n')[0]).toBe('src/cart.py');
    expect(problems).toContain('d4e5f6a7');
    // Under the floor, and elsewhere in the repository: neither is listed.
    expect(problems).not.toContain('e1e2e3e4');
    expect(text).not.toContain('a91c2e0f');
    expect(listedFindings(onBranch, { min: 0.5 }).map(finding => finding.id)).toEqual(['d4e5f6a7']);
    // The count line says how many problems are in changed code, and counts the rest apart.
    expect(coverageCount(onBranch, { min: 0.5 })).toBe('/repo at commit 9f8e7d6: 6 methods, 5 tests, 1 problem in changed code, 3 elsewhere, --all for every mutant');
  });

  it('says when nothing changed', () => {
    const quiet = { ...onBranch, branch: { ...branch, units: [], findings: [] } };
    expect(formatCoverage(quiet, { min: 0.5, ...plain })).toBe('No problems in code changed since origin/main.');
    expect(listedFindings(quiet, { min: 0.5 })).toEqual([]);
  });
});

describe('perch coverage', () => {
  function capture() {
    const out = [], err = [];
    return { out, err, io: { stdout: text => out.push(text), stderr: text => err.push(text), env: {} } };
  }

  it('prints its help', async () => {
    const { out, io } = capture();
    expect(await main(['coverage', '--help'], io)).toBe(0);
    expect(out[0]).toContain('perch coverage: Test coverage, and which tests are worth keeping');
    for (const flag of ['--diff REF', '--html FILE', '--filter', '--min', '--paths', '--json']) expect(out[0]).toContain(flag);
    expect(out[0]).not.toContain('--depth');
    expect(out[0]).toContain('PERCH_BASE_URL');
    expect(await main(['--help'], io)).toBe(0);
    expect(out.at(-1)).toContain('coverage [target]');
  });

  it('rejects an unknown kind', async () => {
    const { err, io } = capture();
    expect(await main(['coverage', '--filter', 'kind=bogus'], io)).toBe(2);
    expect(err.join('\n')).toContain('kind "bogus" is not one of survived, redundant, checks_nothing, mocked, infra');
    expect(err.join('\n')).toContain('perch coverage --help');
    expect(await main(['coverage', '--closed'], io)).toBe(2);
  });
});
