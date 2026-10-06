/**
 * What in a parsed Swift file is a test case. Every answer is read off syntax nodes. XCTest runs each `func test...()` taking no
 * parameters in a class that inherits XCTestCase, after the class's `setUp`. Swift Testing runs each function marked `@Test`,
 * wherever it is declared, under the display name the attribute gives it when it gives one.
 */
import type { Node } from "../node";
import { enclosing, literal, span, type TestScan } from "../tests";
import type { SyntaxIndex } from "../visit";

/** Swift's class, struct, enum, actor and extension declarations are all a `class_declaration` with a declaration kind. */
const TYPES = new Set(["class_declaration", "protocol_declaration"]);

/** XCTest's per-test setup, in the order it runs them: the synchronous one first, then the throwing one. */
const XCTEST_SETUP = new Set(["setUp", "setUpWithError"]);

/** The attributes on a declaration: each by its name, with its arguments. */
function attributes(node: Node): Array<{ name: string; attribute: Node }> {
  const modifiers = node.namedChildren.find(child => child.type === "modifiers");
  return (modifiers?.namedChildren ?? []).filter(child => child.type === "attribute").map(attribute => {
    const type = attribute.namedChildren.find(child => child.type === "user_type");
    return { name: type?.namedChildren.filter(child => child.type === "type_identifier").at(-1)?.text ?? "", attribute };
  });
}

/** The types a class declaration inherits from, by the last segment of each: `XCTestCase`, `Shop.CartTestCase`'s CartTestCase. */
function inherits(node: Node): string[] {
  return node.namedChildren.filter(child => child.type === "inheritance_specifier")
    .map(child => child.childForFieldName("inherits_from")?.namedChildren.filter(part => part.type === "type_identifier").at(-1)?.text ?? "").filter(Boolean);
}

/**
 * Whether a type is an XCTest case class: it inherits XCTestCase, or a class named for being one, since a project's own base
 * case sits between most of its suites and XCTestCase, in a file this one cannot see into.
 */
const isTestCase = (node: Node) => inherits(node).some(name => name === "XCTestCase" || /TestCase$/.test(name));

/** The type a function is declared in, when it is declared in one. */
function typeOf(node: Node): Node | null {
  for (let parent = node.parent; parent; parent = parent.parent) if (TYPES.has(parent.type)) return parent;
  return null;
}

/**
 * What XCTest runs before a test of this class: a fresh instance, so each stored property's initializer (`let cart = Cart()`
 * constructs a Cart), then `setUp` and `setUpWithError`, as calls on the class name them.
 */
function xctestSetup(type: Node): string[] {
  const owner = type.childForFieldName("name")?.text;
  if (!owner) return [];
  const setup: string[] = [];
  for (const item of type.childForFieldName("body")?.namedChildren ?? []) {
    if (item.type === "property_declaration") {
      const value = item.childForFieldName("value");
      const constructed = value?.type === "call_expression" ? value.namedChildren[0] : null;
      if (constructed?.type === "simple_identifier" && /^[A-Z]/.test(constructed.text)) setup.push(constructed.text);
    } else if (item.type === "function_declaration" && XCTEST_SETUP.has(item.childForFieldName("name")?.text ?? "")) {
      setup.push(`${owner}.${item.childForFieldName("name")!.text}`);
    }
  }
  return setup;
}

const typeName = (scope: Node) => scope.childForFieldName("name")?.text ?? null;

export function swiftTests(index: SyntaxIndex, scan: TestScan, path: string | null): void {
  void path;
  for (const node of index.of("function_declaration")) {
    if (node.type !== "function_declaration") continue;
    const name = node.childForFieldName("name")?.text ?? "";
    const type = typeOf(node);
    const suite = enclosing(node, TYPES, typeName);
    const test = attributes(node).find(attribute => attribute.name === "Test");
    if (test) {
      // `@Test("display name", arguments: rows)`: the first argument, a string literal, is the name the test runs under; an
      // `arguments:` label makes it one case per element.
      const args = test.attribute.namedChildren.filter(child => child.type !== "user_type");
      const title = literal(args[0]);
      const parametrized = args.some(child => child.type === "simple_identifier" && child.text === "arguments");
      scan.cases.set(span(node), { test: { name: title ?? name, suite, framework: "Testing", ...(parametrized ? { parametrized: true } : {}) }, qualified: null });
      continue;
    }
    // XCTest finds a test by its shape: a method whose name starts with `test`, taking nothing, on an XCTestCase subclass.
    if (!type || !name.startsWith("test") || node.namedChildren.some(child => child.type === "parameter") || !isTestCase(type)) continue;
    const setup = xctestSetup(type);
    scan.cases.set(span(node), { test: { name, suite, framework: "XCTest", ...(setup.length ? { setup } : {}) }, qualified: null });
  }
}
