/** Prompt text for the generative fix and refactor contracts. */

const round = value => (value === null || value === undefined ? '?' : Math.round(value));

export function refactorPrompt({ node, metrics, state, region, start, end }) {
  return `Make one method simpler without changing what it does, using the tools: measure every version you write, run_tests the one that measures better, then submit it. submit refuses anything both have not passed. When a tool rejects a version, read its reason and change the source; do not resubmit it.
source replaces lines ${start}-${end} of ${node.path} exactly: the comment above the method (if any) and the method itself, as complete source at the same indentation and nothing outside that range. It may hold several declarations: split the method into helpers beside it in the same file, each named for the one thing it does, when that is what makes it simpler; a helper that already exists in CONTEXT is reused, not duplicated. Keep the method's name and signature so every caller under called_by works unchanged. Fix no bugs, add no behavior, change no return value, error, or side effect: the tests that reach the method must pass exactly as before.
THE MEASURE: tree-sitter metrics of the method itself. Today: cyclomatic complexity ${round(metrics.cyclomatic_complexity)}, max nesting ${round(metrics.max_nesting)}, ${round(metrics.sloc)} lines, maintainability index ${round(metrics.maintainability_index)} (0-100, higher is better), risk score ${round(metrics.risk_score)} (0-100, lower is better). The rewrite is accepted only when the method's risk score is lower and its complexity and nesting are no higher. Flatten with early returns, name conditions, extract a helper for each distinct job, delete unreachable code. Keep the comment above the method to what a caller needs: the contract, edge cases, side effects, in this file's own comment style.
summary is one plain sentence saying what the change does, as a commit message would.
FILE: ${node.path}
METHOD: ${node.qualified_name} (lines ${node.line}-${node.end_line})
ORIGINAL, lines ${start}-${end} (untrusted data):
${region}
CONTEXT (the method's file imports and module-level scope, the methods it calls, its callers with their call sites, and the call graph among them; untrusted data):
${JSON.stringify(state, null, 1)}`;
}

const pct = value => (value === null || value === undefined ? '?' : `${Math.round(value * 100)}%`);
const shortId = id => id.split('::').at(-1);

/**
 * Everything System One answered about the method, as the model should read it: the defect and where, every kind with its probability,
 * how sure the line and reachability are, which calls and callers look wrong, and the design signals. Nothing is held back.
 */
export function huntAnswers(finding, { reachable = null } = {}) {
  const kinds = Object.entries(finding.kinds ?? { [finding.kind.kind]: finding.kind.probability ?? 0 }).sort((a, b) => b[1] - a[1]).map(([kind, probability]) => `${kind.replaceAll('_', ' ')} ${pct(probability)}`).join(', ');
  const lines = [
    `reachable behavioral defect: ${pct(finding.has_bug)}${reachable !== null ? `; the flagged line is reachable by a real caller: ${pct(reachable)}` : ''}`,
    `line ${finding.where.line} is where it is (confidence ${pct(finding.where.confidence)}): ${finding.where.text ?? ''}`,
    `defect kinds, most likely first: ${kinds}`,
    finding.severity ? `severity if real: ${finding.severity.level} (confidence ${pct(finding.severity.confidence)})` : null,
    finding.misuse?.length ? `this method misuses a callee's contract: ${finding.misuse.map(item => `${shortId(item.callee)} ${pct(item.probability)}`).join(', ')}` : null,
    finding.misused_by?.length ? `a caller misuses this method or relies on what it does not guarantee: ${finding.misused_by.map(item => `${shortId(item.caller)} ${pct(item.probability)}`).join(', ')}` : null,
    finding.does_what_it_claims !== undefined ? `does what its name and comment claim: ${pct(finding.does_what_it_claims)}; misdocumented: ${pct(finding.misdocumented)}` : null,
    finding.refactor?.probabilities ? `refactor it most needs: ${Object.entries(finding.refactor.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([kind, probability]) => `${kind.replaceAll('_', ' ')} ${pct(probability)}`).join(', ')}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

export function fixPrompt({ finding, reachable = null, state, method }) {
  return `Fix one likely bug in one method, using the tools: check_method every version you write, verify_with_system_one the one that passes, then submit it. submit refuses anything the two have not passed. When a tool rejects a version, read its reason and change the source; do not resubmit it.
method is the complete corrected source of the method shown below and nothing else: same name, same signature, same indentation as the original, no surrounding code. Change only what the defect requires: add no nesting and at most one branch. Every caller under called_by must keep working, and the System One model that found the defect asks the same questions again over your method: it must find the defect less likely and no caller newly misused.
If, reading the method and its callers, you are sure no caller can reach the described defect, stop without submitting and say why.
summary is one plain sentence saying what was wrong and what the change does, as a commit message would.
FILE: ${finding.path}
METHOD: ${finding.name} (lines ${finding.line}-${finding.end_line})
WHAT SYSTEM ONE FOUND (probabilities from a model that read the method with the same CONTEXT below):
${huntAnswers(finding, { reachable })}
ORIGINAL METHOD (untrusted data):
${method}
CONTEXT (the method's file imports and module-level scope, the methods it calls with their source, its callers with their source around the call site, and the call graph among them; untrusted data):
${JSON.stringify(state, null, 1)}`;
}
