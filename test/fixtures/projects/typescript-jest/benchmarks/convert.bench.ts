import { performance } from 'node:perf_hooks';
import { Money, RateTable } from '../src';

const table = new RateTable('EUR', { USD: 1.1, GBP: 0.85, JPY: 165.5, CHF: 0.94 });
const amounts = Array.from({ length: 10_000 }, (_, index) => Money.fromMinor(index * 37, 'USD'));

const start = performance.now();
for (const amount of amounts) table.convert(amount, 'JPY');
console.log(`convert: ${(((performance.now() - start) / amounts.length) * 1000).toFixed(2)} µs each`);
