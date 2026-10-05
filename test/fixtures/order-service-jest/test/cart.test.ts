import { describe, expect, it } from '@jest/globals';
import { applyDiscount, subtotal } from '../src/cart';
import type { Item } from '../src/cart';

describe('applyDiscount', () => {
  it('takes 10 percent off', () => {
    expect(applyDiscount(200, 10)).toBe(180);
  });

  it('takes 20 percent off', () => {
    expect(applyDiscount(200, 20)).toBe(160);
  });

  it('takes 25 percent off', () => {
    expect(applyDiscount(200, 25)).toBe(150);
  });

  it('takes 50 percent off', () => {
    expect(applyDiscount(200, 50)).toBe(100);
  });

  it('takes 75 percent off', () => {
    expect(applyDiscount(200, 75)).toBe(50);
  });
});

describe('subtotal', () => {
  it('adds up the cart', () => {
    subtotal([{ sku: 'book', quantity: 1, unitPrice: 20 }, { sku: 'pen', quantity: 2, unitPrice: 3 }]);
  });

  it('matches the total the orders API saved', async () => {
    const response = await fetch(`${process.env.ORDERS_API_URL}/orders/1`, {
      headers: { authorization: `Bearer ${process.env.ORDERS_API_TOKEN}` },
    });
    const order = await response.json() as { items: Item[]; total: number };
    expect(subtotal(order.items)).toBe(order.total);
  });
});
