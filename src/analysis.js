/** Tree-sitter analysis of tracked source files through the in-tree analyzer package. */
import { createRequire as makeRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createAnalyzer } from '../analysis/src/index.ts';

const resolveModule = makeRequire(import.meta.url);

const languages = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'tsx', rs: 'rust', py: 'python', go: 'go' };
export const languageOf = path => languages[path.split('.').at(-1)];

function assetPath(name) {
  if (name === 'web-tree-sitter.wasm') return resolveModule.resolve('web-tree-sitter/web-tree-sitter.wasm');
  const language = name.slice('tree-sitter-'.length, -'.wasm'.length);
  return resolveModule.resolve(`tree-sitter-wasm/${language}/tree-sitter-${language}.wasm`);
}

export function createSourceAnalyzer() {
  return createAnalyzer({ loadAsset: async name => readFile(assetPath(name)) });
}

export const sourceFile = item => item.type === 'blob' && Boolean(languageOf(item.path)) && item.size <= 1024 * 1024 &&
  !/(^|\/)(vendor|node_modules|dist|target|\.git|\.perch|\.lakeday|build|coverage)(\/|$)/.test(item.path) && !/\.min\.js$/.test(item.path);

export const testFile = path => /(^|\/)(tests?|__tests__)(\/|\.)|\.test\.|\.spec\./.test(path);

/** Analyze every file, returning coverage counts and the ranked candidate list. */
export async function analyzeFiles(files, { analyzer, readSource, limit = 4, log = () => {} }) {
  const coverage = { supported: files.length, parsed: 0, parse_failures: 0, parser_diagnostics: [] };
  let functions = 0;
  const candidates = [];
  for (const file of files) {
    const source = await readSource(file);
    const analysis = await analyzer.analyzeSummary(source, languageOf(file.path));
    if (!['parsed', 'parse-error'].includes(analysis.parser_status)) throw new Error(`Parser unavailable for ${file.path}: ${analysis.parser_message}`);
    if (analysis.parser_status !== 'parsed') {
      coverage.parse_failures++;
      if (coverage.parser_diagnostics.length < 20)
        coverage.parser_diagnostics.push({ path: file.path, status: analysis.parser_status, message: analysis.parser_message, diagnostics: analysis.diagnostics?.slice(0, 8) });
      continue;
    }
    coverage.parsed++;
    functions += analysis.declaration_count;
    log(`analyzed ${file.path} (risk ${analysis.metrics?.risk_score?.toFixed?.(3) ?? '?'}, ${analysis.declaration_count} functions)`);
    if (analysis.declaration_count && source.length <= 32 * 1024 && !testFile(file.path))
      candidates.push({ path: file.path, blob: file.sha, score: analysis.metrics?.risk_score ?? 0, source, analysis: { metrics: analysis.metrics } });
  }
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { coverage, functions, candidates: candidates.slice(0, limit) };
}
