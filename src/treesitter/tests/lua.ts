/**
 * What in a parsed Lua file is a test case, and what it mocks. Every answer is read off syntax nodes: a call's callee and its
 * arguments, a function's name, and the file's own `require` calls.
 *
 * busted declares suites as `describe("x", function() ... end)` and tests as `it("name", function() ... end)`. luaunit runs the
 * `test*` methods of every table named `Test*`, and every top-level `test*` function, in a file that requires it.
 */
import type { Node } from "../node";
import type { TestScan } from "../tests";
import type { MockTarget } from "../types";
import { lineOf, literal, ownerIn, span } from "../tests";
import type { SyntaxIndex } from "../visit";

const BUSTED_SUITES = new Set(["describe", "context", "insulate", "expose"]);
const BUSTED_TESTS = new Set(["it", "spec", "test"]);

/** A busted call's role, title and body: a string first, a function after it. */
function bustedRole(call: Node): { role: "suite" | "test"; title: string; body: Node } | null {
  if (call.type !== "function_call") return null;
  const callee = call.childForFieldName("name");
  if (callee?.type !== "identifier" || !(BUSTED_SUITES.has(callee.text) || BUSTED_TESTS.has(callee.text))) return null;
  const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter(arg => arg.type !== "comment");
  const title = literal(args[0]);
  const body = args.slice(1).find(arg => arg.type === "function_definition");
  if (title === null || !body) return null;
  return { role: BUSTED_SUITES.has(callee.text) ? "suite" : "test", title, body };
}

function bustedTests(index: SyntaxIndex, scan: TestScan): void {
  for (const node of index.of("function_call")) {
    const found = bustedRole(node);
    if (found?.role === "suite") scan.suites.push({ start: found.body.startIndex, end: found.body.endIndex });
    if (found?.role !== "test") continue;
    const suite: string[] = [];
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.type !== "function_definition" || parent.parent?.type !== "arguments") continue;
      const outer = bustedRole(parent.parent.parent!);
      if (outer?.role === "suite" && outer.body.id === parent.id) suite.unshift(outer.title);
    }
    scan.cases.set(span(found.body), { test: { name: found.title, suite, framework: "busted" }, qualified: [...suite, found.title].join(" > ") });
  }
}

/** Whether the file requires luaunit: `local lu = require('luaunit')`. */
function requiresLuaunit(index: SyntaxIndex): boolean {
  return index.of("function_call").some(call => call.childForFieldName("name")?.text === "require"
    && (literal(call.childForFieldName("arguments")?.namedChildren[0]) ?? "").split(".").at(-1) === "luaunit");
}

/** The table and method a Lua function is declared on: `TestCart` and `testTotal` for `function TestCart:testTotal()`. */
function declaredOn(node: Node): { table: string | null; method: string } | null {
  const name = node.childForFieldName("name");
  if (!name) return null;
  if (name.type === "identifier") return { table: null, method: name.text };
  if (name.type === "method_index_expression" || name.type === "dot_index_expression") {
    const table = name.childForFieldName("table"), method = name.childForFieldName("method") ?? name.childForFieldName("field");
    return table?.type === "identifier" && method?.type === "identifier" ? { table: table.text, method: method.text } : null;
  }
  return null;
}

/** luaunit's rule: tables named Test* or test*, and in them methods named test* or Test*; top-level functions named the same way. */
const TEST_NAME = /^[Tt]est/;

function luaunitTests(index: SyntaxIndex, scan: TestScan): void {
  if (!requiresLuaunit(index)) return;
  const declared = index.of("function_declaration").map(node => ({ node, on: declaredOn(node) })).filter(item => item.on);
  const setup = new Map<string, string[]>();
  for (const { on } of declared) {
    if (on!.table && ["setUp", "setup"].includes(on!.method)) setup.set(on!.table, [`${on!.table}.${on!.method}`]);
  }
  for (const { node, on } of declared) {
    if (!TEST_NAME.test(on!.method) || (on!.table !== null && !TEST_NAME.test(on!.table))) continue;
    // A method is declared on the table in the file's top level; a function nested in another is that function's local.
    if (node.parent?.type !== "chunk" && node.parent?.parent?.type !== "chunk") continue;
    const suite = on!.table ? [on!.table] : [];
    const before = on!.table ? setup.get(on!.table) : undefined;
    scan.cases.set(span(node), { test: { name: on!.method, suite, framework: "luaunit", ...(before ? { setup: before } : {}) }, qualified: null });
  }
}

/** busted's `stub(cart, "discount")` and `spy.on(cart, "discount")`: one function of a table, named by a string. */
function luaMockTarget(call: Node): MockTarget | null {
  const callee = call.childForFieldName("name");
  const written = callee?.text ?? "";
  if (!(callee?.type === "identifier" && written === "stub") && !(callee?.type === "dot_index_expression" && written === "spy.on")) return null;
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  const object = args[0], name = literal(args[1]);
  if (!object || !name || !["identifier", "dot_index_expression"].includes(object.type)) return null;
  return { kind: "member", object: object.text, name };
}

function luaMocks(index: SyntaxIndex, scan: TestScan): void {
  for (const node of index.of("function_call")) {
    const target = luaMockTarget(node);
    if (target) scan.mocks.push({ owner: ownerIn(node, scan), target, line: lineOf(node) });
  }
}

export function luaTests(index: SyntaxIndex, scan: TestScan, _path: string | null): void {
  bustedTests(index, scan);
  luaunitTests(index, scan);
  luaMocks(index, scan);
}
