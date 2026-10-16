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
  sh: 'bash', bash: 'bash', bats: 'bash',
};
/**
 * A `.h` file is C or C++ by the repository it is in: one with C++ sources writes C++ headers, and the C grammar reads a template
 * or a namespace as an error and loses every function after it. C++'s grammar reads a C header as well, so a repository with
 * both is read as C++.
 */
const CPP = new Set(Object.keys(languages).filter(extension => languages[extension] === 'cpp'));
export const headerLanguage = paths => (paths.some(path => CPP.has(path.split('.').at(-1))) ? 'cpp' : 'c');
export const languageOf = (path, header = 'c') => {
  const extension = path.split('.').at(-1);
  return extension === 'h' ? header : languages[extension];
};

/** Every language ID a question's `language` can name. */

/** File review adds document and configuration grammars; these do not claim to have callable code. */
const fileLanguages = { md: 'markdown', mdx: 'markdown', yaml: 'yaml', yml: 'yaml', json: 'json', toml: 'toml',
  tf: 'hcl', tfvars: 'hcl', hcl: 'hcl', html: 'html', htm: 'html', css: 'css', scss: 'scss', xml: 'xml', svg: 'xml',
  ini: 'ini', cfg: 'ini', sql: 'sql', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  vue: 'vue', svelte: 'svelte', ex: 'elixir', exs: 'elixir', dart: 'dart' };
const namedFiles = { Dockerfile: 'dockerfile', Makefile: 'make', 'CMakeLists.txt': 'cmake', Gemfile: 'ruby', Rakefile: 'ruby' };
export const fileLanguageOf = path => namedFiles[path.split('/').at(-1)] ?? fileLanguages[path.split('.').at(-1)];

/** Language IDs usable by questions, including optional file review. */
export const LANGUAGES = [...new Set([...Object.values(languages), ...Object.values(fileLanguages), ...Object.values(namedFiles)])].sort();
