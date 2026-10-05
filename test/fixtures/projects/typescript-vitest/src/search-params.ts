import { decodeComponent, encodeComponent } from './encode';
import { splitPair } from './parse';

type Init = string | Record<string, string | string[]> | Iterable<readonly [string, string]>;

/** An ordered list of query parameters, as the WHATWG URLSearchParams, without depending on a global one. */
export class SearchParams implements Iterable<[string, string]> {
  #entries: Array<[string, string]> = [];

  constructor(init?: Init) {
    if (typeof init === 'string') {
      const query = init.startsWith('?') ? init.slice(1) : init;
      for (const pair of query.split('&')) {
        if (!pair) continue;
        const [key, value] = splitPair(pair);
        this.#entries.push([decodeComponent(key), decodeComponent(value ?? '')]);
      }
    } else if (init && Symbol.iterator in init) {
      for (const [key, value] of init as Iterable<readonly [string, string]>) this.#entries.push([key, value]);
    } else if (init) {
      for (const [key, value] of Object.entries(init)) {
        for (const item of Array.isArray(value) ? value : [value]) this.#entries.push([key, item]);
      }
    }
  }

  get size(): number {
    return this.#entries.length;
  }

  append(key: string, value: string | number): this {
    this.#entries.push([key, String(value)]);
    return this;
  }

  /** Replaces every value of `key` with one, where the first of them was. */
  set(key: string, value: string | number): this {
    const at = this.#entries.findIndex(([name]) => name === key);
    if (at === -1) return this.append(key, value);
    this.#entries[at] = [key, String(value)];
    this.#entries = this.#entries.filter(([name], index) => index <= at || name !== key);
    return this;
  }

  get(key: string): string | null {
    return this.#entries.find(([name]) => name === key)?.[1] ?? null;
  }

  getAll(key: string): string[] {
    return this.#entries.filter(([name]) => name === key).map(([, value]) => value);
  }

  has(key: string, value?: string): boolean {
    return this.#entries.some(([name, item]) => name === key && (value === undefined || item === value));
  }

  delete(key: string, value?: string): this {
    this.#entries = this.#entries.filter(([name, item]) => name !== key || (value !== undefined && item !== value));
    return this;
  }

  /** Sorts by key, keeping the order of values under one key. */
  sort(): this {
    this.#entries = this.#entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => (a.entry[0] < b.entry[0] ? -1 : a.entry[0] > b.entry[0] ? 1 : a.index - b.index))
      .map(({ entry }) => entry);
    return this;
  }

  forEach(callback: (value: string, key: string, params: SearchParams) => void): void {
    for (const [key, value] of this.#entries) callback(value, key, this);
  }

  [Symbol.iterator](): Iterator<[string, string]> {
    return this.#entries[Symbol.iterator]();
  }

  toString(): string {
    return this.#entries.map(([key, value]) => `${encodeComponent(key)}=${encodeComponent(value)}`).join('&');
  }
}
