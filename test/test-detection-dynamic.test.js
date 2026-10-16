/**
 * Test detection and call resolution for Ruby, PHP and Lua: Minitest, test-unit and RSpec; PHPUnit and Pest; busted and luaunit.
 * Each case is read off syntax nodes, and each call from a test reaches the code under test by the language's own rules: a Ruby
 * require, a PHP namespace and its `use`, a Lua `require` bound to a local.
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

describe('Ruby', () => {
  const files = {
    'lib/shop.rb': source(['require_relative "shop/cart"', '', 'module Shop', '  VERSION = "1.0"', 'end']),
    'lib/shop/cart.rb': source([
      'module Shop',
      '  class Cart',
      '    def initialize(limit = 3)',
      '      @limit = limit',
      '      @items = []',
      '    end',
      '',
      '    def add(price)',
      '      raise ArgumentError, "full" if @items.size >= @limit',
      '      @items << price',
      '      self',
      '    end',
      '',
      '    def total',
      '      @items.sum',
      '    end',
      '',
      '    def self.discount(total, percent)',
      '      total - total * percent / 100',
      '    end',
      '  end',
      'end',
    ]),
    'test/test_helper.rb': source(['require "minitest/autorun"', 'require "shop"']),
    'test/cart_test.rb': source([
      'require "test_helper"',
      '',
      'class CartTest < Minitest::Test',
      '  def setup',
      '    @cart = Shop::Cart.new(2)',
      '  end',
      '',
      '  def test_adds_prices',
      '    @cart.add(5)',
      '    assert_equal 5, @cart.total',
      '  end',
      '',
      '  test "zero items" do',
      '    assert_equal 0, @cart.total',
      '    helper(1)',
      '  end',
      '',
      '  def test_discount',
      '    Shop::Cart.stub(:discount, 1) do',
      '      assert_equal 90, Shop::Cart.discount(100, 10)',
      '    end',
      '  end',
      '',
      '  def helper(x)',
      '    x',
      '  end',
      'end',
    ]),
    'test/legacy_test.rb': source([
      'require "test_helper"',
      '',
      'class LegacyTest < Test::Unit::TestCase',
      '  def test_discount',
      '    assert_equal 90, Shop::Cart.discount(100, 10)',
      '  end',
      'end',
    ]),
    'test/cart_spec_test.rb': source([
      'require "test_helper"',
      '',
      'describe Shop::Cart do',
      '  it "discounts" do',
      '    _(Shop::Cart.discount(100, 10)).must_equal 90',
      '  end',
      'end',
    ]),
    'spec/cart_spec.rb': source([
      'require "spec_helper"',
      '',
      'RSpec.describe Shop::Cart do',
      '  let(:cart) { Shop::Cart.new }',
      '',
      '  before do',
      '    cart.add(2)',
      '  end',
      '',
      '  it { expect(cart.total).to eq(2) }',
      '',
      '  describe "#total" do',
      '    it "adds up" do',
      '      cart.add(3)',
      '      expect(cart.total).to eq(5)',
      '    end',
      '  end',
      '',
      '  context "with a discount" do',
      '    it "asks the class" do',
      '      allow(Shop::Cart).to receive(:discount).and_return(1)',
      '      expect(Shop::Cart.discount(100, 10)).to eq(1)',
      '    end',
      '  end',
      '',
      '  def helper',
      '    cart.total',
      '  end',
      'end',
    ]),
    'spec/spec_helper.rb': source(['require "shop"']),
  };

  it('finds Minitest, test-unit and RSpec tests', async () => {
    const { file, method } = await repository(files);
    expect(method('test/cart_test.rb::CartTest.test_adds_prices')).toMatchObject({ line: 8, end_line: 11, test: { name: 'test_adds_prices', suite: ['CartTest'], framework: 'minitest' } });
    // Rails' `test "zero items" do` declares test_zero_items, named by its title.
    expect(method('test/cart_test.rb::CartTest.test_zero_items')).toMatchObject({ line: 13, end_line: 16, test: { name: 'zero items', suite: ['CartTest'], framework: 'minitest' } });
    expect(method('test/cart_test.rb::CartTest.helper')).toMatchObject({ support: true });
    expect(method('test/cart_test.rb::CartTest.helper').test).toBeUndefined();
    expect(method('test/cart_test.rb::CartTest.setup').test).toBeUndefined();
    expect(method('test/legacy_test.rb::LegacyTest.test_discount').test).toEqual({ name: 'test_discount', suite: ['LegacyTest'], framework: 'test-unit' });
    // `describe`/`it` in a file that requires test_helper is Minitest::Spec; in one that requires spec_helper it is RSpec.
    expect(method('test/cart_spec_test.rb::Shop::Cart > discounts').test).toEqual({ name: 'discounts', suite: ['Shop::Cart'], framework: 'minitest' });
    expect(file('spec/cart_spec.rb').methods.filter(item => item.test).map(item => [item.id, item.line, item.end_line])).toEqual([
      ['spec/cart_spec.rb::Shop::Cart > example at spec/cart_spec.rb:10', 10, 10],
      ['spec/cart_spec.rb::Shop::Cart > #total > adds up', 13, 16],
      ['spec/cart_spec.rb::Shop::Cart > with a discount > asks the class', 20, 23],
    ]);
    expect(method('spec/cart_spec.rb::Shop::Cart > #total > adds up').test).toEqual({ name: 'adds up', suite: ['Shop::Cart', '#total'], framework: 'rspec' });
    expect(method('spec/cart_spec.rb::helper')).toMatchObject({ support: true });
    for (const path of ['test/cart_test.rb', 'test/legacy_test.rb', 'spec/cart_spec.rb']) expect(file(path).test, path).toBe(true);
    expect(file('lib/shop/cart.rb').test).toBe(false);
    expect(method('lib/shop/cart.rb::Shop.Cart.total')).toMatchObject({ name: 'total', qualified_name: 'Shop.Cart.total' });
  });

  it('links a test to the code it requires', async () => {
    const { graph } = await repository(files);
    // `Shop::Cart.new` is Cart#initialize, found through test_helper's require of shop, which requires shop/cart.
    expect(graph.callees('test/cart_test.rb::CartTest.setup')).toEqual(['lib/shop/cart.rb::Shop.Cart.initialize']);
    // The class's setup runs before each test, and `@cart` holds what it made there.
    expect(graph.callees('test/cart_test.rb::CartTest.test_adds_prices').sort()).toEqual(['lib/shop/cart.rb::Shop.Cart.add', 'lib/shop/cart.rb::Shop.Cart.total', 'test/cart_test.rb::CartTest.setup']);
    expect(graph.callees('test/cart_test.rb::CartTest.test_zero_items').sort()).toEqual(['lib/shop/cart.rb::Shop.Cart.total', 'test/cart_test.rb::CartTest.helper', 'test/cart_test.rb::CartTest.setup']);
    expect(graph.callees('test/legacy_test.rb::LegacyTest.test_discount')).toEqual(['lib/shop/cart.rb::Shop.Cart.discount']);
    expect(graph.callees('test/cart_spec_test.rb::Shop::Cart > discounts')).toEqual(['lib/shop/cart.rb::Shop.Cart.discount']);
    // `let(:cart)` and `before` run for every example in the group; `cart.total` is total of what let built.
    expect(graph.callees('spec/cart_spec.rb::Shop::Cart > #total > adds up').sort()).toEqual(['lib/shop/cart.rb::Shop.Cart.add', 'lib/shop/cart.rb::Shop.Cart.initialize', 'lib/shop/cart.rb::Shop.Cart.total']);
    expect(graph.callees('spec/cart_spec.rb::Shop::Cart > example at spec/cart_spec.rb:10').sort()).toEqual(['lib/shop/cart.rb::Shop.Cart.add', 'lib/shop/cart.rb::Shop.Cart.initialize', 'lib/shop/cart.rb::Shop.Cart.total']);
    expect(graph.nodes.get('spec/cart_spec.rb::Shop::Cart > #total > adds up')).toMatchObject({ test: true, case: { name: 'adds up', framework: 'rspec' } });
  });

  it('reads RSpec stubs and Minitest stubs', async () => {
    const { file, graph } = await repository(files);
    expect(file('spec/cart_spec.rb').mocks).toEqual([{ owner: 'spec/cart_spec.rb::Shop::Cart > with a discount > asks the class', target: { kind: 'member', object: 'Shop::Cart', name: 'discount' }, line: 21 }]);
    expect(graph.mocks('spec/cart_spec.rb::Shop::Cart > with a discount > asks the class')).toEqual(['lib/shop/cart.rb::Shop.Cart.discount']);
    expect(graph.mocks('spec/cart_spec.rb::Shop::Cart > #total > adds up')).toEqual([]);
    expect(file('test/cart_test.rb').mocks).toEqual([{ owner: 'test/cart_test.rb::CartTest.test_discount', target: { kind: 'member', object: 'Shop::Cart', name: 'discount' }, line: 19 }]);
  });
});

describe('PHP', () => {
  const files = {
    'src/Cart.php': source([
      '<?php',
      'declare(strict_types=1);',
      '',
      'namespace App;',
      '',
      'use App\\Tax\\Rate;',
      '',
      'final class Cart',
      '{',
      '    private array $prices = [];',
      '',
      '    public function __construct(private readonly Rate $rate)',
      '    {',
      '    }',
      '',
      '    public function add(int $price): void',
      '    {',
      '        $this->prices[] = $price;',
      '    }',
      '',
      '    public function total(): int',
      '    {',
      '        return $this->rate->on(array_sum($this->prices));',
      '    }',
      '',
      '    public static function discount(int $total, int $percent): int',
      '    {',
      '        return $total - intdiv($total * $percent, 100);',
      '    }',
      '}',
    ]),
    'src/Tax/Rate.php': source([
      '<?php',
      'namespace App\\Tax;',
      '',
      'final class Rate',
      '{',
      '    public function __construct(private readonly int $percent) {}',
      '',
      '    public function on(int $amount): int',
      '    {',
      '        return $amount + intdiv($amount * $this->percent, 100);',
      '    }',
      '}',
    ]),
    'tests/CartTest.php': source([
      '<?php',
      'namespace App\\Tests;',
      '',
      'use App\\Cart;',
      'use App\\Tax\\Rate;',
      'use PHPUnit\\Framework\\Attributes\\DataProvider;',
      'use PHPUnit\\Framework\\Attributes\\Test;',
      'use PHPUnit\\Framework\\TestCase;',
      '',
      'final class CartTest extends TestCase',
      '{',
      '    private Cart $cart;',
      '',
      '    protected function setUp(): void',
      '    {',
      '        $this->cart = new Cart(new Rate(20));',
      '    }',
      '',
      '    public function testTotalsWithTax(): void',
      '    {',
      '        $this->cart->add(100);',
      '        $this->assertSame(120, $this->cart->total());',
      '    }',
      '',
      '    #[Test]',
      '    public function discounts(): void',
      '    {',
      '        $this->assertSame(90, Cart::discount(100, 10));',
      '    }',
      '',
      '    /** @test */',
      '    public function mocksTheRate(): void',
      '    {',
      '        $rate = $this->createMock(Rate::class);',
      '        $cart = new Cart($rate);',
      '        $this->assertSame(0, $cart->total());',
      '    }',
      '',
      "    #[DataProvider('percents')]",
      '    public function testDiscountByPercent(int $percent, int $expected): void',
      '    {',
      '        $this->assertSame($expected, $this->helper($percent));',
      '    }',
      '',
      '    public static function percents(): array',
      '    {',
      '        return [[10, 90], [50, 50]];',
      '    }',
      '',
      '    private function helper(int $percent): int',
      '    {',
      '        return Cart::discount(100, $percent);',
      '    }',
      '}',
    ]),
    'tests/Unit/CheckoutTest.php': source([
      '<?php',
      '',
      'use App\\Cart;',
      'use App\\Tax\\Rate;',
      '',
      'beforeEach(function () {',
      '    $this->cart = new Cart(new Rate(0));',
      '});',
      '',
      "it('starts empty', function () {",
      '    expect($this->cart->total())->toBe(0);',
      '});',
      '',
      "describe('checkout', function () {",
      "    it('adds prices', function () {",
      '        $this->cart->add(5);',
      '        expect($this->cart->total())->toBe(5);',
      '    });',
      '',
      "    test('discounts', function (int $percent, int $expected) {",
      '        expect(Cart::discount(100, $percent))->toBe($expected);',
      '    })->with([[10, 90], [50, 50]]);',
      '});',
    ]),
  };

  it('finds PHPUnit and Pest tests', async () => {
    const { file, method } = await repository(files);
    expect(file('tests/CartTest.php').package).toBe('App\\Tests');
    expect(file('src/Tax/Rate.php').package).toBe('App\\Tax');
    expect(method('tests/CartTest.php::CartTest.testTotalsWithTax')).toMatchObject({ line: 19, end_line: 23, test: { name: 'testTotalsWithTax', suite: ['CartTest'], framework: 'phpunit' } });
    expect(method('tests/CartTest.php::CartTest.discounts').test).toEqual({ name: 'discounts', suite: ['CartTest'], framework: 'phpunit' });
    expect(method('tests/CartTest.php::CartTest.mocksTheRate').test).toEqual({ name: 'mocksTheRate', suite: ['CartTest'], framework: 'phpunit' });
    expect(method('tests/CartTest.php::CartTest.testDiscountByPercent').test).toEqual({ name: 'testDiscountByPercent', suite: ['CartTest'], framework: 'phpunit', parametrized: true });
    for (const name of ['setUp', 'percents', 'helper']) expect(method(`tests/CartTest.php::CartTest.${name}`), name).toMatchObject({ support: true });
    expect(file('tests/Unit/CheckoutTest.php').methods.filter(item => item.test).map(item => [item.id, item.test])).toEqual([
      ['tests/Unit/CheckoutTest.php::starts empty', { name: 'starts empty', suite: [], framework: 'pest' }],
      ['tests/Unit/CheckoutTest.php::checkout > adds prices', { name: 'adds prices', suite: ['checkout'], framework: 'pest' }],
      ['tests/Unit/CheckoutTest.php::checkout > discounts', { name: 'discounts', suite: ['checkout'], framework: 'pest', parametrized: true }],
    ]);
    expect(file('tests/CartTest.php').test).toBe(true);
    expect(file('tests/Unit/CheckoutTest.php').test).toBe(true);
    expect(file('src/Cart.php').test).toBe(false);
  });

  it('links calls through namespaces and use declarations', async () => {
    const { graph } = await repository(files);
    expect(graph.callees('tests/CartTest.php::CartTest.setUp').sort()).toEqual(['src/Cart.php::Cart.__construct', 'src/Tax/Rate.php::Rate.__construct']);
    // The class's setUp runs before each test, and `$this->cart` is the Cart it made.
    expect(graph.callees('tests/CartTest.php::CartTest.testTotalsWithTax').sort()).toEqual(['src/Cart.php::Cart.add', 'src/Cart.php::Cart.total', 'tests/CartTest.php::CartTest.setUp']);
    expect(graph.callees('tests/CartTest.php::CartTest.discounts').sort()).toEqual(['src/Cart.php::Cart.discount', 'tests/CartTest.php::CartTest.setUp']);
    expect(graph.callees('tests/CartTest.php::CartTest.helper')).toEqual(['src/Cart.php::Cart.discount']);
    // A promoted constructor property holds the parameter's type: `$this->rate->on()` is Rate's on, through Cart's own `use`.
    expect(graph.callees('src/Cart.php::Cart.total')).toEqual(['src/Tax/Rate.php::Rate.on']);
    // Pest: a file-level beforeEach runs before every test in the file, and `$this->cart` is what it built.
    expect(graph.callees('tests/Unit/CheckoutTest.php::starts empty').sort()).toEqual(['src/Cart.php::Cart.__construct', 'src/Cart.php::Cart.total', 'src/Tax/Rate.php::Rate.__construct']);
    expect(graph.callees('tests/Unit/CheckoutTest.php::checkout > adds prices').sort()).toEqual(['src/Cart.php::Cart.__construct', 'src/Cart.php::Cart.add', 'src/Cart.php::Cart.total', 'src/Tax/Rate.php::Rate.__construct']);
    expect(graph.callees('tests/Unit/CheckoutTest.php::checkout > discounts')).toContain('src/Cart.php::Cart.discount');
  });

  it('reads createMock', async () => {
    const { file, graph } = await repository(files);
    expect(file('tests/CartTest.php').mocks).toEqual([{ owner: 'tests/CartTest.php::CartTest.mocksTheRate', target: { kind: 'class', name: 'Rate' }, line: 34 }]);
    expect(graph.mocks('tests/CartTest.php::CartTest.mocksTheRate').sort()).toEqual(['src/Tax/Rate.php::Rate.__construct', 'src/Tax/Rate.php::Rate.on']);
    expect(graph.mocks('tests/CartTest.php::CartTest.discounts')).toEqual([]);
  });
});

describe('Lua', () => {
  const files = {
    'src/cart.lua': source([
      'local M = {}',
      'M.__index = M',
      '',
      'function M.new(limit)',
      '  return setmetatable({ limit = limit or 3, prices = {} }, M)',
      'end',
      '',
      'function M:add(price)',
      '  if #self.prices >= self.limit then error("full") end',
      '  self.prices[#self.prices + 1] = price',
      '  return self',
      'end',
      '',
      'function M:total()',
      '  local sum = 0',
      '  for _, price in ipairs(self.prices) do sum = sum + price end',
      '  return sum',
      'end',
      '',
      'function M.discount(total, percent)',
      '  return total - total * percent / 100',
      'end',
      '',
      'return M',
    ]),
    'spec/cart_spec.lua': source([
      'local cart = require("cart")',
      '',
      'describe("cart", function()',
      '  local c',
      '',
      '  before_each(function()',
      '    c = cart.new(2)',
      '  end)',
      '',
      '  it("starts empty", function()',
      '    assert.are.equal(0, c:total())',
      '  end)',
      '',
      '  context("with prices", function()',
      '    it("adds them up", function()',
      '      c:add(2):add(3)',
      '      assert.are.equal(5, c:total())',
      '    end)',
      '',
      '    it("stubs the discount", function()',
      '      stub(cart, "discount")',
      '      cart.discount(100, 10)',
      '      assert.stub(cart.discount).was_called()',
      '    end)',
      '  end)',
      'end)',
    ]),
    'test/test_cart.lua': source([
      'local lu = require("luaunit")',
      'local cart = require("cart")',
      '',
      'TestCart = {}',
      '',
      'function TestCart:setUp()',
      '  self.c = cart.new(2)',
      'end',
      '',
      'function TestCart:testTotal()',
      '  self.c:add(4)',
      '  lu.assertEquals(self.c:total(), 4)',
      'end',
      '',
      'function TestCart.testDiscount()',
      '  lu.assertEquals(cart.discount(100, 10), 90)',
      'end',
      '',
      'function TestCart:helper()',
      '  return 1',
      'end',
      '',
      'function testTopLevel()',
      '  lu.assertEquals(cart.discount(100, 0), 100)',
      'end',
      '',
      'os.exit(lu.LuaUnit.run())',
    ]),
    'examples/no_framework.lua': source([
      'local cart = require("cart")',
      '',
      'function testNothing()',
      '  return cart.discount(1, 1)',
      'end',
    ]),
  };

  it('finds busted and luaunit tests', async () => {
    const { file, method } = await repository(files);
    expect(file('spec/cart_spec.lua').methods.filter(item => item.test).map(item => [item.id, item.line, item.end_line, item.test])).toEqual([
      ['spec/cart_spec.lua::cart > starts empty', 10, 12, { name: 'starts empty', suite: ['cart'], framework: 'busted' }],
      ['spec/cart_spec.lua::cart > with prices > adds them up', 15, 18, { name: 'adds them up', suite: ['cart', 'with prices'], framework: 'busted' }],
      ['spec/cart_spec.lua::cart > with prices > stubs the discount', 20, 24, { name: 'stubs the discount', suite: ['cart', 'with prices'], framework: 'busted' }],
    ]);
    // `function TestCart:testTotal()` is TestCart.testTotal, as `function TestCart.testDiscount()` is TestCart.testDiscount.
    expect(method('test/test_cart.lua::TestCart.testTotal')).toMatchObject({ qualified_name: 'TestCart.testTotal', line: 10, end_line: 13, test: { name: 'testTotal', suite: ['TestCart'], framework: 'luaunit' } });
    expect(method('test/test_cart.lua::TestCart.setUp')).toMatchObject({ qualified_name: 'TestCart.setUp', support: true });
    expect(method('test/test_cart.lua::TestCart.testDiscount').test).toEqual({ name: 'testDiscount', suite: ['TestCart'], framework: 'luaunit' });
    expect(method('test/test_cart.lua::testTopLevel').test).toEqual({ name: 'testTopLevel', suite: [], framework: 'luaunit' });
    expect(method('test/test_cart.lua::TestCart.helper').test).toBeUndefined();
    expect(method('test/test_cart.lua::TestCart.setUp').test).toBeUndefined();
    // A test* function in a file that does not require luaunit is a function.
    expect(method('examples/no_framework.lua::testNothing').test).toBeUndefined();
    expect(file('spec/cart_spec.lua').test).toBe(true);
    expect(file('test/test_cart.lua').test).toBe(true);
    expect(file('src/cart.lua').test).toBe(false);
  });

  it('links calls through a required module', async () => {
    const { graph } = await repository(files);
    // `require("cart")` is src/cart.lua, whose chunk returns M: cart.new is M.new, and what it makes is an M.
    expect(graph.callees('spec/cart_spec.lua::cart > starts empty').sort()).toEqual(['src/cart.lua::M.new', 'src/cart.lua::M.total']);
    expect(graph.callees('spec/cart_spec.lua::cart > with prices > adds them up').sort()).toEqual(['src/cart.lua::M.add', 'src/cart.lua::M.new', 'src/cart.lua::M.total']);
    expect(graph.callees('test/test_cart.lua::TestCart.setUp')).toEqual(['src/cart.lua::M.new']);
    expect(graph.callees('test/test_cart.lua::TestCart.testTotal').sort()).toEqual(['src/cart.lua::M.add', 'src/cart.lua::M.total', 'test/test_cart.lua::TestCart.setUp']);
    expect(graph.callees('test/test_cart.lua::TestCart.testDiscount').sort()).toEqual(['src/cart.lua::M.discount', 'test/test_cart.lua::TestCart.setUp']);
    expect(graph.callees('test/test_cart.lua::testTopLevel')).toEqual(['src/cart.lua::M.discount']);
  });

  it('reads busted stubs', async () => {
    const { file, graph } = await repository(files);
    expect(file('spec/cart_spec.lua').mocks).toEqual([{ owner: 'spec/cart_spec.lua::cart > with prices > stubs the discount', target: { kind: 'member', object: 'cart', name: 'discount' }, line: 21 }]);
    expect(graph.mocks('spec/cart_spec.lua::cart > with prices > stubs the discount')).toEqual(['src/cart.lua::M.discount']);
    expect(graph.mocks('spec/cart_spec.lua::cart > starts empty')).toEqual([]);
  });
});
