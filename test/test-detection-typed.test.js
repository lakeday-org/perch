/**
 * Test detection and call resolution in C#, Swift and Scala: what the tree says is a test, under which framework, with what
 * setup, and how a test's calls reach the code under test by each language's own scoping (namespaces and usings, SwiftPM
 * modules, packages and imports).
 */
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

/** The setup a test runs, as the calls analysis.js turns a case's `setup` into: owned by the test, at its first line. */
const setupOf = (file, id) => file.calls.filter(call => call.from === id && call.line === file.methods.find(method => method.id === id).line).map(call => call.name);

describe('C#', () => {
  const files = {
    'src/Shop/Cart.cs': source([
      'namespace Shop;',
      '',
      'public class Cart',
      '{',
      '    public Cart() { }',
      '    public void Add(int x) { }',
      '    public int Total() { return 0; }',
      '    public static int Discount(int total, int percent) { return total - total * percent / 100; }',
      '}',
    ]),
    'src/Shop/Pricing/Rules.cs': source([
      'namespace Shop.Pricing',
      '{',
      '    public static class Rules',
      '    {',
      '        public static int Apply(int x) { return x; }',
      '    }',
      '    public class Catalogue',
      '    {',
      '        public int Price(string sku) { return 1; }',
      '    }',
      '}',
    ]),
    'tests/Shop.Tests/CartTests.cs': source([
      'using Shop.Pricing;',
      'using static Shop.Pricing.Rules;',
      'using Prices = Shop.Pricing.Catalogue;',
      'using Xunit;',
      '',
      'namespace Shop.Tests;',
      '',
      'public class CartTests',
      '{',
      '    private readonly Cart _cart = new Cart();',
      '    private Prices _prices;',
      '',
      '    public CartTests() { _prices = new Prices(); }',
      '',
      '    [Fact]',
      '    public void Discounts()',
      '    {',
      '        _cart.Add(1);',
      '        this._prices.Price("a");',
      '        Assert.Equal(180, Cart.Discount(200, 10));',
      '        Apply(1);',
      '        Helper();',
      '    }',
      '',
      '    [Theory]',
      '    [InlineData(1)]',
      '    public void Zero(int x) { Assert.True(new Cart().Total() >= 0); }',
      '',
      '    private void Helper() { }',
      '}',
    ]),
    'tests/Shop.Tests/NUnitTests.cs': source([
      'using NUnit.Framework;',
      '',
      'namespace Shop.Tests',
      '{',
      '    [TestFixture]',
      '    public class NUnitTests',
      '    {',
      '        private Cart _cart;',
      '',
      '        [SetUp]',
      '        public void SetUp() { _cart = new Cart(); }',
      '',
      '        [OneTimeSetUp]',
      '        public void Once() { }',
      '',
      '        [Test]',
      '        public void Adds() { _cart.Add(1); }',
      '',
      '        [TestCase(1, 2)]',
      '        [TestCase(3, 4)]',
      '        public void Rows(int a, int b) { }',
      '',
      '        [TearDown]',
      '        public void TearDown() { }',
      '    }',
      '}',
    ]),
    'tests/Shop.Tests/MsTests.cs': source([
      'using Microsoft.VisualStudio.TestTools.UnitTesting;',
      '',
      'namespace Shop.Tests;',
      '',
      '[TestClass]',
      'public class MsTests',
      '{',
      '    [TestInitialize]',
      '    public void Init() { }',
      '',
      '    [TestMethod]',
      '    public void Totals() { }',
      '',
      '    [DataTestMethod]',
      '    [DataRow(1)]',
      '    public void Rows(int a) { }',
      '',
      '    [TestCleanup]',
      '    public void Cleanup() { }',
      '}',
    ]),
  };

  it('finds xUnit, NUnit and MSTest tests by their attributes', async () => {
    const { file, method } = await repository(files);
    expect(file('tests/Shop.Tests/CartTests.cs').package).toBe('Shop.Tests');
    expect(file('src/Shop/Pricing/Rules.cs').package).toBe('Shop.Pricing');
    expect(method('tests/Shop.Tests/CartTests.cs::CartTests.Discounts')).toMatchObject({ line: 15, end_line: 23, test: { name: 'Discounts', suite: ['CartTests'], framework: 'xunit' } });
    expect(method('tests/Shop.Tests/CartTests.cs::CartTests.Zero').test).toEqual({ name: 'Zero', suite: ['CartTests'], framework: 'xunit', parametrized: true });
    expect(method('tests/Shop.Tests/CartTests.cs::CartTests.Helper').test).toBeUndefined();
    expect(method('tests/Shop.Tests/CartTests.cs::CartTests.Helper').support).toBe(true);
    expect(method('tests/Shop.Tests/NUnitTests.cs::NUnitTests.Adds').test).toEqual({ name: 'Adds', suite: ['NUnitTests'], framework: 'nunit' });
    expect(method('tests/Shop.Tests/NUnitTests.cs::NUnitTests.Rows').test).toEqual({ name: 'Rows', suite: ['NUnitTests'], framework: 'nunit', parametrized: true });
    for (const name of ['SetUp', 'Once', 'TearDown']) expect(method(`tests/Shop.Tests/NUnitTests.cs::NUnitTests.${name}`).test, name).toBeUndefined();
    expect(method('tests/Shop.Tests/MsTests.cs::MsTests.Totals').test).toEqual({ name: 'Totals', suite: ['MsTests'], framework: 'mstest' });
    expect(method('tests/Shop.Tests/MsTests.cs::MsTests.Rows').test).toEqual({ name: 'Rows', suite: ['MsTests'], framework: 'mstest', parametrized: true });
    for (const name of ['Init', 'Cleanup']) expect(method(`tests/Shop.Tests/MsTests.cs::MsTests.${name}`).test, name).toBeUndefined();
    expect(method('src/Shop/Cart.cs::Cart.Discount').test).toBeUndefined();
  });

  it("runs each framework's setup before a test: xUnit's constructor, NUnit's [SetUp], MSTest's [TestInitialize]", async () => {
    const { file, graph } = await repository(files);
    expect(setupOf(file('tests/Shop.Tests/CartTests.cs'), 'tests/Shop.Tests/CartTests.cs::CartTests.Discounts')).toEqual(['CartTests.CartTests']);
    expect(setupOf(file('tests/Shop.Tests/NUnitTests.cs'), 'tests/Shop.Tests/NUnitTests.cs::NUnitTests.Adds')).toEqual(['NUnitTests.SetUp', 'NUnitTests.Once']);
    expect(setupOf(file('tests/Shop.Tests/MsTests.cs'), 'tests/Shop.Tests/MsTests.cs::MsTests.Totals')).toEqual(['MsTests.Init']);
    expect(graph.callees('tests/Shop.Tests/NUnitTests.cs::NUnitTests.Adds').sort()).toEqual(['src/Shop/Cart.cs::Cart.Add', 'tests/Shop.Tests/NUnitTests.cs::NUnitTests.Once', 'tests/Shop.Tests/NUnitTests.cs::NUnitTests.SetUp']);
    // The constructor runs for each test, and what it constructs is what the test's fields hold.
    expect(graph.callees('tests/Shop.Tests/NUnitTests.cs::NUnitTests.SetUp')).toEqual(['src/Shop/Cart.cs::Cart.Cart']);
  });

  it('resolves calls by namespace, enclosing namespace, using, using static and alias', async () => {
    const { graph } = await repository(files);
    // Shop.Tests sees Shop's Cart through the enclosing namespace, Rules.Apply through `using static`, and Catalogue as Prices.
    expect(graph.callees('tests/Shop.Tests/CartTests.cs::CartTests.Discounts').sort()).toEqual([
      'src/Shop/Cart.cs::Cart.Add',
      'src/Shop/Cart.cs::Cart.Discount',
      'src/Shop/Pricing/Rules.cs::Catalogue.Price',
      'src/Shop/Pricing/Rules.cs::Rules.Apply',
      'tests/Shop.Tests/CartTests.cs::CartTests.CartTests',
      'tests/Shop.Tests/CartTests.cs::CartTests.Helper',
    ]);
    // `new Cart().Total()`: the member of what the construction makes.
    expect(graph.callees('tests/Shop.Tests/CartTests.cs::CartTests.Zero').sort()).toEqual([
      'src/Shop/Cart.cs::Cart.Cart', 'src/Shop/Cart.cs::Cart.Total', 'tests/Shop.Tests/CartTests.cs::CartTests.CartTests',
    ]);
    expect(graph.callees('tests/Shop.Tests/CartTests.cs::CartTests.CartTests')).toEqual([]);
    expect(graph.external('tests/Shop.Tests/CartTests.cs::CartTests.Discounts').map(call => call.name)).toEqual(['Assert.Equal']);
  });
});

describe('Swift', () => {
  const files = {
    'Package.swift': source(['// swift-tools-version:5.9', 'import PackageDescription', 'let package = Package(name: "Shop", targets: [.target(name: "Shop"), .testTarget(name: "ShopTests", dependencies: ["Shop"])])']),
    'Sources/Shop/Cart.swift': source([
      'public final class Cart {',
      '    public init() {}',
      '    public func add(_ price: Int) {}',
      '    public func total() -> Int { return 0 }',
      '    public static func discount(_ total: Int, _ percent: Int) -> Int { return total - total * percent / 100 }',
      '}',
      'public func discount(_ total: Int, _ percent: Int) -> Int { return Cart.discount(total, percent) }',
    ]),
    'Sources/Other/Cart.swift': source(['public final class Cart {', '    public init() {}', '    public func add(_ price: Int) {}', '}']),
    'Tests/ShopTests/CartTests.swift': source([
      'import XCTest',
      '@testable import Shop',
      '',
      'final class CartTests: XCTestCase {',
      '    var cart: Cart!',
      '    let fixed = Cart()',
      '',
      '    override func setUp() {',
      '        super.setUp()',
      '        cart = Cart()',
      '    }',
      '',
      '    func testDiscount() {',
      '        cart.add(1)',
      '        fixed.add(2)',
      '        XCTAssertEqual(discount(200, 10), 180)',
      '        XCTAssertEqual(Cart.discount(200, 10), 180)',
      '        XCTAssertEqual(Cart().total(), 0)',
      '        helper()',
      '    }',
      '',
      '    func testTakesAParameter(x: Int) {}',
      '    func helper() {}',
      '}',
      '',
      'final class NotATestCase {',
      '    func testNothing() {}',
      '}',
    ]),
    'Tests/ShopTests/SuiteTests.swift': source([
      'import Testing',
      '@testable import Shop',
      '',
      '@Suite("Cart suite") struct CartSuite {',
      '    @Test func zero() { #expect(discount(1, 0) > 0) }',
      '    @Test("named case") func named() { let c = Cart(); c.add(1) }',
      '    @Test("rows", arguments: [1, 2]) func rows(x: Int) {}',
      '    @Test(arguments: [1, 2]) func bare(x: Int) {}',
      '    func helper() {}',
      '}',
      '',
      '@Test func topLevel() {}',
    ]),
  };

  it('finds XCTest methods and Swift Testing functions', async () => {
    const { file, method } = await repository(files);
    expect(method('Tests/ShopTests/CartTests.swift::CartTests.testDiscount')).toMatchObject({ line: 13, end_line: 20, test: { name: 'testDiscount', suite: ['CartTests'], framework: 'XCTest' } });
    expect(method('Tests/ShopTests/CartTests.swift::CartTests.testTakesAParameter').test).toBeUndefined();
    expect(method('Tests/ShopTests/CartTests.swift::CartTests.helper').test).toBeUndefined();
    expect(method('Tests/ShopTests/CartTests.swift::CartTests.setUp').test).toBeUndefined();
    // A class that does not inherit XCTestCase has no tests, whatever its methods are called.
    expect(method('Tests/ShopTests/CartTests.swift::NotATestCase.testNothing').test).toBeUndefined();
    expect(file('Tests/ShopTests/SuiteTests.swift').methods.filter(item => item.test).map(item => [item.qualified_name, item.test])).toEqual([
      ['CartSuite.zero', { name: 'zero', suite: ['CartSuite'], framework: 'Testing' }],
      ['CartSuite.named', { name: 'named case', suite: ['CartSuite'], framework: 'Testing' }],
      ['CartSuite.rows', { name: 'rows', suite: ['CartSuite'], framework: 'Testing', parametrized: true }],
      ['CartSuite.bare', { name: 'bare', suite: ['CartSuite'], framework: 'Testing', parametrized: true }],
      ['topLevel', { name: 'topLevel', suite: [], framework: 'Testing' }],
    ]);
  });

  it("runs XCTest's setUp and the stored properties' initializers before each test", async () => {
    const { file } = await repository(files);
    expect(setupOf(file('Tests/ShopTests/CartTests.swift'), 'Tests/ShopTests/CartTests.swift::CartTests.testDiscount')).toEqual(['Cart', 'CartTests.setUp']);
  });

  it('resolves calls through the module an import names, and never through another target', async () => {
    const { graph } = await repository(files);
    // Bare `discount` is Shop's top-level function; `Cart()` runs Shop's init, not Other's; members resolve through what a
    // property or a construction holds.
    expect(graph.callees('Tests/ShopTests/CartTests.swift::CartTests.testDiscount').sort()).toEqual([
      'Sources/Shop/Cart.swift::Cart.add',
      'Sources/Shop/Cart.swift::Cart.discount',
      'Sources/Shop/Cart.swift::Cart.init',
      'Sources/Shop/Cart.swift::Cart.total',
      'Sources/Shop/Cart.swift::discount',
      'Tests/ShopTests/CartTests.swift::CartTests.helper',
      'Tests/ShopTests/CartTests.swift::CartTests.setUp',
    ]);
    expect(graph.callees('Tests/ShopTests/CartTests.swift::CartTests.setUp')).toEqual(['Sources/Shop/Cart.swift::Cart.init']);
    expect(graph.callees('Tests/ShopTests/SuiteTests.swift::CartSuite.zero')).toEqual(['Sources/Shop/Cart.swift::discount']);
    expect(graph.callees('Tests/ShopTests/SuiteTests.swift::CartSuite.named').sort()).toEqual(['Sources/Shop/Cart.swift::Cart.add', 'Sources/Shop/Cart.swift::Cart.init']);
    // Within a module, a bare name reaches the module's own declarations.
    expect(graph.callees('Sources/Shop/Cart.swift::discount')).toEqual(['Sources/Shop/Cart.swift::Cart.discount']);
    expect(graph.external('Tests/ShopTests/CartTests.swift::CartTests.testDiscount').map(call => call.name)).toEqual(['XCTAssertEqual', 'XCTAssertEqual', 'XCTAssertEqual']);
  });
});

describe('Scala', () => {
  const files = {
    'src/main/scala/shop/cart/Cart.scala': source([
      'package shop.cart',
      '',
      'object Cart {',
      '  def apply(): Cart = new Cart()',
      '  def discount(total: Int, percent: Int): Int = total - total * percent / 100',
      '}',
      '',
      'class Cart {',
      '  private var items = List.empty[Int]',
      '  def add(x: Int): Unit = items = x :: items',
      '  def total(): Int = items.sum',
      '  def isEmpty: Boolean = items.isEmpty',
      '}',
    ]),
    'src/main/scala/shop/pricing/Rules.scala': source([
      'package shop.pricing',
      '',
      'object Rules {',
      '  def apply(x: Int): Int = x',
      '  def standard: Rules = new Rules(1)',
      '}',
      'class Rules(rate: Int) {',
      '  def price(x: Int): Int = x * rate',
      '}',
      'object Discount {',
      '  def of(x: Int): Int = x',
      '}',
    ]),
    'src/test/scala/shop/cart/CartSuite.scala': source([
      'package shop',
      'package cart',
      '',
      'import org.scalatest.BeforeAndAfterEach',
      'import org.scalatest.funsuite.AnyFunSuite',
      'import shop.pricing.{Discount, Rules => R}',
      '',
      'class CartSuite extends AnyFunSuite with BeforeAndAfterEach {',
      '  var cart: Cart = _',
      '  val fixed = new Cart()',
      '',
      '  override def beforeEach(): Unit = { cart = Cart() }',
      '',
      '  test("discounts") {',
      '    cart.add(1)',
      '    fixed.add(2)',
      '    assert(Cart.discount(200, 10) == 180)',
      '    assert(Discount.of(1) == 1)',
      '    assert(R.standard.price(2) == 2)',
      '    assert(new Cart().total() == 0)',
      '    assert(Cart().isEmpty)',
      '    helper()',
      '  }',
      '',
      '  test("ignored".ignore) { }',
      '  ignore("skipped") { }',
      '',
      '  def helper(): Unit = ()',
      '}',
    ]),
    'src/test/scala/shop/cart/CartSpec.scala': source([
      'package shop.cart',
      '',
      'import org.scalatest.flatspec.AnyFlatSpec',
      'import org.scalatest.funspec.AnyFunSpec',
      'import org.scalatest.wordspec.AnyWordSpec',
      '',
      'class CartSpec extends AnyFlatSpec {',
      '  "A Cart" should "discount" in { Cart.discount(200, 10) }',
      '  it should "reject" in { Cart.discount(200, 100) }',
      '  behavior of "An empty cart"',
      '  it must "total zero" in { new Cart().total() }',
      '}',
      '',
      'class CartFunSpec extends AnyFunSpec {',
      '  describe("Cart") {',
      '    describe("when empty") {',
      '      it("totals zero") { new Cart().total() }',
      '    }',
      '  }',
      '}',
      '',
      'class CartWordSpec extends AnyWordSpec {',
      '  "A Cart" when {',
      '    "empty" should {',
      '      "total zero" in { new Cart().total() }',
      '    }',
      '  }',
      '}',
    ]),
    'src/test/scala/shop/cart/CartMunit.scala': source([
      'package shop.cart',
      '',
      'import munit.FunSuite',
      '',
      'class CartMunit extends FunSuite {',
      '  override def beforeEach(context: BeforeEach): Unit = ()',
      '  test("zero") {',
      '    assertEquals(Cart.discount(1, 0), 1)',
      '  }',
      '  test("tagged".tag(Slow)) {',
      '    assertEquals(Cart.discount(1, 0), 1)',
      '  }',
      '}',
      '',
      'class Plain {',
      '  def test(name: String)(body: => Unit): Unit = ()',
      '  test("not a test") { }',
      '}',
    ]),
  };

  it('finds ScalaTest and munit tests under the names the frameworks report', async () => {
    const { file, method } = await repository(files);
    expect(file('src/test/scala/shop/cart/CartSuite.scala').package).toBe('shop.cart');
    expect(method('src/test/scala/shop/cart/CartSuite.scala::CartSuite.discounts')).toMatchObject({ line: 14, end_line: 23, test: { name: 'discounts', suite: ['CartSuite'], framework: 'scalatest' } });
    // An ignored test does not run; a helper is test code beside the tests.
    expect(file('src/test/scala/shop/cart/CartSuite.scala').methods.filter(item => item.node !== null).map(item => item.qualified_name)).toEqual(['CartSuite.beforeEach', 'CartSuite.discounts', 'CartSuite.helper']);
    expect(method('src/test/scala/shop/cart/CartSuite.scala::CartSuite.helper')).toMatchObject({ support: true });
    expect(file('src/test/scala/shop/cart/CartSpec.scala').methods.filter(item => item.test).map(item => [item.qualified_name, item.test])).toEqual([
      ['CartSpec.A Cart should discount', { name: 'A Cart should discount', suite: ['CartSpec'], framework: 'scalatest' }],
      ['CartSpec.A Cart should reject', { name: 'A Cart should reject', suite: ['CartSpec'], framework: 'scalatest' }],
      ['CartSpec.An empty cart must total zero', { name: 'An empty cart must total zero', suite: ['CartSpec'], framework: 'scalatest' }],
      ['CartFunSpec.Cart when empty totals zero', { name: 'Cart when empty totals zero', suite: ['CartFunSpec'], framework: 'scalatest' }],
      ['CartWordSpec.A Cart when empty should total zero', { name: 'A Cart when empty should total zero', suite: ['CartWordSpec'], framework: 'scalatest' }],
    ]);
    expect(file('src/test/scala/shop/cart/CartMunit.scala').methods.filter(item => item.test).map(item => [item.qualified_name, item.test])).toEqual([
      ['CartMunit.zero', { name: 'zero', suite: ['CartMunit'], framework: 'munit' }],
      ['CartMunit.tagged', { name: 'tagged', suite: ['CartMunit'], framework: 'munit' }],
    ]);
    // A `test("x") { }` call in a class that extends no suite is whatever that class's test method does.
    expect(file('src/test/scala/shop/cart/CartMunit.scala').methods.map(item => item.qualified_name)).not.toContain('Plain.not a test');
  });

  it('runs beforeEach before each test', async () => {
    const { file, graph } = await repository(files);
    expect(setupOf(file('src/test/scala/shop/cart/CartSuite.scala'), 'src/test/scala/shop/cart/CartSuite.scala::CartSuite.discounts')).toEqual(['CartSuite.beforeEach']);
    expect(setupOf(file('src/test/scala/shop/cart/CartMunit.scala'), 'src/test/scala/shop/cart/CartMunit.scala::CartMunit.zero')).toEqual(['CartMunit.beforeEach']);
    expect(graph.callees('src/test/scala/shop/cart/CartSuite.scala::CartSuite.beforeEach')).toEqual(['src/main/scala/shop/cart/Cart.scala::Cart.apply']);
  });

  it('resolves calls by package, import, selector rename and uniform access', async () => {
    const { graph } = await repository(files);
    expect(graph.callees('src/test/scala/shop/cart/CartSuite.scala::CartSuite.discounts').sort()).toEqual([
      'src/main/scala/shop/cart/Cart.scala::Cart.add',
      'src/main/scala/shop/cart/Cart.scala::Cart.apply',
      'src/main/scala/shop/cart/Cart.scala::Cart.discount',
      'src/main/scala/shop/cart/Cart.scala::Cart.isEmpty',
      'src/main/scala/shop/cart/Cart.scala::Cart.total',
      'src/main/scala/shop/pricing/Rules.scala::Discount.of',
      'src/main/scala/shop/pricing/Rules.scala::Rules.price',
      'src/test/scala/shop/cart/CartSuite.scala::CartSuite.beforeEach',
      'src/test/scala/shop/cart/CartSuite.scala::CartSuite.helper',
    ]);
    expect(graph.callees('src/test/scala/shop/cart/CartSpec.scala::CartSpec.A Cart should discount')).toEqual(['src/main/scala/shop/cart/Cart.scala::Cart.discount']);
    expect(graph.callees('src/test/scala/shop/cart/CartSpec.scala::CartWordSpec.A Cart when empty should total zero')).toEqual(['src/main/scala/shop/cart/Cart.scala::Cart.total']);
    expect(graph.callees('src/test/scala/shop/cart/CartMunit.scala::CartMunit.tagged').sort()).toEqual(['src/main/scala/shop/cart/Cart.scala::Cart.discount', 'src/test/scala/shop/cart/CartMunit.scala::CartMunit.beforeEach']);
    expect(graph.external('src/test/scala/shop/cart/CartMunit.scala::CartMunit.zero').map(call => call.name)).toEqual(['assertEquals']);
  });
});
