import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coerce, fromEnv } from '../src/env.js';

describe('fromEnv', () => {
  let env;

  before(() => {
    env = {
      APP__DB__HOST: 'localhost',
      APP__DB__POOL_SIZE: '10',
      APP__FEATURES__BETA: 'true',
      HOME: '/home/app',
      APPLE: 'no separator after the prefix',
    };
  });

  it('nests keys on the separator and camel-cases them', () => {
    assert.deepEqual(fromEnv(env, { prefix: 'APP' }), { db: { host: 'localhost', poolSize: 10 }, features: { beta: true } });
  });

  it('keeps keys as written without camelCase', () => {
    assert.deepEqual(fromEnv({ X__A_B: '1' }, { prefix: 'X', camelCase: false }), { A_B: 1 });
  });
});

describe('coerce', () => {
  it('reads booleans, null and numbers, and leaves the rest', () => {
    assert.deepEqual(['true', 'false', 'null', '-3.5', '007', '12abc'].map(coerce), [true, false, null, -3.5, 7, '12abc']);
  });
});
