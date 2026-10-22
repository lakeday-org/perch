/**
 * What a scan narrowed by --since or --paths parses: the languages its files are written in, whole, and any other language whose
 * code reaches theirs. A method is shown with its callers, its callees and what those call, so the graph has to give each of them
 * the neighbours a parse of the whole repository would.
 *
 * Inside one language, less than all of it is not enough. The files that name a changed method hold its callers, and what they
 * import resolves its callees, but a callee reaches further than anything imports: Sentry's `metrics.incr` calls every subclass of
 * `MetricsBackend`, in files nothing imports, and `serialize` calls whatever serializer any caller anywhere passes it. Parsing the
 * files that name a changed method and everything they import read a third of Sentry and still showed some callee different
 * neighbours in three of its first four benchmark pull requests. Which code is test code is decided by its directory and by who
 * imports it, which following imports forward never reaches either.
 *
 * Between languages very little crosses, and each crossing is looked for here: an import that resolves to a file in another
 * language, a directory where two languages keep test code, and a class whose base has the name of a class in another language,
 * which the graph links as an override.
 */
import { dirname } from 'node:path';
import { git } from './git.js';
import { resolveModule } from './graph.js';
import { GROUPED } from './test-scope.js';

/**
 * Languages that find one another's code by name, so one cannot be parsed without the others: JavaScript and TypeScript import
 * each other, Java, Kotlin, Scala, C# and PHP share one index of packages in the graph, and C and C++ link by name.
 */
const FAMILY = { typescript: 'javascript', tsx: 'javascript', kotlin: 'java', scala: 'java', c_sharp: 'java', php: 'java', cpp: 'c' };
export const familyOf = language => FAMILY[language] ?? language;

/**
 * `git grep` over `paths`, and only those of them in what it found. Thousands are searched by their extensions instead, since a
 * pathspec per path costs git a comparison of each against every file of the tree, which on Grafana took longer than the
 * search. One that finds nothing exits 1 and says nothing; anything else on stderr is git failing.
 */
async function grep(root, revision, args, paths) {
  // A few hundred named is quicker than reading every file with their extensions, vendored bundles included.
  const pathspecs = paths.length <= 500 ? paths.map(path => `:(literal)${path}`) : [...new Set(paths.map(path => `*.${path.split('.').at(-1)}`))];
  let text;
  try { text = await git(['grep', '-z', '-I', ...args, revision, '--', ...pathspecs], root); }
  catch (error) { if (error.code !== 1 || error.stderr.trim()) throw error; text = error.stdout; }
  return { text, wanted: new Set(paths) };
}
/** The files `git grep -l -z` named, among those wanted. */
const listed = ({ text, wanted }, revision) => text.split('\0').map(entry => entry.slice(revision.length + 1)).filter(path => wanted.has(path));
/** What `git grep -o -z` matched, one line a match, each with the file it is in, among those wanted. */
const matched = ({ text, wanted }, revision) => text.split('\n').flatMap(line => {
  const at = line.indexOf('\0'), path = line.slice(revision.length + 1, at);
  return at >= 0 && wanted.has(path) ? [{ path, match: line.slice(at + 1) }] : [];
});

/**
 * Where one language's imports can lead into another's files. JavaScript and Go resolve a relative path as written, or with any
 * of the extensions graph.js tries, which include .py, .rs and .go; C and C++ include any file by name, and Bash, Solidity and
 * PHP load one by its path. The other languages that resolve the way JavaScript does import names, never relative paths, and
 * every remaining resolver only finds files in its own language. Each candidate is a string in the file that could be one of
 * those specifiers, so this finds more than the parser records, never less. An escaped quote ends a candidate early, which no
 * import of a file in the tree has needed.
 */
const SPECIFIERS = [
  { languages: new Set(['javascript', 'typescript', 'tsx', 'go']), implied: true, patterns: ["'\\.[^']*'", '"\\.[^"]*"', '`\\.[^`]*`'] },
  { languages: new Set(['c', 'cpp']), patterns: ['#[[:space:]]*include[[:space:]]*("[^"]*"|<[^>]*>)'] },
  { languages: new Set(['bash']), patterns: [`(^|[;&|({[:space:]])(source|\\.|load)[[:space:]]+("[^"]*"|'[^']*'|[^[:space:];&|)]+)`] },
  { languages: new Set(['solidity', 'php']), patterns: ["'[^']*'", '"[^"]*"'] },
];
/** The extensions graph.js tries after a relative specifier written without one, so a bare path reaches a file of each. */
const IMPLIED = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go']);
/** The specifier inside one match: the quoted text, the included name, or the sourced word. */
const specifierOf = match => {
  const include = /^#\s*include\s*["<](.*)[">]$/.exec(match);
  if (include) return include[1];
  const sourced = /(?:source|\.|load)\s+(.+)$/.exec(match);
  const value = sourced && !/^["'`]/.test(match) ? sourced[1] : match;
  return /^(["'`]).*\1$/s.test(value) ? value.slice(1, -1) : value;
};

/**
 * What imports files of the families `into`, by the strings that could be import specifiers in files no parse has read yet: a
 * [from, to] pair of paths for each that resolves to a source file. `known` is every source path of the tree, which is what the
 * graph's resolution is asked against. Unless a bare relative path reaches them, a specifier names a file with its extension, so
 * only files holding one of those extensions are read for them.
 */
export async function importsBetween({ root, revision, sources, known, into, crates = [], skip = () => false }) {
  const byPath = new Map(sources.map(file => [file.path, file]));
  const extensions = [...new Set(sources.filter(file => into.has(familyOf(file.language))).map(file => file.path.split('.').at(-1)))];
  const pairs = [];
  for (const { languages, patterns, implied } of SPECIFIERS) {
    let files = sources.filter(file => languages.has(file.language) && !skip(file));
    if (!files.length || !extensions.length) continue;
    if (!implied || !extensions.some(extension => IMPLIED.has(extension))) {
      const named = new Set(listed(await grep(root, revision, ['-l', '-F', ...extensions.flatMap(extension => ['-e', `.${extension}`])], files.map(file => file.path)), revision));
      files = files.filter(file => named.has(file.path));
      if (!files.length) continue;
    }
    for (const { path, match } of matched(await grep(root, revision, ['-o', '-E', ...patterns.flatMap(pattern => ['-e', pattern])], files.map(file => file.path)), revision)) {
      const file = byPath.get(path);
      const target = resolveModule(file.path, specifierOf(match), file.language, known, crates);
      if (byPath.has(target) && target !== file.path && into.has(familyOf(byPath.get(target).language))) pairs.push([file.path, target]);
    }
  }
  return pairs;
}

/** The languages whose importers a specifier names in a string, so importsBetween finds every one of them. */
export const SPECIFIED = new Set(['javascript', 'typescript', 'tsx', 'c', 'cpp']);

/** The families a parsed file's imports resolve into, by the same resolution the graph does. */
export function importedFamilies(records, { byPath, known, crates = [] }) {
  const found = new Set();
  for (const record of records) {
    for (const item of record.imports ?? []) {
      const target = byPath.get(resolveModule(record.path, item.module, record.language, known, crates));
      if (target) found.add(familyOf(target.language));
    }
  }
  return found;
}

const dirOf = path => (path.includes('/') ? dirname(path) : '');
const ancestors = dir => { const dirs = []; for (let at = dir; at; at = dirOf(at)) dirs.push(at); return dirs; };

/**
 * For a path, the JavaScript, Python, C and C++ files of families not parsed in its directory and in each directory above it but
 * the root: what markTestSupport reads, beside the file itself, to call that directory test code. It calls a directory test code
 * when every such file in it is, whatever language each is in, and the directories under one take that from it.
 */
export function heldBeside(sources, parsedFamily) {
  const held = new Map();
  for (const file of sources) {
    if (!GROUPED.has(file.language) || parsedFamily(familyOf(file.language))) continue;
    const dir = dirOf(file.path);
    if (!held.has(dir)) held.set(dir, []);
    held.get(dir).push(file);
  }
  return path => { const dir = dirOf(path); return [...new Set([dir, ...ancestors(dir)])].flatMap(at => held.get(at) ?? []); };
}

/**
 * The files of families not parsed that a parsed file's verdict on being test code can turn on, by `heldBeside`. A file with no
 * methods and no imports turns on nothing anyone can see: it is no node, and no other file's verdict reads it.
 */
export function testNeighbours(records, beside) {
  const found = new Map();
  for (const record of records) {
    if (!GROUPED.has(record.language) || (!record.methods.length && !(record.imports ?? []).length)) continue;
    for (const file of beside(record.path)) found.set(file.path, file);
  }
  return [...found.values()];
}

/** Each class that owns a method, with those methods' names, among the callees of `ids` and of what they call. */
export function ownersCalled(graph, ids) {
  const owners = new Map();
  const callers = [...new Set([...ids, ...ids.flatMap(id => graph.callees(id))])];
  for (const id of new Set(callers.flatMap(id => graph.callees(id)))) {
    const parts = (graph.nodes.get(id)?.qualified_name ?? '').split('.');
    if (parts.length < 2) continue;
    if (!owners.has(parts.at(-2))) owners.set(parts.at(-2), new Set());
    owners.get(parts.at(-2)).add(parts.at(-1));
  }
  return owners;
}

/** Which of `paths` hold one of `names` as a whole word. */
export async function mentioning({ root, revision, names, paths }) {
  if (!names.length || !paths.length) return new Set();
  const holding = new Set();
  // A pattern per argument, so the names are batched as the paths are.
  for (let at = 0; at < names.length; at += 1000) {
    for (const path of listed(await grep(root, revision, ['-l', '-w', '-F', ...names.slice(at, at + 1000).flatMap(name => ['-e', name])], paths), revision)) holding.add(path);
  }
  return holding;
}

/**
 * The words a file in a language has to hold to declare a class with a base, after basesOf in treesitter/references.ts: a
 * JavaScript class's bases follow `extends` or `implements`, a Python or Ruby class's follow `class`, a Rust trait is
 * implemented with `impl`, C++ bases belong to a `class` or a `struct`, and Solidity's to a `contract`. Go, Lua, Zig and Bash
 * declare none. The rest can name a base with no keyword of its own, as Java's `new Adapter() { ... }` does, and are read alike.
 * Without `words`, whether the language can declare one at all.
 */
const HERITAGE = { javascript: ['extends', 'implements'], typescript: ['extends', 'implements'], tsx: ['extends', 'implements'], python: ['class'], ruby: ['class'],
  rust: ['impl'], c: ['class', 'struct'], cpp: ['class', 'struct'], solidity: ['contract'], go: [], lua: [], zig: [], bash: [] };
export const mayExtend = (language, words) => !HERITAGE[language] || HERITAGE[language].some(word => !words || words.has(word));

/**
 * The words a JavaScript or TypeScript class could name a base with: those after each `extends` or `implements`, up to the `{`
 * that opens what follows outside any brackets, parentheses or type arguments. A base is named nowhere else, so a file whose
 * text names a class only elsewhere extends no class of that name.
 */
export function heritageWords(text) {
  const words = new Set();
  for (const keyword of text.matchAll(/\b(?:extends|implements)\b/g)) {
    let depth = 0, at = keyword.index + keyword[0].length;
    for (; at < text.length; at++) {
      const char = text[at];
      if (char === '(' || char === '[' || char === '<') depth++;
      else if ((char === ')' || char === ']' || char === '>') && depth) depth--;
      else if (char === '{' && !depth) break;
    }
    for (const word of text.slice(keyword.index + keyword[0].length, at).match(/[A-Za-z_$][\w$]*/g) ?? []) words.add(word);
  }
  return words;
}

/**
 * Whether a parsed file declares a class extending one of `owners` with a method of that owner's name, which the graph links as
 * an override whatever language either is in, as it does `subclassesOf` in graph.js.
 */
export function overrides(record, owners) {
  for (const [name, bases] of Object.entries(record.bases ?? {})) {
    for (const base of bases) {
      const members = owners.get(String(base).split(/::|\./).at(-1));
      if (!members) continue;
      for (const method of record.methods) {
        const member = method.qualified_name.split('.').at(-1);
        if (members.has(member) && (method.qualified_name === `${name}.${member}` || method.qualified_name.endsWith(`.${name}.${member}`))) return true;
      }
    }
  }
  return false;
}
