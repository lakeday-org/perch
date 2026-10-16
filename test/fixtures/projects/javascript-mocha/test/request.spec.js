'use strict';

const assert = require('node:assert');
const { request } = require('..');
const { compileTrust } = require('../lib/utils');

function req(headers, socket = {}) {
  return { headers, socket };
}

describe('request', function () {
  describe('.accepts(req, types)', function () {
    it('should pick the type the client prefers', function () {
      const r = req({ accept: 'text/html;q=0.5, application/json' });

      assert.strictEqual(request.accepts(r, 'html', 'json'), 'json');
    });
  });

  describe('.protocol(req, trust)', function () {
    it('should trust X-Forwarded-Proto only from a trusted proxy', function () {
      const r = req({ 'x-forwarded-proto': 'https, http' }, { remoteAddress: '10.0.0.1' });

      assert.strictEqual(request.protocol(r, compileTrust('10.0.0.1')), 'https');
      assert.strictEqual(request.protocol(r, compileTrust(false)), 'http');
    });
  });

  describe('.hostname(req, trust)', function () {
    it('should drop the port but keep an IPv6 literal whole', function () {
      assert.strictEqual(request.hostname(req({ host: 'example.com:3000' })), 'example.com');
      assert.strictEqual(request.hostname(req({ host: '[::1]:3000' })), '[::1]');
    });
  });
});
