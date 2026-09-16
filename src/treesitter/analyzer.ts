import { Language, Parser } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";
import {
  ANALYSIS_PROFILE,
  CORE_ASSET,
  type AnalysisDiagnostic,
  type Analyzer,
  type AnalyzerOptions,
  type Declaration,
  type ParserResources,
  type SourceAnalysis,
  type SourceSummary,
  type WasmAsset,
} from "./types";
import {
  languageDefinition,
  normalizeLanguage,
  type LanguageDefinition,
} from "./languages";
import {
  functionDepth,
  functionName,
  isFunction,
  location,
  measure,
  parentFunctionName,
  qualityMetrics,
  qualifiedFunctionName,
  walkNodes,
} from "./metrics";
import { collectReferences } from "./references";
import { measureComplexity } from "./complexity";

const MAX_DECLARATIONS = 10_000;
const MAX_REFERENCES = 50_000;
const MAX_DIAGNOSTICS = 512;

let parserInitialization: Promise<void> | null = null;

function asBytes(asset: WasmAsset, assetName: string): Uint8Array {
  if (asset instanceof Uint8Array) return asset;
  if (asset instanceof ArrayBuffer) return new Uint8Array(asset);
  throw new Error(`${assetName} must be supplied as bytes; a WebAssembly.Module is only valid for grammar assets`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function initializeParser(core: Uint8Array): Promise<void> {
  if (!parserInitialization) {
    // Assets are supplied by the granted host loader. Emscripten still computes
    // a filename with wasmBinary present; native V8 has no import.meta.url.
    const options = {
      wasmBinary: core,
      locateFile: (name: string) => name,
      // Native Worker turns drain JS microtasks, not V8's asynchronous WASM
      // compiler queue. Instantiate supplied bytes within the current turn.
      instantiateWasm(imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
        const module = new WebAssembly.Module(core as Uint8Array<ArrayBuffer>);
        const instance = new WebAssembly.Instance(module, imports);
        receive(instance, module);
        return instance.exports;
      },
    } as unknown as Parameters<typeof Parser.init>[0];
    parserInitialization = Parser.init(options).catch((error: unknown) => {
      parserInitialization = null;
      throw error;
    });
  }
  await parserInitialization;
}

async function loadLanguage(
  resources: ParserResources,
  definition: LanguageDefinition,
): Promise<Language> {
  const coreAsset = resources.coreWasm ?? (await resources.loadAsset(CORE_ASSET));
  await initializeParser(asBytes(coreAsset, CORE_ASSET));
  const grammarAsset = await resources.loadAsset(definition.grammar_asset);
  if (grammarAsset instanceof WebAssembly.Module) return Language.loadSync(grammarAsset);
  return Language.loadSync(new WebAssembly.Module(asBytes(grammarAsset, definition.grammar_asset) as Uint8Array<ArrayBuffer>));
}

function blankTruncation(): { declarations: boolean; references: boolean; diagnostics: boolean } {
  return { declarations: false, references: false, diagnostics: false };
}

function unavailable(
  language: string,
  definition: LanguageDefinition | null,
  status: "unsupported" | "resource-unavailable",
  diagnostic: AnalysisDiagnostic,
): SourceAnalysis {
  return {
    profile: ANALYSIS_PROFILE,
    language,
    grammar_asset: definition?.grammar_asset ?? null,
    parser_status: status,
    parser_message: diagnostic.message,
    metrics: null,
    declarations: [],
    references: [],
    diagnostics: [diagnostic],
    truncated: blankTruncation(),
  };
}

function collectFunctions(root: Node): { nodes: Node[]; truncated: boolean } {
  const nodes: Node[] = [];
  let truncated = false;
  for (const node of walkNodes(root)) {
    if (!isFunction(node)) continue;
    if (nodes.length >= MAX_DECLARATIONS) {
      truncated = true;
      continue;
    }
    nodes.push(node);
  }
  return { nodes, truncated };
}

function syntaxDiagnostics(root: Node): { diagnostics: AnalysisDiagnostic[]; truncated: boolean } {
  const diagnostics: AnalysisDiagnostic[] = [];
  let truncated = false;
  for (const node of walkNodes(root)) {
    if (!node.isError && !node.isMissing) continue;
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      truncated = true;
      continue;
    }
    const text = node.text.trim().slice(0, 160);
    diagnostics.push({
      kind: "syntax",
      message: node.isMissing ? `Missing ${node.type}` : `Unexpected ${node.type}`,
      location: location(node),
      ...(text ? { text } : {}),
    });
  }
  return { diagnostics, truncated };
}

function endLine(node: Node): number {
  return Math.max(
    node.startPosition.row + 1,
    node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0),
  );
}

function declaration(node: Node, source: string, language: string): Declaration {
  const complexity = measureComplexity(node, language, true);
  const metrics = qualityMetrics(measure(node, source, true), complexity);
  const name = functionName(node);
  return {
    id: `function:${node.startIndex}`,
    kind: "function",
    syntax_kind: node.type,
    name,
    qualified_name: qualifiedFunctionName(node),
    parent_function: parentFunctionName(node),
    function_depth: functionDepth(node),
    line: node.startPosition.row + 1,
    end_line: endLine(node),
    location: location(node),
    metrics,
  };
}

function analyzeTree(
  root: Node,
  source: string,
  language: string,
  definition: LanguageDefinition,
): SourceAnalysis {
  const syntax = syntaxDiagnostics(root);
  const functions = collectFunctions(root);
  const references = collectReferences(root, language);
  const truncated = blankTruncation();
  truncated.declarations = functions.truncated;
  truncated.references = references.length > MAX_REFERENCES;
  truncated.diagnostics = syntax.truncated;
  const fileComplexity = measureComplexity(root, language, false);
  const metrics = qualityMetrics(measure(root, source, false), fileComplexity);
  const boundedReferences = references.slice(0, MAX_REFERENCES);
  return {
    profile: ANALYSIS_PROFILE,
    language,
    grammar_asset: definition.grammar_asset,
    parser_status: syntax.diagnostics.length > 0 ? "parse-error" : "parsed",
    parser_message: syntax.diagnostics.length > 0 ? syntax.diagnostics[0]?.message ?? null : null,
    metrics,
    declarations: functions.nodes.map((node) => declaration(node, source, language)),
    references: boundedReferences,
    diagnostics: syntax.diagnostics,
    truncated,
  };
}

function summarizeTree(root: Node, source: string, language: string, definition: LanguageDefinition): SourceSummary {
  const syntax = syntaxDiagnostics(root);
  const functions = collectFunctions(root);
  return {
    profile: ANALYSIS_PROFILE,
    language,
    grammar_asset: definition.grammar_asset,
    parser_status: syntax.diagnostics.length ? "parse-error" : "parsed",
    parser_message: syntax.diagnostics[0]?.message ?? null,
    metrics: qualityMetrics(measure(root, source, false), measureComplexity(root, language, false)),
    declaration_count: functions.nodes.length,
    diagnostics: syntax.diagnostics,
    truncated: { declarations: functions.truncated, references: false, diagnostics: syntax.truncated },
  };
}

class TreeSitterAnalyzer implements Analyzer {
  // Keep one grammar live per analyzer. A scan worker should create one
  // analyzer for a language batch; replacing this entry bounds retained
  // grammar state when a repository contains many languages.
  private languageCache: { id: string; promise: Promise<Language> } | null = null;

  public constructor(private readonly resources: ParserResources) {}

  public analyzeSource(source: string, language: string): Promise<SourceAnalysis> {
    return this.parse(source, language, analyzeTree, result => result);
  }

  public analyzeSummary(source: string, language: string): Promise<SourceSummary> {
    return this.parse(source, language, summarizeTree, result => {
      const { declarations, references: _references, ...summary } = result;
      return { ...summary, declaration_count: declarations.length };
    });
  }

  private async parse<T>(source: string, language: string,
    analyze: (root: Node, source: string, language: string, definition: LanguageDefinition) => T,
    failed: (result: SourceAnalysis) => T,
  ): Promise<T> {
    const normalized = normalizeLanguage(language);
    const definition = languageDefinition(language);
    if (!normalized || !definition) {
      return failed(unavailable(language, null, "unsupported", {
        kind: "unsupported",
        message: `No Tree-sitter grammar is registered for ${language}`,
        location: null,
      }));
    }

    let languagePromise: Promise<Language>;
    if (this.languageCache?.id === normalized) {
      languagePromise = this.languageCache.promise;
    } else {
      languagePromise = loadLanguage(this.resources, definition);
      const cacheEntry = { id: normalized, promise: languagePromise };
      this.languageCache = cacheEntry;
      languagePromise = languagePromise.catch((error: unknown) => {
        if (this.languageCache === cacheEntry) this.languageCache = null;
        throw error;
      });
      cacheEntry.promise = languagePromise;
    }

    let grammar: Language;
    try {
      grammar = await languagePromise;
    } catch (error) {
      return failed(unavailable(normalized, definition, "resource-unavailable", {
        kind: "resource",
        message: `Unable to load ${definition.grammar_asset}: ${errorMessage(error)}`,
        location: null,
        asset: definition.grammar_asset,
      }));
    }

    let parser: Parser | null = null;
    let tree: ReturnType<Parser["parse"]> = null;
    try {
      parser = new Parser();
      parser.setLanguage(grammar);
      tree = parser.parse(source);
      if (!tree) {
        return failed(unavailable(normalized, definition, "resource-unavailable", {
          kind: "resource",
          message: "Tree-sitter returned no syntax tree",
          location: null,
        }));
      }
      return analyze(tree.rootNode, source, normalized, definition);
    } finally {
      tree?.delete();
      parser?.delete();
    }
  }
}

export function createAnalyzer(resources: ParserResources): Analyzer {
  return new TreeSitterAnalyzer(resources);
}

/**
 * Analyze one source string. A resource loader is required in V8 because the
 * package does not access a filesystem or bundle every grammar into the app.
 * For repeated files, create one analyzer and reuse its language cache.
 */
export async function analyzeSource(
  source: string,
  language: string,
  options: AnalyzerOptions = {},
): Promise<SourceAnalysis> {
  const resources = options.resources;
  const definition = languageDefinition(language);
  const normalized = normalizeLanguage(language);
  if (!resources) {
    return unavailable(normalized ?? language, definition, "resource-unavailable", {
      kind: "resource",
      message: "Parser resources are not configured; pass { resources: { loadAsset } } or use createAnalyzer",
      location: null,
      asset: definition?.grammar_asset ?? CORE_ASSET,
    });
  }
  return createAnalyzer(resources).analyzeSource(source, language);
}
