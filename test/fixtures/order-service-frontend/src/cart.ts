export interface Item { sku: string; quantity: number; unitPrice: number }
export type Stock = Record<string, number>;

export function subtotal(items: Item[]): number {
  let total = 0;
  for (const item of items) total += item.unitPrice * item.quantity;
  return total;
}
