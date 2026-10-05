/**
 * What in a parsed Ruby file is a test case, and what it mocks. Every answer is read off syntax nodes: a class's superclass, a
 * method's name inside such a class, a call's method and its arguments, and the file's own `require` calls.
 *
 * Minitest and test-unit declare a test as `def test_x` in a class whose superclass is a test case, and Rails' declarative style
 * as `test "name" do ... end` in that class body. RSpec and Minitest::Spec declare suites as `describe "x" do ... end` and tests
 * as `it "name" do ... end`; the two spell this the same way, so which one a file is written for is read from what it requires.
 */
import type { Node } from "../node";
import type { TestScan } from "../tests";
import type { MockTarget } from "../types";
import { enclosing, lineOf, literal, ownerIn, span } from "../tests";
import type { SyntaxIndex } from "../visit";

/** RSpec's example groups, and the suite-like aliases Capybara and shared examples add. */
const SUITES = new Set(["describe", "context", "feature", "shared_examples", "shared_examples_for", "shared_context"]);
/** RSpec's examples. `its` and one-liner `it { }` are read too, named as RSpec names an example with no description. */
const TESTS = new Set(["it", "specify", "example", "scenario"]);
/** Ruby's blocks: `do ... end` and `{ ... }`. Neither is a function to the grammar. */
const BLOCKS = new Set(["do_block", "block"]);
const SCOPES = new Set(["class", "module"]);
const scopeName = (scope: Node) => scope.childForFieldName("name")?.text ?? null;

/** A call's method name, its arguments and its block, when it is a plain `name args do ... end` call. */
function callParts(call: Node): { method: string; receiver: string | null; args: Node[]; block: Node | null } | null {
  if (call.type !== "call") return null;
  const method = call.childForFieldName("method");
  if (method?.type !== "identifier") return null;
  const receiver = call.childForFieldName("receiver");
  const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter(arg => arg.type !== "comment");
  const block = call.childForFieldName("block");
  return { method: method.text, receiver: receiver ? receiver.text : null, args, block: block && BLOCKS.has(block.type) ? block : null };
}

/**
 * A description as RSpec builds it from a group's or an example's arguments: a string as written, a constant by its name, and
 * several joined with a space, except that a part starting with `#` or `.` names a method and follows the class directly.
 */
function description(args: Node[]): string | null {
  const parts: string[] = [];
  for (const arg of args) {
    const written = literal(arg) ?? (["constant", "scope_resolution"].includes(arg.type) ? arg.text : arg.type === "simple_symbol" ? arg.text.slice(1) : null);
    if (written === null) break;
    parts.push(written);
  }
  if (!parts.length) return null;
  return parts.reduce((whole, part) => (/^[#.]/.test(part) ? `${whole}${part}` : `${whole} ${part}`));
}

/**
 * The spec framework a file is written for, by what it requires: minitest's own files or a `test_helper` for Minitest::Spec,
 * anything else for RSpec, which is where `describe` and `it` without a receiver most often come from and which loads its
 * `spec_helper` through `.rspec` rather than a require.
 */
function specFramework(index: SyntaxIndex): "minitest" | "rspec" {
  for (const call of index.of("call")) {
    const parts = callParts(call);
    if (!parts || parts.method !== "require" || parts.receiver) continue;
    const required = literal(parts.args[0]);
    if (required && (/^minitest\b/.test(required) || required === "test_helper")) return "minitest";
    if (required && (/^rspec\b/.test(required) || /^(?:spec|rails)_helper$/.test(required))) return "rspec";
  }
  return "rspec";
}

/** `test-unit` for Test::Unit::TestCase and `minitest` for Minitest's classes and the Rails test cases built on them; null otherwise. */
function testClass(node: Node): string | null {
  if (node.type !== "class") return null;
  const base = node.childForFieldName("superclass")?.namedChildren.find(child => ["constant", "scope_resolution"].includes(child.type));
  if (!base) return null;
  const written = base.text, last = written.split("::").at(-1) ?? "";
  if (/^(?:::)?Test::Unit::TestCase$/.test(written)) return "test-unit";
  // A project's own base class sits between most suites and Minitest::Test: ApplicationTestCase, a BaseTest. Such a base is
  // named for what it is.
  return /(?:TestCase|Test|Spec)$/.test(last) ? "minitest" : null;
}

/** The suites around a node: its classes and modules, and the describe blocks it is written in, outermost first. */
function suitesAround(node: Node): string[] {
  const suite: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (SCOPES.has(parent.type)) { const name = scopeName(parent); if (name) suite.unshift(name); }
    if (!BLOCKS.has(parent.type) || parent.parent?.type !== "call") continue;
    const outer = callParts(parent.parent);
    if (outer?.block?.id === parent.id && SUITES.has(outer.method)) suite.unshift(description(outer.args) ?? "");
  }
  return suite;
}

export function rubyTests(index: SyntaxIndex, scan: TestScan, path: string | null): void {
  const framework = specFramework(index);
  // Minitest and test-unit: a class with a test case for a superclass. Its body is a suite, so `setup do ... end` and anything
  // else run in the class body applies to every test in it.
  for (const node of index.of("class")) {
    const kind = testClass(node);
    const body = node.childForFieldName("body");
    if (!kind || !body) continue;
    const owner = [...enclosing(node, SCOPES, scopeName), scopeName(node) ?? ""].filter(Boolean);
    const suite = owner;
    scan.suites.push({ start: body.startIndex, end: body.endIndex });
    const methods = body.namedChildren.filter(item => item.type === "method");
    const setup = methods.filter(item => ["setup", "before_setup"].includes(item.childForFieldName("name")?.text ?? "")).map(item => `${owner.join(".")}.${item.childForFieldName("name")!.text}`);
    const fixed = setup.length ? { setup } : {};
    for (const method of methods) {
      const name = method.childForFieldName("name")?.text ?? "";
      if (name.startsWith("test_")) scan.cases.set(span(method), { test: { name, suite, framework: kind, ...fixed }, qualified: null });
    }
    // Rails' `test "name" do ... end` declares test_name, with spaces made underscores, as ActiveSupport does.
    for (const item of body.namedChildren) {
      const parts = callParts(item);
      const title = parts && parts.method === "test" && !parts.receiver ? literal(parts.args[0]) : null;
      if (title === null || !parts?.block) continue;
      scan.bodies.push(parts.block);
      const generated = `test_${title.replace(/\s+/g, "_")}`;
      scan.cases.set(span(parts.block), { test: { name: title, suite, framework: kind, ...fixed }, qualified: [...owner, generated].join(".") });
    }
  }
  // RSpec and Minitest::Spec: suites are `describe` calls with a block, tests are `it` calls with one.
  for (const node of index.of("call")) {
    const parts = callParts(node);
    if (!parts?.block) continue;
    if (SUITES.has(parts.method) && (parts.receiver === null || parts.receiver === "RSpec")) { scan.suites.push({ start: parts.block.startIndex, end: parts.block.endIndex }); continue; }
    if (!TESTS.has(parts.method) || parts.receiver !== null) continue;
    const suite = suitesAround(node);
    // An example declared outside every group is nothing RSpec would run; a Minitest class's `test "x"` is read above.
    if (!suite.length) continue;
    const title = description(parts.args) ?? `example at ${path ?? "<unknown>"}:${lineOf(node)}`;
    scan.bodies.push(parts.block);
    scan.cases.set(span(parts.block), { test: { name: title, suite, framework }, qualified: [...suite, title].join(" > ") });
  }
  rubyMocks(index, scan);
}

const VERIFYING_DOUBLES = new Set(["instance_double", "class_double", "object_double", "instance_spy", "class_spy"]);
const STUBBING = new Set(["allow", "expect", "allow_any_instance_of", "expect_any_instance_of"]);

/** The method a stub names: `allow(Cart).to receive(:discount)`, `Cart.stub(:discount, 1) do ... end`, `instance_double(Cart)`. */
function rubyMockTarget(call: Node): MockTarget | null {
  const parts = callParts(call);
  if (!parts) return null;
  if (parts.receiver === null && VERIFYING_DOUBLES.has(parts.method)) {
    const named = parts.args[0];
    return named && ["constant", "scope_resolution"].includes(named.type) ? { kind: "class", name: named.text.split("::").at(-1)! } : null;
  }
  // `allow(Cart).to receive(:discount).and_return(1)`: the `to` call's receiver names what is stubbed, and the `receive` the
  // matcher chain starts from names which method. One that calls the original through still runs it, and replaces nothing.
  if (parts.method === "to" || parts.method === "not_to" || parts.method === "to_not") {
    const receiver = call.childForFieldName("receiver");
    const stubbed = receiver ? callParts(receiver) : null;
    let chain: Node | null = parts.args[0] ?? null, matcher = chain ? callParts(chain) : null;
    while (chain && matcher && matcher.method !== "receive") {
      if (matcher.method === "and_call_original") return null;
      chain = chain.childForFieldName("receiver");
      matcher = chain ? callParts(chain) : null;
    }
    if (!stubbed || stubbed.receiver !== null || !STUBBING.has(stubbed.method) || matcher?.method !== "receive" || matcher.receiver !== null) return null;
    const object = stubbed.args[0], name = matcher.args[0];
    return object && ["constant", "scope_resolution", "identifier", "instance_variable"].includes(object.type) && name?.type === "simple_symbol"
      ? { kind: "member", object: object.text.replace(/^@/, "this."), name: name.text.slice(1) } : null;
  }
  // Minitest's `Cart.stub(:discount, 180) do ... end`.
  if (parts.method === "stub" && parts.receiver !== null && parts.args[0]?.type === "simple_symbol") {
    const receiver = call.childForFieldName("receiver")!;
    return ["constant", "scope_resolution", "identifier", "instance_variable"].includes(receiver.type) ? { kind: "member", object: receiver.text.replace(/^@/, "this."), name: parts.args[0].text.slice(1) } : null;
  }
  return null;
}

function rubyMocks(index: SyntaxIndex, scan: TestScan): void {
  for (const node of index.of("call")) {
    const target = rubyMockTarget(node);
    if (target) scan.mocks.push({ owner: ownerIn(node, scan), target, line: lineOf(node) });
  }
}
