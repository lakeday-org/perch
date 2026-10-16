'use strict';

const assert = require('node:assert');
const sinon = require('sinon');
const Layer = require('../lib/router/layer');

describe('Layer', function () {
  function noop(req, res, next) {
    next();
  }

  describe('.match(path)', function () {
    it('fills params from the path, decoded', function () {
      const layer = new Layer('/users/:name', { end: true }, noop);

      assert.ok(layer.match('/users/caf%C3%A9'));
      assert.deepStrictEqual(layer.params, { name: 'café' });
      assert.strictEqual(layer.path, '/users/caf%C3%A9');
    });

    it('fails a param that does not decode with a 400', function () {
      const layer = new Layer('/users/:name', { end: true }, noop);

      assert.throws(() => layer.match('/users/%E0%A4%A'), err => err.status === 400 && /Failed to decode param/.test(err.message));
    });
  });

  describe('.handleRequest(req, res, next)', function () {
    it('passes what the handler throws to next', function () {
      const boom = new Error('boom');
      const layer = new Layer('/', {}, function (req, res, next) {
        throw boom;
      });
      const next = sinon.spy();

      layer.handleRequest({}, {}, next);

      sinon.assert.calledOnceWithExactly(next, boom);
    });
  });

  describe('.handleError(err, req, res, next)', function () {
    it('passes the error over a handler that takes three arguments', function () {
      const handler = sinon.spy(noop);
      const layer = new Layer('/', {}, handler);
      const next = sinon.spy();
      const err = new Error('nope');

      layer.handleError(err, {}, {}, next);

      sinon.assert.notCalled(handler);
      sinon.assert.calledOnceWithExactly(next, err);
    });
  });
});
