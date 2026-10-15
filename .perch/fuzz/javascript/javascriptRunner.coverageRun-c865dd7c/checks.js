/** Every test with at least one recorded hit has corresponding executed-line data. */
export function check_hit_lines(v, result) {
  for (const [test, hits] of result.hits) {
    if (hits.size > 0) {
      const lines = result.executed.get(test);
      assert(lines instanceof Map && lines.size > 0, `test ${test} has hits ${JSON.stringify([...hits])} but executed lines ${JSON.stringify(lines ? [...lines] : null)}`);
    }
  }
}