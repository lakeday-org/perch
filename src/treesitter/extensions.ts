/** Language-specific facts the pack's structural extraction does not yet expose. All nodes come from its native tree. */
import type { StructureItem } from '@xberg-io/tree-sitter-language-pack';
import type { Node } from './node';

export function callableName(node: Node): Node | null {
  if (node.type === 'Decl') return node.namedChildren.find(child => child.type === 'FnProto')?.childForFieldName('function') ?? null;
  if (node.type === 'command' && node.namedChildren[0]?.text === 'def') {
    const block = node.namedChildren.find(child => child.type === 'block');
    const call = block?.namedChildren[0]?.namedChildren.find(child => child.type === 'func');
    return call?.namedChildren[0] ?? null;
  }
  return null;
}

/** These two grammars have no built-in Function/Method records in language-pack 1.20. */
export function extraDeclaration(node: Node, language: string): StructureItem | null {
  if (!['groovy', 'zig'].includes(language)) return null;
  const name = callableName(node);
  if (!name) return null;
  const start = node.startPosition, end = node.endPosition;
  return { kind: { type: 'Function' }, name: name.text,
    span: { startByte: node.startIndex, endByte: node.endIndex, startLine: start.row, endLine: end.row, startColumn: start.column, endColumn: end.column }, children: [] };
}
