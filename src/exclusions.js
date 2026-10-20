/** Tracked dependencies and generated output are excluded regardless of the language or rule reading them. */
export const EXCLUSIONS_PROFILE = 'default-exclusions-v1';

// Tool-specific names apply at any depth. Ambiguous names belong to a project below.
const directories = new Set([
  '.git', '.perch', '.lakeday', 'vendor', 'node_modules', 'dist', 'target', 'build', 'coverage', 'out',
  'third_party', 'third-party', 'thirdparty', '3rdparty', '.cache',
  '.next', '.nuxt', '.output', '.svelte-kit', '.angular', '.parcel-cache', '.turbo', '.vite', '.npm', '.pnpm-store',
  'bower_components', 'jspm_packages', 'web_modules', 'storybook-static', '.docusaurus', '.nyc_output',
  '.venv', 'venv', 'site-packages', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.eggs', 'htmlcov',
  '.gradle', '.bloop', '.metals', '.scala-build', '.cxx', '.externalNativeBuild',
  'CMakeFiles', '_deps', 'bazel-bin', 'bazel-out', 'bazel-testlogs',
  '.build', 'Pods', 'DerivedData', '.zig-cache', 'zig-cache', 'zig-out',
  '.dart_tool', '.pub-cache', '.pub', '.stack-work', 'dist-newstyle', '.cabal-sandbox', '_build', '.elixir_ls',
  'lua_modules', 'blib', '.precomp', '.cpcache', '.godot', '.import',
]);
const subdirectories = new Set([
  '.yarn/cache', '.yarn/unplugged', '.vitepress/cache', '.vitepress/dist',
  'Carthage/Build', 'Carthage/Checkouts', 'renv/library', 'renv/staging', 'packrat/lib', 'packrat/lib-ext',
  '.clj-kondo/.cache', 'Godeps/_workspace',
]);

/** Only directory components are matched; a tracked file called build or src/node_modules.js is still source. */
export function eligibleFile(item) {
  if (item.type !== 'blob' || /\.min\.(?:[cm]?[jt]s|[jt]sx)$/.test(item.path)) return false;
  const parts = item.path.split('/');
  return !parts.slice(0, -1).some((part, index) => directories.has(part) || /^cmake-build-.+/.test(part)
    || subdirectories.has(`${parts[index - 1]}/${part}`));
}

/**
 * Resolve project-owned output once from tracked manifests, keeping bin, lib, packages, and deps elsewhere readable. `attributes`
 * are the repository's own `.gitattributes` lines (attributeRules): a path it marks `linguist-generated` or `linguist-vendored` is
 * excluded, and one it marks either `false` is read even where the defaults would leave it out.
 */
export function createFileSelector(tree, attributes = []) {
  const generated = new Set();
  const add = (root, names) => { for (const name of names) generated.add(root + name); };
  for (const item of tree) {
    if (!eligibleFile(item)) continue;
    const path = item.path, slash = path.lastIndexOf('/'), root = path.slice(0, slash + 1), name = path.slice(slash + 1);
    if (/\.(?:cs|fs|vb)proj$/i.test(name)) add(root, ['bin', 'Bin', 'obj', 'Obj']);
    if (name === 'mix.exs' || name === 'rebar.config') add(root, ['deps']);
    if (/^hardhat\.config\.(?:[cm]?js|[cm]?ts)$/.test(name)) add(root, ['cache', 'artifacts']);
    if (name === 'foundry.toml') add(root, ['cache', 'broadcast']);
    if (/(^|\/)ProjectSettings\/ProjectVersion\.txt$/.test(path))
      add(path.slice(0, -'ProjectSettings/ProjectVersion.txt'.length), ['Library', 'Temp', 'Obj', 'Logs', 'UserSettings', 'Builds']);
    if (name.endsWith('.uproject')) add(root, ['Binaries', 'Intermediate', 'Saved']);
    if (name === 'pyvenv.cfg' && root) generated.add(root.slice(0, -1));
  }
  return item => {
    const declared = declaredGenerated(attributes, item.path);
    if (declared !== undefined) return item.type === 'blob' && !declared;
    if (!eligibleFile(item)) return false;
    const parts = item.path.split('/');
    let parent = '';
    for (const part of parts.slice(0, -1)) {
      parent = parent ? `${parent}/${part}` : part;
      if (generated.has(parent)) return false;
    }
    return true;
  };
}

/**
 * Whether the repository's `.gitattributes` say a path is generated or vendored, as GitHub's Linguist reads them: true when
 * `linguist-generated` or `linguist-vendored` is set, false when one is unset (`-linguist-vendored`) or `false` and neither is set,
 * undefined when no line names either. The last line that matches wins, and a deeper `.gitattributes` comes after its parents.
 */
export function declaredGenerated(attributes, path) {
  const state = {};
  for (const rule of attributes) if (rule.match(path)) Object.assign(state, rule.values);
  const values = ['linguist-generated', 'linguist-vendored'].map(name => state[name]).filter(value => value !== undefined);
  return values.length ? values.some(Boolean) : undefined;
}

/** A `.gitattributes` pattern as a test of a repository path, with gitignore's rules: one without a slash matches a name at any
 * depth below its file, one with a slash is anchored to its file's directory, `**` spans directories and `*` does not. */
function attributePattern(dir, pattern) {
  const anchored = pattern.includes('/');
  const glob = pattern.replace(/^\//, '');
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (c === '[') { const end = glob.indexOf(']', i + 1); if (end > i) { source += glob.slice(i, end + 1).replace(/^\[!/, '[^'); i = end; } else source += '\\['; }
    else source += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  const prefix = dir ? `${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/` : '';
  const test = new RegExp(`^${prefix}${anchored ? '' : '(?:.*/)?'}${source}$`);
  return path => test.test(path);
}

/** Each `.gitattributes` line about `linguist-generated` or `linguist-vendored`, from every such file in the tree, shallowest first. */
export async function attributeRules(tree, read) {
  const files = tree.filter(item => item.type === 'blob' && /(^|\/)\.gitattributes$/.test(item.path))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const rules = [];
  for (const file of files) {
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    for (const line of String(await read(file) ?? '').split('\n')) {
      const [pattern, ...attrs] = line.trim().split(/\s+/);
      if (!pattern || pattern.startsWith('#') || pattern.startsWith('!')) continue;
      const values = {};
      for (const attr of attrs) {
        const [, unset, name, value] = attr.match(/^([-!]?)(linguist-(?:generated|vendored))(?:=(.*))?$/) ?? [];
        if (!name) continue;
        values[name] = unset ? false : value === undefined ? true : !/^(?:false|0)$/i.test(value);
      }
      if (Object.keys(values).length) rules.push({ match: attributePattern(dir, pattern), values });
    }
  }
  return rules;
}

/** Lines near the top of a file that the tools writing it leave, as GitHub's Linguist and Go's convention read them. */
const GENERATED_MARKERS = [
  /^\s*(?:\/\/|#|--|;|\/\*+|\*)\s*Code generated\b.*\bDO NOT EDIT\b/i,
  /^\s*(?:\/\/|#|--|\/\*+|\*)\s*@generated\b/,
  /Generated by the protocol buffer compiler\.\s+DO NOT EDIT!/,
  /GENERATED CODE -- DO NOT EDIT!/,
  /^\s*\/\/ Generated by the gRPC/,
  /Autogenerated by Thrift Compiler/,
  /DO NOT EDIT THIS FILE - it is machine generated/,
  /Generated by Cython/,
];
const MINIFIABLE = /\.(?:[cm]?js|css)$/i;

/**
 * Why a file's text says a tool wrote it, or null. A JavaScript or CSS file is minified when its lines average more than 110
 * characters or it ends by naming its source map; any file is generated when one of its first 40 lines is a generator's
 * marker. GitHub's Linguist decides the same way, so a file GitHub folds away in a diff is one perch does not read.
 */
export function generatedText(path, text) {
  const lines = String(text).split('\n');
  if (MINIFIABLE.test(path)) {
    if (lines.length && lines.reduce((total, line) => total + line.length, 0) / lines.length > 110) return 'minified';
    if (lines.slice(-2).some(line => /^\/[*/][#@] source(?:Mapping)?URL|sourceURL=/.test(line))) return 'source map';
  }
  return lines.slice(0, 40).some(line => GENERATED_MARKERS.some(marker => marker.test(line))) ? 'generated' : null;
}
