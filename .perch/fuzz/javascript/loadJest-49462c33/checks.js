/** Any listed test paths exposed by the result are relative paths contained beneath the supplied root. */
export function check_cwe22_test_paths(v, result) {
  if (result == null || !Array.isArray(result.tests)) return;
  for (const path of result.tests) {
    assert(typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..'), `input=${JSON.stringify(v)} returned test path=${JSON.stringify(path)}`);
  }
}