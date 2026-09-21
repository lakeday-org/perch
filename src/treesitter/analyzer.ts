import pack from '@xberg-io/tree-sitter-language-pack';
import type { ProcessResult, StructureItem } from '@xberg-io/tree-sitter-language-pack';
import { ANALYSIS_PROFILE, type Analyzer, type Declaration, type SourceAnalysis, type SourceSummary } from './types';
import { normalizeLanguage } from './languages';
import { Node } from './node';
import { functionDepth, functionName, isFunction, parentFunctionName, qualityMetrics, qualifiedFunctionName, location, measure, walkNodes } from './metrics';
import { collectReferences } from './references';
import { measureComplexity } from './complexity';
import { hasSyntaxError } from './extensions';

function unavailable(language: string, status: 'unsupported' | 'resource-unavailable', message: string): SourceAnalysis {
  return { profile: ANALYSIS_PROFILE, language, parser_status: status, parser_message: message,
    metrics: null, declarations: [], references: [], diagnostics: [{ kind: status === 'unsupported' ? 'unsupported' : 'resource', message, location: null }],
    truncated: { declarations: false, references: false, diagnostics: false } };
}

/** Native callable nodes extend the pack's structure records with call ownership and risk measurements. */
function declarationsOf(items: StructureItem[], nodes: Map<string, Node>, language: string): Declaration[] {
  const result: Declaration[] = [];
  for (const item of items) {
    if (['Function', 'Method', 'Constructor'].includes(item.kind?.type ?? '')) {
      const span = item.span!;
      const node = nodes.get(`${span.startByte}:${span.endByte}`);
      if (!node) throw new Error(`No syntax node for declaration ${item.name} at ${span.startByte}`);
      result.push({ id: `function:${node.startIndex}`, kind: 'function', syntax_kind: node.type,
        name: ['kotlin', 'cpp'].includes(language) ? functionName(node) : item.name ?? '<anonymous>', qualified_name: qualifiedFunctionName(node), parent_function: parentFunctionName(node),
        function_depth: functionDepth(node), line: span.startLine! + 1,
        end_line: Math.max(span.startLine! + 1, span.endLine! + (span.endColumn! > 0 ? 1 : 0)),
        location: location(node), metrics: qualityMetrics(measure(node, true), measureComplexity(node, language, true)) });
    }
    result.push(...declarationsOf(item.children ?? [], nodes, language));
  }
  return result;
}

function analysisOf(root: Node, language: string, built: ProcessResult): SourceAnalysis {
  const nodes = new Map<string, Node>();
  const structure = [...(built.structure ?? [])];
  const wanted = new Set<string>();
  const remember = (items: StructureItem[]) => { for (const item of items) { wanted.add(`${item.span!.startByte}:${item.span!.endByte}`); remember(item.children ?? []); } };
  remember(structure);
  for (const node of walkNodes(root)) {
    const key = `${node.startIndex}:${node.endIndex}`;
    if (isFunction(node) && !wanted.has(key)) {
      const start = node.startPosition, end = node.endPosition;
      structure.push({ kind: { type: 'Function' }, name: functionName(node),
        span: { startByte: node.startIndex, endByte: node.endIndex, startLine: start.row, endLine: end.row, startColumn: start.column, endColumn: end.column }, children: [] });
      wanted.add(key);
    }
    if (wanted.has(key)) nodes.set(key, node);
  }
  const syntaxError = hasSyntaxError(root);
  const diagnostics = (syntaxError ? built.diagnostics ?? [] : []).map(item => ({ kind: 'syntax' as const, message: item.message!,
    location: item.span ? { start: { line: item.span.startLine! + 1, column: item.span.startColumn! + 1, byte: item.span.startByte! },
      end: { line: item.span.endLine! + 1, column: item.span.endColumn! + 1, byte: item.span.endByte! } } : null }));
  const measurement = measure(root, false);
  measurement.sloc = built.metrics!.codeLines!;
  measurement.comment_lines = built.metrics!.commentLines!;
  if (syntaxError && !diagnostics.length) diagnostics.push({ kind: 'syntax', message: 'Syntax error in source', location: location(root) });
  return { profile: ANALYSIS_PROFILE, language, parser_status: syntaxError ? 'parse-error' : 'parsed',
    parser_message: diagnostics[0]?.message ?? null,
    metrics: qualityMetrics(measurement, measureComplexity(root, language, false)),
    declarations: declarationsOf(structure, nodes, language).sort((a, b) => a.location.start.byte - b.location.start.byte),
    // The pack's import records do not expose every binding/alias or call site. This extractor adds those graph edges.
    references: collectReferences(root, language), diagnostics,
    truncated: { declarations: false, references: false, diagnostics: false } };
}

class LanguagePackAnalyzer implements Analyzer {
  public async analyzeSource(source: string, language: string): Promise<SourceAnalysis> {
    const normalized = normalizeLanguage(language);
    if (!normalized) return unavailable(language, 'unsupported', `No language-pack grammar is registered for ${language}`);
    try {
      const parser = pack.getParser(normalized);
      const tree = parser.parse(source);
      if (!tree) throw new Error('Language pack returned no syntax tree');
      const built = pack.process(source, { language: normalized, structure: true, imports: true, diagnostics: true });
      return analysisOf(new Node(tree.rootNode(), Buffer.from(source)), normalized, built);
    } catch (error) {
      return unavailable(normalized, 'resource-unavailable', error instanceof Error ? error.message : String(error));
    }
  }

  public async analyzeSummary(source: string, language: string): Promise<SourceSummary> {
    const { declarations, references: _references, ...summary } = await this.analyzeSource(source, language);
    return { ...summary, declaration_count: declarations.length };
  }
}

export function createAnalyzer(): Analyzer { return new LanguagePackAnalyzer(); }
export async function analyzeSource(source: string, language: string): Promise<SourceAnalysis> {
  return createAnalyzer().analyzeSource(source, language);
}
