/** A successful rule operation changes files only within its temporary target root. */
export function check_cwe22_changed_paths_stay_in_root(v, result) {
  const observation = observations.get(v);
  assert(observation, `missing filesystem observation for ${JSON.stringify(v)}`);
  for (const changed of observation.changed) {
    const relative = path.relative(observation.root, changed);
    assert(relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)), `input ${JSON.stringify(v)} changed path ${changed} outside root ${observation.root}`);
  }
}

/** A rule operation does not alter a file reached through a symlink or hard link. */
export function check_cwe59_external_link_target_unchanged(v, result) {
  const observation = observations.get(v);
  assert(observation, `missing link observation for ${JSON.stringify(v)}`);
  const after = observations.get(v);
  assert(after.sentinelBefore.equals(after.sentinelBefore), `sentinel baseline was not a stable buffer for ${JSON.stringify(v)}`);
  assert(!observation.changed.includes(observation.sentinel), `input ${JSON.stringify(v)} changed link target ${observation.sentinel}`);
}