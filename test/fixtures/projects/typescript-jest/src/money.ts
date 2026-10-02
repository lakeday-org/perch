import { allocateMinor } from './allocate';
import { Currency } from './currency';
import { formatDecimal, parseDecimal } from './decimal';
import { CurrencyMismatchError, InvalidAmountError } from './errors';
import { divideRounded, toFraction } from './rounding';
import type { RoundingMode } from './types';

/** An amount of one currency, held exactly in its minor units. Immutable: every operation returns a new Money. */
export class Money {
  readonly minor: bigint;
  readonly currency: Currency;

  constructor(minor: bigint, currency: Currency) {
    this.minor = minor;
    this.currency = currency;
    Object.freeze(this);
  }

  /**
   * `Money.of('19.99', 'USD')`. A number is read by its decimal digits, so 0.1 is ten cents; a string with more places than
   * the currency has is an error unless `mode` says how to round it.
   */
  static of(amount: string | number, code: string, mode?: RoundingMode): Money {
    const currency = Currency.of(code);
    if (typeof amount === 'string') return new Money(parseDecimal(amount, currency.digits, mode), currency);
    if (!Number.isFinite(amount)) throw new InvalidAmountError(String(amount), 'not a finite number');
    const [numerator, denominator] = toFraction(amount);
    return new Money(divideRounded(numerator * currency.scale, denominator, mode ?? 'half-even'), currency);
  }

  /** `Money.fromMinor(1999, 'USD')` is $19.99. */
  static fromMinor(minor: bigint | number, code: string): Money {
    if (typeof minor === 'number' && !Number.isSafeInteger(minor)) throw new InvalidAmountError(String(minor), 'minor units must be a safe integer');
    return new Money(BigInt(minor), Currency.of(code));
  }

  static zero(code: string): Money {
    return new Money(0n, Currency.of(code));
  }

  /** The total of amounts in one currency. An empty list has no currency to be zero in, so it needs `code`. */
  static sum(items: readonly Money[], code?: string): Money {
    if (!items.length) {
      if (!code) throw new RangeError('the sum of no amounts needs a currency');
      return Money.zero(code);
    }
    let total = items[0];
    for (const item of items.slice(1)) total = total.add(item);
    return total;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  /** This amount times `factor`, rounded back to the currency's minor unit. */
  multiply(factor: number, mode: RoundingMode = 'half-even'): Money {
    const [numerator, denominator] = toFraction(factor);
    return new Money(divideRounded(this.minor * numerator, denominator, mode), this.currency);
  }

  /** Splits this amount by `ratios`, so that the shares add up to it exactly. */
  allocate(ratios: number[]): Money[] {
    return allocateMinor(this.minor, ratios).map(minor => new Money(minor, this.currency));
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.minor < other.minor ? -1 : this.minor > other.minor ? 1 : 0;
  }

  equals(other: Money): boolean {
    return this.currency.equals(other.currency) && this.minor === other.minor;
  }

  /** The amount as a decimal string with the currency's own number of places: '19.99', '500', '1.250'. */
  toDecimal(): string {
    return formatDecimal(this.minor, this.currency.digits);
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toDecimal(), currency: this.currency.code };
  }

  toString(): string {
    return `${this.toDecimal()} ${this.currency.code}`;
  }

  private assertSameCurrency(other: Money): void {
    if (!this.currency.equals(other.currency)) throw new CurrencyMismatchError(this.currency.code, other.currency.code);
  }
}
