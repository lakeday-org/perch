import type { Node } from "./node";
import { callableName, extraScopeName } from "./extensions";
import type {
  HalsteadMetrics,
  QualityMetrics,
  SourcePoint,
} from "./types";
import { measureComplexity } from "./complexity";
import { walk, type SyntaxIndex } from "./visit";

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
  "compact_constructor_declaration",
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
  // A Solidity modifier runs around each function that names it: a callable with a body of its own.
  "modifier_definition",
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

/** Parent node types that give an unnamed function the name it is assigned to. */
const BINDING_TYPES = new Set([
  "variable_declarator",
  "assignment",
  "assignment_expression",
  "binary_operator",
  "pair",
  "property_declaration",
  "lexical_declaration",
]);

/** Node types functionName walks up through to get from a callback argument to the assignment of the call's result. */
const ARGUMENT_TYPES = new Set(["arguments", "argument_list", "value_argument", "value_arguments", "call_suffix", "annotated_lambda"]);
const CALL_TYPES = new Set(["call_expression", "call", "method_invocation", "await_expression"]);

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
  "record_declaration",
  "enum_item",
  "module",
  "contract_declaration",
  "library_declaration",
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
  // A grammar can name a keyword token after the construct it opens: JavaScript's `function`, Python's `lambda`. A leaf is
  // never a second declaration at the same byte as the one around it.
  if (node.childCount === 0) return false;
  if (extraScopeName(node)) return false;
  if (callableName(node)) return true;
  return FUNCTION_TYPES.has(node.type) && !EXCLUDED_FUNCTION_TYPES.has(node.type);
}

/** Walk the language pack's native tree without materializing a second syntax tree. */
export function* walkNodes(root: Node): Generator<Node> { yield* root.walk(); }


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

function containsInterpolation(node: Node, index: SyntaxIndex): boolean {
  return index.within(node).some(current => current !== node && INTERPOLATION_TYPES.has(current.type));
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

/** The rows of a node's text that hold anything but whitespace, numbered as rows of the file. */
export const nonblankRows = (root: Node): Set<number> => new Set([...nonblankLines(root.text)].map(line => line + root.startPosition.row));

/**
 * `nonblank` is the file's nonblank rows, when the caller measures many nodes of one file. Read from each node's own text, a
 * function nested thousands deep re-read everything inside it once per function around it.
 */
export function measure(root: Node, excludeNested = false, nonblank = nonblankRows(root), index = walk(root)): Measurement {
  const operators = new Map<string, number>();
  const operands = new Map<string, number>();
  const codeLines = new Set<number>();
  const comments = new Set<number>();
  let opaque_bytes = 0;
  // The root's subtree is a slice of the walk; a node whose subtree is not counted is passed over by jumping to its end.
  const all = index.all, stop = index.end(root);
  for (let at = index.at(root); at < stop;) {
    const node = all[at], past = index.end(node);
    if (node !== root && excludeNested && isFunction(node)) { at = past; continue; }
    if (isComment(node)) {
      addLines(comments, node);
      at = past;
      continue;
    }
    // A MISSING token takes no bytes, so the width says it without asking.
    if (node.endIndex <= node.startIndex) { at = past; continue; }
    if (node.type === "raw_text" || node.type === "jsx_text" || node.type === "html_text") {
      opaque_bytes += node.endIndex - node.startIndex;
      at = past;
      continue;
    }
    if (STRING_TYPES.has(node.type) && !containsInterpolation(node, index)) {
      const token = lexeme(node);
      operands.set(token, (operands.get(token) ?? 0) + 1);
      addLines(codeLines, node);
      at = past;
      continue;
    }
    if (isLeaf(node)) {
      addLines(codeLines, node);
      recordToken(node, operators, operands);
      at = past;
      continue;
    }
    at += 1;
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

/**
 * The name a C or C++ declarator declares, and the scopes it is qualified with. `double Cart::total()` declares `total` in
 * `Cart`; the first name node inside the declarator is `Cart`, which is the class, and read that way every out-of-line member
 * of a class was called by the class's name.
 */
function declared(declarator: Node): { name: Node | null; scopes: string[] } {
  const scopes: string[] = [];
  for (const item of walkNodes(declarator)) {
    if (item.type === "qualified_identifier") {
      const scope = item.childForFieldName("scope");
      if (scope) scopes.push(text(scope.childForFieldName("name") ?? scope));
      const inner = item.childForFieldName("name");
      if (!inner) return { name: null, scopes };
      const rest = declared(inner);
      return { name: rest.name, scopes: [...scopes, ...rest.scopes] };
    }
    if (NAME_TYPES.has(item.type)) return { name: item, scopes };
  }
  return { name: null, scopes };
}

/**
 * Names are read once per node. A declaration's qualified name reads the name of every function around it, so a file of nested
 * functions asked for each enclosing name once per declaration inside it, and the native field lookups behind a name were most
 * of the time left in parsing one.
 */
const names = new WeakMap<Node, string>();
const remembered = (cache: WeakMap<Node, string>, node: Node, read: (node: Node) => string): string => {
  let name = cache.get(node);
  if (name === undefined) { name = read(node); cache.set(node, name); }
  return name;
};

export const functionName = (node: Node): string => remembered(names, node, readFunctionName);

function readFunctionName(node: Node): string {
  // `exports.etag = function etag() {}` and `const f = function g() {}`: a function expression's own name is seen only inside
  // it, and everything else reaches it by what it is assigned to. `module.exports = function query() {}` is the module itself,
  // so there the function's own name is the one it goes by.
  const target = node.parent && BINDING_TYPES.has(node.parent.type) ? node.parent.childForFieldName("left") ?? node.parent.childForFieldName("name") : null;
  const assigned = node.type === "function_expression" && target !== null && !/^(?:module\.exports|exports)$/.test(target.text);
  let name = assigned ? null : callableName(node) ?? node.childForFieldName("name");
  // A lambda's declarator lists its parameters, so the first name inside it is a parameter's type: a C++ lambda taking a
  // `const std::string&` was called `std`. A lambda has no name of its own; it takes one only from what it is bound to.
  if (!name && !ANONYMOUS_FUNCTION_TYPES.has(node.type)) {
    const declarator = node.childForFieldName("declarator");
    if (declarator) name = declared(declarator).name;
  }
  if (!name) {
    let parent = node.parent;
    // In `const wrapped = withAuth(async req => ...)` the callback is named wrapped. Only done outside a function, since a
    // callback inside one is read as part of it.
    if (parent && ARGUMENT_TYPES.has(parent.type) && !enclosingFunction(node)) {
      while (parent && (ARGUMENT_TYPES.has(parent.type) || CALL_TYPES.has(parent.type))) parent = parent.parent;
    }
    if (parent && BINDING_TYPES.has(parent.type)) {
      for (const field of ["name", "left", "lhs", "key"]) {
        name = parent.childForFieldName(field);
        if (name) break;
      }
    }
    // C++ `auto charge = [](...) {...}` and Rust `let charge = |...| ...`. Only a plain identifier names it: `auto *p = ...`
    // declares a pointer and `let (a, b) = ...` a pattern, neither of them a function.
    const bound = parent?.type === "init_declarator" ? parent.childForFieldName("declarator")
      : parent?.type === "let_declaration" ? parent.childForFieldName("pattern") : null;
    if (bound?.type === "identifier") name = bound;
  }
  if (!name && !ANONYMOUS_FUNCTION_TYPES.has(node.type)) {
    name = node.namedChildren.find((child) => NAME_TYPES.has(child.type)) ?? null;
  }
  return text(name) || "<anonymous>";
}

/**
 * A type's arguments are not part of its name: a method of `Stack[T]` or `Stack<T>` belongs to Stack. Named after T, the methods
 * of two generic types shared one id, told apart only by the order they were declared in, and `perch check` could not find
 * either by its type.
 */
const insideTypeArguments = (node: Node, within: Node): boolean => {
  for (let parent = node.parent; parent && parent.id !== within.id; parent = parent.parent) if (parent.type === "type_arguments") return true;
  return false;
};

function scopeName(node: Node): string | null {
  // A JavaScript object literal is named by what holds it: `const types = { boolean() {} }` has `types.boolean`. One with
  // nothing holding it, an argument or a return value, adds no name.
  if (node.type === "object") {
    const holder = node.parent;
    const name = holder?.type === "variable_declarator" ? holder.childForFieldName("name")
      : holder?.type === "assignment_expression" ? holder.childForFieldName("left") : holder?.type === "pair" ? holder.childForFieldName("key") : null;
    return name && /^[\p{L}_$][\p{L}\p{N}_$.]*$/u.test(name.text) ? name.text : null;
  }
  let name = extraScopeName(node) ?? node.childForFieldName("name");
  if (!name && node.type === "impl_item") {
    name = node.childForFieldName("type");
    if (name?.type === "generic_type") name = name.childForFieldName("type");
  }
  if (!name) name = node.namedChildren.find((child) => NAME_TYPES.has(child.type)) ?? null;
  return text(name) || null;
}

function receiverName(node: Node): string | null {
  const receiver = node.childForFieldName("receiver");
  if (!receiver) return null;
  const nodes = [...walkNodes(receiver)].reverse();
  const name = nodes.find((item) =>
    new Set(["type_identifier", "identifier", "simple_identifier"]).has(item.type) && !insideTypeArguments(item, receiver),
  );
  return text(name) || null;
}

/** The scopes a C++ out-of-line definition names in its declarator: `Cart` for `double Cart::total()`. */
function declaratorScopes(node: Node): string[] {
  if (ANONYMOUS_FUNCTION_TYPES.has(node.type) || node.childForFieldName("name")) return [];
  const declarator = node.childForFieldName("declarator");
  return declarator ? declared(declarator).scopes : [];
}

/**
 * A name some callers already know better than the tree does. A test case is named by its title or its macro arguments, not by
 * the `TEST` or the anonymous callback the grammar sees, and what is declared inside it is qualified by that name.
 */
export type Renamed = (node: Node) => string | null;
const notRenamed: Renamed = () => null;
/** Qualified names, remembered per node for each way of renaming: one file's test cases rename only that file's nodes. */
const qualifiedNames = new WeakMap<Renamed, WeakMap<Node, string>>();

export function qualifiedFunctionName(node: Node, renamed: Renamed = notRenamed): string {
  let cache = qualifiedNames.get(renamed);
  if (!cache) { cache = new WeakMap(); qualifiedNames.set(renamed, cache); }
  return remembered(cache, node, item => renamed(item) ?? readQualifiedName(item, renamed));
}

function readQualifiedName(node: Node, renamed: Renamed): string {
  const parts: string[] = [];
  let parent = node.parent;
  while (parent) {
    if (isFunction(parent)) {
      // A renamed ancestor already carries every scope above it.
      const known = renamed(parent);
      if (known !== null) { parts.push(known); break; }
      parts.push(functionName(parent));
    } else if (SCOPE_TYPES.has(parent.type) || extraScopeName(parent)) {
      const name = scopeName(parent);
      if (name) parts.push(name);
    }
    parent = parent.parent;
  }
  const receiver = receiverName(node);
  if (receiver && !parts.includes(receiver)) parts.push(receiver);
  parts.reverse();
  parts.push(...declaratorScopes(node));
  parts.push(functionName(node));
  return parts.filter(Boolean).join(".") || "<anonymous>";
}

function enclosingFunction(node: Node): Node | null {
  let parent = node.parent;
  while (parent && !isFunction(parent)) parent = parent.parent;
  return parent;
}

/** Whether the last part of a qualified name is a real name rather than <anonymous>. */
export const isNamed = (qualifiedName: string): boolean => qualifiedName.split(".").at(-1) !== "<anonymous>";

export function parentFunctionName(node: Node, renamed: Renamed = notRenamed): string | null {
  let parent = node.parent;
  while (parent) {
    if (isFunction(parent)) return qualifiedFunctionName(parent, renamed);
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
