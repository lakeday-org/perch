/**
 * What in a parsed Bash file is a test case: nothing the grammar can show. bats writes a test as `@test "name" { ... }`, which
 * the Bash grammar reads as a command named `@test` with the string and the `{` as its arguments, the body's statements as
 * siblings of that command, and the closing `}` as another command. No node spans the test, so there is nothing to declare as
 * one: a case keyed by the `@test` command alone would own none of the calls its body makes, and a test that reaches nothing is
 * a worse answer than no test. A bats file is still read as Bash: its functions, the files it sources and the commands they run.
 */
import type { TestScan } from "../tests";
import type { SyntaxIndex } from "../visit";

export function bashTests(index: SyntaxIndex, scan: TestScan, path: string | null): void {
  void index; void scan; void path;
}
