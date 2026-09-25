import { expect, it } from 'vitest';
import { batchBlobSize } from '../src/git.js';

it('rejects Git batch headers whose blob size cannot be indexed safely', () => {
  const header = `${'a'.repeat(40)} blob `;
  expect(batchBlobSize(`${header}42`, 50)).toBe(42);
  expect(() => batchBlobSize(`${header}${Number.MAX_SAFE_INTEGER}`, 50)).toThrow('invalid blob header');
  expect(() => batchBlobSize(`${header}9007199254740992`, 50)).toThrow('invalid blob header');
  expect(() => batchBlobSize(`${header}-1`, 50)).toThrow('invalid blob header');
});
