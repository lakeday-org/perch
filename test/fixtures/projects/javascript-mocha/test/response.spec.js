'use strict';

const assert = require('node:assert');
const sinon = require('sinon');
const switchyard = require('..');
const utils = require('../lib/utils');
const { Response } = switchyard;

describe('Response', function () {
  let res;

  beforeEach(function () {
    const headers = {};
    res = {
      statusCode: 200,
      headers,
      setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
      getHeader: name => headers[name.toLowerCase()],
      removeHeader: name => { delete headers[name.toLowerCase()]; },
      end: sinon.spy(),
    };
  });

  afterEach(function () {
    sinon.restore();
  });

  function sent() {
    const [body] = res.end.firstCall.args;
    return body === undefined ? undefined : body.toString();
  }

  describe('.json(obj)', function () {
    it('should send an object as JSON', function () {
      new Response(res, { method: 'GET' }).json({ user: 'tobi' });

      assert.strictEqual(sent(), '{"user":"tobi"}');
      assert.strictEqual(res.headers['content-type'], 'application/json; charset=utf-8');
    });

    it('should escape the characters that would end a script tag', function () {
      new Response(res, { method: 'GET' }).send({ html: '</script>' });

      assert.strictEqual(sent(), '{"html":"\\u003c/script\\u003e"}');
    });
  });

  describe('.send(body)', function () {
    it("should set the ETag the app's etag function makes", function () {
      const wetag = sinon.stub(utils, 'wetag').returns('W/"stubbed"');
      const app = switchyard();

      new Response(res, { method: 'GET' }, app).send('hello');

      sinon.assert.calledOnce(wetag);
      assert.strictEqual(res.headers.etag, 'W/"stubbed"');
    });

    it('should drop the body of a 204', function () {
      new Response(res, { method: 'GET' }).status(204).send('ignored');

      assert.strictEqual(sent(), '');
      assert.strictEqual(res.headers['content-length'], undefined);
    });
  });

  describe('.redirect(url)', function () {
    it('should redirect with a 302 and a Location header', function () {
      new Response(res, { method: 'GET' }).redirect('/login?next=/a b');

      assert.strictEqual(res.statusCode, 302);
      assert.strictEqual(res.headers.location, '/login?next=/a%20b');
      assert.strictEqual(sent(), 'Found. Redirecting to /login?next=/a%20b');
    });
  });
});
