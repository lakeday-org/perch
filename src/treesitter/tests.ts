/**
 * What in a parsed file is a test case, what it mocks, and what package the file declares. Every answer here is read off syntax
 * nodes: a decorator, an annotation, an attribute, a macro name, a call's callee and its arguments. The file's path takes part
 * in one decision only, the one pytest itself makes from it: which files' module-level `test*` functions it collects.
 */
import type { Node } from "./node";
import type { Mock, MockTarget, TestCase } from "./types";
import { isFunction } from "./metrics";
import type { SyntaxIndex } from "./visit";
import { goTests } from "./tests/go";
import { cTests } from "./tests/c";
import { csharpTests } from "./tests/c_sharp";
import { rubyTests } from "./tests/ruby";
import { phpTests } from "./tests/php";
import { luaTests } from "./tests/lua";
import { swiftTests } from "./tests/swift";
import { zigTests } from "./tests/zig";
import { solidityTests } from "./tests/solidity";
import { scalaTests } from "./tests/scala";
import { groovyTests } from "./tests/groovy";
import { bashTests } from "./tests/bash";

/** A test case found in the tree, keyed by its declaration node, with the qualified name it is known by when that differs. */
export interface FoundTest {
  test: TestCase;
  qualified: string | null;
}

export interface TestScan {
  /** Test cases by the `start:end` byte span of their declaration node. */
  cases: Map<string, FoundTest>;
  /** Declaration nodes the grammar does not report as functions: a Catch2 `TEST_CASE("...") { }` body. */
  bodies: Node[];
  mocks: Mock[];
  package: string | null;
  /** The byte spans of suite callbacks, `describe("...", () => { ... })`: setup there runs for every test inside. */
  suites: Array<{ start: number; end: number }>;
  /**
   * The macros the file's test framework writes as `NAME(args) { block }`: Catch2's and doctest's test cases, sections and
   * GIVEN/WHEN/THEN. The C++ grammar has no rule for a call followed by a block, so it may recover one as an ERROR.
   */
  blockMacros: Set<string>;
}

export const span = (node: Node) => `${node.startIndex}:${node.endIndex}`;
const named = (node: Node, type: string) => node.namedChildren.filter(child => child.type === type);
export const lineOf = (node: Node) => node.startPosition.row + 1;

/** The declaration id a node sits in, as references.ts assigns it, or `file` at the top level. */
function ownerOf(node: Node): string {
  for (let parent = node.parent; parent; parent = parent.parent) if (isFunction(parent)) return `function:${parent.startIndex}`;
  return "file";
}

/**
 * The declaration a node sits in when test bodies the grammar does not call functions count too: a Ruby `it "x" do ... end`
 * block is a declaration once `cases` holds its span, and a mock inside it belongs to that test.
 */
export function ownerIn(node: Node, scan: TestScan): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isFunction(parent) || scan.cases.has(span(parent))) return `function:${parent.startIndex}`;
  }
  return "file";
}

/** Names of the enclosing scopes of the given node types, outermost first. */
export function enclosing(node: Node, types: Set<string>, nameOf: (scope: Node) => string | null): string[] {
  const names: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!types.has(parent.type)) continue;
    const name = nameOf(parent);
    if (name) names.unshift(name);
  }
  return names;
}

/** A dotted name built from identifier and member nodes only: `mock.patch`, `obj.inner`, `this`. Anything computed is null. */
function dotted(node: Node | null, member: string, object: string, property: string): string | null {
  if (!node) return null;
  if (["identifier", "this", "self", "property_identifier", "simple_identifier", "type_identifier"].includes(node.type)) return node.text;
  if (node.type !== member) return null;
  const head = dotted(node.childForFieldName(object), member, object, property);
  const tail = node.childForFieldName(property);
  return head && tail ? `${head}.${tail.text}` : null;
}

/** The character each single-letter escape stands for, in every language here. */
const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", a: "\x07", 0: "\0" };

/**
 * What one escape sequence stands for: `\n`, `\'`, `\x41`, `\u0041`, `\u{1F600}`, `\U0001F600`, octal `\101`. A backslash before a
 * line break continues the line and stands for nothing. Any other escaped character stands for itself. Python's `\N{name}` needs
 * the Unicode name table and is kept as written.
 */
function unescape(sequence: string): string {
  const body = sequence.slice(1);
  if (body === "\n" || body === "\r\n") return "";
  if (/^[0-7]{1,3}$/.test(body) && body !== "0") return String.fromCodePoint(parseInt(body, 8));
  const hex = /^(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]+)\}|U([0-9a-fA-F]{8}))$/.exec(body);
  if (hex) return String.fromCodePoint(parseInt(hex[1] ?? hex[2] ?? hex[3] ?? hex[4], 16));
  if (body.startsWith("N{")) return sequence;
  return SIMPLE_ESCAPES[body] ?? body;
}

/**
 * The value of a string literal with nothing interpolated into it, or null. Escapes are decoded, since a test framework reports
 * the title the program sees: `'it\'s'` is reported as `it's`. A raw string, Python's `r'...'` or C++'s `R"(...)"`, has no
 * escapes and is taken as written.
 */
export function literal(node: Node | null | undefined): string | null {
  if (!node) return null;
  const parts = node.namedChildren;
  if (parts.some(part => ["template_substitution", "interpolation", "string_interpolation"].includes(part.type))) return null;
  // PHP's double-quoted string interpolates a variable written bare in it, `"total $x"`, with no node to say so but the variable's.
  if (node.type === "encapsed_string" && parts.some(part => !["string_content", "escape_sequence"].includes(part.type))) return null;
  if (!["string", "template_string", "string_literal", "raw_string_literal", "encapsed_string"].includes(node.type)) return null;
  const raw = node.type === "raw_string_literal" || /^[a-zA-Z]*[rR][a-zA-Z]*["']/.test(parts.find(part => part.type === "string_start")?.text ?? "");
  return parts.filter(part => ["string_fragment", "string_content", "escape_sequence"].includes(part.type))
    .map(part => (part.type === "escape_sequence" && !raw ? unescape(part.text) : part.text)).join("");
}

// ---------------------------------------------------------------------------------------------------------------- Python

const PY_PATCH = new Set(["patch", "mock.patch", "unittest.mock.patch", "mocker.patch"]);
const PY_PATCH_OBJECT = new Set(["patch.object", "mock.patch.object", "unittest.mock.patch.object", "mocker.patch.object", "mocker.spy"]);
const PY_TESTCASE = new Set(["TestCase", "IsolatedAsyncioTestCase"]);

/** pytest collects module-level tests from `test_*.py` and `*_test.py`, by basename. That is its rule, not a guess at one. */
function pytestCollects(path: string | null): boolean {
  const base = path?.split("/").at(-1) ?? "";
  return base.endsWith(".py") && (base.startsWith("test_") || base.endsWith("_test.py"));
}

const pyDotted = (node: Node | null) => dotted(node, "attribute", "object", "attribute");

/** `unittest` for a TestCase subclass, `pytest` for a class pytest collects by its `Test` prefix, otherwise null. */
function pythonTestClass(node: Node): string | null {
  const bases = node.childForFieldName("superclasses")?.namedChildren ?? [];
  // A project's own base class sits between most suites and TestCase, in another module this file cannot see into: LimiterTestCase,
  // Django's TransactionTestCase, DRF's APITestCase. Such a base is named for what it is.
  if (bases.some(base => { const name = pyDotted(base)?.split(".").at(-1) ?? ""; return PY_TESTCASE.has(name) || /(TestCase|TestBase)$/.test(name); })) return "unittest";
  return node.childForFieldName("name")?.text.startsWith("Test") ? "pytest" : null;
}

/** unittest's and pytest's per-test and per-class setup, by the name the framework calls. */
const PY_SETUP = new Set(["setUp", "asyncSetUp", "setUpClass", "setup_method", "setup_class", "setup"]);

/** The setup methods a Python test class declares, as calls on `self`. */
function pythonSetup(body: Node): string[] {
  return body.namedChildren.map(item => (item.type === "decorated_definition" ? item.childForFieldName("definition") : item))
    .filter(item => item?.type === "function_definition").map(item => item!.childForFieldName("name")?.text ?? "")
    .filter(name => PY_SETUP.has(name)).map(name => `self.${name}`);
}

function pythonTests(index: SyntaxIndex, path: string | null, scan: TestScan): void {
  const collected = pytestCollects(path);
  const classNames = new Set(["class_definition"]);
  for (const node of index.of("function_definition")) {
    if (node.type !== "function_definition") continue;
    const name = node.childForFieldName("name")?.text ?? "";
    if (!name.startsWith("test")) continue;
    const holder = node.parent?.type === "decorated_definition" ? node.parent : node;
    const container = holder.parent;
    const suite = enclosing(node, classNames, scope => scope.childForFieldName("name")?.text ?? null);
    if (container?.type === "module") {
      if (collected) scan.cases.set(span(node), { test: { name, suite, framework: "pytest" }, qualified: null });
    } else if (container?.type === "block" && container.parent?.type === "class_definition") {
      const framework = pythonTestClass(container.parent);
      const setup = pythonSetup(container);
      if (framework) scan.cases.set(span(node), { test: { name, suite, framework, ...(setup.length ? { setup } : {}) }, qualified: null });
    }
  }
}

/** A patch call's target, when its arguments say what it replaces. */
function pythonMockTarget(call: Node): MockTarget | null {
  const callee = pyDotted(call.childForFieldName("function"));
  const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter(arg => arg.type !== "comment");
  if (!callee) return null;
  const path = literal(args[0]);
  if (PY_PATCH.has(callee)) return path ? { kind: "path", path } : null;
  const object = pyDotted(args[0] ?? null), name = literal(args[1]);
  if (callee === "monkeypatch.setattr") {
    if (path && args.length === 2) return { kind: "path", path };
    return object && name ? { kind: "member", object, name } : null;
  }
  if (PY_PATCH_OBJECT.has(callee)) return object && name ? { kind: "member", object, name } : null;
  return null;
}

function pythonMocks(index: SyntaxIndex, scan: TestScan): void {
  for (const node of index.of("call")) {
    if (node.type !== "call") continue;
    const target = pythonMockTarget(node);
    if (!target) continue;
    const line = lineOf(node);
    // A decorator patches for the whole of what it decorates: one test, or every test of a decorated class.
    const decorated = node.parent?.type === "decorator" ? node.parent.parent?.childForFieldName("definition") : null;
    if (decorated?.type === "function_definition") scan.mocks.push({ owner: `function:${decorated.startIndex}`, target, line });
    else if (decorated?.type === "class_definition") {
      for (const member of decorated.childForFieldName("body")?.namedChildren ?? []) {
        const method = member.type === "decorated_definition" ? member.childForFieldName("definition") : member;
        if (method?.type === "function_definition" && scan.cases.has(span(method))) scan.mocks.push({ owner: `function:${method.startIndex}`, target, line });
      }
    } else scan.mocks.push({ owner: ownerOf(node), target, line });
  }
}

// ------------------------------------------------------------------------------------------------ JavaScript, TypeScript

const JS_TESTS = new Set(["it", "test", "specify"]);
const JS_SUITES = new Set(["describe", "context", "suite"]);
const JS_FUNCTIONS = new Set(["arrow_function", "function_expression", "function"]);
const JS_MODULE_MOCKS = new Set(["mock", "doMock", "unstable_mockModule"]);

/** The identifier a callee chain starts from, and the property names along it: `it.each(table)` is `it` with `each`. */
function calleeChain(callee: Node | null): { head: string; properties: string[] } | null {
  const properties: string[] = [];
  for (let node = callee; node;) {
    if (node.type === "identifier") return { head: node.text, properties: properties.reverse() };
    if (node.type === "member_expression") {
      properties.push(node.childForFieldName("property")?.text ?? "");
      node = node.childForFieldName("object");
    } else if (node.type === "call_expression") node = node.childForFieldName("function");
    else return null;
  }
  return null;
}

/** Where each imported or required name came from, so a test can say which framework it belongs to. */
function jsImports(index: SyntaxIndex): Map<string, string> {
  const sources = new Map<string, string>();
  for (const node of index.of("import_statement", "variable_declarator")) {
    if (node.type === "import_statement") {
      const source = literal(node.childForFieldName("source"));
      if (!source) continue;
      for (const item of index.within(node)) {
        if (item.type === "import_specifier") sources.set((item.childForFieldName("alias") ?? item.childForFieldName("name"))?.text ?? "", source);
        else if (item.type === "identifier" && ["import_clause", "namespace_import"].includes(item.parent?.type ?? "")) sources.set(item.text, source);
      }
    } else if (node.type === "variable_declarator") {
      const value = node.childForFieldName("value");
      if (value?.type !== "call_expression" || value.childForFieldName("function")?.text !== "require") continue;
      const source = literal(value.childForFieldName("arguments")?.namedChildren[0]);
      const binding = node.childForFieldName("name");
      if (!source || !binding) continue;
      if (binding.type === "identifier") sources.set(binding.text, source);
      for (const item of index.within(binding)) {
        if (item.type === "shorthand_property_identifier_pattern") sources.set(item.text, source);
        else if (item.type === "pair_pattern") sources.set(item.childForFieldName("value")?.text ?? "", source);
      }
    }
  }
  return sources;
}

/**
 * A call's title and callback when it has the shape of a test or a suite: a title first and a function after it. A title built
 * at run time, as a table-driven test in a loop writes `test(t.input + " with " + t.query, ...)`, is named by its source and marked
 * computed: it is one case per row, under names only the run knows.
 */
function titled(call: Node): { title: string; body: Node; computed: boolean } | null {
  const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter(arg => arg.type !== "comment");
  const body = args.slice(1).find(arg => JS_FUNCTIONS.has(arg.type));
  if (!args[0] || !body || JS_FUNCTIONS.has(args[0].type)) return null;
  const title = literal(args[0]);
  if (title !== null) return { title, body, computed: false };
  return { title: computedTitle(args[0]).replace(/\s+/g, " ").slice(0, 120), body, computed: true };
}

/**
 * A title built at run time, as a template: its literal parts as they are, and each part only the run knows as `${source}`.
 * `` `should normalize ${type}` `` and `t.name + " survives"` read `should normalize ${type}` and `${t.name} survives`, which is
 * how the run's own titles are matched to it.
 */
function computedTitle(node: Node): string {
  const written = literal(node);
  if (written !== null) return written;
  if (node.type === "template_string") {
    return node.namedChildren.map(part => (part.type === "template_substitution" ? `\${${part.namedChildren[0]?.text ?? ""}}`
      : part.type === "escape_sequence" ? unescape(part.text) : part.text)).join("");
  }
  if (node.type === "parenthesized_expression" && node.namedChildren.length === 1) return computedTitle(node.namedChildren[0]);
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
    return computedTitle(node.childForFieldName("left")!) + computedTitle(node.childForFieldName("right")!);
  }
  return `\${${node.text}}`;
}

/** Whether a call declares a suite, a test, or neither, with its title and callback when it does. */
function jsRole(call: Node, imports: Map<string, string>): { role: "suite" | "test"; title: string; body: Node; computed: boolean; framework: string; each: boolean } | null {
  if (call.type !== "call_expression") return null;
  const chain = calleeChain(call.childForFieldName("function"));
  const shape = chain ? titled(call) : null;
  if (!chain || !shape) return null;
  const each = chain.properties.includes("each") || shape.computed;
  // Playwright's suites are `test.describe(...)`, written on the test function.
  if (JS_SUITES.has(chain.head) || (JS_TESTS.has(chain.head) && chain.properties.includes("describe"))) return { role: "suite", ...shape, framework: "", each };
  if (chain.head === "Deno" && chain.properties.length === 1 && chain.properties[0] === "test") return { role: "test", ...shape, framework: "deno", each };
  if (JS_TESTS.has(chain.head)) return { role: "test", ...shape, framework: imports.get(chain.head) ?? "global", each };
  return null;
}

function jsTests(index: SyntaxIndex, scan: TestScan): void {
  const imports = jsImports(index);
  for (const node of index.of("call_expression")) {
    const found = jsRole(node, imports);
    if (found?.role === "suite") scan.suites.push({ start: found.body.startIndex, end: found.body.endIndex });
    if (found?.role !== "test") continue;
    // The suites are the calls whose callbacks hold this one. A test inside another test's callback (Playwright's `test.step`)
    // is a step of the test it is in, not a case of its own.
    const suite: string[] = [];
    let nested = false, parametrized = found.each;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!JS_FUNCTIONS.has(parent.type) || parent.parent?.type !== "arguments") continue;
      const outer = jsRole(parent.parent.parent!, imports);
      if (outer?.body.id !== parent.id) continue;
      if (outer.role === "test") nested = true;
      else { suite.unshift(outer.title); parametrized ||= outer.each; }
    }
    if (nested) continue;
    const test = { name: found.title, suite, framework: found.framework, ...(parametrized ? { parametrized: true } : {}) };
    scan.cases.set(span(found.body), { test, qualified: [...suite, found.title].join(" > ") });
  }
}

const jsDotted = (node: Node | null) => dotted(node, "member_expression", "object", "property");

function jsMockTarget(call: Node): MockTarget | null {
  const callee = call.childForFieldName("function");
  if (callee?.type !== "member_expression") return null;
  const object = jsDotted(callee.childForFieldName("object")), property = callee.childForFieldName("property")?.text ?? "";
  const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter(arg => arg.type !== "comment");
  if ((object === "vi" || object === "jest") && JS_MODULE_MOCKS.has(property)) {
    const module = literal(args[0]);
    return module ? { kind: "module", module } : null;
  }
  const member = () => {
    const target = jsDotted(args[0] ?? null), name = literal(args[1]);
    return target && name ? { kind: "member" as const, object: target, name } : null;
  };
  if ((object === "vi" || object === "jest") && property === "spyOn") return member();
  if (object === "sinon" && ["stub", "spy", "replace"].includes(property)) return member();
  // node:test, as `mock.method(obj, 'n')` or through a test context's `t.mock.method(obj, 'n')`, and a whole module as
  // `mock.module('./m.ts', options)` or `t.mock.module(...)`.
  if (property === "method" && object?.split(".").at(-1) === "mock") return member();
  if (property === "module" && object?.split(".").at(-1) === "mock") {
    const module = literal(args[0]);
    return module ? { kind: "module", module } : null;
  }
  return null;
}

function jsMocks(index: SyntaxIndex, scan: TestScan): void {
  for (const node of index.of("call_expression")) {
    if (node.type !== "call_expression") continue;
    const target = jsMockTarget(node);
    if (target) scan.mocks.push({ owner: ownerOf(node), target, line: lineOf(node) });
  }
}

// ------------------------------------------------------------------------------------------------------------------ Rust

const RUST_TESTS = new Set(["test", "rstest"]);

/** Where Rust items sit side by side: a file, and the body of a `mod`. */
const RUST_ITEMS = new Set(["source_file", "declaration_list"]);

/**
 * A function is a test when an attribute directly above it, comments aside, is `#[test]` or ends in `::test` or is `#[rstest]`.
 * Each list of items is read once, front to back, carrying the attributes seen since the last item.
 */
function rustTests(index: SyntaxIndex, scan: TestScan): void {
  const modules = new Set(["mod_item"]);
  for (const container of index.of("source_file", "declaration_list")) {
    if (!RUST_ITEMS.has(container.type)) continue;
    let marker: string | null = null;
    for (const item of container.namedChildren) {
      if (item.type.includes("comment")) continue;
      if (item.type === "attribute_item") {
        const path = item.namedChildren.find(child => child.type === "attribute")?.namedChildren[0] ?? null;
        const last = path?.type === "scoped_identifier" ? path.childForFieldName("name") : path;
        if (path && last && ["identifier", "scoped_identifier"].includes(path.type) && RUST_TESTS.has(last.text)) marker ??= path.text;
        continue;
      }
      if (item.type === "function_item" && marker) {
        const name = item.childForFieldName("name")?.text ?? "";
        const suite = enclosing(item, modules, scope => scope.childForFieldName("name")?.text ?? null);
        scan.cases.set(span(item), { test: { name, suite, framework: marker }, qualified: null });
      }
      marker = null;
    }
  }
}

/** mockall generates `MockX` for the trait or struct `X`, and a test builds one with `MockX::new()` or `MockX::default()`. */
function rustMocks(index: SyntaxIndex, scan: TestScan): void {
  for (const node of index.of("call_expression")) {
    if (node.type !== "call_expression") continue;
    const callee = node.childForFieldName("function");
    if (callee?.type !== "scoped_identifier") continue;
    const type = callee.childForFieldName("path"), method = callee.childForFieldName("name")?.text;
    if (type?.type !== "identifier" || !["new", "default"].includes(method ?? "")) continue;
    if (type.text.startsWith("Mock") && type.text.length > 4)
      scan.mocks.push({ owner: ownerOf(node), target: { kind: "class", name: type.text.slice(4) }, line: lineOf(node) });
  }
}

// ----------------------------------------------------------------------------------------------------------- Java, Kotlin

const JVM_TESTS = new Set(["Test", "ParameterizedTest", "RepeatedTest", "TestFactory", "TestTemplate"]);
const JVM_MOCK_FIELDS = new Set(["Mock", "Spy", "MockBean", "SpyBean", "MockitoBean", "MockitoSpyBean", "MockK", "RelaxedMockK", "SpyK"]);
const MOCKITO_CALLS = new Set(["mock", "spy", "mockStatic", "mockConstruction"]);
const MOCKK_CALLS = new Set(["mockk", "spyk", "mockkClass", "mockkObject", "mockkStatic", "mockkConstructor"]);
const JAVA_CLASSES = new Set(["class_declaration", "enum_declaration", "record_declaration", "interface_declaration"]);
const KOTLIN_CLASSES = new Set(["class_declaration", "object_declaration"]);

/** The annotations on a Java or Kotlin declaration, each as the name it was written with and its last segment. */
function annotations(node: Node, language: string): Array<{ written: string; name: string }> {
  const modifiers = node.namedChildren.find(child => child.type === "modifiers");
  const found: Array<{ written: string; name: string }> = [];
  for (const item of modifiers?.namedChildren ?? []) {
    if (language === "java" && (item.type === "marker_annotation" || item.type === "annotation")) {
      const name = item.childForFieldName("name");
      const last = name?.type === "scoped_identifier" ? name.childForFieldName("name") : name;
      if (name && last) found.push({ written: name.text, name: last.text });
    } else if (language === "kotlin" && item.type === "annotation") {
      const type = item.namedChildren.find(child => child.type === "user_type")
        ?? item.namedChildren.find(child => child.type === "constructor_invocation")?.namedChildren.find(child => child.type === "user_type");
      const parts = type ? named(type, "type_identifier").map(part => part.text) : [];
      if (parts.length) found.push({ written: parts.join("."), name: parts.at(-1)! });
    }
  }
  return found;
}

/** The class a Java type node names: `Store` for `Store`, `List<Store>`'s `List`, and `Outer.Store`'s `Store`. */
function javaTypeName(type: Node | null): string | null {
  if (!type) return null;
  if (type.type === "type_identifier") return type.text;
  if (type.type === "generic_type") return javaTypeName(type.namedChildren[0] ?? null);
  if (type.type === "scoped_type_identifier") return javaTypeName(type.namedChildren.at(-1) ?? null);
  return null;
}

/** The class a Kotlin `user_type` names, by its last segment. */
const kotlinTypeName = (type: Node | null | undefined) => (type ? named(type, "type_identifier").at(-1)?.text ?? null : null);

/** JUnit 4's, JUnit 5's and TestNG's setup: the methods run before each test, or once before a class's tests. */
const JVM_SETUP = new Set(["BeforeEach", "BeforeAll", "Before", "BeforeClass", "BeforeMethod"]);

/**
 * The setup methods that run before a test: those of its class and of every class around it, since a JUnit 5 `@Nested` class's
 * tests run their outer class's `@BeforeEach` first. Each is named by its class, `AccountTest.openAccounts`.
 */
function jvmSetup(node: Node, language: string, classes: Set<string>, className: (scope: Node) => string | null): string[] {
  const kind = language === "java" ? "method_declaration" : "function_declaration";
  const setup: string[] = [];
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (!classes.has(scope.type)) continue;
    const owner = className(scope);
    const body = scope.childForFieldName("body") ?? scope.namedChildren.find(child => child.type === "class_body") ?? null;
    for (const item of body?.namedChildren ?? []) {
      if (item.type !== kind || !owner || !annotations(item, language).some(annotation => JVM_SETUP.has(annotation.name))) continue;
      const name = (language === "java" ? item.childForFieldName("name") : item.namedChildren.find(child => child.type === "simple_identifier"))?.text;
      if (name) setup.push(`${owner}.${name}`);
    }
  }
  return setup;
}

function jvmTests(index: SyntaxIndex, language: string, scan: TestScan): void {
  const kind = language === "java" ? "method_declaration" : "function_declaration";
  const classes = language === "java" ? JAVA_CLASSES : KOTLIN_CLASSES;
  const className = (scope: Node) => (language === "java" ? scope.childForFieldName("name")?.text
    : scope.namedChildren.find(child => ["type_identifier", "simple_identifier"].includes(child.type))?.text) ?? null;
  for (const node of index.of(kind)) {
    if (node.type !== kind) continue;
    const marker = annotations(node, language).find(annotation => JVM_TESTS.has(annotation.name)) ?? (language === "java" ? testngClassMarker(node) : undefined);
    if (!marker) continue;
    const name = (language === "java" ? node.childForFieldName("name") : node.namedChildren.find(child => child.type === "simple_identifier"))?.text ?? "";
    const setup = jvmSetup(node, language, classes, className);
    scan.cases.set(span(node), { test: { name, suite: enclosing(node, classes, className), framework: marker.written, ...(setup.length ? { setup } : {}) }, qualified: null });
  }
}

/** TestNG's configuration annotations, and the two that make a method a data source: none of them is a test. */
const TESTNG_NOT_TESTS = new Set(["BeforeSuite", "AfterSuite", "BeforeTest", "AfterTest", "BeforeGroups", "AfterGroups", "BeforeClass", "AfterClass",
  "BeforeMethod", "AfterMethod", "DataProvider", "Factory"]);

/**
 * TestNG's `@Test` on a class makes every public method declared in it a test. JUnit's `@Test` cannot be put on a class, so on a
 * class it is TestNG's. The class's `@Test` is the method's marker when the method is public and carries none of TestNG's
 * configuration or data-provider annotations.
 */
function testngClassMarker(method: Node): { written: string; name: string } | undefined {
  const owner = method.parent?.type === "class_body" ? method.parent.parent : null;
  if (owner?.type !== "class_declaration") return undefined;
  const marker = annotations(owner, "java").find(annotation => annotation.name === "Test");
  if (!marker) return undefined;
  const modifiers = method.namedChildren.find(child => child.type === "modifiers");
  if (!modifiers || !Array.from({ length: modifiers.childCount }, (_, index) => modifiers.child(index)).some(child => child?.type === "public")) return undefined;
  if (annotations(method, "java").some(annotation => TESTNG_NOT_TESTS.has(annotation.name))) return undefined;
  return marker;
}

function javaMocks(index: SyntaxIndex, scan: TestScan): void {
  for (const node of index.of("field_declaration", "method_invocation")) {
    if (node.type === "field_declaration" && annotations(node, "java").some(annotation => JVM_MOCK_FIELDS.has(annotation.name))) {
      const name = javaTypeName(node.childForFieldName("type"));
      if (name) scan.mocks.push({ owner: "file", target: { kind: "class", name }, line: lineOf(node) });
    } else if (node.type === "method_invocation" && MOCKITO_CALLS.has(node.childForFieldName("name")?.text ?? "")) {
      const object = node.childForFieldName("object");
      if (object && object.text !== "Mockito") continue;
      const literalClass = node.childForFieldName("arguments")?.namedChildren[0];
      const name = literalClass?.type === "class_literal" ? javaTypeName(literalClass.namedChildren[0] ?? null) : null;
      if (name) scan.mocks.push({ owner: ownerOf(node), target: { kind: "class", name }, line: lineOf(node) });
    }
  }
}

function kotlinMocks(index: SyntaxIndex, scan: TestScan): void {
  for (const node of index.of("property_declaration", "call_expression")) {
    if (node.type === "property_declaration" && annotations(node, "kotlin").some(annotation => JVM_MOCK_FIELDS.has(annotation.name))) {
      const declared = node.namedChildren.find(child => child.type === "variable_declaration");
      const name = kotlinTypeName(declared?.namedChildren.find(child => child.type === "user_type"));
      if (name) scan.mocks.push({ owner: "file", target: { kind: "class", name }, line: lineOf(node) });
    } else if (node.type === "call_expression") {
      const callee = node.namedChildren[0];
      if (callee?.type !== "simple_identifier" || !MOCKK_CALLS.has(callee.text)) continue;
      const suffix = node.namedChildren.find(child => child.type === "call_suffix");
      // `mockk<Store>()` names the class as a type argument, `mockkClass(Store::class)` as a class reference, and
      // `mockkObject(Util)` as the object itself.
      const typed = suffix?.namedChildren.find(child => child.type === "type_arguments")?.namedChildren[0]?.namedChildren.find(child => child.type === "user_type");
      const argument = suffix?.namedChildren.find(child => child.type === "value_arguments")?.namedChildren[0]?.namedChildren[0];
      const name = kotlinTypeName(typed)
        ?? (argument?.type === "callable_reference" ? argument.namedChildren.find(child => child.type === "type_identifier")?.text ?? null : null)
        ?? (argument?.type === "simple_identifier" && callee.text === "mockkObject" ? argument.text : null);
      if (name) scan.mocks.push({ owner: ownerOf(node), target: { kind: "class", name }, line: lineOf(node) });
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------ C, C++

const GTEST = new Set(["TEST", "TEST_F", "TEST_P", "TYPED_TEST", "TYPED_TEST_P"]);
const CATCH_FIXTURES = new Set(["TEST_CASE_METHOD", "CATCH_TEST_CASE_METHOD", "SCENARIO_METHOD", "CATCH_SCENARIO_METHOD", "TEST_CASE_FIXTURE", "DOCTEST_TEST_CASE_FIXTURE"]);
const CATCH = new Set(["TEST_CASE", "SCENARIO", "CATCH_TEST_CASE", "CATCH_SCENARIO", "DOCTEST_TEST_CASE", "DOCTEST_SCENARIO", ...CATCH_FIXTURES]);

/**
 * The classes a fixture's members are constructed as, when the fixture is declared in the file and gives them a value:
 * `TokenBucket bucket{5, 2, clock};` constructs a TokenBucket for each test, with no constructor of the fixture's to say so.
 */
function cppMembers(index: SyntaxIndex, fixture: string): string[] {
  let body: Node | null = null;
  for (const node of index.of("class_specifier", "struct_specifier")) {
    if ((node.type === "class_specifier" || node.type === "struct_specifier") && node.childForFieldName("name")?.text === fixture) { body = node.childForFieldName("body"); break; }
  }
  return (body?.namedChildren ?? []).filter(item => item.type === "field_declaration" && item.childForFieldName("default_value"))
    .map(item => item.childForFieldName("type")).filter(type => type && ["type_identifier", "qualified_identifier", "template_type"].includes(type.type) && !type.text.startsWith("std::"))
    .map(type => type!.text.replace(/<[\s\S]*>$/, ""));
}

/** A test case's title, less the decorators doctest multiplies onto it: `"slow" * doctest::skip()` is `slow`. */
function decoratedTitle(node: Node | undefined): string | null {
  if (node?.type === "binary_expression" && node.childForFieldName("operator")?.text === "*") return decoratedTitle(node.childForFieldName("left") ?? undefined);
  return literal(node);
}

/** Each framework's macros that take a block, as `catch_test_macros.hpp` and `doctest.h` define them, prefixed forms included. */
const CATCH2_BLOCKS = ["TEST_CASE", "SCENARIO", "SECTION", "DYNAMIC_SECTION", "GIVEN", "AND_GIVEN", "WHEN", "AND_WHEN", "THEN", "AND_THEN"];
const DOCTEST_BLOCKS = ["TEST_CASE", "SCENARIO", "TEST_SUITE", "SUBCASE", "GIVEN", "AND_GIVEN", "WHEN", "AND_WHEN", "THEN", "AND_THEN"];
const BLOCK_MACROS = {
  catch2: new Set([...CATCH2_BLOCKS, ...CATCH2_BLOCKS.map(name => `CATCH_${name}`)]),
  doctest: new Set([...DOCTEST_BLOCKS, ...DOCTEST_BLOCKS.map(name => `DOCTEST_${name}`)]),
};

/** The macro a function definition is written with, as in `TEST(Suite, Name) { }`, and its parameters. */
function macroDefinition(node: Node): { macro: string; parameters: Node[] } | null {
  const declarator = node.childForFieldName("declarator");
  if (declarator?.type !== "function_declarator") return null;
  const macro = declarator.childForFieldName("declarator");
  if (macro?.type !== "identifier") return null;
  return { macro: macro.text, parameters: named(declarator.childForFieldName("parameters") ?? declarator, "parameter_declaration") };
}

/** Where C++ declarations sit side by side: a file, and the body of a namespace. */
const CPP_SCOPES = new Set(["translation_unit", "declaration_list"]);

function cppTests(index: SyntaxIndex, scan: TestScan): void {
  for (const node of index.of("function_definition")) {
    if (node.type !== "function_definition") continue;
    // gtest's macros parse as a function named by the macro whose two parameters are types: the suite and the test.
    const definition = macroDefinition(node);
    if (!definition || !GTEST.has(definition.macro) || definition.parameters.length !== 2) continue;
    const [suite, name] = definition.parameters.map(parameter => parameter.childForFieldName("type"));
    if (suite?.type !== "type_identifier" || name?.type !== "type_identifier" || parameterHasDeclarator(definition.parameters)) continue;
    // TEST_F's and TEST_P's first argument is a fixture class: gtest constructs it and calls its SetUp before the test body.
    const setup = definition.macro === "TEST" ? [] : [suite.text, ...cppMembers(index, suite.text), `${suite.text}.SetUp`];
    scan.cases.set(span(node), { test: { name: name.text, suite: [suite.text], framework: definition.macro, ...(setup.length ? { setup } : {}) }, qualified: `${suite.text}.${name.text}` });
  }
  // Catch2's and doctest's `TEST_CASE("name") { }` is not a function to the grammar: it is a call statement followed by a block.
  // Each scope's declarations are read once, front to back, pairing the call with the block after it. A SECTION or SUBCASE is
  // inside that block, never in a scope, so it is part of its test case and not a test.
  const library = cppLibrary(index);
  if (library) scan.blockMacros = BLOCK_MACROS[library];
  for (const scope of index.of("translation_unit", "declaration_list", "compound_statement")) {
    const suite = testScope(scope, library);
    if (!suite) continue;
    const items = scope.namedChildren.filter(item => !item.type.includes("comment"));
    for (const [at, item] of items.entries()) {
      const macro = macroCall(item);
      if (!macro || !CATCH.has(macro.name)) continue;
      // Catch2's TEST_CASE_METHOD and doctest's TEST_CASE_FIXTURE take a fixture class first: each test case is a fresh instance
      // of it, so the test runs its constructor and reaches its members.
      const fixture = CATCH_FIXTURES.has(macro.name) ? macro.arguments[0]?.text ?? null : null;
      const written = decoratedTitle(macro.arguments[fixture === null ? 0 : 1]);
      const body = items[at + 1];
      if (written === null || body?.type !== "compound_statement") continue;
      const name = macro.name.endsWith("SCENARIO") && library ? `${SCENARIO_PREFIX[library]}${written}` : written;
      scan.bodies.push(body);
      const fixed = fixture === null ? {} : { fixture, setup: [fixture, ...cppMembers(index, fixture)] };
      scan.cases.set(span(body), { test: { name, suite, framework: library ?? macro.name, ...fixed }, qualified: [...suite, name].join(".") });
    }
  }
}

/**
 * The framework whose `TEST_CASE` a C++ file uses, by the header it includes: Catch2 (`catch2/...` from v3, `catch.hpp` from v2)
 * or doctest. The two spell a test the same way and name it differently in their reports. Null when the file includes neither,
 * and its test then goes by the macro's name for a framework.
 */
function cppLibrary(index: SyntaxIndex): "catch2" | "doctest" | null {
  for (const node of index.of("preproc_include")) {
    if (node.type !== "preproc_include") continue;
    const path = node.childForFieldName("path");
    const header = path?.type === "system_lib_string" ? path.text.slice(1, -1) : literal(path);
    if (header?.startsWith("catch2/") || header === "catch.hpp") return "catch2";
    if (header === "doctest.h" || header?.endsWith("/doctest.h")) return "doctest";
  }
  return null;
}

/** What a `SCENARIO` macro puts before its name: `TEST_CASE("Scenario: " name)` in Catch2, `"  Scenario: "` in doctest. */
const SCENARIO_PREFIX = { catch2: "Scenario: ", doctest: "  Scenario: " };

/** A statement that is a macro call, `NAME(args)`, as the macro's name and its arguments. */
function macroCall(item: Node): { name: string; arguments: Node[] } | null {
  const call = item.type === "expression_statement" ? item.namedChildren[0] : null;
  const macro = call?.type === "call_expression" ? call.childForFieldName("function") : null;
  if (macro?.type !== "identifier") return null;
  return { name: macro.text, arguments: (call!.childForFieldName("arguments")?.namedChildren ?? []).filter(arg => !arg.type.includes("comment")) };
}

/** doctest's `TEST_SUITE("name") { }`, a call statement and then a block: the suite's name when `block` is one, otherwise null. */
function doctestSuite(block: Node): string | null {
  if (block.type !== "compound_statement" || !block.parent) return null;
  const items = block.parent.namedChildren.filter(item => !item.type.includes("comment"));
  const index = items.findIndex(item => item.startIndex === block.startIndex);
  const macro = index > 0 ? macroCall(items[index - 1]) : null;
  return macro?.name === "TEST_SUITE" || macro?.name === "DOCTEST_TEST_SUITE" ? literal(macro.arguments[0]) : null;
}

/**
 * The suites a scope's test cases are in, when the scope is one test cases are declared in: a file, a namespace's body, and in
 * doctest a `TEST_SUITE` block. Null for any other node.
 */
function testScope(scope: Node, library: string | null): string[] | null {
  const suiteOf = (node: Node) => (library === "doctest" ? doctestSuite(node) : null);
  if (!CPP_SCOPES.has(scope.type) && suiteOf(scope) === null) return null;
  const suites: string[] = [];
  for (let node: Node | null = scope; node; node = node.parent) {
    const name = suiteOf(node);
    if (name !== null) suites.unshift(name);
  }
  return suites;
}

/** `TEST(Suite, Name)` has bare types for parameters; a real function `f(Suite s, Name n)` names its parameters. */
const parameterHasDeclarator = (parameters: Node[]) => parameters.some(parameter => parameter.childForFieldName("declarator"));

/** A gmock class, `class MockStore : public Store { MOCK_METHOD(...); }`, stands in for each class it derives from. */
function cppMocks(index: SyntaxIndex, scan: TestScan): void {
  for (const node of index.of("class_specifier", "struct_specifier")) {
    if (node.type !== "class_specifier" && node.type !== "struct_specifier") continue;
    const body = node.childForFieldName("body");
    const mocking = body && index.within(body).some(item => item.type === "function_declarator"
      && item.childForFieldName("declarator")?.type === "identifier"
      && ["MOCK_METHOD", "MOCK_CONST_METHOD"].some(prefix => item.childForFieldName("declarator")!.text.startsWith(prefix)));
    if (!mocking) continue;
    const bases = node.namedChildren.find(child => child.type === "base_class_clause")?.namedChildren ?? [];
    for (const base of bases) {
      const name = base.type === "type_identifier" ? base.text : base.type === "qualified_identifier" ? base.childForFieldName("name")?.text : null;
      if (name) scan.mocks.push({ owner: "file", target: { kind: "class", name }, line: lineOf(node) });
    }
  }
}

// --------------------------------------------------------------------------------------------------------------- package

function packageOf(root: Node, language: string): string | null {
  for (const node of root.namedChildren) {
    if (language === "java" && node.type === "package_declaration") return node.namedChildren.find(child => child.type.endsWith("identifier"))?.text ?? null;
    if (language === "kotlin" && node.type === "package_header") {
      const name = node.namedChildren.find(child => child.type === "identifier");
      return name ? named(name, "simple_identifier").map(part => part.text).join(".") : null;
    }
    if (language === "go" && node.type === "package_clause") return node.namedChildren.find(child => child.type === "package_identifier")?.text ?? null;
    // PHP's namespace is its package: `namespace App\Tests;` puts every class in the file in App\Tests.
    if (language === "php" && node.type === "namespace_definition") return node.childForFieldName("name")?.text ?? null;
  }
  return null;
}

/** The remaining languages, each in a module of its own under tests/. */
const OTHERS: Record<string, (index: SyntaxIndex, scan: TestScan, path: string | null) => void> = {
  go: goTests,
  c_sharp: csharpTests,
  ruby: rubyTests,
  php: phpTests,
  lua: luaTests,
  swift: swiftTests,
  zig: zigTests,
  solidity: solidityTests,
  scala: scalaTests,
  groovy: groovyTests,
  bash: bashTests,
};

/** The test cases, mocks and package of one parsed file. */
export function findTests(root: Node, language: string, path: string | null, index: SyntaxIndex): TestScan {
  const scan: TestScan = { cases: new Map(), bodies: [], mocks: [], package: packageOf(root, language), blockMacros: new Set(), suites: [] };
  if (language === "python") { pythonTests(index, path, scan); pythonMocks(index, scan); }
  else if (["javascript", "typescript", "tsx"].includes(language)) { jsTests(index, scan); jsMocks(index, scan); }
  else if (language === "rust") { rustTests(index, scan); rustMocks(index, scan); }
  else if (language === "java") { jvmTests(index, language, scan); javaMocks(index, scan); }
  else if (language === "kotlin") { jvmTests(index, language, scan); kotlinMocks(index, scan); }
  else if (language === "cpp" || language === "c") { cppTests(index, scan); cppMocks(index, scan); if (language === "c") cTests(index, scan, path); }
  else if (language in OTHERS) OTHERS[language](index, scan, path);
  return scan;
}
