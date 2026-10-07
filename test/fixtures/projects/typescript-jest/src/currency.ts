import { UnknownCurrencyError } from './errors';
import { ISO_4217 } from './generated/iso4217';

/** A currency and how many decimal places its minor unit has. */
export class Currency {
  private static readonly registry = new Map<string, Currency>();

  constructor(readonly code: string, readonly digits: number, readonly symbol: string = code, readonly name: string = code) {
    if (!/^[A-Z]{3}$/.test(code)) throw new RangeError(`currency code must be three capital letters, got ${JSON.stringify(code)}`);
    if (!Number.isInteger(digits) || digits < 0 || digits > 8) throw new RangeError(`${code}: digits must be an integer from 0 to 8`);
  }

  /** The ISO 4217 currency with this code, or one added with `Currency.register`. Always the same instance for a code. */
  static of(code: string): Currency {
    const upper = code.toUpperCase();
    const known = Currency.registry.get(upper);
    if (known) return known;
    const data = ISO_4217.find(item => item.code === upper);
    if (!data) throw new UnknownCurrencyError(code);
    const currency = new Currency(data.code, data.digits, data.symbol, data.name);
    Currency.registry.set(upper, currency);
    return currency;
  }

  /** Adds a currency ISO 4217 does not list, such as loyalty points. An ISO currency cannot be replaced. */
  static register(currency: Currency): Currency {
    if (ISO_4217.some(item => item.code === currency.code)) throw new RangeError(`${currency.code} is an ISO 4217 currency and cannot be replaced`);
    Currency.registry.set(currency.code, currency);
    return currency;
  }

  /** Minor units in one major unit: 100n for USD, 1n for JPY. */
  get scale(): bigint {
    return 10n ** BigInt(this.digits);
  }

  equals(other: Currency): boolean {
    return this.code === other.code;
  }

  toString(): string {
    return this.code;
  }
}
