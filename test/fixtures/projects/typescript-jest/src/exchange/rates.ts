import { Currency } from '../currency';
import { Money } from '../money';
import { divideRounded, toFraction } from '../rounding';
import type { RoundingMode } from '../types';

export interface RatesJSON {
  base: string;
  date: string;
  rates: Record<string, number>;
}

/** Exchange rates against one base currency, on one day. */
export class RateTable {
  readonly base: string;
  readonly asOf: Date;
  readonly #rates: Map<string, number>;

  constructor(base: string, rates: Record<string, number>, asOf: Date = new Date()) {
    this.base = Currency.of(base).code;
    this.asOf = asOf;
    this.#rates = new Map([[this.base, 1]]);
    for (const [code, rate] of Object.entries(rates)) {
      if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`the rate for ${code} must be a positive number, got ${rate}`);
      this.#rates.set(Currency.of(code).code, rate);
    }
  }

  /** A table from the JSON an ECB-style rates endpoint returns: `{ base, date, rates }`. */
  static fromJSON(json: RatesJSON | string): RateTable {
    const data: RatesJSON = typeof json === 'string' ? JSON.parse(json) : json;
    const asOf = new Date(`${data.date}T00:00:00Z`);
    if (Number.isNaN(asOf.getTime())) throw new RangeError(`invalid date ${JSON.stringify(data.date)}`);
    return new RateTable(data.base, data.rates, asOf);
  }

  /** How many units of `to` one unit of `from` buys, through the base currency. */
  rate(from: string, to: string): number {
    const source = this.#rates.get(from.toUpperCase());
    const target = this.#rates.get(to.toUpperCase());
    if (source === undefined || target === undefined) throw new RangeError(`no rate from ${from} to ${to} on ${this.asOf.toISOString().slice(0, 10)}`);
    return target / source;
  }

  /** `money` in `to`, rounded to that currency's minor unit. */
  convert(money: Money, to: string, mode: RoundingMode = 'half-even'): Money {
    const target = Currency.of(to);
    if (target.equals(money.currency)) return money;
    const [numerator, denominator] = toFraction(this.rate(money.currency.code, target.code));
    const minor = divideRounded(money.minor * numerator * target.scale, denominator * money.currency.scale, mode);
    return new Money(minor, target);
  }

  /** Whether the rates are older than `maxAgeMs` at `now`. */
  isStale(now: Date, maxAgeMs: number): boolean {
    return now.getTime() - this.asOf.getTime() > maxAgeMs;
  }
}
