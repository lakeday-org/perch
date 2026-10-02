/** Language-specific facts absent from the pack's structure records, read from its native tree. */
import type { Node } from './node';
import type { SyntaxIndex } from './visit';

/**
 * Groovy wraps both typed declarations and calls in command nodes; a declaration has a prefix before its block. An operator in
 * the prefix is kept, since it makes the block a call: `def r = retry(3) { ... }` assigns what retry returns.
 */
function groovyPrefix(node: Node): string[] {
  if (node.type !== 'block' || !['command', 'end_command'].includes(node.parent?.type ?? '')) return [];
  let prefix: string[] = [];
  for (const child of node.parent!.namedChildren) {
    if (child.id === node.id) break;
    if (child.type === 'block') prefix = [];
    else if (child.type === 'unit' || child.type === 'operators') prefix.push(child.text);
  }
  return prefix;
}

/** The words that can stand before a Groovy method's name, besides a class type: its modifiers, then def, void or a primitive. */
const SIGNATURE_WORDS = new Set(['public', 'protected', 'private', 'static', 'final', 'abstract', 'native', 'strictfp',
  'def', 'var', 'void', 'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double']);

/**
 * Whether a prefix word can be part of a method's signature. A class type is capitalized, as `String`, `List<String>` or
 * `java.util.List`. Anything else is a call: `println qux(1) { it }` hands qux's result to println.
 */
const signatureWord = (word: string): boolean => SIGNATURE_WORDS.has(/^\w+/.exec(word)?.[0] ?? '') || /^([a-z_]\w*\.)*[A-Z]/.test(word);

export function callableName(node: Node): Node | null {
  if (node.type === 'Decl') return node.namedChildren.find(child => child.type === 'FnProto')?.childForFieldName('function') ?? null;
  if (node.type === 'lambda_literal') {
    let parent = node.parent;
    while (parent?.type === 'parenthesized_expression') parent = parent.parent;
    if (parent?.type === 'property_declaration')
      return parent.namedChildren.find(child => child.type === 'variable_declaration')?.namedChildren.find(child => child.type === 'simple_identifier') ?? null;
  }
  const prefix = groovyPrefix(node);
  if (!prefix.length || !prefix.every(signatureWord)) return null;
  const call = node.namedChildren[0]?.namedChildren.find(child => child.type === 'func');
  return call?.namedChildren.find(child => child.type === 'identifier') ?? null;
}

export function extraScopeName(node: Node): Node | null {
  if (groovyPrefix(node).some(word => ['class', 'interface', 'trait', 'enum'].includes(word)))
    return node.namedChildren[0]?.namedChildren.find(child => child.type === 'identifier') ?? null;
  // The Kotlin grammar represents a same-line object body as a lambda in an infix expression.
  if (node.type === 'lambda_literal' && node.parent?.type === 'infix_expression') {
    const siblings = node.parent.namedChildren;
    if (siblings[0]?.type === 'object_literal') return siblings.find(child => child.type === 'simple_identifier') ?? null;
  }
  return null;
}

/** Tokens the parser fills in that end a statement it had already read whole. Any other MISSING token is a broken construct. */
const FILLED = new Set([';', '_automatic_semicolon']);

/**
 * A parse error is an ERROR node, text the parser could not place, or a MISSING token other than a statement terminator. A
 * MISSING `;` is the parser completing a statement it read whole: the semicolon JavaScript leaves out before a line that starts
 * with `[`, a C++ macro invocation at file scope with none after it, Kotlin's optional member separator. Files like that were
 * dropped whole, every method in them unread, on a tree that had every method in it. A MISSING `)` is not that, and stays an
 * error. The S-expression is read because native child iteration omits hidden missing tokens.
 *
 * An ERROR is the same statement read whole when all it holds is a test framework's block macros, `GIVEN("x") { }`, written in
 * `blockMacros`: see blockMacroError.
 */
export function hasSyntaxError(root: Node, blockMacros: ReadonlySet<string> = new Set(), index: SyntaxIndex | null = null): boolean {
  if (!root.nativeHasError()) return false;
  const sexp = root.sexp;
  // The ERROR nodes inside the root, from the file's walk when there is one: they are the ones whose span the root's holds.
  const errors = index ? index.of('ERROR').filter(node => index.at(node) >= index.at(root) && index.at(node) < index.end(root))
    : [...root.walk()].filter(node => node.type === 'ERROR');
  if (/\(ERROR\b/.test(sexp) && errors.some(node => !blockMacroError(node, blockMacros))) return true;
  // A quoted token is punctuation, `(MISSING ")")`; a bare one is a hidden rule, `(MISSING _automatic_semicolon)`.
  return [...sexp.matchAll(/\(MISSING (?:"([^"]+)"|([^\s()]+))\)/g)].some(match => !FILLED.has(match[1] ?? match[2]));
}

/**
 * The C++ grammar has no rule for a function-like macro followed by a block, which is how Catch2 and doctest write a section and
 * GIVEN/WHEN/THEN. It reads `SECTION("x") { }` as a statement missing its `;` and then a block, and in some places recovers the
 * same text as `(ERROR (call_expression)) (compound_statement)`, or as one ERROR holding several such pairs whose last block
 * follows it. Such an ERROR holds nothing but calls of the framework's block macros, each followed by its block, and so is the
 * framework's syntax, read whole. An ERROR holding anything else, a token the parser could not place included, is an error.
 */
function blockMacroError(error: Node, blockMacros: ReadonlySet<string>): boolean {
  if (!blockMacros.size) return false;
  const parts = Array.from({ length: error.childCount }, (_, index) => error.child(index)!).filter(part => !part.type.includes('comment'));
  if (!parts.length) return false;
  const siblings = error.parent?.namedChildren.filter(part => !part.type.includes('comment')) ?? [];
  const at = siblings.findIndex(part => part.id === error.id);
  const after = at === -1 ? null : siblings[at + 1] ?? null;
  for (let index = 0; index < parts.length; index += 2) {
    const call = parts[index], block = parts[index + 1] ?? after;
    const macro = call.type === 'call_expression' ? call.childForFieldName('function') : null;
    if (macro?.type !== 'identifier' || !blockMacros.has(macro.text) || block?.type !== 'compound_statement') return false;
  }
  return true;
}

/**
 * A C or C++ function other translation units cannot call: `static` at namespace scope, or defined in an unnamed namespace. The
 * linker never resolves a call in another file to one of these, so neither does the graph. `static` on a function defined in a
 * class body declares a class function, which other files do call.
 */
export function internalLinkage(node: Node, language: string): boolean {
  if ((language !== 'c' && language !== 'cpp') || node.type !== 'function_definition') return false;
  const member = node.parent?.type === 'field_declaration_list';
  if (!member && node.namedChildren.some(child => child.type === 'storage_class_specifier' && child.text === 'static')) return true;
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.type === 'namespace_definition' && !parent.childForFieldName('name')) return true;
  return false;
}
