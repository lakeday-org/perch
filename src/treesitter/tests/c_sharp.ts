/**
 * What in a parsed C# file is a test case. Every answer is read off syntax nodes: the attributes on a method, and the class it
 * is declared in. xUnit marks a test `[Fact]` or `[Theory]`, NUnit `[Test]` or `[TestCase]`, MSTest `[TestMethod]`; each
 * framework's attribute names which framework the test belongs to, and its own setup attribute names what runs before it.
 */
import type { Node } from "../node";
import { enclosing, span, type TestScan } from "../tests";
import type { SyntaxIndex } from "../visit";

/** Each framework's test attributes, and the ones among them that run the method once per row of data. */
const FRAMEWORKS: Record<string, { tests: Set<string>; parametrized: Set<string>; setup: Set<string> }> = {
  xunit: { tests: new Set(["Fact", "Theory"]), parametrized: new Set(["Theory"]), setup: new Set() },
  nunit: { tests: new Set(["Test", "TestCase", "TestCaseSource", "Theory", "Combinatorial", "Pairwise", "Sequential"]),
    parametrized: new Set(["TestCase", "TestCaseSource", "Theory", "Combinatorial", "Pairwise", "Sequential"]), setup: new Set(["SetUp", "OneTimeSetUp"]) },
  mstest: { tests: new Set(["TestMethod", "DataTestMethod"]), parametrized: new Set(["DataTestMethod"]), setup: new Set(["TestInitialize", "ClassInitialize"]) },
};

/** The attribute names NUnit and MSTest use for data rows on a method whose test marker is a plain one. */
const DATA_ROWS = new Set(["TestCase", "TestCaseSource", "Values", "ValueSource", "Range", "Random", "DataRow", "DynamicData"]);

const CLASSES = new Set(["class_declaration", "struct_declaration", "record_declaration"]);

/** The attributes on a declaration, each by the last segment of its name: `[Xunit.Fact]` is Fact. */
function attributes(node: Node): string[] {
  const found: string[] = [];
  for (const list of node.namedChildren.filter(child => child.type === "attribute_list")) {
    for (const attribute of list.namedChildren.filter(child => child.type === "attribute")) {
      const name = attribute.childForFieldName("name");
      const last = name?.type === "qualified_name" ? name.childForFieldName("name") : name;
      if (last) found.push(last.text.replace(/Attribute$/, ""));
    }
  }
  return found;
}

/**
 * The framework a method's attributes belong to. `Theory` is both xUnit's and NUnit's, and `Test` NUnit's alone, so the framework
 * is decided by the one attribute that is only one framework's when there is one, and by the file's usings otherwise.
 */
function frameworkOf(names: string[], usings: Set<string>): string | null {
  const claimed = Object.keys(FRAMEWORKS).filter(framework => names.some(name => FRAMEWORKS[framework].tests.has(name)));
  if (!claimed.length) return null;
  if (claimed.length === 1) return claimed[0];
  const unique = claimed.filter(framework => names.some(name => FRAMEWORKS[framework].tests.has(name)
    && !Object.keys(FRAMEWORKS).some(other => other !== framework && FRAMEWORKS[other].tests.has(name))));
  if (unique.length === 1) return unique[0];
  if (usings.has("Xunit") && !usings.has("NUnit.Framework")) return "xunit";
  if (usings.has("NUnit.Framework") && !usings.has("Xunit")) return "nunit";
  return claimed[0];
}

/** The namespaces the file's `using` directives name, so an ambiguous attribute can be placed. */
function usingsOf(index: SyntaxIndex): Set<string> {
  const names = new Set<string>();
  for (const node of index.of("using_directive")) {
    const path = node.namedChildren.find(child => child.type === "qualified_name" || child.type === "identifier");
    if (path && !node.childForFieldName("name")) names.add(path.text);
  }
  return names;
}

/**
 * What runs before the test, as calls on its class would name it: NUnit's `[SetUp]` and MSTest's `[TestInitialize]` methods of
 * the test's class and each class around it. xUnit has no setup attribute: it constructs the class once per test, so the
 * constructor is the setup, and `InitializeAsync` after it when the class declares one.
 */
function setupOf(node: Node, framework: string): string[] {
  const setup: string[] = [];
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (!CLASSES.has(scope.type)) continue;
    const owner = scope.childForFieldName("name")?.text;
    if (!owner) continue;
    const members = scope.childForFieldName("body")?.namedChildren ?? [];
    if (framework === "xunit" && members.some(item => item.type === "constructor_declaration")) setup.push(`${owner}.${owner}`);
    for (const item of members) {
      if (item.type !== "method_declaration") continue;
      const name = item.childForFieldName("name")?.text;
      if (name && (attributes(item).some(marker => FRAMEWORKS[framework].setup.has(marker)) || (framework === "xunit" && name === "InitializeAsync"))) setup.push(`${owner}.${name}`);
    }
  }
  return setup;
}

export function csharpTests(index: SyntaxIndex, scan: TestScan, path: string | null): void {
  void path;
  const usings = usingsOf(index);
  const className = (scope: Node) => scope.childForFieldName("name")?.text ?? null;
  for (const node of index.of("method_declaration")) {
    if (node.type !== "method_declaration") continue;
    const names = attributes(node);
    const framework = frameworkOf(names, usings);
    if (!framework) continue;
    const name = node.childForFieldName("name")?.text ?? "";
    const setup = setupOf(node, framework);
    const parametrized = names.some(item => FRAMEWORKS[framework].parametrized.has(item) || DATA_ROWS.has(item));
    scan.cases.set(span(node), { test: { name, suite: enclosing(node, CLASSES, className), framework, ...(parametrized ? { parametrized: true } : {}), ...(setup.length ? { setup } : {}) }, qualified: null });
  }
}
