/**
 * The mutants perch makes of a method to ask whether its tests would notice: the edits a developer makes by mistake, read off
 * the syntax tree by a fixed table. No model proposes them; the model is asked, for each one, whether the tests reaching the
 * method would fail against it. They are the operators Stryker and PIT use: a comparison moved to its boundary or flipped, a
 * connective swapped, a condition forced true or false, an `if` body emptied, a call statement removed, a `!` or a minus
 * dropped, an arithmetic or update operator changed, a boolean flipped, a string emptied, a number moved by one, a returned
 * value replaced, and the whole body emptied, which asks the oldest question about a test: does it notice when the function does
 * nothing? Every mutant a method has is made; none is left out for being the eleventh.
 */
import { createHash } from 'node:crypto';
import pack from '@xberg-io/tree-sitter-language-pack';
import { Node } from './treesitter/node.ts';
import { downloading, normalizeLanguage } from './treesitter/languages.ts';
import { FUNCTION_TYPES } from './treesitter/metrics.ts';

const COMPARISONS = { '<': '<=', '<=': '<', '>': '>=', '>=': '>', '==': '!=', '!=': '==', '===': '!==', '!==': '===', '~=': '==' };
/** The same comparisons as Bash's `test` spells them: `[ "$n" -ge 100 ]`. */
const TEST_COMPARISONS = { '-eq': '-ne', '-ne': '-eq', '-lt': '-le', '-le': '-lt', '-gt': '-ge', '-ge': '-gt' };
const ARITHMETIC = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' };
const LOGIC = { '&&': '||', '||': '&&', and: 'or', or: 'and' };
/** `n += 1` and `n++`: the update that goes the other way. */
const UPDATES = { '+=': '-=', '-=': '+=', '*=': '/=', '/=': '*=', '++': '--', '--': '++' };

// The node that holds a binary operator, by language. Where the grammar gives the operator no field, it is the unnamed child.
// Bash's `[ a ] && [ b ]` is a `list` of two commands with the connective between them; a list is read only in Bash, since Python
// names its list literal the same. Zig's BinaryExpr holds its operator in a CompareOp, AdditionOp or MultiplyOp node, or as the
// bare `and`/`or` keyword. Scala writes every binary operator as an infix_expression whose operator is a named operator_identifier;
// Swift reads a comparison beside a `||` as an infix_expression with a custom_operator in its `op` field.
const BINARY = new Set(['binary_expression', 'binary_operator', 'boolean_operator', 'comparison_operator',
  'comparison_expression', 'equality_expression', 'additive_expression', 'multiplicative_expression', 'conjunction_expression', 'disjunction_expression',
  'BinaryExpr', 'infix_expression',
  // Ruby
  'binary']);
// An update written as an assignment with an operator, `n += 1`, or as `n++`.
const UPDATED = new Set(['augmented_assignment_expression', 'augmented_assignment', 'assignment_statement', 'compound_assignment_expr', 'assignment_expression',
  'operator_assignment', 'assignment', 'AssignExpr', 'update_expression', 'inc_statement', 'dec_statement', 'postfix_unary_expression', 'prefix_unary_expression']);
// A statement that branches on a condition. Ruby's `unless` and `until` branch on the condition's opposite, and `x += 1 if y` is
// an if with the branch written first; each still has one condition, and a constant in its place still decides the branch.
const IFS = new Set(['if_statement', 'if_expression', 'IfPrefix', 'if', 'unless', 'elsif', 'if_modifier', 'unless_modifier', 'else_if_clause', 'elseif_statement']);
const LOOPS = new Set(['while_statement', 'while_expression', 'WhilePrefix', 'while', 'until', 'while_modifier', 'until_modifier']);
// Zig's IfPrefix and WhilePrefix give the condition no field: it is the first named child, between the keyword's parentheses.
const PREFIXED = new Set(['IfPrefix', 'WhilePrefix']);
const WRAPPED = new Set(['parenthesized_expression', 'condition_clause', 'parenthesized_statements']);
// A prefix operator with its operand: C#'s prefix_unary_expression, Swift's prefix_expression with a `bang` node for the `!`,
// Scala's prefix_expression with the `!` unnamed, Bash's negated_command, Zig's UnaryExpr, Ruby's unary, PHP's unary_op_expression.
const NOT = new Set(['unary_expression', 'unary_operator', 'not_operator', 'negated_command', 'UnaryExpr', 'prefix_unary_expression', 'prefix_expression', 'unary', 'unary_op_expression']);
const BOOLEANS = new Set(['true', 'false', 'boolean_literal', 'boolean']);
// Swift's return is a control_transfer_statement whose result is the value; a bare `break` or `continue` has none. Ruby's is `return`.
const RETURNS = new Set(['return_statement', 'return_expression', 'control_transfer_statement', 'jump_expression', 'return']);
const NUMBERS = new Set(['number', 'integer', 'float', 'integer_literal', 'float_literal', 'decimal_integer_literal', 'int_literal', 'number_literal', 'INTEGER', 'FLOAT']);
// A string literal, by grammar. A string with something interpolated into it is not a literal and is left alone.
const STRINGS = new Set(['string', 'string_literal', 'interpreted_string_literal', 'raw_string_literal', 'line_string_literal', 'encapsed_string', 'STRINGLITERALSINGLE', 'template_string', 'raw_string']);
const STRING_PARTS = new Set(['string_start', 'string_content', 'string_end', 'string_fragment', 'escape_sequence', 'interpreted_string_literal_content', 'raw_string_literal_content',
  'line_str_text', 'string_literal_content', 'multiline_string_content']);
// Where a string is a name rather than a value: what is imported, an object's key, a decorator's or attribute's argument.
const NAMED_BY_STRINGS = new Set(['import_statement', 'import_from_statement', 'import_declaration', 'import_spec', 'preproc_include', 'namespace_use_declaration', 'use_declaration',
  'import_directive', 'pair', 'decorator', 'annotation', 'attribute', 'attribute_argument', 'marker_annotation', 'modifier']);
const IMPORT_CALLS = new Set(['require', 'require_relative', 'import', '@import', 'include', 'include_once', 'require_once', 'load', 'source', 'use']);
// A list, a dictionary, an object: an empty one of the same kind is a value a caller can hold and find nothing in.
const EMPTIES = { array: '[]', list: '[]', object: '{}', dictionary: '{}', hash: '{}', table_constructor: '{}', array_creation_expression: '[]' };
// Nodes that hold one expression and add nothing to it: Solidity wraps every operand in `expression`, Zig every operand in an
// ErrorUnionExpr around a SuffixExpr. A returned literal is read through them.
const WRAPPERS = new Set(['expression', 'ErrorUnionExpr', 'SuffixExpr', 'await_expression']);
/** The null a dynamic language returns when a method returns nothing it meant to; a typed language has no value that compiles. */
const NULLS = { javascript: 'null', python: 'None', ruby: 'nil', lua: 'nil', php: 'null' };
/** Languages whose functions carry no return type, so an emptied body is the whole edit. */
const UNTYPED = new Set(['javascript', 'python', 'ruby', 'lua']);
/** The zero of a declared return type, where the type has one every language spells alike; anything else gets no body mutant. */
const ZEROS = {
  number: '0', int: '0', long: '0', short: '0', byte: '0', double: '0', float: '0', decimal: '0', Int: '0', Double: '0', Float: '0', Long: '0',
  i8: '0', i16: '0', i32: '0', i64: '0', i128: '0', u8: '0', u16: '0', u32: '0', u64: '0', u128: '0', usize: '0', isize: '0', f32: '0', f64: '0',
  int8: '0', int16: '0', int32: '0', int64: '0', uint: '0', uint8: '0', uint16: '0', uint32: '0', uint64: '0', uint128: '0', uint256: '0', int256: '0',
  bool: 'false', boolean: 'false', Bool: 'false', Boolean: 'false',
  string: '""', String: '""', str: '""', '&str': '""',
};
/** The types a function returns nothing under. */
const NOTHING = new Set(['', 'void', 'Unit', '()', 'None', 'Promise<void>']);
/** How each language writes a return of a value in a one-statement body, and an empty body. */
const RETURN_STYLE = {
  tail: new Set(['rust', 'scala']), bare: new Set(['go', 'swift', 'kotlin']),
};

/** Languages where a block's last expression is its value: a call there is a return, not a statement to remove. */
const TAIL_VALUES = new Set(['rust', 'scala', 'kotlin', 'ruby']);
/** The containers a statement sits directly in, and the call nodes a statement can be. */
const STATEMENT_CONTAINERS = new Set(['statement_block', 'block', 'statements', 'body_statement', 'then', 'else', 'do_block', 'compound_statement', 'statement_list',
  'function_body', 'control_structure_body', 'chunk', 'program', 'Block', 'block_statement', 'function_body_block', 'module', 'template_body', 'class_body', 'declaration_list']);
const CALLS = new Set(['call_expression', 'call', 'method_invocation', 'invocation_expression', 'function_call', 'function_call_expression', 'member_call_expression',
  'scoped_call_expression', 'nullsafe_member_call_expression', 'macro_invocation']);
/** Calls a statement is never without: a constructor's chaining, an assertion a test file reads, a module load. */
const KEPT_CALLS = new Set(['super', 'this', 'base', ...IMPORT_CALLS]);
const STATEMENT_WRAPPERS = new Set(['expression_statement', 'statement', 'Statement', 'AssignExpr']);

const KNOWN = text => text in COMPARISONS || text in ARITHMETIC || text in LOGIC || text in TEST_COMPARISONS || text in UPDATES;
const operatorOf = node => [node.childForFieldName('operator'), node.childForFieldName('op')].find(child => child && KNOWN(child.text))
  ?? node.namedChildren.find(child => child.type === 'AssignOp' && KNOWN(child.text))
  ?? node.children.find(child => !child.isNamed && KNOWN(child.text)) ?? null;
/** Zig has no return node: `return x;` is an AssignExpr whose first token is the keyword. Swift's control_transfer_statement is one only when it starts with `return`. */
const isReturn = node => (RETURNS.has(node.type) && (!['control_transfer_statement', 'jump_expression'].includes(node.type) || node.children[0]?.text === 'return'))
  || (node.type === 'AssignExpr' && node.children[0]?.isNamed === false && node.children[0].text === 'return');
const unwrapped = node => { while (WRAPPERS.has(node.type) && node.namedChildren.length === 1) node = node.namedChildren[0]; return node; };

/** A Bash command's name and arguments: `return 1` is the command return with the argument 1. */
const bashCommand = node => ({ name: node.childForFieldName('name')?.text, args: node.namedChildren.filter(child => child.type !== 'command_name') });

/** What a comparison becomes: its boundary moved, or its sense flipped in the language's own spelling (`~=` in Lua, `!=` elsewhere). */
const comparisonSwap = (text, language) => (text === '==' && language === 'lua' ? '~=' : COMPARISONS[text]);

/** A string literal's text emptied, keeping its own quotes: `"hello"` is `""`, `'x'` is `''`, Go's `` `raw` `` is ``` `` ```. */
function emptied(text) {
  const match = /^([a-zA-Z@$]*)(["'`]+)([\s\S]*)\2$/.exec(text);
  if (!match || !match[3]) return null;
  return `${match[1]}${match[2]}${match[2]}`;
}

/** Whether a string literal is a value: not a docstring, not a name something is imported or keyed by, not interpolated. */
function isValueString(node, language) {
  // Solidity's string_literal holds a string; anything else inside, an interpolation, makes it no literal.
  if (node.namedChildren.some(child => !STRING_PARTS.has(child.type) && !STRINGS.has(child.type) && !child.type.includes('comment'))) return false;
  for (let parent = node.parent, depth = 0; parent && depth < 4; parent = parent.parent, depth++) {
    // An object's key names a property; its value is a value.
    if (parent.type === 'pair') { if (parent.childForFieldName('key')?.id === node.id) return false; continue; }
    if (NAMED_BY_STRINGS.has(parent.type)) return false;
    if (CALLS.has(parent.type) || parent.type === 'command') {
      const callee = parent.childForFieldName('function') ?? parent.childForFieldName('name') ?? parent.childForFieldName('method') ?? parent.namedChildren[0];
      if (callee && IMPORT_CALLS.has(callee.text.replace(/!$/, ''))) return false;
    }
    // Python's docstring and a bare string statement anywhere: a value nobody reads.
    if (depth === 0 && (STATEMENT_CONTAINERS.has(parent.type) || (parent.type === 'expression_statement' && parent.namedChildren.length === 1))) return false;
  }
  return language !== 'bash' || node.parent?.type !== 'command_name';
}

/** The call a statement makes and nothing else, or null: `save(items);`, `await flush();`, Zig's `cart.add(x);`. */
function statementCall(node, language) {
  if (!node.parent || !STATEMENT_CONTAINERS.has(node.parent.type)) return null;
  if (TAIL_VALUES.has(language) && node.parent.namedChildren.filter(child => !child.type.includes('comment')).at(-1) === node) return null;
  let inner = node;
  while ((STATEMENT_WRAPPERS.has(inner.type) || WRAPPERS.has(inner.type)) && inner.type !== 'SuffixExpr') {
    const children = inner.namedChildren.filter(child => !child.type.includes('comment'));
    if (children.length !== 1) return null;
    inner = children[0];
  }
  if (inner.type === 'SuffixExpr') return inner.namedChildren.some(child => child.type === 'FnCallArguments' || (child.type === 'FieldOrFnCall' && child.namedChildren.some(item => item.type === 'FnCallArguments'))) ? inner : null;
  return CALLS.has(inner.type) ? inner : null;
}

/** What a call runs, as its head name: `save`, `this.save`, `cart.add`. */
function calleeName(call) {
  const callee = call.childForFieldName('function') ?? call.childForFieldName('method') ?? call.childForFieldName('name') ?? call.namedChildren[0];
  return callee?.text.split(/[.(]/)[0] ?? '';
}

/** The body a branch runs, as the grammar holds it: a field for most, Swift's statements child, Zig's BlockExpr, Ruby's then. */
function consequenceOf(node) {
  const held = node.childForFieldName('consequence') ?? node.childForFieldName('body');
  if (held) return held.type === 'BlockExpr' ? held.namedChildren[0] ?? held : held;
  if (node.type === 'IfPrefix' && node.parent?.type === 'IfStatement') return node.parent.namedChildren.find(child => child.type === 'BlockExpr')?.namedChildren[0] ?? null;
  return node.namedChildren.find(child => ['statements', 'then', 'block', 'statement_block', 'compound_statement', 'control_structure_body', 'block_statement'].includes(child.type)) ?? null;
}

/** The declared return type of a function, as written, or null where the language declares none. */
function returnTypeOf(fn, language) {
  if (UNTYPED.has(language)) return '';
  if (language === 'zig') {
    const last = fn.namedChildren.find(item => item.type === 'FnProto')?.namedChildren.at(-1);
    return last && !['IDENTIFIER', 'ParamDeclList'].includes(last.type) ? last.text : null;
  }
  if (language === 'solidity') return fn.namedChildren.find(item => item.type === 'return_type_definition')?.text ?? '';
  if (language === 'kotlin' || language === 'swift') {
    // The type sits between the parameters and the body, with no field of its own; a function without one returns nothing.
    const typed = fn.namedChildren.find(item => ['user_type', 'nullable_type', 'optional_type', 'tuple_type', 'function_type'].includes(item.type) && item.startIndex > (fn.childForFieldName('parameters')?.endIndex ?? fn.namedChildren.find(child => child.type === 'function_value_parameters' || child.type === 'parameter')?.endIndex ?? 0));
    return typed?.text ?? '';
  }
  const declared = fn.childForFieldName('return_type') ?? fn.childForFieldName('result') ?? fn.childForFieldName('returns')
    ?? (['java', 'c', 'cpp'].includes(language) ? fn.childForFieldName('type') : null);
  return declared?.text ?? '';
}

/** A return type's text reduced to the name the tables know: `: number`, `-> i32`, `returns (uint256)`, `string memory`. */
const typeName = text => text.replace(/^(:|->|returns)\s*/, '').replace(/^\((.*)\)$/, '$1').replace(/\b(memory|calldata|storage)\b/g, '').trim();

/** The body a function runs, as the grammar holds it. */
const bodyOf = fn => fn.childForFieldName('body')
  ?? fn.namedChildren.find(item => ['function_body', 'Block', 'block', 'statement_block', 'compound_statement', 'body_statement'].includes(item.type)) ?? null;

/**
 * The function at exactly these lines with its body replaced: emptied, or returning its type's zero. Null when the body is empty
 * already, or the type has no zero every test would compile against.
 */
function bodyMutant(root, language, line, end_line) {
  let fn = null;
  const find = node => {
    if (fn) return;
    if ((FUNCTION_TYPES.has(node.type) || node.type === 'Decl') && node.startPosition.row + 1 === line && node.endPosition.row + 1 === end_line) { fn = node; return; }
    for (const child of node.children) find(child);
  };
  find(root);
  const body = fn && bodyOf(fn);
  if (!body || !body.namedChildren.some(child => !child.type.includes('comment'))) return null;
  const declared = returnTypeOf(fn, language);
  if (declared === null) return null;
  const name = typeName(declared);
  const braced = body.text.startsWith('{');
  if (NOTHING.has(name)) return { body, to: braced ? '{}' : language === 'python' ? 'pass' : '' };
  if (language === 'rust' && name === 'String') return { body, to: '{ String::new() }' };
  const zero = ZEROS[name];
  if (zero === undefined || !braced) return null;
  const value = language === 'php' && zero === '""' ? "''" : zero;
  return { body, to: RETURN_STYLE.tail.has(language) ? `{ ${value} }` : RETURN_STYLE.bare.has(language) ? `{ return ${value} }` : `{ return ${value}; }` };
}

/**
 * Every mutant of the method at lines `line` to `end_line` of `source`, in the order they sit in it. Each is one node's text
 * replaced: where, what it said, what it says instead, and the lines it touches both ways.
 */
export function mutantsOf({ source, language, line, end_line }) {
  const normalized = normalizeLanguage(language);
  if (!normalized) return [];
  const bytes = Buffer.from(source);
  const root = new Node(downloading(() => pack.getParser(normalized)).parse(source).rootNode(), bytes);
  const lineStarts = [0];
  for (let at = 0; at < bytes.length; at++) if (bytes[at] === 10) lineStarts.push(at + 1);
  const found = [], seen = new Set();
  const add = (kind, node, to) => {
    const row = node.startPosition.row, last = node.endPosition.row;
    if (row + 1 < line || row + 1 > end_line || node.text === to) return;
    // The same span given the same text once: a block of one call emptied is that call removed. A longer span is another edit.
    const key = `${node.startIndex}:${node.endIndex}:${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    const start = lineStarts[row], end = last + 1 < lineStarts.length ? lineStarts[last + 1] - 1 : bytes.length;
    const original = bytes.subarray(start, end).toString('utf8');
    const mutated = Buffer.concat([bytes.subarray(start, node.startIndex), Buffer.from(to), bytes.subarray(node.endIndex, end)]).toString('utf8');
    found.push({ kind, line: row + 1, column: node.startPosition.column, from: node.text, to, original, mutated });
  };
  const truth = value => (normalized === 'python' ? (value ? 'True' : 'False') : value ? 'true' : 'false');
  // A body emptied: `{}` where braces delimit it, `pass` in Python, nothing where a keyword closes the block. A brace language's
  // one-statement body without braces is left alone, since what follows the `if` would become its body.
  const KEYWORD_BLOCKS = new Set(['python', 'ruby', 'lua', 'swift']);
  const emptyBlock = block => (block.text.startsWith('{') ? '{}' : normalized === 'python' ? 'pass' : KEYWORD_BLOCKS.has(normalized) ? '' : null);
  const walk = node => {
    if (node.startPosition.row + 1 <= end_line && node.endPosition.row + 1 >= line) {
      if (BINARY.has(node.type) || UPDATED.has(node.type) || (normalized === 'bash' && node.type === 'list')) {
        const operator = operatorOf(node);
        const text = operator?.text;
        if (text in COMPARISONS) add('boundary', operator, comparisonSwap(text, normalized));
        else if (text in TEST_COMPARISONS) add('boundary', operator, TEST_COMPARISONS[text]);
        else if (text in LOGIC) add('logic', operator, LOGIC[text]);
        else if (text in ARITHMETIC) add('arithmetic', operator, ARITHMETIC[text]);
        else if (text in UPDATES) add('update', operator, UPDATES[text]);
      }
      if (IFS.has(node.type) || LOOPS.has(node.type)) {
        const condition = node.childForFieldName('condition') ?? (PREFIXED.has(node.type) ? node.namedChildren[0] : null);
        // `if let` binds a pattern rather than testing a value; there is no condition to replace.
        if (condition && !/^let/.test(condition.type)) {
          const inner = WRAPPED.has(condition.type) ? condition.namedChildren[0] : condition;
          if (inner && !BOOLEANS.has(inner.type)) {
            // A loop forced true never ends; forced false it never runs, which a test of what it does should notice.
            if (IFS.has(node.type)) add('condition', inner, truth(true));
            add('condition', inner, truth(false));
          }
        }
        // `return 0 if x` has no body to empty: the statement is the body.
        const body = IFS.has(node.type) && normalized !== 'bash' && !node.type.endsWith('_modifier') ? consequenceOf(node) : null;
        const empty = body && body.namedChildren.some(child => !child.type.includes('comment')) ? emptyBlock(body) : null;
        if (empty !== null) add('block', body, empty);
      }
      if (NOT.has(node.type)) {
        const operator = node.childForFieldName('operator') ?? node.childForFieldName('operation') ?? node.children.find(child => !child.isNamed);
        const operand = node.childForFieldName('argument') ?? node.childForFieldName('operand') ?? node.childForFieldName('target') ?? node.namedChildren.find(child => child !== operator);
        if (operand && (operator?.text === '!' || operator?.text === 'not')) add('not', node, operand.text);
        else if (operand && operator?.text === '-') add('negative', node, operand.text);
      }
      // Solidity's boolean_literal holds a `true` node: one literal, read once.
      if (BOOLEANS.has(node.type) && !BOOLEANS.has(node.parent?.type)) add('boolean', node, node.text.toLowerCase() === 'true' ? (node.text[0] === 'T' ? 'False' : 'false') : (node.text[0] === 'F' ? 'True' : 'true'));
      if (isReturn(node)) {
        // Go returns an expression_list and Ruby and Lua an argument_list or expression_list; one value in it is the returned
        // value. Zig and Solidity wrap the value in expression nodes.
        const listed = node.namedChildren.length === 1 ? node.namedChildren[0] : null;
        const value = listed ? unwrapped(['expression_list', 'argument_list'].includes(listed.type) && listed.namedChildren.length === 1 ? listed.namedChildren[0] : listed) : null;
        if (value && NUMBERS.has(value.type)) add('return', value, /^0+(\.0+)?$/.test(value.text) ? '1' : '0');
        else if (value && STRINGS.has(value.type) && isValueString(value, normalized)) { const empty = emptied(value.text); if (empty) add('return', value, empty); }
        else if (value && value.type in EMPTIES) add('return', value, EMPTIES[value.type]);
        else if (value && !BOOLEANS.has(value.type) && NULLS[normalized] && node.type !== 'AssignExpr') add('return', value, NULLS[normalized]);
      }
      if (STRINGS.has(node.type) && !(isReturn(node.parent) || node.parent?.type === 'expression' && isReturn(node.parent.parent)) && isValueString(node, normalized)) {
        const empty = emptied(node.text);
        if (empty) add('string', node, empty);
      }
      if (NUMBERS.has(node.type) && /^\d+$/.test(node.text) && !isReturn(node.parent)) add('number', node, node.text === '0' ? '1' : node.text === '1' ? '0' : String(BigInt(node.text) + 1n));
      // A statement that only calls something: the call removed, which a test of what it did should notice. Python needs a
      // body to stay a body.
      const call = statementCall(node, normalized);
      if (call && !KEPT_CALLS.has(calleeName(call))) add('removal', node, normalized === 'python' ? 'pass' : '');
      // Bash's `return 0` is the command return with one number: success, or any other number for failure.
      if (normalized === 'bash' && node.type === 'command') {
        const { name, args } = bashCommand(node);
        if (name === 'return' && args.length === 1 && args[0].type === 'number') add('return', args[0], /^0+$/.test(args[0].text) ? '1' : '0');
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  const whole = bodyMutant(root, normalized, line, end_line);
  if (whole) add('body', whole.body, whole.to);
  return found.sort((a, b) => a.line - b.line || a.column - b.column || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}

/** Every kind of mutant, in the order two at the same place are listed. */
export const KINDS = ['body', 'boundary', 'logic', 'arithmetic', 'update', 'condition', 'block', 'removal', 'not', 'negative', 'boolean', 'return', 'string', 'number'];

/** A mutant's id within its method: where it is and what it does, stable across runs. */
export const mutantId = mutant => `${mutant.line}:${mutant.column}:${mutant.kind}:${createHash('sha1').update(`${mutant.from}>${mutant.to}`).digest('hex').slice(0, 8)}`;

const shown = text => { const flat = text.trim().replace(/\s+/g, ' '); return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat; };
/** How a mutant reads in a sentence: what changed, in the words of its kind. */
export function describeMutant(mutant) {
  if (mutant.kind === 'removal') return `the call \`${shown(mutant.from)}\` removed`;
  if (mutant.kind === 'block') return 'the branch\'s body emptied';
  if (mutant.kind === 'body') return /return|^\{ \S/.test(mutant.to) ? `the body replaced by \`${shown(mutant.to.replace(/^\{ | \}$/g, ''))}\`` : 'the body emptied';
  if (mutant.kind === 'condition') return `\`${mutant.to}\` as the condition`;
  return `\`${shown(mutant.to)}\` instead of \`${shown(mutant.from)}\``;
}
