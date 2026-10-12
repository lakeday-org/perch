import { describe, expect, it } from 'vitest';
import { analyzeFiles } from '../src/analysis.js';
import { buildGraph } from '../src/graph.js';
import { createAnalyzer } from '../src/treesitter/index.ts';

const analyzer = createAnalyzer();
const source = lines => lines.join('\n') + '\n';

/** Analyze an in-memory repository the way a scan does, and build its graph. */
async function repository(files) {
  const paths = Object.keys(files);
  const scan = await analyzeFiles(paths.map(path => ({ type: 'blob', path, sha: path })), { analyzer, readSource: file => files[file.path] });
  expect(scan.coverage.parse_failures).toBe(0);
  const byPath = new Map(scan.files.map(file => [file.path, file]));
  const method = id => scan.files.flatMap(file => file.methods).find(item => item.id === id);
  return { scan, graph: buildGraph(scan.files), file: path => byPath.get(path), method };
}

describe('Python', () => {
  const files = {
    'shop/cart.py': source([
      'class Cart:',
      '    def save(self):',
      '        return 1',
      '',
      'def fetch(x):',
      '    if x:',
      '        return 1',
      '    return 2',
      '',
      'def test_helper_in_source():',
      '    return fetch(1)',
    ]),
    'tests/test_cart.py': source([
      'import unittest',
      'from unittest.mock import patch',
      'from shop.cart import fetch, Cart',
      '',
      'def test_fetch(monkeypatch):',
      "    monkeypatch.setattr('shop.cart.fetch', lambda x: 3)",
      '    assert fetch(1) == 1',
      '',
      'class TestCart(unittest.TestCase):',
      "    @patch('shop.cart.fetch')",
      '    def test_save(self, fetch_mock):',
      "        with patch.object(Cart, 'save'):",
      '            self.assertEqual(fetch(2), 1)',
      '',
      '    def helper(self):',
      '        return fetch(2)',
      '',
      'class CartChecks:',
      '    def test_not_collected(self):',
      '        pass',
    ]),
  };

  it('finds pytest and unittest tests', async () => {
    const { method } = await repository(files);
    expect(method('tests/test_cart.py::test_fetch')).toMatchObject({ name: 'test_fetch', qualified_name: 'test_fetch', line: 5, end_line: 7,
      test: { name: 'test_fetch', suite: [], framework: 'pytest' } });
    expect(method('tests/test_cart.py::TestCart.test_save')).toMatchObject({ line: 11, end_line: 13,
      test: { name: 'test_save', suite: ['TestCart'], framework: 'unittest' } });
    expect(method('tests/test_cart.py::TestCart.helper').test).toBeUndefined();
    expect(method('tests/test_cart.py::CartChecks.test_not_collected').test).toBeUndefined();
    // A module-level test_ function in a file pytest does not collect is an ordinary function.
    expect(method('shop/cart.py::test_helper_in_source').test).toBeUndefined();
  });

  it('resolves patch targets', async () => {
    const { file, graph } = await repository(files);
    expect(file('tests/test_cart.py').mocks).toEqual([
      { owner: 'tests/test_cart.py::test_fetch', target: { kind: 'path', path: 'shop.cart.fetch' }, line: 6 },
      { owner: 'tests/test_cart.py::TestCart.test_save', target: { kind: 'path', path: 'shop.cart.fetch' }, line: 10 },
      { owner: 'tests/test_cart.py::TestCart.test_save', target: { kind: 'member', object: 'Cart', name: 'save' }, line: 12 },
    ]);
    expect(graph.mocks('tests/test_cart.py::TestCart.test_save')).toEqual(['shop/cart.py::fetch', 'shop/cart.py::Cart.save']);
    expect(graph.mocks('tests/test_cart.py::test_fetch')).toEqual(['shop/cart.py::fetch']);
    expect(graph.mocks('tests/test_cart.py::TestCart.helper')).toEqual([]);
  });

  it('links imported functions', async () => {
    const { graph } = await repository(files);
    expect(graph.callees('tests/test_cart.py::test_fetch')).toEqual(['shop/cart.py::fetch']);
    expect(graph.nodes.get('tests/test_cart.py::test_fetch')).toMatchObject({ test: true, case: { name: 'test_fetch', suite: [], framework: 'pytest' } });
    expect(graph.nodes.get('tests/test_cart.py::TestCart.helper')).toMatchObject({ test: true, case: null });
    expect(graph.external('tests/test_cart.py::test_fetch')).toEqual([{ name: 'monkeypatch.setattr', line: 6 }]);
  });
});

describe('module imports', () => {
  it('links calls through imported modules', async () => {
    const { graph } = await repository({
      'cart.py': source(['def subtotal(items):', '    return 0']),
      'shop/cart.py': source(['def apply_discount(total, percent):', '    return total']),
      'shop/pricing/rules.py': source(['def rule():', '    return 1']),
      'shop/checkout.py': source(['from shop import cart', '', 'def place():', '    return cart.apply_discount(1, 2)']),
      'tests/test_modules.py': source([
        'import cart',
        'import shop.pricing.rules',
        'import shop.cart as c',
        '',
        'def test_modules():',
        '    cart.subtotal([])',
        '    shop.pricing.rules.rule()',
        '    c.apply_discount(1, 2)',
      ]),
      'src/lib.rs': source(['pub mod cart;', 'use crate::cart;', '', 'pub fn total() -> i32 {', '    cart::subtotal()', '}']),
      'src/cart.rs': source(['pub fn subtotal() -> i32 {', '    1', '}']),
      'web/util.js': source(['export function format(x) {', '  return x;', '}']),
      'web/run.js': source(["import * as util from './util.js';", '', 'export function run() {', '  return util.format(1);', '}']),
    });
    expect(graph.callees('tests/test_modules.py::test_modules').sort()).toEqual(['cart.py::subtotal', 'shop/cart.py::apply_discount', 'shop/pricing/rules.py::rule']);
    // `from shop import cart` binds the submodule shop/cart.py, not the top-level cart.py.
    expect(graph.callees('shop/checkout.py::place')).toEqual(['shop/cart.py::apply_discount']);
    expect(graph.callees('src/lib.rs::total')).toEqual(['src/cart.rs::subtotal']);
    expect(graph.callees('web/run.js::run')).toEqual(['web/util.js::format']);
  });
});

describe('JavaScript and TypeScript', () => {
  const files = {
    'src/price.ts': source([
      'export function total(items: number[]): number {',
      '  let sum = 0;',
      '  for (const item of items) {',
      '    if (item > 0) sum += item;',
      '  }',
      '  return sum;',
      '}',
      'export function check(pattern: RegExp, text: string) {',
      '  return pattern.test(text);',
      '}',
    ]),
    'test/price.test.ts': source([
      "import { describe, it, test, vi, expect } from 'vitest';",
      "import { total } from '../src/price';",
      "import * as price from '../src/price';",
      '',
      "vi.mock('../src/price');",
      '',
      "describe('total', () => {",
      "  describe('with items', () => {",
      "    it('adds them', () => {",
      '      expect(() => total([1])).not.toThrow();',
      '    });',
      "    it.each([[1, 1]])('adds %i', (a, b) => {",
      '      expect(total([a])).toBe(b);',
      '    });',
      '  });',
      "  test.only('spies', () => {",
      "    vi.spyOn(price, 'check');",
      '  });',
      '});',
      'const pattern = /x/;',
      "pattern.test('not a test', () => total([]));",
    ]),
    'src/cart.js': source(['export function add(x) {', '  return x + 1;', '}']),
    'test/cart.test.js': source([
      "import test from 'node:test';",
      "import { add } from '../src/cart.js';",
      "jest.mock('../src/cart.js');",
      '',
      "context('cart', function () {",
      "  test('adds', () => { add(1); });",
      "  it('is not skipped by a template title', () => {});",
      "  it(`but not ${'one'} with a substitution`, () => {});",
      '});',
    ]),
    'src/Panel.tsx': source([
      'export function formatLabel(label: string) {',
      '  return label.toUpperCase();',
      '}',
      'export function Panel({ label }: { label: string }) {',
      '  return <div>{formatLabel(label)}</div>;',
      '}',
    ]),
    'test/Panel.test.tsx': source([
      "import { formatLabel, Panel } from '../src/Panel';",
      '',
      "describe('Panel', () => {",
      "  it('renders', () => {",
      "    expect(formatLabel('x')).toBe('X');",
      '    const view = <Panel label="x" />;',
      '  });',
      '});',
    ]),
  };

  it('names tests by suite and title', async () => {
    const { file, method } = await repository(files);
    expect(file('test/price.test.ts').methods.filter(item => item.test).map(item => [item.id, item.line, item.end_line])).toEqual([
      ['test/price.test.ts::total > with items > adds them', 9, 11],
      ['test/price.test.ts::total > with items > adds %i', 12, 14],
      ['test/price.test.ts::total > spies', 16, 18],
    ]);
    expect(method('test/price.test.ts::total > with items > adds them')).toMatchObject({ name: 'adds them', test: { name: 'adds them', suite: ['total', 'with items'], framework: 'vitest' } });
    expect(method('test/price.test.ts::total > spies').test).toEqual({ name: 'spies', suite: ['total'], framework: 'vitest' });
    expect(file('test/price.test.ts').methods.map(item => item.name)).not.toContain('not a test');
    expect(file('test/cart.test.js').methods.filter(item => item.node !== null).map(item => [item.qualified_name, item.test])).toEqual([
      ['cart > adds', { name: 'adds', suite: ['cart'], framework: 'node:test' }],
      ['cart > is not skipped by a template title', { name: 'is not skipped by a template title', suite: ['cart'], framework: 'global' }],
      // A title with a substitution is known only when it runs, so the case is named by its source.
      ["cart > but not ${'one'} with a substitution", { name: "but not ${'one'} with a substitution", suite: ['cart'], framework: 'global', parametrized: true }],
    ]);
    expect(method('test/Panel.test.tsx::Panel > renders')).toMatchObject({ line: 4, end_line: 7, test: { name: 'renders', suite: ['Panel'], framework: 'global' } });
  });

  it('owns calls in nested callbacks', async () => {
    const { graph, file } = await repository(files);
    expect(file('test/price.test.ts').calls.filter(call => call.name === 'total').map(call => [call.from, call.line])).toEqual([
      ['test/price.test.ts::total > with items > adds them', 10],
      ['test/price.test.ts::total > with items > adds %i', 13],
      // `pattern.test(...)` is no test; the call in its callback is the file's top-level code.
      ['test/price.test.ts::<top-level>', 21],
    ]);
    expect(graph.callees('test/price.test.ts::total > with items > adds them')).toEqual(['src/price.ts::total']);
    expect(graph.callees('test/cart.test.js::cart > adds')).toEqual(['src/cart.js::add']);
    expect(graph.callees('test/Panel.test.tsx::Panel > renders')).toEqual(['src/Panel.tsx::formatLabel']);
    expect(graph.external('test/price.test.ts::total > with items > adds them')).toEqual([{ name: 'expect', line: 10 }]);
  });

  it('reads module mocks and spies', async () => {
    const { file, graph } = await repository(files);
    expect(file('test/price.test.ts').mocks).toEqual([
      { owner: 'file', target: { kind: 'module', module: '../src/price' }, line: 5 },
      { owner: 'test/price.test.ts::total > spies', target: { kind: 'member', object: 'price', name: 'check' }, line: 17 },
    ]);
    expect(file('test/cart.test.js').mocks).toEqual([{ owner: 'file', target: { kind: 'module', module: '../src/cart.js' }, line: 3 }]);
    expect(graph.mocks('test/price.test.ts::total > spies')).toEqual(['src/price.ts::total', 'src/price.ts::check']);
    expect(graph.mocks('test/cart.test.js::cart > adds')).toEqual(['src/cart.js::add']);
    expect(graph.mocks('test/Panel.test.tsx::Panel > renders')).toEqual([]);
  });

  it('records branch lines', async () => {
    const { method } = await repository(files);
    expect(method('src/price.ts::total').branches).toEqual([3, 4]);
    expect(method('src/price.ts::check').branches).toEqual([]);
  });
});

describe('Rust', () => {
  const files = {
    'src/lib.rs': source([
      'pub trait Store {',
      '    fn get(&self) -> i32 { 1 }',
      '}',
      '',
      'pub fn plain(x: i32) -> i32 {',
      '    if x > 0 { x } else { 0 }',
      '}',
      '',
      '#[cfg(test)]',
      'mod tests {',
      '    use super::*;',
      '',
      '    #[test]',
      '    fn keeps_positive() {',
      '        let got = plain(2);',
      '        assert_eq!(got, 2);',
      '    }',
      '',
      '    #[tokio::test]',
      '    async fn works_async() {',
      '        let store = MockStore::new();',
      '    }',
      '',
      '    fn helper() {}',
      '}',
    ]),
  };

  it('finds #[test] functions', async () => {
    const { scan, graph, method } = await repository(files);
    expect(method('src/lib.rs::keeps_positive')).toMatchObject({ line: 14, end_line: 17, test: { name: 'keeps_positive', suite: ['tests'], framework: 'test' } });
    expect(method('src/lib.rs::works_async').test).toEqual({ name: 'works_async', suite: ['tests'], framework: 'tokio::test' });
    expect(method('src/lib.rs::helper').test).toBeUndefined();
    expect(method('src/lib.rs::plain').test).toBeUndefined();
    expect(scan.candidates.map(candidate => candidate.id).sort()).toEqual(['src/lib.rs::Store.get', 'src/lib.rs::helper', 'src/lib.rs::plain']);
    expect(graph.nodes.get('src/lib.rs::keeps_positive')).toMatchObject({ test: true, case: { name: 'keeps_positive', suite: ['tests'], framework: 'test' } });
    expect(graph.nodes.get('src/lib.rs::plain')).toMatchObject({ test: false, case: null });
    expect(graph.callees('src/lib.rs::keeps_positive')).toEqual(['src/lib.rs::plain']);
  });

  it('reads calls in assertion macros', async () => {
    const { graph, file } = await repository({
      'src/lib.rs': source([
        'pub fn plain(x: i32) -> i32 { x }',
        '',
        '#[test]',
        'fn asserts() {',
        '    assert_eq!(plain(2), Vec::<i32>::new().len());',
        '    let check = |x: i32| plain(x);',
        '    assert!(check(1) > 0, "{}", crate::plain(3));',
        '}',
      ]),
    });
    expect(file('src/lib.rs').methods.map(method => method.qualified_name)).toEqual(['plain', 'asserts', 'asserts.check']);
    expect(file('src/lib.rs').calls.map(call => [call.name, call.from, call.line])).toEqual([
      ['plain', 'src/lib.rs::asserts', 5],
      ['plain', 'src/lib.rs::asserts.check', 6],
      ['check', 'src/lib.rs::asserts', 7],
      ['crate::plain', 'src/lib.rs::asserts', 7],
    ]);
    expect(graph.callees('src/lib.rs::asserts').sort()).toEqual(['src/lib.rs::asserts.check', 'src/lib.rs::plain']);
  });

  it('reads MockX::new() as a mock of X', async () => {
    const { file, graph } = await repository(files);
    expect(file('src/lib.rs').mocks).toEqual([{ owner: 'src/lib.rs::works_async', target: { kind: 'class', name: 'Store' }, line: 21 }]);
    expect(graph.mocks('src/lib.rs::works_async')).toEqual(['src/lib.rs::Store.get']);
    expect(graph.mocks('src/lib.rs::keeps_positive')).toEqual([]);
  });
});

describe('Java and Kotlin', () => {
  const files = {
    'src/main/java/shop/Cart.java': source(['package shop;', '', 'public class Cart {', '    public static int subtotal(int a) {', '        return a * 2;', '    }', '}']),
    'src/main/java/other/Cart.java': source(['package other;', '', 'public class Cart {', '    public static int subtotal(int a) { return a; }', '}']),
    'src/main/java/shop/pricing/Discounts.java': source(['package shop.pricing;', '', 'public class Discounts {', '    public static int apply(int a) { return a - 1; }', '}']),
    'src/test/java/shop/CartTest.java': source([
      'package shop;',
      '',
      'import shop.pricing.Discounts;',
      'import org.junit.jupiter.api.Test;',
      '',
      'class CartTest {',
      '    @Mock Discounts discounts;',
      '',
      '    @Test',
      '    void doublesTheTotal() {',
      '        Cart.subtotal(2);',
      '        Discounts.apply(3);',
      '    }',
      '',
      '    @ParameterizedTest',
      '    void appliesTheDiscount(int x) { helper(); mock(Cart.class); }',
      '',
      '    void helper() {}',
      '}',
    ]),
    'src/main/kotlin/shop/Format.kt': source(['package shop', '', 'fun format(x: Int): String = x.toString()']),
    'src/test/kotlin/shop/FormatTest.kt': source(['package shop', '', 'class FormatTest {', '    @Test fun formats() { format(1) }', '}']),
  };

  it('finds JUnit tests', async () => {
    const { file, method } = await repository(files);
    expect(file('src/test/java/shop/CartTest.java').package).toBe('shop');
    expect(file('src/main/java/shop/pricing/Discounts.java').package).toBe('shop.pricing');
    expect(method('src/test/java/shop/CartTest.java::CartTest.doublesTheTotal')).toMatchObject({ line: 9, end_line: 13,
      test: { name: 'doublesTheTotal', suite: ['CartTest'], framework: 'Test' } });
    expect(method('src/test/java/shop/CartTest.java::CartTest.appliesTheDiscount').test).toEqual({ name: 'appliesTheDiscount', suite: ['CartTest'], framework: 'ParameterizedTest' });
    expect(method('src/test/java/shop/CartTest.java::CartTest.helper').test).toBeUndefined();
    expect(method('src/test/kotlin/shop/FormatTest.kt::FormatTest.formats').test).toEqual({ name: 'formats', suite: ['FormatTest'], framework: 'Test' });
  });

  it('reads class-level TestNG @Test', async () => {
    const { method } = await repository({
      'src/test/java/shop/TotalTest.java': source([
        'package shop;',
        '',
        'import org.testng.annotations.BeforeMethod;',
        'import org.testng.annotations.DataProvider;',
        'import org.testng.annotations.Test;',
        '',
        '@Test',
        'public class TotalTest {',
        '    @BeforeMethod',
        '    public void setUp() {}',
        '',
        '    @DataProvider',
        '    public Object[][] totals() { return new Object[0][]; }',
        '',
        '    public void addsTheLines() { Cart.subtotal(1); }',
        '',
        '    void packagePrivate() {}',
        '',
        '    private int helper() { return 1; }',
        '',
        '    static class Inner {',
        '        public void notATest() {}',
        '    }',
        '}',
      ]),
    });
    expect(method('src/test/java/shop/TotalTest.java::TotalTest.addsTheLines').test).toEqual({ name: 'addsTheLines', suite: ['TotalTest'], framework: 'Test' });
    for (const name of ['setUp', 'totals', 'packagePrivate', 'helper', 'Inner.notATest']) {
      expect(method(`src/test/java/shop/TotalTest.java::TotalTest.${name}`).test, name).toBeUndefined();
    }
  });

  it('links classes by package and import', async () => {
    const { graph } = await repository(files);
    expect(graph.callees('src/test/java/shop/CartTest.java::CartTest.doublesTheTotal').sort()).toEqual([
      'src/main/java/shop/Cart.java::Cart.subtotal',
      'src/main/java/shop/pricing/Discounts.java::Discounts.apply',
    ]);
    expect(graph.callees('src/test/java/shop/CartTest.java::CartTest.appliesTheDiscount')).toEqual(['src/test/java/shop/CartTest.java::CartTest.helper']);
    expect(graph.callees('src/test/kotlin/shop/FormatTest.kt::FormatTest.formats')).toEqual(['src/main/kotlin/shop/Format.kt::format']);
  });

  it('reads Mockito mocks', async () => {
    const { file, graph } = await repository(files);
    expect(file('src/test/java/shop/CartTest.java').mocks).toEqual([
      { owner: 'file', target: { kind: 'class', name: 'Discounts' }, line: 7 },
      { owner: 'src/test/java/shop/CartTest.java::CartTest.appliesTheDiscount', target: { kind: 'class', name: 'Cart' }, line: 16 },
    ]);
    expect(graph.mocks('src/test/java/shop/CartTest.java::CartTest.doublesTheTotal')).toEqual(['src/main/java/shop/pricing/Discounts.java::Discounts.apply']);
    expect(graph.mocks('src/test/java/shop/CartTest.java::CartTest.appliesTheDiscount').sort()).toEqual([
      'src/main/java/shop/Cart.java::Cart.subtotal',
      'src/main/java/shop/pricing/Discounts.java::Discounts.apply',
    ]);
  });
});

describe('C and C++', () => {
  const files = {
    'src/cart.cpp': source([
      '#include "cart.hpp"',
      '',
      'int apply_discount(int total, int percent) {',
      '    if (percent >= 100) return 0;',
      '    return total - total * percent / 100;',
      '}',
      '',
      'static int round_down(int x) { return x; }',
      '',
      'int duplicate() { return 1; }',
      '',
      'double Cart::total() const { return 0; }',
      '',
      'int Store::get() { return 1; }',
    ]),
    'src/other.cpp': source(['int duplicate() { return 2; }']),
    'test/cart_test.cpp': source([
      '#include "cart.hpp"',
      '#include <gtest/gtest.h>',
      '',
      'class MockStore : public Store {',
      '    MOCK_METHOD(int, get, (), (override));',
      '};',
      '',
      'TEST(ApplyDiscount, TakesTenPercentOff) {',
      '    EXPECT_EQ(apply_discount(200, 10), 180);',
      '    round_down(1);',
      '    duplicate();',
      '    auto charge = [](const std::string& sku) { return apply_discount(1, 2); };',
      '    std::for_each(items.begin(), items.end(), [](const std::string& s) { return s; });',
      '}',
      '',
      'TEST_F(CartFixture, Empty) { EXPECT_TRUE(true); }',
      '',
      'TEST_CASE("catch style", "[cart]") {',
      '    REQUIRE(apply_discount(100, 100) == 0);',
      '}',
      '',
      'int normal() { return 0; }',
    ]),
  };

  it('finds GoogleTest and Catch2 tests', async () => {
    const { file, method } = await repository(files);
    expect(file('test/cart_test.cpp').methods.filter(item => item.node !== null).map(item => [item.qualified_name, item.line, item.end_line, item.test ?? null])).toEqual([
      ['ApplyDiscount.TakesTenPercentOff', 8, 14, { name: 'TakesTenPercentOff', suite: ['ApplyDiscount'], framework: 'TEST' }],
      // A lambda is named by what it is bound to, and qualified by the test it is in. The unbound one has no name.
      ['ApplyDiscount.TakesTenPercentOff.charge', 12, 12, null],
      ['CartFixture.Empty', 16, 16, { name: 'Empty', suite: ['CartFixture'], framework: 'TEST_F' }],
      ['catch style', 18, 20, { name: 'catch style', suite: [], framework: 'TEST_CASE' }],
      ['normal', 22, 22, null],
    ]);
    expect(method('src/cart.cpp::Cart.total')).toMatchObject({ name: 'total', qualified_name: 'Cart.total' });
    // A lambda taking a `std::` type was once named `std`, after the first name inside its parameter list.
    expect(file('test/cart_test.cpp').methods.map(item => item.name)).not.toContain('std');
    expect(method('src/cart.cpp::apply_discount').branches).toEqual([4]);
  });

  it('links only a unique external definition', async () => {
    const { graph, method } = await repository(files);
    expect(method('src/cart.cpp::round_down').internal).toBe(true);
    expect(method('src/cart.cpp::apply_discount').internal).toBeUndefined();
    // The test reaches apply_discount, and the lambda it wrote, which reaches apply_discount again.
    expect(graph.callees('test/cart_test.cpp::ApplyDiscount.TakesTenPercentOff').sort()).toEqual(['src/cart.cpp::apply_discount', 'test/cart_test.cpp::ApplyDiscount.TakesTenPercentOff.charge']);
    expect(graph.callees('test/cart_test.cpp::ApplyDiscount.TakesTenPercentOff.charge')).toEqual(['src/cart.cpp::apply_discount']);
    expect(graph.callees('test/cart_test.cpp::catch style')).toEqual(['src/cart.cpp::apply_discount']);
    expect(graph.external('test/cart_test.cpp::ApplyDiscount.TakesTenPercentOff').map(call => call.name).sort()).toEqual(
      ['EXPECT_EQ', 'duplicate', 'items.begin', 'items.end', 'round_down', 'std::for_each']);
  });

  it('reads gmock classes', async () => {
    const { file, graph } = await repository(files);
    expect(file('test/cart_test.cpp').mocks).toEqual([{ owner: 'file', target: { kind: 'class', name: 'Store' }, line: 4 }]);
    expect(graph.mocks('test/cart_test.cpp::CartFixture.Empty')).toEqual(['src/cart.cpp::Store.get']);
  });
});

describe('Catch2 and doctest', () => {
  const cart = source([
    'int apply_discount(int total, int percent) {',
    '    if (percent >= 100) return 0;',
    '    return total - total * percent / 100;',
    '}',
  ]);
  // Clause names this short are where the C++ grammar recovers `GIVEN("0") { }` as an ERROR and a block.
  const bdd = source([
      '#include "cart.hpp"',
      '#include <catch2/catch_test_macros.hpp>',
      '',
      'SCENARIO("no discount") {',
      '    GIVEN("0") {',
      '        CHECK(apply_discount(200, 0) == 200);',
      '    }',
      '}',
      '',
      'SCENARIO("ten percent off") {',
      '    WHEN("10") {',
      '        THEN("ok") {',
      '            CHECK(apply_discount(200, 10) == 180);',
      '        }',
      '    }',
      '}',
      '',
      'SCENARIO("discounts in turn") {',
      '    GIVEN("a") {',
      '        WHEN("b") { CHECK(apply_discount(200, 10) == 180); }',
      '        AND_WHEN("c") { CHECK(apply_discount(200, 20) == 160); }',
      '        THEN("d") { CHECK(apply_discount(200, 20) < 200); }',
      '        AND_THEN("e") { CHECK(apply_discount(200, 100) == 0); }',
      '    }',
      '}',
      '',
      'TEST_CASE("apply_discount by section", "[apply_discount]") {',
      '    SECTION("a") {',
      '        CHECK(apply_discount(200, 10) == 180);',
      '    }',
      '    for (int percent : {20, 50}) {',
      '        DYNAMIC_SECTION("p" << percent) {',
      '            CHECK(apply_discount(200, percent) < 200);',
      '        }',
      '    }',
      '}',  ]);
  const doctest = source([
    '#include "cart.hpp"',
    '#include <doctest/doctest.h>',
    '',
    'TEST_CASE("takes ten percent off") {',
    '    SUBCASE("0") {',
    '        CHECK(apply_discount(200, 10) == 180);',
    '    }',
    '}',
    '',
    'SCENARIO("paying") {',
    '    GIVEN("0") {',
    '        CHECK(apply_discount(200, 0) == 200);',
    '    }',
    '}',
    '',
    'TEST_SUITE("discounts") {',
    '    TEST_CASE("takes half off") { CHECK(apply_discount(200, 50) == 100); }',
    '}',
  ]);
  const tests = file => file.methods.filter(item => item.test).map(item => [item.qualified_name, item.test]);

  it('names Catch2 and doctest cases', async () => {
    const { file } = await repository({ 'src/cart.cpp': cart, 'test/discount_test.cpp': bdd, 'test/doctest_test.cpp': doctest });
    expect(tests(file('test/discount_test.cpp'))).toEqual([
      ['Scenario: no discount', { name: 'Scenario: no discount', suite: [], framework: 'catch2' }],
      ['Scenario: ten percent off', { name: 'Scenario: ten percent off', suite: [], framework: 'catch2' }],
      ['Scenario: discounts in turn', { name: 'Scenario: discounts in turn', suite: [], framework: 'catch2' }],
      ['apply_discount by section', { name: 'apply_discount by section', suite: [], framework: 'catch2' }],
    ]);
    // doctest's SCENARIO is `TEST_CASE("  Scenario: " name)`, and a test in a TEST_SUITE block is in that suite.
    expect(tests(file('test/doctest_test.cpp'))).toEqual([
      ['takes ten percent off', { name: 'takes ten percent off', suite: [], framework: 'doctest' }],
      ['  Scenario: paying', { name: '  Scenario: paying', suite: [], framework: 'doctest' }],
      ['discounts.takes half off', { name: 'takes half off', suite: ['discounts'], framework: 'doctest' }],
    ]);
  });

  it('keeps sections in their test case', async () => {
    const { file, graph } = await repository({ 'src/cart.cpp': cart, 'test/discount_test.cpp': bdd, 'test/doctest_test.cpp': doctest });
    // Nothing but the test cases is a declaration: no section, subcase or clause is a test or a method of its own.
    expect(file('test/discount_test.cpp').methods.map(item => item.qualified_name)).toEqual(
      ['Scenario: no discount', 'Scenario: ten percent off', 'Scenario: discounts in turn', 'apply_discount by section']);
    expect(file('test/doctest_test.cpp').methods.map(item => item.qualified_name)).toEqual(
      ['takes ten percent off', '  Scenario: paying', 'discounts.takes half off']);
    for (const id of ['test/discount_test.cpp::Scenario: no discount', 'test/discount_test.cpp::Scenario: ten percent off',
      'test/discount_test.cpp::Scenario: discounts in turn', 'test/discount_test.cpp::apply_discount by section',
      'test/doctest_test.cpp::takes ten percent off', 'test/doctest_test.cpp::  Scenario: paying']) {
      expect(graph.callees(id), id).toEqual(['src/cart.cpp::apply_discount']);
    }
  });

  it('keeps real syntax errors', async () => {
    // Without Catch2's header GIVEN is no framework's macro, so the ERROR the grammar made of it is an error again, and the
    // scenarios it is in are not read. The one that parsed cleanly still is.
    const { file } = await repository({ 'src/cart.cpp': cart, 'test/discount_test.cpp': bdd.replace('#include <catch2/catch_test_macros.hpp>\n', '') });
    expect(file('test/discount_test.cpp').methods.filter(item => item.node !== null).map(item => item.qualified_name)).toEqual(['apply_discount by section']);
    const broken = await repository({
      'src/cart.cpp': cart,
      'test/broken_test.cpp': source([
        '#include "cart.hpp"',
        '#include <catch2/catch_test_macros.hpp>',
        '',
        'TEST_CASE("does not compile") {',
        '    int total = ;',
        '    CHECK(apply_discount(total, 10) == 0);',
        '}',
        '',
        'TEST_CASE("uses a macro Catch2 does not define") {',
        '    FOO("0") {',
        '        CHECK(apply_discount(200, 10) == 180);',
        '    }',
        '}',
        '',
        'TEST_CASE("reads") {',
        '    CHECK(apply_discount(200, 10) == 180);',
        '}',
      ]),
    });
    expect(broken.file('test/broken_test.cpp').methods.filter(item => item.node !== null).map(item => item.qualified_name)).toEqual(['reads']);
  });
});

describe('test titles', () => {
  it('decodes escapes and marks .each tests', async () => {
    const { analyzeFiles, createSourceAnalyzer } = await import('../src/analysis.js');
    const sources = {
      'a.test.ts': "import { describe, it } from 'vitest';\nit('reads the file\\'s \\x41\\u0042', () => {});\nit.each([[1, 2]])('adds %i and %i', (a, b) => {});\ndescribe.each([{ n: 1 }])('with $n', () => { it('works', () => {}); });\n",
      'test_raw.py': "import pytest\n\n@pytest.mark.parametrize('x', [1])\ndef test_x(x):\n    pass\n",
    };
    const scan = await analyzeFiles(Object.keys(sources).map(path => ({ path, sha: path })), { analyzer: createSourceAnalyzer(), readSource: async file => sources[file.path] });
    const cases = scan.files.flatMap(file => file.methods.filter(method => method.test).map(method => method.test));
    expect(cases).toEqual([
      { name: "reads the file's AB", suite: [], framework: 'vitest' },
      { name: 'adds %i and %i', suite: [], framework: 'vitest', parametrized: true },
      { name: 'works', suite: ['with $n'], framework: 'vitest', parametrized: true },
      { name: 'test_x', suite: [], framework: 'pytest' },
    ]);
  });
});

it('reads a test whose title is computed in a loop as one parametrized case', async () => {
  const source = [
    "import { describe, expect, test } from 'vitest';",
    "import { withQuery } from '../src/query';",
    "describe('withQuery', () => {",
    "  for (const t of tests) {",
    "    test(t.input + ' with ' + JSON.stringify(t.query), () => {",
    "      expect(withQuery(t.input, t.query)).toBe(t.out);",
    '    });',
    '  }',
    '});',
  ].join('\n');
  const result = await createAnalyzer().analyzeSource(source, 'typescript', { path: 'test/query.test.ts' });
  const tests = result.declarations.filter(item => item.test);
  expect(tests.map(item => item.test)).toEqual([{ name: '${t.input} with ${JSON.stringify(t.query)}', suite: ['withQuery'], framework: 'vitest', parametrized: true }]);
});

it("gives each test in a suite the calls the suite's setup makes", async () => {
  const files = {
    'src/render.js': 'export function render(report) {\n  return String(report);\n}\nexport function shout(text) {\n  return text.toUpperCase();\n}\n',
    'test/render.test.js': [
      "import { describe, it, expect, beforeEach } from 'vitest';",
      "import { render, shout } from '../src/render.js';",
      "describe('render', () => {",
      '  const html = render(1);',
      '  let loud;',
      "  beforeEach(() => { loud = shout('a'); });",
      "  it('renders', () => { expect(html).toBe('1'); });",
      "  it('shouts', () => { expect(loud).toBe('A'); });",
      '});',
      "it('outside the suite', () => { expect(1).toBe(1); });",
    ].join('\n'),
  };
  const { graph } = await repository(files);
  expect(graph.callees('test/render.test.js::render > renders').sort()).toEqual(['src/render.js::render', 'src/render.js::shout']);
  expect(graph.callees('test/render.test.js::render > shouts').sort()).toEqual(['src/render.js::render', 'src/render.js::shout']);
  expect(graph.callees('test/render.test.js::outside the suite')).toEqual([]);
});
