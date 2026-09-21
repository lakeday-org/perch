import type { Node as PackNode, Point } from '@xberg-io/tree-sitter-language-pack';

/**
 * Perch's source view adds UTF-8 text to native nodes; parsing belongs entirely to the language pack.
 *
 * Every getter is a call into native code, and the metrics walk reads `type`, the byte range and the positions of each node
 * several times over. Read once and kept: on a 220k-statement function, `type` alone was a third of the analysis time.
 */
export class Node {
  #type?: string;
  #startIndex?: number;
  #endIndex?: number;
  #startPosition?: Point;
  #endPosition?: Point;
  #childCount?: number;
  constructor(private readonly native: PackNode, private readonly source: Buffer) {}
  get type() { return (this.#type ??= this.native.kind()); }
  get startIndex() { return (this.#startIndex ??= this.native.startByte()); }
  get endIndex() { return (this.#endIndex ??= this.native.endByte()); }
  get id() { return `${this.type}:${this.startIndex}:${this.endIndex}`; }
  get startPosition() { return (this.#startPosition ??= this.native.startPosition()); }
  get endPosition() { return (this.#endPosition ??= this.native.endPosition()); }
  get isNamed() { return this.native.isNamed(); }
  nativeHasError() { return this.native.hasError(); }
  get sexp() { return this.native.toSexp(); }
  get isError() { return this.native.isError(); }
  get isMissing() { return this.native.isMissing(); }
  get childCount() { return (this.#childCount ??= this.native.childCount()); }
  get text() { return this.source.subarray(this.startIndex, this.endIndex).toString('utf8'); }
  get parent(): Node | null { return this.wrap(this.native.parent()); }
  get namedChildren(): Node[] {
    return Array.from({ length: this.native.namedChildCount() }, (_, index) => this.wrap(this.native.namedChild(index))!);
  }
  child(index: number): Node | null { return this.wrap(this.native.child(index)); }
  childForFieldName(name: string): Node | null { return this.wrap(this.native.childByFieldName(name)); }
  *walk(): Generator<Node> {
    const cursor = this.native.walk();
    while (true) {
      yield new Node(cursor.node(), this.source);
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) if (!cursor.gotoParent()) return;
    }
  }
  private wrap(node: PackNode | null): Node | null { return node ? new Node(node, this.source) : null; }
}
