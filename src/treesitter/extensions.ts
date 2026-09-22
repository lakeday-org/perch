/** Language-specific facts absent from the pack's structure records, read from its native tree. */
import type { Node } from './node';

/** Groovy wraps both typed declarations and calls in command nodes; a declaration has a prefix before its block. */
function groovyPrefix(node: Node): string[] {
  if (node.type !== 'block' || !['command', 'end_command'].includes(node.parent?.type ?? '')) return [];
  let prefix: string[] = [];
  for (const child of node.parent!.namedChildren) {
    if (child.id === node.id) break;
    if (child.type === 'block') prefix = [];
    else if (child.type === 'unit') prefix.push(child.text);
  }
  return prefix;
}

export function callableName(node: Node): Node | null {
  if (node.type === 'Decl') return node.namedChildren.find(child => child.type === 'FnProto')?.childForFieldName('function') ?? null;
  if (node.type === 'lambda_literal') {
    let parent = node.parent;
    while (parent?.type === 'parenthesized_expression') parent = parent.parent;
    if (parent?.type === 'property_declaration')
      return parent.namedChildren.find(child => child.type === 'variable_declaration')?.namedChildren.find(child => child.type === 'simple_identifier') ?? null;
  }
  const prefix = groovyPrefix(node);
  if (!prefix.length || prefix.some(word => ['return', 'throw', 'new', 'if', 'else', 'for', 'while', 'switch', 'catch', 'synchronized', 'assert'].includes(word))) return null;
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
 */
export function hasSyntaxError(root: Node): boolean {
  if (!root.nativeHasError()) return false;
  const sexp = root.sexp;
  if (/\(ERROR\b/.test(sexp)) return true;
  // A quoted token is punctuation, `(MISSING ")")`; a bare one is a hidden rule, `(MISSING _automatic_semicolon)`.
  return [...sexp.matchAll(/\(MISSING (?:"([^"]+)"|([^\s()]+))\)/g)].some(match => !FILLED.has(match[1] ?? match[2]));
}
