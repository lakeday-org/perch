/**
 * What in a parsed PHP file is a test case, and what it mocks. Every answer is read off syntax nodes: a class's base clause, a
 * method's name and attributes inside such a class, the docblock comment beside it, and a call's callee and arguments.
 *
 * PHPUnit runs the public `test*` methods of a class extending TestCase, and any method marked `#[Test]` or `@test`. Pest
 * declares tests as `it('name', function () { ... })` and `test(...)`, grouped by `describe(...)`.
 */
import type { Node } from "../node";
import type { TestScan } from "../tests";
import type { MockTarget } from "../types";
import { enclosing, lineOf, literal, ownerIn, span } from "../tests";
import type { SyntaxIndex } from "../visit";

const CLASSES = new Set(["class_declaration"]);
const className = (scope: Node) => scope.childForFieldName("name")?.text ?? null;
/** The last segment of a `name` or `qualified_name`: `TestCase` for `\PHPUnit\Framework\TestCase`. */
const lastName = (node: Node | null | undefined) => node?.text.split("\\").at(-1) ?? "";

/** Whether a class is a PHPUnit test case: it extends TestCase, or a project's own base named for one, `KernelTestCase`, `BaseTest`. */
function phpunitClass(node: Node): boolean {
  const bases = node.namedChildren.find(child => child.type === "base_clause")?.namedChildren ?? [];
  return bases.some(base => /(?:TestCase|Test)$/.test(lastName(base)));
}

/** The names of a declaration's attributes, `Test` for `#[Test]` and for `#[\PHPUnit\Framework\Attributes\Test]`. */
function attributes(node: Node): string[] {
  const list = node.childForFieldName("attributes");
  return (list ? [...list.namedChildren.flatMap(group => group.namedChildren)] : [])
    .filter(attribute => attribute.type === "attribute").map(attribute => lastName(attribute.namedChildren[0]));
}

/** The annotations in the docblock written directly above a declaration, `@test` and `@dataProvider`, each as its tag. */
function docblock(node: Node): string[] {
  const siblings = node.parent?.namedChildren ?? [];
  const at = siblings.findIndex(item => item.id === node.id);
  const before = at > 0 ? siblings[at - 1] : null;
  if (before?.type !== "comment" || !before.text.startsWith("/**")) return [];
  return before.text.split(/\s+/).filter(word => word.startsWith("@")).map(word => word.slice(1));
}

const PROVIDERS = new Set(["DataProvider", "DataProviderExternal", "TestWith", "TestWithJson"]);
const PROVIDER_TAGS = new Set(["dataProvider", "testWith"]);

function phpunitTests(index: SyntaxIndex, scan: TestScan): void {
  for (const node of index.of("class_declaration")) {
    if (!phpunitClass(node)) continue;
    const body = node.childForFieldName("body");
    const methods = body?.namedChildren.filter(item => item.type === "method_declaration") ?? [];
    const suite = [...enclosing(node, CLASSES, className), className(node) ?? ""].filter(Boolean);
    const owner = suite.join(".");
    const setup = methods.map(method => method.childForFieldName("name")?.text ?? "").filter(name => name === "setUp" || name === "setUpBeforeClass").map(name => `${owner}.${name}`);
    for (const method of methods) {
      const name = method.childForFieldName("name")?.text ?? "";
      const marked = attributes(method), tagged = docblock(method);
      if (!name.startsWith("test") && !marked.includes("Test") && !tagged.includes("test")) continue;
      // PHPUnit's own hooks and a data provider happen to start with test only by accident; none of them is a test.
      if (/^(?:setUp|tearDown)/.test(name)) continue;
      const parametrized = marked.some(item => PROVIDERS.has(item)) || tagged.some(item => PROVIDER_TAGS.has(item));
      scan.cases.set(span(method), { test: { name, suite, framework: "phpunit", ...(setup.length ? { setup } : {}), ...(parametrized ? { parametrized: true } : {}) }, qualified: null });
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------- Pest

const PEST_TESTS = new Set(["it", "test"]);
const PEST_SUITES = new Set(["describe"]);
const PEST_HOOKS = new Set(["beforeEach", "beforeAll", "afterEach", "afterAll"]);
const CLOSURES = new Set(["anonymous_function", "arrow_function"]);

/** A Pest call's role, title and closure: `it('adds', function () { ... })`, `describe('cart', function () { ... })`. */
function pestRole(call: Node): { role: "suite" | "test"; title: string; body: Node } | null {
  if (call.type !== "function_call_expression") return null;
  const callee = call.childForFieldName("function");
  if (callee?.type !== "name" || !(PEST_TESTS.has(callee.text) || PEST_SUITES.has(callee.text))) return null;
  const args = (call.childForFieldName("arguments")?.namedChildren ?? []).map(arg => arg.namedChildren[0]).filter(Boolean);
  const title = literal(args[0]);
  const body = args.slice(1).find(arg => CLOSURES.has(arg.type));
  if (title === null || !body) return null;
  return { role: PEST_SUITES.has(callee.text) ? "suite" : "test", title, body };
}

/** The chain a Pest test is written into: `it(...)->with([...])` makes it one case per dataset. */
function chained(call: Node, method: string): boolean {
  for (let node = call; node.parent?.type === "member_call_expression" && node.parent.childForFieldName("object")?.id === node.id; node = node.parent) {
    if (node.parent.childForFieldName("name")?.text === method) return true;
  }
  return false;
}

function pestTests(index: SyntaxIndex, scan: TestScan, root: Node): void {
  let hooks = false;
  for (const node of index.of("function_call_expression")) {
    const callee = node.childForFieldName("function");
    if (callee?.type === "name" && PEST_HOOKS.has(callee.text) && node.parent?.parent?.id === root.id) hooks = true;
    const found = pestRole(node);
    if (found?.role === "suite") scan.suites.push({ start: found.body.startIndex, end: found.body.endIndex });
    if (found?.role !== "test") continue;
    const suite: string[] = [];
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!CLOSURES.has(parent.type) || parent.parent?.type !== "argument") continue;
      const outer = parent.parent.parent?.parent;
      const role = outer ? pestRole(outer) : null;
      if (role?.role === "suite" && role.body.id === parent.id) suite.unshift(role.title);
    }
    const parametrized = chained(node, "with");
    scan.cases.set(span(found.body), { test: { name: found.title, suite, framework: "pest", ...(parametrized ? { parametrized: true } : {}) }, qualified: [...suite, found.title].join(" > ") });
  }
  // A `beforeEach` at the top of a Pest file runs before every test in it: the whole file is the suite its setup belongs to.
  if (hooks && scan.cases.size) scan.suites.push({ start: root.startIndex, end: root.endIndex });
}

// ------------------------------------------------------------------------------------------------------------------ mocks

const MOCK_METHODS = new Set(["createMock", "createStub", "createPartialMock", "createConfiguredMock", "getMockBuilder", "mock", "partialMock", "spy"]);

/** `X::class`: the class a mock stands in for. */
function classLiteral(argument: Node | undefined): string | null {
  const value = argument?.namedChildren[0];
  if (value?.type !== "class_constant_access_expression") return null;
  const [owner, constant] = value.namedChildren;
  return constant?.text === "class" && owner ? lastName(owner) : null;
}

/** `$this->createMock(Cart::class)`, `Mockery::mock(Cart::class)`, Pest's `mock(Cart::class)`. */
function phpMockTarget(call: Node): MockTarget | null {
  const callee = call.type === "function_call_expression" ? call.childForFieldName("function") : call.childForFieldName("name");
  const method = callee?.type === "name" ? callee.text : null;
  if (!method || !MOCK_METHODS.has(method)) return null;
  if (call.type === "scoped_call_expression" && call.childForFieldName("scope")?.text !== "Mockery") return null;
  const name = classLiteral(call.childForFieldName("arguments")?.namedChildren[0]);
  return name ? { kind: "class", name } : null;
}

function phpMocks(index: SyntaxIndex, scan: TestScan): void {
  for (const node of index.of("member_call_expression", "scoped_call_expression", "function_call_expression")) {
    const target = phpMockTarget(node);
    if (target) scan.mocks.push({ owner: ownerIn(node, scan), target, line: lineOf(node) });
  }
}

export function phpTests(index: SyntaxIndex, scan: TestScan, _path: string | null): void {
  const root = index.all[0];
  phpunitTests(index, scan);
  if (root) pestTests(index, scan, root);
  phpMocks(index, scan);
}
