import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });

it('reads quotes from the repository fetched for the target, not a checkout the repos directory sits in', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perch-judge-'));
  temporary.push(dir);
  // The scripts and their data laid out as in .benchmarks: the scripts in reviewbench/, the data in hf/reviewbench/.
  await fs.mkdir(path.join(dir, 'reviewbench'));
  await fs.mkdir(path.join(dir, 'hf', 'reviewbench'), { recursive: true });
  for (const name of ['judge.mjs', 'core.mjs']) await fs.copyFile(new URL(name, import.meta.url), path.join(dir, 'reviewbench', name));
  await fs.copyFile(new URL('../data.mjs', import.meta.url), path.join(dir, 'data.mjs'));
  // The directory holding the scripts is a checkout with the quoted commit in it, the way .benchmarks sits inside perch's.
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  await fs.writeFile(path.join(dir, 'a.js'), 'function a() {\n  return 1;\n}\n');
  git(['init', '-q']); git(['add', 'a.js']); git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'a']);
  const head = git(['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(dir, 'hf', 'reviewbench', 'targets.jsonl'), JSON.stringify({ id: 't', repository: 'https://github.com/example/example', head, start_line: 1, end_line: 3 }) + '\n');
  await fs.writeFile(path.join(dir, 'hf', 'reviewbench', 'judgments.jsonl'), JSON.stringify({ id: 't', status: 'supported', start_line: 2, evidence: [{ file: 'a.js', start_line: 2, end_line: 2, quote: '  return 1;' }] }) + '\n');
  // A directory left for the target by an earlier run, with nothing fetched into it.
  await fs.mkdir(path.join(dir, 'repos', 'example_example', head), { recursive: true });
  expect(() => execFileSync(process.execPath, [path.join(dir, 'reviewbench', 'judge.mjs'), '--repos', path.join(dir, 'repos')], { cwd: dir, stdio: 'pipe' })).toThrow(/not a git repository/);
});
