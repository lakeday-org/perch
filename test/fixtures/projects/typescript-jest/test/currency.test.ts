import { describe, expect, it } from '@jest/globals';
import { Currency, UnknownCurrencyError } from '../src';

describe('Currency', () => {
  it('looks up an ISO 4217 currency in any case', () => {
    const yen = Currency.of('jpy');
    expect(yen.code).toBe('JPY');
    expect(yen.digits).toBe(0);
    expect(yen.symbol).toBe('¥');
  });

  it('returns the same instance for the same code', () => {
    expect(Currency.of('EUR')).toBe(Currency.of('eur'));
  });

  it('throws on a code it does not know', () => {
    expect(() => Currency.of('XYZ')).toThrow(UnknownCurrencyError);
  });

  it('registers a currency of its own', () => {
    const points = Currency.register(new Currency('PTS', 0, 'pts', 'Loyalty points'));
    expect(Currency.of('PTS')).toBe(points);
  });

  it('will not replace an ISO currency', () => {
    expect(() => Currency.register(new Currency('USD', 2))).toThrow(RangeError);
  });

  it('rejects a malformed code', () => {
    expect(() => new Currency('usd', 2)).toThrow(RangeError);
  });
});
