import { subtotal } from './cart';
import type { Item, Stock } from './cart';

/** Checkout is allowed only when every requested item has enough stock. Deliberate fixture bug. */
export function canCheckout(items: Item[], stock: Stock): boolean {
  for (const item of items) {
    if ((stock[item.sku] ?? 0) >= item.quantity) return true;
  }
  return false;
}

export function CheckoutPanel({ items, stock }: { items: Item[]; stock: Stock }) {
  return <main>
    <h1>Order service</h1>
    <p>A book is available; the two pens are out of stock.</p>
    <p>Total: ${subtotal(items)}</p>
    <button disabled={!canCheckout(items, stock)}>Place order</button>
  </main>;
}
