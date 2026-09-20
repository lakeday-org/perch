import pack from '@xberg-io/tree-sitter-language-pack';

/** The registry and filename detection come from the same package as the parser. */
export const SUPPORTED_LANGUAGES = pack.manifestLanguages();
export type LanguageId = string;
export interface LanguageDefinition { id: LanguageId }
const aliases: Record<string, string> = { c_sharp: 'csharp', js: 'javascript', jsx: 'javascript', ts: 'typescript', typescriptreact: 'tsx', py: 'python', sh: 'bash', shell: 'bash', rs: 'rust', md: 'markdown' };
export function normalizeLanguage(language: string): string | null {
  const name = language.trim().toLowerCase();
  const normalized = aliases[name] ?? name;
  return pack.hasLanguage(normalized) ? normalized : null;
}
export function languageDefinition(language: string): LanguageDefinition | null {
  const id = normalizeLanguage(language);
  return id ? { id } : null;
}
export function languageForPath(path: string): string | null {
  const file = path.split(/[\\/]/).at(-1)!;
  const named: Record<string, string> = { Dockerfile: 'dockerfile', Makefile: 'make', Gemfile: 'ruby', Rakefile: 'ruby', 'CMakeLists.txt': 'cmake' };
  return named[file] ?? pack.detectLanguageFromPath(path);
}
export function languageDefinitions(): LanguageDefinition[] { return SUPPORTED_LANGUAGES.map(id => ({ id })); }
