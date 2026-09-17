/**
 * `perch setup <assistant>`: put the skill where a coding assistant will find it.
 *
 * One document, written to four places. Claude Code, Codex and pi all read a directory holding a SKILL.md and load it when its
 * description looks relevant, so they take the file as it is. Cursor reads `.mdc` files with a frontmatter of its own, so the
 * same body is rewritten under that frontmatter rather than kept as a second copy that would drift from this one.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The skill as it ships, read from the package rather than the repository being set up. */
const source = () => readFile(new URL('../skill.md', import.meta.url), 'utf8');

/**
 * Where each assistant looks. Codex and pi both also read `.agents/skills`, but a file in the assistant's own directory is the
 * one a person can find when they go looking for what perch installed, so that is where it goes.
 */
export const TARGETS = {
  'claude-code': { path: '.claude/skills/perch/SKILL.md', name: 'Claude Code' },
  codex: { path: '.codex/skills/perch/SKILL.md', name: 'Codex' },
  pi: { path: '.pi/skills/perch/SKILL.md', name: 'pi' },
  cursor: { path: '.cursor/rules/perch.mdc', name: 'Cursor', rewrite: asCursorRule },
};

export const TARGET_NAMES = Object.keys(TARGETS);

/** The frontmatter and the body, so one can be replaced without touching the other. */
function split(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('the skill that ships with perch has no frontmatter; reinstall perch');
  const description = /^description:\s*([\s\S]*?)(?=\n[a-z_]+:|$)/m.exec(match[1])?.[1];
  return { description: String(description ?? '').replace(/\s+/g, ' ').trim(), body: match[2] };
}

/**
 * Cursor's own frontmatter. `alwaysApply` stays false and the description is kept, because this is a rule about a job rather
 * than a rule about the code: a scanner loaded into every chat is a scanner in the way of every chat that is not about scanning.
 */
function asCursorRule(text) {
  const { description, body } = split(text);
  return `---\ndescription: ${description}\nalwaysApply: false\n---\n${body}`;
}

/**
 * Write it, unless something is already there. An assistant's skill is a file a person edits, so replacing one without being
 * asked would throw away their wording; `force` is that asking.
 */
export async function installSkill({ root, target, force = false }) {
  const chosen = TARGETS[target];
  if (!chosen) throw new Error(`perch setup takes ${TARGET_NAMES.join(', ')}, not ${target}`);
  const text = await source();
  const path = join(root, chosen.path);
  const existing = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const written = chosen.rewrite ? chosen.rewrite(text) : text;
  if (existing !== null && !force) {
    return { target, name: chosen.name, path: chosen.path, wrote: false,
      same: existing === written, why: `${chosen.path} is already there; perch setup ${target} --force replaces it` };
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, written);
  return { target, name: chosen.name, path: chosen.path, wrote: true, replaced: existing !== null };
}
