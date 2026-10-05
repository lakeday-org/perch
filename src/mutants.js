/**
 * The bugs perch plants in a method to ask whether its tests would notice: one-token edits of the kind a developer makes by
 * mistake, read off the syntax tree by a fixed table. No model proposes them; the model is asked, for each one, whether the
 * tests reaching the method would fail with it in. These are the operators mutation testers have used for decades: a
 * comparison moved to its boundary, a connective swapped, a condition negated, a `!` dropped, an arithmetic operator changed,
 * a boolean flipped, a returned number zeroed.
 */
import pack from '@xberg-io/tree-sitter-language-pack';
import { Node } from './treesitter/node.ts';
import { downloading, normalizeLanguage } from './treesitter/languages.ts';

/** How many of a method's mutants are asked about, most telling first: boundaries and conditions before arithmetic and literals. */
export const MAX_MUTANTS = 10;

const COMPARISONS = { '<': '<=', '<=': '<', '>': '>=', '>=': '>', '==': '!=', '!=': '==', '===': '!==', '!==': '===' };
/** The same comparisons as Bash's `test` spells them: `[ "$n" -ge 100 ]`. */
const TEST_COMPARISONS = { '-eq': '-ne', '-ne': '-eq', '-lt': '-le', '-le': '-lt', '-gt': '-ge', '-ge': '-gt' };
const ARITHMETIC = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' };
const LOGIC = { '&&': '||', '||': '&&', and: 'or', or: 'and' };
/** The order mutants are kept in when a method has more than MAX_MUTANTS: what a test is likeliest to have missed first. */
const PRIORITY = ['boundary', 'logic', 'condition', 'not', 'arithmetic', 'boolean', 'return'];

// The node that holds a binary operator, by language. Where the grammar gives the operator no field, it is the unnamed child.
// Bash's `[ a ] && [ b ]` is a `list` of two commands with the connective between them; a list is read only in Bash, since Python
// names its list literal the same.
// Zig's BinaryExpr holds its operator in a CompareOp, AdditionOp or MultiplyOp node, or as the bare `and`/`or` keyword.
// Scala writes every binary operator as an infix_expression whose operator is a named operator_identifier; Swift reads a
// comparison beside a `||` as an infix_expression with a custom_operator in its `op` field.
const BINARY = new Set(['binary_expression', 'binary_operator', 'boolean_operator', 'comparison_operator',
  'comparison_expression', 'equality_expression', 'additive_expression', 'multiplicative_expression', 'conjunction_expression', 'disjunction_expression', 'BinaryExpr', 'infix_expression']);
// A condition a statement branches on: the field that holds it, and whether it is wrapped in parentheses the grammar keeps.
const CONDITIONS = new Set(['if_statement', 'while_statement', 'if_expression', 'while_expression', 'IfPrefix', 'WhilePrefix']);
// Zig's IfPrefix and WhilePrefix give the condition no field: it is the first named child, between the keyword's parentheses.
const PREFIXED = new Set(['IfPrefix', 'WhilePrefix']);
const WRAPPED = new Set(['parenthesized_expression', 'condition_clause']);
// A prefix operator with its operand: C#'s prefix_unary_expression, Swift's prefix_expression with a `bang` node for the `!`,
// Scala's prefix_expression with the `!` unnamed, Bash's negated_command, Zig's UnaryExpr.
const NOT = new Set(['unary_expression', 'not_operator', 'negated_command', 'UnaryExpr', 'prefix_unary_expression', 'prefix_expression']);
const BOOLEANS = new Set(['true', 'false', 'boolean_literal']);
// Swift's return is a control_transfer_statement whose result is the value; a bare `break` or `continue` has none.
const RETURNS = new Set(['return_statement', 'return_expression', 'control_transfer_statement']);
const NUMBERS = new Set(['number', 'integer', 'float', 'integer_literal', 'float_literal', 'decimal_integer_literal', 'int_literal', 'number_literal', 'INTEGER', 'FLOAT']);
// Nodes that hold one expression and add nothing to it: Solidity wraps every operand in `expression`, Zig every operand in an
// ErrorUnionExpr around a SuffixExpr. A returned literal is read through them.
const WRAPPERS = new Set(['expression', 'ErrorUnionExpr', 'SuffixExpr']);

const KNOWN = text => text in COMPARISONS || text in ARITHMETIC || text in LOGIC || text in TEST_COMPARISONS;
const operatorOf = node => [node.childForFieldName('operator'), node.childForFieldName('op')].find(child => child && KNOWN(child.text))
  ?? node.children.find(child => !child.isNamed && KNOWN(child.text)) ?? null;
/** Zig has no return node: `return x;` is an AssignExpr whose first token is the keyword. Swift's control_transfer_statement is one only when it starts with `return`. */
const isReturn = node => (RETURNS.has(node.type) && (node.type !== 'control_transfer_statement' || node.children[0]?.text === 'return'))
  || (node.type === 'AssignExpr' && node.children[0]?.isNamed === false && node.children[0].text === 'return');
const unwrapped = node => { while (WRAPPERS.has(node.type) && node.childCount === 1 && node.namedChildren.length === 1) node = node.namedChildren[0]; return node; };

/** A Bash command's name and arguments: `return 1` is the command return with the argument 1. */
const bashCommand = node => ({ name: node.childForFieldName('name')?.text, args: node.namedChildren.filter(child => child.type !== 'command_name') });

/**
 * The mutants of the method at lines `line` to `end_line` of `source`, most telling first and no more than MAX_MUTANTS. Each is
 * one node's text replaced: where, what it said, what it says instead, and the whole line both ways.
 */
export function mutantsOf({ source, language, line, end_line }) {
  const normalized = normalizeLanguage(language);
  if (!normalized) return [];
  const bytes = Buffer.from(source);
  const root = new Node(downloading(() => pack.getParser(normalized)).parse(source).rootNode(), bytes);
  const found = [];
  const add = (kind, node, to) => {
    const row = node.startPosition.row;
    if (row + 1 < line || row + 1 > end_line || node.text === to) return;
    const mutated = Buffer.concat([bytes.subarray(0, node.startIndex), Buffer.from(to), bytes.subarray(node.endIndex)]).toString('utf8').split('\n')[row];
    found.push({ kind, line: row + 1, column: node.startPosition.column, from: node.text, to, original: source.split('\n')[row], mutated });
  };
  // How each language negates a condition: Python's `not`, Bash's `!` before a command or a braced list, `!(...)` elsewhere.
  const negated = (inner) => (normalized === 'python' ? `not (${inner.text})`
    : normalized === 'bash' ? (inner.type === 'list' ? `! { ${inner.text}; }` : `! ${inner.text}`) : `!(${inner.text})`);
  const walk = node => {
    if (node.startPosition.row + 1 <= end_line && node.endPosition.row + 1 >= line) {
      if (BINARY.has(node.type) || (normalized === 'bash' && node.type === 'list')) {
        const operator = operatorOf(node);
        const text = operator?.text;
        if (text in COMPARISONS) add('boundary', operator, COMPARISONS[text]);
        else if (text in TEST_COMPARISONS) add('boundary', operator, TEST_COMPARISONS[text]);
        else if (text in LOGIC) add('logic', operator, LOGIC[text]);
        else if (text in ARITHMETIC) add('arithmetic', operator, ARITHMETIC[text]);
      }
      if (CONDITIONS.has(node.type)) {
        const condition = node.childForFieldName('condition') ?? (PREFIXED.has(node.type) ? node.namedChildren[0] : null);
        // `if let` binds a pattern rather than testing a value; there is no condition to negate.
        if (condition && !/^let/.test(condition.type)) {
          const inner = WRAPPED.has(condition.type) ? condition.namedChildren[0] : condition;
          if (inner) add('condition', inner, negated(inner));
        }
      }
      if (NOT.has(node.type)) {
        const operator = node.childForFieldName('operator') ?? node.childForFieldName('operation') ?? node.children.find(child => !child.isNamed);
        const operand = node.childForFieldName('argument') ?? node.childForFieldName('operand') ?? node.childForFieldName('target') ?? node.namedChildren.find(child => child !== operator);
        if (operand && (operator?.text === '!' || operator?.text === 'not')) add('not', node, operand.text);
      }
      // Solidity's boolean_literal holds a `true` node: one literal, read once.
      if (BOOLEANS.has(node.type) && !BOOLEANS.has(node.parent?.type)) add('boolean', node, node.text.toLowerCase() === 'true' ? (node.text[0] === 'T' ? 'False' : 'false') : (node.text[0] === 'F' ? 'True' : 'true'));
      if (isReturn(node)) {
        // Go returns an expression_list; one number in it is the returned number. Zig and Solidity wrap the value in expression nodes.
        const listed = node.namedChildren.length === 1 ? node.namedChildren[0] : null;
        const value = listed ? unwrapped(listed.type === 'expression_list' && listed.namedChildren.length === 1 ? listed.namedChildren[0] : listed) : null;
        if (value && NUMBERS.has(value.type)) add('return', value, /^0+(\.0+)?$/.test(value.text) ? '1' : '0');
      }
      // Bash's `return 0` is the command return with one number: success, or any other number for failure.
      if (normalized === 'bash' && node.type === 'command') {
        const { name, args } = bashCommand(node);
        if (name === 'return' && args.length === 1 && args[0].type === 'number') add('return', args[0], /^0+$/.test(args[0].text) ? '1' : '0');
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return found.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || a.line - b.line || a.column - b.column).slice(0, MAX_MUTANTS);
}

/** A mutant's id within its method: where it is and what it does, stable across runs. */
export const mutantId = mutant => `${mutant.line}:${mutant.column}:${mutant.from}>${mutant.to}`;

/** How a mutant reads in a sentence: what the line said and what it says instead. */
export const describeMutant = mutant => `\`${mutant.to}\` instead of \`${mutant.from}\``;
