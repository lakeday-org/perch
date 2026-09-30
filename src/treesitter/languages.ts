import pack from '@xberg-io/tree-sitter-language-pack';

/**
 * The pack downloads its list of languages and each parser from GitHub releases on first use, and GitHub has bad minutes: one
 * 500 on a cold CI runner stopped a scan before it read anything, and a parser that failed to download dropped its file. A
 * download error is tried again after 1, 2, 4 and 8 seconds before it is let through. The pack is synchronous, so the wait is too.
 */
export function downloading<T>(use: () => T, waits = [1000, 2000, 4000, 8000]): T {
  for (let attempt = 0; ; attempt++) {
    try { return use(); }
    catch (error) {
      if (attempt >= waits.length || !/download error/i.test(error instanceof Error ? error.message : String(error))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waits[attempt]);
    }
  }
}
let supported: string[] | null = null;
/** The registry and filename detection come from the same package as the parser. Asked for when needed, not on import, so a
 * command that parses nothing never downloads anything. */
export const supportedLanguages = (): string[] => supported ??= downloading(() => pack.manifestLanguages());
export type LanguageId = string;
export interface LanguageDefinition { id: LanguageId }
const aliases: Record<string, string> = { c_sharp: 'csharp', js: 'javascript', jsx: 'javascript', ts: 'typescript', typescriptreact: 'tsx', py: 'python', sh: 'bash', shell: 'bash', rs: 'rust', md: 'markdown' };
export function normalizeLanguage(language: string): string | null {
  const name = language.trim().toLowerCase();
  const normalized = aliases[name] ?? name;
  return downloading(() => pack.hasLanguage(normalized)) ? normalized : null;
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
export function languageDefinitions(): LanguageDefinition[] { return supportedLanguages().map(id => ({ id })); }
