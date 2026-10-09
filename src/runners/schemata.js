/**
 * Mutant schemata, as Stryker builds them: every mutant of a file written into it at once, each behind a switch read when the
 * code runs, so the file is written, compiled or transformed, and loaded once, and a mutant is chosen by setting a number.
 * `__perch(17)` is true while mutant 17 is the one being run, and records that the test running now reached it.
 *
 * Each mutant is placed at the smallest whole expression that holds its edit, as a choice between the edited expression and the
 * original: `(__perch(17) ? (a <= b) : (a < b))` in JavaScript and C#, `(if on(17) { a <= b } else { a < b })` in Rust. A
 * removed statement becomes an `if` around it, and an emptied block or body a block choosing between the empty one and the
 * original. Mutants inside a placed expression are placed inside its original, so the original with every other mutant
 * switched off is what runs when none is.
 *
 * Some edits have no runtime place: a pattern a `match` compares against, a constructor's body around its `super()` call. Those
 * are returned unplaced with the reason, and are invalid. A compiled language may also reject a placed edit, a value a constant
 * needs at compile time; `locate` names the mutants the compiler's error lines fall in, so they can be taken out and the code
 * built again, as Stryker.NET does.
 */
import pack from '@xberg-io/tree-sitter-language-pack';
import { Node } from '../treesitter/node.ts';
import { downloading, normalizeLanguage } from '../treesitter/languages.ts';

const JS_EXPRESSIONS = ['identifier', 'this', 'number', 'string', 'template_string', 'regex', 'true', 'false', 'null', 'undefined', 'array', 'object',
  'function_expression', 'function', 'arrow_function', 'class', 'call_expression', 'new_expression', 'member_expression', 'subscript_expression',
  'binary_expression', 'unary_expression', 'update_expression', 'ternary_expression', 'parenthesized_expression', 'augmented_assignment_expression',
  'assignment_expression', 'await_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'type_assertion', 'jsx_element',
  'jsx_self_closing_element', 'sequence_expression', 'meta_property'];
const CHAINED = new Set(['member_expression', 'call_expression', 'subscript_expression']);

/** Whether `node`'s chain of member accesses and calls, down through what it is called or read on, holds a `?.`. */
function optional(node) {
  for (let at = node; at && CHAINED.has(at.type); at = at.childForFieldName('object') ?? at.childForFieldName('function')) {
    if (at.children.some(child => child.type === 'optional_chain' || child.text === '?.')) return true;
  }
  return false;
}

/**
 * Each language's way of writing a choice. `expressions` are the nodes a choice can replace; `keep` says why an expression must
 * stay whole and the choice go further out, or nothing; `refuse` says why an edit cannot be placed at all.
 */
const DIALECTS = {
  javascript: {
    // Nothing compiles JavaScript ahead of a run, so nothing needs tracing back: and a comment is not allowed where a JSX
    // attribute's value goes.
    markers: false,
    expressions: new Set(JS_EXPRESSIONS), statement: 'expression_statement', block: 'statement_block',
    on: id => `__perch(${id})`,
    choice: (entries, original, node) => {
      const text = `(${entries.map(entry => `__perch(${entry.id}) ? (${entry.text}) : `).join('')}(${original}))`;
      return node.parent?.type === 'jsx_attribute' ? `{${text}}` : text;
    },
    statementChoice: (entries, original) => `{ ${entries.map(entry => `if (__perch(${entry.id})) { ${entry.text} } else `).join('')}{ ${original} } }`,
    blockChoice: (entries, original) => `{ ${entries.map(entry => `if (__perch(${entry.id})) ${entry.text} else `).join('')}${original} }`,
    refuse: at => (['object_pattern', 'array_pattern', 'rest_pattern', 'pair_pattern', 'assignment_pattern', 'for_in_statement', 'enum_body', 'decorator'].includes(at.type) ? `the edit is inside a ${at.type}` : null),
    keep: (at, parent) => {
      // A method read off something is called with that something as `this`; a template is read by its tag. Both stay whole.
      if (parent?.type === 'call_expression' && (parent.childForFieldName('function')?.id === at.id && ['member_expression', 'subscript_expression'].includes(at.type)
        || (parent.childForFieldName('arguments')?.id === at.id && at.type === 'template_string'))) return true;
      // Assigned to, or counted up or down: the place itself cannot be a choice.
      if ((parent?.type === 'assignment_expression' || parent?.type === 'augmented_assignment_expression') && parent.childForFieldName('left')?.id === at.id) return true;
      if (parent?.type === 'update_expression') return true;
      // `a?.b.c` gives undefined for the whole chain when `a` is missing; `(a?.b).c` throws. A chain is placed whole.
      if (parent && CHAINED.has(parent.type) && (parent.childForFieldName('object')?.id === at.id || parent.childForFieldName('function')?.id === at.id) && optional(at)) return true;
      return parent?.type === 'jsx_expression' || (at.type === 'identifier' && parent?.type === 'shorthand_property_identifier');
    },
    refuseBlock: node => {
      const first = node.namedChildren[0];
      if (first?.type === 'expression_statement' && first.namedChildren[0]?.type === 'string') return 'the body starts with a directive';
      if (node.namedChildren.some(child => child.type === 'expression_statement' && /^super\s*\(/.test(child.text))) return 'a constructor\'s body must call super() itself';
      return null;
    },
  },
  rust: {
    markers: true,
    expressions: new Set(['binary_expression', 'unary_expression', 'call_expression', 'field_expression', 'index_expression', 'integer_literal', 'float_literal',
      'string_literal', 'raw_string_literal', 'boolean_literal', 'char_literal', 'macro_invocation', 'reference_expression', 'try_expression', 'await_expression',
      'closure_expression', 'parenthesized_expression', 'array_expression', 'tuple_expression', 'struct_expression', 'identifier', 'range_expression',
      'compound_assignment_expr', 'assignment_expression', 'type_cast_expression', 'if_expression', 'match_expression', 'block', 'unit_expression',
      'scoped_identifier', 'generic_function']),
    statement: 'expression_statement', block: 'block',
    on: id => `crate::__perch::on(${id})`,
    choice: (entries, original) => `(${entries.map(entry => `if crate::__perch::on(${entry.id}) { ${entry.text} } else `).join('')}{ ${original} })`,
    statementChoice: (entries, original) => `${entries.map(entry => `if crate::__perch::on(${entry.id}) { ${entry.text} } else `).join('')}{ ${original} }`,
    blockChoice: (entries, original) => `{ ${entries.map(entry => `if crate::__perch::on(${entry.id}) ${entry.text} else `).join('')}${original} }`,
    refuse: at => (/pattern/.test(at.type) || ['const_item', 'static_item', 'attribute_item', 'inner_attribute_item', 'enum_variant'].includes(at.type) ? `the edit is inside a ${at.type}` : null),
    keep: (at, parent) => {
      if ((parent?.type === 'assignment_expression' || parent?.type === 'compound_assignment_expr') && parent.childForFieldName('left')?.id === at.id) return true;
      // A method called on a value is called on that value, not on a copy the choice made: `a.len()` stays whole.
      if (parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === at.id) return true;
      if (parent?.type === 'reference_expression' || (parent?.type === 'field_expression' && parent.childForFieldName('value')?.id === at.id)) return true;
      // A block that is a function's or a branch's body is the body, not a value inside it.
      return at.type === 'block' && parent && !['parenthesized_expression', 'arguments', 'let_declaration'].includes(parent.type);
    },
    refuseBlock: () => null,
  },
  csharp: {
    markers: true,
    // C# takes an assignment as a statement but not a choice between two: one that is a whole statement is chosen as one.
    statementsOnly: true,
    expressions: new Set(['binary_expression', 'prefix_unary_expression', 'postfix_unary_expression', 'invocation_expression', 'member_access_expression',
      'element_access_expression', 'integer_literal', 'real_literal', 'string_literal', 'verbatim_string_literal', 'raw_string_literal', 'boolean_literal',
      'character_literal', 'null_literal', 'conditional_expression', 'parenthesized_expression', 'object_creation_expression', 'array_creation_expression',
      'implicit_array_creation_expression', 'initializer_expression', 'lambda_expression', 'identifier', 'cast_expression', 'await_expression',
      'conditional_access_expression', 'assignment_expression', 'interpolated_string_expression', 'collection_expression']),
    statement: 'expression_statement', block: 'block',
    on: id => `global::PerchSwitch.On(${id})`,
    choice: (entries, original) => `(${entries.map(entry => `global::PerchSwitch.On(${entry.id}) ? (${entry.text}) : `).join('')}(${original}))`,
    statementChoice: (entries, original) => `{ ${entries.map(entry => `if (global::PerchSwitch.On(${entry.id})) { ${entry.text} } else `).join('')}{ ${original} } }`,
    blockChoice: (entries, original) => `{ ${entries.map(entry => `if (global::PerchSwitch.On(${entry.id})) ${entry.text} else `).join('')}${original} }`,
    // A pattern, an attribute, a case label, an enum member, a default value and a constant all need a value at compile time.
    refuse: at => (/pattern/.test(at.type) || ['attribute', 'attribute_list', 'case_switch_label', 'switch_label', 'enum_member_declaration', 'parameter'].includes(at.type)
      || (['field_declaration', 'local_declaration_statement'].includes(at.type) && /\bconst\b/.test(at.text)) ? `the edit is inside a ${at.type}` : null),
    keep: (at, parent) => {
      if (parent?.type === 'assignment_expression' && parent.childForFieldName('left')?.id === at.id) return true;
      if (parent?.type === 'postfix_unary_expression' || (parent?.type === 'prefix_unary_expression' && /^(\+\+|--)/.test(parent.text))) return true;
      if (parent?.type === 'invocation_expression' && parent.childForFieldName('function')?.id === at.id) return true;
      // A name read off something, `a.Trim`, is part of reading it.
      if (['member_access_expression', 'member_binding_expression', 'qualified_name'].includes(parent?.type) && parent.childForFieldName('name')?.id === at.id) return true;
      // A `ref` or `out` argument is a place, not a value.
      return parent?.type === 'argument' && /^(ref|out|in)\s/.test(parent.text);
    },
    refuseBlock: () => null,
  },
};
for (const language of ['typescript', 'tsx']) DIALECTS[language] = DIALECTS.javascript;

export const SCHEMATA_LANGUAGES = new Set(['javascript', 'typescript', 'tsx']);

const ofKind = kind => (kind === 'removal' ? 'statement' : kind === 'block' || kind === 'body' ? 'block' : 'expression');
const ORDER = { block: 0, statement: 1, expression: 2 };

/** The node the edit is placed at, by its kind, or the reason it has none. */
function anchorOf(node, style, dialect) {
  if (style === 'block') {
    if (node.type !== dialect.block) return { reason: `a ${node.type} is no block` };
    const reason = dialect.refuseBlock(node);
    return reason ? { reason } : { node };
  }
  if (style === 'statement') return node.type === dialect.statement ? { node } : { reason: `a ${node.type} is no statement` };
  for (let at = node; at; at = at.parent) {
    const refused = dialect.refuse(at);
    if (refused) return { reason: refused };
    if (/(_statement|_declaration|_item|^program|^source_file|^compilation_unit|^statement_block)$/.test(at.type) && at.type !== dialect.statement) return { reason: 'no expression holds the edit' };
    if (!dialect.expressions.has(at.type) || dialect.keep(at, at.parent)) continue;
    if (dialect.statementsOnly && at.parent?.type === dialect.statement) return { node: at.parent, style: 'statement' };
    return { node: at };
  }
  return { reason: 'no expression holds the edit' };
}

/**
 * The file with every mutant in `mutants`, `[{ id, mutant }]`, behind its switch: `{ text, unplaced: [{ id, reason }], locate }`.
 * `head` is what goes at the top, after any `#!` line, and `prelude` after the directives: JavaScript's switch, which each file
 * defines. `locate(line)` is the mutants an error on that line of the text can be put down to: the edits whose own text is on it,
 * else every edit placed around it.
 */
export function instrument({ source, language, mutants, prelude = '', head: top = '' }) {
  const normalized = normalizeLanguage(language);
  const dialect = DIALECTS[normalized];
  const bytes = Buffer.from(source);
  const root = new Node(downloading(() => pack.getParser(normalized)).parse(source).rootNode(), bytes);
  const lineStarts = [0];
  for (let at = 0; at < bytes.length; at++) if (bytes[at] === 10) lineStarts.push(at + 1);
  const spans = new Map();
  const index = node => { const key = `${node.startIndex}:${node.endIndex}`; if (!spans.has(key)) spans.set(key, []); spans.get(key).push(node); for (const child of node.children) index(child); };
  index(root);
  const anchors = new Map(), unplaced = [];
  for (const { id, mutant } of mutants) {
    const start = lineStarts[mutant.line - 1] + mutant.column, end = start + Buffer.byteLength(mutant.from);
    const found = spans.get(`${start}:${end}`);
    if (!found || bytes.subarray(start, end).toString('utf8') !== mutant.from) { unplaced.push({ id, reason: 'the edit is not where the source says' }); continue; }
    const style = ofKind(mutant.kind);
    // The outermost node of the span for a statement or block; the innermost for an expression, which is then climbed from.
    const node = style === 'expression' ? found.at(-1) : found.find(item => item.type === (style === 'block' ? dialect.block : dialect.statement)) ?? found[0];
    const placed = anchorOf(node, style, dialect);
    if (!placed.node) { unplaced.push({ id, reason: placed.reason }); continue; }
    const as = placed.style ?? style;
    const key = `${placed.node.startIndex}:${placed.node.endIndex}:${as}`;
    if (!anchors.has(key)) anchors.set(key, { start: placed.node.startIndex, end: placed.node.endIndex, style: as, node: placed.node, entries: [] });
    anchors.get(key).entries.push({ id, start, end, to: mutant.to });
  }
  // Outermost first: a wider span before a narrower one, and at one span a block around a statement around an expression.
  const sorted = [...anchors.values()].sort((a, b) => a.start - b.start || b.end - a.end || ORDER[a.style] - ORDER[b.style]);
  const tree = { start: 0, end: bytes.length, children: [] }, stack = [tree];
  for (const anchor of sorted) {
    anchor.children = [];
    while (stack.length > 1 && !(anchor.start >= stack.at(-1).start && anchor.end <= stack.at(-1).end)) stack.pop();
    stack.at(-1).children.push(anchor);
    stack.push(anchor);
  }
  // Each edit's text and each choice is fenced by a marker comment, so a compiler's error line can be traced to what is on it.
  const text = (from, to) => bytes.subarray(from, to).toString('utf8');
  const inner = (from, to, children) => {
    let out = '', at = from;
    for (const child of children) { out += text(at, child.start) + render(child); at = child.end; }
    return out + text(at, to);
  };
  const render = anchor => {
    const original = inner(anchor.start, anchor.end, anchor.children);
    const fence = (open, body, close) => (dialect.markers ? `/*${open}*/${body}/*${close}*/` : body);
    const entries = anchor.entries.map(entry => ({ id: entry.id, text: fence(`<${entry.id}`, `${text(anchor.start, entry.start)}${entry.to}${text(entry.end, anchor.end)}`, `${entry.id}>`) }));
    const ids = anchor.entries.map(entry => entry.id).join(',');
    const choice = anchor.style === 'expression' ? dialect.choice(entries, original, anchor.node)
      : anchor.style === 'statement' ? dialect.statementChoice(entries, original) : dialect.blockChoice(entries, original);
    return fence(`[${ids}`, choice, `${ids}]`);
  };
  // The prelude goes after a `#!` line and the directives, which must come first to mean anything.
  const bang = source.startsWith('#!') ? (lineStarts[1] ?? bytes.length) : 0;
  let head = bang;
  for (const child of root.namedChildren) {
    if (child.startIndex < head) continue;
    if (child.type === 'expression_statement' && child.namedChildren.length === 1 && child.namedChildren[0].type === 'string') { head = child.endIndex; continue; }
    break;
  }
  const out = `${text(0, bang)}${top}${text(bang, head)}${head > bang ? '\n' : ''}${prelude}${prelude ? '\n' : ''}${inner(head, bytes.length, tree.children)}`;
  return { text: out, unplaced, locate: (line, column) => locate(out, line, column) };
}

/**
 * The mutants an error at `line` and `column` of an instrumented file falls in: the edit around that place, innermost first, else
 * the choice around it. Without a column, anything on the line.
 */
function locate(text, line, column) {
  const starts = [0];
  for (let at = 0; at < text.length; at++) if (text[at] === '\n') starts.push(at + 1);
  const lineStart = starts[line - 1] ?? text.length;
  const from = column ? lineStart + column - 1 : lineStart, to = column ? from + 1 : starts[line] ?? text.length;
  const covering = (open, close) => {
    const found = [];
    for (const match of text.matchAll(open)) {
      const end = text.indexOf(close(match[1]), match.index);
      if (end >= 0 && match.index < to && end + close(match[1]).length > from) found.push({ ids: match[1].split(',').map(Number), size: end - match.index });
    }
    return found.sort((a, b) => a.size - b.size);
  };
  const edits = covering(/\/\*<(\d+)\*\//g, id => `/*${id}>*/`);
  if (edits.length) return edits[0].ids;
  const choices = covering(/\/\*\[([\d,]+)\*\//g, ids => `/*${ids}]*/`);
  return choices.length ? choices[0].ids : [];
}

/**
 * The switch every instrumented JavaScript file defines: one per process or test context, shared by every file in it through
 * `globalThis`. The active mutant comes from PERCH_MUTANT; with PERCH_COVERAGE set, every switch reached is recorded against the
 * test running, which the framework's hooks name in `__perch_state.test`.
 */
export const PRELUDE = `var __perch = globalThis.__perch_switch || (globalThis.__perch_switch = (function () {
  var env = (globalThis.process && globalThis.process.env) || {};
  var state = globalThis.__perch_state || (globalThis.__perch_state = { active: env.PERCH_MUTANT === undefined ? -1 : Number(env.PERCH_MUTANT), test: '', hits: env.PERCH_COVERAGE ? new Map() : null });
  return function (id) {
    if (state.hits) { var seen = state.hits.get(state.test); if (!seen) state.hits.set(state.test, seen = new Set()); seen.add(id); }
    return state.active === id;
  };
})());`;

/** TypeScript's pragma, before everything: the edits on either side of a choice need not have one type. */
export const TS_HEAD = '// @ts-nocheck\n';
