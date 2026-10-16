import { describe, expect, it } from 'vitest';
import { jsonChunks, jsonPieces } from '../src/store.js';

describe('JSON in pieces', () => {
  it('joins to exactly what JSON.stringify writes', () => {
    const values = [
      { a: 1, b: [1, 2, { c: [] }], d: {}, e: null, f: undefined, g: () => 1, h: 'line\nbreak', i: [undefined, null, 'x'] },
      [[[[{ deep: { deeper: [1, { deepest: true }] } }]]]],
      [], {}, 'text', 4, null, true,
      { map: new Map([[1, 2]]), when: new Date(0), nested: { list: [{ id: 'a', tests: [{ id: 't', depth: 1 }] }] } },
    ];
    for (const value of values) expect([...jsonPieces(value)].join('')).toBe(JSON.stringify(value, null, 2));
  });

  it('cuts a large value into chunks that still parse with a newline between each', () => {
    const value = { methods: Array.from({ length: 30000 }, (_, index) => ({ id: `src/m${index}.js::m`, tests: [{ id: `t${index}`, depth: 1 }], note: 'x'.repeat(40) })) };
    const chunks = [...jsonChunks(value)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(JSON.stringify(value, null, 2));
    // How --json prints them: one stdout line each.
    expect(JSON.parse(chunks.join('\n'))).toEqual(value);
  });
});
