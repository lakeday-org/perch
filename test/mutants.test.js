import { describe, expect, it } from 'vitest';
import { describeMutant, KINDS, mutantId, mutantsOf } from '../src/mutants.js';

const edits = mutants => mutants.map(mutant => `${mutant.kind} ${mutant.line} ${mutant.from}>${mutant.to}`);

describe('mutants', () => {
  it('makes every mutant of a method, in the order they sit in it', () => {
    const source = 'function f(a, b) {\n  if (a >= 100 && !b) return 0;\n  while (a < b) a++;\n  return a - b * 2 ? true : false;\n}\n';
    const mutants = mutantsOf({ source, language: 'javascript', line: 1, end_line: 5 });
    expect(edits(mutants)).toEqual([
      // The if: its condition forced either way, the boundary, the number, the connective, the dropped not, the returned number.
      'condition 2 a >= 100 && !b>true', 'condition 2 a >= 100 && !b>false', 'boundary 2 >=>>', 'number 2 100>101', 'logic 2 &&>||', 'not 2 !b>b', 'return 2 0>1',
      // A loop is only ever forced false: forced true it would never end.
      'condition 3 a < b>false', 'boundary 3 <><=', 'update 3 ++>--',
      // A returned expression that is no literal is returned as null in a language where that runs.
      'return 4 a - b * 2 ? true : false>null', 'arithmetic 4 ->+', 'arithmetic 4 *>/', 'number 4 2>3', 'boolean 4 true>false', 'boolean 4 false>true',
    ]);
    // No cap: a method with sixteen mutants is asked about sixteen.
    expect(mutants).toHaveLength(16);
    expect(mutants[2]).toMatchObject({ line: 2, column: 8, original: '  if (a >= 100 && !b) return 0;', mutated: '  if (a > 100 && !b) return 0;' });
    for (const mutant of mutants) expect(KINDS).toContain(mutant.kind);
  });

  it('removes calls, empties bodies, empties strings and replaces returned values', () => {
    const source = 'function f(items, n) {\n  save(items);\n  await flush();\n  n += 1;\n  const name = "hello";\n  if (n > 2) { log("big"); return "x"; } else { return []; }\n  return { a: 1 };\n}\n';
    const mutants = mutantsOf({ source, language: 'javascript', line: 1, end_line: 8 });
    expect(edits(mutants)).toEqual([
      'removal 2 save(items);>', 'removal 3 await flush();>',
      'update 4 +=>-=', 'number 4 1>0',
      'string 5 "hello">""',
      'condition 6 n > 2>true', 'condition 6 n > 2>false', 'boundary 6 >>>=', 'number 6 2>3', 'block 6 { log("big"); return "x"; }>{}', 'removal 6 log("big");>', 'string 6 "big">""', 'return 6 "x">""',
      // `return []` is empty already; `return { a: 1 }` empties, and the 1 in it moves.
      'return 7 { a: 1 }>{}', 'number 7 1>0',
    ]);
    expect(mutants[0]).toMatchObject({ column: 2, original: '  save(items);', mutated: '  ' });
    expect(describeMutant(mutants[0])).toBe('the call `save(items);` removed');
    expect(describeMutant(mutants[9])).toBe("the branch's body emptied");
    expect(describeMutant(mutants[5])).toBe('`true` as the condition');
    expect(describeMutant(mutants[7])).toBe('`>=` instead of `>`');
  });

  it('leaves names, loads and docstrings alone', () => {
    // super() stays, require's argument is a name, an object's key is a name but its value is a value, "use strict" is a statement.
    const source = 'class A extends B {\n  constructor() {\n    super();\n    const fs = require("node:fs");\n    this.map = { key: "value" };\n    "use strict";\n  }\n}\n';
    expect(edits(mutantsOf({ source, language: 'javascript', line: 2, end_line: 7 }))).toEqual(['string 5 "value">""']);
    const python = 'def f(items):\n    """Saves."""\n    import os\n    if items:\n        save(items)\n        log("saved")\n    return [1, -2]\n';
    const mutants = mutantsOf({ source: python, language: 'python', line: 1, end_line: 7 });
    expect(edits(mutants)).toEqual([
      'condition 4 items>True', 'condition 4 items>False', 'block 5 save(items)\n        log("saved")>pass', 'removal 5 save(items)>pass', 'removal 6 log("saved")>pass', 'string 6 "saved">""',
      'return 7 [1, -2]>[]', 'number 7 1>0', 'negative 7 -2>2', 'number 7 2>3',
    ]);
    // An emptied body spans lines: the lines it touches are given both ways.
    expect(mutants[2]).toMatchObject({ line: 5, column: 8, original: '        save(items)\n        log("saved")', mutated: '        pass' });
  });

  it('keeps a call that is a block\'s value', () => {
    // Rust's tail expression is the function's value; the statement before it is not.
    expect(edits(mutantsOf({ source: 'fn f(a: i32) -> String {\n    log(a);\n    a.to_string()\n}\n', language: 'rust', line: 1, end_line: 4 }))).toEqual(['removal 2 log(a);>']);
    // Ruby's `return 0 if x` has no body apart from the statement; emptying it would leave a bare `if`.
    const ruby = mutantsOf({ source: 'def discount(total, percent)\n  return 0 if percent >= 100 && !total.nil?\n  total += 1 unless total.zero?\n  total - total * percent / 100\nend\n', language: 'ruby', line: 1, end_line: 5 });
    expect(edits(ruby)).toEqual([
      'return 2 0>1', 'condition 2 percent >= 100 && !total.nil?>true', 'condition 2 percent >= 100 && !total.nil?>false', 'boundary 2 >=>>', 'number 2 100>101', 'logic 2 &&>||', 'not 2 !total.nil?>total.nil?',
      'update 3 +=>-=', 'number 3 1>0', 'condition 3 total.zero?>true', 'condition 3 total.zero?>false',
      'arithmetic 4 ->+', 'arithmetic 4 *>/', 'arithmetic 4 />*', 'number 4 100>101',
    ]);
  });

  it('reads the operators each grammar spells differently', () => {
    const python = mutantsOf({ source: 'def f(a, b):\n    if a >= 100 and not b:\n        return 0\n    return True\n', language: 'python', line: 1, end_line: 4 });
    expect(edits(python)).toEqual(['condition 2 a >= 100 and not b>True', 'condition 2 a >= 100 and not b>False', 'boundary 2 >=>>', 'number 2 100>101', 'logic 2 and>or', 'not 2 not b>b',
      'block 3 return 0>pass', 'return 3 0>1', 'boolean 4 True>False']);
    // `if let` binds a pattern and has no condition to force; its body still empties.
    const rust = mutantsOf({ source: 'fn f(a: i32, b: bool) -> i32 {\n    if a >= 100 && !b { return 0; }\n    if let Some(x) = g() { return x; }\n    save(a);\n    a - 2\n}\n', language: 'rust', line: 1, end_line: 6 });
    expect(edits(rust)).toEqual(['condition 2 a >= 100 && !b>true', 'condition 2 a >= 100 && !b>false', 'boundary 2 >=>>', 'number 2 100>101', 'logic 2 &&>||', 'not 2 !b>b', 'block 2 { return 0; }>{}', 'return 2 0>1',
      'block 3 { return x; }>{}', 'removal 4 save(a);>', 'arithmetic 5 ->+', 'number 5 2>3']);
    // A brace language's one-statement body without braces stays: emptied, what follows the `if` would become its body.
    const cpp = mutantsOf({ source: 'int f(int a, bool b) {\n  if (a >= 100 && !b) return 0;\n  return a - 2;\n}\n', language: 'cpp', line: 1, end_line: 4 });
    expect(edits(cpp)).toEqual(['condition 2 a >= 100 && !b>true', 'condition 2 a >= 100 && !b>false', 'boundary 2 >=>>', 'number 2 100>101', 'logic 2 &&>||', 'not 2 !b>b', 'return 2 0>1', 'arithmetic 3 ->+', 'number 3 2>3']);
    const java = mutantsOf({ source: 'class C {\n  int f(int a, boolean b) {\n    if (a >= 100 && !b) return 0;\n    return a - 2;\n  }\n}\n', language: 'java', line: 2, end_line: 5 });
    expect(edits(java)).toEqual(['condition 3 a >= 100 && !b>true', 'condition 3 a >= 100 && !b>false', 'boundary 3 >=>>', 'number 3 100>101', 'logic 3 &&>||', 'not 3 !b>b', 'return 3 0>1', 'arithmetic 4 ->+', 'number 4 2>3']);
    const go = mutantsOf({ source: 'package p\nfunc f(a int, b bool) int {\n  if a >= 100 && !b { return 0 }\n  return a - 2\n}\n', language: 'go', line: 2, end_line: 5 });
    expect(edits(go)).toEqual(['condition 3 a >= 100 && !b>true', 'condition 3 a >= 100 && !b>false', 'boundary 3 >=>>', 'number 3 100>101', 'logic 3 &&>||', 'not 3 !b>b', 'block 3 { return 0 }>{}', 'return 3 0>1',
      'arithmetic 4 ->+', 'number 4 2>3']);
  });

  it('reads Zig and Solidity, whose grammars wrap every operand', () => {
    // Zig's operator sits in a CompareOp or AdditionOp node, `and` is a bare keyword, the condition is the IfPrefix's first child,
    // `return 0` is an AssignExpr opened by the keyword, the literal sits under an ErrorUnionExpr and a SuffixExpr, and a call
    // statement is a Statement around an AssignExpr around a SuffixExpr with FnCallArguments.
    const zig = mutantsOf({ source: 'fn f(a: i32, b: bool) i32 {\n    save(a);\n    if (a >= 100 and !b) return 0;\n    while (a < 3) {}\n    return a - 2;\n}\n', language: 'zig', line: 1, end_line: 6 });
    expect(edits(zig)).toEqual(['removal 2 save(a);>', 'condition 3 a >= 100 and !b>true', 'condition 3 a >= 100 and !b>false', 'boundary 3 >=>>', 'number 3 100>101', 'logic 3 and>or', 'not 3 !b>b', 'return 3 0>1',
      'condition 4 a < 3>false', 'boundary 4 <><=', 'number 4 3>4', 'arithmetic 5 ->+', 'number 5 2>3']);
    // Solidity's boolean_literal holds a `true` node, read once; a returned literal is read through its `expression`.
    const solidity = mutantsOf({ source: 'contract C {\n  function f(uint256 a, bool b) internal pure returns (uint256) {\n    if (a >= 100 || !b) return 0;\n    bool c = true;\n    return a - 2;\n  }\n}\n', language: 'solidity', line: 2, end_line: 6 });
    expect(edits(solidity)).toEqual(['condition 3 a >= 100 || !b>true', 'condition 3 a >= 100 || !b>false', 'boundary 3 >=>>', 'number 3 100>101', 'logic 3 ||>&&', 'not 3 !b>b', 'return 3 0>1',
      'boolean 4 true>false', 'arithmetic 5 ->+', 'number 5 2>3']);
  });

  it('reads C#, Swift and Scala operators, negations, conditions and returns', () => {
    const csharp = mutantsOf({ source: 'class C {\n  int F(int a, bool b) {\n    if (a >= 100 || !b) return 0;\n    while (a < 0) a++;\n    return a - 2;\n  }\n}\n', language: 'c_sharp', line: 2, end_line: 6 });
    expect(edits(csharp)).toEqual(['condition 3 a >= 100 || !b>true', 'condition 3 a >= 100 || !b>false', 'boundary 3 >=>>', 'number 3 100>101', 'logic 3 ||>&&', 'not 3 !b>b', 'return 3 0>1',
      'condition 4 a < 0>false', 'boundary 4 <><=', 'number 4 0>1', 'update 4 ++>--', 'arithmetic 5 ->+', 'number 5 2>3']);
    // Swift reads `a >= 100 || !b` as an infix_expression with a custom operator, a return as a control transfer, and a body as
    // statements inside braces the grammar keeps, so an emptied body is `{  }`.
    const swift = mutantsOf({ source: 'func f(_ a: Int, _ b: Bool) -> Int {\n    if a >= 100 || !b { return 0 }\n    if a > 5 { return 1 }\n    return a - 2\n}\n', language: 'swift', line: 1, end_line: 5 });
    expect(edits(swift)).toEqual(['condition 2 a >= 100 || !b>true', 'condition 2 a >= 100 || !b>false', 'boundary 2 >=>>', 'number 2 100>101', 'logic 2 ||>&&', 'not 2 !b>b', 'block 2 return 0>', 'return 2 0>1',
      'condition 3 a > 5>true', 'condition 3 a > 5>false', 'boundary 3 >>>=', 'number 3 5>6', 'block 3 return 1>', 'return 3 1>0', 'arithmetic 4 ->+', 'number 4 2>3']);
    // Scala writes every binary operator as an infix_expression whose operator is a named operator_identifier.
    const scala = mutantsOf({ source: 'object C {\n  def f(a: Int, b: Boolean): Int = {\n    if (a >= 100 || !b) return 0\n    a - 2\n  }\n}\n', language: 'scala', line: 2, end_line: 5 });
    expect(edits(scala)).toEqual(['condition 3 a >= 100 || !b>true', 'condition 3 a >= 100 || !b>false', 'boundary 3 >=>>', 'number 3 100>101', 'logic 3 ||>&&', 'not 3 !b>b', 'return 3 0>1', 'arithmetic 4 ->+', 'number 4 2>3']);
    // A Scala infix method call, `a max b`, is no operator to mutate.
    expect(mutantsOf({ source: 'object C {\n  def f(a: Int, b: Int): Int = a max b\n}\n', language: 'scala', line: 2, end_line: 2 })).toEqual([]);
  });

  it('reads PHP and Lua methods', () => {
    const php = mutantsOf({ source: '<?php\nfunction discount(int $total, int $percent): int {\n    if ($percent >= 100 || !$total) {\n        return 0;\n    }\n    return $total - $total * $percent / 100;\n}\n', language: 'php', line: 2, end_line: 7 });
    expect(edits(php)).toEqual(['condition 3 $percent >= 100 || !$total>true', 'condition 3 $percent >= 100 || !$total>false', 'boundary 3 >=>>', 'number 3 100>101', 'logic 3 ||>&&', 'not 3 !$total>$total',
      'block 3 {\n        return 0;\n    }>{}', 'return 4 0>1', 'return 6 $total - $total * $percent / 100>null', 'arithmetic 6 ->+', 'arithmetic 6 *>/', 'arithmetic 6 />*', 'number 6 100>101']);
    // Lua spells negation `not`, inequality `~=`, and nothing `nil`.
    const lua = mutantsOf({ source: 'function M.discount(total, percent)\n  if percent >= 100 or not total then return 0 end\n  while total ~= 0 do total = total - 1 end\n  return total - total * percent / 100\nend\n', language: 'lua', line: 1, end_line: 5 });
    expect(edits(lua)).toEqual(['condition 2 percent >= 100 or not total>true', 'condition 2 percent >= 100 or not total>false', 'boundary 2 >=>>', 'number 2 100>101', 'logic 2 or>and', 'not 2 not total>total',
      'block 2 return 0>', 'return 2 0>1', 'condition 3 total ~= 0>false', 'boundary 3 ~=>==', 'number 3 0>1', 'arithmetic 3 ->+', 'number 3 1>0',
      'return 4 total - total * percent / 100>nil', 'arithmetic 4 ->+', 'arithmetic 4 *>/', 'arithmetic 4 />*', 'number 4 100>101']);
    expect(edits(mutantsOf({ source: 'function f(a)\n  if a == 1 then return true end\n  return false\nend\n', language: 'lua', line: 1, end_line: 4 })))
      .toEqual(['condition 2 a == 1>true', 'condition 2 a == 1>false', 'boundary 2 ==>~=', 'number 2 1>0', 'block 2 return true>', 'boolean 2 true>false', 'boolean 3 false>true']);
  });

  it('keeps to the method it is given, and names each mutant by where and what', () => {
    const source = 'function a() {\n  return 1 < 2;\n}\nfunction b() {\n  return 3 > 4;\n}\n';
    const mutants = mutantsOf({ source, language: 'javascript', line: 4, end_line: 6 });
    expect(edits(mutants)).toEqual(['return 5 3 > 4>null', 'number 5 3>4', 'boundary 5 >>>=', 'number 5 4>5']);
    // Line, column, kind, and a digest of the edit: two edits at one place differ, and a run tomorrow names them the same.
    expect(mutants.map(mutantId)).toEqual(['5:9:return:' + mutantId(mutants[0]).split(':')[3], '5:9:number:' + mutantId(mutants[1]).split(':')[3], '5:11:boundary:' + mutantId(mutants[2]).split(':')[3], '5:13:number:' + mutantId(mutants[3]).split(':')[3]]);
    expect(new Set(mutants.map(mutantId)).size).toBe(4);
    expect(mutantId(mutants[0])).toMatch(/^5:9:return:[0-9a-f]{8}$/);
  });
});
