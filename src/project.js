/** How a project runs its tests, discovered from the tree at one commit: candidate commands from manifests and CI, one System One choice when there is more than one. */
import { join } from 'node:path';
import { git } from './git.js';
import { readJson, writeJson } from './store.js';

const manifests = ['package.json', 'pyproject.toml', 'setup.cfg', 'pytest.ini', 'tox.ini', 'Cargo.toml', 'go.mod', 'Makefile', 'justfile'];
const has = (paths, name) => paths.some(path => path === name || path.endsWith(`/${name}`));
const hasPrefix = (paths, prefix) => paths.some(path => path.startsWith(prefix));

/** Candidate commands. `{file}` is the test file, `{dir}` its directory; `install` runs once in a fresh worktree. */
export async function candidateCommands({ root, revision, paths }) {
  const read = path => git(['show', `${revision}:${path}`], root).catch(() => '');
  const suite = new Set(), single = new Set(), install = new Set();
  if (has(paths, 'package.json')) {
    const pkg = JSON.parse((await read('package.json')) || '{}');
    const manager = has(paths, 'pnpm-lock.yaml') ? 'pnpm' : has(paths, 'yarn.lock') ? 'yarn' : 'npm';
    const script = pkg.scripts?.test ?? '';
    if (script) suite.add(`${manager} test`);
    if (/vitest/.test(script) || pkg.devDependencies?.vitest) single.add('npx vitest run {file}');
    if (/\bjest\b/.test(script) || pkg.devDependencies?.jest) single.add('npx jest {file}');
    if (/\bmocha\b/.test(script) || pkg.devDependencies?.mocha) single.add('npx mocha {file}');
    if (/node --test|node:test/.test(script) || !single.size) single.add('node --test {file}');
    if (pkg.dependencies || pkg.devDependencies) install.add(manager === 'pnpm' ? 'pnpm install --frozen-lockfile' : manager === 'yarn' ? 'yarn install --frozen-lockfile' : has(paths, 'package-lock.json') ? 'npm ci' : 'npm install');
  }
  addPythonCommands(suite, single, install, paths);
  addCargoCommands(suite, single, install, paths);
  addGoCommands(suite, single, install, paths);
  if (has(paths, 'Makefile') && /^test:/m.test(await read('Makefile'))) suite.add('make test');
  if (has(paths, 'justfile') && /^test\b/m.test(await read('justfile'))) suite.add('just test');
  if (hasPrefix(paths, '.github/workflows/')) {
    for (const path of paths.filter(path => path.startsWith('.github/workflows/'))) {
      for (const line of (await read(path)).split('\n')) {
        const match = /^\s*(?:-\s*)?run:\s*(.+test.*)$/.exec(line);
        if (match && !/\$\{\{/.test(match[1]) && match[1].length < 120) suite.add(match[1].trim());
      }
    }
  }
  return { suite: [...suite], single: [...single], install: [...install] };
}

function addPythonCommands(suite, single, install, paths) {
  if (has(paths, 'pyproject.toml') || has(paths, 'pytest.ini') || has(paths, 'setup.cfg') || has(paths, 'tox.ini') || paths.some(path => /(^|\/)test_.*\.py$|_test\.py$/.test(path))) {
    suite.add('python3 -m pytest -q');
    single.add('python3 -m pytest -q {file}');
    if (has(paths, 'uv.lock')) install.add('uv sync');
    else if (has(paths, 'requirements.txt')) install.add('python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt');
    else if (has(paths, 'pyproject.toml')) install.add('python3 -m venv .venv && .venv/bin/pip install -q -e .');
  }
}

function addCargoCommands(suite, single, install, paths) {
  if (has(paths, 'Cargo.toml')) { suite.add('cargo test'); single.add('cargo test'); install.add('cargo fetch'); }
}

function addGoCommands(suite, single, install, paths) {
  if (has(paths, 'go.mod')) { suite.add('go test ./...'); single.add('go test {dir}'); install.add('go mod download'); }
}

/** The project's test commands at a commit, cached under <out>/projects. */
export async function discoverProject({ root, revision, out, paths, systemOne, log = () => {} }) {
  const path = join(out, 'projects', `${revision}.json`);
  const cached = await readJson(path, null);
  if (cached) return cached;
  const candidates = await candidateCommands({ root, revision, paths });
  const pick = (list, key) => ({ [key]: { type: 'choice', instructions: `Which command is the right way to ${key === 'suite' ? 'run this project\'s whole test suite' : key === 'single' ? 'run one test file ({file} is its path, {dir} its directory)' : 'install this project\'s dependencies in a fresh checkout'}?`, criteria: Object.fromEntries(list.map(item => [item, null])) } });
  const chosen = { suite: candidates.suite[0] ?? null, single: candidates.single[0] ?? null, install: candidates.install[0] ?? null };
  const ambiguous = Object.entries(candidates).filter(([, list]) => list.length > 1);
  if (ambiguous.length) {
    log(`asking ${systemOne.id} how ${root} runs its tests`);
    const questions = Object.assign({}, ...ambiguous.map(([key, list]) => pick(list, key)));
    const state = { manifests: paths.filter(item => manifests.some(name => item === name || item.endsWith(`/${name}`))), workflows: paths.filter(item => item.startsWith('.github/workflows/')), test_files: paths.filter(item => /(^|\/)(tests?|__tests__)\//.test(item) || /\.(test|spec)\.\w+$|(^|\/)test_.*\.py$|_test\.(py|go|rs)$/.test(item)).slice(0, 40), candidates };
    const { answers } = await systemOne.ask(state, questions);
    for (const [key] of ambiguous) chosen[key] = answers[key].choice;
  }
  const project = { revision, ...chosen, candidates, decided_at: new Date().toISOString() };
  await writeJson(path, project);
  return project;
}
