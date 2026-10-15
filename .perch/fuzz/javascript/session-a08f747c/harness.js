import { session } from './src/runners/pytest.js';
export async function fuzz(v) {
  const server = await session({ copies: v.copies, tool: v.tool, parallel: v.parallel });
  let result;
  for (const run of v.runs) result = await server.run(run);
  await server.close();
  return result;
}