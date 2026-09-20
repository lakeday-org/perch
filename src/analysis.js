/** Tree-sitter analysis of tracked source files: per-method metrics plus the calls and imports that link them. */
import { createRequire as makeRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createAnalyzer } from './treesitter/index.ts';
import { sha256 } from './store.js';

const resolveModule = makeRequire(import.meta.url);

/**
 * Extensions perch reads, and the grammar each one is parsed with. Every language here was checked against the analyzer: the parser
 * loads, named methods come back with the right names, and the metrics are computed. Languages whose grammar splits a signature from
 * its body (Dart), or whose functions are macro calls (Elixir), are left out because a method cannot be spliced back as one region.
 */
const languages = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python', pyi: 'python', rs: 'rust', go: 'go',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', sc: 'scala', groovy: 'groovy', gradle: 'groovy',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cs: 'c_sharp',
  rb: 'ruby', rake: 'ruby', php: 'php', phtml: 'php', lua: 'lua', swift: 'swift', zig: 'zig', sol: 'solidity',
  sh: 'bash', bash: 'bash',
};
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
  !/(^|\/)(vendor|node_modules|dist|target|\.git|\.perch|\.lakeday|build|coverage)(\/|$)/.test(item.path) &&
  !/\.min\.(?:[cm]?[jt]s|[jt]sx)$/.test(item.path);

export const testFile = path => /(^|\/)(tests?|__tests__)(\/|\.)|\.test\.|\.spec\./.test(path);

/** Five of the thirty tree-sitter returns. These are the ones read back: the risk a walk orders by, and the line a finding
 * shows under the code. Keeping the rest would carry a metrics object nothing looks at onto every row of every scan. */
const trim = metrics => metrics ? { risk_score: metrics.risk_score, maintainability_index: metrics.maintainability_index, cyclomatic_complexity: metrics.cyclomatic_complexity, max_nesting: metrics.max_nesting, sloc: metrics.sloc } : null;

/** Named methods of one file, each with a stable id and a hash of its own source. */
function methodsOf(path, declarations, lines) {
  const seen = new Map(), methods = [];
  for (const declaration of declarations) {
    if (declaration.name === '<anonymous>') continue;
    const base = `${path}::${declaration.qualified_name}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    methods.push({ id: count > 1 ? `${base}#${count}` : base, node: declaration.id, name: declaration.name, qualified_name: declaration.qualified_name, line: declaration.line, end_line: declaration.end_line,
      hash: sha256(lines.slice(declaration.line - 1, declaration.end_line).join('\n')), metrics: trim(declaration.metrics) });
  }
  return methods;
}

/** The named method whose range contains a line, innermost first; anonymous functions attribute to their enclosing method. */
function ownerAt(methods, line) {
  let owner = null;
  for (const method of methods) {
    if (method.line <= line && line <= method.end_line && (!owner || method.end_line - method.line < owner.end_line - owner.line)) owner = method;
  }
  return owner?.id ?? null;
}

/** Analyze every file, returning coverage counts, per-file method and reference records, and every method ranked by risk. */
export async function analyzeFiles(files, { analyzer, readSource, progress = () => {}, debug = () => {} }) {
  const coverage = { supported: files.length, parsed: 0, parse_failures: 0, parser_diagnostics: [] };
  let functions = 0;
  const analyzed = [], candidates = [];
  for (const [index, file] of files.entries()) {
    const source = await readSource(file, index);
    progress(functions, null);
    // Parsing is synchronous, so a whole tree of it holds the loop and nothing on a clock runs. One yield per file is the
    // difference between a counter that looks alive and one that looks hung.
    await new Promise(resolve => setImmediate(resolve));
    const analysis = await analyzer.analyzeSource(source, languageOf(file.path));
    if (!['parsed', 'parse-error'].includes(analysis.parser_status)) throw new Error(`Parser unavailable for ${file.path}: ${analysis.parser_message}`);
    if (analysis.parser_status !== 'parsed') {
      coverage.parse_failures++;
      if (coverage.parser_diagnostics.length < 20)
        coverage.parser_diagnostics.push({ path: file.path, status: analysis.parser_status, message: analysis.parser_message, diagnostics: analysis.diagnostics?.slice(0, 8) });
      continue;
    }
    coverage.parsed++;
    functions += analysis.declarations.length;
    const methods = methodsOf(file.path, analysis.declarations, source.split('\n'));
    const byNode = new Map(methods.map(method => [method.node, method.id]));
    const calls = analysis.references.filter(reference => reference.kind === 'call' && reference.name !== '<dynamic>')
      .map(reference => ({ name: reference.name, from: byNode.get(reference.source) ?? ownerAt(methods, reference.line), line: reference.line })).filter(call => call.from);
    // A function handed to something else to call later: the edge no call site would show.
    const values = analysis.references.filter(reference => reference.kind === 'value')
      .map(reference => ({ name: reference.name, from: byNode.get(reference.source) ?? ownerAt(methods, reference.line), line: reference.line })).filter(value => value.from);
    const imports = analysis.references.filter(reference => reference.kind === 'import' && reference.imported_name)
      .map(reference => ({ module: reference.module, name: reference.imported_name, alias: reference.alias ?? reference.imported_name }));
    const test = testFile(file.path);
    debug(`analyzed ${file.path} (risk ${analysis.metrics?.risk_score?.toFixed?.(1) ?? '?'}, ${methods.length} methods)`);
    analyzed.push({ path: file.path, blob: file.sha, language: languageOf(file.path), test, metrics: trim(analysis.metrics), methods, calls, values, imports });
    if (!test) for (const method of methods) candidates.push({ id: method.id, score: method.metrics?.risk_score ?? 0 });
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { coverage, functions, files: analyzed, candidates };
}
