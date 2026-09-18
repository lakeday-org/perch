/**
 * Whether perch can run here at all.
 *
 * This is the half of `perch doctor` that has to work when nothing else does. A report about the last run is no use to someone
 * whose key is missing or whose git is not on the path: they have no last run, and the thing they need to be told is the one
 * sentence saying why. So every check is a question with a yes or no, what it found, and what to do when the answer is no.
 *
 * Nothing here calls the model or reads your code. It is the environment, the tools and the files perch needs, and it is safe to
 * run on a machine where everything is broken.
 */
import { access, constants, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseQuestions } from './ask.js';
import { git } from './git.js';
import { RULES_FILE } from './units.js';

/** Node has to be new enough for what the parser and the client use. package.json says so; this is the same number. */
export const NEEDS_NODE = 22;

const ok = (name, found) => ({ name, ok: true, found });
const bad = (name, found, fix) => ({ name, ok: false, found, fix });

/**
 * Every check, in the order they stop mattering. A key you do not have makes the rest moot, so it comes first; a rule file that
 * does not parse only matters once perch can run at all.
 */
export async function runChecks({ root, out, env, versions }) {
  const checks = [];

  const major = Number(String(versions.node).replace(/^v/, '').split('.')[0]);
  checks.push(major >= NEEDS_NODE
    ? ok('node', versions.node)
    : bad('node', versions.node, `perch needs node ${NEEDS_NODE} or newer`));

  checks.push(env.TYPESAFE_API_KEY
    ? ok('key', `TYPESAFE_API_KEY, ${env.TYPESAFE_API_KEY.length} characters`)
    : bad('key', 'TYPESAFE_API_KEY is not set', 'export it, or put it in a .env beside the repository'));

  const version = await git(['--version'], root).then(text => text.trim()).catch(error => error);
  checks.push(typeof version === 'string'
    ? ok('git', version)
    : bad('git', version.message.split('\n')[0], 'perch reads code out of git, so git has to be on the path'));

  const inside = await git(['rev-parse', '--show-toplevel'], root).then(text => text.trim()).catch(() => null);
  checks.push(inside
    ? ok('repository', relativeTo(root, inside))
    : bad('repository', `${root} is not in a git repository`, 'perch reads a commit, so it needs one; git init and commit something'));

  const head = inside ? await git(['rev-parse', '--short', 'HEAD'], root).then(text => text.trim()).catch(error => error) : null;
  if (inside) checks.push(typeof head === 'string'
    ? ok('commit', head)
    : bad('commit', 'the repository has no commits', 'perch reads a commit, so commit something first'));

  const writable = await access(out, constants.W_OK).then(() => true).catch(() => null)
    ?? await access(join(out, '..'), constants.W_OK).then(() => true).catch(() => false);
  checks.push(writable
    ? ok('results', out)
    : bad('results', `${out} cannot be written`, 'point --out somewhere writable'));

  // A rule file perch cannot read stops every command, so it is worth saying which line before you find out mid-scan.
  const rules = await readFile(join(root, RULES_FILE), 'utf8').catch(() => null);
  if (rules === null) checks.push(ok('rules', `no ${RULES_FILE}, so perch asks only its own questions`));
  else {
    try {
      const parsed = parseQuestions(rules, RULES_FILE, 'rule');
      checks.push(ok('rules', `${parsed.length} in ${RULES_FILE}`));
    } catch (error) {
      checks.push(bad('rules', error.message, `fix ${RULES_FILE}; every command reads it`));
    }
  }
  return checks;
}

const relativeTo = (root, inside) => (root === inside ? inside : `${inside} (you are in ${root})`);
