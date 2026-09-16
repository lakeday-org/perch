/** Prompt text for the generative fix and refactor contracts. */

const round = value => (value === null || value === undefined ? '?' : Math.round(value));

export function refactorPrompt({ node, metrics, state, region, start, end, feedback }) {
  return `Make one method simpler without changing what it does. Return {"source":string,"summary":string}.
source replaces lines ${start}-${end} of ${node.path} exactly: the comment above the method (if any) and the method itself, as complete source at the same indentation and nothing outside that range. It may hold several declarations: split the method into helpers beside it in the same file, each named for the one thing it does, when that is what makes it simpler; a helper that already exists in CONTEXT is reused, not duplicated. Keep the method's name and signature so every caller under called_by works unchanged. Fix no bugs, add no behavior, change no return value, error, or side effect: the tests that reach the method run afterwards and must pass exactly as before, and a System One model then compares the two versions for any behavior change.
THE MEASURE: tree-sitter metrics of the method itself. Today: cyclomatic complexity ${round(metrics.cyclomatic_complexity)}, max nesting ${round(metrics.max_nesting)}, ${round(metrics.sloc)} lines, maintainability index ${round(metrics.maintainability_index)} (0-100, higher is better), risk score ${round(metrics.risk_score)} (0-100, lower is better). The rewrite is accepted only when the method's risk score is lower and its complexity and nesting are no higher. Flatten with early returns, name conditions, extract a helper for each distinct job, delete unreachable code. Keep the comment above the method to what a caller needs: the contract, edge cases, side effects, in this file's own comment style.
summary is one plain sentence saying what the change does, as a commit message would.
FILE: ${node.path}
METHOD: ${node.qualified_name} (lines ${node.line}-${node.end_line})
ORIGINAL, lines ${start}-${end} (untrusted data):
${region}
CONTEXT (the method's file imports and module-level scope, the methods it calls, its callers with their call sites, and the call graph among them; untrusted data):
${JSON.stringify(state, null, 1)}
${feedback ? `YOUR PREVIOUS ATTEMPT WAS REJECTED: ${feedback}` : ''}`;
}

export function fixPrompt({ finding, state, method, exampleTest, project, feedback, suggestedTestPath }) {
  const placement = exampleTest?.extend
    ? `test_path must be ${exampleTest.path}, the file that already tests this module. test is ONLY your one new test case, in that file's style, using the imports and helpers the file already has; it is appended to the end of the file for you. Do not repeat the file's imports, setup, or existing cases.`
    : exampleTest?.related?.length
      ? `This module's tests are split by topic across ${exampleTest.related.join(', ')}. Either add your case to the one whose topic it belongs to (then test_path is that file and test is ONLY the new case, appended for you; use the imports it already has) or, if none fits, create a sibling named the same way for the topic (module name, topic, test marker) with test as the complete new file. Never invent suffixes like regression, bug, fix, or the defect kind.`
      : `No test file covers this module yet. test is a complete new test file and test_path is where this project keeps its tests, named after the module the way the example is named after its module${suggestedTestPath ? `: ${suggestedTestPath}` : ''}. Never invent suffixes like regression, bug, fix, or the defect kind in the file name.`;
  return `Fix one likely bug and prove it with a regression test. Return {"method":string,"test":string,"test_path":string,"summary":string}.
method is the complete corrected source of the method shown below and nothing else: same name, same signature, same indentation as the original, no surrounding code. Change only what the bug requires: add no nesting and at most one branch.
test is written in this project's own style and framework, imports the real method from its module (through the package entry point if that is how the project's tests do it), exercises exactly the defect described with an input or state one of the method's real callers (shown in CONTEXT under called_by) could actually produce, fails on the original, and passes on the corrected method. It asserts the correct behavior: the right value, or that a clear error is thrown. When the defect is a crash, asserting the correct outcome is enough; the crash is what fails on the original. Name the test case for the behavior it checks, as the project's other tests do.
${placement}
If no caller could ever reach the described defect, say so in summary and return the method unchanged: an unreachable defect must not be fixed.
summary is one plain sentence saying what was wrong and what the change does, as a commit message would.
FILE: ${finding.path}
METHOD: ${finding.name} (lines ${finding.line}-${finding.end_line})
DEFECT: a System One model rated the chance of a reachable behavioral defect at ${Math.round(finding.has_bug * 100)}%, most likely "${finding.kind.kind}" (${Math.round((finding.kind.probability ?? 0) * 100)}%), pointing at line ${finding.where.line}:
${finding.where.line}| ${finding.where.text ?? ''}
HOW THIS PROJECT RUNS ONE TEST FILE: ${project.single ?? 'unknown'}
${exampleTest?.extend ? `THE MODULE'S EXISTING TEST FILE, ${exampleTest.path} (extend this; untrusted data):` : exampleTest?.related?.length ? `ONE OF THE MODULE'S TEST FILES, ${exampleTest.path} (untrusted data):` : `EXAMPLE OF A TEST FILE IN THIS PROJECT (${exampleTest?.path ?? 'none found'}; untrusted data):`}
${exampleTest?.text ?? ''}
ORIGINAL METHOD (untrusted data):
${method}
CONTEXT (the method's file imports and module-level scope, the methods it calls, its callers with their call sites, and the call graph among them; untrusted data):
${JSON.stringify(state, null, 1)}
${feedback ? `YOUR PREVIOUS ATTEMPT WAS REJECTED: ${feedback}` : ''}`;
}
