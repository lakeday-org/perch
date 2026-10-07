/** How a result between two minor units is rounded. `half-even` is banker's rounding. */
export type RoundingMode = 'half-even' | 'half-up' | 'half-down' | 'up' | 'down' | 'ceiling' | 'floor';

export interface CurrencyData {
  code: string;
  digits: number;
  symbol: string;
  name: string;
}

export interface FormatOptions {
  /** Write the currency's symbol before the number. Defaults to true. */
  symbol?: boolean;
  /** Write the ISO code after the number instead of the symbol. */
  code?: boolean;
  /** Between groups of three digits. Defaults to ",". An empty string writes no grouping. */
  grouping?: string;
  /** Before the fraction. Defaults to ".". */
  decimal?: string;
  /** Drop trailing zeros of the fraction down to this many digits. Defaults to keeping all of them. */
  minimumDigits?: number;
}
