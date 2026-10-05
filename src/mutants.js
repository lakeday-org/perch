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

const COMPARISONS = { '<': '<=', '<=': '<', '>': '>=', '>=': '>', '==': '!=', '!=': '==', '===': '!==', '!==': '===', '~=': '==' };
const ARITHMETIC = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' };
const LOGIC = { '&&': '||', '||': '&&', and: 'or', or: 'and' };
/** The order mutants are kept in when a method has more than MAX_MUTANTS: what a test is likeliest to have missed first. */
const PRIORITY = ['boundary', 'logic', 'condition', 'not', 'arithmetic', 'boolean', 'return'];

// The node that holds a binary operator, by language. Where the grammar gives the operator no field, it is the unnamed child.
const BINARY = new Set(['binary_expression', 'binary_operator', 'boolean_operator', 'comparison_operator',
  'comparison_expression', 'equality_expression', 'additive_expression', 'multiplicative_expression', 'conjunction_expression', 'disjunction_expression',
  // Ruby
  'binary']);
// A condition a statement branches on: the field that holds it, and whether it is wrapped in parentheses the grammar keeps.
// Ruby's `unless` and `until` branch on the condition's opposite, and `x += 1 if y` is an if with the branch written first; each
// still has one condition, and negating it still swaps which way the statement goes.
const CONDITIONS = new Set(['if_statement', 'while_statement', 'if_expression', 'while_expression',
  'if', 'unless', 'while', 'until', 'elsif', 'if_modifier', 'unless_modifier', 'while_modifier', 'until_modifier',
  'else_if_clause', 'elseif_statement']);
const WRAPPED = new Set(['parenthesized_expression', 'condition_clause', 'parenthesized_statements']);
const NOT = new Set(['unary_expression', 'not_operator', 'unary', 'unary_op_expression']);
const BOOLEANS = new Set(['true', 'false', 'boolean_literal', 'boolean']);
const RETURNS = new Set(['return_statement', 'return_expression', 'return']);
const NUMBERS = new Set(['number', 'integer', 'float', 'integer_literal', 'float_literal', 'decimal_integer_literal', 'int_literal', 'number_literal']);
/** Languages that spell negation `not` and inequality `~=` or `!=` in their own way. */
const NOT_WORD = new Set(['python', 'lua']);
/** Languages whose return holds a list of what is returned: Ruby's argument_list, Lua's expression_list. */
const LISTED_RETURNS = new Set(['ruby', 'lua']);

const operatorOf = node => node.childForFieldName('operator') ?? node.children.find(child => !child.isNamed && (child.text in COMPARISONS || child.text in ARITHMETIC || child.text in LOGIC)) ?? null;

/** What a comparison becomes: its boundary moved, or its sense flipped in the language's own spelling (`~=` in Lua, `!=` elsewhere). */
const comparisonSwap = (text, language) => (text === '==' && language === 'lua' ? '~=' : COMPARISONS[text]);

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
  const negated = (text, word) => (word ? `not (${text})` : `!(${text})`);
  const walk = node => {
    if (node.startPosition.row + 1 <= end_line && node.endPosition.row + 1 >= line) {
      if (BINARY.has(node.type)) {
        const operator = operatorOf(node);
        const text = operator?.text;
        if (text in COMPARISONS) add('boundary', operator, comparisonSwap(text, normalized));
        else if (text in LOGIC) add('logic', operator, LOGIC[text]);
        else if (text in ARITHMETIC) add('arithmetic', operator, ARITHMETIC[text]);
      }
      if (CONDITIONS.has(node.type)) {
        const condition = node.childForFieldName('condition');
        // `if let` binds a pattern rather than testing a value; there is no condition to negate.
        if (condition && !/^let/.test(condition.type)) {
          const inner = WRAPPED.has(condition.type) ? condition.namedChildren[0] : condition;
          if (inner) add('condition', inner, negated(inner.text, NOT_WORD.has(normalized)));
        }
      }
      if (NOT.has(node.type)) {
        const operator = node.childForFieldName('operator') ?? node.children.find(child => !child.isNamed);
        const operand = node.childForFieldName('argument') ?? node.childForFieldName('operand') ?? node.namedChildren[0];
        if (operand && (operator?.text === '!' || operator?.text === 'not')) add('not', node, operand.text);
      }
      if (BOOLEANS.has(node.type)) add('boolean', node, node.text.toLowerCase() === 'true' ? (node.text[0] === 'T' ? 'False' : 'false') : (node.text[0] === 'F' ? 'True' : 'true'));
      if (RETURNS.has(node.type)) {
        // Ruby and Lua list what is returned: `return 0` holds an argument_list or an expression_list of one number.
        const listed = LISTED_RETURNS.has(normalized) && node.namedChildren.length === 1 && ['argument_list', 'expression_list'].includes(node.namedChildren[0].type) ? node.namedChildren[0] : node;
        const value = listed.namedChildren[0];
        if (value && listed.namedChildren.length === 1 && NUMBERS.has(value.type)) add('return', value, /^0+(\.0+)?$/.test(value.text) ? '1' : '0');
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
