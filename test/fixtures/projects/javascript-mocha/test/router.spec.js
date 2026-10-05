'use strict';

const assert = require('node:assert');
const sinon = require('sinon');
const Router = require('../lib/router');

describe('Router', function () {
  let router;

  beforeEach(function () {
    router = new Router();
  });

  // Sends a request through the router and resolves once the router hands it on, with the request and what it was handed.
  function dispatch(method, url) {
    const req = { method, url, headers: {} };
    return new Promise(resolve => router.handle(req, {}, err => resolve({ req, err })));
  }

  describe('.route(path)', function () {
    it('should send a request to the route that matches', async function () {
      let params;
      const show = sinon.spy((req, res, next) => {
        params = req.params;
        next();
      });
      router.route('/users/:id').get(show);

      await dispatch('GET', '/users/3');

      sinon.assert.calledOnce(show);
      assert.deepStrictEqual(params, { id: '3' });
    });

    it('should hand on a request no route matches', async function () {
      router.route('/users').get(sinon.spy());

      const { req, err } = await dispatch('GET', '/books?page=2');

      assert.strictEqual(err, undefined);
      assert.strictEqual(req.url, '/books?page=2');
    });
  });

  describe('.use(path, fn)', function () {
    it('should strip the mount path from req.url inside the middleware', async function () {
      let seen;
      router.use('/api', (req, res, next) => {
        seen = [req.url, req.baseUrl];
        next();
      });

      const { req } = await dispatch('GET', '/api/users');

      assert.deepStrictEqual(seen, ['/users', '/api']);
      assert.strictEqual(req.url, '/api/users');
    });

    it('should pass an error to the next error handler', async function () {
      let caught;
      router.use((req, res, next) => next(new Error('nope')));
      router.use((err, req, res, next) => {
        caught = err;
        next();
      });

      const { err } = await dispatch('GET', '/');

      assert.strictEqual(caught.message, 'nope');
      assert.strictEqual(err, undefined);
    });
  });

  describe('.param(name, fn)', function () {
    it('should run a param callback once per request', async function () {
      const load = sinon.spy((req, res, next) => next());
      router.param('id', load);
      router.route('/users/:id').get((req, res, next) => next());
      router.route('/users/:id').get((req, res, next) => next());

      await dispatch('GET', '/users/9');

      sinon.assert.calledOnce(load);
      assert.strictEqual(load.firstCall.args[3], '9');
    });

    it.skip('should merge params from a parent router', async function () {
      const child = new Router({ mergeParams: true });
      router.use('/users/:id', child);
      child.route('/books').get((req, res, next) => next());

      const { req } = await dispatch('GET', '/users/4/books');

      assert.strictEqual(req.params.id, '4');
    });
  });
});
