/**
 * What in a parsed Solidity file is a Foundry test. Every answer is read off syntax nodes: a contract's base types say whether
 * forge runs it, and a function's name prefix, visibility and parameters say whether and how forge runs the function. Hardhat
 * tests are JavaScript and are read by the JavaScript rules.
 */
import type { Node } from "../node";
import type { TestScan } from "../tests";
import type { SyntaxIndex } from "../visit";

/**
 * forge runs a contract's tests when it inherits forge-std's `Test` or ds-test's `DSTest`. A project's own base sits between most
 * suites and `Test`, in another file this one cannot see into: `BaseTest`, `IntegrationTest`. Such a base is named for what it is.
 */
const isTestBase = (name: string): boolean => name === "DSTest" || /Test$/.test(name);

/** forge's test functions by prefix: unit and fuzz tests, the deprecated `testFail`, and invariant tests. */
const TEST_PREFIX = /^(?:test|invariant|statefulFuzz)/;

const span = (node: Node) => `${node.startIndex}:${node.endIndex}`;

export function solidityTests(index: SyntaxIndex, scan: TestScan): void {
  for (const contract of index.of("contract_declaration")) {
    if (contract.type !== "contract_declaration") continue;
    // forge deploys each test contract; an abstract one cannot be deployed, so its tests run only through a contract deriving from it.
    if (contract.children.some(child => !child.isNamed && child.type === "abstract")) continue;
    const bases = contract.namedChildren.filter(child => child.type === "inheritance_specifier")
      .map(child => (child.childForFieldName("ancestor") ?? child.namedChildren[0])?.text.split(".").at(-1) ?? "");
    if (!bases.some(isTestBase)) continue;
    const suite = contract.childForFieldName("name")?.text ?? "";
    const functions = (contract.childForFieldName("body")?.namedChildren ?? []).filter(item => item.type === "function_definition");
    // forge calls setUp before each test. The call is recorded as the test's, as a JUnit @BeforeEach is.
    const setup = functions.some(item => item.childForFieldName("name")?.text === "setUp") ? [`${suite}.setUp`] : [];
    for (const item of functions) {
      const name = item.childForFieldName("name")?.text ?? "";
      const visibility = item.namedChildren.find(child => child.type === "visibility")?.text ?? "";
      if (!TEST_PREFIX.test(name) || !["public", "external"].includes(visibility)) continue;
      // A test with parameters is a fuzz test: forge calls it once per generated input, whatever its name says.
      const parametrized = item.namedChildren.some(child => child.type === "parameter");
      scan.cases.set(span(item), {
        test: { name, suite: [suite], framework: "forge", ...(setup.length ? { setup } : {}), ...(parametrized ? { parametrized: true } : {}) },
        qualified: null,
      });
    }
  }
}
