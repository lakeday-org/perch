import { describe, expect, it, test } from 'vitest';
import { decode, encode, isEncoded } from '../src';

describe('encode', () => {
  test.each([
    { input: 'hello world', want: 'hello%20world' },
    { input: "it's (fine)*", want: 'it%27s%20%28fine%29%2A' },
    { input: 'café', want: 'caf%C3%A9' },
    { input: 'a-b_c.d~e', want: 'a-b_c.d~e' },
  ])('encodes $input', ({ input, want }) => {
    expect(encode(input)).toBe(want);
  });
});

describe('decode', () => {
  it('turns plus signs into spaces', () => {
    expect(decode('a+b+c')).toBe('a b c');
  });

  it('decodes what it can of a broken sequence', () => {
    expect(decode('%E2%9C%93 and %ZZ')).toBe('✓ and %ZZ');
  });

  it('tells an encoded string from a plain one', () => {
    expect(isEncoded('a%20b')).toBe(true);
    expect(isEncoded('a b')).toBe(false);
  });
});
