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
const ARITHMETIC = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' };
const LOGIC = { '&&': '||', '||': '&&', and: 'or', or: 'and' };
/** The order mutants are kept in when a method has more than MAX_MUTANTS: what a test is likeliest to have missed first. */
const PRIORITY = ['boundary', 'logic', 'condition', 'not', 'arithmetic', 'boolean', 'return'];

// The node that holds a binary operator, by language. Where the grammar gives the operator no field, it is the unnamed child.
// Scala writes every binary operator as an infix_expression whose operator is a named operator_identifier; Swift reads a
// comparison beside a `||` as an infix_expression with a custom_operator in its `op` field.
const BINARY = new Set(['binary_expression', 'binary_operator', 'boolean_operator', 'comparison_operator',
  'comparison_expression', 'equality_expression', 'additive_expression', 'multiplicative_expression', 'conjunction_expression', 'disjunction_expression', 'infix_expression']);
// A condition a statement branches on: the field that holds it, and whether it is wrapped in parentheses the grammar keeps.
const CONDITIONS = new Set(['if_statement', 'while_statement', 'if_expression', 'while_expression']);
const WRAPPED = new Set(['parenthesized_expression', 'condition_clause']);
// A prefix operator with its operand: C#'s prefix_unary_expression, Swift's prefix_expression with a `bang` node for the `!`,
// Scala's prefix_expression with the `!` unnamed.
const NOT = new Set(['unary_expression', 'not_operator', 'prefix_unary_expression', 'prefix_expression']);
const BOOLEANS = new Set(['true', 'false', 'boolean_literal']);
// Swift's return is a control_transfer_statement whose result is the value; a bare `break` or `continue` has none.
const RETURNS = new Set(['return_statement', 'return_expression', 'control_transfer_statement']);
const NUMBERS = new Set(['number', 'integer', 'float', 'integer_literal', 'float_literal', 'decimal_integer_literal', 'int_literal', 'number_literal']);

const KNOWN = text => text in COMPARISONS || text in ARITHMETIC || text in LOGIC;
const operatorOf = node => [node.childForFieldName('operator'), node.childForFieldName('op')].find(child => child && KNOWN(child.text))
  ?? node.children.find(child => !child.isNamed && KNOWN(child.text)) ?? null;

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
  const negated = (text, python) => (python ? `not (${text})` : `!(${text})`);
  const walk = node => {
    if (node.startPosition.row + 1 <= end_line && node.endPosition.row + 1 >= line) {
      if (BINARY.has(node.type)) {
        const operator = operatorOf(node);
        const text = operator?.text;
        if (text in COMPARISONS) add('boundary', operator, COMPARISONS[text]);
        else if (text in LOGIC) add('logic', operator, LOGIC[text]);
        else if (text in ARITHMETIC) add('arithmetic', operator, ARITHMETIC[text]);
      }
      if (CONDITIONS.has(node.type)) {
        const condition = node.childForFieldName('condition');
        // `if let` binds a pattern rather than testing a value; there is no condition to negate.
        if (condition && !/^let/.test(condition.type)) {
          const inner = WRAPPED.has(condition.type) ? condition.namedChildren[0] : condition;
          if (inner) add('condition', inner, negated(inner.text, normalized === 'python'));
        }
      }
      if (NOT.has(node.type)) {
        const operator = node.childForFieldName('operator') ?? node.childForFieldName('operation') ?? node.children.find(child => !child.isNamed);
        const operand = node.childForFieldName('argument') ?? node.childForFieldName('operand') ?? node.childForFieldName('target') ?? node.namedChildren.find(child => child !== operator);
        if (operand && (operator?.text === '!' || operator?.text === 'not')) add('not', node, operand.text);
      }
      if (BOOLEANS.has(node.type)) add('boolean', node, node.text.toLowerCase() === 'true' ? (node.text[0] === 'T' ? 'False' : 'false') : (node.text[0] === 'F' ? 'True' : 'true'));
      if (RETURNS.has(node.type) && (node.type !== 'control_transfer_statement' || node.children[0]?.text === 'return')) {
        const value = node.namedChildren[0];
        if (value && node.namedChildren.length === 1 && NUMBERS.has(value.type)) add('return', value, /^0+(\.0+)?$/.test(value.text) ? '1' : '0');
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
