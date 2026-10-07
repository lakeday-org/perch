/**
 * What in a parsed Go file is a test case. Every answer is read off syntax nodes: a function's name and the type of its one
 * parameter, a `t.Run` call's title and callback, a struct's embedded `suite.Suite`. That `go test` only compiles `_test.go`
 * files is a rule about which files are test code, kept in test-scope.js; it decides nothing here.
 */
import type { Node } from "../node";
import { isFunction } from "../metrics";
import { computedTitle, literal, span, type FoundTest, type TestScan } from "../tests";
import type { SyntaxIndex } from "../visit";

/** `*testing.T`: a pointer to the type T of the package testing. `kind` is T for a test, M for TestMain, B for a benchmark. */
function testingType(type: Node | null, kind: string): boolean {
  if (type?.type !== "pointer_type") return false;
  const qualified = type.namedChildren[0];
  return qualified?.type === "qualified_type" && qualified.childForFieldName("package")?.text === "testing" && qualified.childForFieldName("name")?.text === kind;
}

/** The name of a function's one parameter when that parameter is a `*testing.T`, and null for any other signature. */
function testingParameter(fn: Node): string | null {
  const parameters = fn.childForFieldName("parameters")?.namedChildren.filter(item => item.type === "parameter_declaration") ?? [];
  if (parameters.length !== 1 || fn.childForFieldName("parameters")?.namedChildren.length !== 1) return null;
  const names = parameters[0].namedChildren.filter(item => item.type === "identifier");
  return names.length === 1 && testingType(parameters[0].childForFieldName("type"), "T") ? names[0].text : null;
}

/** Go's rule for a test function's name: `Test` followed by nothing, or by a character that is not a lowercase letter. */
const TEST_NAME = /^Test(?:$|[^a-z])/;

/** The type a method's receiver names: `Cart` for `func (c *Cart) Add()`. */
function receiverType(method: Node): string | null {
  const receiver = method.childForFieldName("receiver")?.namedChildren.find(item => item.type === "parameter_declaration");
  let type = receiver?.childForFieldName("type") ?? null;
  if (type?.type === "pointer_type") type = type.namedChildren[0] ?? null;
  return type?.type === "type_identifier" ? type.text : null;
}

/** The struct types declared in the file that embed testify's `suite.Suite`, which makes their `Test*` methods tests. */
function testifySuites(index: SyntaxIndex): Set<string> {
  const suites = new Set<string>();
  for (const spec of index.of("type_spec")) {
    const struct = spec.childForFieldName("type");
    const name = spec.childForFieldName("name");
    if (struct?.type !== "struct_type" || !name) continue;
    const fields = struct.namedChildren.find(item => item.type === "field_declaration_list")?.namedChildren ?? [];
    const embedded = fields.some(field => field.type === "field_declaration" && !field.childForFieldName("name")
      && field.childForFieldName("type")?.type === "qualified_type" && field.childForFieldName("type")!.childForFieldName("package")?.text === "suite"
      && field.childForFieldName("type")!.childForFieldName("name")?.text === "Suite");
    if (embedded) suites.add(name.text);
  }
  return suites;
}

/** testify's setup hooks, in the order it runs them before each test method. */
const TESTIFY_SETUP = ["SetupSuite", "SetupTest", "BeforeTest"];

/** The test case a node is declared inside, innermost first: the function around it that this file found to be a test. */
function enclosingCase(node: Node, scan: TestScan): { node: Node; found: FoundTest } | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!isFunction(parent)) continue;
    const found = scan.cases.get(span(parent));
    if (found) return { node: parent, found };
  }
  return null;
}

export function goTests(index: SyntaxIndex, scan: TestScan, path: string | null): void {
  void path;
  // `func TestX(t *testing.T)`: the testing package's test. TestMain takes a *testing.M and a benchmark a *testing.B; neither is one.
  for (const node of index.of("function_declaration")) {
    const name = node.childForFieldName("name")?.text ?? "";
    if (!TEST_NAME.test(name) || !testingParameter(node)) continue;
    scan.cases.set(span(node), { test: { name, suite: [], framework: "testing" }, qualified: null });
  }
  // testify: `func (s *CartSuite) TestAdd()` on a struct embedding suite.Suite, run by suite.Run from a testing test.
  const suites = testifySuites(index);
  if (suites.size) {
    const methods = index.of("method_declaration").filter(node => node.type === "method_declaration");
    const methodsOf = (type: string) => methods.filter(node => receiverType(node) === type).map(node => node.childForFieldName("name")?.text ?? "");
    for (const node of methods) {
      const type = receiverType(node), name = node.childForFieldName("name")?.text ?? "";
      if (!type || !suites.has(type) || !TEST_NAME.test(name)) continue;
      const declared = methodsOf(type);
      const setup = TESTIFY_SETUP.filter(hook => declared.includes(hook)).map(hook => `${type}.${hook}`);
      scan.cases.set(span(node), { test: { name, suite: [type], framework: "testify", ...(setup.length ? { setup } : {}) }, qualified: null });
    }
  }
  // `t.Run("name", func(t *testing.T) { })` inside a test: a subtest, named under its parent as `TestX/name`. The call is on the
  // enclosing test's own *testing.T, and the callback takes one. A title built at run time, as a table-driven test's loop does,
  // is one case per row under names only the run knows, so it is named by its source and marked parametrized.
  for (const node of index.of("call_expression")) {
    const callee = node.childForFieldName("function");
    if (callee?.type !== "selector_expression" || callee.childForFieldName("field")?.text !== "Run") continue;
    const receiver = callee.childForFieldName("operand");
    const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter(arg => !arg.type.includes("comment"));
    const body = args[1];
    if (receiver?.type !== "identifier" || args.length !== 2 || body?.type !== "func_literal" || !testingParameter(body)) continue;
    const parent = enclosingCase(node, scan);
    if (!parent || testingParameter(parent.node) !== receiver.text) continue;
    const written = literal(args[0]);
    const name = written ?? computedTitle(args[0]).replace(/\s+/g, " ").slice(0, 120);
    const parametrized = written === null || parent.found.test.parametrized === true;
    const suite = [...parent.found.test.suite, parent.found.test.name];
    const qualified = `${parent.found.qualified ?? parent.found.test.name}/${name}`;
    scan.cases.set(span(body), { test: { name, suite, framework: parent.found.test.framework, ...(parametrized ? { parametrized: true } : {}) }, qualified });
  }
}
