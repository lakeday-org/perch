export interface Item { sku: string; quantity: number; unitPrice: number }
export type Stock = Record<string, number>;

export function subtotal(items: Item[]): number {
  let total = 0;
  for (const item of items) total += item.unitPrice * item.quantity;
  return total;
}

/** Take a percentage off a total. A discount of 100 percent or more makes the order free. */
export function applyDiscount(total: number, percent: number): number {
  if (percent >= 100) return 0;
  return total - (total * percent) / 100;
}
