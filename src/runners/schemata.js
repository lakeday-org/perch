/**
 * Mutant schemata for JavaScript and TypeScript, as Stryker builds them: every mutant of a file written into it at once, each
 * behind a switch read when the code runs, so the file is written, transformed and loaded once and a mutant is chosen by setting
 * a number. `__perch(17)` is true while mutant 17 is the one being run, and records that the test running now reached it.
 *
 * Each mutant is placed at the smallest whole expression that holds its edit, as a choice between the edited expression and the
 * original: `(__perch(17) ? (a <= b) : (a < b))`. A removed statement becomes an `if` around it, and an emptied block or body a
 * block choosing between the empty one and the original. Mutants inside a placed expression are placed inside its original, so
 * the original with every other mutant switched off is what runs when none is.
 *
 * Some edits have no runtime place: a constructor's body around its `super()` call, a value an enum's other members count on.
 * Those are returned unplaced with the reason, and are invalid: the edit cannot be run as it is.
 */
import pack from '@xberg-io/tree-sitter-language-pack';
import { Node } from '../treesitter/node.ts';
import { downloading, normalizeLanguage } from '../treesitter/languages.ts';

export const SCHEMATA_LANGUAGES = new Set(['javascript', 'typescript', 'tsx']);

/** Nodes that are whole expressions in the JavaScript and TypeScript grammars. */
const EXPRESSIONS = new Set(['identifier', 'this', 'number', 'string', 'template_string', 'regex', 'true', 'false', 'null', 'undefined', 'array', 'object',
  'function_expression', 'function', 'arrow_function', 'class', 'call_expression', 'new_expression', 'member_expression', 'subscript_expression',
  'binary_expression', 'unary_expression', 'update_expression', 'ternary_expression', 'parenthesized_expression', 'augmented_assignment_expression',
  'assignment_expression', 'await_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'type_assertion', 'jsx_element',
  'jsx_self_closing_element', 'sequence_expression', 'meta_property']);
/** Where a value cannot be swapped for a choice of two: it is assigned to, or bound, or the code is a type. */
const BINDINGS = new Set(['object_pattern', 'array_pattern', 'rest_pattern', 'pair_pattern', 'assignment_pattern', 'for_in_statement', 'enum_body', 'decorator']);
const CHAINED = new Set(['member_expression', 'call_expression', 'subscript_expression']);

const ofKind = kind => (kind === 'removal' ? 'statement' : kind === 'block' || kind === 'body' ? 'block' : 'expression');
const ORDER = { block: 0, statement: 1, expression: 2 };

/** Whether `node`'s chain of member accesses and calls, down through what it is called or read on, holds a `?.`. */
function optional(node) {
  for (let at = node; at && CHAINED.has(at.type); at = at.childForFieldName('object') ?? at.childForFieldName('function')) {
    if (at.children.some(child => child.type === 'optional_chain' || child.text === '?.')) return true;
  }
  return false;
}

/** The node the edit is placed at, by its kind, or the reason it has none. */
function anchorOf(node, style) {
  if (style === 'block') {
    if (node.type !== 'statement_block') return { reason: `a ${node.type} is no block` };
    const first = node.namedChildren[0];
    if (first?.type === 'expression_statement' && first.namedChildren[0]?.type === 'string') return { reason: 'the body starts with a directive' };
    if (node.namedChildren.some(child => child.type === 'expression_statement' && /^super\s*\(/.test(child.text))) return { reason: 'a constructor\'s body must call super() itself' };
    return { node };
  }
  if (style === 'statement') return node.type === 'expression_statement' ? { node } : { reason: `a ${node.type} is no statement` };
  for (let at = node; at; at = at.parent) {
    if (BINDINGS.has(at.type)) return { reason: `the edit is inside a ${at.type}` };
    if (at.type.endsWith('_statement') || at.type.endsWith('_declaration') || at.type === 'program' || at.type === 'statement_block') return { reason: 'no expression holds the edit' };
    if (!EXPRESSIONS.has(at.type)) continue;
    const parent = at.parent;
    // A method read off something is called with that something as `this`; a template is read by its tag. Both stay whole.
    if (parent?.type === 'call_expression' && (parent.childForFieldName('function')?.id === at.id && ['member_expression', 'subscript_expression'].includes(at.type)
      || (parent.childForFieldName('arguments')?.id === at.id && at.type === 'template_string'))) continue;
    // Assigned to, or counted up or down: the place itself cannot be a choice.
    if ((parent?.type === 'assignment_expression' || parent?.type === 'augmented_assignment_expression') && parent.childForFieldName('left')?.id === at.id) continue;
    if (parent?.type === 'update_expression') continue;
    // `a?.b.c` gives undefined for the whole chain when `a` is missing; `(a?.b).c` throws. A chain is placed whole.
    if (parent && CHAINED.has(parent.type) && (parent.childForFieldName('object')?.id === at.id || parent.childForFieldName('function')?.id === at.id) && optional(at)) continue;
    if (parent?.type === 'jsx_expression' || at.type === 'identifier' && parent?.type === 'shorthand_property_identifier') continue;
    return { node: at };
  }
  return { reason: 'no expression holds the edit' };
}

/**
 * The file with every mutant in `mutants`, `[{ id, mutant }]`, behind its switch: `{ text, unplaced: [{ id, reason }] }`. `prelude`
 * is the code that defines `__perch`, put after any `#!` line and directives.
 */
export function instrument({ source, language, mutants, prelude }) {
  const normalized = normalizeLanguage(language);
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
    const node = style === 'expression' ? found.at(-1) : found.find(item => (style === 'block' ? item.type === 'statement_block' : item.type === 'expression_statement')) ?? found[0];
    const placed = anchorOf(node, style);
    if (!placed.node) { unplaced.push({ id, reason: placed.reason }); continue; }
    const key = `${placed.node.startIndex}:${placed.node.endIndex}:${style}`;
    if (!anchors.has(key)) anchors.set(key, { start: placed.node.startIndex, end: placed.node.endIndex, style, node: placed.node, entries: [] });
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
  const text = (from, to) => bytes.subarray(from, to).toString('utf8');
  const inner = (from, to, children) => {
    let out = '', at = from;
    for (const child of children) { out += text(at, child.start) + render(child); at = child.end; }
    return out + text(at, to);
  };
  const render = anchor => {
    const original = inner(anchor.start, anchor.end, anchor.children);
    const mutated = entry => text(anchor.start, entry.start) + entry.to + text(entry.end, anchor.end);
    if (anchor.style === 'expression') {
      const choice = `(${anchor.entries.map(entry => `__perch(${entry.id}) ? (${mutated(entry)}) : `).join('')}(${original}))`;
      return anchor.node.parent?.type === 'jsx_attribute' ? `{${choice}}` : choice;
    }
    if (anchor.style === 'statement') return `{ ${anchor.entries.map(entry => `if (__perch(${entry.id})) { ${mutated(entry)} } else `).join('')}{ ${original} } }`;
    return `{ ${anchor.entries.map(entry => `if (__perch(${entry.id})) ${mutated(entry)} else `).join('')}${original} }`;
  };
  // The prelude goes after a `#!` line and the directives, which must come first to mean anything; TypeScript's pragma before
  // all of them, since the edits on either side of a choice need not have one type.
  const bang = source.startsWith('#!') ? (lineStarts[1] ?? bytes.length) : 0;
  let head = bang;
  for (const child of root.namedChildren) {
    if (child.startIndex < head) continue;
    if (child.type === 'expression_statement' && child.namedChildren.length === 1 && child.namedChildren[0].type === 'string') { head = child.endIndex; continue; }
    break;
  }
  const out = `${text(0, bang)}// @ts-nocheck\n${text(bang, head)}${head > bang ? '\n' : ''}${prelude}\n${inner(head, bytes.length, tree.children)}`;
  return { text: out, unplaced };
}

/**
 * The switch every instrumented file defines: one per process or test context, shared by every file in it through `globalThis`.
 * The active mutant comes from PERCH_MUTANT; with PERCH_COVERAGE set, every switch reached is recorded against the test running,
 * which the framework's hooks name in `__perch_state.test`.
 */
export const PRELUDE = `var __perch = globalThis.__perch_switch || (globalThis.__perch_switch = (function () {
  var env = (globalThis.process && globalThis.process.env) || {};
  var state = globalThis.__perch_state || (globalThis.__perch_state = { active: env.PERCH_MUTANT === undefined ? -1 : Number(env.PERCH_MUTANT), test: '', hits: env.PERCH_COVERAGE ? new Map() : null });
  return function (id) {
    if (state.hits) { var seen = state.hits.get(state.test); if (!seen) state.hits.set(state.test, seen = new Set()); seen.add(id); }
    return state.active === id;
  };
})());`;
