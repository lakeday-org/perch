import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, revision } from '../src/git.js';
import { createSourceAnalyzer, sourceFile } from '../src/analysis.js';
import { analyzeTree } from '../src/analyze.js';
import { fixtureOptions, makeFixture, makeGraphFixture } from './helpers.js';

const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(make = makeFixture) {
  const root = await make();
  cleanups.push(root);
  return { root, revision: await revision(root), out: join(root, '.perch') };
}

describe('source selection', () => {
  it('leaves every minified JavaScript and TypeScript variant out of analysis', () => {
    const extensions = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'];
    for (const extension of extensions) {
      expect(sourceFile({ type: 'blob', path: `src/app.min.${extension}`, size: 100 })).toBe(false);
      expect(sourceFile({ type: 'blob', path: `src/app.${extension}`, size: 100 })).toBe(true);
    }
  });
});

describe('one file that cannot be analyzed', () => {
  it('parses a block with hundreds of thousands of statements', async () => {
    // metrics.ts spread every child of a block into one stack.push call, so a generated function with 200k+ statements threw
    // RangeError, analysis.js read that as the parser being unavailable, and the whole scan ended with zero requests.
    const source = `function generated() {\n${'a = 1;\n'.repeat(220000)}}\n`;
    const result = await analyzer.analyzeSource(source, 'javascript');
    expect(result.parser_status).toBe('parsed');
    expect(result.declarations.map(declaration => declaration.qualified_name)).toContain('generated');
  }, 120_000);

  it('records a file the parser cannot handle as that file\'s failure and reads the rest', async () => {
    const repo = await fixture();
    // Whatever the parser could not do with one file is that file's parse failure. It used to throw out of analyzeTree, so
    // every other file in the repository went unread.
    let failed = 0;
    const failing = { analyzeSource: async (source, language) => {
      if (!source.includes('export function clamp')) return analyzer.analyzeSource(source, language);
      failed++;
      return { parser_status: 'resource-unavailable', parser_message: 'Maximum call stack size exceeded', declarations: [], references: [], diagnostics: [] };
    } };
    const scan = await analyzeTree(fixtureOptions(repo, { analyzer: failing }));
    expect(scan.status).toBe('complete');
    expect(failed).toBe(1);
    expect(scan.coverage.parse_failures).toBe(failed);
    expect(scan.coverage.parser_diagnostics.every(item => item.status === 'resource-unavailable')).toBe(true);
    expect(scan.coverage.parsed).toBeGreaterThan(0);
  });
});

describe('perch scan', () => {
  it('ranks methods at the revision without a worktree or a model', async () => {
    const repo = await fixture();
    const scan = await analyzeTree(fixtureOptions(repo, { analyzer }));
    expect(scan.status).toBe('complete');
    expect(scan.coverage).toMatchObject({ parsed: 2, parse_failures: 0, excluded: 1 });
    expect(scan.candidates.map(candidate => candidate.id)).toEqual(['src/clamp.js::clamp']);
    const [file] = scan.files.filter(file => file.path === 'src/clamp.js');
    expect(file.methods[0]).toMatchObject({ id: 'src/clamp.js::clamp', name: 'clamp', line: 1, end_line: 5 });
    expect(file.methods[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(file.methods[0].metrics.risk_score).toBeTypeOf('number');
    expect(existsSync(join(repo.out, 'workspaces'))).toBe(false);
    expect((await git(['status', '--porcelain'], repo.root)).trim()).toBe('');
    expect((await git(['worktree', 'list', '--porcelain'], repo.root)).match(/^worktree /gm)).toHaveLength(1);

    let analyzed = 0;
    const again = await analyzeTree(fixtureOptions(repo, { analyzer: { analyzeSource: (...args) => { analyzed++; return analyzer.analyzeSource(...args); } } }));
    expect(again.id).toBe(scan.id);
    expect(analyzed).toBe(scan.coverage.supported);
  });

  it('records calls and imports per file and keeps test methods out of the ranking', async () => {
    const repo = await fixture(makeGraphFixture);
    const scan = await analyzeTree(fixtureOptions(repo, { analyzer }));
    const a = scan.files.find(file => file.path === 'src/a.js');
    expect(a.imports).toEqual([{ module: './b.js', name: 'h', alias: 'h' }]);
    expect(a.calls.map(call => `${call.from}>${call.name}`).sort()).toEqual(['src/a.js::f>g', 'src/a.js::f>g', 'src/a.js::f>h', 'src/a.js::f>h']);
    expect(scan.candidates.map(candidate => candidate.id)).not.toContain('test/a.test.js::<anonymous>');
    expect(scan.candidates.every(candidate => candidate.id.startsWith('src/'))).toBe(true);
    expect(scan.candidates[0].id).toBe('src/a.js::f');
  });

  it('limits analysis to --paths', async () => {
    const repo = await fixture();
    const scan = await analyzeTree(fixtureOptions(repo, { analyzer, paths: ['test'] }));
    expect(scan.coverage.parsed).toBe(1);
    expect(scan.candidates).toEqual([]);
    await expect(analyzeTree(fixtureOptions(repo, { analyzer, paths: ['nowhere'] }))).rejects.toThrow('No supported source files');
  });
});
