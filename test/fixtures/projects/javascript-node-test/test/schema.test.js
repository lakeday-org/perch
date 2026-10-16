import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '../src/schema/index.js';
import { ValidationError } from '../src/errors.js';

describe('Schema', () => {
  let schema;

  beforeEach(() => {
    schema = new Schema({
      server: {
        port: { type: 'port', default: 8080, doc: 'Port to listen on' },
        host: { type: 'string', default: '0.0.0.0' },
      },
      db: { url: { type: 'url', required: true } },
      log: { level: { type: 'string', enum: ['debug', 'info', 'warn'], default: 'info' } },
    });
  });

  it('fills in defaults', () => {
    const config = schema.validate({ db: { url: 'postgres://localhost/app' } });

    assert.deepEqual(config, { db: { url: 'postgres://localhost/app' }, server: { port: 8080, host: '0.0.0.0' }, log: { level: 'info' } });
  });

  it('coerces strings from the environment', () => {
    const config = schema.validate({ server: { port: '9090' }, db: { url: 'postgres://localhost/app' } });

    assert.equal(config.server.port, 9090);
  });

  it('reports every problem at once', () => {
    assert.throws(() => schema.validate({ server: { port: 70000 }, log: { level: 'trace' } }), err => {
      assert.ok(err instanceof ValidationError);
      assert.deepEqual(err.problems.map(problem => problem.key), ['server.port', 'db.url', 'log.level']);
      return true;
    });
  });

  it('describes each key for the docs', () => {
    assert.deepEqual(schema.describe()[0], { key: 'server.port', type: 'port', required: false, default: 8080, doc: 'Port to listen on' });
  });

  it.skip('validates arrays of objects', () => {
    const list = new Schema({ upstreams: { type: 'array', items: { host: { type: 'string', required: true } } } });

    assert.throws(() => list.validate({ upstreams: [{}] }), ValidationError);
  });
});
