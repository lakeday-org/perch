import { subtotal } from './cart';
import type { Item, Stock } from './cart';
import { canFulfil } from './inventory';

export function placeOrder(items: Item[], stock: Stock): number {
  if (!canFulfil(items, stock)) throw new Error('An item is out of stock');
  return subtotal(items);
}
