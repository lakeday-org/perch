/** Grammars shipped by the pinned tree-sitter-wasm asset set. */
export const SUPPORTED_LANGUAGES = [
  "ada",
  "angular",
  "arduino",
  "asm",
  "astro",
  "bash",
  "bibtex",
  "c",
  "c_sharp",
  "clojure",
  "cmake",
  "comment",
  "commonlisp",
  "cpp",
  "css",
  "csv",
  "cuda",
  "d",
  "dart",
  "desktop",
  "diff",
  "dockerfile",
  "dtd",
  "editorconfig",
  "elisp",
  "elixir",
  "elm",
  "embedded_template",
  "erlang",
  "fortran",
  "gdscript",
  "gdshader",
  "git_config",
  "git_rebase",
  "gitattributes",
  "gitignore",
  "gleam",
  "glsl",
  "go",
  "godot_resource",
  "graphql",
  "groovy",
  "haskell",
  "hcl",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "julia",
  "just",
  "kdl",
  "kotlin",
  "latex",
  "liquid",
  "lua",
  "make",
  "markdown",
  "markdown_inline",
  "matlab",
  "nginx",
  "nim",
  "nix",
  "objc",
  "ocaml",
  "ocaml_interface",
  "ocaml_type",
  "perl",
  "php",
  "powershell",
  "prisma",
  "proto",
  "psv",
  "python",
  "qmljs",
  "query",
  "r",
  "racket",
  "razor",
  "regex",
  "requirements",
  "rescript",
  "ruby",
  "rust",
  "scala",
  "scheme",
  "sln",
  "solidity",
  "sql",
  "ssh_config",
  "svelte",
  "swift",
  "templ",
  "terraform",
  "toml",
  "tsv",
  "tsx",
  "typescript",
  "typst",
  "vim",
  "vimdoc",
  "vue",
  "xml",
  "yaml",
  "zig",
] as const;

export type LanguageId = (typeof SUPPORTED_LANGUAGES)[number];

export interface LanguageDefinition {
  id: LanguageId;
  grammar_asset: string;
  extensions: readonly string[];
}

const extensionEntries: ReadonlyArray<readonly [LanguageId, readonly string[]]> = [
  ["ada", [".ada", ".adb", ".ads"]],
  ["angular", [".component.html"]],
  ["arduino", [".ino"]],
  ["asm", [".asm", ".s"]],
  ["astro", [".astro"]],
  ["bash", [".sh", ".bash"]],
  ["bibtex", [".bib"]],
  ["c", [".c", ".h"]],
  ["c_sharp", [".cs"]],
  ["clojure", [".clj", ".cljs", ".cljc", ".edn"]],
  ["cmake", [".cmake"]],
  ["commonlisp", [".lisp", ".lsp"]],
  ["cpp", [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".C", ".H"]],
  ["css", [".css"]],
  ["csv", [".csv"]],
  ["cuda", [".cu", ".cuh"]],
  ["d", [".d"]],
  ["dart", [".dart"]],
  ["desktop", [".desktop"]],
  ["diff", [".diff", ".patch"]],
  ["dockerfile", [".dockerfile"]],
  ["dtd", [".dtd"]],
  ["editorconfig", [".editorconfig"]],
  ["elisp", [".el"]],
  ["elixir", [".ex", ".exs"]],
  ["elm", [".elm"]],
  ["embedded_template", [".ejs", ".erb", ".etlua"]],
  ["erlang", [".erl", ".hrl"]],
  ["fortran", [".f", ".f90", ".f95", ".f03", ".f08", ".F", ".F90"]],
  ["gdscript", [".gd"]],
  ["gdshader", [".gdshader"]],
  ["git_config", [".gitconfig"]],
  ["git_rebase", [".git-rebase-todo"]],
  ["gitattributes", [".gitattributes"]],
  ["gitignore", [".gitignore"]],
  ["gleam", [".gleam"]],
  ["glsl", [".glsl", ".vert", ".frag"]],
  ["go", [".go"]],
  ["godot_resource", [".tres", ".tscn"]],
  ["graphql", [".graphql", ".gql"]],
  ["groovy", [".groovy", ".gradle"]],
  ["haskell", [".hs", ".lhs"]],
  ["hcl", [".hcl"]],
  ["html", [".html", ".htm"]],
  ["ini", [".ini"]],
  ["java", [".java"]],
  ["javascript", [".js", ".jsx", ".mjs", ".cjs"]],
  ["json", [".json", ".jsonc"]],
  ["julia", [".jl"]],
  ["just", [".just"]],
  ["kdl", [".kdl"]],
  ["kotlin", [".kt", ".kts"]],
  ["latex", [".tex", ".sty"]],
  ["liquid", [".liquid"]],
  ["lua", [".lua"]],
  ["make", [".mk"]],
  ["markdown", [".md", ".markdown"]],
  ["markdown_inline", [".md.inline"]],
  ["matlab", [".m"]],
  ["nginx", [".nginx"]],
  ["nim", [".nim", ".nims"]],
  ["nix", [".nix"]],
  ["objc", [".m", ".mm"]],
  ["ocaml", [".ml"]],
  ["ocaml_interface", [".mli"]],
  ["ocaml_type", [".ty"]],
  ["perl", [".pl", ".pm"]],
  ["php", [".php", ".phtml"]],
  ["powershell", [".ps1", ".psm1", ".psd1"]],
  ["prisma", [".prisma"]],
  ["proto", [".proto"]],
  ["psv", [".psv"]],
  ["python", [".py", ".pyw", ".pyi"]],
  ["qmljs", [".qml"]],
  ["query", [".scm"]],
  ["r", [".r", ".R"]],
  ["racket", [".rkt"]],
  ["razor", [".razor"]],
  ["regex", [".regex"]],
  ["requirements", [".requirements"]],
  ["rescript", [".res", ".resi"]],
  ["ruby", [".rb", ".rake", ".gemspec"]],
  ["rust", [".rs"]],
  ["scala", [".scala", ".sc"]],
  ["scheme", [".scm", ".ss"]],
  ["sln", [".sln"]],
  ["solidity", [".sol"]],
  ["sql", [".sql"]],
  ["ssh_config", [".sshconfig"]],
  ["svelte", [".svelte"]],
  ["swift", [".swift"]],
  ["templ", [".templ"]],
  ["terraform", [".tf", ".tfvars"]],
  ["toml", [".toml"]],
  ["tsv", [".tsv"]],
  ["tsx", [".tsx"]],
  ["typescript", [".ts", ".mts", ".cts"]],
  ["typst", [".typ"]],
  ["vim", [".vim"]],
  ["vimdoc", []],
  ["vue", [".vue"]],
  ["xml", [".xml"]],
  ["yaml", [".yaml", ".yml"]],
  ["zig", [".zig"]],
];

const extensionMap = new Map<string, LanguageId>();
for (const [language, extensions] of extensionEntries) {
  for (const extension of extensions) {
    if (!extensionMap.has(extension)) extensionMap.set(extension, language);
  }
}

const definitions = new Map<LanguageId, LanguageDefinition>();
for (const language of SUPPORTED_LANGUAGES) {
  const extensions = extensionEntries.find(([id]) => id === language)?.[1] ?? [];
  definitions.set(language, {
    id: language,
    grammar_asset: `tree-sitter-${language}.wasm`,
    extensions,
  });
}

const aliases: Readonly<Record<string, LanguageId>> = {
  asm6502: "asm",
  csharp: "c_sharp",
  cs: "c_sharp",
  cxx: "cpp",
  "c++": "cpp",
  htm: "html",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  objc: "objc",
  objectivec: "objc",
  "objective-c": "objc",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "tsx",
  typescriptreact: "tsx",
  typescriptreactjs: "tsx",
  yml: "yaml",
};

const fileNames: Readonly<Record<string, LanguageId>> = {
  BUILD: "make",
  "BUILD.bazel": "make",
  CMakeLists: "cmake",
  "CMakeLists.txt": "cmake",
  Dockerfile: "dockerfile",
  Gemfile: "ruby",
  Makefile: "make",
  Rakefile: "ruby",
  Vagrantfile: "ruby",
  WORKSPACE: "make",
  ".bash_profile": "bash",
  ".bashrc": "bash",
  ".editorconfig": "editorconfig",
  ".gitattributes": "gitattributes",
  ".gitignore": "gitignore",
};

export function normalizeLanguage(language: string): LanguageId | null {
  const normalized = language.trim().toLowerCase().replaceAll(" ", "_");
  if (normalized in aliases) return aliases[normalized];
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(normalized)
    ? (normalized as LanguageId)
    : null;
}

export function languageDefinition(language: string): LanguageDefinition | null {
  const normalized = normalizeLanguage(language);
  return normalized ? definitions.get(normalized) ?? null : null;
}

export function languageForPath(path: string): LanguageId | null {
  const basename = path.split(/[\\/]/u).at(-1) ?? path;
  const byName = fileNames[basename];
  if (byName) return byName;

  const dot = basename.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = basename.slice(dot);
  return extensionMap.get(extension) ?? extensionMap.get(extension.toLowerCase()) ?? null;
}

export function languageDefinitions(): readonly LanguageDefinition[] {
  return [...definitions.values()];
}
