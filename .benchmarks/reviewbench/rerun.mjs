import { execFile, spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { jsonl } from './core.mjs';
import { dataDir, needData } from '../data.mjs';

// Scans each of the 177 pull requests in targets.jsonl with this checkout's bin/perch.mjs,
// `perch scan --since <base> --include-tests --json`, and writes one line a pull request to <out>/<name>.jsonl for
// rerun-score.mjs --results. Tests are read because ReviewBench's targets include test methods. The model and its key come from
// the environment, as for any perch scan: PERCH_BASE_URL, PERCH_MODEL_ID, and PERCH_API_KEY, OPENAI_API_KEY or TYPESAFE_API_KEY.
//
// Up to MAX_REPOS repositories run at once, one repository's pull requests one at a time since they share a clone, and a clone
// is deleted once its pull requests are done. A pull request that finished is not scanned again, so a rerun resumes and retries
// the rest. A scan past MEMORY_LIMIT_GB of resident memory, or SCAN_TIMEOUT_MIN minutes, is killed and recorded.
//
// Usage: node rerun.mjs [--out DIR] [--name NAME] [--parallel N] [--prs a,b]
const root = path.dirname(fileURLToPath(import.meta.url));

/** The answers each run's line keeps for a method: where it is, and the two bug questions. */
const readingOf = row => ({ method: row.method, path: row.path, name: row.name, line: row.line, end_line: row.end_line ?? row.line,
  has_bug: row.has_bug, bug_edge_case: row.bug_edge_case });

/**
 * One pull request's run as a line of results/rerun-luna.jsonl: how the scan ended, what it cost, the methods perch reported,
 * every method it read with its answers, and the language of each file it parsed that the pull request changed or a target
 * sits in, and whether perch counts it as a test. `dir` holds the run's result.json and files.json, and the scan.jsonl and
 * stdout.json that `perch scan --json --out <dir>` left there.
 */
export async function compact(dir) {
  const result = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  const line = { pr: result.pr, code: result.code, seconds: result.seconds, usage: {}, cost: 0, reported: [], files: {}, readings: [] };
  if (result.error) line.error = result.error;
  if (![0, 3].includes(result.code)) return line;
  line.files = JSON.parse(await fs.readFile(path.join(dir, 'files.json'), 'utf8'));
  for (const text of (await fs.readFile(path.join(dir, 'scan.jsonl'), 'utf8')).split('\n')) {
    if (!text) continue;
    const row = JSON.parse(text);
    if (row.type === 'read') line.readings.push(readingOf(row));
  }
  const json = JSON.parse(await fs.readFile(path.join(dir, 'stdout.json'), 'utf8'));
  line.usage = json.usage ?? {};
  line.cost = Object.values(line.usage).reduce((n, u) => n + (u.cost ?? 0), 0);
  line.reported = [...new Set((json.issues ?? []).map(issue => issue.method))];
  return line;
}

/** The distinct pull requests in targets.jsonl, each with its repository, number, base and head. */
export function pullRequests(file = path.join(dataDir('reviewbench'), 'targets.jsonl')) {
  const prs = new Map();
  for (const text of readFileSync(file, 'utf8').split('\n')) {
    if (!text) continue;
    const t = JSON.parse(text);
    if (!prs.has(t.pr)) prs.set(t.pr, { name: t.pr, repository: t.repository, number: Number(/_(\d+)-[0-9a-f]{8}$/.exec(t.pr)?.[1]), base: t.base, head: t.head });
  }
  return [...prs.values()];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; };
  if (args.length % 2 || args.some((arg, i) => i % 2 === 0 && !['--out', '--name', '--parallel', '--prs'].includes(arg))) throw Error('Use rerun.mjs [--out DIR] [--name NAME] [--parallel N] [--prs a,b]');
  const out = path.resolve(option('out') ?? path.join(root, 'runs')), name = option('name') ?? 'rerun';
  const perch = path.join(root, '../../bin/perch.mjs');
  const data = needData('reviewbench', ['targets.jsonl']);
  const MEMORY_LIMIT_GB = Number(process.env.MEMORY_LIMIT_GB ?? 24), MAX_REPOS = Number(process.env.MAX_REPOS ?? 4);
  const SCAN_TIMEOUT_MIN = Number(process.env.SCAN_TIMEOUT_MIN ?? 120);
  const run = promisify(execFile);
  const git = args => run('git', args, { maxBuffer: 1 << 26, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30 * 60_000 });
  const hasCommit = (dir, sha) => git(['-C', dir, 'cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);
  const repoDir = repository => path.join(out, 'repos', repository.replace(/^https:\/\/github\.com\//, '').replace('/', '__'));
  const done = dir => existsSync(path.join(dir, 'result.json')) && [0, 3].includes(JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')).code);
  const wanted = option('prs')?.split(',');
  const items = pullRequests().filter(item => !wanted || wanted.includes(item.name));

  async function checkout(item) {
    const dir = repoDir(item.repository);
    if (!existsSync(path.join(dir, '.git'))) {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(path.dirname(dir), { recursive: true });
      // A repository that was deleted or made private fails here.
      await git(['clone', '-q', '--filter=blob:none', '--no-checkout', `${item.repository}.git`, dir]).catch(error => { throw Error(`clone of ${item.repository} failed`, { cause: error }); });
    }
    for (const sha of [item.base, item.head]) {
      // A commit no branch reaches any more is often still under the pull request's own refs.
      for (const refs of [[sha], [`refs/pull/${item.number}/head`], [`refs/pull/${item.number}/merge`]]) {
        if (await hasCommit(dir, sha)) break;
        await git(['-C', dir, 'fetch', '-q', 'origin', ...refs]).catch(error => console.log(`${item.name}: fetch ${refs[0]} failed: ${error.message.split('\n')[0]}`));
      }
      if (!await hasCommit(dir, sha)) throw Error(`${sha === item.base ? 'base' : 'head'} ${sha} not fetchable`);
    }
    await git(['-C', dir, 'checkout', '-q', '-f', '--detach', item.head]);
    await git(['-C', dir, 'clean', '-fdqx']);
    return dir;
  }

  /** Resident memory of a process and its children, in GB. */
  async function residentGb(pid) {
    const { stdout } = await run('ps', ['-Ao', 'pid=,ppid=,rss=']);
    const rows = stdout.trim().split('\n').map(text => text.trim().split(/\s+/).map(Number));
    const family = new Set([pid]);
    for (let grew = true; grew;) { grew = false; for (const [p, parent] of rows) if (family.has(parent) && !family.has(p)) { family.add(p); grew = true; } }
    return rows.filter(([p]) => family.has(p)).reduce((sum, [, , rss]) => sum + rss, 0) / 1048576;
  }

  function scan(cwd, base, dir) {
    return new Promise(resolve => {
      const started = Date.now();
      const flags = ['scan', '--since', base, '--include-tests', '--json', '--out', dir, ...(option('parallel') ? ['--parallel', option('parallel')] : [])];
      const child = spawn(process.execPath, [perch, ...flags], { cwd, env: process.env });
      let stdout = '', stderr = '', killed = null;
      const watch = setInterval(async () => {
        if (!killed && await residentGb(child.pid) > MEMORY_LIMIT_GB) { killed = 'memory'; child.kill('SIGKILL'); }
      }, 2000);
      const timer = setTimeout(() => { if (!killed) { killed = 'timeout'; child.kill('SIGKILL'); } }, SCAN_TIMEOUT_MIN * 60_000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => { clearInterval(watch); clearTimeout(timer); resolve({ code: killed ?? code, seconds: (Date.now() - started) / 1000, stdout, stderr }); });
    });
  }

  /** Each file in `paths` that perch parsed, from the parse cache the scan left in `dir`, with its language and whether it is a test. */
  async function fileKinds(dir, paths) {
    const kinds = {}, scans = path.join(dir, 'scans');
    for (const id of existsSync(scans) ? await fs.readdir(scans) : []) {
      const file = path.join(scans, id, 'files.jsonl');
      if (!existsSync(file)) continue;
      // A large repository's cache runs to hundreds of MB, so it is read a line at a time and only the files wanted are parsed.
      for await (const text of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
        const head = /^\{"path":("(?:[^"\\]|\\.)*")/.exec(text);
        if (!head || !paths.has(JSON.parse(head[1]))) continue;
        const row = JSON.parse(text);
        kinds[row.path] = { language: row.language, test: row.test };
      }
    }
    return kinds;
  }
  const targetPaths = new Map();
  for (const t of await jsonl(path.join(data, 'targets.jsonl'))) targetPaths.set(t.pr, (targetPaths.get(t.pr) ?? new Set()).add(t.path));

  async function prRun(item) {
    const dir = path.join(out, name, item.name);
    if (done(dir)) return;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    let cwd;
    try { cwd = await checkout(item); }
    catch (error) {
      const message = error.message.split('\n').find(Boolean);
      await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ pr: item.name, code: 'checkout', error: message, seconds: 0 }));
      console.log(`${item.name} checkout failed: ${message}`);
      return;
    }
    const result = await scan(cwd, item.base, dir);
    await fs.writeFile(path.join(dir, 'stdout.json'), result.stdout);
    await fs.writeFile(path.join(dir, 'stderr.txt'), result.stderr);
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ pr: item.name, code: result.code, seconds: result.seconds }));
    if ([0, 3].includes(result.code)) {
      const changed = JSON.parse(result.stdout).run?.paths ?? [];
      await fs.writeFile(path.join(dir, 'files.json'), JSON.stringify(await fileKinds(dir, new Set([...changed, ...targetPaths.get(item.name)]))));
      // The parse cache runs to a few hundred MB a pull request and nothing reads it again.
      await fs.rm(path.join(dir, 'scans'), { recursive: true, force: true });
    }
    console.log(`${item.name} exit ${result.code} in ${result.seconds.toFixed(0)}s${[0, 3].includes(result.code) ? '' : `: ${result.stderr.trim().split('\n').at(-1)}`}`);
  }

  const byRepo = new Map();
  for (const item of items) byRepo.set(item.repository, [...(byRepo.get(item.repository) ?? []), item]);
  const queue = [...byRepo.entries()];
  console.log(`perch ${(await run(process.execPath, [perch, '--version'])).stdout.trim()}, ${items.length} pull requests into ${path.join(out, name)}`);
  await Promise.all(Array.from({ length: MAX_REPOS }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [repository, prs] = next;
      for (const item of prs) await prRun(item);
      await fs.rm(repoDir(repository), { recursive: true, force: true });
    }
  }));
  const lines = [];
  for (const item of items) if (existsSync(path.join(out, name, item.name, 'result.json'))) lines.push(JSON.stringify(await compact(path.join(out, name, item.name))));
  await fs.writeFile(path.join(out, `${name}.jsonl`), lines.join('\n') + '\n');
  console.log(`${lines.length} of ${items.length} pull requests in ${path.join(out, `${name}.jsonl`)}`);
}
