'use strict';

const assert = require('node:assert');
const utils = require('../lib/utils');

describe('utils', function () {
  describe('.etag(body)', function () {
    it('should make a strong tag from the length and a hash', function () {
      assert.strictEqual(utils.etag('express!'), '"8-O2uVAFaQ1rZvlKLT14RnuvjPIdg"');
    });
  });

  describe('.wetag(body)', function () {
    it('should make a weak tag', function () {
      assert.strictEqual(utils.wetag('express!'), 'W/"8-O2uVAFaQ1rZvlKLT14RnuvjPIdg"');
    });
  });

  describe('.normalizeType(type)', function () {
    const cases = [
      ['html', 'text/html'],
      ['.json', 'application/json'],
      ['text/x-markdown', 'text/x-markdown'],
      ['unheard-of', 'application/octet-stream'],
    ];

    cases.forEach(function ([type, expected]) {
      it(`should normalize ${type}`, function () {
        assert.strictEqual(utils.normalizeType(type), expected);
      });
    });
  });

  describe('.setCharset(type, charset)', function () {
    it('should replace a charset and keep other parameters', function () {
      assert.strictEqual(utils.setCharset('text/html; charset=latin1; level=1', 'UTF-8'), 'text/html; level=1; charset=utf-8');
    });
  });

  describe('.compileETag(value)', function () {
    it('should throw on a value it does not know', function () {
      assert.throws(() => utils.compileETag('medium'), /unknown value for etag function: medium/);
    });
  });
});
