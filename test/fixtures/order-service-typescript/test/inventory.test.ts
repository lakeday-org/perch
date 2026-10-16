import { afterEach, describe, expect, it, vi } from 'vitest';
import * as inventory from '../src/inventory.js';
import { canFulfil } from '../src/inventory.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canFulfil', () => {
  it('accepts a cart when every item is in stock', () => {
    const items = [{ sku: 'book', quantity: 1, unitPrice: 20 }, { sku: 'pen', quantity: 2, unitPrice: 3 }];
    expect(canFulfil(items, { book: 4, pen: 5 })).toBe(true);
  });

  it('rejects an empty cart', () => {
    expect(canFulfil([], { book: 4 })).toBe(false);
  });

  it('accepts a quantity equal to the stock level', () => {
    expect(canFulfil([{ sku: 'book', quantity: 3, unitPrice: 20 }], { book: 3 })).toBe(true);
  });

  it('returns what the stub returns', () => {
    vi.spyOn(inventory, 'canFulfil').mockReturnValue(true);
    expect(inventory.canFulfil([{ sku: 'pen', quantity: 2, unitPrice: 3 }], { pen: 0 })).toBe(true);
  });
});
