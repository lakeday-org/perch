import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main, parseArgs } from '../src/cli.js';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('cli', () => {
  it('parses flags and positionals', () => {
    expect(parseArgs(['scan', 'owner/repo', '--fix', '--paths', 'src,lib', '--candidates=2', '--json'])).toEqual({
      flags: { fix: true, paths: 'src,lib', candidates: '2', json: true }, positional: ['scan', 'owner/repo'] });
    expect(() => parseArgs(['scan', '--bogus'])).toThrow('unknown option --bogus');
    expect(() => parseArgs(['scan', '--model'])).toThrow('--model requires a value');
  });

  it('prints usage and reports a missing API key', async () => {
    const out = [], err = [];
    const io = { stdout: text => out.push(text), stderr: text => err.push(text) };
    expect(await main(['--help'], io)).toBe(0);
    expect(out[0]).toContain('perch scan');
    expect(await main(['scan', '.'], { ...io, env: {} })).toBe(1);
    expect(err.at(-1)).toContain('OPENAI_API_KEY');
    expect(await main(['bogus'], io)).toBe(2);
  });

  it('bundles with esbuild into a loadable module', async () => {
    await promisify(execFile)('node', ['build.mjs'], { cwd: root });
    const bundle = await import(new URL('../dist/cli.mjs', import.meta.url).href);
    expect(typeof bundle.main).toBe('function');
  }, 60_000);
});
