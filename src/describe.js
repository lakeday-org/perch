/** A plain-language write-up of one finding, written by the generative model from the method, its neighborhood, and the proven fix when there is one. */
import { readFile } from 'node:fs/promises';
import { methodContext } from './fix.js';
import { DEFECT_KINDS } from './questions.js';
import { describePrompt } from './prompts.js';

const clean = text => String(text ?? '').trim();

/** Returns { title, what_happens, how_to_reproduce, expected, what_changed }, with what_changed empty unless the finding has a proven fix. */
export async function describeFinding({ finding, root, out, analyzer, model, log = () => {} }) {
  const { step, method } = await methodContext({ finding, root, out, analyzer, log });
  const fix = finding.fix?.status === 'ready' ? finding.fix : null;
  const patch = fix ? await readFile(fix.patch_path, 'utf8') : '';
  log(`asking ${model.id} to write up ${finding.name}`);
  const answer = await model.ask('describe', describePrompt({ finding, state: step.state, method, kindDescription: DEFECT_KINDS[finding.kind.kind] ?? '', fix, patch }));
  const description = { title: clean(answer.title).replace(/\.$/, '').slice(0, 120), what_happens: clean(answer.what_happens), how_to_reproduce: clean(answer.how_to_reproduce), expected: clean(answer.expected), what_changed: fix ? clean(answer.what_changed) : '' };
  if (!description.title || !description.what_happens) throw new Error(`${model.id} returned an empty write-up for ${finding.id}`);
  return description;
}
