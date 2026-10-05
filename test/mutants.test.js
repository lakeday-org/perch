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

  it('reads Zig and Solidity, whose grammars wrap every operand', () => {
    // Zig's operator sits in a CompareOp or AdditionOp node, `and` is a bare keyword, the condition is the IfPrefix's first child,
    // `return 0` is an AssignExpr opened by the keyword, and the literal sits under an ErrorUnionExpr and a SuffixExpr.
    const zig = mutantsOf({ source: 'fn f(a: i32, b: bool) i32 {\n    if (a >= 100 and !b) return 0;\n    while (a < 3) {}\n    return a - 2;\n}\n', language: 'zig', line: 1, end_line: 5 });
    expect(edits(zig)).toEqual(['boundary 2 >=>>', 'boundary 3 <><=', 'logic 2 and>or', 'condition 2 a >= 100 and !b>!(a >= 100 and !b)', 'condition 3 a < 3>!(a < 3)', 'not 2 !b>b', 'arithmetic 4 ->+', 'return 2 0>1']);
    // Solidity's boolean_literal holds a `true` node, read once; a returned literal is read through its `expression`.
    const solidity = mutantsOf({ source: 'contract C {\n  function f(uint256 a, bool b) internal pure returns (uint256) {\n    if (a >= 100 || !b) return 0;\n    bool c = true;\n    return a - 2;\n  }\n}\n', language: 'solidity', line: 2, end_line: 6 });
    expect(edits(solidity)).toEqual(['boundary 3 >=>>', 'logic 3 ||>&&', 'condition 3 a >= 100 || !b>!(a >= 100 || !b)', 'not 3 !b>b', 'arithmetic 5 ->+', 'boolean 4 true>false', 'return 3 0>1']);
  });

  it('keeps to the method it is given', () => {
    const source = 'function a() {\n  return 1 < 2;\n}\nfunction b() {\n  return 3 > 4;\n}\n';
    expect(edits(mutantsOf({ source, language: 'javascript', line: 4, end_line: 6 }))).toEqual(['boundary 5 >>>=']);
  });
});
