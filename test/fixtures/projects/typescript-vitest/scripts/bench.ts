/** Times parse and stringify on a large query. Run with `npm run bench`. */
import { performance } from 'node:perf_hooks';
import { parse, stringify } from '../src';

const ROUNDS = 20_000;

function largeQuery(keys: number): string {
  const pairs: string[] = [];
  for (let index = 0; index < keys; index++) pairs.push(`filter[field${index}][]=${index}&filter[field${index}][]=${index + 1}`);
  return pairs.join('&');
}

function time(label: string, run: () => void): void {
  const start = performance.now();
  for (let round = 0; round < ROUNDS; round++) run();
  const each = ((performance.now() - start) / ROUNDS) * 1000;
  console.log(`${label.padEnd(12)} ${each.toFixed(2)} µs`);
}

const query = largeQuery(50);
const object = parse(query);
time('parse', () => parse(query));
time('stringify', () => stringify(object));
