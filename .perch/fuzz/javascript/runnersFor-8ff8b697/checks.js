/** A configured Vitest framework is selected when it is the only configured JavaScript framework. */
export function check_configured_vitest(v, result) {
  if (result === null) return;
  if (v.case !== 'configured_javascript' || !v.frameworks.some(item => item.name === 'Vitest')) return;
  assert(result.name.includes('vitest'), `configured Vitest was not selected for ${JSON.stringify(v)}; got ${result.name}`);
}
/** Karma takes precedence over Vitest and Jest when all are found in scope. */
export function check_configured_karma_precedence(v, result) {
  if (result === null) return;
  const names = v.frameworks.map(item => item.name);
  if (v.case !== 'configured_javascript' || !names.includes('Karma')) return;
  assert(result.name.includes('karma'), `Karma was not selected ahead of other configured frameworks for ${JSON.stringify(v)}; got ${result.name}`);
}
/** A repository with no detected test framework, dependency, or test graph yields no runner. */
export function check_no_runner(v, result) {
  if (v.case !== 'no_runner') return;
  assert.strictEqual(result, null, `unrecognized repository ${JSON.stringify(v)} produced ${result?.name ?? String(result)}`);
}