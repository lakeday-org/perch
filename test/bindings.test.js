import { describe, expect, it } from 'vitest';
import { analyzeFiles, createSourceAnalyzer } from '../src/analysis.js';
import { buildGraph } from '../src/graph.js';

/** The graph of these files, parsed as a scan parses them. */
async function graphOf(files) {
  const scan = await analyzeFiles(Object.keys(files).map(path => ({ type: 'blob', path })), { analyzer: createSourceAnalyzer(), readSource: file => files[file.path] });
  return buildGraph(scan.files);
}

describe('a method called on what a variable holds', () => {
  it('finds it through new, a factory and a field in TypeScript', async () => {
    const graph = await graphOf({
      'src/ledger.ts': 'export class Ledger {\n  constructor() {\n    this.total = 0;\n  }\n  post(amount: number) {\n    return amount;\n  }\n}\nexport function openLedger() {\n  return new Ledger();\n}\n',
      'src/store.ts': 'export class Store {\n  put(key: string) {\n    return key;\n  }\n}\n',
      'src/service.ts': "import { Store } from './store';\nexport class Service {\n  constructor() {\n    this.store = new Store();\n  }\n  save(key: string) {\n    return this.store.put(key);\n  }\n}\n",
      'test/ledger.test.ts': [
        "import { Ledger, openLedger } from '../src/ledger';",
        "test('posts', () => {",
        '  const ledger = new Ledger();',
        '  ledger.post(1);',
        '});',
        "test('posts through a factory', () => {",
        '  const opened = openLedger();',
        '  opened.post(2);',
        '});',
      ].join('\n'),
    });
    expect(graph.callees('test/ledger.test.ts::posts').sort()).toEqual(['src/ledger.ts::Ledger.constructor', 'src/ledger.ts::Ledger.post']);
    expect(graph.callees('test/ledger.test.ts::posts through a factory').sort()).toEqual(['src/ledger.ts::Ledger.post', 'src/ledger.ts::openLedger']);
    expect(graph.callees('src/ledger.ts::openLedger')).toEqual(['src/ledger.ts::Ledger.constructor']);
    expect(graph.callees('src/service.ts::Service.save')).toEqual(['src/store.ts::Store.put']);
  });

  it('finds it through a class called as a function in Python', async () => {
    const graph = await graphOf({
      'shop/__init__.py': '',
      'shop/ledger.py': 'class Ledger:\n    def __init__(self):\n        self.lines = []\n\n    def post(self, amount):\n        self.lines.append(amount)\n',
      'tests/test_ledger.py': 'from shop.ledger import Ledger\n\ndef test_posts():\n    ledger = Ledger()\n    ledger.post(1)\n',
    });
    expect(graph.callees('tests/test_ledger.py::test_posts').sort()).toEqual(['shop/ledger.py::Ledger.__init__', 'shop/ledger.py::Ledger.post']);
  });

  it('finds it through a declared type in Java', async () => {
    const graph = await graphOf({
      'src/main/java/shop/Ledger.java': 'package shop;\npublic class Ledger {\n  private int total;\n  public Ledger() { total = 0; }\n  public int post(int amount) { return amount; }\n}\n',
      'src/test/java/shop/LedgerTest.java': 'package shop;\nimport org.junit.jupiter.api.Test;\nclass LedgerTest {\n  @Test\n  void posts() {\n    Ledger ledger = new Ledger();\n    ledger.post(1);\n  }\n}\n',
    });
    expect(graph.callees('src/test/java/shop/LedgerTest.java::LedgerTest.posts').sort()).toEqual(['src/main/java/shop/Ledger.java::Ledger.Ledger', 'src/main/java/shop/Ledger.java::Ledger.post']);
  });

  it('finds it through a constructor function in Rust', async () => {
    const graph = await graphOf({
      'src/lib.rs': 'pub mod ledger;\n',
      'src/ledger.rs': 'pub struct Ledger { lines: Vec<i64> }\nimpl Ledger {\n    pub fn new() -> Self {\n        Ledger { lines: vec![] }\n    }\n    pub fn post(&mut self, amount: i64) {\n        self.lines.push(amount);\n    }\n}\n',
      'tests/ledger.rs': 'use crate::ledger::Ledger;\n#[test]\nfn posts() {\n    let mut ledger = Ledger::new();\n    ledger.post(1);\n}\n',
    });
    expect(graph.callees('tests/ledger.rs::posts').sort()).toEqual(['src/ledger.rs::Ledger.new', 'src/ledger.rs::Ledger.post']);
  });

  it('finds it through a declared object and a pointer in C++', async () => {
    const graph = await graphOf({
      'src/ledger.cpp': '#include "ledger.hpp"\nint Ledger::post(int amount) {\n  return amount;\n}\n',
      'test/ledger_test.cpp': '#include "ledger.hpp"\nvoid posts() {\n  Ledger ledger;\n  ledger.post(1);\n  Ledger* other = new Ledger();\n  other->post(2);\n}\n',
    });
    expect(graph.callees('test/ledger_test.cpp::posts')).toEqual(['src/ledger.cpp::Ledger.post']);
  });

  it("finds a method through self in a class with a constructor, and does not link a local name to a method", async () => {
    const graph = await graphOf({
      'shop/ledger.py': [
        'class Ledger:',
        '    def __init__(self):',
        '        self.accounts = {}',
        '',
        '    def account(self, name):',
        '        return self.accounts[name]',
        '',
        '    def open_account(self, name):',
        '        account = self._new(name)',
        '        return account',
        '',
        '    def _new(self, name):',
        '        return {}',
      ].join('\n'),
    });
    expect(graph.callees('shop/ledger.py::Ledger.open_account')).toEqual(['shop/ledger.py::Ledger._new']);
  });

  it("does not take one function's local, or one class's field, for another's", async () => {
    const graph = await graphOf({
      'src/shapes.py': 'class Circle:\n    def area(self):\n        return 3\n\nclass Square:\n    def area(self):\n        return 4\n',
      'tests/test_shapes.py': [
        'from src.shapes import Circle, Square',
        'class CircleTest:',
        '    def setUp(self):',
        '        self.shape = Circle()',
        '    def test_area(self):',
        '        self.shape.area()',
        'class SquareTest:',
        '    def setUp(self):',
        '        self.shape = Square()',
        '    def test_area(self):',
        '        self.shape.area()',
        'def test_one():',
        '    s = Circle()',
        'def test_two():',
        '    s.area()',
      ].join('\n'),
    });
    expect(graph.callees('tests/test_shapes.py::SquareTest.test_area')).toEqual(['src/shapes.py::Square.area']);
    expect(graph.callees('tests/test_shapes.py::CircleTest.test_area')).toEqual(['src/shapes.py::Circle.area']);
    expect(graph.callees('tests/test_shapes.py::test_two')).toEqual([]);
  });

  it('follows a method called on a call, on a line of its own, and on a variant', async () => {
    const graph = await graphOf({
      'src/lib.rs': 'pub mod thing;\n',
      'src/thing.rs': [
        'pub struct Thing { n: i64 }',
        'pub enum Color { Red }',
        'impl Thing {',
        '    pub fn new() -> Self {',
        '        Thing { n: 0 }',
        '    }',
        '    pub fn get(&self) -> i64 {',
        '        self.n',
        '    }',
        '}',
        'impl Color {',
        '    pub fn code(&self) -> u8 {',
        '        1',
        '    }',
        '}',
      ].join('\n'),
      'tests/thing.rs': [
        'use crate::thing::{Color, Thing};',
        '#[test]',
        'fn chained() {',
        '    Thing::new().get();',
        '}',
        '#[test]',
        'fn broken_across_lines() {',
        '    let t = Thing::new();',
        '    t',
        '        .get();',
        '}',
        '#[test]',
        'fn variant() {',
        '    Color::Red.code();',
        '}',
      ].join('\n'),
      'shop/entry.py': 'class Entry:\n    def __init__(self, day):\n        self.day = day\n\n    def debit(self, amount):\n        return amount\n',
      'tests/test_entry.py': 'from shop.entry import Entry\n\ndef test_debit():\n    Entry(1).debit(2)\n',
    });
    expect(graph.callees('tests/thing.rs::chained').sort()).toEqual(['src/thing.rs::Thing.get', 'src/thing.rs::Thing.new']);
    expect(graph.callees('tests/thing.rs::broken_across_lines').sort()).toEqual(['src/thing.rs::Thing.get', 'src/thing.rs::Thing.new']);
    expect(graph.callees('tests/thing.rs::variant')).toEqual(['src/thing.rs::Color.code']);
    expect(graph.callees('tests/test_entry.py::test_debit').sort()).toEqual(['shop/entry.py::Entry.__init__', 'shop/entry.py::Entry.debit']);
  });

  it('reads declared parameter and return types, through wrappers, fluent methods and returned locals', async () => {
    const graph = await graphOf({
      'src/money.ts': [
        'export class Money {',
        '  add(other: Money): Money {',
        '    return this;',
        '  }',
        '  toDecimal(): string {',
        "    return '';",
        '  }',
        '}',
        'export function parseMoney(text: string): Money {',
        '  const money = build(text);',
        '  return money;',
        '}',
        'export async function convert(amount: Money): Promise<Money> {',
        '  return amount;',
        '}',
        'export function formatMoney(money: Money) {',
        '  return money.toDecimal();',
        '}',
        'export function sum(items: readonly Money[]) {',
        '  const total = items[0];',
        '  return total.add(items[1]).toDecimal();',
        '}',
      ].join('\n'),
      'test/money.test.ts': [
        "import { convert, parseMoney } from '../src/money';",
        "test('parses', async () => {",
        "  const m = parseMoney('1');",
        '  m.toDecimal();',
        '  const c = await convert(m);',
        '  c.add(m);',
        '});',
      ].join('\n'),
      'src/thing.rs': [
        'pub struct Thing { n: i64 }',
        'impl Thing {',
        '    pub fn literal(n: i64) -> Option<Thing> {',
        '        Some(Thing { n })',
        '    }',
        '    pub fn get(&self) -> i64 {',
        '        self.n',
        '    }',
        '}',
        'pub fn tail() -> Thing {',
        '    let t = Thing { n: 1 };',
        '    t',
        '}',
        'pub fn takes(thing: &Thing) -> i64 {',
        '    thing.get()',
        '}',
      ].join('\n'),
      'src/lib.rs': 'pub mod thing;\n',
      'tests/thing.rs': 'use crate::thing::{tail, Thing};\n#[test]\nfn reads() {\n    let a = tail();\n    a.get();\n    let b = Thing::literal(1).unwrap();\n    b.get();\n}\n',
      'shop/entry.py': 'class Entry:\n    def validate(self):\n        return self\n\n    def amount(self):\n        return 1\n\ndef post(entry: Entry) -> Entry:\n    return entry.validate()\n',
      'tests/test_entry.py': 'from shop.entry import post, Entry\n\ndef test_post():\n    e = post(Entry())\n    e.amount()\n',
    });
    expect(graph.callees('test/money.test.ts::parses').sort()).toEqual(['src/money.ts::Money.add', 'src/money.ts::Money.toDecimal', 'src/money.ts::convert', 'src/money.ts::parseMoney']);
    expect(graph.callees('src/money.ts::formatMoney')).toEqual(['src/money.ts::Money.toDecimal']);
    expect(graph.callees('src/money.ts::sum').sort()).toEqual(['src/money.ts::Money.add', 'src/money.ts::Money.toDecimal']);
    expect(graph.callees('tests/thing.rs::reads').sort()).toEqual(['src/thing.rs::Thing.get', 'src/thing.rs::Thing.literal', 'src/thing.rs::tail']);
    expect(graph.callees('src/thing.rs::takes')).toEqual(['src/thing.rs::Thing.get']);
    expect(graph.callees('shop/entry.py::post')).toEqual(['shop/entry.py::Entry.validate']);
    expect(graph.callees('tests/test_entry.py::test_post').sort()).toEqual(['shop/entry.py::Entry.amount', 'shop/entry.py::post']);
  });

  it('reads a Java record as a class, with its compact constructor and static factories', async () => {
    const graph = await graphOf({
      'src/main/java/shop/Money.java': [
        'package shop;',
        'public record Money(long minor, String currency) {',
        '  public Money {',
        '    if (minor < 0) throw new IllegalArgumentException();',
        '  }',
        '  public static Money of(long minor) { return new Money(minor, "USD"); }',
        '  public Money plus(Money other) { return new Money(minor + other.minor, currency); }',
        '}',
      ].join('\n'),
      'src/test/java/shop/MoneyTest.java': 'package shop;\nimport org.junit.jupiter.api.Test;\nclass MoneyTest {\n  @Test\n  void adds() {\n    Money.of(1).plus(Money.of(2));\n  }\n}\n',
    });
    expect([...graph.nodes.keys()].filter(id => id.startsWith('src/main')).sort()).toEqual(['src/main/java/shop/Money.java::Money.Money', 'src/main/java/shop/Money.java::Money.of', 'src/main/java/shop/Money.java::Money.plus']);
    expect(graph.callees('src/test/java/shop/MoneyTest.java::MoneyTest.adds').sort()).toEqual(['src/main/java/shop/Money.java::Money.of', 'src/main/java/shop/Money.java::Money.plus']);
  });

  it('follows a Java builder of any length, a method reference, an enum constant and setup the framework runs', async () => {
    const graph = await graphOf({
      'src/main/java/shop/Entry.java': [
        'package shop;',
        'public final class Entry {',
        '  public static Builder on(int day) { return new Builder(); }',
        '  public static final class Builder {',
        '    public Builder debit(int a) { return this; }',
        '    public Builder credit(int a) { return this; }',
        '    public Entry build() { return new Entry(); }',
        '  }',
        '}',
      ].join('\n'),
      'src/main/java/shop/Status.java': 'package shop;\npublic enum Status {\n  PAID;\n  public boolean isFinal() { return true; }\n}\n',
      'src/test/java/shop/EntryTest.java': [
        'package shop;',
        'import org.junit.jupiter.api.BeforeEach;',
        'import org.junit.jupiter.api.Test;',
        'class EntryTest {',
        '  private Entry.Builder builder;',
        '  @BeforeEach',
        '  void start() { builder = Entry.on(1); }',
        '  @Test',
        '  void chains() { Entry.on(1).debit(1).credit(1).credit(2).build(); }',
        '  @Test',
        '  void refers() { assertThrows(IllegalStateException.class, builder::build); }',
        '  @Test',
        '  void constants() { Status.PAID.isFinal(); }',
        '}',
      ].join('\n'),
    });
    const entry = 'src/main/java/shop/Entry.java::Entry';
    expect(graph.callees('src/test/java/shop/EntryTest.java::EntryTest.chains')).toEqual(expect.arrayContaining([`${entry}.Builder.credit`, `${entry}.Builder.build`]));
    expect(graph.callees('src/test/java/shop/EntryTest.java::EntryTest.refers')).toEqual(expect.arrayContaining(['src/test/java/shop/EntryTest.java::EntryTest.start', `${entry}.Builder.build`]));
    expect(graph.callees('src/test/java/shop/EntryTest.java::EntryTest.constants')).toContain('src/main/java/shop/Status.java::Status.isFinal');
  });

  it('follows calls in a Rust macro, through what each call returns', async () => {
    const graph = await graphOf({
      'src/lib.rs': [
        'pub struct Version;',
        'impl Version {',
        '    pub fn parse(s: &str) -> Result<Version, String> { Ok(Version) }',
        '    pub fn bump(&self) -> Self { Version }',
        '    pub fn minor(&self) -> u32 { 0 }',
        '}',
        '#[cfg(test)]',
        'mod tests {',
        '    use super::*;',
        '    #[test]',
        '    fn bumps() {',
        '        assert_eq!(Version::parse("1.0.0").map_err(|e| e).unwrap().bump().minor(), 1);',
        '    }',
        '}',
      ].join('\n'),
    });
    expect(graph.callees('src/lib.rs::bumps').sort()).toEqual(['src/lib.rs::Version.bump', 'src/lib.rs::Version.minor', 'src/lib.rs::Version.parse']);
  });

  it('constructs C++ classes named through using, an alias and a declaration the grammar reads as a function', async () => {
    const graph = await graphOf({
      'include/shop/cart.hpp': 'namespace shop {\nclass Cart {\n public:\n  Cart(int size, int limit);\n  int total() const;\n};\n}\n',
      'src/cart.cpp': '#include "shop/cart.hpp"\nnamespace shop {\nCart::Cart(int size, int limit) {}\nint Cart::total() const { return 0; }\n}\n',
      'tests/cart_test.cpp': [
        '#include "shop/cart.hpp"',
        'using shop::Cart;',
        'using Small = Cart;',
        'int size = 1, limit = 2;',
        'void totals() {',
        '  Cart cart(size, limit);',
        '  cart.total();',
        '}',
        'void aliased() {',
        '  Small(1, 2);',
        '}',
      ].join('\n'),
    });
    expect(graph.callees('tests/cart_test.cpp::totals').sort()).toEqual(['src/cart.cpp::shop.Cart.Cart', 'src/cart.cpp::shop.Cart.total']);
    expect(graph.callees('tests/cart_test.cpp::aliased')).toEqual(['src/cart.cpp::shop.Cart.Cart']);
  });

  it('follows CommonJS modules passed on under a name, and a module taken apart after it is required', async () => {
    const graph = await graphOf({
      'index.js': "const createApp = require('./lib/app');\nexports = module.exports = createApp;\nexports.request = require('./lib/request');\n",
      'lib/app.js': 'class App {\n  constructor() {\n    this.ready = true;\n  }\n}\nfunction createApp() {\n  return new App();\n}\nmodule.exports = createApp;\nmodule.exports.App = App;\n',
      'lib/request.js': 'function accepts(req) {\n  return req;\n}\nexports.etag = function etag(body) {\n  return body;\n};\nmodule.exports.accepts = accepts;\n',
      'test/app.spec.js': [
        "const app = require('..');",
        "const { request } = app;",
        "it('builds', () => {",
        '  app();',
        '  request.accepts({});',
        '});',
      ].join('\n'),
    });
    expect(graph.callees('test/app.spec.js::builds').sort()).toEqual(['lib/app.js::createApp', 'lib/request.js::accepts']);
    expect(graph.nodes.has('lib/request.js::exports.etag')).toBe(true);
  });

  it('finds a class through the module a type names, and not by its name alone', async () => {
    const graph = await graphOf({
      'shop/__init__.py': 'from .core import Context\n',
      'shop/core.py': 'class Context:\n    def fail(self):\n        return 1\n',
      'tests/test_core.py': 'import shop\n\ndef test_fails(ctx: shop.Context):\n    ctx.fail()\n',
      // Two classes called Context, and a test that imports neither: which one it means is not for perch to guess.
      'other/core.py': 'class Context:\n    def fail(self):\n        return 2\n',
      'tests/test_guess.py': 'def test_guess(ctx: "Context"):\n    ctx.fail()\n',
    });
    expect(graph.callees('tests/test_core.py::test_fails')).toEqual(['shop/core.py::Context.fail']);
    expect(graph.callees('tests/test_guess.py::test_guess')).toEqual([]);
  });

  it('picks the Kotlin extension declared on the receiver', async () => {
    const graph = await graphOf({
      'src/main/kotlin/okio/Okio.kt': 'package okio\n\nfun Source.buffer(): Int = 1\n\nfun Sink.buffer(): Int = 2\n',
      'src/main/kotlin/okio/Source.kt': 'package okio\n\ninterface Source\n',
      'src/test/kotlin/okio/SourceTest.kt': 'package okio\n\nimport org.junit.Test\n\nclass SourceTest {\n  @Test\n  fun buffers() {\n    val source: Source = make()\n    source.buffer()\n  }\n}\n',
    });
    expect(graph.callees('src/test/kotlin/okio/SourceTest.kt::SourceTest.buffers')).toContain('src/main/kotlin/okio/Okio.kt::Source.buffer');
  });
});
