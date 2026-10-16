import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate, interpolateAll } from '../src/interpolate.js';
import { ConfigError } from '../src/errors.js';

describe('interpolate', () => {
  const env = { HOST: 'db.internal', EMPTY: '' };

  it('replaces a variable', () => {
    assert.equal(interpolate('postgres://${HOST}:5432', env), 'postgres://db.internal:5432');
  });

  it('takes the fallback for an unset or empty variable', () => {
    assert.equal(interpolate('${PORT:-5432}/${EMPTY:-none}', env), '5432/none');
  });

  it('names the key when a variable is missing', () => {
    assert.throws(() => interpolate('${SECRET}', env, 'db.password'), err => err instanceof ConfigError && err.key === 'db.password');
  });
});

describe('interpolateAll', () => {
  it('interpolates every string in a tree and nothing else', () => {
    const tree = { url: 'http://${HOST}', ports: [80, '${PORT:-443}'], debug: false, price: '$$5' };

    assert.deepEqual(interpolateAll(tree, { HOST: 'example.com' }), { url: 'http://example.com', ports: [80, '443'], debug: false, price: '$5' });
  });
});
