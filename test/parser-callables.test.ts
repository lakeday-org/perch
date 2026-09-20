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
    'top', 'assigned', 'module.exports.exported', 'generate', 'sequence', 'asyncWork', 'arrow', 'property', 'outer', 'outer.inner',
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
