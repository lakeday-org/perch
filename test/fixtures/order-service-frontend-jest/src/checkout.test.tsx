import { describe, expect, it } from '@jest/globals';
import { placeOrder } from './checkout';

describe('placeOrder', () => {
  it('returns the subtotal when every item is in stock', () => {
    const items = [{ sku: 'book', quantity: 1, unitPrice: 20 }, { sku: 'pen', quantity: 2, unitPrice: 3 }];
    expect(placeOrder(items, { book: 4, pen: 5 })).toBe(26);
  });
});
