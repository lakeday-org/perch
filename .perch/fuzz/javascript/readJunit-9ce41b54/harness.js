import { readJunit, parseXml } from './src/test-reports.js';
export async function fuzz(v) {
  if (v.case === 'read_junit') return readJunit(v.text, v.path);
  return parseXml(v.text, v.path);
}