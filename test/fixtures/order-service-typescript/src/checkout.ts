import { subtotal } from './cart.js';
import type { Item, Stock } from './cart.js';
import { canFulfil } from './inventory.js';

export function placeOrder(items: Item[], stock: Stock): number {
  if (!canFulfil(items, stock)) throw new Error('An item is out of stock');
  return subtotal(items);
}
