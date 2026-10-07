/**
 * `perch setup <assistant>`: put the skill where a coding assistant will find it.
 *
 * One document, written to four places. Claude Code, Codex and pi all read a directory holding a SKILL.md and load it when its
 * description looks relevant, so they take the file as it is. Cursor reads `.mdc` files with a frontmatter of its own, so the
 * same body is rewritten under that frontmatter rather than kept as a second copy that would drift from this one.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CLOUD_ORIGIN } from './cloud-auth.js';

/** The skill as it ships, read from the package rather than the repository being set up. */
const source = () => readFile(new URL('../skill.md', import.meta.url), 'utf8');

/**
 * Perch Cloud's MCP server: CI runs, and Perch's review comments on a pull request. Scans of the checkout stay with the perch
 * command, which the skill teaches.
 */
export const MCP_NAME = 'perch-cloud';
export const CLOUD_MCP = `${CLOUD_ORIGIN}/mcp`;

/**
 * Where each assistant looks. Codex and pi both also read `.agents/skills`, but a file in the assistant's own directory is the
 * one a person can find when they go looking for what perch installed, so that is where it goes.
 */
export const TARGETS = {
  'claude-code': { path: '.claude/skills/perch/SKILL.md', name: 'Claude Code', mcp: { path: '.mcp.json', server: { type: 'http', url: CLOUD_MCP } } },
  codex: { path: '.codex/skills/perch/SKILL.md', name: 'Codex', mcpCommand: `codex mcp add ${MCP_NAME} --url ${CLOUD_MCP}` },
  pi: { path: '.pi/skills/perch/SKILL.md', name: 'pi' },
  cursor: { path: '.cursor/rules/perch.mdc', name: 'Cursor', rewrite: asCursorRule, mcp: { path: '.cursor/mcp.json', server: { url: CLOUD_MCP } } },
};

/**
 * Adds Perch Cloud's MCP server to the project's servers where the assistant reads them from the repository: Claude Code's
 * .mcp.json and Cursor's .cursor/mcp.json. The assistant signs in to it itself, through Perch Cloud, so nothing secret is
 * written. Codex keeps its servers in the user's own configuration, so it gets the command to run instead, and pi has no MCP
 * support. An entry already there is left alone, and so is a file that does not parse, rather than being rewritten into
 * something its owner did not write.
 */
export async function registerMcp({ root, target }) {
  const chosen = TARGETS[target];
  if (!chosen?.mcp) return { registered: false, command: chosen?.mcpCommand ?? null };
  const path = join(root, chosen.mcp.path);
  const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  let config = {};
  if (text !== null) {
    try { config = JSON.parse(text); } catch { return { registered: false, path: chosen.mcp.path, why: `${chosen.mcp.path} is not valid JSON, so perch left it alone` }; }
  }
  if (config.mcpServers?.[MCP_NAME]) return { registered: false, already: true, path: chosen.mcp.path };
  config.mcpServers = { ...config.mcpServers, [MCP_NAME]: chosen.mcp.server };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return { registered: true, path: chosen.mcp.path };
}

export const TARGET_NAMES = Object.keys(TARGETS);

/**
 * The frontmatter and the body, so one can be replaced without touching the other. A description runs to the next key or the
 * end of the frontmatter, however many lines that is, and a folded one loses its `>-` since Cursor is given it on one line.
 */
function split(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('the skill that ships with perch has no frontmatter; reinstall perch');
  const description = /(?:^|\n)description:[ \t]*([\s\S]*?)(?=\n[\w-]+:|$)/.exec(match[1])?.[1];
  return { description: String(description ?? '').replace(/^[>|][+-]?\s/, '').replace(/\s+/g, ' ').trim(), body: match[2] };
}

/**
 * Cursor's own frontmatter, and always on. The other three pick a skill off a list by its description when they judge it
 * relevant; Cursor would leave that to whether a description matched the turn, and "fix this bug" does not read as semantic
 * linting. The cost of being wrong is not symmetric. Loaded when it was not needed, this is a few kilobytes nobody reads.
 * Not loaded when it was, the assistant either never thinks of perch or runs it out of general knowledge of the shell, which is
 * where scanning a repository to check one line, and reading exit 3 as a crash, both come from.
 */
function asCursorRule(text) {
  const { description, body } = split(text);
  return `---\ndescription: ${description}\nalwaysApply: true\n---\n${body}`;
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
