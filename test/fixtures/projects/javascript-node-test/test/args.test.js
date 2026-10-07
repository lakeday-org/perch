import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('reads --key=value and --key value', () => {
    assert.deepEqual(parseArgs(['--port=8080', '--host', 'example.com']), { port: 8080, host: 'example.com' });
  });

  it('reads --flag as true and --no-flag as false', () => {
    assert.deepEqual(parseArgs(['--verbose', '--no-color']), { verbose: true, color: false });
  });

  it('reads a dotted key into a nested object and stops at --', () => {
    assert.deepEqual(parseArgs(['serve', '--db.pool=4', '--', '--ignored']), { db: { pool: 4 } });
  });
});
