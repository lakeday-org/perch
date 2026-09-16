import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_LANGUAGES,
  analyzeSource,
  createAnalyzer,
  languageForPath,
} from "../src/index";

const require = createRequire(import.meta.url);

function assetPath(name: string): string {
  if (name === "web-tree-sitter.wasm") {
    return require.resolve("web-tree-sitter/web-tree-sitter.wasm");
  }
  const language = name.slice("tree-sitter-".length, -".wasm".length);
  return require.resolve(`tree-sitter-wasm/${language}/tree-sitter-${language}.wasm`);
}

function realAnalyzer() {
  return createAnalyzer({
    loadAsset: async (name) => readFile(assetPath(name)),
  });
}

describe("language registry", () => {
  it("registers the pinned broad grammar set without pretending to support Lean", () => {
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThan(30);
    expect(languageForPath("src/index.ts")).toBe("typescript");
    expect(languageForPath("src/view.tsx")).toBe("tsx");
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("Main.lean")).toBeNull();
  });
});

describe("Tree-sitter analysis", () => {
  it("loads every registered grammar through the real WASM runtime", async () => {
    const analyzer = realAnalyzer();
    for (const language of SUPPORTED_LANGUAGES) {
      const result = await analyzer.analyzeSource("", language);
      expect(result.parser_status, language).not.toBe("resource-unavailable");
    }
  });

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

  it("reports missing resources and unknown grammars explicitly", async () => {
    const missing = await analyzeSource("const x = 1;", "javascript");
    expect(missing.parser_status).toBe("resource-unavailable");
    expect(missing.metrics).toBeNull();
    expect(missing.diagnostics[0]?.kind).toBe("resource");

    const unknown = await realAnalyzer().analyzeSource("theorem foo : True := by trivial", "lean");
    expect(unknown.parser_status).toBe("unsupported");
    expect(unknown.metrics).toBeNull();
    expect(unknown.diagnostics[0]?.kind).toBe("unsupported");
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
  it("fails closed when the grammar is unavailable", async () => {
    const analyzer = createAnalyzer({ loadAsset: () => { throw new Error("missing asset"); } });
    const result = await analyzer.analyzeSummary("fn main() {}", "rust");
    expect(result.parser_status).toBe("resource-unavailable");
    expect(result.metrics).toBeNull();
  });
});
