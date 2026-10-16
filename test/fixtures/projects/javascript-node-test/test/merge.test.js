import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import merge, { isPlainObject, mergeWith } from '../src/merge.js';

describe('merge', () => {
  it('merges nested objects, later sources winning', () => {
    const target = { db: { host: 'localhost', port: 5432 } };

    merge(target, { db: { port: 6432 } }, { db: { user: 'app' } });

    assert.deepEqual(target, { db: { host: 'localhost', port: 6432, user: 'app' } });
  });

  it('replaces arrays by default', () => {
    assert.deepEqual(merge({ hosts: ['a', 'b'] }, { hosts: ['c'] }), { hosts: ['c'] });
  });

  it('concatenates arrays when asked', () => {
    assert.deepEqual(mergeWith({ arrays: 'concat' }, { hosts: ['a'] }, { hosts: ['b'] }), { hosts: ['a', 'b'] });
  });

  it('does not merge into the prototype', () => {
    merge({}, JSON.parse('{"__proto__": {"polluted": true}}'));

    assert.equal({}.polluted, undefined);
  });
});

test('isPlainObject tells an object literal from an instance', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject(new Date()), false);
  assert.equal(isPlainObject([]), false);
});
