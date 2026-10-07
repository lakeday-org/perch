import { createRoot } from 'react-dom/client';
import { CheckoutPanel } from './CheckoutPanel';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
const items = [{ sku: 'book', quantity: 1, unitPrice: 20 }, { sku: 'pen', quantity: 2, unitPrice: 3 }];
createRoot(root).render(<CheckoutPanel items={items} stock={{ book: 4, pen: 0 }} />);
