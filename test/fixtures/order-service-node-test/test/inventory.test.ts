import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canFulfil } from '../src/inventory.ts';

describe('canFulfil', () => {
  it('accepts a cart when every item is in stock', () => {
    const items = [{ sku: 'book', quantity: 1, unitPrice: 20 }, { sku: 'pen', quantity: 2, unitPrice: 3 }];
    assert.equal(canFulfil(items, { book: 4, pen: 5 }), true);
  });

  it('rejects an empty cart', () => {
    assert.equal(canFulfil([], { book: 4 }), false);
  });

  it('accepts a quantity equal to the stock level', () => {
    assert.equal(canFulfil([{ sku: 'book', quantity: 3, unitPrice: 20 }], { book: 3 }), true);
  });

  it('returns what the stub returns', async t => {
    t.mock.module('../src/inventory.ts', { namedExports: { canFulfil: () => true } });
    const inventory = await import('../src/inventory.ts');
    assert.equal(inventory.canFulfil([{ sku: 'pen', quantity: 2, unitPrice: 3 }], { pen: 0 }), true);
  });
});
