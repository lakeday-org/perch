import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createAnalyzer } from "../src/treesitter/index";

const require = createRequire(import.meta.url);

it("initializes from real WASM without an asynchronous compiler host queue", async () => {
  const compile = vi.spyOn(WebAssembly, "compile").mockImplementation(() => {
    throw new Error("Native Worker does not pump async WASM compilation");
  });
  const instantiate = vi.spyOn(WebAssembly, "instantiate").mockImplementation(() => {
    throw new Error("Native Worker does not pump async WASM instantiation");
  });
  try {
    const analyzer = createAnalyzer({
      loadAsset: name => readFile(require.resolve(name === "web-tree-sitter.wasm"
        ? `web-tree-sitter/${name}` : `tree-sitter-wasm/javascript/${name}`)),
    });
    const result = await analyzer.analyzeSource("export function select(x) { return x ? 1 : 0; }", "javascript");
    expect(result.parser_status).toBe("parsed");
    expect(result.declarations[0].name).toBe("select");
    expect(compile).not.toHaveBeenCalled();
    expect(instantiate).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});
