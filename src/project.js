/**
 * How a project builds, tests, and checks itself, discovered from the tree at one commit. Reading the manifests and the CI
 * workflow finds the commands; it does not decide what they are for. `npm run check` could be a linter, a type checker, or a
 * deploy, and no amount of matching on the word "test" tells you which — so every command found is put to System One, and it
 * says what each one does. The answers are cached per commit.
 */
import { join } from 'node:path';
import { git } from './git.js';
import { readJson, writeJson } from './store.js';

const manifests = ['package.json', 'pyproject.toml', 'setup.cfg', 'pytest.ini', 'tox.ini', 'Cargo.toml', 'go.mod', 'Makefile', 'justfile'];
/** How many commands are worth asking about; a repository with fifty scripts does not need fifty questions. */
export const MAX_COMMANDS = 24;
const has = (paths, name) => paths.some(path => path === name || path.endsWith(`/${name}`));

/** What a command is for. `single` takes `{file}`, the test file, and `{dir}`, its directory. */
export const COMMAND_ROLES = {
  suite: 'Runs this project\'s whole test suite',
  single: 'Runs one test file, named by the {file} or {dir} in the command',
  install: 'Installs this project\'s dependencies in a fresh checkout',
  gate: 'Reads the code and fails when it is wrong — it compiles, type-checks, lints, or validates — and changes nothing outside the checkout',
  none: 'None of those: it publishes, deploys, releases, uploads, benchmarks, formats or rewrites files, starts a server, or is not a check at all',
};

/**
 * Every command this project might be run with, from its manifests, its Makefile or justfile, and its CI workflow, plus the
 * single-file test runners its dependencies imply. Deduplicated and capped; unsorted, because sorting them is the model's job.
 */
export async function candidateCommands({ root, revision, paths }) {
  const read = path => git(['show', `${revision}:${path}`], root).catch(() => '');
  const commands = new Set();
  if (has(paths, 'package.json')) {
    const pkg = JSON.parse((await read('package.json')) || '{}');
    const manager = has(paths, 'pnpm-lock.yaml') ? 'pnpm' : has(paths, 'yarn.lock') ? 'yarn' : 'npm';
    for (const name of Object.keys(pkg.scripts ?? {})) commands.add(name === 'test' ? `${manager} test` : `${manager} run ${name}`);
    const script = pkg.scripts?.test ?? '';
    // A runner that can take one file is worth offering even when no script names it, since the suite is the slow way to check.
    if (/vitest/.test(script) || pkg.devDependencies?.vitest) commands.add('npx vitest run {file}');
    if (/\bjest\b/.test(script) || pkg.devDependencies?.jest) commands.add('npx jest {file}');
    if (/\bmocha\b/.test(script) || pkg.devDependencies?.mocha) commands.add('npx mocha {file}');
    if (/node --test|node:test/.test(script)) commands.add('node --test {file}');
    if (pkg.dependencies || pkg.devDependencies) commands.add(manager === 'pnpm' ? 'pnpm install --frozen-lockfile' : manager === 'yarn' ? 'yarn install --frozen-lockfile' : has(paths, 'package-lock.json') ? 'npm ci' : 'npm install');
  }
  if (has(paths, 'pyproject.toml') || has(paths, 'pytest.ini') || has(paths, 'setup.cfg') || has(paths, 'tox.ini') || paths.some(path => /(^|\/)test_.*\.py$|_test\.py$/.test(path))) {
    commands.add('python3 -m pytest -q');
    commands.add('python3 -m pytest -q {file}');
    if (has(paths, 'uv.lock')) commands.add('uv sync');
    else if (has(paths, 'requirements.txt')) commands.add('python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt');
    else if (has(paths, 'pyproject.toml')) commands.add('python3 -m venv .venv && .venv/bin/pip install -q -e .');
  }
  if (has(paths, 'Cargo.toml')) for (const command of ['cargo test', 'cargo fetch', 'cargo clippy --all-targets -- -D warnings', 'cargo check --all-targets']) commands.add(command);
  if (has(paths, 'go.mod')) for (const command of ['go test ./...', 'go test {dir}', 'go mod download', 'go vet ./...', 'go build ./...']) commands.add(command);
  for (const [file, runner, pattern] of [['Makefile', 'make', /^([\w.-]+):/gm], ['justfile', 'just', /^([\w.-]+)\b[^\n]*:/gm]]) {
    if (!has(paths, file)) continue;
    for (const [, target] of (await read(file)).matchAll(pattern)) commands.add(`${runner} ${target}`);
  }
  // What a project runs in CI is what it has decided must pass. A step with a ${{ }} in it cannot be run outside Actions.
  for (const path of paths.filter(item => item.startsWith('.github/workflows/'))) {
    for (const line of (await read(path)).split('\n')) {
      const match = /^\s*(?:-\s*)?run:\s*(.+)$/.exec(line);
      // `run: |` opens a block scalar; the command is on the lines after it, and the marker is not one.
      const command = match?.[1].trim();
      if (command && !/^[|>]/.test(command) && !/\$\{\{/.test(command) && command.length <= 120) commands.add(command);
    }
  }
  // The same script reached through a different package manager is the same command; run it once, as this project runs it.
  const seen = new Map();
  for (const command of commands) { const key = command.replace(/^(npm|pnpm|yarn)\b/, '<pm>'); if (!seen.has(key)) seen.set(key, command); }
  return [...seen.values()].slice(0, MAX_COMMANDS);
}

const roleQuestion = command => ({ type: 'choice', instructions: { command, question: 'What does running `command` do in this project?' }, criteria: COMMAND_ROLES });

/**
 * What the project runs, decided once per commit and cached under `<out>/projects`. `suite`, `single` and `install` are the
 * likeliest command for each, or null when nothing fits; `gates` is every command that only checks the code, which is what a
 * rewrite has to survive before it is committed.
 */
export async function discoverProject({ root, revision, out, paths, systemOne, log = () => {} }) {
  const path = join(out, 'projects', `${revision}.json`);
  const cached = await readJson(path, null);
  if (cached) return cached;
  const commands = await candidateCommands({ root, revision, paths });
  const project = { revision, suite: null, single: null, install: null, gates: [], commands, roles: {}, decided_at: new Date().toISOString() };
  if (commands.length) {
    log(`asking ${systemOne.id} what ${root}'s ${commands.length} commands do`);
    const state = {
      manifests: paths.filter(item => manifests.some(name => item === name || item.endsWith(`/${name}`))),
      workflows: paths.filter(item => item.startsWith('.github/workflows/')),
      test_files: paths.filter(item => /(^|\/)(tests?|__tests__)\//.test(item) || /\.(test|spec)\.\w+$|(^|\/)test_.*\.py$|_test\.(py|go|rs)$/.test(item)).slice(0, 40),
      commands,
    };
    const questions = Object.fromEntries(commands.map((command, index) => [`role_${index}`, roleQuestion(command)]));
    const { answers } = await systemOne.ask(state, questions);
    const roleOf = index => answers[`role_${index}`]?.choice ?? 'none';
    const belief = (index, role) => answers[`role_${index}`]?.probabilities?.[role] ?? 0;
    // One of each of the three; every gate, since a project may hold a change to more than one.
    for (const role of ['suite', 'single', 'install']) {
      const best = commands.map((command, index) => ({ command, index })).filter(({ index }) => roleOf(index) === role)
        .sort((a, b) => belief(b.index, role) - belief(a.index, role))[0];
      project[role] = best?.command ?? null;
    }
    project.gates = commands.filter((command, index) => roleOf(index) === 'gate');
    project.roles = Object.fromEntries(commands.map((command, index) => [command, roleOf(index)]));
  }
  await writeJson(path, project);
  return project;
}
