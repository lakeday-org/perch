import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { revision } from '../src/git.js';
import { createSourceAnalyzer } from '../src/analysis.js';
import { checkTarget } from '../src/check.js';
import { scanRepository } from '../src/scan.js';
import { methodStep, methodSteps } from '../src/questions.js';
import { commitAll, makeGraphFixture, scriptedSystemOne } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** Every state a run asked a method question over, by method, as the text an endpoint would cache its answers under. */
const methodStates = systemOne => new Map(systemOne.calls.filter(call => call.state.method).map(call => [call.method, JSON.stringify(call.state)]));

describe('the state a method is asked over', () => {
  const file = [
    'const LIMIT = 3;',
    '',
    '/** Halves x, rounding down. */',
    'function half(x) {',
    '  return Math.floor(x / 2);',
    '}',
    '',
    '// Clamps x to LIMIT after halving it.',
    'function small(x) {',
    '  return Math.min(half(x), LIMIT);',
    '}',
    '',
    '/** Every item made small. */',
    'function all(items) {',
    '  return items.map(item => small(item));',
    '}',
  ];
  /** The same three methods with `above` lines put in before any of them, the way an added import or constant moves a file. */
  const placed = (above = 0) => {
    const lines = [...Array.from({ length: above }, () => ''), ...file];
    const node = (name, line, end) => ({ id: `a.js::${name}`, path: 'a.js', qualified_name: name, line: line + above, end_line: end + above, metrics: { risk_score: 12 } });
    return { node: node('small', 9, 11), lines,
      callees: [{ node: node('half', 4, 6), lines }],
      callers: [{ node: node('all', 14, 16), lines, site: 15 + above }],
      edges: [['a.js::small', 'a.js::half'], ['a.js::all', 'a.js::small']] };
  };

  it('is the method and its call graph, each under the comment above it, with no line numbers', () => {
    const { state } = methodStep(placed());
    expect(state).toEqual({
      method: { path: 'a.js', name: 'small', metrics: { risk_score: 12 }, source: '// Clamps x to LIMIT after halving it.\nfunction small(x) {\n  return Math.min(half(x), LIMIT);\n}' },
      graph: {
        nodes: [
          { id: 'a.js::half', path: 'a.js', source: '/** Halves x, rounding down. */\nfunction half(x) {\n  return Math.floor(x / 2);\n}' },
          { id: 'a.js::all', path: 'a.js', source: '/** Every item made small. */\nfunction all(items) {\n  return items.map(item => small(item));\n}' },
        ],
        edges: ['a.js::small -> a.js::half', 'a.js::all -> a.js::small'],
      },
    });
  });

  it('is the same state wherever the method sits in its file', () => {
    const before = methodSteps(placed()), after = methodSteps(placed(7));
    expect(after.map(step => step.state)).toEqual(before.map(step => step.state));
    expect(after.map(step => step.questions)).toEqual(before.map(step => step.questions));
    // What moved is kept on this side: the lines a reading covered are the file's own.
    expect(before[0].covers).toMatchObject({ line: 9, end_line: 11 });
    expect(after[0].covers).toMatchObject({ line: 16, end_line: 18 });
  });

  it('centers a long caller on its call without saying which line that is', () => {
    const body = Array.from({ length: 200 }, (_, index) => (index === 150 ? '  small(total);' : `  total += ${index};`));
    const at = above => {
      const lines = [...Array.from({ length: above }, () => ''), 'function long(total) {', ...body, '}'];
      const caller = { node: { id: 'b.js::long', path: 'b.js', qualified_name: 'long', line: above + 1, end_line: above + 202 }, lines, site: above + 152 };
      return methodStep({ ...placed(), callers: [caller], edges: [['b.js::long', 'a.js::small']] }).state.graph.nodes.at(-1);
    };
    expect(at(0).source).toContain('  small(total);');
    expect(at(0).source).toMatch(/^\.\.\. \(\d+ lines above\)\n/);
    expect(at(40)).toEqual(at(0));
  });

  it('says a caller hands the method on rather than calling it', () => {
    const { callers, ...rest } = placed();
    const { state } = methodStep({ ...rest, callers: [{ ...callers[0], handover: true }] });
    expect(state.graph.nodes.at(-1).note).toContain('passes it on to be called later');
  });

  it('keeps a top-level unit to its own lines without numbering the ones left out', () => {
    const lines = ['const LIMIT = 3;', '', 'function half(x) {', '  return x / 2;', '}', '', 'run(LIMIT);'];
    const node = { id: 'a.js::<top-level>', path: 'a.js', qualified_name: '<top-level>', line: 1, end_line: 7, lines: [1, 2, 6, 7] };
    const [step] = methodSteps({ node, lines });
    expect(step.state.method.source).toBe('const LIMIT = 3;\n\n... (read on its own)\n\nrun(LIMIT);');
    expect(step.covers).toMatchObject({ line: 1, end_line: 7 });
  });
});

describe('a repository scanned again after a line was added above its methods', () => {
  it('asks over the same state for every method, so every cached answer is still the answer', async () => {
    const root = await makeGraphFixture(); cleanups.push(root);
    const scan = async () => {
      const systemOne = scriptedSystemOne();
      await scanRepository({ root, revision: await revision(root), out: join(root, '.perch'), analyzer, systemOne, paths: [] });
      return methodStates(systemOne);
    };
    const before = await scan();
    expect([...before.keys()].sort()).toEqual(['src/a.js::f', 'src/a.js::g', 'src/b.js::h', 'src/b.js::k']);
    for (const path of ['src/a.js', 'src/b.js']) await writeFile(join(root, path), `\n${await readFile(join(root, path), 'utf8')}`);
    await commitAll(root, 'a blank line at the top of each source file');
    await rm(join(root, '.perch'), { recursive: true, force: true });
    const after = await scan();
    for (const [method, state] of before) expect(after.get(method), method).toBe(state);
  });
});

describe('perch check on a method a scan has read', () => {
  it('asks over the state the scan asked over', async () => {
    const root = await makeGraphFixture(); cleanups.push(root);
    const options = { root, revision: await revision(root), out: join(root, '.perch'), analyzer };
    const scanned = scriptedSystemOne(), checked = scriptedSystemOne();
    await scanRepository({ ...options, systemOne: scanned, paths: [] });
    for (const target of ['src/a.js::f', 'src/b.js::h']) await checkTarget({ ...options, target, systemOne: checked });
    const fromScan = methodStates(scanned), fromCheck = methodStates(checked);
    expect([...fromCheck.keys()].sort()).toEqual(['src/a.js::f', 'src/b.js::h']);
    for (const [method, state] of fromCheck) expect(state, method).toBe(fromScan.get(method));
    // Both callers and callees are in it, and the calls between them, which a check used to leave out.
    expect(JSON.parse(fromCheck.get('src/b.js::h')).graph.edges).toEqual(expect.arrayContaining(['src/a.js::f -> src/b.js::h', 'src/b.js::h -> src/b.js::k']));
  });

  it('asks over the same state after lines are added above the method on disk', async () => {
    const root = await makeGraphFixture(); cleanups.push(root);
    const options = { root, revision: await revision(root), out: join(root, '.perch'), analyzer };
    const check = async () => {
      const systemOne = scriptedSystemOne();
      await checkTarget({ ...options, target: 'src/a.js::g', systemOne });
      return methodStates(systemOne).get('src/a.js::g');
    };
    const before = await check();
    await writeFile(join(root, 'src', 'a.js'), `// moved\n\n${await readFile(join(root, 'src', 'a.js'), 'utf8')}`);
    expect(await check()).toBe(before);
  });
});
