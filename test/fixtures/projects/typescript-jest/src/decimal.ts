import { InvalidAmountError } from './errors';
import { divideRounded } from './rounding';
import type { RoundingMode } from './types';

const DECIMAL = /^([+-])?(\d+)(?:\.(\d+))?$/;

/**
 * A decimal string as minor units at `digits` places: '12.34' at 2 is 1234n. More places than that are an error unless a
 * rounding mode says what to do with them.
 */
export function parseDecimal(text: string, digits: number, mode?: RoundingMode): bigint {
  const match = DECIMAL.exec(text.trim());
  if (!match) throw new InvalidAmountError(text, 'not a decimal number');
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length <= digits) {
    const minor = BigInt(whole + fraction.padEnd(digits, '0'));
    return sign === '-' ? -minor : minor;
  }
  if (!mode) throw new InvalidAmountError(text, `more than ${digits} decimal places`);
  const exact = BigInt(`${sign === '-' ? '-' : ''}${whole}${fraction}`);
  return divideRounded(exact, 10n ** BigInt(fraction.length - digits), mode);
}

/** Minor units written as a decimal string with exactly `digits` places: 1234n at 2 is '12.34'. */
export function formatDecimal(minor: bigint, digits: number): string {
  const negative = minor < 0n;
  const text = (negative ? -minor : minor).toString().padStart(digits + 1, '0');
  const whole = text.slice(0, text.length - digits);
  const fraction = digits ? `.${text.slice(-digits)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
