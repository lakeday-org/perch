import type { Node as PackNode, Point } from '@xberg-io/tree-sitter-language-pack';

/** Where each line of a source starts, by byte: tree-sitter's row and column are a byte offset counted against newlines. */
const lineStarts = new WeakMap<Buffer, number[]>();
function pointAt(source: Buffer, byte: number): Point {
  let starts = lineStarts.get(source);
  if (!starts) {
    starts = [0];
    for (let at = source.indexOf(10); at !== -1; at = source.indexOf(10, at + 1)) starts.push(at + 1);
    lineStarts.set(source, starts);
  }
  let low = 0, high = starts.length - 1;
  while (low < high) { const middle = (low + high + 1) >> 1; if (starts[middle] <= byte) low = middle; else high = middle - 1; }
  return { row: low, column: byte - starts[low] };
}

/**
 * Perch's source view adds UTF-8 text to native nodes; parsing belongs entirely to the language pack.
 *
 * A call into native code costs more than the work it does, and analysis reads `type`, the byte range and the positions of every
 * node. Each is read once and kept, positions are counted from the source instead of asked for, and a child's field comes from
 * the cursor pass that found it: on a 220k-statement function, `type` alone was a third of the analysis time.
 */
export class Node {
  #type?: string;
  #startIndex?: number;
  #endIndex?: number;
  #startPosition?: Point;
  #endPosition?: Point;
  #isNamed?: boolean;
  #isMissing?: boolean;
  /** The field its parent holds it in, `name` or `body`, read in the cursor pass that built the parent's children. */
  #field: string | null = null;
  /**
   * The children, wrapped once and kept, so what one stage read of a node another does not ask native code for again.
   * `#complete` says the whole subtree below is built, by one cursor pass: native `child(i)` counts siblings from the first, so
   * reading a block's children one by one was quadratic in them.
   */
  #children?: Node[];
  #complete = false;
  /**
   * The node this one was reached from, or undefined when it was not reached from one. Native `parent()` searches down from the
   * root, so it costs the node's depth, and the walks that climb from a node to the function around it paid that at every step:
   * a 34 KB file of nested functions took two minutes to parse. A node reached from its parent keeps it instead.
   */
  #parent?: Node | null;
  constructor(private readonly native: PackNode, private readonly source: Buffer, parent?: Node | null) { this.#parent = parent; }
  get type() { return (this.#type ??= this.native.kind()); }
  get startIndex() { if (this.#startIndex === undefined) this.#range(); return this.#startIndex!; }
  get endIndex() { if (this.#endIndex === undefined) this.#range(); return this.#endIndex!; }
  /** Both ends of the byte range in one call into native code. */
  #range(): void { const range = this.native.byteRange(); this.#startIndex = range.start; this.#endIndex = range.end; }
  get id() { return `${this.type}:${this.startIndex}:${this.endIndex}`; }
  get startPosition() { return (this.#startPosition ??= pointAt(this.source, this.startIndex)); }
  get endPosition() { return (this.#endPosition ??= pointAt(this.source, this.endIndex)); }
  get isNamed() { return (this.#isNamed ??= this.native.isNamed()); }
  nativeHasError() { return this.native.hasError(); }
  get sexp() { return this.native.toSexp(); }
  get isError() { return this.native.isError(); }
  get isMissing() { return (this.#isMissing ??= this.native.isMissing()); }
  /** As many as the cursor that built the children found: the same count, without asking native code. */
  get childCount() { return this.children.length; }
  get text() { return this.source.subarray(this.startIndex, this.endIndex).toString('utf8'); }
  get parent(): Node | null {
    if (this.#parent === undefined) { const native = this.native.parent(); this.#parent = native ? new Node(native, this.source) : null; }
    return this.#parent;
  }
  get children(): Node[] {
    this.#build();
    return this.#children!;
  }
  get namedChildren(): Node[] { return this.children.filter(child => child.isNamed); }
  child(index: number): Node | null { return this.children[index] ?? null; }
  /** The first child in that field. The cursor that built the children said which field each is in, so this asks native code nothing. */
  childForFieldName(name: string): Node | null {
    return this.children.find(child => child.#field === name) ?? null;
  }
  /** Every node from this one down, in source order, each with its parent. */
  *walk(): Generator<Node> {
    const stack: Node[] = [this];
    while (stack.length) {
      const node = stack.pop()!;
      yield node;
      const children = node.children;
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
    }
  }
  /** One cursor pass over the subtree, giving every node in it its children. */
  #build(): void {
    if (this.#complete) return;
    this.#children = [];
    const cursor = this.native.walk();
    if (!cursor.gotoFirstChild()) { this.#complete = true; return; }
    const path: Node[] = [this];
    while (true) {
      const node = new Node(cursor.node(), this.source, path.at(-1)!);
      node.#field = cursor.fieldName();
      node.#children = [];
      path.at(-1)!.#children!.push(node);
      if (cursor.gotoFirstChild()) { path.push(node); continue; }
      node.#complete = true;
      while (!cursor.gotoNextSibling()) {
        cursor.gotoParent();
        const finished = path.pop()!;
        finished.#complete = true;
        if (finished === this) return;
      }
    }
  }
}
