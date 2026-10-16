import { canCheckout } from './CheckoutPanel';
import { subtotal } from './cart';
import type { Item, Stock } from './cart';

/** The amount to charge for an order, refused when any item is out of stock. */
export function placeOrder(items: Item[], stock: Stock): number {
  if (!canCheckout(items, stock)) throw new Error('An item is out of stock');
  return subtotal(items);
}
