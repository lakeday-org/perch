/**
 * What in a parsed Scala file is a test case. Every answer is read off syntax nodes: the base class a suite extends, the import
 * that names where that base comes from, and the calls and infix expressions the suite's body is written as. ScalaTest's and
 * munit's `test("name") { }` is a call whose last argument is a block; ScalaTest's spec styles write a test as `"subject" should
 * "do this" in { }`, an infix expression ending in a block. The grammar reports neither block as a function, so each is pushed to
 * the scan's bodies and named as its framework names it.
 */
import type { Node } from "../node";
import { enclosing, literal, span, type TestScan } from "../tests";
import type { SyntaxIndex } from "../visit";

const TYPES = new Set(["class_definition", "object_definition", "trait_definition"]);

/** The calls that declare one test, in ScalaTest's FunSuite, FunSpec, PropSpec and FeatureSpec and in munit. */
const TEST_CALLS = new Set(["test", "it", "they", "property", "scenario", "Scenario"]);
/** The calls that declare a group of tests around them, and the prefix ScalaTest puts on a test's name for each. */
const GROUP_CALLS: Record<string, string> = { describe: "", feature: "Feature: ", Feature: "Feature: " };
/** The verbs a spec style writes between a subject and a block or a clause, each kept in the test's name as written. */
const VERBS = new Set(["should", "must", "can", "when", "which", "that", "in", ">>"]);
/** ScalaTest's and munit's per-test and per-suite setup methods, which a suite overrides. */
const SETUP = new Set(["beforeEach", "beforeAll"]);

/** The last segment of each type a definition extends or mixes in. */
function extended(type: Node): string[] {
  return (type.childForFieldName("extend")?.namedChildren ?? []).map(item => item.type === "generic_type" ? item.namedChildren[0] : item)
    .filter(item => item && ["type_identifier", "stable_type_identifier"].includes(item.type)).map(item => item!.text.split(".").at(-1)!);
}

/** Where each imported name comes from, and the packages imported whole, so a base class can be placed with its library. */
function imports(index: SyntaxIndex): { named: Map<string, string>; whole: string[] } {
  const named = new Map<string, string>(), whole: string[] = [];
  for (const node of index.of("import_declaration")) {
    const path = node.namedChildren.filter(child => child.type === "identifier").map(child => child.text);
    const selectors = node.namedChildren.find(child => child.type === "namespace_selectors");
    if (node.namedChildren.some(child => child.type === "namespace_wildcard")) whole.push(path.join("."));
    else if (selectors) {
      for (const item of selectors.namedChildren) {
        if (item.type === "identifier") named.set(item.text, path.join("."));
        else if (item.type === "namespace_wildcard") whole.push(path.join("."));
        else if (item.type.endsWith("renamed_identifier")) named.set(item.childForFieldName("alias")?.text ?? item.childForFieldName("name")?.text ?? "", path.join("."));
      }
    } else if (path.length > 1) named.set(path.at(-1)!, path.slice(0, -1).join("."));
  }
  return { named, whole };
}

/** The framework a library package belongs to, by its root: `org.scalatest.funsuite` is ScalaTest's. */
function libraryOf(path: string): string | null {
  if (/^org\.scalatest(\.|$)/.test(path)) return "scalatest";
  if (/^munit(\.|$)/.test(path)) return "munit";
  if (/^org\.specs2(\.|$)/.test(path)) return "specs2";
  return null;
}

/** ScalaTest's own suite classes, by name, for a base imported through a wildcard the file does not spell out. */
const SCALATEST_BASES = /^(?:Any|Async|Fixture)?(?:FunSuite|FlatSpec|WordSpec|FunSpec|FeatureSpec|FreeSpec|PropSpec|RefSpec)(?:Like)?$/;
const MUNIT_BASES = /^(?:FunSuite|ScalaCheckSuite|CatsEffectSuite|ZSuite|Suite)$/;
const SPECS2_BASES = /^(?:Specification|SpecificationWithJUnit|SpecificationLike)$/;

/**
 * The framework a suite's tests belong to, from what it extends: the import that brings the base in says which library it is
 * from; failing that, the base's name, where ScalaTest's and munit's suites have names of their own.
 */
function frameworkOf(type: Node, known: { named: Map<string, string>; whole: string[] }): string | null {
  const bases = extended(type);
  for (const base of bases) {
    const from = known.named.get(base);
    const library = from ? libraryOf(from) : null;
    if (library) return library;
  }
  const wholes = known.whole.map(libraryOf).filter((library): library is string => library !== null);
  for (const base of bases) {
    if (SCALATEST_BASES.test(base) && (base.startsWith("Any") || base.startsWith("Async") || wholes.includes("scalatest") || !wholes.includes("munit"))) return "scalatest";
    if (MUNIT_BASES.test(base)) return wholes.includes("scalatest") ? "scalatest" : "munit";
    if (SPECS2_BASES.test(base)) return "specs2";
  }
  // A project's own base suite, `trait BaseSpec extends AnyFunSuite`, declared in another file: named for what it is, and
  // placed with whichever of the libraries this file imports.
  if (bases.some(base => /(?:Suite|Spec)$/.test(base)) && wholes.length === 1) return wholes[0];
  return null;
}

/** The setup methods a suite declares, as calls on the suite would name them. */
function setupOf(type: Node): string[] {
  const owner = type.childForFieldName("name")?.text;
  if (!owner) return [];
  return (type.childForFieldName("body")?.namedChildren ?? [])
    .filter(item => item.type === "function_definition" && SETUP.has(item.childForFieldName("name")?.text ?? ""))
    .map(item => `${owner}.${item.childForFieldName("name")!.text}`);
}

/**
 * A test's title as written in a call's first argument: a string, or one munit tags (`"slow".tag(Slow)`) or marks as its only
 * case (`"x".only`); `"x".ignore` is a test that does not run. A title built at run time is kept as its source and marked
 * computed, as a test declared in a loop is one case per iteration.
 */
function titled(argument: Node | undefined): { title: string; computed: boolean } | null {
  if (!argument) return null;
  const written = literal(argument);
  if (written !== null) return { title: written, computed: false };
  if (argument.type === "call_expression" || argument.type === "field_expression") {
    const access = argument.type === "call_expression" ? argument.childForFieldName("function") : argument;
    if (access?.type === "field_expression") {
      const member = access.childForFieldName("field")?.text;
      if (member === "ignore") return null;
      if (member === "tag" || member === "only" || member === "flaky" || member === "fail") return titled(access.childForFieldName("value") ?? undefined);
    }
  }
  if (argument.type === "interpolated_string_expression") return { title: argument.text.replace(/^\w+"""|"""$|^\w+"|"$/g, ""), computed: true };
  return null;
}

/** A call written `name("title") { block }`: its name, title and block, when it has that shape. */
function blockCall(node: Node): { callee: string; title: { title: string; computed: boolean } | null; block: Node } | null {
  if (node.type !== "call_expression") return null;
  const block = node.childForFieldName("arguments"), inner = node.childForFieldName("function");
  if (block?.type !== "block" || inner?.type !== "call_expression") return null;
  const callee = inner.childForFieldName("function");
  if (callee?.type !== "identifier") return null;
  const args = inner.childForFieldName("arguments")?.namedChildren.filter(arg => !arg.type.includes("comment")) ?? [];
  return { callee: callee.text, title: titled(args[0]), block };
}

/** A string argument of an infix verb: the literal, or the text of a run-time string, so `"a $b" in { }` is still a test. */
const clause = (node: Node | null): string | null => (node ? literal(node) ?? (node.type === "interpolated_string_expression" ? node.text : null) : null);

/**
 * A spec test, `"subject" should "do this" in { }`: an infix expression whose operator is `in` and whose right side is a block.
 * Its name is what ScalaTest reports: the words of its left side, then of each clause around it, each being a string and a verb,
 * read outward. `it should "do this"` takes the subject the suite last gave, with `behavior of "subject"` or an earlier test.
 */
function specTest(node: Node, subjects: Map<string, string>): { name: string; block: Node } | null {
  if (node.type !== "infix_expression") return null;
  const block = node.childForFieldName("right"), verb = node.childForFieldName("operator")?.text;
  if (block?.type !== "block" || (verb !== "in" && verb !== ">>")) return null;
  const words = clauseWords(node.childForFieldName("left"), subjects);
  if (!words) return null;
  const outer: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== "infix_expression" || parent.childForFieldName("right")?.type !== "block") continue;
    const around = clauseWords(parent.childForFieldName("left"), subjects);
    if (!around || !VERBS.has(parent.childForFieldName("operator")?.text ?? "")) return null;
    outer.unshift(`${around} ${parent.childForFieldName("operator")!.text}`);
  }
  return { name: [...outer, words].join(" "), block };
}

/** The words of a clause's left side: `"A Cart" should "discount"` reads as written; `it should "reject"` names the last subject. */
function clauseWords(left: Node | null, subjects: Map<string, string>): string | null {
  if (!left) return null;
  const own = clause(left);
  if (own !== null) return own;
  if (left.type !== "infix_expression") return null;
  const verb = left.childForFieldName("operator")?.text ?? "";
  if (!VERBS.has(verb)) return null;
  const subject = left.childForFieldName("left"), rest = clause(left.childForFieldName("right"));
  if (rest === null) return null;
  const head = subject && ["it", "they"].includes(subject.text) ? subjects.get(subjectKey(left)) ?? null : clause(subject);
  return head === null ? null : `${head} ${verb} ${rest}`;
}

/** The statement of the suite's body a clause is in, which is what its `it` takes its subject from. */
function subjectKey(node: Node): string {
  for (let statement = node; statement.parent; statement = statement.parent) if (statement.parent.type === "template_body") return span(statement);
  return "file";
}

/**
 * The subject in effect at each statement of a suite's body, so `it should` after `"A Cart" should "x" in { }` or after
 * `behavior of "A Cart"` is a test of A Cart. Read front to back, each statement updating what `it` means for the ones after it.
 */
function subjectsOf(body: Node): Map<string, string> {
  const subjects = new Map<string, string>();
  let current: string | null = null;
  for (const item of body.namedChildren) {
    if (item.type !== "infix_expression") continue;
    const verb = item.childForFieldName("operator")?.text;
    const left = item.childForFieldName("left");
    if (left?.text === "behavior" && verb === "of") { current = clause(item.childForFieldName("right")) ?? current; continue; }
    // A clause's subject is the string before its first verb: `"A Cart" should "x" in { }`.
    let head: Node | null = item;
    while (head?.type === "infix_expression") head = head.childForFieldName("left");
    const subject = clause(head);
    if (subject !== null && head?.parent?.type === "infix_expression" && VERBS.has(head.parent.childForFieldName("operator")?.text ?? "")) current = subject;
    if (current !== null) subjects.set(span(item), current);
  }
  return subjects;
}

export function scalaTests(index: SyntaxIndex, scan: TestScan, path: string | null): void {
  void path;
  const known = imports(index);
  const typeName = (scope: Node) => scope.childForFieldName("name")?.text ?? null;
  for (const type of index.of("class_definition", "object_definition", "trait_definition")) {
    if (!TYPES.has(type.type)) continue;
    const framework = frameworkOf(type, known);
    const body = type.childForFieldName("body");
    if (!framework || !body) continue;
    // What the suite's body runs outside its tests, a `val cart = new Cart()` or a `before { }` block, runs for each test in it.
    scan.suites.push({ start: body.startIndex, end: body.endIndex });
    const suite = [...enclosing(type, TYPES, typeName), typeName(type) ?? ""].filter(Boolean);
    const setup = setupOf(type);
    const subjects = subjectsOf(body);
    const add = (name: string, block: Node, computed = false) => {
      scan.bodies.push(block);
      scan.cases.set(span(block), { test: { name, suite, framework, ...(computed ? { parametrized: true } : {}), ...(setup.length ? { setup } : {}) }, qualified: [...suite, name].join(".") });
    };
    for (const node of index.within(body)) {
      // A test declared inside another suite's body belongs to that suite, which has its own turn.
      if (node === body || enclosingBody(node) !== body) continue;
      const call = blockCall(node);
      if (call && TEST_CALLS.has(call.callee) && call.title) {
        // ScalaTest names a FunSpec or FeatureSpec test by the groups around it: `describe("Cart") { it("adds") }` is `Cart adds`.
        const groups: string[] = [];
        let computed = call.title.computed;
        for (let parent: Node | null = node.parent; parent && parent !== body; parent = parent.parent) {
          const group = blockCall(parent);
          if (!group || !(group.callee in GROUP_CALLS)) continue;
          if (!group.title) { groups.length = 0; break; }
          groups.unshift(`${GROUP_CALLS[group.callee]}${group.title.title}`);
          computed ||= group.title.computed;
        }
        const own = call.callee === "scenario" || call.callee === "Scenario" ? `Scenario: ${call.title.title}` : call.title.title;
        add([...groups, own].join(" "), call.block, computed);
        continue;
      }
      const spec = specTest(node, subjects);
      if (spec) add(spec.name, spec.block);
    }
  }
}

/** The nearest suite body around a node. */
function enclosingBody(node: Node): Node | null {
  for (let parent: Node | null = node.parent; parent; parent = parent.parent) if (parent.type === "template_body") return parent;
  return null;
}
