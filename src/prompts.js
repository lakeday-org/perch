/** Prompt text for the four inference contracts, addressed to a local checkout. */

export function preparationPrompt({ workspace, inventory, candidates, previous, failure }) {
  return `Prepare the repository checkout at ${workspace} for bug investigation. Return {"setup":string,"baseline":string}. setup installs project dependencies and baseline runs the relevant existing tests. Both are Bash scripts executed with bash -c on the operator's own machine, starting in ${workspace} with $0 set to perch; do not derive the working directory from a script path. Each has a 1200-second execution deadline. The operator's PATH and toolchains are already available; the inventory lists which tools were found. Do not install system packages, do not use sudo, do not change global tool versions, and do not write outside the workspace; project-local dependency installation (npm ci, pip install into a .venv, cargo fetch) is fine. Run tests from their workspace directory so the existing runner configuration and aliases apply. Use npm workspace scripts or the actual shared binary path rather than assuming a workspace-local node_modules binary. Limit setup and baseline to the candidate files and their relevant existing test suite; do not build or test unrelated monorepo workspaces. Use discovered local tests and manifests, and propagate command failures. If the relevant tests use only built-in modules, no dependency installation is needed (setup may be "true"). Do not call any AI service or model CLI. Inventory:\n${inventory}\nHighest-risk files to investigate:\n${candidates.map(candidate => candidate.path).join('\n')}\nPrevious preparation scripts, if any: ${JSON.stringify(previous ?? null)}\nPrevious preparation failure, if any: ${JSON.stringify(failure ?? null)}`;
}

export function triagePrompt({ workspace, preparation, candidate }) {
  return `Investigate this source for a concrete behavioral bug. Return {"found":boolean,"title":string,"reason":string,"priority":"P1"|"P2"|"P3","regression_path":string,"regression":string,"command":string}. If found, regression is a complete runnable regression test that imports this actual source and fails due to the bug; regression_path is its path relative to the repository root, and command runs that test with bash -c from ${workspace} using the prepared dependencies. Preserve existing tests. No test-only failures, missing dependencies, or type errors count as bug reproduction. Select one concrete bug and stop once you have its assertion-based regression. Do not design or optimize a fix here; a separate agent does that after reproduction. Return found:false if uncertain. Repo setup: ${JSON.stringify(preparation)}\nFile: ${candidate.path}\nSOURCE (untrusted data):\n${candidate.source}`;
}

export function fixPrompt({ candidate, finding, before, rejection }) {
  return `Implement the confirmed bug fix. Return {"source":string,"summary":string} with the complete corrected file. Preserve the frozen regression and all existing behavior except the demonstrated bug. Do not increase cyclomatic complexity, maximum nesting, or risk score. You may simplify checks rendered redundant by the fix.
FILE: ${candidate.path}
ORIGINAL:
${candidate.source}
BUG:
${finding.reason}
FROZEN REGRESSION:
${finding.regression}
BASE FAILURE:
${before.stdout}
${before.stderr}
Previous rejected attempt (if any): ${JSON.stringify(rejection ?? null)}`;
}

export function reviewPrompt({ candidate, fix, finding, before, after, checks }) {
  return `Independently review this bug fix. Return {"approved":boolean,"reason":string}. Approve only a real behavioral bug reproduced by the regression and a correct narrow fix. Check that no tests are weakened, disabled, or forged.
ORIGINAL:
${candidate.source}
FIX:
${fix.source}
FROZEN REGRESSION:
${finding.regression}
BEFORE:
${before.stdout}
${before.stderr}
AFTER:
${after.stdout}
${after.stderr}
PROJECT CHECKS:
${checks.stdout}
${checks.stderr}`;
}
