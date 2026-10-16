'use strict';

const assert = require('node:assert');
const sinon = require('sinon');
const Route = require('../lib/router/route');

describe('Route', function () {
  let route;

  beforeEach(function () {
    route = new Route('/books');
  });

  describe('.dispatch(req, res, done)', function () {
    it('should run the handlers in order', function (done) {
      const calls = [];
      route.get(
        (req, res, next) => { calls.push('first'); next(); },
        (req, res, next) => { calls.push('second'); next(); },
      );

      route.dispatch({ method: 'GET' }, {}, function (err) {
        assert.ifError(err);
        assert.deepStrictEqual(calls, ['first', 'second']);
        done();
      });
    });

    it('should skip handlers for another method', function (done) {
      const post = sinon.spy();
      route.post(post);

      route.dispatch({ method: 'GET' }, {}, function () {
        sinon.assert.notCalled(post);
        done();
      });
    });

    it('should leave the route when a handler calls next("route")', function (done) {
      const after = sinon.spy();
      route.all((req, res, next) => next('route'), after);

      route.dispatch({ method: 'DELETE' }, {}, function (err) {
        assert.strictEqual(err, undefined);
        sinon.assert.notCalled(after);
        done();
      });
    });
  });

  it('should answer HEAD with its GET handlers', function () {
    route.get(function () {});
    assert.ok(route.handlesMethod('HEAD'));
    assert.ok(!route.handlesMethod('PUT'));
  });
});
