import type { LanguageId } from "./languages";

/** Part of a saved parse's id. Bump it when a change alters parse output, so saved parses are redone. */
export const PARSE_VERSION = "language-pack-1.20-v30" as const;

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
  /** One-based lines of every control-flow structure, sorted and unique. The hotspots are only the heaviest few of them. */
  branch_lines: number[];
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

/** A declaration that is a test case: its own name, the suites around it outermost first, and what declared it. */
export interface TestCase {
  name: string;
  suite: string[];
  framework: string;
  /** Declared with `.each` (itself or a suite around it), so its titles are templates each case fills in: `adds %i and %i`. */
  parametrized?: boolean;
  /**
   * What the framework calls before the test, as calls written in the test would name them: its class's `@BeforeEach` and
   * `setUp`, a GoogleTest fixture's constructor and `SetUp`. The test reaches what they reach.
   */
  setup?: string[];
  /** The fixture class a Catch2 TEST_CASE_METHOD or doctest TEST_CASE_FIXTURE is a member of, which Catch2's runs are named under. */
  fixture?: string;
}

/** What a mock replaces: a module, a dotted path, one member of an object, or a whole class. */
export type MockTarget =
  | { kind: "module"; module: string }
  | { kind: "path"; path: string }
  | { kind: "member"; object: string; name: string }
  | { kind: "class"; name: string };

export interface Mock {
  /** The declaration the mock applies to, `function:<start byte>`, or `file` for every test in the file. */
  owner: string;
  target: MockTarget;
  line: number;
}

export interface Declaration {
  id: string;
  kind: "function";
  syntax_kind: string;
  name: string;
  qualified_name: string;
  parent_function: string | null;
  /** The id of the declaration this one is inside, or null at the top level. */
  parent_id: string | null;
  function_depth: number;
  line: number;
  end_line: number;
  location: SourceLocation;
  metrics: QualityMetrics;
  test: TestCase | null;
  /** A C or C++ function other translation units cannot call: `static`, or in an unnamed namespace. */
  internal: boolean;
  /** The parameters it declares, in order. */
  params: Parameter[];
  /** Test code that is no test: a helper in a test class or file, a fixture. */
  support?: boolean;
  /** A Kotlin extension function: `fun String.size()`, declared for a receiver type rather than in a class. */
  extension?: boolean;
}

export type ReferenceKind = "call" | "import" | "value" | "read" | "bind" | "returns" | "extends";

/**
 * What a value is, when its source says: an instance of a type (`new Ledger()`, `x: Ledger`), the result of a call whose type is
 * found later (`make()`), a member call on what another value holds (`Entry(day).debit()`), or another local's value.
 */
export interface Held {
  type?: string | null;
  call?: string | null;
  on?: Held | null;
  local?: string | null;
  /** An object literal's named values, `{ analyzer, reader: make() }`: what a destructured parameter takes from it. */
  fields?: Record<string, Held>;
  /** A function written in place, `file => read(file)`: the declaration id of the function the value is. */
  fn?: string;
}

/** A parameter a function declares: its name, its position, and the property it takes when it is destructured from an object. */
export interface Parameter {
  name: string;
  index: number;
  field?: string;
}

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
  /** An import this module passes on with `export ... from`, rather than binds for its own use. */
  reexport?: boolean;
  /** For a `bind`, a `returns`, or a call on a receiver with no name: what the value is, when the source says. */
  held?: Held;
  /** For a call: what each positional argument holds, and what each named one does, when the source says. */
  args?: Array<Held | null>;
  named?: Record<string, Held>;
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
  profile: typeof PARSE_VERSION;
  language: LanguageId | string;
  parser_status: ParserStatus;
  parser_message: string | null;
  metrics: QualityMetrics | null;
  declarations: Declaration[];
  /** Line numbers outside every named function, ascending. */
  top_level: number[];
  /** The name a JavaScript module's default export is defined under, when it has one. */
  default_export?: string | null;
  /** The byte spans of a test file's suite callbacks, whose setup runs for each test inside them. */
  suites?: Array<{ start: number; end: number }>;
  references: Reference[];
  diagnostics: AnalysisDiagnostic[];
  truncated: AnalysisTruncation;
  /** The Java or Kotlin package, or the Go package clause; null elsewhere. */
  package: string | null;
  mocks: Mock[];
}

/** File-level analysis without materializing function metrics or a reference graph. */
export interface SourceSummary extends Omit<SourceAnalysis, "declarations" | "top_level" | "references"> {
  declaration_count: number;
}

export interface AnalyzeOptions {
  /** The file's path in the repository. pytest decides from it which module-level functions are tests. */
  path?: string;
}

export interface Analyzer {
  analyzeSummary(source: string, language: string, options?: AnalyzeOptions): Promise<SourceSummary>;
  analyzeSource(source: string, language: string, options?: AnalyzeOptions): Promise<SourceAnalysis>;
}
