import type { Node } from './node';

/** A stage of analysis that reads nodes as the one walk of a file reaches them, on the way down and on the way back up. */
export interface Visitor {
  enter?(node: Node): void;
  exit?(node: Node): void;
}

/**
 * Every node of a file in the order the walk reached them, filed by type, with the span of the list each node's subtree takes.
 * A stage that needs the whole tree before it can decide anything, or the nodes inside one node, reads them here: a subtree is
 * a slice of the list, so nothing walks the tree a second time.
 */
export class SyntaxIndex {
  readonly all: Node[] = [];
  readonly #byType = new Map<string, Node[]>();
  readonly #at = new Map<Node, number>();
  readonly #end = new Map<Node, number>();
  #bySpan: Map<string, Node[]> | null = null;

  /** Where a node is in `all`, and where its subtree ends: the subtree is `all[at, end)`. */
  at(node: Node): number { return this.#at.get(node) ?? -1; }
  end(node: Node): number { return this.#end.get(node) ?? -1; }

  /** The nodes of these types, in walk order. */
  of(...types: string[]): Node[] {
    if (types.length === 1) return this.#byType.get(types[0]) ?? [];
    return types.flatMap(type => this.#byType.get(type) ?? []).sort((a, b) => this.at(a) - this.at(b));
  }

  /** A node and everything below it, in walk order. A node from outside the walk is walked on its own. */
  within(node: Node): Node[] {
    const start = this.at(node);
    return start === -1 ? [...node.walk()] : this.all.slice(start, this.end(node));
  }

  /** The nodes with exactly this byte span, `start:end` as a test case's key writes it, outermost first. */
  spanned(span: string): Node[] {
    if (!this.#bySpan) {
      this.#bySpan = new Map();
      for (const node of this.all) {
        const key = `${node.startIndex}:${node.endIndex}`, same = this.#bySpan.get(key);
        if (same) same.push(node);
        else this.#bySpan.set(key, [node]);
      }
    }
    return this.#bySpan.get(span) ?? [];
  }

  add(node: Node): void {
    this.#at.set(node, this.all.length);
    this.all.push(node);
    const list = this.#byType.get(node.type);
    if (list) list.push(node);
    else this.#byType.set(node.type, [node]);
  }

  close(node: Node): void { this.#end.set(node, this.all.length); }
}

/**
 * The one walk of a file. Each node is filed in the index and handed to every visitor in order, and on the way back up, after
 * everything below it, handed to each visitor's exit. Children are taken from the start, so the order is source order.
 */
export function walk(root: Node, visitors: Visitor[] = []): SyntaxIndex {
  const index = new SyntaxIndex();
  const enters = visitors.filter(visitor => visitor.enter), exits = visitors.filter(visitor => visitor.exit);
  // A frame is a node and how many of its children have been entered. Iterative, since a 200,000-statement block nests deeper
  // than the call stack allows.
  const nodes: Node[] = [root], next: number[] = [0];
  index.add(root);
  for (const visitor of enters) visitor.enter!(root);
  while (nodes.length) {
    const top = nodes.length - 1, node = nodes[top], children = node.children;
    if (next[top] < children.length) {
      const child = children[next[top]++];
      index.add(child);
      for (const visitor of enters) visitor.enter!(child);
      nodes.push(child);
      next.push(0);
      continue;
    }
    index.close(node);
    for (const visitor of exits) visitor.exit!(node);
    nodes.pop();
    next.pop();
  }
  return index;
}
