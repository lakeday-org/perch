# tally-money

Exact money arithmetic. Amounts are held in minor units as `bigint`, so `0.1 + 0.2` is thirty cents and a split never loses one.

```ts
import { Money, formatMoney, parseMoney } from 'tally-money';

const bill = Money.of('100.00', 'USD');
bill.allocate([1, 1, 1]).map(share => share.toDecimal());
// ['33.34', '33.33', '33.33']

formatMoney(Money.of('1234567.5', 'USD'));
// '$1,234,567.50'

parseMoney('1.234,56 EUR').toDecimal();
// '1234.56'
```

Rounding is banker's rounding (`half-even`) unless you name another mode: `half-up`, `half-down`, `up`, `down`, `ceiling`,
`floor`.

`src/generated/iso4217.ts` is written by `npm run generate:currencies`; do not edit it by hand.
