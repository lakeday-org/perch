import { expect, it } from 'vitest';
import { createAnalyzer } from '../src/treesitter/index';

it.each(['javascript', 'typescript'])('finds expressions, generators, exports and nested callables in %s', async language => {
  const source = [
    'function top() { return helper(); }',
    'const assigned = function() { return helper(); };',
    'module.exports.exported = function() { return helper(); };',
    'function* generate() { yield helper(); }',
    'const sequence = function*() { yield helper(); };',
    'const asyncWork = async function() { return helper(); };',
    'const arrow = () => helper();',
    'const object = { property: function() { return helper(); } };',
    'function outer() { const inner = function() { return helper(); }; return inner(); }',
  ].join('\n');
  const result = await createAnalyzer().analyzeSource(source, language);
  expect(result.parser_status).toBe('parsed');
  expect(result.declarations.map(item => item.qualified_name).sort()).toEqual([
    'top', 'assigned', 'module.exports.exported', 'generate', 'sequence', 'asyncWork', 'arrow', 'object.property', 'outer', 'outer.inner',
  ].sort());
  for (const declaration of result.declarations) {
    expect(declaration.location.start.byte).toBeLessThan(declaration.location.end.byte);
    expect(result.references.some(ref => ref.kind === 'call' && ref.source === declaration.id)).toBe(true);
  }
  expect(result.declarations.find(item => item.name === 'inner')).toMatchObject({ parent_function: 'outer', function_depth: 1, line: 9 });
});

it.each([
  ['java', 'class Example {\n  Example() { helper(); }\n  int compute() { return helper(); }\n}', 'compute'],
  ['csharp', 'class Example {\n  public Example() { Helper(); }\n  int Compute() { return Helper(); }\n}', 'Compute'],
])('includes constructors and their calls in %s', async (language, source, method) => {
  const result = await createAnalyzer().analyzeSource(source, language);
  expect(result.parser_status).toBe('parsed');
  expect(result.declarations.map(item => item.qualified_name).sort()).toEqual(['Example.Example', `Example.${method}`].sort());
  const constructor = result.declarations.find(item => item.name === 'Example')!;
  expect(constructor).toMatchObject({ line: 2, end_line: 2 });
  expect(result.references.some(ref => ref.kind === 'call' && ref.source === constructor.id)).toBe(true);
});

it('finds Kotlin class and object members under their declared scopes', async () => {
  const result = await createAnalyzer().analyzeSource('class K {\n fun compute(): Int { return helper() }\n}\nobject O {\n fun o() = helper()\n}', 'kotlin');
  expect(result.parser_status).toBe('parsed');
  expect(result.declarations.map(item => item.qualified_name)).toEqual(['K.compute', 'O.o']);
  expect(result.declarations.map(item => item.line)).toEqual([2, 5]);
  for (const declaration of result.declarations) expect(result.references.some(ref => ref.kind === 'call' && ref.source === declaration.id)).toBe(true);
});

it('keeps a same-line Kotlin object body as a named scope rather than a callable lambda', async () => {
  const result = await createAnalyzer().analyzeSource('object O { fun o() = helper() }', 'kotlin');
  expect(result.parser_status).toBe('parsed');
  expect(result.declarations.map(item => item.qualified_name)).toEqual(['O.o']);
});

it.each(['class K { fun compute() }', 'class K { fun compute() { helper() } }'])('accepts the optional separator after a Kotlin class member: %s', async source => {
  const result = await createAnalyzer().analyzeSource(source, 'kotlin');
  expect(result.parser_status).toBe('parsed');
  expect(result.declarations.map(item => item.qualified_name)).toEqual(['K.compute']);
});

it.each(['class K { fun compute( { helper() } }', 'class K { fun compute() { val x = } }'])('keeps real Kotlin syntax errors visible: %s', async source => {
  expect((await createAnalyzer().analyzeSource(source, 'kotlin')).parser_status).toBe('parse-error');
});

it('finds Groovy typed and def methods with class scope without mistaking calls for declarations', async () => {
  const source = 'class Box {\n int size() { return helper() }\n def other(x) { return size() }\n}\ndef top(x) { return x }\nitems.each { item -> println(item) }\n';
  const result = await createAnalyzer().analyzeSource(source, 'groovy');
  expect(result.parser_status).toBe('parsed');
  expect(result.declarations.map(item => item.qualified_name)).toEqual(['Box.size', 'Box.other', 'top']);
  expect(result.declarations.map(item => item.line)).toEqual([2, 3, 5]);
  const size = result.declarations.find(item => item.name === 'size')!;
  expect(result.references).toContainEqual(expect.objectContaining({ kind: 'call', reference: 'helper', source: size.id }));
});

it.each([
  ['go', 'package main\nfunc (s *Stack[T]) Push(v T) {}\nfunc (q *Queue[T]) Push(v T) {}\nfunc (m Map[K, V]) Get(k K) V { var v V; return v }\nfunc (s Plain) Len() int { return 0 }\n',
    ['Stack.Push', 'Queue.Push', 'Map.Get', 'Plain.Len']],
  ['kotlin', 'fun <T> List<T>.second(): T = this[1]\nfun Map<String, Int>.total(): Int = 0\nfun String.shout(): String = this\n', ['List.second', 'Map.total', 'String.shout']],
  ['rust', 'impl<T> Stack<T> {\n    fn push(&mut self) {}\n}\nimpl<T: Clone> Clone for Stack<T> {\n    fn clone(&self) -> Self { todo!() }\n}\nimpl Plain {\n    fn len(&self) -> usize { 0 }\n}\n',
    ['Stack.push', 'Stack.clone', 'Plain.len']],
])('names a method of a generic %s type after the type, not its type arguments', async (language, source, names) => {
  const result = await createAnalyzer().analyzeSource(source, language);
  expect(result.parser_status).toBe('parsed');
  expect(result.declarations.map(item => item.qualified_name)).toEqual(names);
});

it('reads a Groovy call with a trailing closure as a call, not a declaration', async () => {
  const source = [
    "def sourcesJar = tasks.register('sourcesJar', Jar) { from sourceSets.main.allSource }",
    'def build() {',
    "    def result = retry(3) { sh 'make' }",
    '    println qux(1) { it }',
    '}',
    "private List<String> names(int a, String b = 'x') { return [] }",
    'static main(args) { build() }',
    'java.util.List all() { [] }',
  ].join('\n');
  const result = await createAnalyzer().analyzeSource(source, 'groovy');
  expect(result.parser_status).toBe('parsed');
  expect(result.declarations.map(item => item.qualified_name)).toEqual(['build', 'names', 'main', 'all']);
  const build = result.declarations.find(item => item.name === 'build')!;
  const calls = result.references.filter(ref => ref.kind === 'call');
  expect(calls).toContainEqual(expect.objectContaining({ reference: 'register', line: 1 }));
  expect(calls).toContainEqual(expect.objectContaining({ reference: 'retry', source: build.id }));
  expect(calls).toContainEqual(expect.objectContaining({ reference: 'qux', source: build.id }));
});

it('reads a Python lambda as one declaration, not also its lambda keyword', async () => {
  const source = 'def test_it():\n    patches = {"run": lambda prompt: helper(prompt)}\n    other = lambda: helper(1)\n';
  const result = await createAnalyzer().analyzeSource(source, 'python');
  expect(result.parser_status).toBe('parsed');
  expect(result.declarations.map(item => item.syntax_kind)).toEqual(['function_definition', 'lambda', 'lambda']);
  for (const declaration of result.declarations) expect(declaration.parent_id).not.toBe(declaration.id);
});

it('records CommonJS require as an import, with the names it binds', async () => {
  const source = "const utils = require('./utils');\nconst { parse, format: fmt } = require('../lib/format');\nrequire('./setup');\nconst dynamic = require(name);\n";
  const result = await createAnalyzer().analyzeSource(source, 'javascript');
  expect(result.references.filter(item => item.kind === 'import').map(item => [item.module, item.imported_name, item.alias])).toEqual([
    ['./utils', '*', 'utils'], ['../lib/format', 'parse', 'parse'], ['../lib/format', 'format', 'fmt'], ['./setup', '*', null],
  ]);
});

it.each([
  ['export default function combineURLs(a, b) {\n  return a + b;\n}\n', 'combineURLs'],
  ['function helper() {\n  return 1;\n}\nexport default helper;\n', 'helper'],
  ['function utils() {\n  return 1;\n}\nmodule.exports = utils;\n', 'utils'],
  ['export default () => 1;\n', null],
])('names the default export of %j', async (source, name) => {
  expect((await createAnalyzer().analyzeSource(source, 'javascript')).default_export).toBe(name);
});

it('marks a Kotlin extension function, and names a call on a receiver the tree cannot name', async () => {
  const lib = await createAnalyzer().analyzeSource('package okio\n\nfun String.utf8Size(): Long {\n  return 1L\n}\n\nclass Buffer {\n  fun size(): Long = 0L\n}\n', 'kotlin');
  expect(lib.declarations.map(item => [item.qualified_name, item.extension ?? false])).toEqual([['String.utf8Size', true], ['Buffer.size', false]]);
  const test = await createAnalyzer().analyzeSource('fun check() {\n  val s = "abc"\n  s.utf8Size()\n  "x".utf8Size()\n}\n', 'kotlin');
  expect(test.references.filter(item => item.kind === 'call').map(item => item.name)).toEqual(['s.utf8Size', '$receiver.utf8Size']);
});

it('answers a language it has no grammar for as unsupported, with nothing read', async () => {
  const result = await createAnalyzer().analyzeSource('x\n', 'no-such-language');
  expect(result).toMatchObject({ parser_status: 'unsupported', declarations: [], top_level: [], references: [], package: null, mocks: [] });
  expect(result.diagnostics).toEqual([{ kind: 'unsupported', message: 'No language-pack grammar is registered for no-such-language', location: null }]);
});
