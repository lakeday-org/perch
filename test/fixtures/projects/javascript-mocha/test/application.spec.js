'use strict';

const assert = require('node:assert');
const switchyard = require('..');

/** A stand-in for http.ServerResponse that records what was sent and resolves `finished` when the response ends. */
function createResponse() {
  const headers = {};
  let finish;
  const res = {
    statusCode: 200,
    headersSent: false,
    headers,
    finished: new Promise(resolve => { finish = resolve; }),
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    removeHeader(name) { delete headers[name.toLowerCase()]; },
    end(body) {
      this.body = body === undefined ? '' : String(body);
      this.headersSent = true;
      finish(this);
    },
  };
  return res;
}

function request(app, method, url) {
  const res = createResponse();
  app.handle({ method, url, headers: {} }, res);
  return res.finished;
}

describe('app', function () {
  describe('settings', function () {
    it('should start with x-powered-by and weak etags', function () {
      const app = switchyard();

      assert.ok(app.enabled('x-powered-by'));
      assert.strictEqual(app.set('etag fn')('hi'), 'W/"2-witfkXg0JglCjW9RssWvTAveakI"');
    });

    it('should cache views in production', function () {
      assert.ok(switchyard({ env: 'production' }).enabled('view cache'));
      assert.ok(!switchyard({ env: 'test' }).enabled('view cache'));
    });
  });

  describe('.handle(req, res)', function () {
    it('should answer from the route that matches', async function () {
      const app = switchyard();
      app.get('/hello', (req, res) => res.reply.send('hi ' + req.query.name));

      const res = await request(app, 'GET', '/hello?name=ada');

      assert.strictEqual(res.body, 'hi ada');
      assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
      assert.strictEqual(res.headers['x-powered-by'], 'Switchyard');
    });

    it('should answer 404 when no route matches', async function () {
      const app = switchyard();

      const res = await request(app, 'GET', '/missing');

      assert.strictEqual(res.statusCode, 404);
      assert.match(res.body, /Cannot GET \/missing/);
    });

    it('should answer with the status of the error a handler throws', async function () {
      const app = switchyard({ env: 'production' });
      app.get('/teapot', () => {
        throw Object.assign(new Error('short and stout'), { status: 418 });
      });

      const res = await request(app, 'GET', '/teapot');

      assert.strictEqual(res.statusCode, 418);
      assert.match(res.body, /I&#39;m a Teapot/);
    });
  });
});
