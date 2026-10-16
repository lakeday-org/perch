import type { Money } from './money';
import type { RoundingMode } from './types';

/** `principal` grown by `ratePercent` each period for `periods` periods, rounded every period as a bank statement is. */
export function compound(principal: Money, ratePercent: number, periods: number, mode: RoundingMode = 'half-even'): Money {
  if (!Number.isInteger(periods) || periods < 0) throw new RangeError('periods must be a whole number');
  let balance = principal;
  for (let period = 0; period < periods; period++) balance = balance.add(balance.multiply(ratePercent / 100, mode));
  return balance;
}

/** Interest on `principal` at `ratePercent` a period, not compounded. */
export function simpleInterest(principal: Money, ratePercent: number, periods: number): Money {
  return principal.multiply((ratePercent / 100) * periods);
}

/** The yearly rate a nominal rate compounded `periodsPerYear` times comes to, in percent. */
export function effectiveAnnualRate(nominalPercent: number, periodsPerYear: number): number {
  return ((1 + nominalPercent / 100 / periodsPerYear) ** periodsPerYear - 1) * 100;
}
