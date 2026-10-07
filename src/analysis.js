/** Tree-sitter analysis of tracked source files: per-method metrics plus the calls and imports that link them. */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

/**
 * A test file is one the parser found tests in and nothing else: every function in it is a test or test code beside one. What a
 * file is named says nothing; `CartTest.java`, `cart_test.go` and `test_cart.py` are test files for what is in them, and a Rust
 * source file with a test module in it is still a source file.
 */
export const holdsOnlyTests = methods => methods.some(method => method.test) && methods.every(method => method.node === null || method.test || method.support);

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
    // Unnamed: its lines are covered by the method that contains it, or by analysis.top_level. A test case is named by its
    // title, so a JS test callback, anonymous to the grammar, is a method here.
    if (!isNamed(declaration.qualified_name)) continue;
    const name = declaration.name === '<anonymous>' ? declaration.qualified_name.split('.').at(-1) : declaration.name;
    // `branches` are the lines of the method's control-flow structures, read before `trim` drops the rest of the metrics. Only
    // what is true is written: most methods are not tests and have no `internal`.
    add({ node: declaration.id, name, qualified_name: declaration.qualified_name, line: declaration.line, end_line: declaration.end_line, metrics: trim(declaration.metrics),
      branches: declaration.metrics?.branch_lines ?? [], ...(declaration.test ? { test: declaration.test } : {}), ...(declaration.internal ? { internal: true } : {}),
      ...(declaration.support ? { support: true } : {}),
      ...(declaration.extension ? { extension: true } : {}) },
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

/**
 * The named method whose bytes contain a position, innermost first. Bytes rather than lines: a test callback starts on the line
 * of the `it(...)` call that declares it, and that call is not inside the callback.
 */
function ownerAt(spans, byte) {
  let owner = null;
  for (const span of spans) {
    if (span.start <= byte && byte < span.end && (!owner || span.end - span.start < owner.end - owner.start)) owner = span;
  }
  return owner?.id ?? null;
}

/** The test framework's own calls in a suite body: declaring the tests and their hooks is not setup a test makes. */
const FRAMEWORK_CALLS = new Set(['describe', 'context', 'suite', 'it', 'test', 'specify', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'before', 'after', 'vi', 'jest', 'expect',
  // RSpec, Minitest, Pest and busted spell their hooks and stubs in their own words.
  'let', 'let!', 'subject', 'allow', 'receive', 'double', 'instance_double', 'setup', 'teardown', 'uses', 'before_each', 'after_each', 'lazy_setup', 'strict_setup',
  'insulate', 'expose', 'spec', 'pending', 'stub', 'spy', 'mock', 'assert', 'RSpec']);

/** What a binding or a return says a value is: an instance of a type, a call's result, or another local's value. */
const heldBy = reference => reference.held ?? null;

/** One parsed file as the scan keeps it: its methods, and the calls, values, reads, bindings, imports and mocks that link them. */
export function fileRecord(file, source, analysis) {
  const methods = methodsOf(file.path, analysis, source.split('\n'));
  const byNode = new Map(methods.map(method => [method.node, method.id]));
  const parents = new Map(analysis.declarations.map(declaration => [declaration.id, declaration.parent_id]));
  const spans = analysis.declarations.filter(declaration => byNode.has(declaration.id))
    .map(declaration => ({ id: byNode.get(declaration.id), start: declaration.location.start.byte, end: declaration.location.end.byte }));
  /**
   * The named method a reference belongs to. One inside an anonymous function belongs to the method the function is in, found
   * up the tree. One outside every function belongs to the method whose bytes hold it, which is how a Catch2 body, a block to
   * the grammar rather than a function, keeps its calls, and failing that to the file's top-level unit.
   */
  const top = methods.find(method => method.node === null), topLines = new Set(top?.lines ?? []);
  const ownerOf = (source, byte, line) => {
    if (source !== 'file') for (let id = source; id; id = parents.get(id) ?? null) if (byNode.has(id)) return byNode.get(id);
    return (byte === null ? null : ownerAt(spans, byte)) ?? (topLines.has(line) ? top.id : null);
  };
  // A call in a suite's own body, outside every test, is setup: `const html = render(report)` in a describe, or a beforeEach
  // callback. It runs for each test in the suite, so each test makes it. Owned by the file's top-level unit, no test reached it.
  const suites = analysis.suites ?? [];
  const testIds = new Set(methods.filter(method => method.test).map(method => method.id)), testSpans = spans.filter(span => testIds.has(span.id));
  const setupFor = byte => {
    const around = suites.filter(suite => suite.start <= byte && byte < suite.end);
    return around.length ? testSpans.filter(span => around.some(suite => suite.start <= span.start && span.end <= suite.end)).map(span => span.id) : [];
  };
  const calls = analysis.references.filter(reference => reference.kind === 'call' && reference.name !== '<dynamic>').flatMap(reference => {
    const byte = reference.location.start.byte, from = ownerOf(reference.source, byte, reference.line);
    const setup = (!from || from === top?.id) && !FRAMEWORK_CALLS.has(reference.name.split('.')[0]) ? setupFor(byte) : [];
    // What a receiver the tree cannot name holds, when the source says: `Thing::new().get()` is a get of whatever new returns.
    const via = reference.held ?? null;
    return (setup.length ? setup : [from]).filter(Boolean).map(owner => ({ name: reference.name, from: owner, line: reference.line, ...(via ? { via } : {}) }));
  });
  // What the framework calls before a test, its class's setUp or a fixture's SetUp, is a call the test makes.
  for (const method of methods) {
    if (!method.test?.setup) continue;
    for (const name of method.test.setup) calls.push({ name, from: method.id, line: method.line });
    method.test = { ...method.test };
    delete method.test.setup;
  }
  // A function handed to something else to call later: the edge no call site would show.
  const values = analysis.references.filter(reference => reference.kind === 'value')
    .map(reference => ({ name: reference.name, from: ownerOf(reference.source, reference.location.start.byte, reference.line), line: reference.line })).filter(value => value.from);
  // Member access nothing calls, once per name and method: how a method reads its environment or configuration.
  const seen = new Set();
  const reads = analysis.references.filter(reference => reference.kind === 'read')
    .map(reference => ({ name: reference.name, from: ownerOf(reference.source, reference.location.start.byte, reference.line), line: reference.line, ...(reference.held ? { via: reference.held } : {}) }))
    .filter(read => read.from && !seen.has(`${read.from}:${read.name}`) && seen.add(`${read.from}:${read.name}`));
  // What a variable holds and what a function returns, when the source says: how `ledger.post()` is found to be Ledger's post.
  const binds = analysis.references.filter(reference => reference.kind === 'bind')
    .map(reference => ({ name: reference.name, ...heldBy(reference), from: ownerOf(reference.source, reference.location.start.byte, reference.line) }));
  for (const reference of analysis.references.filter(reference => reference.kind === 'returns')) {
    const owner = methods.find(method => method.id === ownerOf(reference.source, reference.location.start.byte, reference.line));
    if (owner && !owner.returns && owner.node !== null) owner.returns = heldBy(reference);
  }
  // Each class's bases, by the name the class goes by here.
  const extended = {};
  for (const reference of analysis.references.filter(reference => reference.kind === 'extends')) (extended[reference.name] ??= []).push(reference.reference);
  const imports = analysis.references.filter(reference => reference.kind === 'import' && reference.imported_name)
    .map(reference => ({ module: reference.module, name: reference.imported_name, alias: reference.alias ?? reference.imported_name, ...(reference.reexport ? { reexport: true } : {}) }));
  // A mock inside an anonymous callback belongs to the method around it, as a call there does. One outside every method, a
  // module-level `vi.mock`, a `@Mock` field, or a `beforeEach` callback, applies to every test in the file.
  const mocks = (analysis.mocks ?? []).map(mock => ({ owner: mock.owner === 'file' ? 'file' : ownerOf(mock.owner, null, null) ?? 'file', target: mock.target, line: mock.line }));
  const test = holdsOnlyTests(methods);
  return { path: file.path, blob: file.sha, language: file.language ?? languageOf(file.path), test, metrics: trim(analysis.metrics), methods, calls, values, reads, imports, package: analysis.package ?? null, mocks,
    ...(analysis.default_export ? { default_export: analysis.default_export } : {}), ...(binds.length ? { binds } : {}), ...(Object.keys(extended).length ? { bases: extended } : {}) };
}

/** Parse one file and read it: its record, or why it could not be read. What a worker thread runs for each file it is given. */
export async function parseFile(file, source, analyzer) {
  const analysis = await analyzer.analyzeSource(source, file.language ?? languageOf(file.path), { path: file.path });
  const diagnostic = { path: file.path, status: analysis.parser_status, message: analysis.parser_message, diagnostics: analysis.diagnostics?.slice(0, 8) };
  if (analysis.parser_status !== 'parsed') return { failed: diagnostic };
  return { record: fileRecord(file, source, analysis), functions: analysis.declarations.length, risk: analysis.metrics?.risk_score ?? null,
    ...(analysis.diagnostics?.length ? { noted: diagnostic } : {}) };
}

/**
 * A process parsing files for analyzeFiles: the bundled perch forked with this flag, which listens instead of running a command.
 * Processes rather than threads: the parser serializes the threads of one process, and nine of them parsed slower than one.
 */
const CHILD_FLAG = '--perch-parse-child';
if (process.argv.includes(CHILD_FLAG) && process.send) {
  const analyzer = createAnalyzer();
  process.on('message', async ({ index, file, source }) => {
    let result;
    try { result = await parseFile(file, source, analyzer); }
    catch (error) { result = { failed: { path: file.path, status: 'resource-unavailable', message: error.message } }; }
    process.send({ index, result });
  });
}

/** Whether this is the bundled perch, the one file a child can load: from source, the TypeScript parser would not load. */
const BUNDLED = import.meta.url.endsWith('.mjs');
/** Below this many files, starting processes costs more than it saves. */
const PARALLEL_FROM = 200;

/**
 * Each file's result, in file order. Sources are read in order, since they stream from one git process, and handed to the next free
 * process; with no workers, or from source, or for a few files, each is parsed here in turn.
 */
async function readAll(files, { analyzer, readSource, workers, progress }) {
  const results = new Array(files.length);
  let functions = 0;
  const done = (index, result) => { results[index] = result; functions += result.functions ?? 0; progress(functions, null); };
  if (workers < 2 || !BUNDLED || files.length < PARALLEL_FROM) {
    for (const [index, file] of files.entries()) {
      const source = await readSource(file, index);
      progress(functions, null);
      // Parsing is synchronous, so a whole tree of it holds the loop and nothing on a clock runs. One yield per file is the
      // difference between a counter that looks alive and one that looks hung.
      await new Promise(resolve => setImmediate(resolve));
      done(index, await parseFile(file, source, analyzer));
    }
    return results;
  }
  const pool = Array.from({ length: Math.min(workers, files.length) }, () => fork(fileURLToPath(import.meta.url), [CHILD_FLAG], { serialization: 'advanced' }));
  let next = 0;
  try {
    await Promise.all(pool.map(child => new Promise((resolve, reject) => {
      const send = async () => {
        if (next >= files.length) { resolve(); return; }
        const index = next++;
        child.send({ index, file: files[index], source: await readSource(files[index], index) });
      };
      child.on('message', ({ index, result }) => { done(index, result); send().catch(reject); });
      child.on('error', reject);
      child.on('exit', code => { if (next < files.length || results.includes(undefined)) reject(new Error(`a parsing process exited with ${code}`)); });
      send().catch(reject);
    })));
  } finally { for (const child of pool) child.kill(); }
  return results;
}

/**
 * Analyze every file, returning coverage counts, per-file method and reference records, and every method ranked by risk. With
 * `workers`, the bundled perch parses in that many processes: one core read OpenClaw's 50,000 files in half an hour.
 */
export async function analyzeFiles(files, { analyzer, readSource, progress = () => {}, debug = () => {}, workers = 0 }) {
  const coverage = { supported: files.length, parsed: 0, parse_failures: 0, parser_diagnostics: [] };
  let functions = 0;
  const analyzed = [], candidates = [];
  for (const result of await readAll(files, { analyzer, readSource, workers, progress })) {
    // The parser being unavailable for one file is that file's failure. It used to end the run with zero requests, so one
    // generated file too large to walk cost every other file its reading. perch doctor lists it with the others.
    if (result.failed) {
      coverage.parse_failures++;
      if (coverage.parser_diagnostics.length < 20) coverage.parser_diagnostics.push(result.failed);
      continue;
    }
    coverage.parsed++;
    // A file read around a syntax error is a parsed file with a note: perch doctor shows the line, and the count says how many.
    if (result.noted) {
      coverage.parsed_with_errors = (coverage.parsed_with_errors ?? 0) + 1;
      if (coverage.parser_diagnostics.length < 20) coverage.parser_diagnostics.push(result.noted);
    }
    functions += result.functions;
    const { record } = result;
    debug(`analyzed ${record.path} (risk ${result.risk?.toFixed?.(1) ?? '?'}, ${record.methods.length} methods)`);
    analyzed.push(record);
    // A test is never read as code under test, including one that lives in a source file (Rust's `#[cfg(test)] mod tests`).
    if (!record.test) for (const method of record.methods) if (!method.test) candidates.push({ id: method.id, score: method.metrics?.risk_score ?? 0 });
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { coverage, functions, files: analyzed, candidates };
}
