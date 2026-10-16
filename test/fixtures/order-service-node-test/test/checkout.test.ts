import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { placeOrder } from '../src/checkout.ts';

describe('placeOrder', () => {
  it('returns the subtotal when every item is in stock', () => {
    const items = [{ sku: 'book', quantity: 1, unitPrice: 20 }, { sku: 'pen', quantity: 2, unitPrice: 3 }];
    assert.equal(placeOrder(items, { book: 4, pen: 5 }), 26);
  });
});
