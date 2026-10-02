import type { Money } from '../money';
import type { FormatOptions } from '../types';

/** Inserts `separator` between every three digits from the right: '1234567' is '1,234,567'. */
export function groupDigits(digits: string, separator: string): string {
  if (!separator || digits.length <= 3) return digits;
  const head = digits.length % 3 || 3;
  const groups = [digits.slice(0, head)];
  for (let at = head; at < digits.length; at += 3) groups.push(digits.slice(at, at + 3));
  return groups.join(separator);
}

/** `$1,234.50`, or with `code: true` `1,234.50 USD`. The sign goes before the symbol: `-€42.00`. */
export function formatMoney(money: Money, options: FormatOptions = {}): string {
  const grouping = options.grouping ?? ',';
  const decimal = options.decimal ?? '.';
  const text = money.toDecimal();
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  let shown = fraction;
  if (options.minimumDigits !== undefined && shown.length > options.minimumDigits) {
    shown = shown.replace(/0+$/, '').padEnd(options.minimumDigits, '0');
  }
  const number = groupDigits(whole, grouping) + (shown ? decimal + shown : '');
  const sign = negative ? '-' : '';
  if (options.code) return `${sign}${number} ${money.currency.code}`;
  if (options.symbol ?? true) return `${sign}${money.currency.symbol}${number}`;
  return `${sign}${number}`;
}
