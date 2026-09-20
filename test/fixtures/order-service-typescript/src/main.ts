import { placeOrder } from './checkout.js';

const items = [{ sku: 'book', quantity: 1, unitPrice: 20 }, { sku: 'pen', quantity: 2, unitPrice: 3 }];
console.log(`Accepted order total: ${placeOrder(items, { book: 4, pen: 0 })}`);
