/** `perch scan`: analyze the tracked source files at a revision, all of them or what a narrowed run needs, and rank them by risk. No model. */
import { availableParallelism } from 'node:os';
import { blobsAt, git, listTree, readBlobs } from './git.js';
import { analyzeFiles, languageOf, METHOD_HASH, sourceFile } from './analysis.js';
import { fileLanguageOf, headerLanguage } from './languages.js';
import { attributeRules, createFileSelector, declaredGenerated, EXCLUSIONS_PROFILE } from './exclusions.js';
import { PARSE_VERSION } from './treesitter/types.ts';
import { identity, openStore, readScan, writable, writeScan } from './store.js';
import { GROUPED, markTestSupport } from './test-scope.js';
import { familyOf, heldBeside, heritageWords, importedFamilies, importsBetween, mayExtend, mentioning, overrides, ownersCalled, SPECIFIED, testNeighbours } from './narrow.js';
import { resolveModule } from './graph.js';

/**
 * A parse narrowed to what `around` needs is not the parse of the whole tree, so it is never reused as one, nor one as it: `around`
 * is part of what it is, and a parse without it is keyed exactly as it always was.
 */
export function scanIdentity({ revision, paths, includeFiles = false, filePaths = [], around = [] }) {
  const parts = ['scan', PARSE_VERSION, EXCLUSIONS_PROFILE, METHOD_HASH, revision, [...paths].sort()];
  return identity(...parts, ...(includeFiles ? ['include-files', [...filePaths].sort()] : []), ...(around.length ? ['around', [...around].sort()] : []));
}

const selected = paths => file => !paths.length || paths.some(path => file.path === path || file.path.startsWith(path.replace(/\/$/, '') + '/'));

/** A crate's name and lib.rs from its Cargo.toml: `[lib] name` or `[package] name`, a hyphen in either written as an underscore in code. */
export function crateOf(path, text) {
  const section = name => text.match(new RegExp(`^\\[${name}\\]([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm'))?.[1] ?? '';
  const field = (body, key) => body.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1] ?? null;
  const name = field(section('lib'), 'name') ?? field(section('package'), 'name');
  if (!name) return null;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const lib = field(section('lib'), 'path');
  return { name: name.replaceAll('-', '_'), root: dir, lib: lib ? (dir ? `${dir}/${lib}` : lib) : `${dir ? `${dir}/` : ''}src/lib.rs` };
}

/** A Go module's path and the directory it is in, from its go.mod: `module example.com/shop` in services/go.mod. */
export function goModuleOf(path, text) {
  const name = text.match(/^module\s+"?([^\s"]+)"?/m)?.[1] ?? null;
  return name ? { path: name, dir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' } : null;
}

/**
 * Each Rust crate's name and where it is: `serde_json::from_str` in a test names the crate by its Cargo.toml, not by a path, so
 * the call graph needs the name to find the crate's lib.rs. Each Go module's path likewise, since `import "example.com/shop/cart"`
 * names a directory of this repository only through the go.mod that declares the prefix.
 */
async function manifestsOf(root, revision, tree, pattern, read) {
  const found = [];
  for (const item of tree.filter(entry => entry.type === 'blob' && pattern.test(entry.path))) {
    // The tree lists it at this revision, so a failure to show it is git failing, not a manifest that is not there.
    const manifest = read(item.path, await git(['show', `${revision}:${item.path}`], root));
    if (manifest) found.push(manifest);
  }
  return found;
}
const cratesOf = (root, revision, tree) => manifestsOf(root, revision, tree, /(^|\/)Cargo\.toml$/, crateOf);
const goModulesOf = (root, revision, tree) => manifestsOf(root, revision, tree, /(^|\/)go\.mod$/, goModuleOf);

/**
 * The source files a parse of `revision` reads, in tree order, each with its language, and the tree they came from. A commit's
 * tree does not change, so a run that asks again, to check what a narrowed parse left out, is answered from the first asking.
 */
const sourcesSeen = new Map();
const sourcesAt = options => {
  const key = JSON.stringify([options.root, options.revision, options.paths ?? [], options.includeFiles ? options.filePaths ?? [] : false]);
  if (!sourcesSeen.has(key)) {
    // A few commits at most: a process serving many runs moves on from each.
    if (sourcesSeen.size >= 4) sourcesSeen.delete(sourcesSeen.keys().next().value);
    sourcesSeen.set(key, listSources(options).catch(error => { sourcesSeen.delete(key); throw error; }));
  }
  return sourcesSeen.get(key);
};
async function listSources({ root, revision, paths = [], includeFiles = false, filePaths = [] }) {
  const tree = await listTree(root, revision);
  const header = headerLanguage(tree.map(item => item.path));
  // The repository's own .gitattributes say what is generated or vendored, before perch's defaults and before any text is read.
  const attributes = await attributeRules(tree, item => git(['show', `${revision}:${item.path}`], root));
  const sources = tree.filter(createFileSelector(tree, attributes)).filter(file => sourceFile(file) || (includeFiles && fileLanguageOf(file.path) && selected(filePaths)(file)))
    .filter(selected(paths)).map(file => ({ ...file, language: languageOf(file.path, header) ?? fileLanguageOf(file.path),
      ...(declaredGenerated(attributes, file.path) === false ? { authored: true } : {}) }));
  return { tree, sources };
}

/** Parses `files`, streaming their blobs from one git process while the analyzer works through them in order. */
async function parseSources(files, { root, analyzer, progress, debug, log }) {
  const blobs = new Map(), waiting = new Map();
  const reading = readBlobs(root, files.map(file => file.sha), (index, text) => { const wake = waiting.get(index); if (wake) { waiting.delete(index); wake(text); } else blobs.set(index, text); });
  reading.catch(error => { log(`blob reading failed: ${error.message}`); });
  const readSource = (file, index) => {
    if (blobs.has(index)) { const text = blobs.get(index); blobs.delete(index); return text; }
    return Promise.race([new Promise(resolve => waiting.set(index, resolve)), reading.then(() => { throw new Error(`Blob for ${file.path} was not delivered`); })]);
  };
  // One thread a core, less the one reading blobs and keeping count.
  const analysis = await analyzeFiles(files, { analyzer, readSource, progress, debug, workers: availableParallelism() - 1 });
  await reading;
  return analysis;
}

/**
 * The parse of what a run narrowed to `around` reads (narrow.js says why it is whole languages): the families of the files it
 * covers, then any family that imports into them or that they import into, until no more do. The records come back in tree
 * order, as a parse of everything would list them.
 *
 * Test code of a family left out that sits in a directory with parsed code is parsed too, with whatever imports it, so
 * markTestSupport judges those directories as it would with everything parsed. Those records are `beside`, for that and nothing
 * else. When what imports them cannot be found from their text, or is itself code whose judgement would need more of its family,
 * the family is parsed instead.
 */
async function parseAround(sources, { around, root, revision, crates, analyzer, progress, debug, log }) {
  const known = new Set(sources.map(file => file.path)), byPath = new Map(sources.map(file => [file.path, file]));
  const order = new Map(sources.map((file, index) => [file.path, index]));
  const families = new Set(sources.filter(selected(around)).map(file => familyOf(file.language)));
  const parsed = new Set(), parts = [];
  // What imports files of each family, read once a family is parsed, from the files of the families not parsed yet: a parsed
  // file's own imports are read off its record below.
  const imports = [], into = new Set();
  let functions = 0, beside = [];
  const parse = async files => {
    for (const file of files) parsed.add(file.path);
    const before = functions;
    const part = await parseSources(files, { root, analyzer, progress: (count, total) => progress(before + count, total), debug, log });
    functions += part.functions;
    return part;
  };
  for (;;) {
    for (let fresh = [...families].filter(family => !into.has(family)); fresh.length; fresh = [...families].filter(family => !into.has(family))) {
      for (const family of fresh) into.add(family);
      if (sources.every(file => families.has(familyOf(file.language)))) break;
      const parsing = new Set(families);
      imports.push(...await importsBetween({ root, revision, sources, known, crates, into: new Set(fresh), skip: file => parsing.has(familyOf(file.language)) }));
      for (const [from] of imports) families.add(familyOf(byPath.get(from).language));
    }
    const batch = sources.filter(file => families.has(familyOf(file.language)) && !parsed.has(file.path));
    if (batch.length) {
      debug(`analyzing ${batch.length} of ${sources.length} source files (${[...families].sort().join(', ')})`);
      const part = await parse(batch);
      parts.push(part);
      const more = [...importedFamilies(part.files, { byPath, known, crates })].filter(family => !families.has(family));
      if (more.length) { for (const family of more) families.add(family); continue; }
    }
    const unjudged = heldBeside(sources, family => families.has(family));
    const neighbours = testNeighbours(parts.flatMap(part => part.files), unjudged);
    if (!neighbours.length) break;
    // Those files, what imports them, and the files in the same directories as each of those, until nothing more imports any:
    // what markTestSupport reads to judge them. The importers of a JavaScript, C or C++ file name it in a string, which finds
    // every one of them and some that only mention it, so each is parsed to see. A Python module's importers are found only by
    // parsing Python, and so is a family whose share of this grows past a quarter of it.
    // markTestSupport counts only JavaScript, Python, C and C++ files as importers, so those are the only ones looked for.
    const toward = new Set([...GROUPED].map(familyOf).filter(family => !families.has(family)));
    const reaching = (await importsBetween({ root, revision, sources, known, crates, into: toward, skip: file => families.has(familyOf(file.language)) }))
      .filter(([from]) => GROUPED.has(byPath.get(from).language));
    const near = new Map(neighbours.map(file => [file.path, file])), read = new Map();
    const size = family => sources.filter(file => familyOf(file.language) === family).length;
    let whole;
    for (;;) {
      const counts = Map.groupBy([...near.values()], file => familyOf(file.language));
      whole = [...near.values()].filter(file => !SPECIFIED.has(file.language)).map(file => familyOf(file.language));
      for (const [family, files] of counts) if (files.length * 4 > size(family)) whole.push(family);
      if (whole.length) break;
      const candidates = [...new Set(reaching.filter(([from, to]) => near.has(to) && !near.has(from)).map(([from]) => from))];
      const unread = [...near.keys(), ...candidates].filter(path => !read.has(path));
      if (unread.length) {
        debug(`analyzing ${unread.length} files beside them to tell their test code apart`);
        const { files } = await parseSources(unread.map(path => byPath.get(path)), { root, analyzer, progress: () => {}, debug, log });
        for (const path of unread) read.set(path, null);
        for (const record of files) read.set(record.path, record);
      }
      const importing = candidates.filter(path => (read.get(path)?.imports ?? []).some(item => near.has(resolveModule(path, item.module, byPath.get(path).language, known, crates))));
      if (!importing.length) break;
      for (const path of importing) for (const file of [byPath.get(path), ...unjudged(path)]) near.set(file.path, file);
    }
    if (whole.length) { debug(`judging test code beside them needs all of ${[...new Set(whole)].join(', ')}`); for (const family of whole) families.add(family); continue; }
    beside = [...near.keys()].map(path => read.get(path)).filter(Boolean);
    break;
  }
  const coverage = { supported: 0, parsed: 0, parse_failures: 0, parser_diagnostics: [] };
  for (const { coverage: part } of parts) {
    for (const [key, value] of Object.entries(part)) if (typeof value === 'number') coverage[key] = (coverage[key] ?? 0) + value;
    coverage.parser_diagnostics.push(...part.parser_diagnostics);
  }
  coverage.parser_diagnostics = coverage.parser_diagnostics.slice(0, 20);
  coverage.unparsed = sources.length - parts.reduce((total, part) => total + part.coverage.supported, 0);
  const candidates = parts.flatMap(part => part.candidates).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { coverage, functions, files: parts.flatMap(part => part.files).sort((a, b) => order.get(a.path) - order.get(b.path)), candidates, beside };
}

/**
 * The parse of a revision. `around`, when given, narrows it to what a run covering those paths needs, which parseAround works out;
 * without it every source file is parsed, as `perch coverage`, `perch check` and a scan of the whole repository need.
 */
export async function analyzeTree({ root, revision, out, analyzer, label = root, github = null, paths = [], around = [], includeFiles = false, filePaths = [], progress = () => {}, log = () => {}, debug = () => {} }) {
  const store = openStore(out);
  const id = scanIdentity({ revision, paths, includeFiles, filePaths, around });
  const dir = store.scanDir(id);
  // A parse is local work the model never sees, and perch issues parses on every call to tell which findings still exist. The
  // same commit and paths parse the same way, so a finished one is the answer.
  const existing = await readScan(dir);
  if (existing?.status === 'complete') {
    debug(`scan ${id} already complete; reusing ${dir}`);
    return existing;
  }
  await store.exclude(root);
  const { tree, sources } = await sourcesAt({ root, revision, paths, includeFiles, filePaths });
  const crates = await cratesOf(root, revision, tree), modules = await goModulesOf(root, revision, tree);
  // A repository with no code still has files a rule can be about: a docs-only repository scans zero methods, not an error.
  debug(`analyzing ${sources.length} source files`);
  const analysis = around.length ? await parseAround(sources, { around, root, revision, crates, analyzer, progress, debug, log })
    : await parseSources(sources, { root, analyzer, progress, debug, log });
  await markTestSupport({ root, paths: tree.filter(item => item.type === 'blob').map(item => item.path), files: [...analysis.files, ...(analysis.beside ?? [])] });
  const scan = { id, status: 'complete', target: label, github, root, revision, paths, ...(around.length ? { around: [...around].sort() } : {}), out: dir, created_at: new Date().toISOString(),
    coverage: { ...analysis.coverage, excluded: tree.filter(item => item.type === 'blob').length - sources.length }, functions: analysis.functions, files: analysis.files, candidates: analysis.candidates,
    crates, modules };
  await writable(store.out, dir);
  await writeScan(dir, scan);
  await store.prune('scans', id).catch(error => log(`Could not remove earlier scans: ${error.message}`));
  return scan;
}

/**
 * Whether a parse narrowed to some languages left out a class the graph links as an override of a callee in view: one declared
 * in another language, extending a class of the same name as the callee's and defining a method of the same name, which
 * `subclassesOf` in graph.js finds whatever language either is written in. Only files naming such a class and such a method are
 * parsed to find out.
 */
export async function overriddenElsewhere({ root, revision, scan, graph, ids, analyzer, debug = () => {}, log = () => {} }) {
  if (!scan.coverage?.unparsed) return false;
  const { sources } = await sourcesAt({ root, revision });
  const parsed = new Set(scan.files.map(file => file.path));
  const left = sources.filter(file => !parsed.has(file.path) && mayExtend(file.language, null));
  const owners = left.length ? ownersCalled(graph, ids) : new Map();
  if (!owners.size) return false;
  const named = await mentioning({ root, revision, names: [...owners.keys()], paths: left.map(file => file.path) });
  const unread = left.filter(file => named.has(file.path));
  if (!unread.length) return false;
  // A name is a word of the file's text, the way git grep -w found the class: a method's name may end in ? ! or =, as Ruby's do.
  const texts = new Map();
  await readBlobs(root, unread.map(file => file.sha), (index, text) => {
    const file = unread[index];
    texts.set(file.path, { words: new Set(text.match(/[A-Za-z_$][\w$]*[?!=]?/g) ?? []), bases: familyOf(file.language) === 'javascript' ? heritageWords(text) : null });
  });
  const holds = (words, word) => words.has(word) || words.has(word.replace(/[?!=]$/, ''));
  const both = unread.filter(file => {
    const { words, bases } = texts.get(file.path);
    return mayExtend(file.language, words) && [...owners].some(([owner, members]) => (bases ?? words).has(owner) && [...members].some(member => holds(words, member)));
  });
  if (!both.length) return false;
  debug(`checking ${both.length} files in other languages for overrides of ${owners.size} classes`);
  const { files } = await parseSources(both, { root, analyzer, progress: () => {}, debug, log });
  return files.some(record => overrides(record, owners));
}

/**
 * What a narrowed parse can say of a method in a file it did not read, for the readings and checks a run carries over from the
 * last: whether method `id` is there at `revision`, and its hash, or null when it is not. A file unchanged since the reading has
 * the methods it had then, so the reading's own hash stands; a changed one is parsed to find out, as a whole parse would have.
 */
export async function unreadMethods({ root, revision, scan, refs, analyzer, debug = () => {}, log = () => {} }) {
  const parsed = new Set(scan.files.map(file => file.path));
  const wanted = refs.filter(ref => ref.path && !parsed.has(ref.path));
  if (!wanted.length) return { has: () => false, hash: () => null };
  const { sources } = await sourcesAt({ root, revision });
  const byPath = new Map(sources.map(file => [file.path, file]));
  const then = await blobsAt(root, [...new Set(wanted.filter(ref => byPath.has(ref.path) && ref.revision && ref.revision !== revision).map(ref => `${ref.revision}:${ref.path}`))]);
  const same = ref => ref.revision === revision || then.get(`${ref.revision}:${ref.path}`) === byPath.get(ref.path)?.sha;
  const changed = [...new Set(wanted.filter(ref => byPath.has(ref.path) && !same(ref)).map(ref => ref.path))].map(path => byPath.get(path));
  if (changed.length) debug(`reading ${changed.length} changed files the last run read and this one did not`);
  const { files } = changed.length ? await parseSources(changed, { root, analyzer, progress: () => {}, debug, log }) : { files: [] };
  const reread = new Set(changed.map(file => file.path)), hashes = new Map(files.flatMap(file => file.methods.map(method => [method.id, method.hash])));
  return {
    has: (ref, id) => byPath.has(ref.path) && (!reread.has(ref.path) || hashes.has(id)),
    hash: (ref, id) => (!byPath.has(ref.path) ? null : reread.has(ref.path) ? hashes.get(id) ?? null : ref.hash ?? null),
  };
}
