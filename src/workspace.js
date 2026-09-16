/** How test commands run in the operator's checkout during a fix. */

export const COMMAND_MS = 5 * 60_000;
/** perch's own configuration never reaches a test run: model-written tests must not see credentials, and a project's tests must not read perch's .env. */
export const WITHHELD = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'TYPESAFE_API_KEY'];
export const workspaceEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([key]) => !WITHHELD.includes(key)));
