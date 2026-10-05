/**
 * Test detection for the systems languages: Go's testing package and testify, C's Check, cmocka, Criterion and Unity, and what
 * Bash offers. Each case parses real source with perch's analyzer, builds the graph, and asserts on the tests found, the suites
 * and setup read for them, and the methods their calls resolve to by the language's own rules.
 */
import { describe, expect, it } from 'vitest';
import { analyzeFiles } from '../src/analysis.js';
import { buildGraph } from '../src/graph.js';
import { createAnalyzer } from '../src/treesitter/index.ts';
import { mutantsOf } from '../src/mutants.js';

const analyzer = createAnalyzer();
const source = lines => lines.join('\n') + '\n';

/** Analyze an in-memory repository the way a scan does, and build its graph. `modules` are its Go modules, as go.mod declares them. */
async function repository(files, { modules = [] } = {}) {
  const paths = Object.keys(files);
  const scan = await analyzeFiles(paths.map(path => ({ type: 'blob', path, sha: path })), { analyzer, readSource: file => files[file.path] });
  expect(scan.coverage.parse_failures).toBe(0);
  const byPath = new Map(scan.files.map(file => [file.path, file]));
  const method = id => scan.files.flatMap(file => file.methods).find(item => item.id === id);
  return { scan, graph: buildGraph(scan.files, { modules }), file: path => byPath.get(path), method };
}

const tests = file => file.methods.filter(item => item.test).map(item => [item.id, item.line, item.end_line, item.test]);

describe('Go', () => {
  const files = {
    'cart/cart.go': source([
      'package cart',
      '',
      'type Cart struct{ items []int }',
      '',
      'func New() *Cart { return &Cart{} }',
      '',
      'func (c *Cart) Add(n int) { c.items = append(c.items, n) }',
      '',
      'func (c *Cart) Total() int {',
      '\tt := 0',
      '\tfor _, i := range c.items { t += i }',
      '\treturn t',
      '}',
    ]),
    'cart/discount.go': source([
      'package cart',
      '',
      'func Discount(total, percent int) int {',
      '\tif percent >= 100 { return 0 }',
      '\treturn total - total*percent/100',
      '}',
    ]),
    // An external test package beside the package it tests: it reaches cart only through the import.
    'cart/cart_test.go': source([
      'package cart_test',
      '',
      'import (',
      '\t"testing"',
      '',
      '\t"example.com/shop/cart"',
      ')',
      '',
      'func TestTotal(t *testing.T) {',
      '\tc := cart.New()',
      '\tc.Add(100)',
      '\tif got := c.Total(); got != 100 {',
      '\t\tt.Fatalf("got %d", got)',
      '\t}',
      '\tvar d cart.Cart',
      '\td.Add(1)',
      '\te := &cart.Cart{}',
      '\te.Add(2)',
      '\tcheck(t)',
      '}',
      '',
      'func TestDiscount(t *testing.T) {',
      '\tcases := []struct{ name string; pct int }{{"zero", 0}}',
      '\tfor _, tc := range cases {',
      '\t\tt.Run(tc.name, func(t *testing.T) {',
      '\t\t\tif cart.Discount(100, tc.pct) < 0 { t.Fail() }',
      '\t\t})',
      '\t}',
      '\tt.Run("ten percent", func(t *testing.T) {',
      '\t\tt.Run("nested", func(t *testing.T) { cart.Discount(1, 1) })',
      '\t})',
      '\tDiscount(1, 1)',
      '}',
      '',
      'func TestMain(m *testing.M) { m.Run() }',
      'func BenchmarkTotal(b *testing.B) { cart.New() }',
      'func Test(t *testing.T) {}',
      'func Testable(t *testing.T) {}',
      'func check(t *testing.T) {}',
    ]),
    // An internal test file shares the package: bare calls find the package's names in any file of the directory.
    'cart/internal_test.go': source([
      'package cart',
      '',
      'import "testing"',
      '',
      'func TestInternal(t *testing.T) {',
      '\tif Discount(1, 1) < 0 { t.Fail() }',
      '\tc := New()',
      '\tc.Add(1)',
      '}',
    ]),
    'pricing/suite_test.go': source([
      'package pricing',
      '',
      'import (',
      '\t"testing"',
      '',
      '\t"example.com/shop/cart"',
      '\t"github.com/stretchr/testify/suite"',
      ')',
      '',
      'type PricingSuite struct {',
      '\tsuite.Suite',
      '\tcart *cart.Cart',
      '}',
      '',
      'func (s *PricingSuite) SetupTest() { s.cart = cart.New() }',
      'func (s *PricingSuite) TestDiscount() { s.Equal(90, cart.Discount(100, 10)) }',
      'func (s *PricingSuite) helper() {}',
      'func TestPricingSuite(t *testing.T) { suite.Run(t, new(PricingSuite)) }',
    ]),
  };
  const modules = [{ path: 'example.com/shop', dir: '' }];

  it('finds testing tests by the Test prefix and the *testing.T parameter', async () => {
    const { file, method } = await repository(files, { modules });
    expect(tests(file('cart/cart_test.go'))).toEqual([
      ['cart/cart_test.go::TestTotal', 9, 20, { name: 'TestTotal', suite: [], framework: 'testing' }],
      ['cart/cart_test.go::TestDiscount', 22, 33, { name: 'TestDiscount', suite: [], framework: 'testing' }],
      // A subtest is named under its parent, as `go test -v` reports it. A title built in a loop is one case per row.
      ['cart/cart_test.go::TestDiscount/${tc.name}', 25, 27, { name: '${tc.name}', suite: ['TestDiscount'], framework: 'testing', parametrized: true }],
      ['cart/cart_test.go::TestDiscount/ten percent', 29, 31, { name: 'ten percent', suite: ['TestDiscount'], framework: 'testing' }],
      ['cart/cart_test.go::TestDiscount/ten percent/nested', 30, 30, { name: 'nested', suite: ['TestDiscount', 'ten percent'], framework: 'testing' }],
      ['cart/cart_test.go::Test', 37, 37, { name: 'Test', suite: [], framework: 'testing' }],
    ]);
    // TestMain takes a *testing.M, a benchmark a *testing.B, and `Testable` has a lowercase letter after Test: none is a test.
    for (const name of ['TestMain', 'BenchmarkTotal', 'Testable', 'check']) expect(method(`cart/cart_test.go::${name}`).test, name).toBeUndefined();
    expect(method('cart/cart_test.go::check')).toMatchObject({ support: true });
    expect(method('cart/internal_test.go::TestInternal').test).toEqual({ name: 'TestInternal', suite: [], framework: 'testing' });
  });

  it('finds testify suite methods with the suite as their setup', async () => {
    const { file, method } = await repository(files, { modules });
    expect(tests(file('pricing/suite_test.go')).map(([id, , , test]) => [id, test])).toEqual([
      ['pricing/suite_test.go::PricingSuite.TestDiscount', { name: 'TestDiscount', suite: ['PricingSuite'], framework: 'testify' }],
      ['pricing/suite_test.go::TestPricingSuite', { name: 'TestPricingSuite', suite: [], framework: 'testing' }],
    ]);
    expect(method('pricing/suite_test.go::PricingSuite.helper').test).toBeUndefined();
    expect(method('pricing/suite_test.go::PricingSuite.SetupTest').test).toBeUndefined();
  });

  it('resolves calls through the import path, the package directory and what a local holds', async () => {
    const { graph } = await repository(files, { modules });
    // `cart.New()` through `import "example.com/shop/cart"` and the go.mod declaring example.com/shop; `c.Add` on what New returns,
    // `d.Add` on a declared type and `e.Add` on a composite literal; `check` in the test's own file.
    expect(graph.callees('cart/cart_test.go::TestTotal').sort()).toEqual(['cart/cart.go::Cart.Add', 'cart/cart.go::Cart.Total', 'cart/cart.go::New', 'cart/cart_test.go::check']);
    expect(graph.callees('cart/cart_test.go::TestDiscount/${tc.name}')).toEqual(['cart/discount.go::Discount']);
    expect(graph.callees('cart/cart_test.go::TestDiscount/ten percent/nested')).toEqual(['cart/discount.go::Discount']);
    // A bare `Discount(1, 1)` in the external test package names nothing: cart's names are only reached through the import.
    expect(graph.callees('cart/cart_test.go::TestDiscount')).toEqual([]);
    expect(graph.external('cart/cart_test.go::TestDiscount').map(call => call.name)).toContain('Discount');
    // Inside the package, a bare name is found in whichever file of the directory declares it.
    expect(graph.callees('cart/internal_test.go::TestInternal').sort()).toEqual(['cart/cart.go::Cart.Add', 'cart/cart.go::New', 'cart/discount.go::Discount']);
    expect(graph.callees('cart/cart.go::Cart.Total')).toEqual([]);
    // testify runs SetupTest before each test method, so the test reaches what SetupTest reaches.
    expect(graph.callees('pricing/suite_test.go::PricingSuite.TestDiscount').sort()).toEqual(['cart/discount.go::Discount', 'pricing/suite_test.go::PricingSuite.SetupTest']);
    expect(graph.callees('pricing/suite_test.go::PricingSuite.SetupTest')).toEqual(['cart/cart.go::New']);
    expect(graph.nodes.get('cart/cart_test.go::TestDiscount/ten percent')).toMatchObject({ test: true, case: { name: 'ten percent', suite: ['TestDiscount'], framework: 'testing' } });
  });

  it('resolves an import only through a go.mod that declares its prefix', async () => {
    const { graph } = await repository(files, { modules: [] });
    expect(graph.callees('cart/cart_test.go::TestTotal')).toEqual(['cart/cart_test.go::check']);
    const nested = await repository(files, { modules: [{ path: 'example.com/shop', dir: 'services' }] });
    expect(nested.graph.callees('cart/cart_test.go::TestTotal')).toEqual(['cart/cart_test.go::check']);
  });
});

describe('C', () => {
  const cart = source([
    '#include "cart.h"',
    '',
    'int discount(int total, int percent) {',
    '  if (percent >= 100) return 0;',
    '  return total - total * percent / 100;',
    '}',
    'struct cart *cart_new(void) { return 0; }',
    'void cart_add(struct cart *c, int n) {}',
    'int cart_total(struct cart *c) { return 1; }',
    'void cart_free(struct cart *c) {}',
  ]);
  const check = source([
    '#include <check.h>',
    '#include "../src/cart.h"',
    '',
    'static struct cart *c;',
    'static void setup(void) { c = cart_new(); }',
    'static void teardown(void) { cart_free(c); }',
    '',
    'START_TEST(adds_items)',
    '{',
    '  cart_add(c, 100);',
    '  ck_assert_int_eq(cart_total(c), 100);',
    '}',
    'END_TEST',
    '',
    'START_TEST(discounts)',
    '{',
    '  ck_assert_int_eq(discount(200, 10), 180);',
    '}',
    'END_TEST',
    '',
    'START_TEST(unregistered) { ck_assert(1); } END_TEST',
    '',
    'Suite *cart_suite(void)',
    '{',
    '  Suite *s = suite_create("Cart");',
    '  TCase *tc_core = tcase_create("Core");',
    '  tcase_add_checked_fixture(tc_core, setup, teardown);',
    '  tcase_add_test(tc_core, adds_items);',
    '  tcase_add_loop_test(tc_core, discounts, 0, 3);',
    '  suite_add_tcase(s, tc_core);',
    '  return s;',
    '}',
  ]);
  const cmocka = source([
    '#include <setjmp.h>',
    '#include <cmocka.h>',
    '#include "../src/cart.h"',
    '',
    'static int setup(void **state) { *state = cart_new(); return 0; }',
    'static int group_setup(void **state) { return 0; }',
    '',
    'static void test_adds_items(void **state) {',
    '  cart_add(*state, 100);',
    '  assert_int_equal(cart_total(*state), 100);',
    '}',
    '',
    'static void test_discounts(void **state) {',
    '  assert_int_equal(discount(200, 10), 180);',
    '}',
    '',
    'static void not_registered(void **state) {}',
    '',
    'int main(void) {',
    '  const struct CMUnitTest cart_tests[] = {',
    '    cmocka_unit_test_setup_teardown(test_adds_items, setup, NULL),',
    '    cmocka_unit_test(test_discounts),',
    '  };',
    '  return cmocka_run_group_tests(cart_tests, group_setup, NULL);',
    '}',
  ]);
  const criterion = source([
    '#include <criterion/criterion.h>',
    '#include "../src/cart.h"',
    '',
    'static struct cart *c;',
    'static void setup(void) { c = cart_new(); }',
    'static void each(void) { discount(1, 1); }',
    '',
    'TestSuite(cart, .init = setup);',
    '',
    'Test(cart, adds_items) {',
    '  cart_add(c, 100);',
    '  cr_assert_eq(cart_total(c), 100);',
    '}',
    '',
    'Test(pricing, discounts, .description = "ten percent") {',
    '  cr_assert_eq(discount(200, 10), 180);',
    '}',
    '',
    'Test(pricing, zero, .init = each) {',
    '  cr_assert(discount(1, 0) > 0);',
    '}',
    '',
    'ParameterizedTest(int *pct, pricing, table) {',
    '  cr_assert(discount(100, *pct) >= 0);',
    '}',
  ]);
  const unity = source([
    '#include "unity.h"',
    '#include "../src/cart.h"',
    '',
    'static struct cart *c;',
    'void setUp(void) { c = cart_new(); }',
    'void tearDown(void) { cart_free(c); }',
    '',
    'void test_adds_items(void) {',
    '  cart_add(c, 100);',
    '  TEST_ASSERT_EQUAL_INT(100, cart_total(c));',
    '}',
    '',
    'void test_discounts(void) {',
    '  TEST_ASSERT_EQUAL_INT(180, discount(200, 10));',
    '}',
    '',
    'void test_not_run(void) {}',
    '',
    'int main(void) {',
    '  UNITY_BEGIN();',
    '  RUN_TEST(test_adds_items);',
    '  RUN_TEST(test_discounts);',
    '  return UNITY_END();',
    '}',
  ]);
  const header = source([
    '#ifndef CART_H',
    '#define CART_H',
    'struct cart;',
    'int discount(int total, int percent);',
    'struct cart *cart_new(void);',
    'void cart_add(struct cart *c, int n);',
    'int cart_total(struct cart *c);',
    'void cart_free(struct cart *c);',
    '#endif',
  ]);
  const files = { 'src/cart.h': header, 'src/cart.c': cart, 'tests/check_test.c': check, 'tests/cmocka_test.c': cmocka, 'tests/criterion_test.c': criterion, 'tests/unity_test.c': unity };

  it('reads Check tests with their suite, tcase and fixture', async () => {
    const { file, method, graph } = await repository(files);
    // A header's prototypes declare the functions; only the definitions in cart.c are methods, so each name links to its one definition.
    expect(file('src/cart.h').methods.filter(item => item.node !== null)).toEqual([]);
    expect(tests(file('tests/check_test.c'))).toEqual([
      ['tests/check_test.c::adds_items', 8, 12, { name: 'adds_items', suite: ['Cart', 'Core'], framework: 'check' }],
      // The END_TEST closing the test before has no semicolon, so the grammar reads it as this test's type: the test starts on its line.
      ['tests/check_test.c::discounts', 13, 18, { name: 'discounts', suite: ['Cart', 'Core'], framework: 'check' }],
      // A test no tcase registers is still a test, in no suite.
      ['tests/check_test.c::unregistered', 19, 21, { name: 'unregistered', suite: [], framework: 'check' }],
    ]);
    expect(method('tests/check_test.c::setup')).toMatchObject({ support: true });
    expect(file('tests/check_test.c').test).toBe(true);
    // The checked fixture runs before each test of the tcase, so each reaches what setup reaches.
    expect(graph.callees('tests/check_test.c::adds_items').sort()).toEqual(['src/cart.c::cart_add', 'src/cart.c::cart_total', 'tests/check_test.c::setup']);
    expect(graph.callees('tests/check_test.c::discounts').sort()).toEqual(['src/cart.c::discount', 'tests/check_test.c::setup']);
    expect(graph.callees('tests/check_test.c::unregistered')).toEqual([]);
    expect(graph.callees('tests/check_test.c::setup')).toEqual(['src/cart.c::cart_new']);
  });

  it('reads cmocka tests from their registrations', async () => {
    const { file, method, graph } = await repository(files);
    expect(tests(file('tests/cmocka_test.c'))).toEqual([
      ['tests/cmocka_test.c::test_adds_items', 8, 11, { name: 'test_adds_items', suite: ['cart_tests'], framework: 'cmocka' }],
      ['tests/cmocka_test.c::test_discounts', 13, 15, { name: 'test_discounts', suite: ['cart_tests'], framework: 'cmocka' }],
    ]);
    expect(method('tests/cmocka_test.c::not_registered').test).toBeUndefined();
    expect(method('tests/cmocka_test.c::main').test).toBeUndefined();
    // The group's setup runs once before the group and the test's own setup before the test; both are reached.
    expect(graph.callees('tests/cmocka_test.c::test_adds_items').sort()).toEqual(['src/cart.c::cart_add', 'src/cart.c::cart_total', 'tests/cmocka_test.c::group_setup', 'tests/cmocka_test.c::setup']);
    expect(graph.callees('tests/cmocka_test.c::test_discounts').sort()).toEqual(['src/cart.c::discount', 'tests/cmocka_test.c::group_setup']);
  });

  it('reads Criterion tests as a call followed by a block, with the suite init', async () => {
    const { file, graph } = await repository(files);
    expect(tests(file('tests/criterion_test.c'))).toEqual([
      ['tests/criterion_test.c::cart.adds_items', 10, 13, { name: 'adds_items', suite: ['cart'], framework: 'criterion' }],
      ['tests/criterion_test.c::pricing.discounts', 15, 17, { name: 'discounts', suite: ['pricing'], framework: 'criterion' }],
      ['tests/criterion_test.c::pricing.zero', 19, 21, { name: 'zero', suite: ['pricing'], framework: 'criterion' }],
      ['tests/criterion_test.c::pricing.table', 23, 25, { name: 'table', suite: ['pricing'], framework: 'criterion', parametrized: true }],
    ]);
    // Nothing but the tests and the plain functions is a declaration: a test's block is the test, not a method of its own.
    expect(file('tests/criterion_test.c').methods.filter(item => item.node !== null).map(item => item.qualified_name)).toEqual(['setup', 'each', 'cart.adds_items', 'pricing.discounts', 'pricing.zero', 'pricing.table']);
    expect(graph.callees('tests/criterion_test.c::cart.adds_items').sort()).toEqual(['src/cart.c::cart_add', 'src/cart.c::cart_total', 'tests/criterion_test.c::setup']);
    expect(graph.callees('tests/criterion_test.c::pricing.discounts')).toEqual(['src/cart.c::discount']);
    expect(graph.callees('tests/criterion_test.c::pricing.zero').sort()).toEqual(['src/cart.c::discount', 'tests/criterion_test.c::each']);
  });

  it('reads Unity tests from RUN_TEST, with setUp', async () => {
    const { file, method, graph } = await repository(files);
    expect(tests(file('tests/unity_test.c'))).toEqual([
      ['tests/unity_test.c::test_adds_items', 8, 11, { name: 'test_adds_items', suite: [], framework: 'unity' }],
      ['tests/unity_test.c::test_discounts', 13, 15, { name: 'test_discounts', suite: [], framework: 'unity' }],
    ]);
    expect(method('tests/unity_test.c::test_not_run').test).toBeUndefined();
    expect(graph.callees('tests/unity_test.c::test_discounts').sort()).toEqual(['src/cart.c::discount', 'tests/unity_test.c::setUp']);
    expect(graph.callees('tests/unity_test.c::setUp')).toEqual(['src/cart.c::cart_new']);
  });

  it('knows each framework by the header the file includes', async () => {
    const stripped = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, text.replace(/#include [<"](check|cmocka|criterion\/criterion|unity)\.h[>"]\n/, '')]));
    const { scan } = await repository(stripped);
    expect(scan.files.flatMap(file => file.methods.filter(method => method.test))).toEqual([]);
  });
});

describe('Bash', () => {
  const files = {
    'lib/money.sh': source(['format_money() {', '  printf "%d.00" "$1"', '}']),
    'lib/discount.sh': source([
      '#!/usr/bin/env bash',
      'source "./money.sh"',
      '. lib/rates.sh',
      'discount() {',
      '  local total=$1 pct=$2',
      '  if [ "$pct" -ge 100 ] || [ -z "$total" ]; then return 0; fi',
      '  if ! is_number "$total"; then return 1; fi',
      '  echo $(( total - total * pct / 100 ))',
      '  format_money "$total"',
      '  rate_for usd',
      '  "$helper" x',
      '  ./tools/run.sh',
      '}',
    ]),
    'lib/rates.sh': source(['rate_for() {', '  echo 1', '}', 'is_number() {', '  [[ $1 =~ ^[0-9]+$ ]]', '}']),
    'test/helpers.bash': source(['setup_cart() {', '  discount 200 10', '}']),
    'test/discount.bats': source([
      '#!/usr/bin/env bats',
      'load helpers',
      '@test "discounts" {',
      '  run discount 200 10',
      '  [ "$output" = "180" ]',
      '}',
      'helper_in_bats() {',
      '  setup_cart',
      '}',
    ]),
  };

  it('reads source and load as imports and commands as calls', async () => {
    const { file, graph } = await repository(files);
    expect(file('lib/discount.sh').imports).toEqual([{ module: './money.sh', name: '*', alias: '*' }, { module: 'lib/rates.sh', name: '*', alias: '*' }]);
    expect(file('test/discount.bats').imports).toEqual([{ module: 'helpers', name: '*', alias: '*' }]);
    // A sourced path is read beside the file and from the repository root; `load` adds .bash as bats does.
    expect(graph.callees('lib/discount.sh::discount').sort()).toEqual(['lib/money.sh::format_money', 'lib/rates.sh::is_number', 'lib/rates.sh::rate_for']);
    expect(graph.callees('test/discount.bats::helper_in_bats')).toEqual(['test/helpers.bash::setup_cart']);
    expect(graph.callees('test/helpers.bash::setup_cart')).toEqual([]);
    // The shell's own control flow is no call; a program is a call outside the repository; a computed name or a path is nothing.
    expect(graph.external('lib/discount.sh::discount').map(call => call.name)).toEqual(['echo']);
    expect(file('lib/discount.sh').calls.map(call => call.name)).not.toContain('return');
  });

  it('finds no bats test, since the grammar gives its body no node', async () => {
    const { file } = await repository(files);
    // `@test "name" {` is a command with the `{` as an argument, its statements siblings of it: nothing spans the test.
    expect(file('test/discount.bats').methods.filter(method => method.node !== null).map(method => [method.qualified_name, method.test ?? null])).toEqual([['helper_in_bats', null]]);
  });
});

describe('mutants for the systems languages', () => {
  const edits = mutants => mutants.map(mutant => `${mutant.kind} ${mutant.line} ${mutant.from}>${mutant.to}`);

  it('plants boundary, condition, arithmetic and return mutants in a Go function', () => {
    const go = source(['package cart', '', 'func Discount(total, percent int) int {', '\tif percent >= 100 || total <= 0 {', '\t\treturn 0', '\t}', '\treturn total - total*percent/100', '}']);
    expect(edits(mutantsOf({ source: go, language: 'go', line: 3, end_line: 8 }))).toEqual([
      'boundary 4 >=>>', 'boundary 4 <=><', 'logic 4 ||>&&', 'condition 4 percent >= 100 || total <= 0>!(percent >= 100 || total <= 0)',
      'arithmetic 7 ->+', 'arithmetic 7 *>/', 'arithmetic 7 />*', 'return 5 0>1',
    ]);
  });

  it("plants mutants in a Bash function in the shell's own spelling", () => {
    const bash = source(['discount() {', '  if [ "$2" -ge 100 ] || [ -z "$1" ]; then return 0; fi', '  if ! is_number "$1"; then return 1; fi', '  echo $(( $1 - $1 * $2 / 100 ))', '}']);
    expect(edits(mutantsOf({ source: bash, language: 'bash', line: 1, end_line: 5 }))).toEqual([
      'boundary 2 -ge>-gt', 'logic 2 ||>&&',
      'condition 2 [ "$2" -ge 100 ] || [ -z "$1" ]>! { [ "$2" -ge 100 ] || [ -z "$1" ]; }', 'condition 3 ! is_number "$1">! ! is_number "$1"',
      'not 3 ! is_number "$1">is_number "$1"',
      'arithmetic 4 ->+', 'arithmetic 4 *>/', 'arithmetic 4 />*',
      'return 2 0>1', 'return 3 1>0',
    ]);
  });
});
