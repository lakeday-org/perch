import { describe, it, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadConfig, Schema, ValidationError } from '../src/index.js';

/** Stands in for the disk: readFile answers from `files`, and a path not in it is ENOENT, as it would be. */
function fakeDisk(files) {
  return mock.method(fs, 'readFile', async path => {
    if (path in files) return files[path];
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
  });
}

describe('loadConfig', () => {
  it('layers defaults, files, the environment and flags in that order', async t => {
    t.after(() => mock.restoreAll());
    fakeDisk({
      'config/default.json': '{ "server": { "port": 8080, "host": "localhost" }, "db": { "url": "postgres://${DB_HOST:-localhost}/app" } }',
      'config/production.ini': '[server]\nhost = 0.0.0.0\n',
    });

    const config = await loadConfig({
      defaults: { log: 'info' },
      files: ['config/default.json', 'config/production.ini'],
      env: { APP__LOG: 'warn', DB_HOST: 'db.internal' },
      prefix: 'APP',
      argv: ['--server.port=9000'],
    });

    assert.deepEqual(config, { log: 'warn', server: { port: 9000, host: '0.0.0.0' }, db: { url: 'postgres://db.internal/app' } });
  });

  it('passes over an optional file that is not there', async t => {
    t.after(() => mock.restoreAll());
    fakeDisk({ '.env': 'NAME=app' });

    const config = await loadConfig({ files: ['.env', { path: '.env.local', optional: true }], env: {} });

    assert.deepEqual(config, { NAME: 'app' });
  });

  it('rejects a configuration the schema does not allow', async t => {
    t.after(() => mock.restoreAll());
    fakeDisk({ 'app.json': '{ "port": "eighty" }' });

    await assert.rejects(loadConfig({ files: ['app.json'], env: {}, schema: { port: { type: 'port' } } }), ValidationError);
  });
});

test('hands the merged configuration to the schema once', async t => {
  const validate = t.mock.method(Schema.prototype, 'validate', config => ({ ...config, checked: true }));

  const config = await loadConfig({ defaults: { a: 1 }, env: {}, schema: new Schema({ a: { type: 'integer' } }) });

  assert.equal(validate.mock.callCount(), 1);
  assert.deepEqual(config, { a: 1, checked: true });
});
