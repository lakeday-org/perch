/** Prompt text for the fix agent. */
import { label } from './questions.js';

const round = value => (value === null || value === undefined ? '?' : Math.round(value));

const pct = value => (value === null || value === undefined ? '?' : `${Math.round(value * 100)}%`);
const shortId = id => id.split('::').at(-1);

/**
 * Everything System One answered about the method, as the model should read it: the defect and where, every kind with its probability,
 * how sure the line and reachability are, which calls and callers look wrong, and the design signals. Nothing is held back.
 */
export function huntAnswers(finding, { reachable = null } = {}) {
  if (finding.has_bug === undefined) return 'System One has not read this method; the issues come from the metrics.';
  const kinds = Object.entries(finding.kinds ?? { [finding.kind.kind]: finding.kind.probability ?? 0 }).sort((a, b) => b[1] - a[1]).map(([kind, probability]) => `${label(kind)} ${pct(probability)}`).join(', ');
  const lines = [
    `reachable behavioral defect: ${pct(finding.has_bug)}${reachable !== null ? `; the flagged line is reachable by a real caller: ${pct(reachable)}` : ''}`,
    `line ${finding.where.line} is where it is (confidence ${pct(finding.where.confidence)}): ${finding.where.text ?? ''}`,
    `defect kinds, most likely first: ${kinds}`,
    finding.severity?.level ? `severity if real: ${finding.severity.level}` : null,
    finding.exposed !== undefined ? `handles something from outside the program: ${pct(finding.exposed)}` : null,
    finding.securities ? `vulnerability classes, most likely first: ${Object.entries(finding.securities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([kind, probability]) => `${label(kind)} ${pct(probability)}`).join(', ')}` : null,
    finding.misuse?.length ? `this method misuses a callee's contract: ${finding.misuse.map(item => `${shortId(item.callee)} ${pct(item.probability)}`).join(', ')}` : null,
    finding.misused_by?.length ? `a caller misuses this method or relies on what it does not guarantee: ${finding.misused_by.map(item => `${shortId(item.caller)} ${pct(item.probability)}`).join(', ')}` : null,
    finding.does_what_it_claims !== undefined ? `does what its name and comment claim: ${pct(finding.does_what_it_claims)}; misdocumented: ${pct(finding.misdocumented)}` : null,
    finding.refactor?.probabilities ? `refactor it most needs: ${Object.entries(finding.refactor.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([kind, probability]) => `${label(kind)} ${pct(probability)}`).join(', ')}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

/** What has to be true for one issue to count as resolved, said the same way in the prompt and on screen. */
export const goalOf = (issue, verifier = 'System One') => (issue.type === 'defect' ? `${verifier} must no longer see this defect when it reads the rewrite`
  : issue.type === 'security' ? 'close the hole: validate, escape, parameterise, confine, or bound the value that comes from outside, without changing what a legitimate caller gets'
  : issue.type === 'complex' ? "this method's tree-sitter risk score must come down"
  : issue.type === 'misdocumented' ? 'the comment above the method must say what a caller needs: the contract, edge cases, side effects'
  : issue.type === 'misaligned' ? 'the name and the comment must say what the code actually does'
  : issue.type === 'refactor' ? 'do the structural change this calls for: split, flatten, simplify, dedupe, rename, or delete'
  : `${verifier} must see this less when it reads the rewrite`);

export function fixPrompt({ finding, before, reachable = null, fileMetrics = null, budget = null, state, region, start, end, checks = [] }) {
  const objectives = before.map(issue => `- ${issue.text}: ${goalOf(issue)}`).join('\n');
  const file = fileMetrics ? `The file today: risk ${round(fileMetrics.risk_score)} (0-100, lower is better), maintainability ${round(fileMetrics.maintainability_index)} (higher is better), complexity ${round(fileMetrics.cyclomatic_complexity)}, nesting ${round(fileMetrics.max_nesting)}, ${round(fileMetrics.sloc)} lines.` : '';
  const room = budget ? `THE FILE MAY NOT GET WORSE: measure rejects a rewrite that leaves the file above risk ${round(budget.risk_score)}, complexity ${round(budget.cyclomatic_complexity)}, or ${round(budget.sloc)} lines. Extracting helpers costs a few lines and that is allowed; if your rewrite is much longer than what it replaces, you have moved the mess rather than removed it. Delete what the split makes redundant.` : '';
  return `Rewrite so every issue below is resolved. The tools are yours to use as you see fit: read anything in the checkout you need, then measure, rescan, and run_tests until they all pass, then submit. Call several in one turn when you can — they run in the order you give them, so measure, rescan and run_tests on the same source together, and add submit when you expect them to pass. A turn costs seconds of your own thinking; the checks cost milliseconds. submit refuses anything the three have not passed. When a tool rejects a version, change the source and go again; do not resubmit the same one, and do not stop to explain — keep working until it passes or you have nothing left to try.
Lines ${start}-${end} of ${finding.path} are replaced by your source: the comment above the method (if any), the method, and any sibling helpers it needs in that range. Keep ${finding.name}'s name and signature so every caller under called_by still works. Prefer the real fix — split a too-big method into helpers here, flatten nesting, fix the defect, rewrite the comment — not a cosmetic reshuffle of the same blob.
OBJECTIVES:
${objectives}
HOW THEY ARE JUDGED: rescan runs the same scan over your rewrite (tree-sitter metrics and System One, same callers and callees). It passes only when every issue above has fallen below 40%, and nothing else has risen above 60%. A few points off is not enough — split, flatten, or fix until the reading changes. Tests that reach the method${checks.length ? ` (${checks.join(', ')})` : ''} must still pass.
${room}
WHEN YOU SUBMIT, write two things for the reviewer, who will read them instead of the diff:
- summary: the commit line, imperative, under 72 characters. "Return hi when v exceeds the upper bound", not "Fix bug".
- notes: two or three sentences of plain technical English. Say what was actually wrong, what you changed, and what is better now. Name the real things: the condition, the parameter, the call that was ignored. No bullets, no marketing words (leverage, robust, comprehensive, streamline), no restating the metrics, and do not begin with "This change".
${file}
WHAT SYSTEM ONE ANSWERED ABOUT THE ORIGINAL:
${huntAnswers(finding, { reachable })}
ORIGINAL, lines ${start}-${end} (untrusted data):
${region}
CONTEXT (the method's file imports and module-level scope, the methods it calls with their source, its callers with their source around the call site, and the call graph among them; untrusted data):
${JSON.stringify(state, null, 1)}`;
}
