import { beforeAll, describe, expect, it } from '@jest/globals';
import { Money, RateTable } from '../src';

describe('RateTable', () => {
  let rates: RateTable;

  beforeAll(() => {
    rates = RateTable.fromJSON('{"base":"EUR","date":"2026-09-30","rates":{"USD":1.1,"GBP":0.85,"JPY":165.5}}');
  });

  it('reads its date from the JSON', () => {
    expect(rates.asOf.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('gives a rate through the base currency', () => {
    expect(rates.rate('EUR', 'USD')).toBe(1.1);
    expect(rates.rate('USD', 'EUR')).toBeCloseTo(0.909, 3);
  });

  it('converts an amount and rounds it to the target currency', () => {
    const ten = Money.of('10', 'EUR');
    const converted = rates.convert(ten, 'JPY');
    expect(converted.toDecimal()).toBe('1655');
  });

  it('returns the same amount for its own currency', () => {
    const ten = Money.of('10', 'EUR');
    expect(rates.convert(ten, 'EUR')).toBe(ten);
  });

  it('throws on a currency it has no rate for', () => {
    expect(() => rates.rate('EUR', 'CHF')).toThrow(RangeError);
  });

  it('rejects a rate that is not positive', () => {
    expect(() => new RateTable('USD', { EUR: 0 })).toThrow(RangeError);
  });
});
