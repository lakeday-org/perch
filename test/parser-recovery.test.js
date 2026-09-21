import { describe, expect, it } from 'vitest';
import { createSourceAnalyzer } from '../src/analysis.js';

const analyzer = createSourceAnalyzer();
const names = result => result.declarations.map(declaration => declaration.qualified_name);

describe('a token the parser filled in does not fail the file', () => {
  it('keeps a JavaScript file whose statement has no semicolon before a line starting with [', async () => {
    // tests/test-proxy.js in cypress-io/request: tree-sitter inserts a MISSING `;` after the declaration and the tree is whole.
    const source = "var s = 1\nvar currResponseHandler\n\n['a', 'b'].forEach(function (url) {\n  currResponseHandler(url)\n})\n\nfunction later() { return 1 }\n";
    const result = await analyzer.analyzeSource(source, 'javascript');
    expect(result.parser_status).toBe('parsed');
    expect(result.diagnostics).toEqual([]);
    expect(names(result)).toContain('later');
  });

  it('keeps a C++ file with a macro invocation and no semicolon at file scope', async () => {
    // native/addon.cpp in bitcoinjs/tiny-secp256k1: NODE_MODULE(secp256k1, Init) at the end of the file.
    const source = '#define REGISTER(name) int name() {return 1;}\nint first() { return 0; }\nREGISTER(example)\nint after() { return 2; }\n';
    const result = await analyzer.analyzeSource(source, 'cpp');
    expect(result.parser_status).toBe('parsed');
    expect(result.diagnostics).toEqual([]);
    expect(names(result)).toEqual(expect.arrayContaining(['first', 'after']));
  });

  it('still reports text the parser could not place', async () => {
    const js = await analyzer.analyzeSource('function ok() { return 1 }\nfunction broken( { return\n', 'javascript');
    expect(js.parser_status).toBe('parse-error');
    expect(js.diagnostics.length).toBeGreaterThan(0);
    const cpp = await analyzer.analyzeSource('int ok() { return 1; }\nint broken( { return\n', 'cpp');
    expect(cpp.parser_status).toBe('parse-error');
  });
});
