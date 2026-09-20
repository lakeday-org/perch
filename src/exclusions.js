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

/** Resolve project-owned output once from tracked manifests, keeping bin, lib, packages, and deps elsewhere readable. */
export function createFileSelector(tree) {
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
