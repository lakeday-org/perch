import { describe, expect, it } from 'vitest';
import { adviceFor, methodAdvice } from '../src/coverage-advice.js';

const mutant = (kind, from, to, line = 12) => ({ kind, from, to, line });

describe('what test to add for a survived mutant', () => {
  it('names the edit a test has to tell apart, by its kind', () => {
    expect(adviceFor(mutant('body', '{ save(order); }', '{}'))).toBe('Add a test that fails when the method does nothing.');
    expect(adviceFor(mutant('removal', 'save(order);', ''))).toBe('Add a test that fails when `save(order);` is not called.');
    expect(adviceFor(mutant('block', '{ total += 1; }', '{}'))).toBe('Add a test that fails when the block at line 12 is skipped.');
    expect(adviceFor(mutant('condition', 'percent > 100', 'true'))).toBe('Add a test in which the condition at line 12 is false, and assert on what follows.');
    expect(adviceFor(mutant('condition', 'percent > 100', 'false'))).toBe('Add a test in which the condition at line 12 is true, and assert on what follows.');
    expect(adviceFor(mutant('boundary', '>=', '>'))).toBe('Add a test at the boundary of `>=` on line 12, where `>=` and `>` give different results.');
    expect(adviceFor(mutant('logic', '&&', '||'))).toBe('Add a test in which only one side of `&&` on line 12 holds.');
    expect(adviceFor(mutant('string', "'An item is out of stock'", "''"))).toBe("Add a test that asserts on the text `'An item is out of stock'` at line 12.");
    expect(adviceFor(mutant('number', '100', '101'))).toBe('Add a test that asserts on the value `100` at line 12.');
    expect(adviceFor(mutant('return', 'total', '0'))).toBe('Add a test that asserts on what line 12 returns.');
    expect(adviceFor(mutant('arithmetic', '*', '/'))).toBe('Add a test that asserts on the arithmetic at line 12, where `*` can become `/`.');
    expect(adviceFor(mutant('update', '+=', '-='))).toBe('Add a test that asserts on the arithmetic at line 12, where `+=` can become `-=`.');
    expect(adviceFor(mutant('not', '!ready', 'ready'))).toBe('Add a test that asserts on the result of line 12, where `!ready` can become `ready` unnoticed.');
    expect(adviceFor(mutant('boolean', 'true', 'false'))).toBe('Add a test that asserts on the result of line 12, where `true` can become `false` unnoticed.');
  });

  it('names a method swapped, dropped, a literal emptied, a chain, an arrow function and a pattern', () => {
    expect(adviceFor(mutant('method', 'startsWith', 'endsWith'))).toBe('Add a test for which `startsWith` and `endsWith` give different results on line 12.');
    expect(adviceFor(mutant('method', 'items.filter(x => x.ok)', 'items'))).toBe('Add a test that fails when `filter` is not called on line 12.');
    expect(adviceFor(mutant('method', 'sorted(items)', 'items'))).toBe('Add a test that fails when `sorted` is not called on line 12.');
    expect(adviceFor(mutant('method', 'strings.TrimSpace(a)', 'a'))).toBe('Add a test that fails when `strings.TrimSpace` is not called on line 12.');
    expect(adviceFor(mutant('collection', '[1, 2]', '[]'))).toBe('Add a test that asserts on the contents of `[1, 2]` at line 12.');
    expect(adviceFor(mutant('chaining', '?.', '.'))).toBe('Add a test in which the value before `?.` on line 12 is missing.');
    expect(adviceFor(mutant('chaining', '?', ''))).toBe('Add a test in which the value before `?.` on line 12 is missing.');
    expect(adviceFor(mutant('lambda', 'x + 1', 'undefined'))).toBe('Add a test that asserts on what the arrow function at line 12 returns.');
    expect(adviceFor(mutant('regex', '^a+$', 'a+$'))).toBe('Add a test with an input that `^a+$` and `a+$` match differently.');
  });

  it('cuts a long call to one line of it', () => {
    const call = `references.push(...phpUseReferences(node, index, scope, imports, aliases, 'use', 'function'));`;
    expect(adviceFor(mutant('removal', `  ${call}\n`, ''))).toBe("Add a test that fails when `references.push(...phpUseReferences(node, index, scope, i…` is not called.");
  });

  it('speaks for the surest mutant and counts the rest', () => {
    expect(methodAdvice([])).toBe('');
    expect(methodAdvice([mutant('boundary', '>', '>=', 6)])).toBe('Add a test at the boundary of `>` on line 6, where `>` and `>=` give different results.');
    expect(methodAdvice([mutant('boundary', '>', '>=', 6), mutant('number', '100', '101', 6)])).toBe('Add a test at the boundary of `>` on line 6, where `>` and `>=` give different results. 1 more edit survives.');
    expect(methodAdvice([mutant('return', 'x', 'null', 9), mutant('number', '1', '0', 9), mutant('string', "'a'", "''", 10)])).toBe('Add a test that asserts on what line 9 returns. 2 more edits survive.');
  });
});
