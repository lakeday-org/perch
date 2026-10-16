/** How long allocation and formatting take on many shares. Run with `npm run bench`. */
import { performance } from 'node:perf_hooks';
import { allocateMinor, formatMoney, Money } from '../src';

function measure(label: string, rounds: number, run: () => void): void {
  const start = performance.now();
  for (let round = 0; round < rounds; round++) run();
  const micros = ((performance.now() - start) / rounds) * 1000;
  console.log(`${label.padEnd(24)} ${micros.toFixed(2)} µs`);
}

const ratios = Array.from({ length: 1000 }, (_, index) => (index % 7) + 1);
const payroll = Money.of('1234567.89', 'USD');

measure('allocate 1000 shares', 500, () => allocateMinor(payroll.minor, ratios));
measure('format', 100_000, () => formatMoney(payroll));
