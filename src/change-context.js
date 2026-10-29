import { git } from './git.js';

const filename = value => value.startsWith('"') ? JSON.parse(value.replace(/\\([0-7]{3})/g, (_, octal) => `\\u00${parseInt(octal, 8).toString(16).padStart(2, '0')}`)) : value.replace(/\t$/, '');
const limited = (source, limit = 6000) => ({ source: source.slice(0, limit), partial: source.length > limit });
const numbered = (lines, start) => lines.map((line, i) => `L${start + i}| ${line}`).join('\n');

/** Read a branch diff once, then reuse old file sources across its methods. */
export async function createChangeReader(root, since, revision) {
  const base = (await git(['merge-base', since, revision], root)).trim();
  const diff = await git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', '-M', `${base}..${revision}`], root);
  const files = new Map(), previous = new Map();
  let file, hunk;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { file = { old: null, hunks: [] }; hunk = null; }
    if (!hunk && line.startsWith('--- ') && file) file.old = line.slice(4) === '/dev/null' ? null : filename(line.slice(4)).replace(/^a\//, '');
    if (!hunk && line.startsWith('+++ ') && file) {
      const path = filename(line.slice(4));
      if (path !== '/dev/null') files.set(path.replace(/^b\//, ''), file);
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match && file) {
      hunk = { old: +match[1], oldCount: +(match[2] ?? 1), start: +match[3], count: +(match[4] ?? 1), lines: [], changed: [], at: +match[3] };
      file.hunks.push(hunk);
    } else if (hunk) {
      // The new-side line each added line is on, and the one a deletion sits before. Context lines only move the count along.
      if (line.startsWith('+')) hunk.changed.push(hunk.at++);
      else if (line.startsWith('-')) hunk.changed.push(hunk.at);
      else if (line.startsWith(' ')) hunk.at++;
    }
    if (hunk) hunk.lines.push(line);
  }
  // A method is changed when a line the branch added or deleted is one of its own. A hunk's context lines are not, and neither
  // are the methods inside a top-level unit's span: its `lines` are what it covers.
  const owns = node => node.lines ? (own => at => own.has(at))(new Set(node.lines)) : at => at >= node.line && at <= node.end_line;
  return async node => {
    const file = files.get(node.path), mine = owns(node);
    const hunks = file?.hunks.filter(h => h.changed.some(mine));
    if (!hunks?.length) return null;
    if (file.old && !previous.has(file.old)) previous.set(file.old, git(['show', `${base}:${file.old}`], root).then(text => text.split('\n')));
    const lines = file.old ? await previous.get(file.old) : [];
    const first = Math.max(1, Math.min(...hunks.map(h => h.old)) - 3);
    const last = Math.max(...hunks.map(h => h.old + h.oldCount)) + 3;
    return { before: { ...limited(numbered(lines.slice(first - 1, last), first)), path: file.old, new_file: !file.old },
      diff: limited(hunks.map(h => h.lines.join('\n')).join('\n')) };
  };
}
