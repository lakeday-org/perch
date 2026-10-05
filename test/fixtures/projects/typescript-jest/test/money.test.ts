import { beforeAll, describe, expect, it } from '@jest/globals';
import { CurrencyMismatchError, InvalidAmountError, Money } from '../src';

describe.each([
  ['USD', 2, '19.99', 1999n],
  ['JPY', 0, '500', 500n],
  ['BHD', 3, '1.250', 1250n],
] as const)('Money in %s', (code, digits, text, minor) => {
  let amount: Money;

  beforeAll(() => {
    amount = Money.of(text, code);
  });

  it('reads an amount into minor units', () => {
    expect(amount.minor).toBe(minor);
    expect(amount.currency.digits).toBe(digits);
  });

  it('writes the amount back with its own number of places', () => {
    expect(amount.toDecimal()).toBe(text);
  });

  it('adds two amounts', () => {
    const doubled = amount.add(amount);
    expect(doubled.minor).toBe(minor * 2n);
  });

  it('subtracts down to zero', () => {
    const none = amount.subtract(amount);
    expect(none.isZero()).toBe(true);
    expect(none.equals(Money.zero(code))).toBe(true);
  });
});

describe('Money', () => {
  it('reads a number by its decimal digits', () => {
    expect(Money.of(0.1, 'USD').minor).toBe(10n);
    expect(Money.of(1e-7, 'CLF', 'half-up').minor).toBe(0n);
  });

  it('builds from minor units', () => {
    const price = Money.fromMinor(1999, 'USD');
    expect(price.toString()).toBe('19.99 USD');
  });

  it('rejects minor units that are not safe integers', () => {
    expect(() => Money.fromMinor(2 ** 53, 'USD')).toThrow(InvalidAmountError);
  });

  it('refuses more places than the currency has unless told how to round', () => {
    expect(() => Money.of('1.005', 'USD')).toThrow(InvalidAmountError);
    const rounded = Money.of('1.005', 'USD', 'half-even');
    expect(rounded.minor).toBe(100n);
  });

  it('refuses to add two currencies', () => {
    const dollars = Money.of('1', 'USD');
    const euros = Money.of('1', 'EUR');
    expect(() => dollars.add(euros)).toThrow(CurrencyMismatchError);
  });

  it("multiplies with banker's rounding unless told otherwise", () => {
    const price = Money.of('0.25', 'USD');
    expect(price.multiply(0.5).minor).toBe(12n);
    expect(price.multiply(0.5, 'half-up').minor).toBe(13n);
  });

  it('splits an amount without losing a cent', () => {
    const bill = Money.of('100', 'USD');
    const shares = bill.allocate([1, 1, 1]);
    expect(shares.map(share => share.toDecimal())).toEqual(['33.34', '33.33', '33.33']);
  });

  it('compares two amounts', () => {
    const five = Money.of('5', 'EUR');
    const more = Money.of('7.50', 'EUR');
    expect(five.compare(more)).toBe(-1);
    expect(more.compare(five)).toBe(1);
    expect(five.compare(five)).toBe(0);
  });

  it('sums a list of amounts', () => {
    const total = Money.sum([Money.of('1.10', 'GBP'), Money.of('2.20', 'GBP')]);
    expect(total.toDecimal()).toBe('3.30');
    expect(() => Money.sum([])).toThrow(RangeError);
  });

  it('serializes to JSON as a decimal string', () => {
    expect(JSON.stringify(Money.of('19.99', 'USD'))).toBe('{"amount":"19.99","currency":"USD"}');
  });
});
