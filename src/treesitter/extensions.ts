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

/** Kotlin classMemberDeclarations permits optional separators: https://kotlinlang.org/spec/syntax-and-grammar.html */
export function hasSyntaxError(root: Node, language: string): boolean {
  if (!root.nativeHasError()) return false;
  if (language !== 'kotlin') return true;
  const original = root.sexp;
  let checked = original;
  for (const node of root.walk()) {
    if (node.type !== 'class_body' || !node.nativeHasError() || node.namedChildren.some(child => child.nativeHasError())) continue;
    // This grammar inserts a hidden missing separator after an otherwise valid member.
    // Native child iteration omits that hidden token; its S-expression preserves it.
    const body = node.sexp;
    const optional = body.replaceAll('(MISSING _automatic_semicolon)', '');
    if (optional !== body && !/\((?:ERROR|MISSING)\b/.test(optional)) checked = checked.replace(body, optional);
  }
  return checked === original || /\((?:ERROR|MISSING)\b/.test(checked);
}
