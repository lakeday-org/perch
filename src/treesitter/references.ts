import type { Node } from "./node";
import type { Reference, ReferenceKind, SourceLocation } from "./types";
import { isComment, isFunction, location, walkNodes } from "./metrics";
import { callableName } from "./extensions";

const IMPORT_TYPES = new Set([
  "import_statement",
  "import_from_statement",
  "import_declaration",
  "use_declaration",
  "using_directive",
  "namespace_use_declaration",
  "preproc_include",
  "package_import",
]);

const CALL_TYPES = new Set([
  "call",
  "call_expression",
  "method_invocation",
  "function_call",
  "function_call_expression",
  "invocation_expression",
]);

const NAME_TYPES = new Set([
  "identifier",
  "field_identifier",
  "property_identifier",
  "type_identifier",
  "simple_identifier",
  "name",
  "variable",
]);

const IMPORT_BINDING_TYPES = new Set([
  "aliased_import",
  "dotted_as_name",
  "import_as_name",
  "import_specifier",
  "namespace_import",
  "import_spec",
  "use_as_clause",
]);

function text(node: Node | null | undefined, limit = 256): string {
  if (!node) return "";
  if (node.endIndex - node.startIndex > limit * 4) return "<dynamic>";
  return node.text.trim().slice(0, limit);
}

function stripModule(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed.slice(1, -1);
  return trimmed;
}

function child(node: Node, ...fields: string[]): Node | null {
  for (const field of fields) {
    const result = node.childForFieldName(field);
    if (result) return result;
  }
  return null;
}

function nearestFunction(node: Node): Node | null {
  let parent = node.parent;
  while (parent) {
    if (isFunction(parent)) return parent;
    parent = parent.parent;
  }
  return null;
}

function ownerId(node: Node): string {
  const owner = nearestFunction(node);
  return owner ? `function:${owner.startIndex}` : "file";
}

function sourceRef(node: Node): string {
  return ownerId(node);
}

function referenceBase(node: Node): Node | null {
  return child(node, "function", "callee", "name");
}

function validReference(value: string): string {
  const normalized = value.replaceAll("::", ".");
  if (
    value.length > 256 ||
    !normalized ||
    !normalized.split(".").every((part) => /^[A-Za-z_$][\w$]*$/u.test(part))
  ) {
    return "<dynamic>";
  }
  return value;
}

function makeReference(
  kind: ReferenceKind,
  node: Node,
  values: {
    name?: string;
    reference?: string;
    module?: string | null;
    imported_name?: string | null;
    alias?: string | null;
  },
): Reference {
  const point = node.startPosition;
  const sourceLocation: SourceLocation = location(node);
  const reference = values.reference ?? values.name ?? "<dynamic>";
  return {
    kind,
    name: values.name || reference,
    reference,
    module: values.module ?? null,
    imported_name: values.imported_name ?? null,
    alias: values.alias ?? null,
    source: sourceRef(node),
    line: point.row + 1,
    column: point.column + 1,
    location: sourceLocation,
  };
}

function importModule(node: Node, language: string): string {
  const source = child(node, "source", "path", "module", "module_name", "argument");
  if (source) return stripModule(text(source));
  if (language === "python" && node.type === "import_statement") {
    const imported = node.namedChildren[0] ?? null;
    return stripModule(text(imported?.childForFieldName("name") ?? imported));
  }
  if (language === "python" && node.type === "import_from_statement") {
    const relative = child(node, "relative_import");
    const module = child(node, "module_name");
    return `${text(relative)}${text(module)}`;
  }
  if (node.type === "preproc_include") {
    const include = node.namedChildren.find((item) => item.type.includes("string"));
    return stripModule(text(include));
  }
  if (node.type === "import_declaration") {
    return stripModule(text(node.namedChildren[0] ?? null));
  }
  return stripModule(text(node.namedChildren[0] ?? null));
}

function bindingName(node: Node): { name: string; alias: string | null } | null {
  if (node.type === "namespace_import") {
    const local = text(node.namedChildren.at(-1));
    return local ? { name: "*", alias: local } : null;
  }
  const imported = child(node, "name", "path");
  const alias = child(node, "alias");
  if (imported || alias) {
    const name = text(imported);
    const local = text(alias) || name;
    return name || local ? { name: name || local, alias: local || null } : null;
  }
  const names = node.namedChildren.filter((item) => NAME_TYPES.has(item.type));
  if (names.length === 0) return null;
  const name = text(names[0]);
  const local = text(names.at(-1));
  return name ? { name, alias: local && local !== name ? local : null } : null;
}

function rustUseNames(node: Node, prefix = ""): Array<{ name: string; alias: string | null }> {
  if (node.type === "scoped_use_list") {
    const path = text(child(node, "path"));
    const list = child(node, "list");
    return list ? rustUseNames(list, `${prefix}${path}::`) : [];
  }
  if (node.type === "use_list") {
    return node.namedChildren.flatMap((item) => rustUseNames(item, prefix));
  }
  if (node.type === "use_as_clause") {
    const path = `${prefix}${text(child(node, "path"))}`.replace(/::self$/u, "");
    const alias = text(child(node, "alias")) || path.split("::").at(-1) || path;
    return [{ name: path, alias }];
  }
  const path = `${prefix}${text(node)}`.replace(/::self$/u, "");
  return path ? [{ name: path, alias: path.split("::").at(-1) ?? null }] : [];
}

function importReferences(node: Node, language: string): Reference[] {
  const module = importModule(node, language);
  const references: Reference[] = [];
  references.push(
    makeReference("import", node, {
      name: module || "<unknown-module>",
      reference: module || "<unknown-module>",
      module: module || null,
    }),
  );

  if (language === "rust" && node.type === "use_declaration") {
    const argument = child(node, "argument");
    if (argument) {
      for (const item of rustUseNames(argument)) {
        references.push(
          makeReference("import", node, {
            name: item.name,
            reference: item.name,
            module: item.name.includes("::") ? item.name.slice(0, item.name.lastIndexOf("::")) : item.name,
            imported_name: item.name.split("::").at(-1) ?? item.name,
            alias: item.alias,
          }),
        );
      }
    }
    return references;
  }

  for (const item of walkNodes(node)) {
    if (item === node || !IMPORT_BINDING_TYPES.has(item.type)) continue;
    const binding = bindingName(item);
    if (!binding) continue;
    references.push(
      makeReference("import", item, {
        name: binding.name,
        reference:
          module && binding.name !== module ? `${module}.${binding.name}` : module || binding.name,
        module: module || null,
        imported_name: binding.name,
        alias: binding.alias,
      }),
    );
  }
  for (const item of walkNodes(node)) {
    if (item.type !== "identifier" || item.parent?.type !== "import_clause") continue;
    const local = text(item);
    if (!local) continue;
    references.push(
      makeReference("import", item, {
        name: "default",
        reference: module ? `${module}.default` : "default",
        module: module || null,
        imported_name: "default",
        alias: local,
      }),
    );
  }
  return references;
}

function callReference(node: Node): string {
  if (node.type === "method_invocation") {
    const object = text(child(node, "object"));
    const name = text(child(node, "name"));
    return validReference(object ? `${object}.${name}` : name);
  }
  const callee = referenceBase(node);
  return validReference(text(callee));
}

function callReferenceRecord(node: Node): Reference {
  const reference = callReference(node);
  return makeReference("call", node, {
    name: reference,
    reference,
  });
}

/** Identifiers that can name a function where one is used as a value rather than called. */
const IDENTIFIER_TYPES = new Set([
  "identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "field_identifier",
  "simple_identifier",
]);

/**
 * Positions where naming a function hands it to something else to call later: an argument, the value of a key, or the
 * right-hand side of an assignment. This is how a handler reaches a dispatcher, and the call it eventually makes has no
 * name in the source, so nothing else in the graph would connect the two.
 */
function isPassedAsValue(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "arguments" || parent.type === "argument_list" || parent.type === "expression_list") return true;
  for (const field of ["value", "right"]) {
    const held = parent.childForFieldName(field);
    if (held && held.startIndex === node.startIndex && held.endIndex === node.endIndex) return true;
  }
  return false;
}

function valueReference(node: Node): Reference {
  const name = text(node, 128);
  return makeReference("value", node, { name, reference: name });
}

export function collectReferences(root: Node, language: string): Reference[] {
  const references: Reference[] = [];
  for (const node of walkNodes(root)) {
    if (isComment(node)) continue;
    if (IMPORT_TYPES.has(node.type)) {
      references.push(...importReferences(node, language));
    } else if (language === 'groovy' && node.type === 'func') {
      const unit = node.parent, block = unit?.parent;
      // A declaration's signature also contains a func node; only uses are calls.
      if (block?.type === 'block' && block.namedChildren[0]?.id === unit?.id && callableName(block)) continue;
      const name = validReference(text(node.namedChildren[0]));
      references.push(makeReference('call', node, { name, reference: name }));
    } else if (CALL_TYPES.has(node.type)) {
      references.push(callReferenceRecord(node));
    } else if (IDENTIFIER_TYPES.has(node.type) && isPassedAsValue(node) && validReference(text(node, 128))) {
      references.push(valueReference(node));
    }
  }
  return references;
}
