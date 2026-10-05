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

  it('reads Ruby, PHP and Lua methods', () => {
    // Ruby's `return 0 if ...` and `unless` are conditions with the branch written first; each still has one condition to negate.
    const ruby = mutantsOf({ source: 'def discount(total, percent)\n  return 0 if percent >= 100 && !total.nil?\n  total += 1 unless total.zero?\n  total - total * percent / 100\nend\n', language: 'ruby', line: 1, end_line: 5 });
    expect(edits(ruby)).toEqual(['boundary 2 >=>>', 'logic 2 &&>||', 'condition 2 percent >= 100 && !total.nil?>!(percent >= 100 && !total.nil?)', 'condition 3 total.zero?>!(total.zero?)',
      'not 2 !total.nil?>total.nil?', 'arithmetic 4 ->+', 'arithmetic 4 *>/', 'arithmetic 4 />*', 'return 2 0>1']);
    const php = mutantsOf({ source: '<?php\nfunction discount(int $total, int $percent): int {\n    if ($percent >= 100 || !$total) {\n        return 0;\n    }\n    return $total - $total * $percent / 100;\n}\n', language: 'php', line: 2, end_line: 7 });
    expect(edits(php)).toEqual(['boundary 3 >=>>', 'logic 3 ||>&&', 'condition 3 $percent >= 100 || !$total>!($percent >= 100 || !$total)', 'not 3 !$total>$total',
      'arithmetic 6 ->+', 'arithmetic 6 *>/', 'arithmetic 6 />*', 'return 4 0>1']);
    // Lua spells negation `not` and inequality `~=`.
    const lua = mutantsOf({ source: 'function M.discount(total, percent)\n  if percent >= 100 or not total then return 0 end\n  while total ~= 0 do total = total - 1 end\n  return total - total * percent / 100\nend\n', language: 'lua', line: 1, end_line: 5 });
    expect(edits(lua)).toEqual(['boundary 2 >=>>', 'boundary 3 ~=>==', 'logic 2 or>and', 'condition 2 percent >= 100 or not total>not (percent >= 100 or not total)', 'condition 3 total ~= 0>not (total ~= 0)',
      'not 2 not total>total', 'arithmetic 3 ->+', 'arithmetic 4 ->+', 'arithmetic 4 *>/', 'arithmetic 4 />*']);
    expect(edits(mutantsOf({ source: 'function f(a)\n  if a == 1 then return true end\n  return false\nend\n', language: 'lua', line: 1, end_line: 4 })))
      .toEqual(['boundary 2 ==>~=', 'condition 2 a == 1>not (a == 1)', 'boolean 2 true>false', 'boolean 3 false>true']);
  });

  it('keeps to the method it is given', () => {
    const source = 'function a() {\n  return 1 < 2;\n}\nfunction b() {\n  return 3 > 4;\n}\n';
    expect(edits(mutantsOf({ source, language: 'javascript', line: 4, end_line: 6 }))).toEqual(['boundary 5 >>>=']);
  });
});
