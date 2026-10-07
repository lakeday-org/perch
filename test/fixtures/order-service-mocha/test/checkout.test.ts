import { strict as assert } from 'node:assert';
import { placeOrder } from '../src/checkout';

describe('placeOrder', () => {
  it('returns the subtotal when every item is in stock', () => {
    const items = [{ sku: 'book', quantity: 1, unitPrice: 20 }, { sku: 'pen', quantity: 2, unitPrice: 3 }];
    assert.equal(placeOrder(items, { book: 4, pen: 5 }), 26);
  });
});
