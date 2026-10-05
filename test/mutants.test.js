import { describe, expect, it } from 'vitest';
import { MAX_MUTANTS, mutantsOf } from '../src/mutants.js';

const edits = mutants => mutants.map(mutant => `${mutant.kind} ${mutant.line} ${mutant.from}>${mutant.to}`);

describe('mutants', () => {
  it('plants a boundary, a swapped connective, a negated condition, a dropped not, an arithmetic swap, a flipped boolean and a zeroed return', () => {
    const source = 'function f(a, b) {\n  if (a >= 100 && !b) return 0;\n  while (a < b) a++;\n  return a - b * 2 ? true : false;\n}\n';
    const mutants = mutantsOf({ source, language: 'javascript', line: 1, end_line: 5 });
    expect(edits(mutants)).toEqual([
      'boundary 2 >=>>', 'boundary 3 <><=',
      'logic 2 &&>||',
      'condition 2 a >= 100 && !b>!(a >= 100 && !b)', 'condition 3 a < b>!(a < b)',
      'not 2 !b>b',
      'arithmetic 4 ->+', 'arithmetic 4 *>/',
      'boolean 4 true>false', 'boolean 4 false>true',
    ]);
    // The first ten of eleven: the zeroed return is the least telling and falls off.
    expect(mutants).toHaveLength(MAX_MUTANTS);
    expect(mutants[0]).toMatchObject({ line: 2, column: 8, original: '  if (a >= 100 && !b) return 0;', mutated: '  if (a > 100 && !b) return 0;' });
  });

  it('reads the operators each grammar spells differently', () => {
    const python = mutantsOf({ source: 'def f(a, b):\n    if a >= 100 and not b:\n        return 0\n    return True\n', language: 'python', line: 1, end_line: 4 });
    expect(edits(python)).toEqual(['boundary 2 >=>>', 'logic 2 and>or', 'condition 2 a >= 100 and not b>not (a >= 100 and not b)', 'not 2 not b>b', 'boolean 4 True>False', 'return 3 0>1']);
    const rust = mutantsOf({ source: 'fn f(a: i32, b: bool) -> i32 {\n    if a >= 100 && !b { return 0; }\n    if let Some(x) = g() { return x; }\n    a - 2\n}\n', language: 'rust', line: 1, end_line: 5 });
    expect(edits(rust)).toEqual(['boundary 2 >=>>', 'logic 2 &&>||', 'condition 2 a >= 100 && !b>!(a >= 100 && !b)', 'not 2 !b>b', 'arithmetic 4 ->+', 'return 2 0>1']);
    const cpp = mutantsOf({ source: 'int f(int a, bool b) {\n  if (a >= 100 && !b) return 0;\n  return a - 2;\n}\n', language: 'cpp', line: 1, end_line: 4 });
    expect(edits(cpp)).toEqual(['boundary 2 >=>>', 'logic 2 &&>||', 'condition 2 a >= 100 && !b>!(a >= 100 && !b)', 'not 2 !b>b', 'arithmetic 3 ->+', 'return 2 0>1']);
    const java = mutantsOf({ source: 'class C {\n  int f(int a, boolean b) {\n    if (a >= 100 && !b) return 0;\n    return a - 2;\n  }\n}\n', language: 'java', line: 2, end_line: 5 });
    expect(edits(java)).toEqual(['boundary 3 >=>>', 'logic 3 &&>||', 'condition 3 a >= 100 && !b>!(a >= 100 && !b)', 'not 3 !b>b', 'arithmetic 4 ->+', 'return 3 0>1']);
    const go = mutantsOf({ source: 'package p\nfunc f(a int, b bool) int {\n  if a >= 100 && !b { return 0 }\n  return a - 2\n}\n', language: 'go', line: 2, end_line: 5 });
    expect(edits(go)).toEqual(['boundary 3 >=>>', 'logic 3 &&>||', 'condition 3 a >= 100 && !b>!(a >= 100 && !b)', 'not 3 !b>b', 'arithmetic 4 ->+']);
  });

  it('reads C#, Swift and Scala operators, negations, conditions and returns', () => {
    const csharp = mutantsOf({ source: 'class C {\n  int F(int a, bool b) {\n    if (a >= 100 || !b) return 0;\n    while (a < 0) a++;\n    return a - 2;\n  }\n}\n', language: 'c_sharp', line: 2, end_line: 6 });
    expect(edits(csharp)).toEqual(['boundary 3 >=>>', 'boundary 4 <><=', 'logic 3 ||>&&', 'condition 3 a >= 100 || !b>!(a >= 100 || !b)', 'condition 4 a < 0>!(a < 0)', 'not 3 !b>b', 'arithmetic 5 ->+', 'return 3 0>1']);
    // Swift reads `a >= 100 || !b` as an infix_expression with a custom operator, and a return as a control transfer.
    const swift = mutantsOf({ source: 'func f(_ a: Int, _ b: Bool) -> Int {\n    if a >= 100 || !b { return 0 }\n    if a > 5 { return 1 }\n    return a - 2\n}\n', language: 'swift', line: 1, end_line: 5 });
    expect(edits(swift)).toEqual(['boundary 2 >=>>', 'boundary 3 >>>=', 'logic 2 ||>&&', 'condition 2 a >= 100 || !b>!(a >= 100 || !b)', 'condition 3 a > 5>!(a > 5)', 'not 2 !b>b', 'arithmetic 4 ->+', 'return 2 0>1', 'return 3 1>0']);
    // Scala writes every binary operator as an infix_expression whose operator is a named operator_identifier.
    const scala = mutantsOf({ source: 'object C {\n  def f(a: Int, b: Boolean): Int = {\n    if (a >= 100 || !b) return 0\n    a - 2\n  }\n}\n', language: 'scala', line: 2, end_line: 5 });
    expect(edits(scala)).toEqual(['boundary 3 >=>>', 'logic 3 ||>&&', 'condition 3 a >= 100 || !b>!(a >= 100 || !b)', 'not 3 !b>b', 'arithmetic 4 ->+', 'return 3 0>1']);
    // A Scala infix method call, `a max b`, is no operator to mutate.
    expect(mutantsOf({ source: 'object C {\n  def f(a: Int, b: Int): Int = a max b\n}\n', language: 'scala', line: 2, end_line: 2 })).toEqual([]);
  });

  it('keeps to the method it is given', () => {
    const source = 'function a() {\n  return 1 < 2;\n}\nfunction b() {\n  return 3 > 4;\n}\n';
    expect(edits(mutantsOf({ source, language: 'javascript', line: 4, end_line: 6 }))).toEqual(['boundary 5 >>>=']);
  });
});
