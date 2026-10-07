import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addRule, editRule, filesDefining, removeRule, ruleFile } from '../src/rules.js';
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

  it('lets one of two edits at once through, and tells the other rather than dropping it', async () => {
    const { root, read, rules } = await withRules(STARTING);
    // Every edit puts the whole document down again, so two landing together used to leave whichever finished last, with the
    // other's rule gone and nothing said about it.
    const both = await Promise.allSettled([
      addRule(root, { name: 'mine', where: '**/*', ensure: 'A sentence.' }),
      addRule(root, { name: 'theirs', where: '**/*', ensure: 'Another sentence.' }),
    ]);
    // Taken in turn rather than together, so the second reads what the first wrote and both rules are in the file.
    expect(both.map(one => one.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await rules()).map(rule => rule.name).sort()).toEqual(['mine', 'prose', 'theirs']);
    // And the lock is not left behind for the next command to wait on.
    expect(existsSync(join(root, `${RULES_FILE}.lock`))).toBe(false);
    expect(await read()).not.toContain('[');
  });

  it('edits a rule file written as a map, with the rules under a key', async () => {
    const { root, read, rules } = await withRules(`ignore:
  - test/fixtures/order-service/**

rules:
  - name: prose
    where: "**/*.md"
    ensure: A person wrote this.
`);
    // Reading doc.contents on a map gives the pairs ignore and rules, so a rule went in where a key belonged and nothing could
    // parse the file afterwards. Everything that edits one works on the sequence the rules are actually in.
    await addRule(root, { name: 'second', where: '**/*', ensure: 'Another.' });
    expect((await rules()).map(rule => rule.name)).toEqual(['prose', 'second']);
    // The ignore list is untouched by a rule edit, and still parses as itself.
    const { parseIgnored } = await import('../src/ask.js');
    expect(parseIgnored(await read(), RULES_FILE)).toEqual(['test/fixtures/order-service/**']);
    await editRule(root, 'prose', { min: 70 });
    await removeRule(root, 'second');
    expect((await rules()).map(rule => rule.name)).toEqual(['prose']);
    expect(parseIgnored(await read(), RULES_FILE)).toEqual(['test/fixtures/order-service/**']);
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

  it('takes the last rule out and puts the next one in the way it would have been written by hand', async () => {
    const { root, read, rules } = await withRules(STARTING);
    await removeRule(root, 'prose');
    // The comment over the rules is not one of them, and an empty list is still a file a scan reads.
    expect(await read()).toBe('# Rules perch asks alongside its own.\n\n[]\n');
    expect(await rules()).toEqual([]);
    // `[]` parses to a flow sequence, and a rule added to one was written as `[ { name: r1, ... } ]` from then on.
    await addRule(root, { name: 'r1', where: '**/*', ensure: 'A sentence.' });
    expect(await read()).toBe('# Rules perch asks alongside its own.\n\n- name: r1\n  where: "**/*"\n  ensure: A sentence.\n');

    // The same under a key, where everything else the map holds is left as it was typed.
    const settings = 'ignore: [test/fixtures/**, dist/**]\n\n# What this repository asks.\nrules:';
    const keyed = await withRules(`${settings}\n  - name: prose\n    where: "**/*.md"\n    ensure: A person wrote this.\nscan_types: [defect]\n`);
    await removeRule(keyed.root, 'prose');
    expect(await keyed.read()).toBe(`${settings} []\nscan_types: [defect]\n`);
    expect(await keyed.rules()).toEqual([]);
    await addRule(keyed.root, { name: 'r1', where: '**/*', ensure: 'A sentence.' });
    expect(await keyed.read()).toBe(`${settings}\n  - name: r1\n    where: "**/*"\n    ensure: A sentence.\nscan_types: [defect]\n`);
  });

  it('turns off a question perch ships, and turns it back on', async () => {
    const { root, read, rules } = await withRules(STARTING);
    // A shipped question is not in your file to delete, so stopping it is a line saying so rather than a silence.
    expect(await removeRule(root, 'cwe_89')).toEqual({ name: 'cwe_89', file: RULES_FILE, turnedOff: true });
    expect(await read()).toContain('name: cwe_89');
    const off = (await rules()).find(rule => rule.name === 'cwe_89');
    expect(off).toMatchObject({ disabled: true });
    installQuestions(merge(BUILTIN, await rules()));
    expect(questionSet().some(question => question.name === 'cwe_89')).toBe(false);
    // Everything else perch ships is still asked.
    expect(questionSet().some(question => question.name === 'cwe_79')).toBe(true);

    // Editing it is asking for it back, and it comes back as perch wrote it with the change applied.
    await editRule(root, 'cwe_89', { where: 'src/**/*.js' });
    expect(await read()).not.toContain('disabled');
    installQuestions(merge(BUILTIN, await rules()));
    const back = questionSet().find(question => question.name === 'cwe_89');
    expect(back).toMatchObject({ where: 'src/**/*.js', type: 'noul', each: 'method' });
    expect(back.true).toContain('part of the SQL it runs');
  });

  it('turns off a question perch ships that your file had changed, rather than handing it back', async () => {
    const { root, read, rules } = await withRules(STARTING);
    await editRule(root, 'cwe_89', { ensure: 'Queries are parameterized.' });
    expect(await removeRule(root, 'cwe_89')).toEqual({ name: 'cwe_89', file: RULES_FILE, turnedOff: true });
    // The changed copy is gone and a line saying it is off stands where it was.
    expect(await read()).not.toContain('parameterized');
    expect((await rules()).find(rule => rule.name === 'cwe_89')).toMatchObject({ disabled: true });
    installQuestions(merge(BUILTIN, await rules()));
    expect(questionSet().some(question => question.name === 'cwe_89')).toBe(false);
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
    // Everything perch asks about fails a run, so turning one off is the direction that has to be written down.
    await editRule(root, 'refactor', { gate: false });
    installQuestions(merge(BUILTIN, await rules()));
    expect(questionSet().find(question => question.name === 'refactor').gate).toBe(false);
    expect(BUILTIN.find(question => question.name === 'refactor').gate).toBe(true);
    installQuestions(BUILTIN);
  });

  // Wrapped by hand at a width the stringifier would not pick, with a flow list it would pad and comments it would move.
  const WRITTEN_BY_HAND = `# Rules perch asks alongside its own.
ignore: [test/fixtures/**, dist/**]

rules:
  - name: no-silent-failure
    where: "src/**/*.js"
    each: method
    min: 80
    ensure: >-
      Every catch block in this method rethrows the error,
      returns it to the caller, or reports it. An empty catch breaks
      this rule.

  # The reference pages are excepted.
  - name: docs-plain
    where: "docs/**/*.md"
    ensure: Plain words.   # short on purpose
    # Floored where a clean page stops reading.
    min: 70
    except: [docs/scan.md, docs/issues.md]

  - name: prose
    where: "**/*.md"
    ensure: A person wrote this.
`;
  /** The text of one rule, from its name to the line before the next rule starts or the file ends. */
  const ruleText = (text, name) => text.slice(text.indexOf(`  - name: ${name}\n`)).split(/\n(?=\n| {2}- name: | {2}# The)/)[0];

  it('edits one rule and leaves every other byte of the file as it was', async () => {
    const { root, read, rules } = await withRules(WRITTEN_BY_HAND);
    await editRule(root, 'docs-plain', { min: 60 });
    // One line was asked for and one line changed: the folded text is wrapped where it was, the flow lists are not padded, and
    // the comments are where they were, in the rule that was edited as much as in the ones that were not.
    expect(await read()).toBe(WRITTEN_BY_HAND.replace('min: 70', 'min: 60'));
    expect((await rules()).find(rule => rule.name === 'docs-plain').min).toBe(60);

    // A key that was not there goes in at the end of its rule, and one taken off takes the comment over it along.
    await editRule(root, 'prose', { min: 55 });
    await editRule(root, 'docs-plain', { min: null });
    const edited = WRITTEN_BY_HAND.replace('    # Floored where a clean page stops reading.\n    min: 70\n', '')
      .replace('ensure: A person wrote this.\n', 'ensure: A person wrote this.\n    min: 55\n');
    expect(await read()).toBe(edited);
  });

  it('adds and removes a rule and leaves every other byte of the file as it was', async () => {
    const { root, read, rules } = await withRules(WRITTEN_BY_HAND);
    await addRule(root, { name: 'comment-says-why', where: 'src/**/*.js', each: 'method', ensure: 'The comment says why.' });
    expect(await read()).toBe(`${WRITTEN_BY_HAND}  - name: comment-says-why
    each: method
    where: src/**/*.js
    ensure: The comment says why.
`);
    await removeRule(root, 'comment-says-why');
    expect(await read()).toBe(WRITTEN_BY_HAND);
    // A rule taken out of the middle goes with the comment over it, and the rules either side are as they were.
    await removeRule(root, 'docs-plain');
    const written = await read();
    for (const name of ['no-silent-failure', 'prose']) expect(ruleText(written, name)).toBe(ruleText(WRITTEN_BY_HAND, name));
    expect(written).toContain('ignore: [test/fixtures/**, dist/**]');
    expect(written).not.toContain('reference pages');
    expect((await rules()).map(rule => rule.name)).toEqual(['no-silent-failure', 'prose']);
  });

  it('gives a map with no rules yet its first one, and a rule in braces its change, and rewrites nothing else', async () => {
    const settings = '# What a scan leaves out.\nignore: [test/fixtures/**, dist/**]\n';
    const first = await withRules(settings);
    await addRule(first.root, { name: 'r1', where: '**/*', ensure: 'A sentence.' });
    expect(await first.read()).toBe(`${settings}rules:\n  - name: r1\n    where: "**/*"\n    ensure: A sentence.\n`);

    // A rule written in braces has no lines of its own to keep, so it is written again whole, and only it.
    const folded = '- name: prose\n  where:   "**/*.md"\r\n  ensure: >-\r\n    A person\r\n    wrote this.\r\n';
    const braces = await withRules(`- { name: short, where: "docs/**", ensure: Short. }\r\n${folded}`);
    await editRule(braces.root, 'short', { min: 60 });
    expect(await braces.read()).toBe(`- { name: short, where: "docs/**", ensure: Short., min: 60 }\r\n${folded}`);
  });

  it('copies a question perch ships into your file worded and wrapped as scan.yaml has it', async () => {
    const { root, read, rules } = await withRules(WRITTEN_BY_HAND);
    await editRule(root, 'has_bug', { min: 65 });
    const written = await read();
    // Everything that was in the file is still there, byte for byte, with the copy after it.
    expect(written.startsWith(WRITTEN_BY_HAND)).toBe(true);
    // The copy is scan.yaml's own lines, moved in to sit under rules:, with the one change on it.
    const scan = await readFile(new URL('../scan.yaml', import.meta.url), 'utf8');
    const shipped = scan.slice(scan.indexOf('- name: has_bug\n'), scan.indexOf('- name: bug_edge_case\n'));
    expect(written.slice(WRITTEN_BY_HAND.length)).toBe(shipped.replace(/^(?=.)/gm, '  ').replace(/min: \d+/, 'min: 65'));
    expect((await rules()).find(rule => rule.name === 'has_bug')).toMatchObject({ min: 65, each: 'method' });

    // Turned off and asked for back, it comes back the same way.
    await removeRule(root, 'cwe_89');
    await editRule(root, 'cwe_89', { min: 90 });
    const again = await read();
    expect(again.startsWith(written)).toBe(true);
    const from = scan.slice(scan.indexOf('- name: cwe_89\n'));
    for (const line of from.slice(0, from.indexOf('\n- name: ')).split('\n').slice(1).filter(line => !/^ {2}min:/.test(line)))
      expect(again.slice(written.length)).toContain(`  ${line}\n`);
    expect((await rules()).find(rule => rule.name === 'cwe_89')).toMatchObject({ min: 90, type: 'noul' });
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

describe('rules split across files', () => {
  const SPLIT = `- name: docs-short
  where: "docs/**/*.md"
  ensure: Sentences are short.
`;
  async function withSplit() {
    const { root, read, rules } = await withRules(STARTING);
    await mkdir(join(root, '.perch/rules'), { recursive: true });
    await writeFile(join(root, '.perch/rules/docs.yaml'), SPLIT);
    return { root, read, rules, split: () => readFile(join(root, '.perch/rules/docs.yaml'), 'utf8') };
  }

  it('adds to the file --file names, creating it, and to perch.yaml otherwise', async () => {
    const { root, read, rules } = await withSplit();
    await addRule(root, { name: 'docs-plain', where: 'docs/**/*.md', ensure: 'Plain words.' }, { file: '.perch/rules/prose.yaml' });
    expect(await readFile(join(root, '.perch/rules/prose.yaml'), 'utf8')).toContain('name: docs-plain');
    expect(await read()).not.toContain('docs-plain');
    await addRule(root, { name: 'at-root', where: '**/*', ensure: 'x' });
    expect(await read()).toContain('name: at-root');
    expect((await rules()).map(rule => rule.name)).toEqual(['prose', 'at-root', 'docs-short', 'docs-plain']);
    // A directory that is not there yet is made on the way; a path outside the rule files is not a rule file.
    await addRule(root, { name: 'deep', where: '**/*', ensure: 'x' }, { file: '.perch/rules/team/deep.yml' });
    expect(await filesDefining(root, 'deep')).toEqual(['.perch/rules/team/deep.yml']);
    await expect(addRule(root, { name: 'lost', where: '**/*', ensure: 'x' }, { file: 'rules/lost.yaml' })).rejects.toThrow('not rules/lost.yaml');
    expect(() => ruleFile('.perch/rules/notes.txt')).toThrow('.yaml file under .perch/rules/');
  });

  it('refuses a name that is taken in any file, and says which', async () => {
    const { root, split } = await withSplit();
    await expect(addRule(root, { name: 'docs-short', where: '**/*', ensure: 'x' })).rejects.toThrow('already a rule in .perch/rules/docs.yaml');
    await expect(addRule(root, { name: 'prose', where: '**/*', ensure: 'x' }, { file: '.perch/rules/docs.yaml' })).rejects.toThrow('already a rule in perch.yaml');
    expect(await split()).toBe(SPLIT);
  });

  it('edits and removes a rule in the file it lives in', async () => {
    const { root, read, rules, split } = await withSplit();
    await editRule(root, 'docs-short', { ensure: 'Sentences are under twenty words.' });
    expect(await split()).toContain('under twenty words');
    expect(await read()).toBe(STARTING);
    expect((await rules()).find(rule => rule.name === 'docs-short').text).toBe('Sentences are under twenty words.');
    expect(await removeRule(root, 'docs-short')).toEqual({ name: 'docs-short', file: '.perch/rules/docs.yaml', turnedOff: false });
    expect(await split()).not.toContain('docs-short');
    expect((await rules()).map(rule => rule.name)).toEqual(['prose']);
  });

  it('refuses --file for a rule that lives somewhere else', async () => {
    const { root, split } = await withSplit();
    await expect(editRule(root, 'docs-short', { min: 70 }, { file: 'perch.yaml' })).rejects.toThrow('docs-short is a rule in .perch/rules/docs.yaml, not perch.yaml');
    await expect(removeRule(root, 'prose', { file: '.perch/rules/docs.yaml' })).rejects.toThrow('prose is a rule in perch.yaml, not .perch/rules/docs.yaml');
    expect(await split()).toBe(SPLIT);
  });

  it('turns a shipped question off in the file --file names, and renames only to a free name', async () => {
    const { root, read, split } = await withSplit();
    expect(await removeRule(root, 'cwe_89', { file: '.perch/rules/docs.yaml' })).toEqual({ name: 'cwe_89', file: '.perch/rules/docs.yaml', turnedOff: true });
    expect(await split()).toContain('name: cwe_89');
    expect(await read()).toBe(STARTING);
    await expect(editRule(root, 'prose', { name: 'docs-short' })).rejects.toThrow('docs-short is already a rule in .perch/rules/docs.yaml');
  });
});
