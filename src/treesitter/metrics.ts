import type { Node } from "./node";
import { callableName, extraScopeName } from "./extensions";
import type {
  HalsteadMetrics,
  QualityMetrics,
  SourcePoint,
} from "./types";
import { measureComplexity } from "./complexity";

export const STRING_TYPES = new Set([
  "string",
  "string_literal",
  "raw_string_literal",
  "interpreted_string_literal",
  "verbatim_string_literal",
  "character_literal",
  "char_literal",
  "char",
  "template_string",
  "regex",
  "regex_literal",
  "heredoc_body",
  "string_lit",
  "str_lit",
  "quoted_atom",
  "sigil",
]);

const INTERPOLATION_TYPES = new Set([
  "interpolation",
  "string_interpolation",
  "template_substitution",
  "interpolation_expression",
  "embedded_expression",
  "command_substitution",
  "simple_expansion",
  "expansion",
]);

const LITERAL_WORDS = new Set([
  "true",
  "false",
  "True",
  "False",
  "TRUE",
  "FALSE",
  "nil",
  "null",
  "None",
  "nullptr",
  "undefined",
  "NULL",
]);

const IGNORED_TOKENS = new Set([
  ")",
  "]",
  "}",
  '"',
  "'",
  "`",
  '"""',
  "'''",
  "${",
  "#{",
  "\\",
]);

const OPEN_PAIRS: Readonly<Record<string, string>> = {
  "(": "()",
  "[": "[]",
  "{": "{}",
};

const SYMBOLIC_OPERATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "=",
  "==",
  "===",
  "!=",
  "!==",
  "<",
  ">",
  "<=",
  ">=",
  "&&",
  "||",
  "!",
  "&",
  "|",
  "^",
  "~",
  "<<",
  ">>",
  ">>>",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "++",
  "--",
  "=>",
  "->",
  "<-",
  "::",
  ":=",
  "?",
  "??",
  "?.",
  ".",
  ",",
  ";",
  ":",
  "...",
  "..",
  "..=",
  "|>",
  "<>",
]);

/** AST node kinds that represent executable callable scopes. */
export const FUNCTION_TYPES = new Set([
  "function_definition",
  "function_declaration",
  "function_item",
  "method_definition",
  "method_declaration",
  "method",
  "singleton_method",
  "constructor_declaration",
  "constructor_definition",
  "arrow_function",
  "function_expression",
  "generator_function",
  "generator_function_declaration",
  "lambda",
  "lambda_expression",
  "lambda_literal",
  "anonymous_function",
  "anonymous_function_expression",
  "closure_expression",
  "function_literal",
  "func_literal",
  "local_function_statement",
  "function",
  "function_expression_body",
  "procedure_definition",
  "procedure_declaration",
  "subroutine",
  "subroutine_definition",
  "subroutine_declaration",
  "function_declarator",
  "function_clause",
  "function_declaration_statement",
  "function_definition_statement",
  "function_def",
]);

const EXCLUDED_FUNCTION_TYPES = new Set(["function_declarator"]);

const ANONYMOUS_FUNCTION_TYPES = new Set([
  "arrow_function",
  "function_expression",
  "lambda",
  "lambda_expression",
  "lambda_literal",
  "anonymous_function",
  "anonymous_function_expression",
  "closure_expression",
  "function_literal",
  "func_literal",
]);

const SCOPE_TYPES = new Set([
  "class_definition",
  "class_declaration",
  "class_specifier",
  "struct_specifier",
  "interface_declaration",
  "trait_item",
  "impl_item",
  "namespace_definition",
  "internal_module",
  "module_definition",
  "object_declaration",
  "object",
  "enum_declaration",
  "enum_item",
  "module",
]);

const NAME_TYPES = new Set([
  "identifier",
  "field_identifier",
  "type_identifier",
  "namespace_identifier",
  "property_identifier",
  "simple_identifier",
  "name",
  "variable",
  "operator_name",
  "destructor_name",
]);

export interface Measurement {
  halstead: HalsteadMetrics;
  sloc: number;
  comment_lines: number;
  opaque_bytes: number;
}

export function isComment(node: Node): boolean {
  return node.type.includes("comment") || node.type === "shebang" || node.type === "hash_bang_line";
}

export function isFunction(node: Node): boolean {
  if (extraScopeName(node)) return false;
  if (callableName(node)) return true;
  if (!FUNCTION_TYPES.has(node.type) || EXCLUDED_FUNCTION_TYPES.has(node.type)) return false;
  // JavaScript's grammar exposes the `function` keyword as a named leaf below
  // function_declaration. It is not a second callable declaration.
  if (node.type === "function" && !node.childForFieldName("body")) return false;
  return true;
}

/** Walk the language pack's native tree without materializing a second syntax tree. */
export function* walkNodes(root: Node): Generator<Node> { yield* root.walk(); }

function childNodes(node: Node): Node[] {
  const children: Node[] = [];
  for (let index = node.childCount - 1; index >= 0; index -= 1) {
    const child = node.child(index);
    if (child) children.push(child);
  }
  return children;
}

function lineRange(node: Node): [number, number] {
  const start = node.startPosition.row;
  const end = node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0);
  return [start, Math.max(start + 1, end)];
}

function addLines(target: Set<number>, node: Node): void {
  const [start, end] = lineRange(node);
  for (let line = start; line < end; line += 1) target.add(line);
}

function nonblankLines(source: string): Set<number> {
  const result = new Set<number>();
  let line = 0;
  let hasText = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\n") {
      if (hasText) result.add(line);
      line += 1;
      hasText = false;
    } else if (character !== "\r" && !/\s/u.test(character)) {
      hasText = true;
    }
  }
  if (hasText) result.add(line);
  return result;
}

function containsInterpolation(node: Node): boolean {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current !== node && INTERPOLATION_TYPES.has(current.type)) return true;
    for (let index = current.childCount - 1; index >= 0; index -= 1) {
      const child = current.child(index);
      if (child) stack.push(child);
    }
  }
  return false;
}

function isLeaf(node: Node): boolean {
  return node.childCount === 0;
}

function lexeme(node: Node, limitBytes = 4096): string {
  const bytes = node.endIndex - node.startIndex;
  return bytes > limitBytes ? `<large-token:${bytes}>` : node.text.trim();
}

function recordToken(
  node: Node,
  operators: Map<string, number>,
  operands: Map<string, number>,
): void {
  const token = lexeme(node);
  if (!token || IGNORED_TOKENS.has(token)) return;
  if (token in OPEN_PAIRS) {
    const pair = OPEN_PAIRS[token];
    operators.set(pair, (operators.get(pair) ?? 0) + 1);
  } else if (LITERAL_WORDS.has(token)) {
    operands.set(token, (operands.get(token) ?? 0) + 1);
  } else if (
    !node.isNamed ||
    SYMBOLIC_OPERATORS.has(token) ||
    node.type === "operator" ||
    node.type === "binary_operator_token" ||
    node.type === "unary_operator_token"
  ) {
    operators.set(token, (operators.get(token) ?? 0) + 1);
  } else {
    operands.set(token, (operands.get(token) ?? 0) + 1);
  }
}

function halstead(
  operators: Map<string, number>,
  operands: Map<string, number>,
): HalsteadMetrics {
  const n1 = operators.size;
  const n2 = operands.size;
  const N1 = [...operators.values()].reduce((sum, count) => sum + count, 0);
  const N2 = [...operands.values()].reduce((sum, count) => sum + count, 0);
  const vocabulary = n1 + n2;
  const length = N1 + N2;
  const calculated_length =
    (n1 > 0 ? n1 * Math.log2(n1) : 0) + (n2 > 0 ? n2 * Math.log2(n2) : 0);
  const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;
  const difficulty = n2 > 0 ? (n1 / 2) * (N2 / n2) : 0;
  const effort = difficulty * volume;
  return {
    distinct_operators: n1,
    distinct_operands: n2,
    total_operators: N1,
    total_operands: N2,
    vocabulary,
    length,
    calculated_length,
    volume,
    difficulty,
    effort,
    time_seconds: effort / 18,
    bugs: volume / 3000,
  };
}

export function measure(root: Node, excludeNested = false): Measurement {
  const operators = new Map<string, number>();
  const operands = new Map<string, number>();
  const codeLines = new Set<number>();
  const comments = new Set<number>();
  const nonblank = new Set([...nonblankLines(root.text)].map(line => line + root.startPosition.row));
  let opaque_bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node !== root && excludeNested && isFunction(node)) continue;
    if (isComment(node)) {
      addLines(comments, node);
      continue;
    }
    if (node.isMissing || node.endIndex <= node.startIndex) continue;
    if (node.type === "raw_text" || node.type === "jsx_text" || node.type === "html_text") {
      opaque_bytes += node.endIndex - node.startIndex;
      continue;
    }
    if (STRING_TYPES.has(node.type) && !containsInterpolation(node)) {
      const token = lexeme(node);
      operands.set(token, (operands.get(token) ?? 0) + 1);
      addLines(codeLines, node);
      continue;
    }
    if (isLeaf(node)) {
      addLines(codeLines, node);
      recordToken(node, operators, operands);
      continue;
    }
    stack.push(...childNodes(node));
  }
  const sloc = [...codeLines].filter((line) => nonblank.has(line)).length;
  return {
    halstead: halstead(operators, operands),
    sloc,
    comment_lines: comments.size,
    opaque_bytes,
  };
}

function text(node: Node | null | undefined, limit = 160): string {
  if (!node) return "";
  if (node.endIndex - node.startIndex > limit * 4) return "<truncated>";
  return node.text.slice(0, limit);
}

export function functionName(node: Node): string {
  let name = callableName(node) ?? node.childForFieldName("name");
  if (!name) {
    const declarator = node.childForFieldName("declarator");
    if (declarator) {
      name = [...walkNodes(declarator)].find((item) => NAME_TYPES.has(item.type)) ?? null;
    }
  }
  if (!name) {
    const parent = node.parent;
    if (
      parent &&
      new Set([
        "variable_declarator",
        "assignment",
        "assignment_expression",
        "binary_operator",
        "pair",
        "property_declaration",
        "lexical_declaration",
      ]).has(parent.type)
    ) {
      for (const field of ["name", "left", "lhs", "key"]) {
        name = parent.childForFieldName(field);
        if (name) break;
      }
    }
  }
  if (!name && !ANONYMOUS_FUNCTION_TYPES.has(node.type)) {
    name = node.namedChildren.find((child) => NAME_TYPES.has(child.type)) ?? null;
  }
  return text(name) || "<anonymous>";
}

function scopeName(node: Node): string | null {
  let name = extraScopeName(node) ?? node.childForFieldName("name");
  if (!name && node.type === "impl_item") name = node.childForFieldName("type");
  if (!name) name = node.namedChildren.find((child) => NAME_TYPES.has(child.type)) ?? null;
  return text(name) || null;
}

function receiverName(node: Node): string | null {
  const receiver = node.childForFieldName("receiver");
  if (!receiver) return null;
  const nodes = [...walkNodes(receiver)].reverse();
  const name = nodes.find((item) =>
    new Set(["type_identifier", "identifier", "simple_identifier"]).has(item.type),
  );
  return text(name) || null;
}

export function qualifiedFunctionName(node: Node): string {
  const parts: string[] = [];
  let parent = node.parent;
  while (parent) {
    if (isFunction(parent)) parts.push(functionName(parent));
    else if (SCOPE_TYPES.has(parent.type) || extraScopeName(parent)) {
      const name = scopeName(parent);
      if (name) parts.push(name);
    }
    parent = parent.parent;
  }
  const receiver = receiverName(node);
  if (receiver && !parts.includes(receiver)) parts.push(receiver);
  parts.reverse();
  parts.push(functionName(node));
  return parts.filter(Boolean).join(".") || "<anonymous>";
}

export function parentFunctionName(node: Node): string | null {
  let parent = node.parent;
  while (parent) {
    if (isFunction(parent)) return qualifiedFunctionName(parent);
    parent = parent.parent;
  }
  return null;
}

export function functionDepth(node: Node): number {
  let depth = 0;
  let parent = node.parent;
  while (parent) {
    if (isFunction(parent)) depth += 1;
    parent = parent.parent;
  }
  return depth;
}

export function location(node: Node): { start: SourcePoint; end: SourcePoint } {
  return {
    start: {
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      byte: node.startIndex,
    },
    end: {
      line: node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0),
      column: node.endPosition.column + 1,
      byte: node.endIndex,
    },
  };
}

function bounded(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function maintainabilityIndex(volume: number, sloc: number, cyclomatic: number | null): number | null {
  if (cyclomatic === null) return null;
  if (volume <= 0 && sloc <= 0) return 100;
  const raw =
    171 -
    5.2 * Math.log(Math.max(volume, 1)) -
    0.23 * Math.max(cyclomatic, 1) -
    16.2 * Math.log(Math.max(sloc, 1));
  return bounded((raw * 100) / 171);
}

function complexityScore(cyclomatic: number | null, maxNesting: number | null): number | null {
  if (cyclomatic === null || maxNesting === null) return null;
  const branchPressure = Math.min(1, Math.max(0, (cyclomatic - 1) / 10));
  const nestingPressure = Math.min(1, Math.max(0, maxNesting / 5));
  return bounded(100 * (1 - 0.7 * branchPressure - 0.3 * nestingPressure));
}

export function qualityMetrics(
  measurement: Measurement,
  complexity: ReturnType<typeof measureComplexity>,
): QualityMetrics {
  const mi = maintainabilityIndex(
    measurement.halstead.volume,
    measurement.sloc,
    complexity.cyclomatic_complexity,
  );
  const controlScore = complexityScore(
    complexity.cyclomatic_complexity,
    complexity.max_nesting,
  );
  const halsteadRisk = bounded(
    100 * Math.min(1, Math.log1p(measurement.halstead.volume) / Math.log(10001)),
  );
  const maintainabilityRisk = mi === null ? null : 100 - mi;
  const complexityRisk = controlScore === null ? null : 100 - controlScore;
  const risk =
    maintainabilityRisk === null
      ? halsteadRisk
      : complexityRisk === null
        ? maintainabilityRisk
        : 0.65 * maintainabilityRisk + 0.35 * complexityRisk;
  return {
    ...measurement.halstead,
    ...complexity,
    sloc: measurement.sloc,
    comment_lines: measurement.comment_lines,
    opaque_bytes: measurement.opaque_bytes,
    maintainability_index: mi === null ? null : round(mi),
    halstead_risk_score: round(halsteadRisk),
    complexity_score: controlScore === null ? null : round(controlScore),
    risk_score: round(bounded(risk)),
    risk_components: {
      maintainability_risk: maintainabilityRisk === null ? null : round(maintainabilityRisk),
      halstead_risk: round(halsteadRisk),
      complexity_risk: complexityRisk === null ? null : round(complexityRisk),
    },
  };
}
