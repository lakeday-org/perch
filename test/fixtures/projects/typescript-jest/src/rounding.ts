import type { RoundingMode } from './types';

/** `numerator / denominator` rounded to a whole number by `mode`. The denominator must be positive. */
export function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode = 'half-even'): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  // BigInt division truncates toward zero.
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const negative = numerator < 0n;
  const away = negative ? quotient - 1n : quotient + 1n;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  switch (mode) {
    case 'down':
      return quotient;
    case 'up':
      return away;
    case 'ceiling':
      return negative ? quotient : away;
    case 'floor':
      return negative ? away : quotient;
    case 'half-up':
      return twice >= denominator ? away : quotient;
    case 'half-down':
      return twice > denominator ? away : quotient;
    case 'half-even':
      if (twice !== denominator) return twice > denominator ? away : quotient;
      return quotient % 2n === 0n ? quotient : away;
  }
}

/** A number as the exact fraction its decimal digits say: 0.1 is 1/10, not the binary value nearest it. */
export function toFraction(value: number): [bigint, bigint] {
  if (!Number.isFinite(value)) throw new RangeError(`${value} is not a finite number`);
  const [mantissa, exponent = '0'] = value.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  let numerator = BigInt(whole + fraction);
  let denominator = 10n ** BigInt(fraction.length);
  const shift = Number(exponent);
  if (shift > 0) numerator *= 10n ** BigInt(shift);
  else if (shift < 0) denominator *= 10n ** BigInt(-shift);
  return [numerator, denominator];
}
