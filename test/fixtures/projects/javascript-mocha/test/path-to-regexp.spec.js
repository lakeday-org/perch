'use strict';

const assert = require('node:assert');
const pathToRegexp = require('../lib/path-to-regexp');

describe('pathToRegexp', function () {
  it('names each parameter in keys', function () {
    const keys = [];
    const re = pathToRegexp('/users/:id/books/:book?', keys);

    assert.deepStrictEqual(keys.map(key => key.name), ['id', 'book']);
    assert.deepStrictEqual(re.exec('/users/7/books').slice(1), ['7', undefined]);
  });

  it('allows a trailing slash unless strict', function () {
    assert.ok(pathToRegexp('/users').test('/users/'));
    assert.ok(!pathToRegexp('/users', [], { strict: true }).test('/users/'));
  });

  describe('with end: false', function () {
    it('matches a prefix that ends on a segment', function () {
      const re = pathToRegexp('/admin', [], { end: false });

      assert.strictEqual(re.exec('/admin/users')[0], '/admin');
      assert.ok(!re.test('/administrator'));
    });
  });

  it('numbers the groups of a regular expression', function () {
    const keys = [];
    pathToRegexp(/^\/files\/(\w+)\.(\w+)$/, keys);

    assert.deepStrictEqual(keys.map(key => key.name), [0, 1]);
  });
});
