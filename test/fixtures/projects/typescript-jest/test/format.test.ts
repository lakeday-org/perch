import { beforeAll, describe, expect, it } from '@jest/globals';
import { formatMoney, groupDigits, Money } from '../src';

describe('formatMoney', () => {
  let price: Money;
  let refund: Money;

  beforeAll(() => {
    price = Money.of('1234567.5', 'USD');
    refund = Money.of('-42', 'EUR');
  });

  it('writes the symbol and groups thousands', () => {
    expect(formatMoney(price)).toBe('$1,234,567.50');
  });

  it('writes the code instead of the symbol when asked', () => {
    expect(formatMoney(price, { code: true })).toBe('1,234,567.50 USD');
  });

  it('uses the separators it is given', () => {
    expect(formatMoney(price, { grouping: '.', decimal: ',' })).toBe('$1.234.567,50');
  });

  it('puts the sign before the symbol', () => {
    expect(formatMoney(refund)).toBe('-€42.00');
  });

  it('drops trailing zeros down to minimumDigits', () => {
    expect(formatMoney(refund, { minimumDigits: 0 })).toBe('-€42');
  });

  it.skip('groups digits the way the locale does', () => {
    const rupees = Money.of('1234567.5', 'INR');
    expect(formatMoney(rupees, { locale: 'en-IN' } as never)).toBe('₹12,34,567.50');
  });
});

describe('groupDigits', () => {
  it.each([
    ['1', '1'],
    ['1234', '1,234'],
    ['123456', '123,456'],
    ['1234567', '1,234,567'],
  ])('groups %s as %s', (digits, want) => {
    expect(groupDigits(digits, ',')).toBe(want);
  });
});
