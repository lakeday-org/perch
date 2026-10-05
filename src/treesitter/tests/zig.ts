/** What in a parsed Zig file is a test case, and what it mocks. Every answer is read off syntax nodes. */
import type { TestScan } from "../tests";
import type { SyntaxIndex } from "../visit";

export function zigTests(index: SyntaxIndex, scan: TestScan, path: string | null): void {
  void index; void scan; void path;
}
