import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { jsonl } from './core.mjs';
import { needData } from '../data.mjs';

// Verify manual judgments against exact source, without an explanation or judging API.
const value = name => { const i = process.argv.indexOf(name); if (i >= 0 && !process.argv[i + 1]) throw Error(`${name} needs a value`); return i < 0 ? null : process.argv[i + 1]; };
if (!value('--repos')) throw Error('Use --repos DIR [--fetch] [--judgments FILE]');
const repos = path.resolve(value('--repos')), fetch = process.argv.includes('--fetch');
const data = needData('reviewbench', value('--judgments') ? ['targets.jsonl'] : ['targets.jsonl', 'judgments.jsonl']);
const judgments = await jsonl(value('--judgments') ?? path.join(data, 'judgments.jsonl'));
const targets = new Map((await jsonl(path.join(data, 'targets.jsonl'))).map(t => [t.id, t]));
// Each command names the target's own repository. Found by looking upward, a repos directory inside a checkout, as the README's is
// inside perch's, is that checkout: fetches land in it and quotes are read from it.
const git = (repo, args) => execFileSync('git', ['--git-dir', path.join(repo, '.git'), '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const ready = new Set(); let checked = 0;
for (const judgment of judgments) {
  const target = targets.get(judgment.id);
  if (!target || !['supported', 'unsupported', 'uncertain'].includes(judgment.status)) throw Error('Invalid judgment');
  if (judgment.status === 'supported' && (!judgment.evidence?.length || !Number.isSafeInteger(judgment.start_line) || judgment.start_line < target.start_line || judgment.start_line > target.end_line)) throw Error('Positive judgment needs a target-local source anchor');
  if (!judgment.evidence?.length) continue;
  const match = /^https:\/\/github.com\/([\w.-]+)\/([\w.-]+)$/.exec(target.repository);
  if (!match || !/^[a-f0-9]{40}$/.test(target.head)) throw Error('Invalid repository identity');
  const repo = path.join(repos, match[1] + '_' + match[2], target.head), key = target.repository + '@' + target.head;
  if (!ready.has(key)) {
    if (fetch) {
      await fs.mkdir(repo, { recursive: true });
      execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
      git(repo, ['fetch', '--no-tags', '--depth=1', target.repository, target.head]);
    }
    git(repo, ['cat-file', '-e', target.head + '^{commit}']); ready.add(key);
  }
  for (const evidence of judgment.evidence) {
    if (!Number.isSafeInteger(evidence.start_line) || !Number.isSafeInteger(evidence.end_line) || evidence.start_line < 1 || evidence.end_line < evidence.start_line) throw Error('Invalid source quote span');
    const source = git(repo, ['show', target.head + ':' + evidence.file]).split(/\r?\n/);
    const quote = source.slice(evidence.start_line - 1, evidence.end_line).join('\n');
    if (quote !== evidence.quote) throw Error(`Source quote mismatch: ${judgment.id} ${evidence.file}`);
    checked++;
  }
}
console.log(JSON.stringify({ judgments: judgments.length, exact_source_quotes_verified: checked }));
