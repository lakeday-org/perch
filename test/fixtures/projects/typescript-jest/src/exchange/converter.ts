import type { Money } from '../money';
import type { RoundingMode } from '../types';
import { fetchRates } from './provider';
import type { RateTable } from './rates';

type Loader = (base: string) => Promise<RateTable>;

/** Converts between currencies with rates it fetches once per base currency and keeps for `maxAgeMs`. */
export class Converter {
  readonly #load: Loader;
  readonly #maxAgeMs: number;
  readonly #tables = new Map<string, { at: number; table: Promise<RateTable> }>();

  constructor(options: { load?: Loader; maxAgeMs?: number } = {}) {
    this.#load = options.load ?? (base => fetchRates(base));
    this.#maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000;
  }

  /** A converter that never fetches, for offline use and tests. */
  static withRates(table: RateTable): Converter {
    return new Converter({ load: async () => table, maxAgeMs: Number.POSITIVE_INFINITY });
  }

  async convert(money: Money, to: string, mode?: RoundingMode): Promise<Money> {
    const table = await this.table(money.currency.code);
    return table.convert(money, to, mode);
  }

  /** The rates for `base`: the ones already fetched while they are fresh, otherwise fetched again. A failed fetch is not kept. */
  async table(base: string, now: number = Date.now()): Promise<RateTable> {
    const cached = this.#tables.get(base);
    if (cached && now - cached.at < this.#maxAgeMs) return cached.table;
    const table = this.#load(base);
    this.#tables.set(base, { at: now, table });
    try {
      return await table;
    } catch (error) {
      this.#tables.delete(base);
      throw error;
    }
  }
}
