import { createCloudClient, withCurrentToken } from './src/cloud-client.js';
export async function fuzz(v) {
const tokens = v.tokens ?? ['fuzz-test-token'];
const statuses = v.statuses ?? [200];
let tokenIndex = 0;
const getToken = async () => tokens[Math.min(tokenIndex++, tokens.length - 1)];
let calls = 0;
const fetchImpl = async (url, options) => {
const status = statuses[Math.min(calls, statuses.length - 1)] ?? 200;
calls += 1;
const input = JSON.parse(options.body);
const data = { url, input, authorization: options.headers.authorization, calls };
return { ok: status >= 200 && status < 300, status, url, input, authorization: options.headers.authorization, calls, json: async () => status >= 200 && status < 300 ? data : { error: 'fuzz response' } };
};
if (v.case === 'with_current_token') {
let call = 0;
return withCurrentToken(getToken, undefined, async token => ({ status: statuses[Math.min(call, statuses.length - 1)] ?? 200, token, call: ++call }));
}
const env = { PERCH_API_KEY: tokens[0], PERCH_ORGANIZATION: 'fuzz-test-organization', PERCH_REPOSITORY: 'fuzz-test-repository' };
Object.defineProperty(env, 'PERCH_API_KEY', { get: () => tokens[Math.min(tokenIndex++, tokens.length - 1)] });
const client = createCloudClient({ env, getToken, organizationId: env.PERCH_ORGANIZATION, repositoryId: env.PERCH_REPOSITORY, reports: true, fetchImpl, origin: 'https://cloud.test', reportTimeoutMs: 1000, force: v.force });
const api = client.reports ?? client;
if (v.case === 'fetch_impl') return api.fetchImpl(v.url, { method: 'POST', headers: {}, body: JSON.stringify(v.input) });
if (v.case === 'append_findings') return api.appendFindings(v.scanId, v.findings);
if (v.case === 'finish_scan') return api.finishScan(v.scanId, v.scan);
return api.updateScan(v.scanId, v.progress);
}

/** Successful scan operations use the route selected by the operation, independently of scanId. */
export function check_cwe425_scan_route(v, result) {
if (v.case === 'with_current_token' || v.case === 'fetch_impl') return;
const route = v.case === 'append_findings' ? 'append' : v.case === 'finish_scan' ? 'finish' : 'progress';
const expected = `https://cloud.test/v1/scans/${route}`;
assert.strictEqual(result.url, expected, `input scanId ${JSON.stringify(v.scanId)} produced URL ${JSON.stringify(result.url)} instead of ${JSON.stringify(expected)}`);
}

/** Changing scanId does not change the operation-selected request route. */
export async function check_scan_id_route_metamorphism(v, result) {
if (v.case === 'with_current_token' || v.case === 'fetch_impl') return;
const otherInput = { ...v, scanId: `${v.scanId}/../admin` };
const other = await fuzz(otherInput);
assert.strictEqual(other.url, result.url, `scanId transformation changed URL from ${JSON.stringify(result.url)} to ${JSON.stringify(other.url)} for ${JSON.stringify(v.scanId)}`);
}

/** Scan requests preserve their operation fields alongside the configured organization and repository. */
export function check_scan_payload(v, result) {
if (v.case === 'with_current_token' || v.case === 'fetch_impl') return;
const fields = v.case === 'append_findings' ? { scanId: v.scanId, findings: v.findings } : v.case === 'finish_scan' ? { scanId: v.scanId, scan: v.scan } : { scanId: v.scanId, progress: v.progress };
const expected = { organizationId: 'fuzz-test-organization', repositoryId: 'fuzz-test-repository', ...fields };
assert.deepStrictEqual(result.input, expected, `request payload ${JSON.stringify(result.input)} differs from expected ${JSON.stringify(expected)}`);
}

/** Wrapped requests keep the supplied URL and replace configured organization and repository fields. */
export async function check_fetch_impl_configuration(v, result) {
if (v.case !== 'fetch_impl') return;
const expected = { ...v.input, organizationId: 'fuzz-test-organization', repositoryId: 'fuzz-test-repository', ...(v.force ? { force: true } : {}) };
assert.strictEqual(result.url, v.url, `wrapped URL ${JSON.stringify(result.url)} differs from input URL ${JSON.stringify(v.url)}`);
assert.deepStrictEqual(result.input, expected, `wrapped payload ${JSON.stringify(result.input)} differs from expected ${JSON.stringify(expected)}`);
}

/** A 401 is retried once only when the refreshed token differs from the original token. */
export function check_with_current_token_retry(v, result) {
if (v.case !== 'with_current_token') return;
const retry = v.statuses[0] === 401 && v.tokens.length > 1 && v.tokens[1] !== v.tokens[0];
const expectedCall = retry ? 2 : 1;
const expectedToken = v.tokens[Math.min(expectedCall - 1, v.tokens.length - 1)];
assert.strictEqual(result.call, expectedCall, `returned call ${JSON.stringify(result.call)} differs from expected ${expectedCall} for tokens ${JSON.stringify(v.tokens)} and statuses ${JSON.stringify(v.statuses)}`);
assert.strictEqual(result.token, expectedToken, `returned token ${JSON.stringify(result.token)} differs from expected ${JSON.stringify(expectedToken)} for tokens ${JSON.stringify(v.tokens)}`);
}

/** Successful scan requests carry a bearer token selected from the configured token values. */
export function check_authorization_uses_configured_token(v, result) {
if (v.case === 'with_current_token') {
assert(v.tokens.includes(result.token), `returned token ${JSON.stringify(result.token)} is not in configured tokens ${JSON.stringify(v.tokens)}`);
return;
}
if (v.case === 'fetch_impl') {
assert(v.tokens.some(token => result.authorization === `Bearer ${token}`), `authorization ${JSON.stringify(result.authorization)} does not match configured tokens ${JSON.stringify(v.tokens)}`);
return;
}
assert(v.tokens.some(token => result.authorization === `Bearer ${token}`), `authorization ${JSON.stringify(result.authorization)} does not match configured tokens ${JSON.stringify(v.tokens)}`);
}