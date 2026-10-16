/**
 * What in a parsed Zig file is a test case. Every answer is read off syntax nodes: a `TestDecl` is a test, its string or
 * identifier names it, and the containers it is declared in are its suite. Zig has one test framework, the language's own
 * `test "name" { }` blocks run by `zig test`, so every test here is framework `zig`.
 */
import type { Node } from "../node";
import type { TestScan } from "../tests";
import type { SyntaxIndex } from "../visit";
import { zigContainerName } from "../extensions";

/** Zig's single-letter escapes. `\xNN` and `\u{N}` are decoded by their code; any other escaped character stands for itself. */
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"' };

/** The value of a `STRINGLITERALSINGLE`: the text between its quotes, escapes decoded. */
function literal(node: Node): string {
  return node.text.slice(1, -1).replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|(.))/g, (_, hex, unicode, plain) => {
    if (hex ?? unicode) return String.fromCodePoint(parseInt(hex ?? unicode, 16));
    return ESCAPES[plain] ?? plain;
  });
}

/** The names of the containers a test is declared in, outermost first: `const Cart = struct { test "adds" { } }` is in `Cart`. */
function containers(node: Node): string[] {
  const names: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    const name = parent.type === "ContainerDecl" ? zigContainerName(parent) : null;
    if (name) names.unshift(name.text);
  }
  return names;
}

/**
 * A `TestDecl` is a test. `test "adds" { }` is named by its string, a decltest `test adds { }` by the declaration it names, and
 * `test { }` by its position among the file's unnamed tests, which is how the compiler names them. Each is qualified as the
 * compiler qualifies it, `test.adds`, `decltest.adds` and `test_0`, so a decltest and the declaration it names stay apart. The
 * grammar does not report a test block as a function, so each is pushed as a body and keyed by its own span.
 */
export function zigTests(index: SyntaxIndex, scan: TestScan): void {
  let unnamed = 0;
  for (const node of index.of("TestDecl")) {
    if (node.type !== "TestDecl") continue;
    const title = node.namedChildren.find(child => child.type === "STRINGLITERALSINGLE" || child.type === "IDENTIFIER");
    const name = !title ? `test_${unnamed++}` : title.type === "IDENTIFIER" ? title.text : literal(title);
    const qualified = !title ? name : `${title.type === "IDENTIFIER" ? "decltest" : "test"}.${name}`;
    const suite = containers(node);
    scan.bodies.push(node);
    scan.cases.set(`${node.startIndex}:${node.endIndex}`, { test: { name, suite, framework: "zig" }, qualified: [...suite, qualified].join(".") });
  }
}
