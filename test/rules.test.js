import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addRule, editRule, removeRule } from '../src/rules.js';
import { asRules, readRules, RULES_FILE } from '../src/units.js';
import { BUILTIN, installQuestions, merge, questionSet } from '../src/ask.js';
import { revision } from '../src/git.js';
import { commitAll, initRepo, makeGraphFixture } from './helpers.js';

const cleanups = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** A repository holding a rule file, since reading the rules back reads the tree at a commit. */
async function withRules(text) {
  const root = await mkdtemp(join(tmpdir(), 'perch-rules-'));
  cleanups.push(root);
  await writeFile(join(root, RULES_FILE), text);
  await initRepo(root);
  const read = () => readFile(join(root, RULES_FILE), 'utf8');
  // The rules are read from the working copy, so what was just written is what comes back.
  return { root, read, rules: async () => readRules(root, await revision(root)) };
}

const STARTING = `# Rules perch asks alongside its own.

- name: prose
  where: "**/*.md"
  ensure: A person wrote this.
`;

describe('editing the rule file', () => {
  it('adds a rule and leaves the comments and the order alone', async () => {
    const { root, read, rules } = await withRules(STARTING);
    await addRule(root, { name: 'comment-says-why', where: 'src/**/*.js', each: 'method', ensure: 'The comment says why.' });
    const written = await read();
    expect(written).toContain('# Rules perch asks alongside its own.');
    expect(written.indexOf('name: prose')).toBeLessThan(written.indexOf('name: comment-says-why'));
    expect(written).toContain('each: method');
    // It reads back as the rule that was asked for, through the same reading a scan gives it.
    const back = await rules();
    expect(back.map(rule => rule.name)).toEqual(['prose', 'comment-says-why']);
    expect(back[1]).toMatchObject({ kind: 'ensure', each: 'method', sees: 'self', text: 'The comment says why.' });
  });

  it('refuses a rule the next command would refuse, and writes nothing', async () => {
    const { root, read, rules } = await withRules(STARTING);
    // A method is always read with its callers and callees in view, so asking for more of them says nothing.
    await expect(addRule(root, { name: 'bad', where: 'src/**', each: 'method', sees: 'calls', ensure: 'x' }))
      .rejects.toThrow('a method is always asked with its callers and callees in view');
    await expect(addRule(root, { name: 'bad', where: 'src/**', each: 'everything', ensure: 'x' })).rejects.toThrow('each is file, method, test');
    await expect(addRule(root, { name: 'bad', ensure: 'x' })).rejects.toThrow('needs where');
    // Writing one the next command refuses would wedge the file: every verb parses it, so nothing could list, edit or remove it.
    expect(await read()).toBe(STARTING);
    expect((await rules()).map(rule => rule.name)).toEqual(['prose']);
  });

  it('starts a rule file that is not there yet the way it would have been written by hand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perch-rules-'));
    cleanups.push(root);
    // A repository with no rule file at all, which is every repository until the first rule is added.
    await writeFile(join(root, 'README.md'), '# a\n');
    await initRepo(root);
    await addRule(root, { name: 'r1', where: '**/*', ensure: 'A sentence.' });
    await addRule(root, { name: 'r2', where: 'docs/**/*.md', ensure_absent: 'a page for a command that went' });
    const written = await readFile(join(root, RULES_FILE), 'utf8');
    // `[]` for a file that is not there parses to a flow sequence, and every later edit reparses that and keeps the style, so
    // one missing file at the start meant a rule file nobody could read from then on.
    expect(written).not.toContain('[');
    expect(written.split('\n').filter(Boolean)).toEqual([
      '- name: r1',
      '  where: "**/*"',
      '  ensure: A sentence.',
      '- name: r2',
      '  where: docs/**/*.md',
      '  ensure_absent: a page for a command that went',
    ]);
    // And it reads back as the two rules it says it is.
    expect((await readRules(root, await revision(root))).map(rule => [rule.name, rule.kind]))
      .toEqual([['r1', 'ensure'], ['r2', 'ensure_absent']]);
  });

  it('refuses a name that is taken, since two rules with one name is a report nobody can act on', async () => {
    const { root } = await withRules(STARTING);
    await expect(addRule(root, { name: 'prose', where: '**/*.md', ensure: 'Something else.' })).rejects.toThrow('already a rule');
  });

  it('replaces the assertion when a different one is given, and takes the long way of saying it with it', async () => {
    const { root, read, rules } = await withRules(`- name: docs
  where: "docs/**/*.md"
  type: noul
  ask: Is \`rule\` true of the code below?
  "true": Every command has a page.
  "false": "Not so: Every command has a page."
  ensure: Every command has a page.
`);
    await editRule(root, 'docs', { ensure_absent: 'a page for a command that was removed' });
    const written = await read();
    expect(written).toContain('ensure_absent:');
    for (const gone of ['ensure:', 'ask:', '"true":', '"false":', 'type:']) expect(written).not.toContain(gone);
    expect((await rules())[0]).toMatchObject({ kind: 'ensure_absent', text: 'a page for a command that was removed' });
  });

  it('refuses an edit that would leave a rule it cannot read, and refuses to edit one that is not there', async () => {
    const { root, read } = await withRules(STARTING);
    await expect(editRule(root, 'prose', { each: 'nothing' })).rejects.toThrow('each is file, method, test');
    await expect(editRule(root, 'nowhere', { ensure: 'x' })).rejects.toThrow('no question called nowhere');
    expect(await read()).toBe(STARTING);
  });

  it('removes a rule, and says so when there is nothing to remove', async () => {
    const { root, rules } = await withRules(STARTING);
    await removeRule(root, 'prose');
    expect((await rules()).map(rule => rule.name)).toEqual([]);
    await expect(removeRule(root, 'prose')).rejects.toThrow('no question called prose');
  });

  it('turns off a question perch ships, and turns it back on', async () => {
    const { root, read, rules } = await withRules(STARTING);
    // A shipped question is not in your file to delete, so stopping it is a line saying so rather than a silence.
    expect(await removeRule(root, 'weak_crypto')).toEqual({ name: 'weak_crypto', turnedOff: true });
    expect(await read()).toContain('name: weak_crypto');
    const off = (await rules()).find(rule => rule.name === 'weak_crypto');
    expect(off).toMatchObject({ disabled: true });
    installQuestions(merge(BUILTIN, await rules()));
    expect(questionSet().some(question => question.name === 'weak_crypto')).toBe(false);
    // Everything else perch ships is still asked.
    expect(questionSet().some(question => question.name === 'injection')).toBe(true);

    // Editing it is asking for it back, and it comes back as perch wrote it with the change applied.
    await editRule(root, 'weak_crypto', { where: 'src/**/*.js' });
    expect(await read()).not.toContain('disabled');
    installQuestions(merge(BUILTIN, await rules()));
    const back = questionSet().find(question => question.name === 'weak_crypto');
    expect(back).toMatchObject({ where: 'src/**/*.js', type: 'noul', each: 'method' });
    expect(back.true).toContain('predictable randomness');
  });

  it('changes a question perch ships by copying it into your file, not by editing the package', async () => {
    const { root, read, rules } = await withRules(STARTING);
    await editRule(root, 'has_bug', { ask: 'Is there a bug a caller can reach?' });
    const written = await read();
    expect(written).toContain('name: has_bug');
    expect(written).toContain('Is there a bug a caller can reach?');
    // Copied as it was written, so nothing else about it changes by being moved.
    expect(written).toContain('issue:');
    const mine = (await rules()).find(rule => rule.name === 'has_bug');
    expect(mine).toMatchObject({ ask: 'Is there a bug a caller can reach?', each: 'method' });
    expect(mine.issue).toMatchObject({ type: 'defect', label: 'kind' });
    // And yours is the one in force, with the shipped one no longer counted twice.
    const set = merge(BUILTIN, await rules());
    expect(set.filter(question => question.name === 'has_bug')).toHaveLength(1);
    expect(set.find(question => question.name === 'has_bug').ask).toBe('Is there a bug a caller can reach?');
  });

  it('writes down whether a question fails a run, for one perch ships and one you wrote', async () => {
    const { root, rules } = await withRules(STARTING);
    await addRule(root, { name: 'loose', where: 'docs/**/*.md', gate: false, ensure: 'Docs are short.' });
    // A rule fails a run by default, since it is a claim you made about your own code, and this one says otherwise.
    expect((await rules()).find(rule => rule.name === 'loose').gate).toBe(false);
    // And a question perch ships is turned the other way the same way, by being copied into your file with the change on it.
    await editRule(root, 'refactor', { gate: true });
    installQuestions(merge(BUILTIN, await rules()));
    expect(questionSet().find(question => question.name === 'refactor').gate).toBe(true);
    expect(BUILTIN.find(question => question.name === 'refactor').gate).toBe(false);
    installQuestions(BUILTIN);
  });

  it('lists a question written out longhand, and does not run it as a rule', async () => {
    const root = await makeGraphFixture();
    cleanups.push(root);
    await writeFile(join(root, RULES_FILE), `- name: prose
  where: "**/*.md"
  ensure: A person wrote this.

- name: handles_absence
  type: choice
  each: method
  where: "src/**/*.js"
  ask: How does this method handle a value that is missing?
  options:
    checks: It checks for it
    ignores: It carries on with the missing value
  issue: { type: defect, label: handles_absence, except: checks }
`);
    await commitAll(root, 'rules');
    const questions = await readRules(root, await revision(root));
    // Everything the file holds is listed, or a file could ask something a scan asks without saying so.
    expect(questions.map(question => question.name)).toEqual(['prose', 'handles_absence']);
    // Only the yes-or-no is run as a rule; the other is asked of a method as a question, by the scan.
    expect(asRules(questions).map(rule => rule.name)).toEqual(['prose']);
    expect(questions[1]).toMatchObject({ type: 'choice', kind: null, each: 'method' });
  });
});
