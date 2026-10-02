/** The method graph of a scan: nodes are named methods, edges are calls resolved through same-file names and imports. */
import { dirname, posix } from 'node:path';

const extensions = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go'];
const normalize = path => posix.normalize(path).replace(/^\.\//, '');
const parentDir = dir => (dir === '.' ? null : (dirname(dir) === '.' ? '.' : dirname(dir)));
const ancestors = path => { const dirs = []; for (let dir = dirname(path); dir; dir = parentDir(dir)) dirs.push(dir); return dirs; };

/** Resolve a module specifier from a scanned file to the first existing normalized path, or null. Relative imports use the containing directory; unsupported or invalid specifiers return null without mutating paths. */
const firstExisting = (paths, candidates) => candidates.map(normalize).find(path => paths.has(path)) ?? null;
const resolvePython = (fromPath, module, paths) => {
  const dots = module.length - module.replace(/^\.+/, '').length;
  const rest = module.slice(dots).split('.').filter(Boolean).join('/');
  const dirs = ancestors(fromPath), starts = dots ? [dirs[dots - 1]] : ['.', ...dirs];
  if (dots && !starts[0]) return null;
  return firstExisting(paths, starts.flatMap(start => rest ? [`${start}/${rest}.py`, `${start}/${rest}/__init__.py`] : [`${start}/__init__.py`]));
};
/**
 * mod.rs, lib.rs and main.rs are the module of the directory they sit in. Any other foo.rs is module foo, and its children live
 * in foo/, so `super` from it is the module of its own directory rather than the one above.
 */
const directoryModules = new Set(['mod.rs', 'lib.rs', 'main.rs']);
const childrenOf = path => (directoryModules.has(posix.basename(path)) ? dirname(path) : path.replace(/\.rs$/, ''));
const resolveRust = (fromPath, module, paths) => {
  const has = path => paths.has(normalize(path)), parts = module.split('::');
  let dir = childrenOf(fromPath), file = null, names = parts;
  if (parts[0] === 'crate') {
    const dirs = ancestors(fromPath), root = dirs.find(dir => has(`${dir}/src/lib.rs`) || has(`${dir}/src/main.rs`)) ?? ((dir => dir && parentDir(dir))(dirs.find(dir => dir.endsWith('/src') || dir === 'src')));
    if (!root) return null;
    [dir, file, names] = [`${root}/src`, firstExisting(paths, [`${root}/src/lib.rs`, `${root}/src/main.rs`]), parts.slice(1)];
  } else if (parts[0] === 'self' || parts[0] === 'super') {
    [file, names] = [fromPath, parts[0] === 'self' ? parts.slice(1) : parts];
    for (; names[0] === 'super'; names = names.slice(1)) {
      dir = parentDir(dir);
      if (!dir) return null;
      file = firstExisting(paths, [`${dir}.rs`, `${dir}/mod.rs`, `${dir}/lib.rs`, `${dir}/main.rs`]);
    }
  }
  // Each name is a child module with a file of its own until one is not. The rest is inline in the last file reached, or, for a
  // path that starts nowhere in this crate, like std::collections, nothing here.
  for (const name of names) {
    const child = firstExisting(paths, [`${dir}/${name}.rs`, `${dir}/${name}/mod.rs`]);
    if (!child) break;
    [dir, file] = [`${dir}/${name}`, child];
  }
  return file;
};
/** Resolve a module specifier from a scanned file to the first existing normalized path, or null. Relative imports use the containing directory; unsupported or invalid specifiers return null without mutating paths. */
export function resolveModule(fromPath, module, language, paths) {
  if (typeof module !== 'string') return null;
  if (language === 'python') return resolvePython(fromPath, module, paths);
  if (language === 'rust') return resolveRust(fromPath, module, paths);
  if (!module.startsWith('.')) return null;
  const base = normalize(posix.join(dirname(fromPath), module)), stem = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
  return firstExisting(paths, [base, ...extensions.map(ext => `${stem}.${ext}`), ...extensions.map(ext => `${base}/index.${ext}`)]);
}

/** The specifier of the module an import would name if what it imports is itself a module, or null where a name never is one. */
const submodule = ({ module, name }, language) => {
  if (typeof module !== 'string' || name === '*') return null;
  if (language === 'python') return module.endsWith('.') ? `${module}${name}` : `${module}.${name}`;
  if (language === 'rust') return `${module}::${name}`;
  return null;
};

export function buildGraph(files) {
  const nodes = new Map(), byPath = new Map(), paths = new Set(files.map(file => file.path));
  for (const file of files) {
    const byName = new Map(), byQualified = new Map();
    for (const method of file.methods) {
      nodes.set(method.id, { ...method, path: file.path, language: file.language, test: file.test });
      byQualified.set(method.qualified_name, method.id);
      if (!byName.has(method.name)) byName.set(method.name, []);
      byName.get(method.name).push(method.id);
    }
    byPath.set(file.path, { file, byName, byQualified });
  }
  /** A method by name in one file, preferring a top-level definition. */
  const lookup = (path, name) => {
    const entry = byPath.get(path);
    if (!entry) return null;
    return entry.byQualified.get(name) ?? entry.byName.get(name)?.[0] ?? null;
  };
  // Unqualified Go calls resolve within a package. Index names once instead of searching the entire repository for each call.
  // Keep file order and the per-file lookup preference, including ambiguous names, identical to the ordinary lookup.
  const packages = new Map();
  for (const file of files) {
    if (file.language !== 'go') continue;
    const directory = dirname(file.path);
    if (!packages.has(directory)) packages.set(directory, new Map());
    const names = packages.get(directory), entry = byPath.get(file.path);
    for (const name of new Set([...entry.byName.keys(), ...entry.byQualified.keys()])) {
      if (!names.has(name)) names.set(name, []);
      names.get(name).push({ file, id: lookup(file.path, name) });
    }
  }
  const sameDirectory = (file, name) => packages.get(dirname(file.path))?.get(name)?.find(entry => entry.file !== file)?.id ?? null;
  const viaImport = (file, alias, tail) => {
    const imported = file.imports.find(item => item.alias === alias);
    if (!imported) return null;
    // `from . import utils` then `utils.helper()`: the name imported is a module of its own, and helper is in it, not the package.
    const inner = tail === null ? null : resolveModule(file.path, submodule(imported, file.language), file.language, paths);
    if (inner) return lookup(inner, tail);
    const target = resolveModule(file.path, imported.module, file.language, paths);
    if (!target) return null;
    return tail === null ? lookup(target, imported.name) : lookup(target, `${imported.name}.${tail}`) ?? lookup(target, tail);
  };
  const resolve = (file, name) => {
    const parts = name.split(/::|\./), head = parts[0], tail = parts.at(-1);
    if (parts.length === 1) return viaImport(file, name, null) ?? lookup(file.path, name) ?? (file.language === 'go' ? sameDirectory(file, name) : null);
    return viaImport(file, head, tail) ?? lookup(file.path, `${head}.${tail}`) ?? lookup(file.path, tail);
  };

  // A name that belongs to exactly one method in the repository can be resolved wherever it appears; anything more common is guesswork.
  const unique = new Map();
  for (const [id, node] of nodes) {
    const key = node.name;
    unique.set(key, unique.has(key) ? null : id);
  }

  const callees = new Map(), callers = new Map(), sites = new Map(), dynamic = new Set();
  const link = (map, from, to) => { if (!map.has(from)) map.set(from, new Set()); map.get(from).add(to); };
  for (const file of files) {
    for (const call of file.calls) {
      const to = resolve(file, call.name);
      if (!to || to === call.from) continue;
      link(callees, call.from, to);
      link(callers, to, call.from);
      const key = `${call.from}->${to}`;
      if (!sites.has(key)) sites.set(key, call.line);
    }
  }
  // Functions passed as values: the dispatcher that eventually calls them has no name for them, so the edge comes from the handover.
  for (const file of files) {
    for (const value of file.values ?? []) {
      const to = resolve(file, value.name) ?? unique.get(value.name.split(/::|\./).at(-1)) ?? null;
      if (!to || to === value.from || !nodes.has(to)) continue;
      if (callees.get(value.from)?.has(to)) continue;
      link(callees, value.from, to);
      link(callers, to, value.from);
      dynamic.add(`${value.from}->${to}`);
      if (!sites.has(`${value.from}->${to}`)) sites.set(`${value.from}->${to}`, value.line);
    }
  }

  return {
    nodes,
    /** Whether an edge was inferred from a handover rather than seen as a call. */
    isDynamic: (from, to) => dynamic.has(`${from}->${to}`),
    files: byPath,
    callees: id => [...(callees.get(id) ?? [])],
    callers: id => [...(callers.get(id) ?? [])],
    /**
     * Return the first recorded source line for the directed edge from `from` to `to`.
     * The line may identify a call or a function-value handover. Return null when no
     * such edge was recorded; this lookup does not change the graph.
     */
    site: (from, to) => {
      const edge = `${from}->${to}`;
      return sites.get(edge) ?? null;
    },
    edgeCount: () => [...callees.values()].reduce((sum, set) => sum + set.size, 0),
  };
}
