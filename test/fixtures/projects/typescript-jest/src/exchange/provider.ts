import { RateTable, type RatesJSON } from './rates';

export const DEFAULT_ENDPOINT = 'https://rates.example.com/latest';

/** The latest rates for `base` from an ECB-style endpoint. */
export async function fetchRates(base: string, endpoint: string = DEFAULT_ENDPOINT): Promise<RateTable> {
  const response = await fetch(`${endpoint}?from=${encodeURIComponent(base)}`);
  if (!response.ok) throw new Error(`rates request for ${base} failed: ${response.status} ${response.statusText}`);
  return RateTable.fromJSON((await response.json()) as RatesJSON);
}
