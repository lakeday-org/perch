import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, ValidationError } from '../src/errors.js';

describe('ValidationError', () => {
  const problems = [{ key: 'db.url', message: 'is required' }, { key: 'server.port', message: 'must be a port, got 0' }];

  it('says how many problems and lists each', () => {
    const err = new ValidationError(problems);

    assert.equal(err.message, '2 problems in the configuration:\n  db.url: is required\n  server.port: must be a port, got 0');
    assert.ok(err instanceof ConfigError);
  });

  it('gives the problems with one key', () => {
    assert.deepEqual(new ValidationError(problems).about('db.url'), [problems[0]]);
  });
});
