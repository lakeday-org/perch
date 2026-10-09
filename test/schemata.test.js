import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { mutantsOf } from '../src/mutants.js';
import { instrument, PRELUDE, TS_HEAD } from '../src/runners/schemata.js';

/** A program with every kind of edit in it, and the calls whose results must tell each mutant apart from the code as written. */
const PROGRAM = `"use strict";
function clamp(value, low = 0, high = 100) {
  if (value < low) return low;
  if (value > high) { return high; }
  return value;
}
function total(items, rate) {
  let sum = 0;
  for (let at = 0; at < items.length; at++) sum += items[at].price * (1 - rate);
  const names = items.filter(item => item.price > 10).map(item => item.name.trim().toUpperCase());
  log(names.join(','));
  return { sum: Math.round(sum * 100) / 100, names, first: items[0]?.name ?? 'none', valid: !items.some(item => item.price < 0) };
}
function label(text) {
  const tidy = text.startsWith(' ') ? text.trimStart() : text;
  return /^[a-z]+\\d*$/.test(tidy) ? \`ok:\${tidy}\` : tidy === '' ? [] : -tidy.length;
}
class Cart {
  constructor(owner) { this.owner = owner; this.items = []; }
  add(item) { this.items.push(item); return this.items.length >= 2 && item.price !== 0; }
}
`;
const CALLS = `[clamp(-5), clamp(500), clamp(42, 50), total([{ name: ' a ', price: 20 }, { name: 'b', price: 5 }], 0.1), total([], 0),
  label('abc1'), label(' X'), label(''), (() => { const cart = new Cart('me'); return [cart.add({ price: 1 }), cart.add({ price: 0 }), cart.owner]; })(), logged]`;

/** What the calls return, or the error they throw, with the switch set to `active`. */
function outcome(code, active) {
  const context = { globalThis: undefined, logged: [] };
  context.globalThis = context;
  context.__perch_state = { active, test: '', hits: null };
  try {
    return JSON.stringify(runInNewContext(`const logged = []; function log(text) { logged.push(text); }\n${code}\n;${CALLS}`, context, { timeout: 1000 }));
  } catch (error) { return `threw ${error.constructor?.name ?? 'Error'}`; }
}

/** The program with one mutant's edit written in, as perch wrote it before. */
function written(source, mutant) {
  const start = source.split('\n').slice(0, mutant.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + mutant.column;
  return `${source.slice(0, start)}${mutant.to}${source.slice(start + mutant.from.length)}`;
}

describe('mutant schemata', () => {
  it('runs every mutant exactly as the edit written into the file runs, and the code as written with none on', () => {
    const lines = PROGRAM.split('\n').length;
    const mutants = [];
    for (const [line, end_line] of [[2, 6], [7, 13], [14, 17], [19, 19], [20, 20]]) mutants.push(...mutantsOf({ source: PROGRAM, language: 'javascript', line, end_line }));
    expect(mutants.length).toBeGreaterThan(60);
    const { text, unplaced } = instrument({ source: PROGRAM, language: 'javascript', mutants: mutants.map((mutant, id) => ({ id, mutant })), prelude: PRELUDE, head: TS_HEAD });
    // The constructor's body holds no super() call, so every mutant has a place.
    expect(unplaced).toEqual([]);
    expect(text.startsWith('// @ts-nocheck\n"use strict";\nvar __perch')).toBe(true);
    expect(outcome(text, -1)).toBe(outcome(PROGRAM, -1));
    const differing = [];
    for (const [id, mutant] of mutants.entries()) {
      const expected = outcome(written(PROGRAM, mutant), -1), actual = outcome(text, id);
      if (expected !== actual) differing.push({ kind: mutant.kind, line: mutant.line, from: mutant.from, to: mutant.to, expected, actual });
    }
    expect(differing).toEqual([]);
    expect(lines).toBeGreaterThan(10);
  });

  it('compiles as TypeScript and JSX, and records which switches a test reaches', () => {
    const source = 'export function greet(name: string, loud?: boolean): string {\n  const text: string = `hi ${name}`;\n  return loud ? text.toUpperCase() : text;\n}\nexport const View = (props: { n: number }) => <p title="x">{props.n > 1 ? "many" : "one"}</p>;\n';
    const mutants = [...mutantsOf({ source, language: 'tsx', line: 1, end_line: 4 }), ...mutantsOf({ source, language: 'tsx', line: 5, end_line: 5 })];
    const { text, unplaced } = instrument({ source, language: 'tsx', mutants: mutants.map((mutant, id) => ({ id, mutant })), prelude: PRELUDE, head: TS_HEAD });
    expect(unplaced).toEqual([]);
    expect(() => transformSync(text, { loader: 'tsx', jsx: 'automatic' })).not.toThrow();
    expect(text).toContain('title={(__perch(');
    // Run with coverage on, as a test: which switches the call reached are recorded against the test's name.
    const js = transformSync(text, { loader: 'tsx', format: 'cjs', jsx: 'transform', jsxFactory: 'h' }).code;
    const module = { exports: {} };
    const context = { module, exports: module.exports, h: () => null, process: { env: { PERCH_COVERAGE: '1' } } };
    context.globalThis = context;
    runInNewContext(js, context);
    context.__perch_state.test = 'greets';
    module.exports.greet('ann', false);
    const reached = [...context.__perch_state.hits.get('greets')].map(id => mutants[id].kind);
    // The condition was reached and so was the ternary's else; `toUpperCase` is in the branch not taken.
    expect(reached).toContain('condition');
    expect(reached).not.toContain('method');
  });

  it('leaves out an edit with no place to run, and says why', () => {
    const source = 'class A extends B {\n  constructor() {\n    super(1);\n    this.x = 2;\n  }\n}\n';
    const mutants = mutantsOf({ source, language: 'javascript', line: 2, end_line: 5 });
    const { unplaced } = instrument({ source, language: 'javascript', mutants: mutants.map((mutant, id) => ({ id, mutant })), prelude: PRELUDE, head: TS_HEAD });
    expect(unplaced.map(item => [mutants[item.id].kind, item.reason])).toEqual([['body', 'a constructor\'s body must call super() itself']]);
  });
});
