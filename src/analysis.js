/** Tree-sitter analysis of tracked source files: per-method metrics plus the calls and imports that link them. */
import { createAnalyzer, isNamed } from './treesitter/index.ts';
import { sha256 } from './store.js';
import { eligibleFile } from './exclusions.js';
import { languageOf } from './languages.js';
import { shownSource } from './questions.js';

export { languageOf };

export function createSourceAnalyzer() {
  return createAnalyzer();
}

export const sourceFile = item => eligibleFile(item) && Boolean(languageOf(item.path));

export const testFile = path => /(^|\/)(tests?|__tests__)(\/|\.)|\.test\.|\.spec\./.test(path);

/** Five of the thirty tree-sitter returns. These are the ones read back: the risk a walk orders by, and the line a finding
 * shows under the code. Keeping the rest would carry a metrics object nothing looks at onto every row of every scan. */
const trim = metrics => metrics ? { risk_score: metrics.risk_score, maintainability_index: metrics.maintainability_index, cyclomatic_complexity: metrics.cyclomatic_complexity, max_nesting: metrics.max_nesting, sloc: metrics.sloc } : null;

/** What a method's hash covers. Part of a parse's identity, so a parse cached under another definition is not reused. */
export const METHOD_HASH = 'comment-and-body';

const comment = text => /^\s*(\/\/|\/\*|\*|#(?!\s*define)|"""|''')/.test(text);

/** A line that is code: not blank, not a comment, not an import. */
export const isCode = text => Boolean(text.trim()) && !comment(text) && !/^\s*(import|from|use|package)\b|^\s*#\s*include\b/.test(text);

/** The name of the unit that holds a file's code outside named functions. */
export const TOP_LEVEL = '<top-level>';

/**
 * Returns the methods of one file, each with an id and a hash of its source. An unnamed function is not a method; it is read as
 * part of the method that contains it, or as part of the file's top-level unit. The top-level unit is added last, and its
 * `lines` lists the line numbers it covers.
 */
export function methodsOf(path, analysis, lines) {
  const seen = new Map(), methods = [];
  const add = (method, shown) => {
    const base = `${path}::${method.qualified_name}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    methods.push({ id: count > 1 ? `${base}#${count}` : base, ...method, hash: sha256(shown) });
  };
  for (const declaration of analysis.declarations) {
    // Unnamed: its lines are covered by the method that contains it, or by analysis.top_level.
    if (!isNamed(declaration.qualified_name)) continue;
    const name = declaration.name === '<anonymous>' ? declaration.qualified_name.split('.').at(-1) : declaration.name;
    add({ node: declaration.id, name, qualified_name: declaration.qualified_name, line: declaration.line, end_line: declaration.end_line, metrics: trim(declaration.metrics) },
      shownSource(lines, declaration.line, declaration.end_line));
  }
  // A comment directly above a function belongs to that function, not to the top-level unit.
  const described = new Set();
  for (const method of methods) for (let line = method.line - 1; line >= 1 && comment(lines[line - 1]); line--) described.add(line);
  const outside = (analysis.top_level ?? []).filter(line => !described.has(line));
  const code = outside.filter(line => isCode(lines[line - 1] ?? ''));
  if (code.length) {
    const own = outside.filter(line => line >= code[0] && line <= code.at(-1));
    add({ node: null, name: TOP_LEVEL, qualified_name: TOP_LEVEL, line: code[0], end_line: code.at(-1), lines: own, metrics: null }, own.map(line => lines[line - 1]).join('\n'));
  }
  return methods;
}

/** Returns the id of the smallest method containing a line. A top-level unit only contains the lines in its `lines`. */
function ownerAt(methods, line) {
  let owner = null;
  for (const method of methods) {
    if (method.line <= line && line <= method.end_line && (!method.lines || method.lines.includes(line))
      && (!owner || method.end_line - method.line < owner.end_line - owner.line)) owner = method;
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
    // The parser being unavailable for one file is that file's failure. It used to end the run with zero requests, so one
    // generated file too large to walk cost every other file its reading. perch doctor lists it with the others.
    if (analysis.parser_status !== 'parsed') {
      coverage.parse_failures++;
      if (coverage.parser_diagnostics.length < 20)
        coverage.parser_diagnostics.push({ path: file.path, status: analysis.parser_status, message: analysis.parser_message, diagnostics: analysis.diagnostics?.slice(0, 8) });
      continue;
    }
    coverage.parsed++;
    // A file read around a syntax error is a parsed file with a note: perch doctor shows the line, and the count says how many.
    if (analysis.diagnostics?.length) {
      coverage.parsed_with_errors = (coverage.parsed_with_errors ?? 0) + 1;
      if (coverage.parser_diagnostics.length < 20)
        coverage.parser_diagnostics.push({ path: file.path, status: 'parsed', message: analysis.parser_message, diagnostics: analysis.diagnostics.slice(0, 8) });
    }
    functions += analysis.declarations.length;
    const methods = methodsOf(file.path, analysis, source.split('\n'));
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
