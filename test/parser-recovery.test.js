import { describe, expect, it } from 'vitest';
import { createSourceAnalyzer } from '../src/analysis.js';

const analyzer = createSourceAnalyzer();
const names = result => result.declarations.map(declaration => declaration.qualified_name);

/** Each is valid in its language, or valid for a parser that ran the preprocessor; tree-sitter recovers and the functions are in the tree. */
const recovered = [
  ['javascript', 'a statement with no semicolon before a line starting with [', "var s = 1\nvar currResponseHandler\n\n['a', 'b'].forEach(function (url) {\n  currResponseHandler(url)\n})\n\nfunction later() { return 1 }\n", ['later'], false],
  ['cpp', 'a macro invocation at file scope with no semicolon', '#define REGISTER(name) int name() {return 1;}\nint first() { return 0; }\nREGISTER(example)\nint after() { return 2; }\n', ['first', 'after'], false],
  ['c', 'cleanup-attribute macros in declarations', 'int work(void) { int _cleanup_close_ fd = open("x", 0); void _cleanup_free_ *buf = malloc(4); return fd; }\nint other(void) { return 1; }\n', ['other'], true],
  ['javascript', 'a long s in a string', 'const value = "ſt";\nfunction f() { return value; }\n', ['f'], true],
  ['typescript', 'a generic import type', 'type T = import("./foo").ListConfig<string, number>;\nexport function f(x: T): T { return x; }\n', ['f'], true],
  // The annotation is inside read's own signature, so read is the one declaration the error costs; other is still read.
  ['javascript', 'Flow type imports and annotations', '// @flow\nimport type { Model } from "./types";\nfunction read(x: Model): void {}\nfunction other() { return 1; }\n', ['other'], true],
  ['groovy', 'wildcard and static wildcard imports', 'import java.util.*\nimport static java.util.Collections.*\nclass A { def m() { return 1 } }\n', ['m'], true],
];

describe('a syntax error costs the file one declaration, not all of them', () => {
  it.each(recovered)('%s: %s', async (language, _what, source, expected, noted) => {
    const result = await analyzer.analyzeSource(source, language);
    expect(result.parser_status).toBe('parsed');
    expect(names(result)).toEqual(expect.arrayContaining(expected));
    // A filled-in semicolon is not an error; text the parser could not place is, and the file says so while still being read.
    if (noted) expect(result.diagnostics.length).toBeGreaterThan(0);
    else expect(result.diagnostics).toEqual([]);
  });

  it('leaves out the declaration the error is inside and keeps its neighbours', async () => {
    const result = await analyzer.analyzeSource('function ok() { return 1 }\nfunction broken( { return\n}\nfunction alsoOk() { return 2 }\n', 'javascript');
    expect(result.parser_status).toBe('parsed');
    expect(names(result)).toContain('ok');
    expect(names(result)).not.toContain('broken');
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('is a parse error only when nothing in the file can be read', async () => {
    const js = await analyzer.analyzeSource('function broken( { return\n', 'javascript');
    expect(js.parser_status).toBe('parse-error');
    expect(js.declarations).toEqual([]);
    const cpp = await analyzer.analyzeSource('int broken( { return\n', 'cpp');
    expect(cpp.parser_status).toBe('parse-error');
  });
});
