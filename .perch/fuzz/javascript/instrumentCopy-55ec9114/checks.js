/** A source-matching expression edit is placed and its replacement text appears in the instrumented output. */
export function check_matching_edit_is_rendered(v, result) {
  const item = v.mutants[0];
  assert(!result.unplaced.some(entry => entry.id === item.id), `matching edit ${JSON.stringify(item)} was unplaced: ${JSON.stringify(result.unplaced)}`);
  assert(result.text.includes(item.mutant.to), `instrumented output ${JSON.stringify(result.text)} does not contain replacement ${JSON.stringify(item.mutant.to)}`);
}

/** An edit whose from-text does not match the source is reported as unplaced with its ID. */
export function check_mismatched_source_is_unplaced(v, result) {
  const item = v.mutants[0];
  const entry = result.unplaced.find(candidate => candidate.id === item.id);
  assert(entry, `mismatched edit ${JSON.stringify(item)} was not reported unplaced; output=${JSON.stringify(result.text)}`);
  assert.strictEqual(entry.reason, "the edit is not where the source says", `unexpected reason for mismatched edit ${JSON.stringify(item)}: ${JSON.stringify(entry)}`);
}