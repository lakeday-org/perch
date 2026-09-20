import type { Item, Stock } from './cart.js';

/** True only when every requested item has enough stock. Deliberate fixture bug. */
export function canFulfil(items: Item[], stock: Stock): boolean {
  for (const item of items) {
    if ((stock[item.sku] ?? 0) >= item.quantity) return true;
  }
  return false;
}
