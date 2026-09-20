import { describe, expect, it } from "vitest";
import {
  SUPPORTED_LANGUAGES,
  createAnalyzer,
  languageForPath,
} from "../src/treesitter/index";

function realAnalyzer() { return createAnalyzer(); }

describe("language registry", () => {
  it("registers the language pack and detects source languages", () => {
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThan(30);
    expect(languageForPath("src/index.ts")).toBe("typescript");
    expect(languageForPath("src/view.tsx")).toBe("tsx");
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
  });
});

describe("Tree-sitter analysis", () => {
  it("parses JavaScript and returns Halstead, control-flow, locations, imports, and calls", async () => {
    const analyzer = realAnalyzer();
    const result = await analyzer.analyzeSource(
      `import { helper as h } from "./helper.js";\n\n// keep this branch explicit\nfunction score(value) {\n  if (value > 0 && h(value)) return 1;\n  return 0;\n}\n`,
      "javascript",
    );

    expect(result.parser_status).toBe("parsed");
    expect(result.metrics?.volume).toBeGreaterThan(0);
    expect(result.metrics?.maintainability_index).not.toBeNull();
    expect(result.metrics?.cyclomatic_complexity).toBe(3);
    expect(result.metrics?.comment_lines).toBe(1);
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]).toMatchObject({
      name: "score",
      kind: "function",
      line: 4,
      end_line: 7,
    });
    expect(result.declarations[0]?.location.start.byte).toBeGreaterThan(0);
    expect(result.references.filter((reference) => reference.kind === "import")).not.toHaveLength(0);
    expect(result.references).toContainEqual(
      expect.objectContaining({ kind: "call", reference: "h", line: 5 }),
    );
  });

  it("uses the real Rust grammar and keeps the call reference scoped to its declaration", async () => {
    const result = await realAnalyzer().analyzeSource(
      `use crate::helper::run;\nfn main(value: i32) -> i32 {\n  if value > 0 { run(value); }\n  value\n}\n`,
      "rust",
    );

    expect(result.parser_status).toBe("parsed");
    expect(result.metrics?.cyclomatic_complexity).toBe(2);
    expect(result.declarations[0]).toMatchObject({ name: "main", line: 2 });
    expect(result.references).toContainEqual(
      expect.objectContaining({ kind: "call", reference: "run", source: "function:24" }),
    );
    expect(result.references.some((reference) => reference.kind === "import")).toBe(true);
  });

  it("parses SQL with real Tree-sitter and reports complexity as unverified", async () => {
    const result = await realAnalyzer().analyzeSource(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\nSELECT id FROM users;\n",
      "sql",
    );

    expect(result.parser_status).toBe("parsed");
    expect(result.metrics?.volume).toBeGreaterThan(0);
    expect(result.metrics?.complexity_status).toBe("unsupported");
    expect(result.metrics?.cyclomatic_complexity).toBeNull();
    expect(result.metrics?.maintainability_index).toBeNull();
  });

  it("keeps syntax errors inspectable instead of falling back to lexical parsing", async () => {
    const result = await realAnalyzer().analyzeSource("function broken( {\n", "javascript");

    expect(result.parser_status).toBe("parse-error");
    expect(result.diagnostics.some((diagnostic) => diagnostic.kind === "syntax")).toBe(true);
    expect(result.diagnostics[0]?.location?.start.line).toBeGreaterThan(0);
  });
});


describe("scan summaries", () => {
  it.each([
    ["javascript", "import x from './x.js'; function outer(v) { const inner = n => n && x(n); if (v) return inner(v); return 0; }"],
    ["rust", "fn outer(v: bool) -> i32 { if v { 1 } else { 0 } }"],
    ["typescript", "function broken( {"],
  ])("preserves file metrics and diagnostics for %s without function detail", async (language, source) => {
    const analyzer = realAnalyzer();
    const full = await analyzer.analyzeSource(source, language);
    const { declarations, references: _references, ...expected } = full;
    expect(await analyzer.analyzeSummary(source, language)).toEqual({ ...expected, declaration_count: declarations.length });
  });
});

const scanExamples = {
  javascript: 'function probe(x) { return x; }',
  typescript: 'function probe(x: number) { return x; }',
  tsx: 'function probe() { return <div />; }',
  python: 'def probe(x):\n    return x\n',
  rust: 'fn probe(x: i32) -> i32 { x }',
  go: 'package main\nfunc probe(x int) int { return x }',
  java: 'class Example { int probe(int x) { return x; } }',
  kotlin: 'fun probe(x: Int): Int { return x }',
  scala: 'object Example { def probe(x: Int): Int = x }',
  groovy: 'def probe(x) { return x }\n',
  c: 'int probe(int x) { return x; }',
  cpp: 'int probe(int x) { return x; }',
  csharp: 'class Example { int probe(int x) { return x; } }',
  ruby: 'def probe(x)\n x\nend',
  php: '<?php function probe($x) { return $x; }',
  lua: 'function probe(x) return x end',
  swift: 'func probe(_ x: Int) -> Int { return x }',
  zig: 'fn probe(x: i32) i32 { return x; }',
  solidity: 'contract Example { function probe(uint x) public pure returns (uint) { return x; } }',
  bash: 'probe() { echo "$1"; }',
};
it.each(Object.entries(scanExamples))('keeps callable declarations for the existing %s scanner language', async (language, source) => {
  const result = await realAnalyzer().analyzeSource(source, language);
  expect(result.parser_status).toBe('parsed');
  expect(result.declarations.some(item => item.name === 'probe')).toBe(true);
});
