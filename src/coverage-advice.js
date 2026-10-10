/**
 * What test to add for a survived mutant, in one sentence, from the kind of edit it is. The sentence is fixed wording around the
 * report's own facts: the line, and the text the edit changed. It says what a test has to tell apart, not how to write it.
 */
import { droppedCall, droppedName } from './mutants.js';

/** A piece of code in a sentence, cut to one line of it. */
const edit = text => {
  const one = String(text ?? '').trim().replace(/\s+/g, ' ');
  return `\`${one.length > 60 ? `${one.slice(0, 57)}…` : one}\``;
};

/** The other value of a forced condition: a test is missing for the case the mutant removed. */
const otherBranch = to => (/^(true|True)$/.test(String(to).trim()) ? 'false' : 'true');

export function adviceFor(mutant) {
  const line = mutant.line;
  switch (mutant.kind) {
    case 'body': return 'Add a test that fails when the method does nothing.';
    case 'removal': return `Add a test that fails when ${edit(mutant.from)} is not called.`;
    case 'method': return droppedCall(mutant)
      ? `Add a test that fails when \`${droppedName(mutant)}\` is not called on line ${line}.`
      : `Add a test for which \`${mutant.from}\` and \`${mutant.to}\` give different results on line ${line}.`;
    case 'collection': return `Add a test that asserts on the contents of ${edit(mutant.from)} at line ${line}.`;
    case 'chaining': return `Add a test in which the value before \`${mutant.from === '?' ? '?.' : mutant.from}\` on line ${line} is missing.`;
    case 'lambda': return `Add a test that asserts on what the arrow function at line ${line} returns.`;
    case 'regex': return `Add a test with an input that ${edit(mutant.from)} and ${edit(mutant.to)} match differently.`;
    case 'block': return `Add a test that fails when the block at line ${line} is skipped.`;
    case 'condition': return `Add a test in which the condition at line ${line} is ${otherBranch(mutant.to)}, and assert on what follows.`;
    case 'boundary': return `Add a test at the boundary of ${edit(mutant.from)} on line ${line}, where ${edit(mutant.from)} and ${edit(mutant.to)} give different results.`;
    case 'logic': return `Add a test in which only one side of ${edit(mutant.from)} on line ${line} holds.`;
    case 'string': return `Add a test that asserts on the text ${edit(mutant.from)} at line ${line}.`;
    case 'number': return `Add a test that asserts on the value ${edit(mutant.from)} at line ${line}.`;
    case 'return': return `Add a test that asserts on what line ${line} returns.`;
    case 'arithmetic': case 'update': return `Add a test that asserts on the arithmetic at line ${line}, where ${edit(mutant.from)} can become ${edit(mutant.to)}.`;
    default: return `Add a test that asserts on the result of line ${line}, where ${edit(mutant.from)} can become ${edit(mutant.to)} unnoticed.`;
  }
}

/**
 * The test to add for a method, from its surest survived mutant, and how many more edits survive beside it. `mutants` are the
 * method's listed survived mutants, surest first.
 */
export function methodAdvice(mutants) {
  if (!mutants.length) return '';
  const more = mutants.length - 1;
  return `${adviceFor(mutants[0])}${more ? ` ${more} more ${more === 1 ? 'edit survives' : 'edits survive'}.` : ''}`;
}
