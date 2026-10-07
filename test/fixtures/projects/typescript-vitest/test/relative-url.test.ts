import { describe, expect, it, vi } from 'vitest';
import { Url } from '../src';

vi.mock('../src/env', () => ({ currentOrigin: () => 'https://app.example.com' }));

describe('Url in a browser', () => {
  it('resolves a relative URL against the page origin', () => {
    expect(new Url('/settings?tab=billing').toString()).toBe('https://app.example.com/settings?tab=billing');
  });

  it('resolves a protocol-relative URL', () => {
    expect(new Url('//cdn.example.com/app.js').toString()).toBe('https://cdn.example.com/app.js');
  });
});
