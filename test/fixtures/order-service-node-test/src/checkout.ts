import { subtotal } from './cart.ts';
import type { Item, Stock } from './cart.ts';
import { canFulfil } from './inventory.ts';

export function placeOrder(items: Item[], stock: Stock): number {
  if (!canFulfil(items, stock)) throw new Error('An item is out of stock');
  return subtotal(items);
}
