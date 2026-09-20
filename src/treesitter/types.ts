import type { LanguageId } from "./languages";

export const ANALYSIS_PROFILE = "language-pack-1.20-v3" as const;

export interface SourcePoint {
  /** One-based source line. */
  line: number;
  /** One-based UTF-8 column. */
  column: number;
  /** Zero-based UTF-8 byte offset. */
  byte: number;
}

export interface SourceLocation {
  start: SourcePoint;
  end: SourcePoint;
}

export interface HalsteadMetrics {
  distinct_operators: number;
  distinct_operands: number;
  total_operators: number;
  total_operands: number;
  vocabulary: number;
  length: number;
  calculated_length: number;
  volume: number;
  difficulty: number;
  effort: number;
  time_seconds: number;
  bugs: number;
}

export interface StructureHotspot {
  type: string;
  node_type: string;
  line: number;
  end_line: number;
  nesting: number;
  counts_toward_cyclomatic: boolean;
  guard_branches: number;
  subtree_branches: number;
  subtree_control_nodes: number;
  subtree_logical_branches: number;
  subtree_max_nesting: number;
}

export type ComplexityStatus = "supported" | "unsupported";

export interface ComplexityMetrics {
  complexity_status: ComplexityStatus;
  complexity_adapter: string | null;
  cyclomatic_complexity: number | null;
  control_branch_count: number | null;
  logical_branch_count: number | null;
  max_nesting: number | null;
  structure_hotspots: StructureHotspot[];
}

export interface QualityMetrics extends HalsteadMetrics, ComplexityMetrics {
  sloc: number;
  comment_lines: number;
  opaque_bytes: number;
  maintainability_index: number | null;
  halstead_risk_score: number;
  complexity_score: number | null;
  risk_score: number;
  risk_components: {
    maintainability_risk: number | null;
    halstead_risk: number;
    complexity_risk: number | null;
  };
}

export interface Declaration {
  id: string;
  kind: "function";
  syntax_kind: string;
  name: string;
  qualified_name: string;
  parent_function: string | null;
  function_depth: number;
  line: number;
  end_line: number;
  location: SourceLocation;
  metrics: QualityMetrics;
}

export type ReferenceKind = "call" | "import" | "value";

export interface Reference {
  kind: ReferenceKind;
  /** The callee or imported binding when one is available. */
  name: string;
  /** Stable lexical reference; dynamic expressions are reported as such. */
  reference: string;
  /** Import module, or null for calls. */
  module: string | null;
  imported_name: string | null;
  alias: string | null;
  /** Owning function id, or `file` for a top-level reference. */
  source: string;
  line: number;
  column: number;
  location: SourceLocation;
}

export type DiagnosticKind = "syntax" | "unsupported" | "resource";

export interface AnalysisDiagnostic {
  kind: DiagnosticKind;
  message: string;
  location: SourceLocation | null;
  text?: string;
  asset?: string;
}

export type ParserStatus =
  | "parsed"
  | "parse-error"
  | "unsupported"
  | "resource-unavailable";

export interface AnalysisTruncation {
  declarations: boolean;
  references: boolean;
  diagnostics: boolean;
}

export interface SourceAnalysis {
  profile: typeof ANALYSIS_PROFILE;
  language: LanguageId | string;
  parser_status: ParserStatus;
  parser_message: string | null;
  metrics: QualityMetrics | null;
  declarations: Declaration[];
  references: Reference[];
  diagnostics: AnalysisDiagnostic[];
  truncated: AnalysisTruncation;
}

/** File-level analysis without materializing function metrics or a reference graph. */
export interface SourceSummary extends Omit<SourceAnalysis, "declarations" | "references"> {
  declaration_count: number;
}

export interface Analyzer {
  analyzeSummary(source: string, language: string): Promise<SourceSummary>;
  analyzeSource(source: string, language: string): Promise<SourceAnalysis>;
}
