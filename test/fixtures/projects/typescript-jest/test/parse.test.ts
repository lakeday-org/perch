import { describe, expect, it } from '@jest/globals';
import { InvalidAmountError, normalizeSeparators, parseMoney, UnknownCurrencyError } from '../src';

describe('parseMoney', () => {
  it.each([
    ['$1,234.56', 'USD', '1234.56'],
    ['-¥500', 'JPY', '-500'],
    ['1.234,56 EUR', 'EUR', '1234.56'],
    ['CA$ 9.99', 'CAD', '9.99'],
    ['(£12.00)', 'GBP', '-12.00'],
  ])('reads %s', (input, code, amount) => {
    const money = parseMoney(input);
    expect(money.currency.code).toBe(code);
    expect(money.toDecimal()).toBe(amount);
  });

  it('reads a bare number in the fallback currency', () => {
    const money = parseMoney('12.5', 'EUR');
    expect(money.toDecimal()).toBe('12.50');
  });

  it('needs a currency from somewhere', () => {
    expect(() => parseMoney('12.50')).toThrow(InvalidAmountError);
  });

  it('rejects a currency code it does not know', () => {
    expect(() => parseMoney('12 XXX')).toThrow(UnknownCurrencyError);
  });
});

describe('normalizeSeparators', () => {
  it('treats a lone comma before three digits as grouping', () => {
    expect(normalizeSeparators('1,234')).toBe('1234');
  });

  it('treats the last separator before fewer digits as the decimal point', () => {
    expect(normalizeSeparators("1'234,5")).toBe('1234.5');
  });
});
