'use strict';

const assert = require('node:assert');
const sinon = require('sinon');
const query = require('../lib/middleware/query');
const { init } = require('../lib/middleware/init');

describe('middleware', function () {
  describe('query()', function () {
    it('should collect a repeated key into an array', function () {
      const req = { url: '/search?tag=a&tag=b&q=x' };
      const next = sinon.spy();

      query()(req, {}, next);

      assert.deepStrictEqual(req.query, { tag: ['a', 'b'], q: 'x' });
      sinon.assert.calledOnce(next);
    });

    it('should leave a query something else parsed', function () {
      const parsed = { already: 'here' };
      const req = { url: '/?a=1', query: parsed };

      query()(req, {}, function () {});

      assert.strictEqual(req.query, parsed);
    });
  });

  describe('init(app)', function () {
    it('should link the request, the response and the app', function () {
      const app = { enabled: sinon.stub().withArgs('x-powered-by').returns(false) };
      const req = {};
      const res = { setHeader: sinon.spy() };

      init(app)(req, res, function () {});

      assert.strictEqual(req.res, res);
      assert.strictEqual(res.req, req);
      assert.strictEqual(res.reply.app, app);
      sinon.assert.notCalled(res.setHeader);
    });
  });
});
