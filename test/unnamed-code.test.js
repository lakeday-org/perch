import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { revision } from '../src/git.js';
import { analyzeFiles, createSourceAnalyzer } from '../src/analysis.js';
import { methodQuestions, scanRepository } from '../src/scan.js';
import { methodSteps } from '../src/questions.js';
import { fixtureOptions, initRepo, scriptedSystemOne } from './helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/unnamed-code/', import.meta.url));
const analyzer = createSourceAnalyzer();
const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** The units a scan would read from one file of the fixture, or from `source` in its place. */
async function unitsOf(path, source) {
  const text = source ?? await readFile(join(fixture, path), 'utf8');
  const scan = await analyzeFiles([{ path, sha: 'x' }], { analyzer, readSource: () => text });
  return { file: scan.files[0], candidates: scan.candidates.map(candidate => candidate.id), lines: text.split('\n') };
}
const bodyOf = ({ lines }, method) => lines.slice(method.line - 1, method.end_line).join('\n');
const named = (file, name) => file.methods.find(method => method.qualified_name === name);

describe('a function the parser cannot name', () => {
  it('is read under the name its enclosing call is assigned to', async () => {
    const units = await unitsOf('handlers.ts');
    const wrapped = named(units.file, 'wrapped');
    expect(wrapped).toBeDefined();
    expect(bodyOf(units, wrapped)).toContain('async (req) => {');
    expect(units.candidates).toContain('handlers.ts::wrapped');
  });

  it('is read under a name reached through more than one wrapping call', async () => {
    const units = await unitsOf('wrapped.ts', 'export const handler = withLogging(withAuth(async (req) => {\n  return req;\n}));\n');
    expect(units.candidates).toContain('wrapped.ts::handler');
  });

  it('is read under the name of the export it is assigned to', async () => {
    const units = await unitsOf('validate.js');
    expect(units.candidates).toEqual(['validate.js::module.exports.validateInput']);
  });

  it('inside a method is read as part of that method, not on its own', async () => {
    const units = await unitsOf('handlers.ts');
    expect(units.file.methods.map(method => method.qualified_name)).not.toContain('withAuth.<anonymous>');
    expect(bodyOf(units, named(units.file, 'withAuth'))).toContain('return async (req) => handler(req);');
  });
});

describe('code no function holds', () => {
  it('is read as one top-level unit per file', async () => {
    for (const [path, code] of [['routes.js', "res.send(req.query.name);"], ['pattern.js', 'module.exports = /^(a+)+$/;'], ['generated.c', 'FN(generated);']]) {
      const units = await unitsOf(path);
      expect(units.candidates).toEqual([`${path}::<top-level>`]);
      expect(bodyOf(units, named(units.file, '<top-level>'))).toContain(code);
    }
  });

  it('sits beside the named functions of the same file', async () => {
    const units = await unitsOf('cli.py');
    expect(units.candidates.sort()).toEqual(['cli.py::<top-level>', 'cli.py::main']);
  });

  it('calls what it names, so the call graph reaches the functions it runs', async () => {
    const units = await unitsOf('cli.py');
    expect(units.file.calls).toContainEqual(expect.objectContaining({ name: 'main', from: 'cli.py::<top-level>' }));
  });

  it('is not made up of imports, comments and the classes around methods', async () => {
    const units = await unitsOf('example/Inventory.java');
    expect(units.candidates).toEqual(['example/Inventory.java::Inventory.has']);
  });

  it('includes the statement that ends a Python block around a function, since nothing closes one', async () => {
    const source = 'class Config:\n    def load(self):\n        return self.DEFAULT\n    DEFAULT = 5\n\n\nif __name__ == "__main__":\n    def run():\n        return Config().load()\n    main()\n';
    const units = await unitsOf('config.py', source);
    const top = named(units.file, '<top-level>');
    expect(top?.lines.map(line => units.lines[line - 1])).toEqual(expect.arrayContaining(['    DEFAULT = 5', '    main()']));
    expect(units.file.calls).toContainEqual(expect.objectContaining({ name: 'main', from: 'config.py::<top-level>' }));
  });

  it.each([
    ['tests.js', "describe('cart', () => {\n  function total(items) { return items.length; }\n  // keep it short\n}); // cart\n"],
    ['inventory.rb', 'module Shop\n  class Inventory\n    def has(sku)\n      true\n    end\n  end\nend\n'],
  ])('still leaves out a line in %s that only closes what is around a function', async (path, source) => {
    const units = await unitsOf(path, source);
    expect(units.candidates.filter(id => id.endsWith('<top-level>'))).toEqual([]);
  });

  it('leaves a function\'s leading comment with the function it describes', async () => {
    const units = await unitsOf('double.js', 'const LIMIT = 3;\n\n/** Twice x. */\nexport function double(x) { return x * 2; }\n\nrun(LIMIT);\n');
    const node = { ...named(units.file, '<top-level>'), path: 'double.js' };
    const [step] = methodSteps({ node, lines: units.lines, methods: units.file.methods });
    expect(step.state.method.source).toContain('run(LIMIT);');
    expect(step.state.method.source).not.toContain('Twice x');
  });

  it('keeps its hash when only a function body changes', async () => {
    const before = await unitsOf('cli.py');
    const after = await unitsOf('cli.py', before.lines.join('\n').replace('return len(argv[:LIMIT])', 'return len(argv)'));
    expect(named(after.file, 'main').hash).not.toBe(named(before.file, 'main').hash);
    expect(named(after.file, '<top-level>').hash).toBe(named(before.file, '<top-level>').hash);
  });

  it('is shown to the model without the bodies of the functions it surrounds', async () => {
    const units = await unitsOf('cli.py');
    const node = { ...named(units.file, '<top-level>'), path: 'cli.py' };
    const [step] = methodSteps({ node, lines: units.lines, methods: units.file.methods });
    expect(step.state.method.source).toContain('sys.exit(main(sys.argv))');
    expect(step.state.method.source).toContain('LIMIT = 3');
    expect(step.state.method.source).not.toContain('return len(argv[:LIMIT])');
  });
});

describe('the questions a top-level unit is asked', () => {
  it('leaves out the ones about what a name or comment claims, since it has neither', () => {
    const named = methodQuestions(new Set(['defect', 'lint']), 'javascript').map(question => question.name);
    const top = methodQuestions(new Set(['defect', 'lint']), 'javascript', { topLevel: true }).map(question => question.name);
    expect(named).toContain('has_bug');
    expect(top).toContain('has_bug');
    expect(top).not.toContain('does_what_it_claims');
    expect(top).not.toContain('documented');
  });
});

describe('perch scan', () => {
  it('reads every function and every file of code outside one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-unnamed-'));
    cleanups.push(root);
    await cp(fixture, root, { recursive: true });
    await writeFile(join(root, 'package.json'), '{ "name": "unnamed", "version": "1.0.0" }\n');
    await initRepo(root);
    const systemOne = scriptedSystemOne();
    await scanRepository(fixtureOptions({ root, revision: await revision(root), out: join(root, '.perch') }, { analyzer, systemOne }));
    expect(systemOne.calls.map(call => call.method).sort()).toEqual([
      'cli.py::<top-level>', 'cli.py::main',
      'example/Inventory.java::Inventory.has',
      'generated.c::<top-level>',
      'handlers.ts::<top-level>', 'handlers.ts::bare', 'handlers.ts::named', 'handlers.ts::withAuth', 'handlers.ts::wrapped',
      'pattern.js::<top-level>',
      'routes.js::<top-level>',
      'validate.js::module.exports.validateInput',
    ]);
  });
});
