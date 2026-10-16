import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Converter, Money, RateTable } from '../src';
import { fetchRates } from '../src/exchange/provider';

jest.mock('../src/exchange/provider');
const fetched = jest.mocked(fetchRates);

describe('Converter', () => {
  const dollars = new RateTable('USD', { EUR: 0.92, JPY: 151.25 }, new Date('2026-09-30T00:00:00Z'));

  beforeEach(() => {
    fetched.mockReset();
    fetched.mockResolvedValue(dollars);
  });

  it('converts with the rates it fetched', async () => {
    const converter = new Converter();
    const price = Money.of('19.99', 'USD');
    const converted = await converter.convert(price, 'JPY');
    expect(converted.toDecimal()).toBe('3023');
    expect(fetched).toHaveBeenCalledWith('USD');
  });

  it('fetches the rates for a base currency once', async () => {
    const converter = new Converter();
    await converter.convert(Money.of(1, 'USD'), 'EUR');
    await converter.convert(Money.of(2, 'USD'), 'EUR');
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('fetches again once the rates are older than maxAgeMs', async () => {
    const converter = new Converter({ maxAgeMs: 1000 });
    await converter.table('USD', 0);
    await converter.table('USD', 500);
    await converter.table('USD', 1500);
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it('forgets a failed fetch', async () => {
    fetched.mockRejectedValueOnce(new Error('offline'));
    const converter = new Converter();
    await expect(converter.table('USD')).rejects.toThrow('offline');
    await expect(converter.table('USD')).resolves.toBe(dollars);
  });

  it('converts offline with fixed rates', async () => {
    const offline = Converter.withRates(dollars);
    const converted = await offline.convert(Money.of('10', 'USD'), 'EUR');
    expect(converted.toDecimal()).toBe('9.20');
    expect(fetched).not.toHaveBeenCalled();
  });
});
