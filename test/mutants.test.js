import { describe, expect, it } from 'vitest';
import { describeMutant, KINDS, mutantId, mutantsOf } from '../src/mutants.js';

/** Every edit but the whole-body one, which is asserted apart: its `from` is the body. */
const edits = mutants => mutants.filter(mutant => mutant.kind !== 'body').map(mutant => `${mutant.kind} ${mutant.line} ${mutant.from}>${mutant.to}`);
const bodies = mutants => mutants.filter(mutant => mutant.kind === 'body').map(mutant => `${mutant.line} ${mutant.to}`);

describe('mutants', () => {
  it('makes every mutant of a method, in the order they sit in it', () => {
    const source = 'function f(a, b) {\n  if (a >= 100 && !b) return 0;\n  while (a < b) a++;\n  return a - b * 2 ? true : false;\n}\n';
    const mutants = mutantsOf({ source, language: 'javascript', line: 1, end_line: 5 });
    expect(edits(mutants)).toEqual([
      // The if: its condition forced either way, the boundary, the number, the connective, the dropped not, the returned number.
      'condition 2 a >= 100 && !b>true', 'condition 2 a >= 100 && !b>false', 'boundary 2 >=>>', 'number 2 100>101', 'logic 2 &&>||', 'not 2 !b>b', 'return 2 0>1',
      // A loop is only ever forced false: forced true it would never end.
      'condition 3 a < b>false', 'boundary 3 <><=', 'update 3 ++>--',
      // A returned expression that is no literal is returned as null in a language where that runs; a ternary's condition is
      // forced each way like an if's.
      'condition 4 a - b * 2>true', 'condition 4 a - b * 2>false', 'return 4 a - b * 2 ? true : false>null', 'arithmetic 4 ->+', 'arithmetic 4 *>/', 'number 4 2>3', 'boolean 4 true>false', 'boolean 4 false>true',
    ]);
    // No cap: a method with nineteen mutants is asked about nineteen, the whole body emptied among them.
    expect(mutants).toHaveLength(19);
    expect(bodies(mutants)).toEqual(['1 {}']);
    expect(mutants[3]).toMatchObject({ line: 2, column: 8, original: '  if (a >= 100 && !b) return 0;', mutated: '  if (a > 100 && !b) return 0;' });
    for (const mutant of mutants) expect(KINDS).toContain(mutant.kind);
  });

  it('leaves types alone, which change nothing a test runs', () => {
    const ts = 'function f(a: 0 | 1, b: Array<"x">): 2 | 3 {\n  const c: Record<"k", 4> = { k: 4 };\n  return a + 5;\n}\n';
    expect(edits(mutantsOf({ source: ts, language: 'typescript', line: 1, end_line: 4 }))).toEqual([
      'collection 2 { k: 4 }>{}', 'number 2 4>5', 'arithmetic 3 +>-', 'number 3 5>6']);
    const py = 'def f(a: Literal[1] = 2) -> "str":\n    return a\n';
    expect(edits(mutantsOf({ source: py, language: 'python', line: 1, end_line: 2 }))).toEqual(['number 1 2>3', 'return 2 a>None']);
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
    const [whole, ...rest] = mutants;
    expect(whole).toMatchObject({ kind: 'body', line: 1, column: 21, to: '{}' });
    expect(describeMutant(whole)).toBe('the body emptied');
    expect(rest[0]).toMatchObject({ column: 2, original: '  save(items);', mutated: '  ' });
    expect(describeMutant(rest[0])).toBe('the call `save(items);` removed');
    expect(describeMutant(rest[9])).toBe("the branch's body emptied");
    expect(describeMutant(rest[5])).toBe('`true` as the condition');
    expect(describeMutant(rest[7])).toBe('`>=` instead of `>`');
  });

  it('leaves names, loads and docstrings alone', () => {
    // super() stays, require's argument is a name, an object's key is a name but its value is a value, "use strict" is a statement.
    const source = 'class A extends B {\n  constructor() {\n    super();\n    const fs = require("node:fs");\n    this.map = { key: "value" };\n    "use strict";\n  }\n}\n';
    expect(edits(mutantsOf({ source, language: 'javascript', line: 2, end_line: 7 }))).toEqual(['collection 5 { key: "value" }>{}', 'string 5 "value">""']);
    const python = 'def f(items):\n    """Saves."""\n    import os\n    if items:\n        save(items)\n        log("saved")\n    return [1, -2]\n';
    const mutants = mutantsOf({ source: python, language: 'python', line: 1, end_line: 7 });
    expect(edits(mutants)).toEqual([
      'condition 4 items>True', 'condition 4 items>False', 'block 5 save(items)\n        log("saved")>pass', 'removal 5 save(items)>pass', 'removal 6 log("saved")>pass', 'string 6 "saved">""',
      'return 7 [1, -2]>[]', 'number 7 1>0', 'negative 7 -2>2', 'number 7 2>3',
    ]);
    // An emptied body spans lines: the lines it touches are given both ways.
    expect(mutants.find(mutant => mutant.kind === 'block')).toMatchObject({ line: 5, column: 8, original: '        save(items)\n        log("saved")', mutated: '        pass' });
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

  it('empties a method\'s body, or returns its type\'s zero', () => {
    const body = (source, language, line, end_line) => { const found = mutantsOf({ source, language, line, end_line }).filter(mutant => mutant.kind === 'body'); return found.map(mutant => [mutant.to, describeMutant(mutant)]); };
    // No return type to honour: the body goes, and the function returns what an empty one does.
    expect(body('function f(a) {\n  return a + 1;\n}\n', 'javascript', 1, 3)).toEqual([['{}', 'the body emptied']]);
    expect(body('def f(a):\n    return a + 1\n', 'python', 1, 2)).toEqual([['pass', 'the body emptied']]);
    expect(body('def f(a)\n  a + 1\nend\n', 'ruby', 1, 3)).toEqual([['', 'the body emptied']]);
    // A declared type with a zero every compiler accepts: that zero is returned, in the language's own spelling.
    expect(body('export function f(a: number): number {\n  return a + 1;\n}\n', 'typescript', 1, 3)).toEqual([['{ return 0; }', 'the body replaced by `return 0;`']]);
    expect(body('package p\nfunc f(a int) string {\n  return g(a)\n}\n', 'go', 2, 4)).toEqual([['{ return "" }', 'the body replaced by `return ""`']]);
    expect(body('fn f(a: i32) -> bool {\n    a > 1\n}\n', 'rust', 1, 3)).toEqual([['{ false }', 'the body replaced by `false`']]);
    expect(body('fn f(a: i32) -> String {\n    a.to_string()\n}\n', 'rust', 1, 3)).toEqual([['{ String::new() }', 'the body replaced by `String::new()`']]);
    expect(body('class C {\n  int f(int a) {\n    return a + 1;\n  }\n}\n', 'java', 2, 4)).toEqual([['{ return 0; }', 'the body replaced by `return 0;`']]);
    expect(body('fun f(a: Int): Int { return a + 1 }\n', 'kotlin', 1, 1)).toEqual([['{ return 0 }', 'the body replaced by `return 0`']]);
    expect(body('func f(_ a: Int) -> Bool { return a > 1 }\n', 'swift', 1, 1)).toEqual([['{ return false }', 'the body replaced by `return false`']]);
    expect(body('contract C {\n  function f(uint256 a) public pure returns (string memory) { return g(a); }\n}\n', 'solidity', 2, 2)).toEqual([['{ return ""; }', 'the body replaced by `return "";`']]);
    // Nothing returned: the body is emptied, whatever the language.
    expect(body('package p\nfunc f(a int) {\n  g(a)\n}\n', 'go', 2, 4)).toEqual([['{}', 'the body emptied']]);
    expect(body('fun f(a: Int) { g(a) }\n', 'kotlin', 1, 1)).toEqual([['{}', 'the body emptied']]);
    expect(body('export async function f(a: number): Promise<void> {\n  await g(a);\n}\n', 'typescript', 1, 3)).toEqual([['{}', 'the body emptied']]);
    // A type with no zero every test would compile against gets no body mutant, and nor does a body that is empty already.
    expect(body('class C {\n  Map<String, Integer> f(int a) {\n    return g(a);\n  }\n}\n', 'java', 2, 4)).toEqual([]);
    expect(body('function f() {}\n', 'javascript', 1, 1)).toEqual([]);
  });

  it('swaps a method for its opposite or drops its call, in each language\'s own names', () => {
    const js = 'function f(a, b, items) {\n  const t = a.trim().toUpperCase();\n  const m = Math.min(a, b);\n  return items.filter(i => i.ok);\n}\n';
    expect(edits(mutantsOf({ source: js, language: 'javascript', line: 1, end_line: 5 })).filter(edit => edit.startsWith('method'))).toEqual([
      'method 2 a.trim()>a', 'method 2 toUpperCase>toLowerCase', 'method 3 min>max', 'method 4 items.filter(i => i.ok)>items',
    ]);
    const dropped = mutantsOf({ source: js, language: 'javascript', line: 1, end_line: 5 }).find(mutant => mutant.kind === 'method');
    expect(describeMutant(dropped)).toBe('the call to `trim` removed');
    expect(describeMutant({ kind: 'method', from: 'startsWith', to: 'endsWith' })).toBe('`endsWith` instead of `startsWith`');
    // A free function too: sorted(items) is items, and the name of the module it comes from stays with it.
    const python = 'def f(a, items):\n    t = a.strip().upper()\n    return sorted(items), min(1, 2)\n';
    expect(edits(mutantsOf({ source: python, language: 'python', line: 1, end_line: 3 })).filter(edit => edit.startsWith('method'))).toEqual([
      'method 2 a.strip()>a', 'method 2 upper>lower', 'method 3 sorted(items)>items', 'method 3 min>max']);
    const go = 'package p\nfunc f(a string) string {\n  return strings.ToUpper(strings.TrimSpace(a))\n}\n';
    expect(edits(mutantsOf({ source: go, language: 'go', line: 2, end_line: 4 })).filter(edit => edit.startsWith('method'))).toEqual([
      'method 3 strings.ToUpper>strings.ToLower', 'method 3 strings.TrimSpace(a)>a']);
    // Ruby and Scala call without parentheses; Kotlin and Swift chain through a navigation suffix; C# and Java name the member.
    const ruby = 'def f(a, items)\n  t = a.strip.upcase\n  items.select { |i| i }.sort\nend\n';
    expect(edits(mutantsOf({ source: ruby, language: 'ruby', line: 1, end_line: 4 })).filter(edit => edit.startsWith('method'))).toEqual([
      'method 2 a.strip>a', 'method 2 upcase>downcase', 'method 3 items.select { |i| i }.sort>items.select { |i| i }', 'method 3 items.select { |i| i }>items']);
    const scala = 'object S { def f(a: String, items: List[Int]): List[Int] = {\n  val t = a.trim.toUpperCase\n  items.filter(_ > 0).sorted\n} }\n';
    expect(edits(mutantsOf({ source: scala, language: 'scala', line: 1, end_line: 4 })).filter(edit => edit.startsWith('method'))).toEqual([
      'method 2 a.trim>a', 'method 2 toUpperCase>toLowerCase', 'method 3 items.filter(_ > 0).sorted>items.filter(_ > 0)', 'method 3 items.filter(_ > 0)>items']);
    const kotlin = 'fun f(a: String, items: List<Int>): List<Int> {\n  val t = a.trim().uppercase()\n  return items.filter { it > 0 }.sorted()\n}\n';
    expect(edits(mutantsOf({ source: kotlin, language: 'kotlin', line: 1, end_line: 4 })).filter(edit => edit.startsWith('method'))).toEqual([
      'method 2 a.trim()>a', 'method 2 uppercase>lowercase', 'method 3 items.filter { it > 0 }.sorted()>items.filter { it > 0 }', 'method 3 items.filter { it > 0 }>items']);
    const csharp = 'class S { int F(string a, int[] items) {\n  var t = a.Trim().ToUpper();\n  return items.Where(i => i > 0).Count();\n} }\n';
    expect(edits(mutantsOf({ source: csharp, language: 'c_sharp', line: 1, end_line: 4 })).filter(edit => edit.startsWith('method'))).toEqual([
      'method 2 a.Trim()>a', 'method 2 ToUpper>ToLower', 'method 3 items.Where(i => i > 0)>items']);
    const java = 'class S { int f(String a, java.util.List<Integer> items) {\n  String t = a.trim().toUpperCase();\n  return items.stream().filter(i -> i > 0).toList().size();\n} }\n';
    expect(edits(mutantsOf({ source: java, language: 'java', line: 1, end_line: 4 })).filter(edit => edit.startsWith('method'))).toEqual([
      'method 2 a.trim()>a', 'method 2 toUpperCase>toLowerCase', 'method 3 items.stream().filter(i -> i > 0)>items.stream()']);
    const rust = 'fn f(a: &str, items: Vec<i32>) -> usize {\n  let t = a.trim().to_uppercase();\n  items.iter().filter(|i| **i > 0).count()\n}\n';
    expect(edits(mutantsOf({ source: rust, language: 'rust', line: 1, end_line: 4 })).filter(edit => edit.startsWith('method'))).toEqual([
      'method 2 a.trim()>a', 'method 2 to_uppercase>to_lowercase', 'method 3 items.iter().filter(|i| **i > 0)>items.iter()']);
    const php = '<?php\nfunction f($a, $items) {\n  $t = strtoupper(trim($a));\n  return array_filter($items);\n}\n';
    expect(edits(mutantsOf({ source: php, language: 'php', line: 2, end_line: 5 })).filter(edit => edit.startsWith('method'))).toEqual([
      'method 3 strtoupper>strtolower', 'method 3 trim($a)>$a', 'method 4 array_filter($items)>$items']);
  });

  it('finds nothing to swap in a method Object has a property for', () => {
    // toString, valueOf and constructor are properties of every plain object; the tables are looked up as tables, not objects.
    const source = 'function f(a) {\n  return a.toString() + a.valueOf() + a.constructor() + hasOwnProperty(a);\n}\n';
    expect(edits(mutantsOf({ source, language: 'javascript', line: 1, end_line: 3 })).filter(edit => edit.startsWith('method'))).toEqual([]);
  });

  it('empties collections, fills empty ones, makes chains unconditional, blanks arrow functions and edits patterns', () => {
    const js = 'function f(a, items) {\n  const x = a?.b?.(1)?.[0];\n  const arr = [1, 2], empty = [], obj = { k: 1 }, s = "", r = /^a+\\d?$/g;\n  const g = x => x + 1;\n  for (let i = 0; i < 3; i++) {}\n  a ??= 1; a %= 2;\n  return a ?? items;\n}\n';
    const mutants = mutantsOf({ source: js, language: 'javascript', line: 1, end_line: 8 });
    expect(edits(mutants).filter(edit => !/^(number|boundary|arithmetic|update 5|return)/.test(edit))).toEqual([
      // One `?.` each on the member, the call and the subscript; the member's becomes `.`, the others go.
      'chaining 2 ?.>.', 'chaining 2 ?.>', 'chaining 2 ?.>',
      'collection 3 [1, 2]>[]', 'collection 3 []>["perch was here"]', 'collection 3 { k: 1 }>{}', 'string 3 "">"perch was here"',
      'regex 3 ^a+\\d?$>a+\\d?$', 'regex 3 ^a+\\d?$>^a+\\d?', 'regex 3 ^a+\\d?$>^a*\\d?$', 'regex 3 ^a+\\d?$>^a+\\D?$', 'regex 3 ^a+\\d?$>^a+\\d$',
      'lambda 4 x + 1>undefined',
      'condition 5 i < 3>false',
      'update 6 ??=>&&=', 'update 6 %=>*=',
      'logic 7 ??>&&',
    ]);
    expect(describeMutant(mutants.find(mutant => mutant.kind === 'chaining'))).toBe('the optional `?.` made unconditional');
    expect(describeMutant(mutants.find(mutant => mutant.kind === 'lambda'))).toBe('the arrow function returning `undefined`');
    expect(mutants.find(mutant => mutant.kind === 'regex')).toMatchObject({ column: 63, original: '  const arr = [1, 2], empty = [], obj = { k: 1 }, s = "", r = /^a+\\d?$/g;', mutated: '  const arr = [1, 2], empty = [], obj = { k: 1 }, s = "", r = /a+\\d?$/g;' });
    // `??` becomes `&&` only where `&&` takes any value; a typed language's `??` is left alone.
    expect(edits(mutantsOf({ source: 'class S { int F(int? a) { return a ?? 2; } }\n', language: 'c_sharp', line: 1, end_line: 1 })).filter(edit => edit.startsWith('logic'))).toEqual([]);
    // Ruby's `&.`, PHP's `?->`, Kotlin's `?.` made unconditional in each language's spelling; C#'s `?.` likewise.
    expect(edits(mutantsOf({ source: 'def f(a)\n  a&.b\nend\n', language: 'ruby', line: 1, end_line: 3 })).filter(edit => edit.startsWith('chaining'))).toEqual(['chaining 2 &.>.']);
    expect(edits(mutantsOf({ source: '<?php\nfunction f($a) { return $a?->b(); }\n', language: 'php', line: 2, end_line: 2 })).filter(edit => edit.startsWith('chaining'))).toEqual(['chaining 2 ?->>->']);
    expect(edits(mutantsOf({ source: 'fun f(a: String?): String? = a?.trim()\n', language: 'kotlin', line: 1, end_line: 1 })).filter(edit => edit.startsWith('chaining'))).toEqual(['chaining 1 ?.>!!.']);
    expect(edits(mutantsOf({ source: 'class S { int F(string a) { return a?.Length ?? 0; } }\n', language: 'c_sharp', line: 1, end_line: 1 })).filter(edit => edit.startsWith('chaining'))).toEqual(['chaining 1 ?>']);
    // A typed literal keeps its type: Go's and Java's bodies empty, Rust's vec! empties; Kotlin's listOf and Swift's [] are left alone.
    expect(edits(mutantsOf({ source: 'package p\nfunc f() []int { x := []int{1, 2}; return x }\n', language: 'go', line: 2, end_line: 2 })).filter(edit => edit.startsWith('collection'))).toEqual(['collection 2 {1, 2}>{}']);
    expect(edits(mutantsOf({ source: 'class S { int[] f() { int[] x = new int[]{1, 2}; return x; } }\n', language: 'java', line: 1, end_line: 1 })).filter(edit => edit.startsWith('collection'))).toEqual(['collection 1 {1, 2}>{}']);
    expect(edits(mutantsOf({ source: 'fn f() -> Vec<i32> { let v = vec![1, 2]; v }\n', language: 'rust', line: 1, end_line: 1 })).filter(edit => edit.startsWith('collection'))).toEqual(['collection 1 vec![1, 2]>vec![]']);
    expect(edits(mutantsOf({ source: 'fun f(): List<Int> { val x = listOf(1, 2); return x }\n', language: 'kotlin', line: 1, end_line: 1 })).filter(edit => edit.startsWith('collection'))).toEqual([]);
    expect(edits(mutantsOf({ source: 'func f() -> [Int] { let x = [1, 2]; return x }\n', language: 'swift', line: 1, end_line: 1 })).filter(edit => edit.startsWith('collection'))).toEqual([]);
    expect(edits(mutantsOf({ source: 'def f():\n    x = [1, 2]; d = {"k": 1}; s = {1}; e = []\n    return x\n', language: 'python', line: 1, end_line: 3 })).filter(edit => edit.startsWith('collection'))).toEqual([
      'collection 2 [1, 2]>[]', 'collection 2 {"k": 1}>{}', 'collection 2 {1}>set()', 'collection 2 []>["perch was here"]']);
  });

  it('keeps to the method it is given, and names each mutant by where and what', () => {
    const source = 'function a() {\n  return 1 < 2;\n}\nfunction b() {\n  return 3 > 4;\n}\n';
    const all = mutantsOf({ source, language: 'javascript', line: 4, end_line: 6 });
    expect(edits(all)).toEqual(['return 5 3 > 4>null', 'number 5 3>4', 'boundary 5 >>>=', 'number 5 4>5']);
    expect(bodies(all)).toEqual(['4 {}']);
    // Line, column, kind, and a digest of the edit: two edits at one place differ, and a run tomorrow names them the same.
    const mutants = all.filter(mutant => mutant.kind !== 'body');
    expect(mutants.map(mutant => mutantId(mutant).split(':').slice(0, 3).join(':'))).toEqual(['5:9:return', '5:9:number', '5:11:boundary', '5:13:number']);
    expect(new Set(all.map(mutantId)).size).toBe(5);
    expect(mutantId(mutants[0])).toMatch(/^5:9:return:[0-9a-f]{8}$/);
  });
});
