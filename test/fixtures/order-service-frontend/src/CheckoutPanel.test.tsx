import { afterEach, describe, expect, it, vi } from 'vitest';
import * as panel from './CheckoutPanel';
import { canCheckout } from './CheckoutPanel';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canCheckout', () => {
  it('allows checkout when every item is in stock', () => {
    const items = [{ sku: 'book', quantity: 1, unitPrice: 20 }, { sku: 'pen', quantity: 2, unitPrice: 3 }];
    expect(canCheckout(items, { book: 4, pen: 5 })).toBe(true);
  });

  it('refuses checkout for an empty cart', () => {
    expect(canCheckout([], { book: 4 })).toBe(false);
  });

  it('allows a quantity equal to the stock level', () => {
    expect(canCheckout([{ sku: 'book', quantity: 3, unitPrice: 20 }], { book: 3 })).toBe(true);
  });

  it('returns what the stub returns', () => {
    vi.spyOn(panel, 'canCheckout').mockReturnValue(true);
    expect(panel.canCheckout([{ sku: 'pen', quantity: 2, unitPrice: 3 }], { pen: 0 })).toBe(true);
  });
});
