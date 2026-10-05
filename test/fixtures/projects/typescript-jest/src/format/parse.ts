import { Currency } from '../currency';
import { InvalidAmountError } from '../errors';
import { ISO_4217 } from '../generated/iso4217';
import { Money } from '../money';

const BY_SYMBOL = [...ISO_4217].sort((a, b) => b.symbol.length - a.symbol.length);

/**
 * `1,234.56` and `1.234,56` both as `1234.56`. The last separator is the decimal point unless three digits follow it and it is
 * a comma with no point anywhere, or it appears more than once.
 */
export function normalizeSeparators(text: string): string {
  const cleaned = text.replace(/[\s'_]/g, '');
  const last = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
  if (last === -1) return cleaned;
  const separator = cleaned[last];
  const places = cleaned.length - last - 1;
  const repeated = cleaned.indexOf(separator) !== last;
  if (places === 3 && (repeated || (separator === ',' && !cleaned.includes('.')))) return cleaned.replace(/[.,]/g, '');
  return `${cleaned.slice(0, last).replace(/[.,]/g, '')}.${cleaned.slice(last + 1)}`;
}

/**
 * Reads an amount as people write one: `$1,234.56`, `-¥500`, `(£12.00)`, `1.234,56 EUR` or `CA$ 9.99`. A bare number is in
 * `fallback`, and without one it is an error.
 */
export function parseMoney(input: string, fallback?: string): Money {
  let text = input.trim();
  const negative = text.startsWith('-') || (text.startsWith('(') && text.endsWith(')'));
  if (negative) text = text.replace(/^-|^\(|\)$/g, '').trim();
  let currency: Currency | undefined;
  const code = /^[A-Z]{3}\b|\b[A-Z]{3}$/.exec(text)?.[0];
  if (code) {
    currency = Currency.of(code);
    text = text.replace(code, '').trim();
  } else {
    const known = BY_SYMBOL.find(item => text.startsWith(item.symbol));
    if (known) {
      currency = Currency.of(known.code);
      text = text.slice(known.symbol.length).trim();
    }
  }
  if (!currency && fallback) currency = Currency.of(fallback);
  if (!currency) throw new InvalidAmountError(input, 'no currency symbol or code, and no fallback currency');
  const money = Money.of(normalizeSeparators(text), currency.code);
  return negative ? money.negate() : money;
}
