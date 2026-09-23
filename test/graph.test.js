import { describe, expect, it } from 'vitest';
import { buildGraph, resolveModule } from '../src/graph.js';

const method = (path, name, line, risk = 10) => ({ id: `${path}::${name}`, node: `function:${line}`, name: name.split('.').at(-1), qualified_name: name, line, end_line: line + 2, hash: 'h', metrics: { risk_score: risk } });

describe('method graph', () => {
  it('preserves Go package order, top-level preference, language boundaries and unresolved calls', () => {
    const file = (path, language, names, calls = [], values = []) => ({ path, language, methods: names.map((name, i) => method(path, name, i + 1)), calls, values, imports: [] });
    const files = [
      file('other/a.go', 'go', ['helper']),
      file('pkg/a.js', 'javascript', ['helper']),
      file('pkg/a.go', 'go', ['Runner.Run'], [
        { from: 'pkg/a.go::Runner.Run', name: 'helper', line: 2 },
        { from: 'pkg/a.go::Runner.Run', name: 'unknown', line: 3 },
      ], [{ from: 'pkg/a.go::Runner.Run', name: 'callback', line: 4 }]),
      file('pkg/b.go', 'go', ['Receiver.helper', 'helper', 'callback']),
      file('pkg/c.go', 'go', ['helper', 'callback']),
      file('pkg/d.go', 'go', ['helper', 'Run'], [{ from: 'pkg/d.go::Run', name: 'helper', line: 2 }]),
    ];
    const graph = buildGraph(files);
    expect(graph.callees('pkg/a.go::Runner.Run')).toEqual(['pkg/b.go::helper', 'pkg/b.go::callback']);
    expect(graph.callees('pkg/d.go::Run')).toEqual(['pkg/d.go::helper']);
    expect(graph.callers('pkg/b.go::helper')).toEqual(['pkg/a.go::Runner.Run']);
    expect(graph.isDynamic('pkg/a.go::Runner.Run', 'pkg/b.go::callback')).toBe(true);
    expect(graph.site('pkg/a.go::Runner.Run', 'pkg/b.go::callback')).toBe(4);
  });

  it('resolves module specifiers per language', () => {
    const paths = new Set(['src/a.js', 'src/b.ts', 'src/dir/index.js', 'pkg/__init__.py', 'pkg/util.py', 'pkg/sub/mod.py', 'crate/src/lib.rs', 'crate/src/util.rs', 'crate/src/net/mod.rs']);
    expect(resolveModule('src/a.js', './b.js', 'javascript', paths)).toBe('src/b.ts');
    expect(resolveModule('src/a.js', './dir', 'javascript', paths)).toBe('src/dir/index.js');
    expect(resolveModule('src/a.js', 'lodash', 'javascript', paths)).toBeNull();
    expect(resolveModule('pkg/sub/mod.py', '.util', 'python', paths)).toBeNull();
    expect(resolveModule('pkg/sub/mod.py', '..util', 'python', paths)).toBe('pkg/util.py');
    expect(resolveModule('pkg/sub/mod.py', 'pkg.util', 'python', paths)).toBe('pkg/util.py');
    expect(resolveModule('pkg/sub/mod.py', 'pkg', 'python', paths)).toBe('pkg/__init__.py');
    expect(resolveModule('crate/src/lib.rs', 'crate::util', 'rust', paths)).toBe('crate/src/util.rs');
    expect(resolveModule('crate/src/util.rs', 'crate::net', 'rust', paths)).toBe('crate/src/net/mod.rs');
    expect(resolveModule('crate/src/net/mod.rs', 'super::util', 'rust', paths)).toBe('crate/src/util.rs');
  });

  it('links calls through same-file names, imports, classes, and Go packages', () => {
    const files = [
      { path: 'src/a.js', language: 'javascript', test: false, methods: [method('src/a.js', 'f', 1, 50), method('src/a.js', 'g', 10, 20), method('src/a.js', 'K.m', 20, 30)],
        calls: [{ name: 'g', from: 'src/a.js::f', line: 2 }, { name: 'h', from: 'src/a.js::f', line: 3 }, { name: 'this.m', from: 'src/a.js::g', line: 11 }, { name: 'util.k', from: 'src/a.js::g', line: 12 }, { name: 'console.log', from: 'src/a.js::f', line: 4 }],
        imports: [{ module: './b.js', name: 'h', alias: 'h' }, { module: './b.js', name: 'util', alias: 'util' }] },
      { path: 'src/b.js', language: 'javascript', test: false, methods: [method('src/b.js', 'h', 1), method('src/b.js', 'util.k', 5)], calls: [{ name: 'k', from: 'src/b.js::h', line: 2 }], imports: [] },
      { path: 'go/x.go', language: 'go', test: false, methods: [method('go/x.go', 'Run', 1)], calls: [{ name: 'helper', from: 'go/x.go::Run', line: 2 }], imports: [] },
      { path: 'go/y.go', language: 'go', test: false, methods: [method('go/y.go', 'helper', 1)], calls: [], imports: [] },
      { path: 'test/a.test.js', language: 'javascript', test: true, methods: [method('test/a.test.js', 't', 1)], calls: [{ name: 'f', from: 'test/a.test.js::t', line: 2 }], imports: [{ module: '../src/a.js', name: 'f', alias: 'f' }] },
    ];
    const graph = buildGraph(files);
    expect(graph.callees('src/a.js::f').sort()).toEqual(['src/a.js::g', 'src/b.js::h']);
    expect(graph.callees('src/a.js::g').sort()).toEqual(['src/a.js::K.m', 'src/b.js::util.k']);
    expect(graph.callees('src/b.js::h')).toEqual(['src/b.js::util.k']);
    expect(graph.callees('go/x.go::Run')).toEqual(['go/y.go::helper']);
    expect(graph.callers('src/a.js::f')).toEqual(['test/a.test.js::t']);
    expect(graph.callers('src/b.js::h')).toEqual(['src/a.js::f']);
    expect(graph.site('src/a.js::f', 'src/b.js::h')).toBe(3);
    expect(graph.nodes.get('test/a.test.js::t').test).toBe(true);
    expect(graph.edgeCount()).toBe(7);
  });
});
