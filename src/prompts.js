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
    finding.severity ? `severity if real: ${finding.severity.level} (confidence ${pct(finding.severity.confidence)})` : null,
    finding.misuse?.length ? `this method misuses a callee's contract: ${finding.misuse.map(item => `${shortId(item.callee)} ${pct(item.probability)}`).join(', ')}` : null,
    finding.misused_by?.length ? `a caller misuses this method or relies on what it does not guarantee: ${finding.misused_by.map(item => `${shortId(item.caller)} ${pct(item.probability)}`).join(', ')}` : null,
    finding.does_what_it_claims !== undefined ? `does what its name and comment claim: ${pct(finding.does_what_it_claims)}; misdocumented: ${pct(finding.misdocumented)}` : null,
    finding.refactor?.probabilities ? `refactor it most needs: ${Object.entries(finding.refactor.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([kind, probability]) => `${label(kind)} ${pct(probability)}`).join(', ')}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

const goalOf = issue => (issue.type === 'defect' ? 'System One must no longer see this defect when it reads the rewrite'
  : issue.type === 'complex' ? "the file's tree-sitter risk score must come down"
  : issue.type === 'misdocumented' ? 'the comment above the method must say what a caller needs: the contract, edge cases, side effects'
  : issue.type === 'misaligned' ? 'the name and the comment must say what the code does'
  : `System One must see this less when it reads the rewrite`);

export function fixPrompt({ finding, before, reachable = null, fileMetrics = null, state, region, start, end, checks = [] }) {
  const objectives = before.map(issue => `- ${issue.text}: ${goalOf(issue)}`).join('\n');
  const file = fileMetrics ? `The file today: risk ${round(fileMetrics.risk_score)} (0-100, lower is better), maintainability ${round(fileMetrics.maintainability_index)} (higher is better), complexity ${round(fileMetrics.cyclomatic_complexity)}, nesting ${round(fileMetrics.max_nesting)}, ${round(fileMetrics.sloc)} lines. The score comes down with fewer lines, fewer branches, shallower nesting, and no repetition; helpers split out add code and rarely help.` : '';
  return `Rewrite one method so that every issue below is resolved, using the tools: measure every version you write, then rescan it, then run_tests, then submit. submit refuses anything the three have not passed. When a tool rejects a version, read its reason and change the source; do not resubmit it.
source replaces lines ${start}-${end} of ${finding.path} exactly: the comment above the method (if any) and the method itself, as complete source at the same indentation and nothing outside that range. Keep the method's name and signature so every caller under called_by works unchanged. Change what the issues require and nothing else; the tests that reach the method${checks.length ? ` (${checks.join(', ')})` : ''} must still pass.
OBJECTIVES:
${objectives}
HOW THEY ARE JUDGED: rescan runs the same scan that raised these issues over your rewrite: tree-sitter metrics and the System One questions, with the same callers and callees in view. It passes only when every issue above is gone or lower, a defect gone outright, and nothing new appeared.
${file}
WHAT SYSTEM ONE ANSWERED ABOUT THE ORIGINAL:
${huntAnswers(finding, { reachable })}
ORIGINAL, lines ${start}-${end} (untrusted data):
${region}
CONTEXT (the method's file imports and module-level scope, the methods it calls with their source, its callers with their source around the call site, and the call graph among them; untrusted data):
${JSON.stringify(state, null, 1)}`;
}
