import pack from '@xberg-io/tree-sitter-language-pack';
import type { ProcessResult, StructureItem } from '@xberg-io/tree-sitter-language-pack';
import { PARSE_VERSION, type AnalyzeOptions, type Analyzer, type Declaration, type Mock, type SourceAnalysis, type SourceSummary } from './types';
import { downloading, normalizeLanguage } from './languages';
import { Node } from './node';
import { functionDepth, functionName, isComment, isFunction, isNamed, nonblankRows, parentFunctionName, qualityMetrics, qualifiedFunctionName, location, measure } from './metrics';
import { referenceVisitor } from './references';
import { walk, type SyntaxIndex } from './visit';
import { measureComplexity } from './complexity';
import { hasSyntaxError, internalLinkage } from './extensions';
import { findTests, type FoundTest } from './tests';

function unavailable(language: string, status: 'unsupported' | 'resource-unavailable', message: string): SourceAnalysis {
  return { profile: PARSE_VERSION, language, parser_status: status, parser_message: message,
    metrics: null, declarations: [], top_level: [], references: [], diagnostics: [{ kind: status === 'unsupported' ? 'unsupported' : 'resource', message, location: null }],
    truncated: { declarations: false, references: false, diagnostics: false }, package: null, mocks: [] };
}

/**
 * Where declarations beside a test are test code: a test class, a describe callback, a namespace or file of tests, and Rust's
 * `#[cfg(test)] mod tests`. What holds tests makes what holds it test code too, a test class its file, except a Rust module:
 * a file with a test module in it is a source file with its tests inside.
 */
const CONTAINERS = new Set(['class_definition', 'class_declaration', 'class_specifier', 'struct_specifier', 'object_declaration', 'object_definition', 'trait_definition',
  'record_declaration', 'enum_declaration', 'interface_declaration', 'namespace_definition', 'impl_item', 'mod_item', 'object_literal', 'protocol_declaration', 'extension_declaration',
  // Ruby's class and module.
  'class', 'module']);

function testHolders(root: Node, cases: Map<string, FoundTest>, suites: Array<{ start: number; end: number }>, index: SyntaxIndex): Set<string> {
  const key = (node: Node) => `${node.startIndex}:${node.endIndex}`;
  const suite = new Set(suites.map(item => `${item.start}:${item.end}`));
  const holderOf = (node: Node): Node => {
    // A Zig test block sits beside the code it tests, at the top of the file or in a struct, as Zig writes them. It holds its own
    // test code and makes nothing around it test code.
    if (node.type === 'TestDecl') return node;
    for (let parent = node.parent; parent; parent = parent.parent) if (!parent.parent || CONTAINERS.has(parent.type) || suite.has(key(parent))) return parent;
    return root;
  };
  const held = new Set<string>();
  for (const node of [...cases.keys(), ...suite].flatMap(span => index.spanned(span))) {
    for (let holder: Node | null = holderOf(node); holder && !held.has(key(holder)); holder = holder.parent && holder.type !== 'mod_item' ? holderOf(holder) : null) {
      held.add(key(holder));
    }
  }
  return held;
}

/** Whether a declaration is test code: inside something that holds tests, or a pytest fixture, which pytest calls for a test. */
function supportsTests(node: Node, held: Set<string>, language: string): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) if (held.has(`${parent.startIndex}:${parent.endIndex}`)) return true;
  const decorated = language === 'python' && node.parent?.type === 'decorated_definition' ? node.parent : null;
  return Boolean(decorated?.namedChildren.some(item => item.type === 'decorator' && /^@(?:pytest\.)?fixture\b/.test(item.text)));
}

/**
 * Native callable nodes extend the pack's structure records with call ownership and risk measurements. A test case takes the name
 * it is known by, its title or its macro's arguments, and whatever is declared inside it is qualified by that name.
 */
function declarationsOf(items: StructureItem[], nodes: Map<string, Node>, language: string, nonblank: Set<number>, cases: Map<string, FoundTest>, blockMacros: ReadonlySet<string>, held: Set<string>, index: SyntaxIndex): Declaration[] {
  const result: Declaration[] = [];
  const found = (node: Node) => cases.get(`${node.startIndex}:${node.endIndex}`) ?? null;
  const renamed = (node: Node) => found(node)?.qualified ?? null;
  // An id is a start byte, so an enclosing node that starts where this one does has its id. Naming it as the parent made the
  // owner walk in analysis.js loop forever.
  const parentId = (node: Node) => {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (parent.startIndex !== node.startIndex && (isFunction(parent) || found(parent))) return `function:${parent.startIndex}`;
    return null;
  };
  for (const item of items) {
    if (['Function', 'Method', 'Constructor'].includes(item.kind?.type ?? '')) {
      const span = item.span!;
      const node = nodes.get(`${span.startByte}:${span.endByte}`);
      if (!node) throw new Error(`No syntax node for declaration ${item.name} at ${span.startByte}`);
      // A C or C++ prototype, `int parse(const char *text);` in a header, is a declaration and not a definition: it has no body
      // to measure or ask about, and counted as a definition it made every function a header declares ambiguous to the linker.
      if ((language === 'c' || language === 'cpp') && node.type === 'declaration') continue;
      // A declaration the parser could not read whole is not offered as a method; the ones around it still are. Nested
      // declarations are read on their own, since a broken outer function says nothing about an inner one.
      if (hasSyntaxError(node, blockMacros, index)) { result.push(...declarationsOf(item.children ?? [], nodes, language, nonblank, cases, blockMacros, held, index)); continue; }
      const test = found(node);
      result.push({ id: `function:${node.startIndex}`, kind: 'function', syntax_kind: node.type,
        name: test?.test.name ?? (['kotlin', 'cpp', 'solidity', 'lua'].includes(language) ? functionName(node) : item.name ?? '<anonymous>'),
        qualified_name: qualifiedFunctionName(node, renamed), parent_function: parentFunctionName(node, renamed), parent_id: parentId(node),
        function_depth: functionDepth(node), line: span.startLine! + 1,
        end_line: Math.max(span.startLine! + 1, span.endLine! + (span.endColumn! > 0 ? 1 : 0)),
        location: location(node), metrics: qualityMetrics(measure(node, true, nonblank, index), measureComplexity(node, language, true, index)),
        test: test?.test ?? null, internal: internalLinkage(node, language),
        ...(!test && supportsTests(node, held, language) ? { support: true } : {}),
        // `fun String.size()` is a top-level function called as a member of whatever receiver it names, not a class's method.
        ...(language === 'kotlin' && node.childForFieldName('receiver') ? { extension: true } : {}) });
    }
    result.push(...declarationsOf(item.children ?? [], nodes, language, nonblank, cases, blockMacros, held, index));
  }
  return result;
}

/** The 1-based number of a node's last line. A node that ends at the start of a line ends on the line before it. */
const lastLine = (node: Node): number => node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0);

/**
 * Whether a line holds nothing but punctuation, comments and the keywords that close the nodes around named functions: the `}`
 * of a class, the `})();` after a callback, the `end` of a Ruby module. A name, a literal or a keyword of its own, like Python's
 * `pass`, is code.
 */
function onlyCloses(root: Node, line: number, around: Set<string>): boolean {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.startPosition.row + 1 > line || lastLine(node) < line || node.endIndex <= node.startIndex || isComment(node)) continue;
    if (node.childCount) { for (let index = 0; index < node.childCount; index++) stack.push(node.child(index)!); continue; }
    if (node.isNamed || (/\w/.test(node.text) && !around.has(node.parent?.id ?? ''))) return false;
  }
  return true;
}

/**
 * Returns the line numbers outside every named function. The first line of a node that contains a named function, such as a
 * class declaration, is left out too, since it only opens it, and so is its last line when that only closes it. A Python class
 * has nothing to close it, so its last line is a statement of the class and stays.
 */
function topLevelLines(root: Node, declarations: Declaration[], nodes: Map<string, Node>, lines: number): number[] {
  const held = new Set<number>(), around = new Set<string>(), ends = new Set<number>();
  for (const declaration of declarations) {
    if (!isNamed(declaration.qualified_name)) continue;
    for (let line = declaration.line; line <= declaration.end_line; line++) held.add(line);
    let parent = nodes.get(`${declaration.location.start.byte}:${declaration.location.end.byte}`)?.parent ?? null;
    // A node seen before had everything above it seen with it.
    for (; parent && parent.id !== root.id && !around.has(parent.id); parent = parent.parent) {
      around.add(parent.id);
      held.add(parent.startPosition.row + 1);
      ends.add(lastLine(parent));
    }
  }
  for (const line of ends) if (!held.has(line) && onlyCloses(root, line, around)) held.add(line);
  return Array.from({ length: lines }, (_, index) => index + 1).filter(line => !held.has(line));
}

function analysisOf(root: Node, language: string, built: ProcessResult, path: string | null): SourceAnalysis {
  const nodes = new Map<string, Node>();
  const structure = [...(built.structure ?? [])];
  const wanted = new Set<string>();
  const remember = (items: StructureItem[]) => { for (const item of items) { wanted.add(`${item.span!.startByte}:${item.span!.endByte}`); remember(item.children ?? []); } };
  remember(structure);
  // The one walk of the file. References are read on the way; the functions the pack's structure leaves out are noted; every
  // later stage reads the index it leaves instead of walking again.
  const references = referenceVisitor(language), functions: Node[] = [];
  const index = walk(root, [references, { enter: node => { if (isFunction(node)) functions.push(node); } }]);
  const tests = findTests(root, language, path, index);
  const declare = (node: Node) => {
    const start = node.startPosition, end = node.endPosition;
    structure.push({ kind: { type: 'Function' }, name: functionName(node),
      span: { startByte: node.startIndex, endByte: node.endIndex, startLine: start.row, endLine: end.row, startColumn: start.column, endColumn: end.column }, children: [] });
    wanted.add(`${node.startIndex}:${node.endIndex}`);
  };
  // A Catch2 test body is a block to the grammar, not a function, so nothing else would make it a declaration.
  for (const body of tests.bodies) if (!wanted.has(`${body.startIndex}:${body.endIndex}`)) declare(body);
  for (const node of functions) if (!wanted.has(`${node.startIndex}:${node.endIndex}`)) declare(node);
  // The innermost node with a declaration's span is the declaration's node.
  for (const key of wanted) { const same = index.spanned(key); if (same.length) nodes.set(key, same[same.length - 1]); }
  const syntaxError = hasSyntaxError(root, tests.blockMacros, index);
  const nonblank = nonblankRows(root);
  const held = testHolders(root, tests.cases, tests.suites, index);
  const declarations = declarationsOf(structure, nodes, language, nonblank, tests.cases, tests.blockMacros, held, index).sort((a, b) => a.location.start.byte - b.location.start.byte);
  const diagnostics = (syntaxError ? built.diagnostics ?? [] : []).map(item => ({ kind: 'syntax' as const, message: item.message!,
    location: item.span ? { start: { line: item.span.startLine! + 1, column: item.span.startColumn! + 1, byte: item.span.startByte! },
      end: { line: item.span.endLine! + 1, column: item.span.endColumn! + 1, byte: item.span.endByte! } } : null }));
  const measurement = measure(root, false, nonblank, index);
  measurement.sloc = built.metrics!.codeLines!;
  measurement.comment_lines = built.metrics!.commentLines!;
  if (syntaxError && !diagnostics.length) diagnostics.push({ kind: 'syntax', message: 'Syntax error in source', location: location(root) });
  // tree-sitter recovers locally, so a tree with an error in it still holds the declarations the error did not touch. Dropping
  // the file for one bad line, in any language, cost every method in it: a Flow import, a Groovy wildcard import, a C attribute
  // macro. The file is a parse error only when nothing in it can be read.
  return { profile: PARSE_VERSION, language, parser_status: syntaxError && !declarations.length ? 'parse-error' : 'parsed',
    parser_message: diagnostics[0]?.message ?? null,
    metrics: qualityMetrics(measurement, measureComplexity(root, language, false, index)),
    declarations,
    top_level: topLevelLines(root, declarations, nodes, root.endPosition.row + 1),
    // The pack's import records do not expose every binding/alias or call site. This extractor adds those graph edges.
    references: references.finish(index), diagnostics,
    truncated: { declarations: false, references: false, diagnostics: false },
    package: tests.package, mocks: tests.mocks satisfies Mock[], default_export: defaultExport(root, language), suites: tests.suites };
}

const DEFAULT_EXPORTERS = new Set(['javascript', 'typescript', 'tsx']);
const NAMED_DECLARATIONS = new Set(['function_declaration', 'generator_function_declaration', 'class_declaration', 'function_expression', 'class']);

/**
 * The name a JavaScript module's default export is defined under: `export default function f`, `export default f`, or CommonJS's
 * `module.exports = f`. `import f from "./m"` and `const f = require("./m")` bind this, whatever name the importer gives it.
 * A Lua module is what its chunk returns: `return M` after `function M.total()` makes `require("cart").total` that function.
 */
function defaultExport(root: Node, language: string): string | null {
  if (language === 'lua') {
    const returned = root.namedChildren.filter(item => item.type === 'return_statement').at(-1)?.namedChildren[0]?.namedChildren[0];
    return returned?.type === 'identifier' ? returned.text : null;
  }
  if (!DEFAULT_EXPORTERS.has(language)) return null;
  const named = (node: Node | null) => (node?.type === 'identifier' ? node.text
    : node && NAMED_DECLARATIONS.has(node.type) ? node.childForFieldName('name')?.text ?? null : null);
  for (const item of root.namedChildren) {
    if (item.type === 'export_statement' && Array.from({ length: item.childCount }, (_, index) => item.child(index)).some(part => part?.type === 'default')) {
      const found = named(item.childForFieldName('declaration')) ?? named(item.childForFieldName('value'));
      if (found) return found;
    }
    // `exports = module.exports = createApplication` assigns through a chain; the last value is what the module is.
    let assignment = item.type === 'expression_statement' ? item.namedChildren[0] : null, exported = false;
    while (assignment?.type === 'assignment_expression') {
      exported ||= assignment.childForFieldName('left')?.text === 'module.exports';
      const right = assignment.childForFieldName('right');
      if (right?.type !== 'assignment_expression') { const found = exported ? named(right) : null; if (found) return found; break; }
      assignment = right;
    }
  }
  return null;
}

class LanguagePackAnalyzer implements Analyzer {
  public async analyzeSource(source: string, language: string, options: AnalyzeOptions = {}): Promise<SourceAnalysis> {
    const normalized = normalizeLanguage(language);
    if (!normalized) return unavailable(language, 'unsupported', `No language-pack grammar is registered for ${language}`);
    try {
      const parser = downloading(() => pack.getParser(normalized));
      const tree = parser.parse(source);
      if (!tree) throw new Error('Language pack returned no syntax tree');
      const built = downloading(() => pack.process(source, { language: normalized, structure: true, imports: true, diagnostics: true }));
      return analysisOf(new Node(tree.rootNode(), Buffer.from(source)), normalized, built, options.path ?? null);
    } catch (error) {
      return unavailable(normalized, 'resource-unavailable', error instanceof Error ? error.message : String(error));
    }
  }

  public async analyzeSummary(source: string, language: string, options: AnalyzeOptions = {}): Promise<SourceSummary> {
    const { declarations, top_level: _topLevel, references: _references, ...summary } = await this.analyzeSource(source, language, options);
    return { ...summary, declaration_count: declarations.length };
  }
}

export function createAnalyzer(): Analyzer { return new LanguagePackAnalyzer(); }
export async function analyzeSource(source: string, language: string, options: AnalyzeOptions = {}): Promise<SourceAnalysis> {
  return createAnalyzer().analyzeSource(source, language, options);
}
