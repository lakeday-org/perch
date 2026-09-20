import type { Node } from "./node";
import type { ComplexityMetrics, StructureHotspot } from "./types";
import { isFunction } from "./metrics";

/**
 * Complexity adapters are deliberately conservative. The grammar registry is
 * broad, but only these grammars have a verified McCabe node mapping here.
 */
export const COMPLEXITY_LANGUAGES = new Set([
  "c",
  "cpp",
  "go",
  "java",
  "javascript",
  "python",
  "rust",
  "typescript",
  "tsx",
]);

const CONTROL_NODE_TYPES = new Set([
  "if_statement",
  "if_expression",
  "elif_clause",
  "for_statement",
  "for_expression",
  "for_in_statement",
  "for_range_loop",
  "for_in_clause",
  "foreach_statement",
  "enhanced_for_statement",
  "while_statement",
  "while_expression",
  "do_statement",
  "repeat_statement",
  "loop_statement",
  "loop_expression",
  "try_statement",
  "catch_clause",
  "except_clause",
  "conditional_expression",
  "ternary_expression",
  "switch_statement",
  "switch_expression",
  "expression_switch_statement",
  "type_switch_statement",
  "select_statement",
  "match_expression",
  "match_statement",
  "case_statement",
  "type_case",
  "switch_case",
  "switch_label",
  "expression_case",
  "default_case",
  "case_clause",
  "switch_default",
  "match_arm",
  "when_entry",
  "communication_case",
  "if_clause",
]);

const DECISION_NODE_TYPES = new Set([
  "if_statement",
  "if_expression",
  "elif_clause",
  "for_statement",
  "for_expression",
  "for_in_statement",
  "for_range_loop",
  "for_in_clause",
  "foreach_statement",
  "enhanced_for_statement",
  "while_statement",
  "while_expression",
  "do_statement",
  "repeat_statement",
  "catch_clause",
  "except_clause",
  "conditional_expression",
  "ternary_expression",
  "if_clause",
]);

const ARM_NODE_TYPES = new Set([
  "case_statement",
  "type_case",
  "switch_case",
  "switch_label",
  "expression_case",
  "default_case",
  "case_clause",
  "switch_default",
  "match_arm",
  "when_entry",
  "communication_case",
]);

const LOGICAL_NODE_TYPES = new Set([
  "boolean_operator",
  "binary_expression",
  "binary_operator",
  "logical_expression",
  "infix_expression",
]);

const LOGICAL_OPERATORS = new Set(["and", "or", "&&", "||", "??"]);

const BRANCH_LABELS: Readonly<Record<string, string>> = {
  if_statement: "if",
  if_expression: "if",
  elif_clause: "elif",
  for_statement: "for",
  for_expression: "for",
  for_in_statement: "for-in",
  for_range_loop: "for-range",
  for_in_clause: "for-in",
  foreach_statement: "foreach",
  enhanced_for_statement: "for-each",
  while_statement: "while",
  while_expression: "while",
  do_statement: "do-while",
  repeat_statement: "repeat",
  loop_statement: "loop",
  loop_expression: "loop",
  try_statement: "try",
  catch_clause: "catch",
  except_clause: "except",
  conditional_expression: "conditional",
  ternary_expression: "ternary",
  switch_statement: "switch",
  switch_expression: "switch",
  expression_switch_statement: "switch",
  type_switch_statement: "type-switch",
  select_statement: "select",
  match_expression: "match",
  match_statement: "match",
  case_statement: "case",
  type_case: "case",
  switch_case: "case",
  switch_label: "case",
  expression_case: "case",
  default_case: "default",
  case_clause: "case",
  switch_default: "default",
  match_arm: "arm",
  when_entry: "when",
  communication_case: "case",
  if_clause: "if",
};

function unsupported(): ComplexityMetrics {
  return {
    complexity_status: "unsupported",
    complexity_adapter: null,
    cyclomatic_complexity: null,
    control_branch_count: null,
    logical_branch_count: null,
    max_nesting: null,
    structure_hotspots: [],
  };
}

function nodeText(node: Node | null): string {
  return node?.text.trim() ?? "";
}

function operatorText(node: Node): string {
  const operator = node.childForFieldName("operator");
  if (operator) return nodeText(operator);
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child && !child.isNamed && LOGICAL_OPERATORS.has(nodeText(child))) {
      return nodeText(child);
    }
  }
  return "";
}

function isLogical(node: Node): boolean {
  return LOGICAL_NODE_TYPES.has(node.type) && LOGICAL_OPERATORS.has(operatorText(node));
}

function isElseIf(node: Node): boolean {
  if (node.type === "elif_clause") {
    return node.parent?.type === "if_statement" || node.parent?.type === "elif_clause";
  }
  if (node.type !== "if_statement" && node.type !== "if_expression") return false;
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "else_clause") return true;
  if (parent.type !== "if_statement" && parent.type !== "if_expression") return false;
  const alternative = parent.childForFieldName("alternative");
  return alternative?.id === node.id;
}

function isDefaultArm(node: Node): boolean {
  if (node.type === "default_case" || node.type === "switch_default") return true;
  const text = nodeText(node).replace(/^\s+/u, "");
  if (node.type === "match_arm") {
    const pattern = node.childForFieldName("pattern");
    return nodeText(pattern).split("=>", 1)[0].trim() === "_";
  }
  return text.startsWith("default");
}

function countsAsDecision(node: Node): boolean {
  return DECISION_NODE_TYPES.has(node.type) ||
    (ARM_NODE_TYPES.has(node.type) && !isDefaultArm(node));
}

function hasMatchGuard(node: Node): boolean {
  if (node.type !== "match_arm") return false;
  const pattern = node.childForFieldName("pattern");
  return pattern?.childForFieldName("condition") != null;
}

function children(node: Node): Node[] {
  const result: Node[] = [];
  for (let index = node.childCount - 1; index >= 0; index -= 1) {
    const child = node.child(index);
    if (child) result.push(child);
  }
  return result;
}

interface MutableHotspot extends StructureHotspot {
  index: number;
}

function effectiveAncestorsFor(
  node: Node,
  ancestors: number[],
  branches: MutableHotspot[],
): number[] {
  const previous = ancestors.at(-1);
  const isConditional =
    node.type === "if_statement" || node.type === "if_expression" || node.type === "elif_clause";
  const previousIsConditional =
    previous !== undefined &&
    branches[previous]?.node_type !== undefined &&
    ["if_statement", "if_expression", "elif_clause"].includes(branches[previous].node_type);

  return previousIsConditional && isConditional && isElseIf(node)
    ? ancestors.slice(0, -1)
    : ancestors;
}

function addBranch(
  node: Node,
  ancestors: number[],
  branches: MutableHotspot[],
): { ancestors: number[]; decisions: number; nesting: number } {
  if (!CONTROL_NODE_TYPES.has(node.type)) {
    return { ancestors, decisions: 0, nesting: 0 };
  }

  const index = branches.length;
  const nesting = ancestors.length + 1;
  const counts = countsAsDecision(node);
  const guard = hasMatchGuard(node) ? 1 : 0;
  const decisions = (counts ? 1 : 0) + guard;
  const hotspot: MutableHotspot = {
    index,
    type: BRANCH_LABELS[node.type] ?? node.type,
    node_type: node.type,
    line: node.startPosition.row + 1,
    end_line: Math.max(
      node.startPosition.row + 1,
      node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0),
    ),
    nesting,
    counts_toward_cyclomatic: counts,
    guard_branches: guard,
    subtree_branches: decisions,
    subtree_control_nodes: 1,
    subtree_logical_branches: 0,
    subtree_max_nesting: nesting,
  };
  branches.push(hotspot);

  for (const parent of ancestors) {
    branches[parent].subtree_branches += decisions;
    branches[parent].subtree_control_nodes += 1;
    branches[parent].subtree_max_nesting = Math.max(
      branches[parent].subtree_max_nesting,
      nesting,
    );
  }

  return { ancestors: [...ancestors, index], decisions, nesting };
}

function addLogicalBranch(node: Node, ancestors: number[], branches: MutableHotspot[]): number {
  if (!isLogical(node)) return 0;
  for (const parent of ancestors) {
    branches[parent].subtree_logical_branches += 1;
  }
  return 1;
}

function hotspotComparator(left: MutableHotspot, right: MutableHotspot): number {
  return (
    right.subtree_branches - left.subtree_branches ||
    right.subtree_logical_branches - left.subtree_logical_branches ||
    right.subtree_control_nodes - left.subtree_control_nodes ||
    right.nesting - left.nesting ||
    left.line - right.line ||
    left.end_line - right.end_line
  );
}

export function measureComplexity(
  root: Node,
  language: string,
  excludeNested = false,
): ComplexityMetrics {
  if (!COMPLEXITY_LANGUAGES.has(language)) return unsupported();

  const branches: MutableHotspot[] = [];
  let logicalCount = 0;
  let decisionCount = 0;
  let maxNesting = 0;
  const stack: Array<{ node: Node; ancestors: number[] }> = [{ node: root, ancestors: [] }];

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) continue;
    const { node, ancestors } = item;
    if (node !== root && excludeNested && isFunction(node)) continue;

    const effectiveAncestors = effectiveAncestorsFor(node, ancestors, branches);
    const branch = addBranch(node, effectiveAncestors, branches);
    decisionCount += branch.decisions;
    maxNesting = Math.max(maxNesting, branch.nesting);
    logicalCount += addLogicalBranch(node, effectiveAncestors, branches);

    for (const child of children(node)) {
      stack.push({ node: child, ancestors: branch.ancestors });
    }
  }

  const structure_hotspots = branches
    .sort(hotspotComparator)
    .slice(0, 24)
    .map(({ index: _index, ...hotspot }) => hotspot);

  return {
    complexity_status: "supported",
    complexity_adapter: "core-tree-sitter-v1",
    cyclomatic_complexity: 1 + decisionCount + logicalCount,
    control_branch_count: decisionCount,
    logical_branch_count: logicalCount,
    max_nesting: maxNesting,
    structure_hotspots,
  };
}
