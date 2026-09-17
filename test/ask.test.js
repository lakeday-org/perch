import { describe, expect, it } from 'vitest';
import { BUILTIN, check, compile, issues, merge, parseQuestions, setHash, vocabulary } from '../src/ask.js';

const at = 'test.yaml question 1';
const noul = (name, extra = {}) => check({ name, where: '**/*', ask: 'Is it?', true: 'Yes', false: 'No', ...extra }, at);

describe('the question grammar', () => {
  it('ships a set that declares what perch asks, and nothing asks it twice', () => {
    const names = BUILTIN.map(question => question.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['has_bug', 'kind', 'severity', 'refactor', 'exposed', 'injection', 'use_after_free']));
    // Every shipped question is about a method, and the three shapes are all in use.
    expect(new Set(BUILTIN.map(question => question.each))).toEqual(new Set(['method']));
    expect(new Set(BUILTIN.map(question => question.type))).toEqual(new Set(['noul', 'choice', 'score']));
  });

  it('refuses a question it cannot act on, naming the file and what is wrong', () => {
    expect(() => check({ where: '**/*' }, at)).toThrow('every question needs a name');
    expect(() => check({ name: 'q', ask: 'Is it?', true: 'a', false: 'b' }, at)).toThrow('needs where');
    expect(() => check({ name: 'q', where: '**/*', type: 'guess', ask: 'Is it?' }, at)).toThrow('type is noul, choice, score');
    expect(() => check({ name: 'q', where: '**/*', ask: 'Is it?' }, at)).toThrow('a noul needs true and false');
    expect(() => check({ name: 'q', where: '**/*', type: 'score', ask: 'Is it?' }, at)).toThrow('a score needs levels');
    expect(() => check({ name: 'q', where: '**/*', sees: 'everything', ensure: 'x' }, at)).toThrow('sees is self, file, calls');
    // A misspelt key is a question that would quietly never be asked the way it reads.
    expect(() => check({ name: 'q', where: '**/*', ensures: 'x' }, at)).toThrow('ensures is not a key');
    expect(() => check({ name: 'q', where: '**/*', ensure: 'x', issue: { label: 'self' } }, at)).toThrow('an issue needs a type');
    // The noun follows the file: the same grammar reads as rules in perch.yaml and as questions in scan.yaml.
    expect(() => parseQuestions('- ensure: x\n', 'perch.yaml', 'rule')).toThrow('perch.yaml rule 1: every rule needs a name');
  });

  it('writes a rule out as the question it is', () => {
    const rule = check({ name: 'comment-says-why', where: 'src/**/*.js', each: 'method', ensure: 'A comment\n  says why.' }, at);
    expect(rule).toMatchObject({ type: 'noul', kind: 'ensure', text: 'A comment says why.', each: 'method', sees: 'self' });
    expect(compile([rule])['comment-says-why']).toEqual({ type: 'noul', instructions: 'Is `rule` true of the code below?',
      criteria: { true: 'A comment says why.', false: 'Not so: A comment says why.' } });
    // A rule is broken by the answer being no, so the issue is raised on false.
    expect(issues({ 'comment-says-why': 0.2 }, 0, [rule])).toEqual([{ type: 'lint', label: 'comment-says-why', probability: 0.8, floor: 0, text: 'comment-says-why 80%' }]);
    // A rule with a default `each` covers whole files, which is what a rule about prose wants.
    expect(check({ name: 'r', where: '**/*.md', ensure: 'x' }, at).each).toBe('file');
  });

  it('compiles each shape the way System One takes it', () => {
    expect(compile([check({ name: 'k', where: '**/*', type: 'choice', ask: 'Which?', options: { a: 'An a', b: 'A b' } }, at)]).k)
      .toEqual({ type: 'choice', instructions: 'Which?', criteria: { a: 'An a', b: 'A b' } });
    expect(compile([check({ name: 's', where: '**/*', type: 'score', ask: 'How bad?', levels: ['none', 'some'] }, at)]).s)
      .toEqual({ type: 'score', instructions: 'How bad?', criteria: ['none', 'some'] });
  });

  it('reads an answer as the issue the question says it means', () => {
    const set = [
      noul('has_bug', { issue: { type: 'defect', label: 'kind' } }),
      check({ name: 'kind', where: '**/*', type: 'choice', ask: 'Which?', options: { boundary: 'An edge', leak: 'A leak' } }, at),
      noul('exposed'),
      noul('injection', { when: 'exposed', issue: { type: 'security', label: 'self', pick: 'strongest' } }),
      noul('use_after_free', { issue: { type: 'security', label: 'self', pick: 'strongest' } }),
      noul('does_what_it_claims', { issue: { type: 'misaligned', label: 'lies', on: false } }),
      check({ name: 'refactor', where: '**/*', type: 'choice', ask: 'What?', options: { split: 'Too big', none: 'Nothing' }, issue: { type: 'refactor', label: 'refactor', except: 'none' } }, at),
    ];
    const answers = { has_bug: 0.8, kind: { choice: 'boundary', probability: 0.9 }, exposed: 0.5, injection: 0.8, use_after_free: 0.3,
      does_what_it_claims: 0.7, refactor: { choice: 'split', probability: 0.6 } };
    const found = issues(answers, 0, set);
    // A defect is labelled by the choice that names it, not by the question that found it.
    expect(found).toContainEqual(expect.objectContaining({ type: 'defect', label: 'boundary', probability: 0.8 }));
    // Gated, injection is 0.8 x 0.5; ungated, use_after_free stands at 0.3. Only the likelier of the two is listed.
    expect(found.filter(issue => issue.type === 'security')).toEqual([expect.objectContaining({ label: 'injection', probability: 0.4 })]);
    expect(found).toContainEqual(expect.objectContaining({ type: 'misaligned', label: 'lies', probability: 0.30000000000000004 }));
    expect(found).toContainEqual(expect.objectContaining({ type: 'refactor', label: 'split', probability: 0.6 }));
    // `min` is a floor on what is shown, and the list runs strongest first.
    expect(issues(answers, 0.5, set).map(issue => issue.label)).toEqual(['has_bug' in answers ? 'boundary' : '', 'split'].filter(Boolean));
    // An option a question excepts raises nothing: no refactor needed is not a finding.
    expect(issues({ ...answers, refactor: { choice: 'none', probability: 0.9 } }, 0, set).some(issue => issue.type === 'refactor')).toBe(false);
  });

  it('takes a floor from the question, for one the model hedges on', () => {
    const hedged = check({ name: 'comment-says-why', where: 'src/**', min: 70, ensure: 'A comment says why.' }, at);
    // Broken at 60%, which clears the run's floor and not the one the question sets for itself.
    expect(issues({ 'comment-says-why': 0.4 }, 0.5, [hedged])).toEqual([]);
    expect(issues({ 'comment-says-why': 0.2 }, 0.5, [hedged])).toHaveLength(1);
    // The run's floor still speaks for a question that does not set one.
    const plain = check({ name: 'plain', where: 'src/**', ensure: 'x' }, at);
    expect(issues({ plain: 0.4 }, 0.5, [plain])).toHaveLength(1);
    expect(() => check({ name: 'q', where: 'src/**', min: 140, ensure: 'x' }, at)).toThrow('min is a percentage, 0 to 100');
  });

  it('tells a filter what this set can raise, so a typo is answered with the real list', () => {
    const { types, labels } = vocabulary(BUILTIN);
    // A type with one question in it is a label, not a type: what a method does other than what it says is a defect.
    expect(types).toEqual(expect.arrayContaining(['defect', 'security', 'refactor', 'docs']));
    expect(types).not.toContain('misaligned');
    // A defect is labelled by the kinds the `kind` choice offers, not by the word "has_bug".
    expect(labels).toContain('boundary');
    expect(labels).not.toContain('has_bug');
    // `none` is excepted by the refactor question, so nothing can be filtered for it.
    expect(labels).not.toContain('none');
  });

  it('lets a repository reword a question perch ships, and says so in the hash', () => {
    const mine = check({ name: 'has_bug', where: 'src/**/*.js', ask: 'Is it broken?', true: 'Yes', false: 'No' }, 'perch.yaml');
    const set = merge(BUILTIN, [mine]);
    expect(set).toHaveLength(BUILTIN.length);
    expect(set.find(question => question.name === 'has_bug').ask).toBe('Is it broken?');
    // The answers are identified by the questions that produced them, so a reworded question is not read as the old one.
    expect(setHash(set)).not.toBe(setHash(BUILTIN));
    expect(setHash(BUILTIN)).toBe(setHash([...BUILTIN].reverse()));
  });
});
