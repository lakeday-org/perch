/**
 * What in a parsed C file is a test case: Check's START_TEST, cmocka's registered functions, Criterion's Test and Unity's
 * RUN_TEST. Every answer is read off syntax nodes: a macro's name and arguments, the functions a registration names, the header
 * the file includes. C has no attribute to mark a test with, so each framework is known by the header it is written against.
 */
import type { Node } from "../node";
import { includedHeaders, literal, macroCall, span, type TestScan } from "../tests";
import type { SyntaxIndex } from "../visit";

const identifierArgs = (args: Node[]) => args.filter(arg => arg.type === "identifier").map(arg => arg.text);

/** A call statement or expression as its callee's name and arguments, when the callee is a plain identifier. */
function callOf(node: Node): { name: string; arguments: Node[] } | null {
  if (node.type !== "call_expression") return null;
  const callee = node.childForFieldName("function");
  if (callee?.type !== "identifier") return null;
  return { name: callee.text, arguments: (node.childForFieldName("arguments")?.namedChildren ?? []).filter(arg => !arg.type.includes("comment")) };
}

/** The name a function definition declares, through the pointer declarators a pointer-returning function wraps it in. */
function definedName(node: Node): string | null {
  let declarator = node.childForFieldName("declarator");
  while (declarator && declarator.type !== "function_declarator") declarator = declarator.childForFieldName("declarator") ?? declarator.namedChildren[0] ?? null;
  const name = declarator?.childForFieldName("declarator");
  return name?.type === "identifier" ? name.text : null;
}

/** Each function the file defines, by the name it declares. */
function definitions(index: SyntaxIndex): Map<string, Node> {
  const defined = new Map<string, Node>();
  for (const node of index.of("function_definition")) {
    if (node.type !== "function_definition") continue;
    const name = definedName(node);
    if (name && !defined.has(name)) defined.set(name, node);
  }
  return defined;
}

/** What each variable in the file is assigned from a call to one of the given functions: `TCase *tc = tcase_create("Core")`. */
function assignedFrom(index: SyntaxIndex, functions: Set<string>): Map<string, Node[]> {
  const values = new Map<string, Node[]>();
  for (const node of index.of("init_declarator", "assignment_expression")) {
    const value = node.type === "init_declarator" ? node.childForFieldName("value") : node.childForFieldName("right");
    const call = value ? callOf(value) : null;
    if (!call || !functions.has(call.name)) continue;
    let name = node.type === "init_declarator" ? node.childForFieldName("declarator") : node.childForFieldName("left");
    while (name && name.type === "pointer_declarator") name = name.childForFieldName("declarator");
    if (name?.type === "identifier") values.set(name.text, call.arguments);
  }
  return values;
}

// ------------------------------------------------------------------------------------------------------------------ Check

/** The macros that register a test with a TCase, `tcase_add_test(tc, name)` and its variants, all with the test second. */
const CHECK_ADD = /^tcase_add_(?:test|loop_test|exit_test|test_raise_signal|loop_exit_test|loop_test_raise_signal)$/;
const CHECK_FIXTURE = new Set(["tcase_add_checked_fixture", "tcase_add_unchecked_fixture"]);

/**
 * `START_TEST(name) { } END_TEST`. The grammar reads the first as a function whose type is START_TEST and whose declarator is
 * `(name)`. The END_TEST that closes it has no semicolon, so the grammar makes it the type of whatever comes next: a second test
 * reads as a function typed END_TEST declaring `START_TEST(name)`, with the name as the type of its one parameter.
 */
function checkTestName(node: Node): string | null {
  const type = node.childForFieldName("type"), declarator = node.childForFieldName("declarator");
  if (type?.type !== "type_identifier" || !declarator) return null;
  if (type.text === "START_TEST" && declarator.type === "parenthesized_declarator") {
    const name = declarator.namedChildren[0];
    return name?.type === "identifier" ? name.text : null;
  }
  if (type.text === "END_TEST" && declarator.type === "function_declarator" && declarator.childForFieldName("declarator")?.text === "START_TEST") {
    const parameters = declarator.childForFieldName("parameters")?.namedChildren.filter(item => item.type === "parameter_declaration") ?? [];
    const name = parameters.length === 1 ? parameters[0].childForFieldName("type") : null;
    return name?.type === "type_identifier" && !parameters[0].childForFieldName("declarator") ? name.text : null;
  }
  return null;
}

function checkTests(index: SyntaxIndex, scan: TestScan): void {
  // Where each test is registered: its TCase, the TCase's suite, and the fixtures that run before it. Check names a run by
  // suite and tcase, `Cart:Core`, from the strings handed to suite_create and tcase_create.
  const tcaseOf = new Map<string, string>(), suiteOf = new Map<string, string>(), fixtureOf = new Map<string, string[]>();
  for (const node of index.of("call_expression")) {
    const call = callOf(node);
    if (!call) continue;
    const args = identifierArgs(call.arguments);
    if (CHECK_ADD.test(call.name) && call.arguments[0]?.type === "identifier" && call.arguments[1]?.type === "identifier") tcaseOf.set(args[1], args[0]);
    else if (call.name === "suite_add_tcase" && args.length >= 2) suiteOf.set(args[1], args[0]);
    else if (CHECK_FIXTURE.has(call.name) && call.arguments[0]?.type === "identifier") {
      const setup = call.arguments[1]?.type === "identifier" ? [call.arguments[1].text] : [];
      fixtureOf.set(args[0], [...(fixtureOf.get(args[0]) ?? []), ...setup]);
    }
  }
  const created = assignedFrom(index, new Set(["suite_create", "tcase_create"]));
  const titled = (variable: string | undefined) => (variable ? literal(created.get(variable)?.[0]) : null);
  for (const node of index.of("function_definition")) {
    if (node.type !== "function_definition") continue;
    const name = checkTestName(node);
    if (!name) continue;
    const tcase = tcaseOf.get(name);
    const suite = [titled(suiteOf.get(tcase ?? "")), titled(tcase)].filter((part): part is string => part !== null);
    const setup = tcase ? fixtureOf.get(tcase) ?? [] : [];
    scan.cases.set(span(node), { test: { name, suite, framework: "check", ...(setup.length ? { setup } : {}) }, qualified: name });
  }
}

// ----------------------------------------------------------------------------------------------------------------- cmocka

/** cmocka's registrations, each with the test function first; those with `setup` in the name take the setup function second. */
const CMOCKA_UNIT = /^cmocka_unit_test(?:_setup|_teardown|_setup_teardown|_prestate|_prestate_setup_teardown)?$/;

/**
 * `static void test_x(void **state)` is a test when a `cmocka_unit_test(test_x)` names it in a `struct CMUnitTest` array, and the
 * array is a group when `cmocka_run_group_tests(array, setup, teardown)` runs it. cmocka names the group after the array, by
 * stringifying the argument, or by the string `cmocka_run_group_tests_name` is given.
 */
function cmockaTests(index: SyntaxIndex, scan: TestScan): void {
  const groups = new Map<string, { name: string | null; setup: string | null }>();
  for (const node of index.of("call_expression")) {
    const call = callOf(node);
    if (call?.name === "cmocka_run_group_tests" && call.arguments[0]?.type === "identifier") {
      groups.set(call.arguments[0].text, { name: call.arguments[0].text, setup: call.arguments[1]?.type === "identifier" ? call.arguments[1].text : null });
    } else if (call?.name === "cmocka_run_group_tests_name" && call.arguments[1]?.type === "identifier") {
      groups.set(call.arguments[1].text, { name: literal(call.arguments[0]), setup: call.arguments[2]?.type === "identifier" ? call.arguments[2].text : null });
    }
  }
  const defined = definitions(index);
  for (const node of index.of("call_expression")) {
    const call = callOf(node);
    if (!call || !CMOCKA_UNIT.test(call.name) || call.arguments[0]?.type !== "identifier") continue;
    const fn = defined.get(call.arguments[0].text);
    if (!fn) continue;
    // The array the registration sits in: an initializer list declared with a name.
    let holder: Node | null = node.parent;
    while (holder && holder.type !== "initializer_list") holder = holder.parent;
    let declared = holder?.parent?.type === "init_declarator" ? holder.parent.childForFieldName("declarator") : null;
    while (declared && declared.type !== "identifier") declared = declared.childForFieldName("declarator") ?? declared.namedChildren[0] ?? null;
    const group = declared ? groups.get(declared.text) : undefined;
    const setup = [group?.setup ?? null, /_setup/.test(call.name) && call.arguments[1]?.type === "identifier" ? call.arguments[1].text : null].filter((item): item is string => item !== null);
    const name = call.arguments[0].text;
    scan.cases.set(span(fn), { test: { name, suite: group?.name ? [group.name] : [], framework: "cmocka", ...(setup.length ? { setup } : {}) }, qualified: null });
  }
}

// -------------------------------------------------------------------------------------------------------------- Criterion

/**
 * Criterion's `Test(suite, name)` and `ParameterizedTest(type *param, suite, name)`. `Theory((int a, int b), suite, name)` opens
 * with a parenthesized parameter list the grammar reads as a declaration with errors, not a call, so it is not read.
 */
const CRITERION_TESTS = new Set(["Test", "ParameterizedTest"]);

/**
 * The function a designated initializer names: `.init = setup` among a macro's arguments. That is not C in an argument list, so
 * the grammar recovers it as an assignment whose left side is `init` alone or a field access ending in it.
 */
function designated(index: SyntaxIndex, args: Node[], field: string): string | null {
  for (const arg of args) {
    for (const node of index.within(arg)) {
      if (node.type !== "assignment_expression") continue;
      const left = node.childForFieldName("left"), right = node.childForFieldName("right");
      const named = left?.type === "identifier" ? left.text : left?.type === "field_expression" ? left.childForFieldName("field")?.text : null;
      if (named === field && right?.type === "identifier") return right.text;
    }
  }
  return null;
}

/**
 * `Test(suite, name) { }`: a call statement the grammar leaves without its `;`, then a block, read as cppTests reads Catch2.
 * `TestSuite(suite, .init = f)` gives every test of the suite its setup; a test's own `.init` runs besides.
 */
function criterionTests(index: SyntaxIndex, scan: TestScan): void {
  const suiteSetup = new Map<string, string>();
  for (const node of index.of("call_expression")) {
    const call = callOf(node);
    if (call?.name !== "TestSuite" || !call.arguments.length) continue;
    const suite = index.within(call.arguments[0]).find(item => item.type === "identifier")?.text;
    const init = designated(index, call.arguments, "init");
    if (suite && init) suiteSetup.set(suite, init);
  }
  if (!scan.blockMacros.size) scan.blockMacros = new Set([...CRITERION_TESTS, "TestSuite"]);
  for (const scope of index.of("translation_unit")) {
    const items = scope.namedChildren.filter(item => !item.type.includes("comment"));
    for (const [at, item] of items.entries()) {
      const macro = macroCall(item);
      const body = items[at + 1];
      if (!macro || !CRITERION_TESTS.has(macro.name) || body?.type !== "compound_statement") continue;
      // The suite and the test are the last two plain identifiers among the arguments: ParameterizedTest's parameter, `int *pct`,
      // reads as an expression before them, and a `.init = setup` after them as an assignment.
      const [suite, name] = identifierArgs(macro.arguments).slice(-2);
      if (!suite || !name) continue;
      const setup = [suiteSetup.get(suite) ?? null, designated(index, macro.arguments, "init")].filter((item): item is string => item !== null);
      scan.bodies.push(body);
      scan.cases.set(span(body), { test: { name, suite: [suite], framework: "criterion", ...(setup.length ? { setup } : {}), ...(macro.name === "Test" ? {} : { parametrized: true }) }, qualified: `${suite}.${name}` });
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------ Unity

/** `void test_x(void)` is a test when `RUN_TEST(test_x)` names it in this file. Unity calls `setUp` before each, when defined. */
function unityTests(index: SyntaxIndex, scan: TestScan): void {
  const defined = definitions(index);
  const setup = defined.has("setUp") ? ["setUp"] : [];
  for (const node of index.of("call_expression")) {
    const call = callOf(node);
    if (call?.name !== "RUN_TEST" || call.arguments[0]?.type !== "identifier") continue;
    const fn = defined.get(call.arguments[0].text);
    if (fn) scan.cases.set(span(fn), { test: { name: call.arguments[0].text, suite: [], framework: "unity", ...(setup.length ? { setup } : {}) }, qualified: null });
  }
}

export function cTests(index: SyntaxIndex, scan: TestScan, path: string | null): void {
  void path;
  const headers = includedHeaders(index);
  const includes = (name: RegExp) => headers.some(header => name.test(header));
  if (includes(/(^|\/)check\.h$/)) checkTests(index, scan);
  if (includes(/(^|\/)cmocka\.h$/)) cmockaTests(index, scan);
  if (includes(/(^|\/)criterion\/[\w/]+\.h$/)) criterionTests(index, scan);
  if (includes(/(^|\/)unity(?:_fixture)?\.h$/)) unityTests(index, scan);
}
