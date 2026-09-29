/**
 * Extensions perch reads, and the grammar each one is parsed with. Every language here was checked against the analyzer: the parser
 * loads, named methods come back with the right names, and the metrics are computed. Languages whose grammar splits a signature from
 * its body (Dart), or whose functions are macro calls (Elixir), are left out because a method cannot be spliced back as one region.
 *
 * Kept apart from the analyzer so a question can name a language without loading a parser.
 */
const languages = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python', pyi: 'python', rs: 'rust', go: 'go',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', sc: 'scala', groovy: 'groovy', gradle: 'groovy',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cs: 'c_sharp',
  rb: 'ruby', rake: 'ruby', php: 'php', phtml: 'php', lua: 'lua', swift: 'swift', zig: 'zig', sol: 'solidity',
  sh: 'bash', bash: 'bash',
};
export const languageOf = path => languages[path.split('.').at(-1)];

/** Every language ID a question's `language` can name. */
export const LANGUAGES = [...new Set(Object.values(languages))].sort();
