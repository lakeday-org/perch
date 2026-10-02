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
  // An absolute import is looked for beside the file, in each directory above it, and in each one's src/: the src layout
  // pyproject's packaging recommends keeps `import click` in src/click, which no test sits beside.
  const dirs = ancestors(fromPath), starts = dots ? [dirs[dots - 1]] : [...new Set(['.', ...dirs].flatMap(dir => [dir, dir === '.' ? 'src' : `${dir}/src`]))];
  if (dots && !starts[0]) return null;
  return firstExisting(paths, starts.flatMap(start => rest ? [`${start}/${rest}.py`, `${start}/${rest}/__init__.py`] : [`${start}/__init__.py`]));
};
/**
 * mod.rs, lib.rs and main.rs are the module of the directory they sit in. Any other foo.rs is module foo, and its children live
 * in foo/, so `super` from it is the module of its own directory rather than the one above.
 */
const directoryModules = new Set(['mod.rs', 'lib.rs', 'main.rs']);
const childrenOf = path => (directoryModules.has(posix.basename(path)) ? dirname(path) : path.replace(/\.rs$/, ''));
const resolveRust = (fromPath, module, paths, crates = []) => {
  const has = path => paths.has(normalize(path)), parts = module.split('::');
  let dir = childrenOf(fromPath), file = null, names = parts;
  // `serde_json::de` from a test or another crate: the crate by its Cargo.toml name, then its modules from its lib.rs.
  const crate = crates.find(item => item.name === parts[0]);
  if (crate) {
    if (!has(crate.lib)) return null;
    [dir, file, names] = [dirname(crate.lib), normalize(crate.lib), parts.slice(1)];
  } else if (parts[0] === 'crate') {
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
/**
 * `#include "gtest/gtest.h"`: beside the including file first, as a quoted include is, then the one file in the repository at
 * that path below some directory, as a compiler finds it on an include path the build gives it. A header two directories could
 * hold is none, since which one the build means is not in the tree.
 */
const byTail = new WeakMap();
function resolveInclude(fromPath, module, paths) {
  const beside = normalize(posix.join(dirname(fromPath), module));
  if (paths.has(beside)) return beside;
  if (!byTail.has(paths)) {
    const named = new Map();
    for (const path of paths) { const base = path.split('/').at(-1); named.set(base, [...(named.get(base) ?? []), path]); }
    byTail.set(paths, named);
  }
  const found = (byTail.get(paths).get(module.split('/').at(-1)) ?? []).filter(path => path === module || path.endsWith(`/${module}`));
  return found.length === 1 ? found[0] : null;
}

export function resolveModule(fromPath, module, language, paths, crates = []) {
  if (typeof module !== 'string') return null;
  if (language === 'python') return resolvePython(fromPath, module, paths);
  if (language === 'rust') return resolveRust(fromPath, module, paths, crates);
  if (language === 'c' || language === 'cpp') return resolveInclude(fromPath, module, paths);
  if (!module.startsWith('.')) return null;
  const base = normalize(posix.join(dirname(fromPath), module)), stem = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
  return firstExisting(paths, [base, ...extensions.map(ext => `${stem}.${ext}`), ...extensions.map(ext => `${base}/index.${ext}`)]);
}

const JAVASCRIPT = new Set(['javascript', 'typescript', 'tsx']);
const CONSTRUCTORS = { python: ['__init__'], javascript: ['constructor'], typescript: ['constructor'], tsx: ['constructor'] };
/** Languages that find a class by its package rather than by the file it is in. */
const JVM = new Set(['java', 'kotlin']);
/** Languages whose linker joins a call in one file to a definition in another, by name alone. */
const NATIVE = new Set(['c', 'cpp']);
/**
 * Languages where a method calls another method of its own class by its bare name. Python, JavaScript, TypeScript, Rust and Go
 * need the receiver written out, so a bare name there is never a method of the class the caller sits in.
 */
const IMPLICIT_THIS = new Set(['java', 'kotlin', 'cpp', 'csharp', 'scala', 'swift', 'dart']);
/** Names a method uses for the object or class it belongs to. */
/** The name a C++ `using namespace` directive is recorded under among a file's imports, the namespace as its module. */
const USING_NAMESPACE = '<namespace>', USING_NAME = '<using>';
const RECEIVERS = new Set(['this', 'self', 'cls', 'Self']);

export function buildGraph(files, { crates = [] } = {}) {
  const resolveIn = (from, module, language, known) => resolveModule(from, module, language, known, crates);
  const nodes = new Map(), byPath = new Map(), paths = new Set(files.map(file => file.path));
  for (const file of files) {
    const byQualified = new Map();
    for (const method of file.methods) {
      // Everything in a test file is test code. A test case in a source file, Rust's `#[cfg(test)] mod tests`, is a test too,
      // and `case` says which test it is.
      nodes.set(method.id, { ...method, path: file.path, language: file.language, test: Boolean(file.test) || Boolean(method.test) || Boolean(method.support), case: method.test ?? null });
      byQualified.set(method.qualified_name, method.id);
    }
    byPath.set(file.path, { file, byQualified });
  }
  /** The method one file defines under exactly this qualified name. A bare name is a top-level definition, never a member. */
  const defined = (path, qualified) => byPath.get(path)?.byQualified.get(qualified) ?? null;
  /**
   * The method a name defines in a file, or, when it names a class, the constructor a call to it runs: `__init__` in Python,
   * `constructor` in JavaScript, and the method named after the class in Java and C#.
   */
  const exact = (path, qualified) => {
    const own = defined(path, qualified);
    if (own) return own;
    const names = [...(CONSTRUCTORS[byPath.get(path)?.file.language] ?? []), qualified.split('.').at(-1)];
    for (const name of names) {
      const found = defined(path, `${qualified}.${name}`);
      if (found) return found;
    }
    return null;
  };
  /**
   * The scopes a call is made from, innermost first: the caller itself, then each name it is nested in. Each says whether it is a
   * function, whose nested definitions its body can call by name in every language, or a class, whose members only languages
   * with an implicit `this` can.
   */
  const scopesOf = (path, from) => {
    const parts = (nodes.get(from)?.qualified_name ?? '').split('.').filter(Boolean);
    const scopes = [];
    for (let length = parts.length; length > 0; length -= 1) {
      const name = parts.slice(0, length).join('.');
      // A function the caller is nested in, by its own name: a class whose constructor `exact` would find is still a class.
      scopes.push({ name, callable: Boolean(defined(path, name)) });
    }
    return scopes;
  };
  /** A bare name called from `from`: a definition nested in a scope the caller can see, innermost first, then the file's own. */
  const unqualified = (file, name, from) => {
    for (const scope of scopesOf(file.path, from)) {
      if (!scope.callable && !IMPLICIT_THIS.has(file.language)) continue;
      const found = exact(file.path, `${scope.name}.${name}`);
      if (found) return found;
    }
    return exact(file.path, name) ?? inClosure(file.path, name);
  };
  /**
   * A function declared inside an unnamed one, `const run = () => ...` in a describe callback, has no name a caller's scopes can
   * spell: it is `<anonymous>.run`. The callers it has are beside it in that callback, so the one such function of that name in
   * the file is the one they call.
   */
  const closures = new Map();
  const inClosure = (path, name) => {
    if (!closures.has(path)) {
      const named = new Map();
      for (const id of byPath.get(path)?.byQualified.values() ?? []) {
        const qualified = nodes.get(id)?.qualified_name ?? '';
        if (!qualified.includes('<anonymous>.')) continue;
        const last = qualified.split('.').at(-1);
        named.set(last, [...(named.get(last) ?? []), id]);
      }
      closures.set(path, named);
    }
    const found = closures.get(path).get(name) ?? [];
    return found.length === 1 ? found[0] : null;
  };
  /** `self.f`, `this.f`, `cls.f`, `Self::f`: f in the class the caller is a member of, which is its innermost scope that is no function. */
  const ownClass = (file, name, from) => {
    const owner = scopesOf(file.path, from).find(scope => !scope.callable);
    return owner ? exact(file.path, `${owner.name}.${name}`) ?? inherited(file, { name: owner.name.split('.').at(-1), path: file.path }, name, 0) : null;
  };
  /** The one method some files define under this exact qualified name, or null when none does or more than one does. */
  const single = (paths, qualified) => {
    const ids = new Set(paths.map(path => byPath.get(path)?.byQualified.get(qualified)).filter(Boolean));
    return ids.size === 1 ? [...ids][0] : null;
  };
  // Unqualified Go calls resolve within a package. Index names once instead of searching the entire repository for each call.
  // Keep file order, so the first file in the package declaring a name is the one a call finds.
  const packages = new Map();
  for (const file of files) {
    if (file.language !== 'go') continue;
    const directory = dirname(file.path);
    if (!packages.has(directory)) packages.set(directory, new Map());
    const names = packages.get(directory), entry = byPath.get(file.path);
    for (const [name, id] of entry.byQualified) {
      if (!names.has(name)) names.set(name, []);
      names.get(name).push({ file, id });
    }
  }
  const sameDirectory = (file, name) => packages.get(dirname(file.path))?.get(name)?.find(entry => entry.file !== file)?.id ?? null;
  /**
   * The longest prefix of a dotted Python path that is a module, the way the import system finds it, and what is left over.
   * `shop.cart.Cart.total` is module shop.cart and `Cart.total` in it when shop/cart.py exists.
   */
  const pythonModule = (file, parts, least) => {
    for (let length = parts.length - least; length > 0; length -= 1) {
      const target = resolveIn(file.path, parts.slice(0, length).join('.'), 'python', paths);
      if (target) return { target, rest: parts.slice(length) };
    }
    return null;
  };
  /** A name inside a module file: one name is whatever the module binds to it, its own or imported; more is a class member. */
  // A class member through a package that passes the class on, `click.Context.fail` with Context defined in click/core.py, is
  // followed as the package's exports are.
  const inModule = (target, rest) => (rest.length === 1 ? resolve(byPath.get(target).file, rest[0], null) : exported(target, rest.join('.'), byPath.get(target).file.language));
  /** A Python `from pkg import name` binds a submodule when pkg/name.py is one, and a name defined in pkg otherwise. */
  const submodule = imported => (imported.module.endsWith('.') || !imported.module ? `${imported.module}${imported.name}` : `${imported.module}.${imported.name}`);
  /**
   * What a module exports under a name: its own definition, `exports.f` or `module.exports.f` for CommonJS, or, for a barrel file
   * that defines nothing itself, whatever its `export ... from` passes on, followed a few files deep.
   */
  const exported = (target, qualified, language, depth = 0) => {
    const own = exact(target, qualified) ?? (JAVASCRIPT.has(language) ? exact(target, `exports.${qualified}`) ?? exact(target, `module.exports.${qualified}`) : null);
    const module = byPath.get(target)?.file;
    if (own || !module || depth > 4) return own;
    const [head, ...more] = qualified.split('.');
    for (const item of module.imports ?? []) {
      // Rust passes a name on with `pub use`, and Python with an import in a package's __init__.py, each written like any other
      // import; a lib.rs or an __init__.py is mostly those.
      if (!item.reexport && module.language !== 'rust' && module.language !== 'python') continue;
      const next = resolveIn(target, item.module, module.language, paths);
      if (!next) continue;
      if (item.name === '*' && (!item.alias || item.alias === '*')) {
        const found = exported(next, qualified, language, depth + 1);
        if (found) return found;
      } else if (item.alias === head) {
        const name = item.name === 'default' || (item.name === '*' && !more.length) ? byPath.get(next)?.file.default_export : item.name;
        // A whole module passed on is its exports, and a CommonJS module that assigns module.exports is that value: `Response.json`
        // through `exports.Response = require('./response')` is json of the class response.js exports.
        const whole = byPath.get(next)?.file.default_export;
        const found = item.name === '*' && more.length
          ? exported(next, more.join('.'), language, depth + 1) ?? (whole && JAVASCRIPT.has(language) ? exported(next, [whole, ...more].join('.'), language, depth + 1) : null)
          : name ? exported(next, [name, ...more].join('.'), language, depth + 1) : null;
        if (found) return found;
      }
    }
    // `const createApplication = require('./lib/application'); module.exports = createApplication`: the module's default is a
    // name it imported, so it is whatever that module exports under it.
    const passed = JAVASCRIPT.has(language) && module.default_export === head ? (module.imports ?? []).find(item => item.alias === head && !item.reexport) : null;
    const next = passed && resolveIn(target, passed.module, module.language, paths);
    if (next) {
      const name = passed.name === 'default' || passed.name === '*' ? byPath.get(next)?.file.default_export : passed.name;
      return name ? exported(next, [name, ...more].join('.'), language, depth + 1) : null;
    }
    return null;
  };
  const viaImport = (file, parts) => {
    const [alias, ...rest] = parts, tail = rest.at(-1) ?? null;
    // A re-export passes a name on; it binds nothing this file can call.
    const imported = file.imports.find(item => item.alias === alias && !item.reexport);
    if (!imported) return null;
    if (file.language === 'python' && rest.length) {
      // `import a.b` binds a module, so `a.b.f()` is f in whichever module of the path exists.
      if (imported.name === '*') {
        // `import a.b` binds a, the package, so `a.b.f()` is read from a; `import a.b as c` binds c to a.b itself.
        const bound = imported.alias === imported.module.split('.')[0] ? [imported.alias] : imported.module.split('.');
        const found = pythonModule(file, [...bound, ...rest], 1);
        return found ? inModule(found.target, found.rest) : null;
      }
      const module = resolveIn(file.path, submodule(imported), 'python', paths);
      if (module) return inModule(module, rest);
    }
    // `use crate::cart;` binds a module, and `cart::f()` is f in that module's file. A `use` naming an item in its parent
    // module has no file of its own, and is looked up in the parent below.
    if (file.language === 'rust' && rest.length) {
      // A path resolves to the last module file it reaches, so the name is a module only when it reaches further than its parent.
      const module = resolveIn(file.path, `${imported.module}::${imported.name}`, 'rust', paths);
      if (module && module !== resolveIn(file.path, imported.module, 'rust', paths)) return exact(module, rest.join('.'));
    }
    const target = resolveIn(file.path, imported.module, file.language, paths);
    if (!target) return null;
    // A default import, or a whole CommonJS module called as a function, is whatever the module exports as its default.
    const fallback = byPath.get(target)?.file.default_export ?? null;
    const own = imported.name === 'default' || (imported.name === '*' && tail === null) ? fallback : imported.name;
    const defined = qualified => exported(target, qualified, file.language);
    if (tail === null) return own ? defined(own) : null;
    // A namespace import binds the module itself, so `ns.f` is f in it. Any other binding is one name the module defines, and
    // `Name.f` is a member of it.
    return imported.name === '*' ? defined(rest.join('.')) : own ? defined([own, ...rest].join('.')) : null;
  };

  // Java and Kotlin find a class by its package, whatever file it is in, so each package's classes are indexed once: a class by
  // the top-level name its methods are qualified with, and a Kotlin top-level function by its bare name. The unnamed package is
  // a package like any other: every file without a declaration is in it.
  const jvm = new Map();
  const jvmPackage = name => {
    if (!jvm.has(name)) jvm.set(name, { classes: new Map(), functions: new Map(), extensions: new Map() });
    return jvm.get(name);
  };
  for (const file of files) {
    if (!JVM.has(file.language)) continue;
    const entry = jvmPackage(file.package ?? '');
    for (const method of file.methods) {
      // A Kotlin extension is a top-level function named for its receiver, not a member of a class with that name.
      if (method.extension) {
        if (!entry.extensions.has(method.name)) entry.extensions.set(method.name, new Set());
        entry.extensions.get(method.name).add(method.id);
        continue;
      }
      const dot = method.qualified_name.indexOf('.');
      const [map, key, value] = dot > 0 ? [entry.classes, method.qualified_name.slice(0, dot), file.path] : [entry.functions, method.qualified_name, method.id];
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(value);
    }
  }
  const sole = ids => (new Set(ids).size === 1 ? ids[0] : null);
  const classesIn = (name, head) => [...(jvm.get(name)?.classes.get(head) ?? [])];
  const functionsIn = (name, head) => [...(jvm.get(name)?.functions.get(head) ?? [])];
  const extensionsIn = (name, member) => [...(jvm.get(name)?.extensions.get(member) ?? [])];
  /**
   * `x.f()` in Kotlin where f is no member perch can find: an extension function named f, by Kotlin's lookup for a top-level
   * function, an import naming it, then the file's own package, then an on-demand import. Which receiver x is decides nothing more
   * here, since the tree does not give its type; an f declared for two receivers in one package links neither.
   */
  const jvmExtension = (file, member, receiver = null) => {
    const imports = file.imports ?? [];
    // With the receiver's class known, `source.buffer()` is the buffer declared on Source, not the one on Sink.
    const on = ids => (receiver ? ids.filter(id => nodes.get(id)?.qualified_name === `${receiver}.${member}`) : ids);
    const explicit = imports.find(item => item.alias === member && item.name !== '*' && !item.name.endsWith('.*'));
    if (explicit) return sole(on(extensionsIn(explicit.module, explicit.name)));
    const own = on(extensionsIn(file.package ?? '', member));
    if (own.length) return sole(own);
    return sole(on(imports.filter(item => item.name === '*').flatMap(item => extensionsIn(item.module, member))));
  };
  /**
   * The files declaring the class a simple name means in this file, by Java's scoping: a single-type import shadows the file's
   * own package, and the package shadows on-demand imports. An import names its class even when that class is not in the
   * repository, so a name it binds never falls through to another package. Null when the name is no class this file can see.
   */
  const classFiles = (file, head) => {
    const imports = file.imports ?? [];
    const named = imports.find(item => item.alias === head && item.name !== '*' && !item.name.includes('.'));
    if (named) return classesIn(named.module, named.name);
    const own = classesIn(file.package ?? '', head);
    if (own.length) return own;
    const onDemand = imports.filter(item => item.name === '*').flatMap(item => classesIn(item.module, head));
    return onDemand.length ? onDemand : null;
  };
  /** `new Ledger()` in Java: the constructor of the class the name means in this file, by Java's scoping. */
  const jvmConstructor = (file, name) => {
    const files = classFiles(file, name);
    return files ? single(files, `${name}.${name}`) : null;
  };
  /** `Head.tail` where Head is a class: the method of that class, or null when the class has no such method. */
  const jvmQualified = (file, parts) => {
    const files = classFiles(file, parts[0]);
    return files === null ? undefined : single(files, parts.join('.'));
  };
  /**
   * An unqualified call to something no class of this file declares. In Java that is a static import, by name before on
   * demand. Kotlin has top-level functions besides, found by an import naming them, then in the file's own package, then
   * through an on-demand import. Java cannot call a Kotlin top-level function without the class Kotlin compiles it into.
   */
  const jvmUnqualified = (file, name) => {
    const kotlin = file.language === 'kotlin', imports = file.imports ?? [];
    const explicit = imports.find(item => item.alias === name && item.name !== '*' && !item.name.endsWith('.*'));
    if (explicit) {
      const [owner, member] = explicit.name.split('.');
      if (member) return single(classesIn(explicit.module, owner), `${owner}.${member}`);
      return kotlin ? sole(functionsIn(explicit.module, explicit.name)) : null;
    }
    const own = kotlin ? functionsIn(file.package ?? '', name) : [];
    if (own.length) return sole(own);
    const onDemand = imports.flatMap(item => {
      if (item.name === '*') return kotlin ? functionsIn(item.module, name) : [];
      if (!item.name.endsWith('.*')) return [];
      const owner = item.name.slice(0, -2);
      return [single(classesIn(item.module, owner), `${owner}.${name}`)].filter(Boolean);
    });
    return sole(onDemand);
  };

  // C and C++ join a call to a definition in another file through the linker, which finds the one definition of the name with
  // external linkage. A `static` function or one in an unnamed namespace is not visible to it. Two definitions of a name link
  // nothing: the program either does not link or picks one by build configuration, which the tree does not show.
  const linkage = new Map();
  for (const file of files) {
    if (!NATIVE.has(file.language)) continue;
    for (const method of file.methods) {
      if (method.internal) continue;
      if (!linkage.has(method.qualified_name)) linkage.set(method.qualified_name, []);
      linkage.get(method.qualified_name).push(method.id);
    }
  }
  /**
   * C++ looks a name up from the innermost scope of the caller outward and stops at the first scope that declares it, so a call
   * to `f` from `shop::Cart::total` means `shop::Cart::f`, `shop::f` or `::f`, whichever is nearest. In C there is one scope.
   */
  const linked = (from, parts, file = null, constructors = true) => {
    const scopes = (nodes.get(from)?.qualified_name ?? '').split('.').slice(0, -1);
    // `using namespace ledger;` makes ledger's names visible here as though declared in the file's own scope.
    const imports = file?.imports ?? [];
    const used = imports.filter(item => item.name === USING_NAMESPACE).map(item => item.module.split('::'));
    // `using ledger::Money;` makes Money, and so `Money::zero`, name ledger::Money.
    for (const item of imports.filter(item => item.name === USING_NAME)) {
      const path = item.module.split('::');
      if (path.length > 1 && path.at(-1) === parts[0]) used.push(path.slice(0, -1));
    }
    // A class named alone is a call to its constructor: `Money(5, usd)` runs Money::Money.
    for (const shape of constructors ? [parts, [...parts, parts.at(-1)]] : [parts]) {
      for (let depth = scopes.length; depth >= 0; depth -= 1) {
        const ids = linkage.get([...scopes.slice(0, depth), ...shape].join('.'));
        if (ids) return ids.length === 1 ? ids[0] : null;
      }
      for (const namespace of used) {
        const ids = linkage.get([...namespace, ...shape].join('.'));
        if (ids) return ids.length === 1 ? ids[0] : null;
      }
    }
    return null;
  };

  const resolve = (file, name, from, depth = 0, via = null) => {
    const parts = name.split(/::|\./), head = parts[0], tail = parts.at(-1);
    // `a.f` in C or C++ is a member of an object whose type the tree does not give; only `a::f` names a definition.
    const native = NATIVE.has(file.language) && !name.includes('.');
    if (parts.length === 1) {
      return viaImport(file, parts) ?? unqualified(file, name, from)
        ?? (file.language === 'python' && depth <= 3 ? viaBinding(file, name, '__call__', from, depth) : null)
        ?? (file.language === 'go' ? sameDirectory(file, name) : null)
        ?? (JVM.has(file.language) ? jvmUnqualified(file, name) ?? jvmConstructor(file, name) : null)
        ?? (file.language === 'kotlin' ? jvmExtension(file, name) : null)
        ?? (native ? linked(from, parts, file) : null);
    }
    // `Color::Red.code()` in Rust, `Status.PAID.isFinal()` or `Money.ZERO.plus()` elsewhere: a method of the enum a variant belongs
    // to, or the type a constant is of.
    const variant = file.language === 'rust' ? /^(?:.*::)?([A-Z]\w*)::[A-Z]\w*\.(\w+)$/.exec(name) : /^(?:.*\.)?([A-Z]\w*)\.[A-Z][A-Z\d_]*\.(\w+)$/.exec(name);
    if (variant) {
      const found = memberOf(file, { name: variant[1] }, variant[2]);
      if (found) return found;
    }
    // `Thing::new().get()`: a method of whatever the receiver's call returns or its construction makes.
    if (head === '$receiver' && via && depth <= 3) {
      const kind = classOf(file, via, from, depth + 1);
      const found = kind && memberOf(file, kind, tail);
      if (found) return found;
    }
    // `self.app(...)` where self.app holds an instance: Python runs its __call__.
    if (RECEIVERS.has(head) && parts.length === 2) return ownClass(file, tail, from) ?? (file.language === 'python' && depth <= 3 ? viaBinding(file, `this.${tail}`, '__call__', from, depth) : null);
    // `ledger.post()` or `this.store.save()`: a method of whatever the variable or field holds, when the source says what that is.
    if (parts.length === 2 || (parts.length === 3 && RECEIVERS.has(head))) {
      const held = depth > 3 ? null : viaBinding(file, parts.length === 3 ? `this.${parts[1]}` : head, tail, from, depth);
      if (held) return held;
    }
    if (RECEIVERS.has(head)) return null;
    const imported = viaImport(file, parts) ?? exact(file.path, parts.join('.'));
    if (imported) return imported;
    // `serde_json::to_string(...)` or `crate::de::from_str(...)`: the longest leading path that is a module, then the name in it.
    if (file.language === 'rust' && name.includes('::')) {
      for (let length = parts.length - 1; length >= 1; length--) {
        const module = resolveIn(file.path, parts.slice(0, length).join('::'), 'rust', paths);
        const found = module ? exported(module, parts.slice(length).join('.'), 'rust') : null;
        if (found) return found;
      }
    }
    // A class the file can see decides the call alone: its method, or nothing.
    if (JVM.has(file.language)) {
      const member = jvmQualified(file, parts);
      if (member !== undefined && member !== null) return member;
      if (file.language === 'kotlin' && parts.length === 2) {
        const extension = jvmExtension(file, tail);
        if (extension) return extension;
      }
      if (member !== undefined) return member;
    }
    // `obj.f` on an object whose type the tree does not give links nothing: which f it is depends on what obj holds.
    return native ? linked(from, parts, file) : null;
  };

  /** Every method by its qualified name across the repository, for a class found by name alone. */
  /**
   * The binding of a name the caller can see: its own, then one in a function around it, then for `this.x` one its class makes in
   * another method, then the module's. A binding in some other function of the file is that function's, and linking through it
   * gave one test the type another test's local had.
   */
  const bindingFor = (file, name, from) => {
    const all = (file.binds ?? []).filter(item => item.name === name);
    if (!all.length) return null;
    const caller = nodes.get(from)?.qualified_name ?? '';
    const scope = id => nodes.get(id)?.qualified_name ?? '';
    const classOfCaller = caller.split('.').slice(0, -1).join('.');
    return all.find(item => item.from === from)
      ?? all.find(item => item.from && caller.startsWith(`${scope(item.from)}.`))
      ?? (name.startsWith('this.') ? all.find(item => item.from && classOfCaller && scope(item.from).split('.').slice(0, -1).join('.') === classOfCaller) : null)
      ?? all.find(item => !item.from || scope(item.from) === '<top-level>')
      ?? null;
  };
  /**
   * `self.clock` a base class's setUp assigns, or a pytest fixture a test takes as an argument: the binding of a name the caller's
   * own file does not make, found where the language puts it.
   */
  const bindingElsewhere = (file, name, from, depth = 0) => {
    const caller = (nodes.get(from)?.qualified_name ?? '').split('.');
    if (name.startsWith('this.') && caller.length > 1 && depth < 4) {
      const at = classFile(file, { name: caller.at(-2), path: file.path });
      for (const base of at?.bases?.[caller.at(-2)] ?? []) {
        const baseFile = classFile(at, { name: base.split(/::|\./).at(-1) });
        const held = baseFile && (baseFile.binds ?? []).find(item => item.name === name && (nodes.get(item.from)?.qualified_name ?? '').split('.').at(-2) === base.split(/::|\./).at(-1));
        if (held) return { held, file: baseFile };
      }
    }
    if (file.language === 'python' && !name.includes('.')) {
      // A pytest fixture: a function of that name in the test's own file, or in a conftest.py beside it or above it.
      const dirs = []; for (let dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') { dirs.push(dir); if (!dir) break; }
      for (const path of [file.path, ...dirs.map(dir => (dir ? `${dir}/conftest.py` : 'conftest.py'))]) {
        if (path !== file.path && !byPath.has(path)) continue;
        if (defined(path, name)) return { held: { call: name }, file: byPath.get(path).file, from: defined(path, name) };
      }
    }
    return null;
  };
  const CONSTRUCTOR_NAMES = new Set(['__init__', 'constructor', 'new']);
  /**
   * The class a value is an instance of: the type it was declared or constructed with, or for a call, the class of what the call
   * resolves to: a constructor's class, what a factory returns, or a static factory's own class (`Ledger::new`, `Ledger.of`).
   */
  const classOf = (file, value, from, depth = 0) => {
    if (!value || depth > 3) return null;
    // `return this`: the class of the method saying it.
    if (value.type === '$self') {
      const owner = (nodes.get(from)?.qualified_name ?? '').split('.');
      return owner.length > 1 ? { name: owner.at(-2), full: owner.slice(0, -1).join('.'), path: nodes.get(from).path, from } : null;
    }
    // A type is written in a file, and names the class that file sees by that name.
    if (value.type) return { name: value.type.split(/::|\./).at(-1), full: value.type.replaceAll('::', '.'), from, path: file.path };
    // Another local's value: `let t = Thing::new(); t` hands on what t holds.
    if (value.local) {
      const held = bindingFor(file, value.local, from);
      return held && held !== value ? classOf(file, held, from, depth + 1) : null;
    }
    if (!value.call) return null;
    // `x.debit(...)` on what another value holds: the member of that value's class, then whatever it returns. A chain is as long
    // as the source wrote it, so walking down it costs no depth: a builder's `.debit().credit().credit().build()` is one value.
    const onKind = value.on ? classOf(file, value.on, from, depth) : null;
    const target = value.on ? (onKind && memberOf(file, onKind, value.call.split('.').at(-1))) : resolve(file, value.call, from, depth + 1);
    const parts = value.call.split(/::|\./);
    if (!target) return /^[A-Z]/.test(parts.at(-2) ?? '') ? { name: parts.at(-2), path: file.path, from } : /^[A-Z]/.test(parts[0]) && parts.length === 1 ? { name: parts[0], path: file.path, from } : null;
    const node = nodes.get(target), owner = node.qualified_name.split('.');
    if (owner.length > 1 && (CONSTRUCTOR_NAMES.has(owner.at(-1)) || owner.at(-1) === owner.at(-2))) return { name: owner.at(-2), full: owner.slice(0, -1).join('.'), path: node.path, from };
    const returned = node.returns && classOf(byPath.get(node.path).file, node.returns, target, depth + 1);
    if (returned) return returned;
    return owner.length > 1 && /^[A-Z]/.test(owner.at(-2)) ? { name: owner.at(-2), full: owner.slice(0, -1).join('.'), path: node.path, from } : null;
  };
  /** Where a class is defined: the file that defines a method of it, by the same lookup a member uses, or its bases' record. */
  const classFile = (file, kind) => {
    if (kind.path && byPath.get(kind.path)?.file.bases?.[kind.name]) return byPath.get(kind.path).file;
    if (file.bases?.[kind.name]) return file;
    const imported = (file.imports ?? []).find(item => item.alias === kind.name && !item.reexport);
    const target = imported && resolveIn(file.path, imported.module, file.language, paths);
    if (target && byPath.get(target)?.file.bases?.[imported.name === 'default' ? byPath.get(target).file.default_export : imported.name]) return byPath.get(target).file;
    // Java and Kotlin find the class by its package or an import, wherever its file is.
    const jvmFiles = JVM.has(file.language) ? (classFiles(file, kind.name) ?? []).map(path => byPath.get(path)?.file).filter(item => item?.bases?.[kind.name]) : [];
    return jvmFiles.length === 1 ? jvmFiles[0] : null;
  };
  /** A member a class inherits: looked up in each base it names, by that base's own lookup, a few generations up. */
  const inherited = (file, kind, member, depth) => {
    const at = classFile(file, kind);
    for (const base of at?.bases?.[kind.name] ?? []) {
      // A base is written in the class's own file, `class TestType(click.ParamType)`, and named from there.
      const found = memberOf(at, { name: base.split(/::|\./).at(-1), full: base.replaceAll('::', '.'), path: at.path }, member, depth + 1);
      if (found) return found;
    }
    return null;
  };
  /** A method of a class found by name: where it was constructed, this file, an import, its Java package, or the one class so named. */
  /**
   * A member of a class, looked up as the language looks the class's name up from the file it is written in: a type in a
   * signature names the class its own file can see, wherever the value is used. Then the caller's file, for a class the value's
   * source did not place.
   */
  const memberOf = (file, kind, member, depth = 0) => {
    if (depth > 4) return null;
    const home = (kind.path && byPath.get(kind.path)?.file) || file;
    for (const at of home === file ? [file] : [home, file]) {
      const found = memberFrom(at, kind, member);
      if (found) return found;
    }
    return inherited(home, kind, member, depth);
  };
  const memberFrom = (file, kind, member) => {
    const qualified = `${kind.name}.${member}`, full = kind.full && kind.full !== kind.name ? `${kind.full}.${member}` : null;
    const found = exact(file.path, qualified) ?? (full && exact(file.path, full));
    if (found) return found;
    // `Builder` written inside `class Entry` names `Entry.Builder`: a name is looked up in the classes around where it is written
    // before the file's own top level.
    const writer = nodes.get(kind.from);
    if (writer?.path === file.path) {
      const scopes = writer.qualified_name.split('.').slice(0, -1);
      for (let depth = scopes.length; depth > 0; depth -= 1) {
        const nested = exact(file.path, [...scopes.slice(0, depth), full ?? qualified].join('.'));
        if (nested) return nested;
      }
    }
    const imported = (file.imports ?? []).find(item => item.alias === kind.name && !item.reexport);
    const target = imported && resolveIn(file.path, imported.module, file.language, paths);
    if (target) {
      const name = imported.name === 'default' ? byPath.get(target)?.file.default_export : imported.name === '*' ? kind.name : imported.name;
      const through = name && exported(target, `${name}.${member}`, file.language);
      if (through) return through;
    }
    // `click.Context` or `money::Money`, written through a module the file imports: the class the import's module defines.
    if (full) {
      const through = viaImport(file, [...kind.full.split('.'), member]);
      if (through) return through;
    }
    // `use super::*;` and `from shop.money import *` bring every name a module has into this one.
    for (const glob of (file.imports ?? []).filter(item => item.name === '*' && (!item.alias || item.alias === '*') && !item.reexport)) {
      const module = resolveIn(file.path, glob.module, file.language, paths);
      const through = module && exported(module, qualified, file.language);
      if (through) return through;
    }
    // `crate::money::Money` written whole names the module it is in.
    if (file.language === 'rust' && full) {
      const module = resolveIn(file.path, kind.full.split('.').slice(0, -1).join('::'), 'rust', paths);
      const through = module && exact(module, qualified);
      if (through) return through;
    }
    if (JVM.has(file.language)) {
      // A class nested in another, `JournalEntry.Builder`, is found through the outer one, by the outer one's package or import.
      const outer = full ? kind.full.split('.')[0] : kind.name;
      const files = classFiles(file, outer);
      const member$ = files && single(files, full ?? qualified);
      if (member$) return member$;
    }
    if (file.language === 'kotlin') {
      const extension = jvmExtension(file, member, kind.name);
      if (extension) return extension;
    }
    // A C++ class in a namespace, `shop::Cart` or `Cart` under `using namespace shop`, is found as the linker finds it, from the
    // scope the value was declared in.
    if (NATIVE.has(file.language)) return linked(kind.from ?? null, [...(kind.full ?? kind.name).split('.'), member], file, false);
    return null;
  };
  const viaBinding = (file, name, member, from, depth = 0) => {
    const binding = bindingFor(file, name, from);
    const elsewhere = binding ? null : bindingElsewhere(file, name, from);
    const kind = binding ? classOf(file, binding, from, depth) : elsewhere && classOf(elsewhere.file, elsewhere.held, elsewhere.from ?? from, depth);
    return kind ? memberOf(file, kind, member) : null;
  };

  const callees = new Map(), callers = new Map(), sites = new Map(), dynamic = new Set(), external = new Map();
  const link = (map, from, to) => { if (!map.has(from)) map.set(from, new Set()); map.get(from).add(to); };
  for (const file of files) {
    for (const call of file.calls) {
      const to = resolve(file, call.name, call.from, 0, call.via ?? null);
      if (!to) {
        // A member of a receiver the tree cannot name says nothing about what leaves the repository: `expect(x).not.toThrow()`.
        if (call.name.startsWith('$receiver.')) continue;
        // What a method calls outside the repository: a library, the runtime, the operating system.
        if (!external.has(call.from)) external.set(call.from, new Map());
        external.get(call.from).set(`${call.name}:${call.line}`, { name: call.name, line: call.line });
        continue;
      }
      if (to === call.from) continue;
      link(callees, call.from, to);
      link(callers, to, call.from);
      const key = `${call.from}->${to}`;
      if (!sites.has(key)) sites.set(key, call.line);
    }
  }
  // Functions passed as values: the dispatcher that eventually calls them has no name for them, so the edge comes from the handover.
  // A name handed on resolves the way a call to it would, or to nothing. Most names passed as arguments are variables, and a
  // variable called `total` is not the one method called total somewhere else in the repository, in whatever language.
  for (const file of files) {
    for (const value of file.values ?? []) {
      const to = resolve(file, value.name, value.from);
      if (!to || to === value.from || !nodes.has(to)) continue;
      if (callees.get(value.from)?.has(to)) continue;
      link(callees, value.from, to);
      link(callers, to, value.from);
      dynamic.add(`${value.from}->${to}`);
      if (!sites.has(`${value.from}->${to}`)) sites.set(`${value.from}->${to}`, value.line);
    }
  }

  const readsBy = new Map();
  for (const file of files) for (const read of file.reads ?? []) readsBy.set(read.from, [...(readsBy.get(read.from) ?? []), { name: read.name, line: read.line }]);

  const methodsOf = path => byPath.get(path)?.file.methods.map(method => method.id) ?? [];
  /** Every method of a class, in the files the class name resolves to from this file by the file's own language. */
  const classMethods = (file, name) => {
    let targets, declared = name;
    if (JVM.has(file.language)) targets = classFiles(file, name) ?? [];
    else if (NATIVE.has(file.language)) targets = files.filter(item => NATIVE.has(item.language)).map(item => item.path);
    else {
      const imported = file.imports.find(item => item.alias === name);
      targets = imported ? [resolveIn(file.path, imported.module, file.language, paths)].filter(Boolean) : [file.path];
      if (imported && imported.name !== '*') declared = imported.name;
    }
    return targets.flatMap(path => byPath.get(path).file.methods.filter(method => method.qualified_name.startsWith(`${declared}.`)).map(method => method.id));
  };
  /**
   * A Python patch target: the longest prefix of the path that is a module, the way mock imports it, and then the name bound in
   * that module, which is a function, a class, or something the module imported. Nothing left over means the whole module.
   */
  const pythonPath = (file, path) => {
    const found = pythonModule(file, path.split('.'), 0);
    if (!found) return [];
    const { target, rest } = found;
    if (!rest.length) return methodsOf(target);
    const members = rest.length === 1 ? byPath.get(target).file.methods.filter(method => method.qualified_name.startsWith(`${rest[0]}.`)).map(method => method.id) : [];
    return [...new Set([inModule(target, rest), ...members].filter(Boolean))];
  };
  const cutBy = (file, target, from) => {
    if (target.kind === 'module') {
      const path = resolveIn(file.path, target.module, file.language, paths);
      return path ? methodsOf(path) : [];
    }
    if (target.kind === 'path') return pythonPath(file, target.path);
    if (target.kind === 'member') return [resolve(file, `${target.object}.${target.name}`, from)].filter(Boolean);
    if (target.kind === 'class') return classMethods(file, target.name);
    return [];
  };

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
    /** The members a method reads without calling them, `process.env.KEY` or `os.environ`, each with its line. */
    reads: id => readsBy.get(id) ?? [],
    /** The calls a method makes that resolve to nothing in the repository, each with its line. */
    external: id => [...(external.get(id)?.values() ?? [])],
    /**
     * The methods a test's mocks replace: its own mocks and the file's. A target resolves by the rules a call does, so a mock
     * of something outside the repository cuts nothing.
     */
    mocks: id => {
      const node = nodes.get(id);
      const file = node && byPath.get(node.path)?.file;
      if (!file) return [];
      const cut = new Set();
      for (const mock of file.mocks ?? []) {
        if (mock.owner !== id && mock.owner !== 'file') continue;
        for (const target of cutBy(file, mock.target, id)) if (nodes.has(target)) cut.add(target);
      }
      return [...cut];
    },
  };
}
