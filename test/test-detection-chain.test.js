/**
 * Test detection in Zig and Solidity, and the chain from a test's call to the method under test: the test is found from syntax
 * nodes, its setup is recorded, and `graph.callees` links its calls through the language's own resolution, `@import` in Zig and
 * `import` plus a state variable's declared contract in Solidity.
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

describe('Zig', () => {
  const files = {
    'src/money.zig': source([
      'const std = @import("std");',
      '',
      'pub fn applyPercent(amount: i64, percent: u8) i64 {',
      '    if (percent == 0) return amount;',
      '    return amount - @divTrunc(amount * percent, 100);',
      '}',
      '',
      'pub fn format(cents: i64) i64 {',
      '    return cents;',
      '}',
      '',
      'test "applyPercent takes ten percent off" {',
      '    try std.testing.expectEqual(@as(i64, 180), applyPercent(200, 10));',
      '}',
      '',
      'test format {',
      '    try std.testing.expectEqual(@as(i64, 5), format(5));',
      '}',
      '',
      'test {',
      '    _ = applyPercent(1, 1);',
      '}',
    ]),
    'src/cart.zig': source([
      'const std = @import("std");',
      'const money = @import("money.zig");',
      'const rules = @import("pricing/rules.zig");',
      '',
      'pub const Cart = struct {',
      '    const Self = @This();',
      '    total_cents: i64,',
      '',
      '    pub fn init(total_cents: i64) Self {',
      '        return .{ .total_cents = total_cents };',
      '    }',
      '',
      '    pub fn total(self: *const Self) i64 {',
      '        return self.total_cents;',
      '    }',
      '',
      '    pub fn discounted(self: *const Self, percent: u8) i64 {',
      '        return money.applyPercent(self.total(), rules.clamp(percent));',
      '    }',
      '',
      '    test "total is what was put in" {',
      '        const cart = Cart.init(5);',
      '        try std.testing.expectEqual(@as(i64, 5), cart.total());',
      '    }',
      '};',
      '',
      'test "a cart is discounted through the rules" {',
      '    var cart = Cart.init(200);',
      '    try std.testing.expectEqual(@as(i64, 180), cart.discounted(10));',
      '}',
    ]),
    'src/pricing/rules.zig': source([
      'const money = @import("../money.zig");',
      '',
      'pub fn clamp(percent: u8) u8 {',
      '    return if (percent > 100) 100 else percent;',
      '}',
      '',
      'pub fn discounted(amount: i64, percent: u8) i64 {',
      '    return money.applyPercent(amount, clamp(percent));',
      '}',
    ]),
    'src/root.zig': source([
      'pub const money = @import("money.zig");',
      'pub const Cart = @import("cart.zig").Cart;',
    ]),
    'src/tests.zig': source([
      'const std = @import("std");',
      'const pantry = @import("root.zig");',
      '',
      'test "the package passes its modules on" {',
      '    var cart = pantry.Cart.init(200);',
      '    try std.testing.expectEqual(@as(i64, 180), pantry.money.applyPercent(cart.total(), 10));',
      '}',
    ]),
  };

  it('finds test blocks by their string, their declaration, or their position', async () => {
    const { method, file } = await repository(files);
    expect(method('src/money.zig::test.applyPercent takes ten percent off')).toMatchObject({ line: 12, end_line: 14,
      test: { name: 'applyPercent takes ten percent off', suite: [], framework: 'zig' } });
    // A decltest is named by the declaration it tests, and kept apart from it as the compiler keeps `decltest.format` from `format`.
    expect(method('src/money.zig::decltest.format')).toMatchObject({ line: 16, end_line: 18, test: { name: 'format', suite: [], framework: 'zig' } });
    expect(method('src/money.zig::format').test).toBeUndefined();
    expect(method('src/money.zig::test_0')).toMatchObject({ line: 20, end_line: 22, test: { name: 'test_0', suite: [], framework: 'zig' } });
    // A test inside a struct is in that struct's suite.
    expect(method('src/cart.zig::Cart.test.total is what was put in').test).toEqual({ name: 'total is what was put in', suite: ['Cart'], framework: 'zig' });
    // Tests sit beside the code they test: the file is not test code, and neither are the functions in it.
    expect(file('src/money.zig').test).toBe(false);
    expect(method('src/money.zig::applyPercent').support).toBeUndefined();
    expect(method('src/cart.zig::Cart.total').support).toBeUndefined();
    expect(file('src/tests.zig').test).toBe(true);
  });

  it('links a test to the function under test in its own file and through @import', async () => {
    const { graph } = await repository(files);
    expect(graph.callees('src/money.zig::test.applyPercent takes ten percent off')).toEqual(['src/money.zig::applyPercent']);
    expect(graph.callees('src/money.zig::decltest.format')).toEqual(['src/money.zig::format']);
    expect(graph.callees('src/money.zig::test_0')).toEqual(['src/money.zig::applyPercent']);
    expect(graph.external('src/money.zig::test.applyPercent takes ten percent off')).toEqual([{ name: 'std.testing.expectEqual', line: 13 }]);
    // `cart.discounted(10)` on what `Cart.init` returns, then `money.applyPercent` through the import and `rules.clamp` through a path.
    expect(graph.callees('src/cart.zig::test.a cart is discounted through the rules').sort()).toEqual(['src/cart.zig::Cart.discounted', 'src/cart.zig::Cart.init']);
    expect(graph.callees('src/cart.zig::Cart.discounted').sort()).toEqual(['src/cart.zig::Cart.total', 'src/money.zig::applyPercent', 'src/pricing/rules.zig::clamp']);
    expect(graph.callees('src/cart.zig::Cart.test.total is what was put in').sort()).toEqual(['src/cart.zig::Cart.init', 'src/cart.zig::Cart.total']);
    // `../money.zig` is relative to the importing file, and a bare name in a file is that file's function.
    expect(graph.callees('src/pricing/rules.zig::discounted').sort()).toEqual(['src/money.zig::applyPercent', 'src/pricing/rules.zig::clamp']);
  });

  it('follows a root file that passes modules and names on', async () => {
    const { graph, file } = await repository(files);
    expect(file('src/root.zig').imports).toEqual([{ module: 'money.zig', name: '*', alias: 'money' }, { module: 'cart.zig', name: 'Cart', alias: 'Cart' }]);
    expect(graph.callees('src/tests.zig::test.the package passes its modules on').sort()).toEqual(['src/cart.zig::Cart.init', 'src/cart.zig::Cart.total', 'src/money.zig::applyPercent']);
  });
});

describe('Solidity', () => {
  const files = {
    'src/Pricing.sol': source([
      'pragma solidity ^0.8.24;',
      '',
      'library Pricing {',
      '    function discount(uint256 amount, uint256 percent) internal pure returns (uint256) {',
      '        if (percent >= 100) return 0;',
      '        return amount - (amount * percent) / 100;',
      '    }',
      '}',
    ]),
    'src/Pausable.sol': source([
      'pragma solidity ^0.8.24;',
      '',
      'abstract contract Pausable {',
      '    bool private _paused;',
      '    modifier whenNotPaused() { _requireNotPaused(); _; }',
      '    function paused() public view returns (bool) { return _paused; }',
      '    function _requireNotPaused() internal view { require(!_paused, "paused"); }',
      '    function _pause() internal { _paused = true; }',
      '}',
    ]),
    'src/Cart.sol': source([
      'pragma solidity ^0.8.24;',
      '',
      'import {Pricing} from "./Pricing.sol";',
      'import "./Pausable.sol";',
      '',
      'contract Cart is Pausable {',
      '    uint256 public total;',
      '    constructor(uint256 total_) { total = total_; }',
      '    function add(uint256 amount) external whenNotPaused { total += amount; }',
      '    function discounted(uint256 percent) external view returns (uint256) {',
      '        if (!Pricing.discount(total, percent) == 0) return 0;',
      '        return total - Pricing.discount(total, percent);',
      '    }',
      '    function pause() external { _pause(); }',
      '}',
    ]),
    'test/Cart.t.sol': source([
      'pragma solidity ^0.8.24;',
      '',
      'import {Test} from "forge-std/Test.sol";',
      'import {Cart} from "../src/Cart.sol";',
      'import "../src/Pricing.sol";',
      '',
      'contract CartTest is Test {',
      '    Cart internal cart;',
      '',
      '    function setUp() public { cart = new Cart(200); }',
      '',
      '    function test_Discounted() public view { assertEq(cart.discounted(10), 20); }',
      '    function testFuzz_Discount(uint256 amount) public pure { assertLe(Pricing.discount(amount, 10), amount); }',
      '    function testFail_Over() public { cart.add(1); }',
      '    function test_RevertWhen_Paused() public { cart.pause(); assertTrue(cart.paused()); helper(); }',
      '    function invariant_Total() public view { cart.total(); }',
      '    function helper() internal { cart.add(2); }',
      '    function testNotRun() internal { cart.add(3); }',
      '}',
      '',
      'abstract contract BaseTest is Test {',
      '    function test_abstract() public {}',
      '}',
      '',
      'contract Plain {',
      '    function test_notATest() public {}',
      '}',
    ]),
    'test/Rules.t.sol': source([
      'pragma solidity ^0.8.24;',
      '',
      'import {BaseTest} from "./Cart.t.sol";',
      '',
      'contract RulesTest is BaseTest {',
      '    function test_Inherits() public {}',
      '}',
    ]),
  };

  it('finds forge tests by their contract base and their name prefix', async () => {
    const { method, file } = await repository(files);
    expect(method('test/Cart.t.sol::CartTest.test_Discounted')).toMatchObject({ line: 12, end_line: 12,
      test: { name: 'test_Discounted', suite: ['CartTest'], framework: 'forge' } });
    // A test with parameters is a fuzz test; forge runs it once per input.
    expect(method('test/Cart.t.sol::CartTest.testFuzz_Discount').test).toEqual({ name: 'testFuzz_Discount', suite: ['CartTest'], framework: 'forge', parametrized: true });
    expect(method('test/Cart.t.sol::CartTest.testFail_Over').test).toEqual({ name: 'testFail_Over', suite: ['CartTest'], framework: 'forge' });
    expect(method('test/Cart.t.sol::CartTest.invariant_Total').test).toEqual({ name: 'invariant_Total', suite: ['CartTest'], framework: 'forge' });
    // forge calls only public and external functions; an abstract contract is not deployed; a contract that is no Test runs nothing.
    expect(method('test/Cart.t.sol::CartTest.testNotRun').test).toBeUndefined();
    expect(method('test/Cart.t.sol::CartTest.helper').test).toBeUndefined();
    expect(method('test/Cart.t.sol::BaseTest.test_abstract').test).toBeUndefined();
    expect(method('test/Cart.t.sol::Plain.test_notATest').test).toBeUndefined();
    // A project's own base that ends in Test is a test base.
    expect(method('test/Rules.t.sol::RulesTest.test_Inherits').test).toEqual({ name: 'test_Inherits', suite: ['RulesTest'], framework: 'forge' });
    expect(file('test/Cart.t.sol').test).toBe(true);
    expect(method('src/Cart.sol::Cart.constructor')).toMatchObject({ name: 'constructor', line: 8 });
  });

  it('runs setUp before each test and links through the state variable\'s declared contract', async () => {
    const { graph } = await repository(files);
    // setUp is a call the test makes, and `new Cart(200)` in it runs Cart's constructor.
    expect(graph.callees('test/Cart.t.sol::CartTest.test_Discounted').sort()).toEqual(['src/Cart.sol::Cart.discounted', 'test/Cart.t.sol::CartTest.setUp']);
    expect(graph.callees('test/Cart.t.sol::CartTest.setUp')).toEqual(['src/Cart.sol::Cart.constructor']);
    // `cart` is declared `Cart`, so `cart.add` is Cart.add, in the file `import {Cart}` names; `cart.paused` is inherited from Pausable.
    expect(graph.callees('test/Cart.t.sol::CartTest.helper')).toEqual(['src/Cart.sol::Cart.add']);
    expect(graph.callees('test/Cart.t.sol::CartTest.test_RevertWhen_Paused').sort()).toEqual(['src/Cart.sol::Cart.pause', 'src/Pausable.sol::Pausable.paused', 'test/Cart.t.sol::CartTest.helper', 'test/Cart.t.sol::CartTest.setUp']);
    // A library through a plain `import "../src/Pricing.sol";`.
    expect(graph.callees('test/Cart.t.sol::CartTest.testFuzz_Discount').sort()).toEqual(['src/Pricing.sol::Pricing.discount', 'test/Cart.t.sol::CartTest.setUp']);
    expect(graph.external('test/Cart.t.sol::CartTest.test_Discounted')).toEqual([{ name: 'assertEq', line: 12 }]);
  });

  it('links a contract\'s own calls: bare names, inherited members, modifiers and the library the grammar misparses', async () => {
    const { graph } = await repository(files);
    // tree-sitter-solidity reads `!Pricing.discount(...)` as `(!Pricing).discount(...)`; the member belongs to Pricing.
    expect(graph.callees('src/Cart.sol::Cart.discounted')).toEqual(['src/Pricing.sol::Pricing.discount']);
    expect(graph.callees('src/Cart.sol::Cart.pause')).toEqual(['src/Pausable.sol::Pausable._pause']);
    expect(graph.callees('src/Cart.sol::Cart.add')).toEqual(['src/Pausable.sol::Pausable.whenNotPaused']);
    expect(graph.callees('src/Pausable.sol::Pausable.whenNotPaused')).toEqual(['src/Pausable.sol::Pausable._requireNotPaused']);
  });
});
