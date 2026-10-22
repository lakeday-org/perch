import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compact } from './core.mjs';
import { needData } from '../data.mjs';

// Scans each of the benchmark's 50 pull requests with this checkout's bin/perch.mjs, `perch scan --since <base> --json`, and
// writes one line a pull request to <out>/<config>.jsonl for score.mjs --results <out>. The model and its key come from the
// environment, as for any perch scan: PERCH_BASE_URL, PERCH_MODEL_ID, and PERCH_API_KEY, OPENAI_API_KEY or TYPESAFE_API_KEY.
// Repositories run in parallel, and one repository's pull requests one at a time, since they share a clone. A finished pull
// request is not scanned again, so a rerun resumes. A scan past MEMORY_LIMIT_GB of resident memory is killed and recorded.
//
// Usage: node run.mjs <config> [--out DIR] [--repos sentry,grafana]
const root = path.dirname(fileURLToPath(import.meta.url));
const perch = path.join(root, '../../bin/perch.mjs');
const [config, ...rest] = process.argv.slice(2);
const option = name => { const i = rest.indexOf('--' + name); return i < 0 ? undefined : rest[i + 1]; };
if (!config || config.startsWith('--') || rest.length % 2) throw Error('Use run.mjs <config> [--out DIR] [--repos sentry,grafana]');
const out = path.resolve(option('out') ?? path.join(root, 'runs'));
const MEMORY_LIMIT_GB = Number(process.env.MEMORY_LIMIT_GB ?? 24);
const data = needData('greptile', ['manifest.json']);
const manifest = JSON.parse(await fs.readFile(path.join(data, 'manifest.json'), 'utf8'));
const repos = option('repos')?.split(',') ?? [...new Set(manifest.map(item => item.repo))];
const run = promisify(execFile);
const git = (...args) => run('git', args, { maxBuffer: 1 << 26 });
const done = dir => existsSync(path.join(dir, 'result.json')) && [0, 3].includes(JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')).code);

async function checkout(item) {
  const dir = path.join(out, 'repos', item.repo);
  if (!existsSync(dir)) await git('clone', '-q', '--filter=blob:none', '--no-checkout', `https://github.com/ai-code-review-evaluation/${item.repo}-greptile.git`, dir);
  await git('-C', dir, 'fetch', '-q', 'origin', item.base, item.head);
  await git('-C', dir, 'checkout', '-q', '-f', '--detach', item.head);
  await git('-C', dir, 'clean', '-fdqx');
  return dir;
}

/** Resident memory of a process and its children, in GB. */
async function residentGb(pid) {
  const { stdout } = await run('ps', ['-Ao', 'pid=,ppid=,rss=']);
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const family = new Set([pid]);
  for (let grew = true; grew;) { grew = false; for (const [p, parent] of rows) if (family.has(parent) && !family.has(p)) { family.add(p); grew = true; } }
  return rows.filter(([p]) => family.has(p)).reduce((sum, [, , rss]) => sum + rss, 0) / 1048576;
}

function scan(cwd, base, dir) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [perch, 'scan', '--since', base, '--json', '--out', dir], { cwd, env: process.env });
    let stdout = '', stderr = '', killed = false;
    const watch = setInterval(async () => {
      if (!killed && await residentGb(child.pid) > MEMORY_LIMIT_GB) { killed = true; child.kill('SIGKILL'); }
    }, 2000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => { clearInterval(watch); resolve({ code: killed ? 'memory' : code, seconds: (Date.now() - started) / 1000, stdout, stderr }); });
  });
}

async function repoRun(repo) {
  for (const item of manifest.filter(entry => entry.repo === repo)) {
    const name = `${repo}-${item.pr}`, dir = path.join(out, config, name);
    if (done(dir)) continue;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const result = await scan(await checkout(item), item.base, dir);
    await fs.writeFile(path.join(dir, 'stdout.json'), result.stdout);
    await fs.writeFile(path.join(dir, 'stderr.txt'), result.stderr);
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ repo, pr: item.pr, config, code: result.code, seconds: result.seconds }));
    console.log(`${name} exit ${result.code} in ${result.seconds.toFixed(0)}s${[0, 3].includes(result.code) ? '' : `: ${result.stderr.trim().split('\n').at(-1)}`}`);
  }
}

console.log(`perch ${(await run(process.execPath, [perch, '--version'])).stdout.trim()}, ${config} into ${out}`);
await Promise.all(repos.map(repoRun));
const lines = [];
for (const item of manifest) {
  const dir = path.join(out, config, `${item.repo}-${item.pr}`);
  if (existsSync(path.join(dir, 'result.json'))) lines.push(JSON.stringify(await compact(config, item, dir)));
}
await fs.writeFile(path.join(out, `${config}.jsonl`), lines.join('\n') + '\n');
console.log(`${lines.length} of ${manifest.length} pull requests in ${path.join(out, `${config}.jsonl`)}`);
