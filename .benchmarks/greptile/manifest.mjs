import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../data.mjs';

// Rebuilds manifest.json in the data folder: each of Martian's golden-comment entries matched to its pull request in the
// -greptile fork, by the number its URL names when it points into a fork, else by title. Reads the golden comments at a pinned
// commit and the forks' pull requests from the GitHub API, which needs no key at this size; GITHUB_TOKEN is used when set.
const MARTIAN = 'https://raw.githubusercontent.com/withmartian/code-review-benchmark/e616e849755441da38f18bf3adba2c9583b03803/offline/golden_comments';
const FILES = { sentry: 'sentry', grafana: 'grafana', 'cal.com': 'cal_dot_com', keycloak: 'keycloak', discourse: 'discourse' };
const headers = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};

async function get(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

const norm = text => text.toLowerCase().replace(/\(#\d+\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const manifest = [], misses = [];
for (const [repo, file] of Object.entries(FILES)) {
  const forks = (await get(`https://api.github.com/repos/ai-code-review-evaluation/${repo}-greptile/pulls?state=all&per_page=100`))
    .map(pull => ({ number: pull.number, title: pull.title, base: pull.base.sha, head: pull.head.sha }));
  for (const golden of await get(`${MARTIAN}/${file}.json`)) {
    const want = norm(golden.pr_title);
    const named = golden.url.match(/ai-code-review-evaluation\/[^/]+-greptile\/pull\/(\d+)/);
    const hit = (named && forks.find(fork => fork.number === Number(named[1]))) || forks.find(fork => norm(fork.title) === want)
      || forks.find(fork => norm(fork.title).startsWith(want.slice(0, 40)) || want.startsWith(norm(fork.title).slice(0, 40)));
    if (!hit) { misses.push(`${repo}: ${golden.pr_title}`); continue; }
    manifest.push({ repo, pr: hit.number, title: hit.title, base: hit.base, head: hit.head, golden_url: golden.url, comments: golden.comments });
  }
}
await fs.mkdir(dataDir('greptile'), { recursive: true });
await fs.writeFile(path.join(dataDir('greptile'), 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`matched ${manifest.length}, missed ${misses.length}`, misses);
