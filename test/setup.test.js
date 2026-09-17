import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installSkill, TARGET_NAMES, TARGETS } from '../src/setup.js';

const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'perch-setup-'));
  cleanups.push(root);
  return root;
}

describe('perch setup', () => {
  it('writes the skill where each assistant looks for it', async () => {
    const root = await repo();
    for (const target of TARGET_NAMES) {
      const done = await installSkill({ root, target });
      expect(done).toMatchObject({ target, wrote: true, replaced: false, path: TARGETS[target].path });
      const written = await readFile(join(root, done.path), 'utf8');
      // The same document every time: what perch can be told to do does not depend on who is reading it.
      expect(written).toContain('perch scan --since origin/main --json');
      expect(written).toContain('perch check src/store.js::openStore.scanDir --json');
      expect(written).toContain('perch rules add no-silent-failure');
      expect(written).toMatch(/^---\n/);
    }
    // Claude Code, Codex and pi load a skill by its name and description, so both have to survive being written out.
    for (const target of ['claude-code', 'codex', 'pi']) {
      const written = await readFile(join(root, TARGETS[target].path), 'utf8');
      expect(written).toMatch(/^---\nname: perch\ndescription: /);
    }
    // Cursor reads its own frontmatter and ignores a .md, so the body is rewritten under it rather than copied beside it.
    const cursor = await readFile(join(root, TARGETS.cursor.path), 'utf8');
    expect(cursor).toMatch(/^---\ndescription: .+\nalwaysApply: false\n---\n/);
    expect(cursor).not.toContain('name: perch');
    // Not applied to every chat: a scanner in the way of every conversation that is not about scanning.
    expect(cursor).toContain('alwaysApply: false');
  });

  it('keeps a skill you have edited until you say otherwise', async () => {
    const root = await repo();
    await installSkill({ root, target: 'claude-code' });
    const path = join(root, TARGETS['claude-code'].path);

    // Writing the same thing again is not a change, and says so rather than claiming to have done something.
    expect(await installSkill({ root, target: 'claude-code' })).toMatchObject({ wrote: false, same: true });

    await writeFile(path, (await readFile(path, 'utf8')) + '\nAsk me before scanning.\n');
    const held = await installSkill({ root, target: 'claude-code' });
    expect(held).toMatchObject({ wrote: false, same: false });
    expect(held.why).toContain('--force');
    expect(await readFile(path, 'utf8')).toContain('Ask me before scanning.');

    const forced = await installSkill({ root, target: 'claude-code', force: true });
    expect(forced).toMatchObject({ wrote: true, replaced: true });
    expect(await readFile(path, 'utf8')).not.toContain('Ask me before scanning.');
  });

  it('refuses an assistant it does not know, and names the ones it does', async () => {
    const root = await repo();
    await expect(installSkill({ root, target: 'emacs' })).rejects.toThrow(/claude-code, codex, pi, cursor/);
  });

  it('tells the assistant the things that are easy to get wrong about perch', async () => {
    const root = await repo();
    const { path } = await installSkill({ root, target: 'claude-code' });
    const skill = await readFile(join(root, path), 'utf8');
    // A scan of everything costs real money, so the narrowed form is the one it is shown.
    expect(skill).toContain('--since <ref>');
    // 3 is a result. An assistant reading a non-zero exit as a crash would stop instead of reporting what was found.
    expect(skill).toMatch(/`3` is a result rather than an error/);
    // The detail is in the JSON; the table rounds it off.
    expect(skill).toMatch(/probabilities/);
    // And a finding is a belief about a method, not a located defect on a line.
    expect(skill).toMatch(/adjacent/i);
    expect(skill).toMatch(/Not a located defect/);
  });
});
