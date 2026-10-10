import type { Node } from "./node";
import type { Reference, ReferenceKind, SourceLocation, Parameter } from "./types";
import { ANONYMOUS_FUNCTION_TYPES, implTypeName, isAnonymousClass, isComment, isFunction, location, qualifiedScopeName, walkNodes } from "./metrics";
import { walk, type SyntaxIndex, type Visitor } from "./visit";
import type { Held } from "./types";
import { callableName } from "./extensions";

const IMPORT_TYPES = new Set([
  "import_statement",
  "import_from_statement",
  "import_declaration",
  // Go's import_declaration holds one import_spec or a parenthesised list of them, and each spec imports a path of its own.
  "import_spec",
  "use_declaration",
  "using_directive",
  "namespace_use_declaration",
  "preproc_include",
  "package_import",
  "import_directive",
]);

const CALL_TYPES = new Set([
  "call",
  "call_expression",
  "method_invocation",
  "function_call",
  "function_call_expression",
  "invocation_expression",
  "member_call_expression",
  "nullsafe_member_call_expression",
  "scoped_call_expression",
]);

/** Calls whose node holds the receiver and the member apart: Java's invocation, PHP's `$a->b()` and `A::b()`. */
const MEMBER_CALLS = new Set(["method_invocation", "member_call_expression", "nullsafe_member_call_expression", "scoped_call_expression"]);

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
  "import_require_clause",
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
  // Kotlin's and Swift's call_expression give the callee no field: it is the first child, ahead of the arguments.
  return child(node, "function", "callee", "name") ?? node.namedChildren.find((item) => !isComment(item)) ?? null;
}

/** A safe call, `a?.b()` or Ruby's `a&.b`, calls the same method `a.b()` does whenever it calls anything. */
function safeNavigation(value: string): string {
  return value.replace(/[?&]\./gu, ".");
}

/** What every language here lets an identifier be: a letter in any script, then letters, marks, digits and joiners. */
const IDENTIFIER = /^[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*$/u;

/**
 * A reference as a path of identifiers, or `<dynamic>`. Ruby lets a method end in `?` or `!`, and name a top-level constant with a
 * leading `::`; PHP separates namespaces with `\`, and a leading `\` makes a name fully qualified.
 */
function validReference(value: string, language = ""): string {
  let normalized = value.replaceAll("::", ".");
  if (language === "ruby") normalized = normalized.replace(/^\./, "").replace(/[?!]$/, "");
  if (language === "php") normalized = normalized.replace(/^\\/, "").replaceAll("\\", ".");
  if (
    value.length > 256 ||
    !normalized ||
    !normalized.split(".").every((part) => IDENTIFIER.test(part))
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
    reexport?: boolean;
    held?: Held | null;
    args?: Array<Held | null>;
    named?: Record<string, Held>;
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
    ...(values.reexport ? { reexport: true } : {}),
    ...(values.held ? { held: values.held } : {}),
    ...(values.args ? { args: values.args } : {}),
    ...(values.named ? { named: values.named } : {}),
    source: sourceRef(node),
    line: point.row + 1,
    column: point.column + 1,
    location: sourceLocation,
  };
}

function importModule(node: Node, language: string): string {
  const source = child(node, "source", "path", "module", "module_name", "argument")
    // TypeScript's `import Foo = require("./foo")` keeps the source on the clause, one level down.
    ?? node.namedChildren.find((item) => item.type === "import_require_clause")?.childForFieldName("source") ?? null;
  if (source) return stripModule(text(source));
  if (language === "python" && node.type === "import_statement") {
    const imported = node.namedChildren[0] ?? null;
    return stripModule(text(imported?.childForFieldName("name") ?? imported));
  }
  if (node.type === "preproc_include") {
    const include = node.namedChildren.find((item) => item.type.includes("string"));
    return stripModule(text(include));
  }
  return stripModule(text(node.namedChildren[0] ?? null));
}

function bindingName(node: Node): { name: string; alias: string | null } | null {
  // `import * as Foo` and `import Foo = require(...)` both bind the module's whole export to one local name.
  if (node.type === "namespace_import" || node.type === "import_require_clause") {
    const local = text(node.namedChildren.find((item) => item.type === "identifier") ?? node.namedChildren.at(-1));
    return local ? { name: "*", alias: local } : null;
  }
  // A Go import_spec's name is the alias, written before the path; without one, the package goes by the path's last element.
  if (node.type === "import_spec") {
    const path = stripModule(text(child(node, "path")));
    return path ? { name: path, alias: text(child(node, "name")) || path.split("/").at(-1) || path } : null;
  }
  const imported = child(node, "name");
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

/**
 * The names a Python import binds. `from m import x` names x with the same dotted_name node that names a module, so the walk
 * the other languages use takes neither for a binding. Each name in `import a.b, c as d` is a module bound whole, and an
 * unaliased `import a.b` binds a, which a call then reaches through as `a.b.f()`.
 */
function pythonImportNames(node: Node, module: string): Array<{ node: Node; module: string; name: string; alias: string; reference: string }> {
  const from = child(node, "module_name");
  const names = [];
  for (const item of node.namedChildren) {
    const aliased = item.type === "aliased_import";
    if ((!aliased && item.type !== "dotted_name") || item.startIndex === from?.startIndex) continue;
    const path = text(aliased ? child(item, "name") : item);
    const alias = aliased ? text(child(item, "alias")) : "";
    if (!path) continue;
    if (node.type === "import_statement") names.push({ node: item, module: path, name: "*", alias: alias || (path.split(".")[0] ?? path), reference: path });
    else names.push({ node: item, module, name: path, alias: alias || path, reference: !module || module.endsWith(".") ? `${module}${path}` : `${module}.${path}` });
  }
  // `from ._models import *` binds every name the module exports, which is how a package's __init__.py passes its modules on.
  const wildcard = node.type === "import_from_statement" ? node.namedChildren.find((item) => item.type === "wildcard_import") : undefined;
  if (wildcard) names.push({ node: wildcard, module, name: "*", alias: "*", reference: !module || module.endsWith(".") ? `${module}*` : `${module}.*` });
  return names;
}

function importReferences(node: Node, language: string): Reference[] {
  // A declaration that only holds Go import_specs imports nothing itself; the walk reaches each spec and reads it.
  if (node.namedChildren.some((item) => item.type === "import_spec" || item.type === "import_spec_list")) return [];
  const module = importModule(node, language);
  const references: Reference[] = [];
  references.push(
    makeReference("import", node, {
      name: module || "<unknown-module>",
      reference: module || "<unknown-module>",
      module: module || null,
      // `#include "ledger.hpp"` brings the whole header in, and binds no name of its own.
      ...(node.type === "preproc_include" && module ? { imported_name: "*", alias: "<include>" } : {}),
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

  if (language === "python") {
    for (const item of pythonImportNames(node, module)) {
      references.push(
        makeReference("import", item.node, {
          name: item.name,
          reference: item.reference,
          module: item.module || null,
          imported_name: item.name,
          alias: item.alias,
        }),
      );
    }
    return references;
  }

  if (language === "solidity" && module) {
    for (const item of solidityImportNames(node)) {
      references.push(makeReference("import", node, { name: item.name, reference: item.name === "*" ? module : `${module}.${item.name}`, module, imported_name: item.name, alias: item.alias }));
    }
    return references;
  }

  // The import itself can be its binding: a Go import_spec names both the path and the name it goes by.
  for (const item of walkNodes(node)) {
    if (!IMPORT_BINDING_TYPES.has(item.type)) continue;
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

/**
 * The names a Solidity import binds, read from its children in order. `import {Cart as C, Other} from "./Cart.sol"` binds each
 * listed name, under its alias when it has one; `import * as P from` and `import "./Cart.sol" as B` bind the whole file to one
 * name; `import "./Cart.sol";` brings every name the file declares in, which is a glob.
 */
function solidityImportNames(node: Node): Array<{ name: string; alias: string }> {
  const names: Array<{ name: string; alias: string }> = [];
  const children = node.children;
  let pending: string | null = null;
  for (const [at, item] of children.entries()) {
    if (item.type !== "identifier") continue;
    // The identifier after `as` is the alias of the name before it, or of the whole file when nothing is pending.
    const before = children[at - 1];
    if (before && !before.isNamed && before.text === "as") {
      names.push({ name: pending ?? "*", alias: item.text });
      pending = null;
    } else {
      if (pending) names.push({ name: pending, alias: pending });
      pending = item.text;
    }
  }
  if (pending) names.push({ name: pending, alias: pending });
  return names.length ? names : [{ name: "*", alias: "*" }];
}

// ------------------------------------------------------------------------------------------------------------------- Zig

/** Zig's builtin types, which name no struct a method could be found on. */
const ZIG_PRIMITIVE = /^(?:[iu]\d+|f\d+|bool|void|type|anytype|anyopaque|anyerror|noreturn|usize|isize|comptime_int|comptime_float|c_\w+)$/;

/** A Zig type as written, less what wraps it: `?*const Cart`, `!Cart` and `anyerror!Cart` name Cart; `Self` is the struct around it. */
function zigBareType(node: Node | null): string | null {
  if (!node) return null;
  const written = text(node).replace(/^(?:\[[^\]]*\]|[?*!]|(?:const|volatile|allowzero)\s+|align\([^)]*\)\s*|[\w.]+!)+/, '').trim();
  if (written === 'Self') return '$self';
  return ZIG_PRIMITIVE.test(written) ? null : typeName(written);
}

/** Zig's suffix operators that hand on the value they are applied to: `.?` unwraps an optional, `.*` dereferences a pointer. */
const ZIG_TRANSPARENT = new Set(['.?', '.*']);

interface ZigCall { reference: string; at: Node; held: Held | null }

/**
 * A Zig SuffixExpr read left to right: a head, then field accesses, calls and indexes. `cart.discount(200, 10)` is one node, as
 * is `Cart.init(a).add(line)`: the first call is named by the path before it, and each later one is a member of what the call
 * before it returned. Returns each call, with what its receiver holds when the path cannot name it, and what the whole
 * expression holds as a value: the last call's result, or a local named alone.
 */
function zigChain(node: Node): { calls: ZigCall[]; value: Held | null } {
  const calls: ZigCall[] = [];
  const parts = node.children.filter(child => !isComment(child));
  const head = parts[0];
  // The names since the last call, or null once the receiver is one the tree cannot name: a literal, a builtin's result, an element.
  let path: string[] | null = head?.type === 'IDENTIFIER' ? [head.text] : null;
  let held: Held | null = null;
  const call = (member: string | null, at: Node) => {
    if (path && (member || path.length)) {
      const reference = validReference([...path, ...(member ? [member] : [])].join('.'));
      if (reference === '<dynamic>') held = null;
      else { calls.push({ reference, at, held: null }); held = { call: reference }; }
    } else if (member && held) {
      const reference = `$receiver.${member}`;
      calls.push({ reference, at, held });
      held = { call: reference, on: held };
    } else held = null;
    path = null;
  };
  for (const part of parts.slice(1)) {
    if (part.type === 'FieldOrFnCall') {
      const field = part.childForFieldName('field_access'), fn = part.childForFieldName('function_call');
      // A field of a call's result is a value whose type the tree does not give.
      if (field) { if (path) path.push(field.text); else held = null; }
      else if (fn) call(fn.text, fn);
    } else if (part.type === 'FnCallArguments') call(null, head);
    else if (part.type === 'SuffixOp' && !ZIG_TRANSPARENT.has(part.text)) { path = null; held = null; }
  }
  return { calls, value: held ?? (path?.length === 1 ? { local: path[0] } : null) };
}

/**
 * A Zig import is a declaration whose value is `@import("file")`, optionally reaching into it: `const cart = @import("cart.zig")`
 * binds the module, `const Cart = @import("cart.zig").Cart` one name of it, and `const Cart = cart.Cart` one name of a module
 * already bound. `@import("std")` names a package the build provides, which no file in the repository is.
 */
function zigImport(node: Node, imports: Reference[]): Reference | null {
  const name = node.childForFieldName('variable_type_function');
  const equals = node.children.findIndex(child => !child.isNamed && child.text === '=');
  let value = equals >= 0 ? node.children[equals + 1] ?? null : null;
  while (value && value.type === 'ErrorUnionExpr' && value.namedChildren.length === 1) value = value.namedChildren[0];
  if (!name || value?.type !== 'SuffixExpr') return null;
  const [head, ...rest] = value.children.filter(child => !isComment(child));
  let module: string, bound: string[] = [];
  if (head?.type === 'BUILTINIDENTIFIER' && head.text === '@import') {
    const argument = rest[0]?.type === 'FnCallArguments' && rest[0].namedChildren.length === 1 ? rest[0].namedChildren[0] : null;
    const string = argument ? [...walkNodes(argument)].find(item => item.type === 'STRINGLITERALSINGLE') : null;
    if (!string) return null;
    module = string.text.slice(1, -1);
    rest.shift();
  } else if (head?.type === 'IDENTIFIER' && rest.length) {
    const through = imports.find(item => item.alias === head.text && item.module);
    if (!through) return null;
    module = through.module!;
    if (through.imported_name && through.imported_name !== '*') bound = through.imported_name.split('.');
  } else return null;
  for (const part of rest) {
    const field = part.type === 'FieldOrFnCall' ? part.childForFieldName('field_access') : null;
    // A call or an index after the import is a value computed from it, not a name passed on.
    if (!field) return null;
    bound.push(field.text);
  }
  const imported = bound.length ? bound.join('.') : '*';
  return makeReference('import', node, { name: imported, reference: imported === '*' ? module : `${module}.${imported}`, module, imported_name: imported, alias: text(name) });
}

/**
 * A Java or Kotlin import as the graph needs it: the package it reaches into, the class (or, in Kotlin, the top-level name) it
 * binds, and the local name. A Java static import binds a member, recorded as `Class.member`; an on-demand import binds `*`.
 * Which package holds which class is the graph's to decide, since only the graph sees every file's package.
 */
function jvmImportReference(node: Node, language: string): Reference | null {
  const path = node.namedChildren.find((item) => ["scoped_identifier", "identifier"].includes(item.type));
  if (!path) return null;
  const segment = language === "kotlin" ? "simple_identifier" : "identifier";
  const segments = [...walkNodes(path)].filter((item) => item.type === segment).map((item) => item.text);
  const wildcard = node.namedChildren.some((item) => item.type === "asterisk" || item.type === "wildcard_import");
  const isStatic = language === "java" && Array.from({ length: node.childCount }, (_, index) => node.child(index)).some((item) => item?.type === "static");
  const alias = language === "kotlin" ? node.namedChildren.find((item) => item.type === "import_alias")?.namedChildren[0]?.text ?? null : null;
  const last = segments.at(-1) ?? "";
  const [module, imported, local] = isStatic
    ? (wildcard ? [segments.slice(0, -1), `${last}.*`, "*"] : [segments.slice(0, -2), `${segments.at(-2)}.${last}`, last])
    : (wildcard ? [segments, "*", "*"] : [segments.slice(0, -1), last, alias ?? last]);
  const reference = wildcard ? `${segments.join(".")}.*` : segments.join(".");
  return makeReference("import", node, { name: reference, reference, module: module.join("."), imported_name: imported, alias: local });
}

/**
 * A C# `using` as the graph needs it, with the shape a Java import has: `using Shop.Pricing;` brings a namespace in whole, as an
 * on-demand import does; `using static Shop.Cart;` brings Cart's static members in, as `import static Shop.Cart.*` would; and
 * `using Alias = Shop.Cart;` binds one class under a local name. A `global using` is the same directive for every file.
 */
function csharpUsingReference(node: Node): Reference | null {
  const alias = node.childForFieldName("name");
  const path = node.namedChildren.find((item) => item !== alias && (item.type === "qualified_name" || item.type === "identifier"));
  if (!path) return null;
  const segments = path.text.split(".").map((part) => part.trim());
  const isStatic = node.children.some((item) => item.type === "static");
  const last = segments.at(-1) ?? "";
  const [module, imported, local] = alias ? [segments.slice(0, -1), last, alias.text]
    : isStatic ? [segments.slice(0, -1), `${last}.*`, "*"]
    : [segments, "*", "*"];
  const reference = alias || isStatic ? segments.join(".") : `${segments.join(".")}.*`;
  return makeReference("import", node, { name: reference, reference, module: module.join("."), imported_name: imported, alias: local });
}

/**
 * A Swift import names a module, and every top-level declaration of the module is then visible by its bare name: the shape of an
 * on-demand import, with the module as what is imported. `import struct Shop.Cart` names one declaration of it; the module is
 * still the first segment, and that is what the graph places it by.
 */
function swiftImportReference(node: Node): Reference | null {
  const path = node.namedChildren.find((item) => item.type === "identifier");
  const module = path?.namedChildren.find((item) => item.type === "simple_identifier")?.text ?? null;
  if (!module) return null;
  return makeReference("import", node, { name: module, reference: module, module, imported_name: "*", alias: module });
}

/**
 * A Scala import as the graph needs it, with the shape a Java import has: `import a.b.C` binds C from package a.b, `import a.b._`
 * or `a.b.*` everything in it, and `import a.b.{C, D => E, F as G}` each selected name, renamed where it says. Which package
 * holds which class is the graph's to decide.
 */
function scalaImportReferences(node: Node): Reference[] {
  const segments = node.namedChildren.filter((item) => item.type === "identifier").map((item) => item.text);
  const selectors = node.namedChildren.find((item) => item.type === "namespace_selectors");
  const record = (module: string[], imported: string, local: string) => {
    const reference = imported === "*" ? `${module.join(".")}.*` : [...module, imported].join(".");
    return makeReference("import", node, { name: reference, reference, module: module.join("."), imported_name: imported, alias: local });
  };
  if (node.namedChildren.some((item) => item.type === "namespace_wildcard")) return [record(segments, "*", "*")];
  if (selectors) {
    return selectors.namedChildren.flatMap((item) => {
      if (item.type === "identifier") return [record(segments, item.text, item.text)];
      if (item.type === "namespace_wildcard") return [record(segments, "*", "*")];
      if (item.type.endsWith("renamed_identifier")) {
        const name = item.childForFieldName("name")?.text, alias = item.childForFieldName("alias")?.text;
        // `C => _` hides a name rather than importing it.
        return name && alias && alias !== "_" ? [record(segments, name, alias)] : [];
      }
      return [];
    });
  }
  return segments.length > 1 ? [record(segments.slice(0, -1), segments.at(-1)!, segments.at(-1)!)] : [];
}

function callReference(node: Node, language: string): string {
  if (MEMBER_CALLS.has(node.type)) {
    const object = child(node, "object", "scope");
    const name = text(child(node, "name"));
    const named = validReference(object ? `${pathText(object, language)}.${name}` : name, language);
    // `Money.of(1).plus(...)`: the member of what the receiver holds, as for every other language's member call.
    return named === '<dynamic>' && object ? `$receiver.${name}` : named;
  }
  // Ruby's call holds the receiver apart from the method, where other grammars hold one callee. `@cart.total` is a member of
  // what the instance variable holds, written `this.cart.total` as the other languages write it.
  const receiver = child(node, "receiver"), method = child(node, "method");
  if (receiver || method) {
    const written = receiver ? `${text(receiver).replace(/^@(?=[\p{L}_])/u, "this.")}.${text(method)}` : text(method);
    const named = validReference(safeNavigation(written), language);
    // `Cart.new(3).total`: the member of what the receiver's call returns.
    return named === '<dynamic>' && receiver && validReference(text(method), language) !== '<dynamic>' ? `$receiver.${text(method)}` : named;
  }
  const callee = referenceBase(node);
  if (language === 'solidity') {
    const rebound = solidityCallee(callee);
    if (rebound) return validReference(rebound, language);
  }
  // `commands[name](io)` or `OTHERS[language](index)`: a table of functions called through a key the source computes. Which one
  // runs is the key's; that it is one of the table's is the table's, and the call is recorded as the table's, `commands[]`.
  if (callee && ['subscript_expression', 'subscript', 'index_expression'].includes(callee.type)) {
    const table = child(callee, 'object', 'value') ?? callee.namedChildren[0] ?? null, index = child(callee, 'index') ?? callee.namedChildren[1] ?? null;
    const name = table ? validReference(pathText(table, language), language) : '<dynamic>';
    if (name !== '<dynamic>' && index) {
      const literal = ['string', 'string_literal'].includes(index.type) ? text(index).replace(/^["'`]|["'`]$/g, '') : null;
      return literal && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(literal) ? `${name}.${literal}` : `${name}[]`;
    }
  }
  const named = validReference(pathText(callee, language), language);
  // `"x".size()`, `Thing::new().get()` or `Entry(day).debit()`: the receiver is no name, but the member is. `$` cannot begin a name
  // in these languages, so `$receiver` stands for one the tree cannot name without being mistaken for one.
  if (named === '<dynamic>') {
    const split = memberOf(callee, language);
    if (split?.member) return `$receiver.${split.member}`;
  }
  return named;
}

/** A Solidity `expression` node holds one operand; the operand is what is meant. */
const unwrapExpression = (node: Node | null): Node | null => (node?.type === 'expression' && node.namedChildren.length === 1 ? node.namedChildren[0] : node);

/**
 * tree-sitter-solidity binds `.` looser than `!` and the binary operators, so `!Sku.isValid(code)` parses as `(!Sku).isValid(code)`
 * and `net + Pricing.tax(net)` as `(net + Pricing).tax(net)`. Solidity binds `.` tightest: the member belongs to the operand
 * nearest it, the operator's argument or its right side. The callee rewritten that way, or null when the tree needs no rewriting.
 */
function solidityCallee(callee: Node | null): string | null {
  const member = unwrapExpression(callee);
  if (member?.type !== 'member_expression') return null;
  let object = unwrapExpression(child(member, 'object'));
  const written = object;
  while (object && (object.type === 'unary_expression' || object.type === 'binary_expression')) {
    object = unwrapExpression(object.type === 'unary_expression' ? child(object, 'argument') : child(object, 'right'));
  }
  if (!object || object === written) return null;
  return `${text(object)}.${text(child(member, 'property'))}`;
}

/**
 * A callee as a path: `ledger->post` in C++ and `ledger?.post` in Kotlin are member calls as `ledger.post` is, and a chain rustfmt
 * breaks across lines (`ledger\n    .post`) is the same path.
 */
function pathText(callee: Node | null, language: string): string {
  // A safe call, `a?.b()` or Ruby's `a&.b`, calls the same method `a.b()` does whenever it calls anything.
  let written = safeNavigation(text(callee).replace(/\s*(\.|::|\?\.|&\.|->|\?->)\s*/g, '$1'));
  if (language === 'c' || language === 'cpp') written = written.replaceAll('->', '.');
  // PHP's `$this->cart->total` and `$this?->cart` are `this.cart.total`; `static::` names the class as `self::` does.
  if (language === 'php') written = written.replaceAll('?->', '.').replaceAll('->', '.').replace(/^\$this\b/, 'this').replace(/^static(?=$|::)/, 'self');
  // Lua's `cart:total()` calls the same function `cart.total(cart)` does.
  if (language === 'lua') written = written.replace(/(?<!:):(?!:)/g, '.');
  // `run_tests<true>()` in C++ and `parse::<i32>()` in Rust call the function their name is before the type arguments.
  if (TYPE_ARGUMENTS.has(language) && written.includes('<')) written = withoutTypeArguments(written.replaceAll('::<', '<'));
  return written;
}
const TYPE_ARGUMENTS = new Set(['c', 'cpp', 'rust']);
/** A call's name with every `<...>` taken out, nested ones included: `map<string, vector<int>>::at` is `map::at`. */
function withoutTypeArguments(written: string): string {
  let depth = 0, kept = '';
  for (const char of written) {
    if (char === '<') depth++;
    else if (char === '>' && depth > 0) depth--;
    else if (depth === 0) kept += char;
  }
  return kept;
}

/**
 * What a call calls: its callee, or for a Java or PHP member call and a Ruby call with a receiver, the call itself, which holds
 * the object and the name.
 */
const calleeOf = (node: Node): Node | null => (MEMBER_CALLS.has(node.type) || (node.type === 'call' && child(node, 'method')) ? node : referenceBase(node));

/** A member access as its receiver and the member's name: `a.b`, `a->b`, `a?.b`, a Java invocation's object and name. */
function memberOf(callee: Node | null, language: string): { receiver: Node | null; member: string } | null {
  if (!callee) return null;
  if (callee.type === 'method_invocation') return { receiver: child(callee, 'object'), member: text(child(callee, 'name')) };
  if (MEMBER_CALLS.has(callee.type)) return { receiver: child(callee, 'object', 'scope'), member: text(child(callee, 'name')) };
  if (callee.type === 'call' && child(callee, 'method')) return { receiver: child(callee, 'receiver'), member: text(child(callee, 'method')) };
  // Lua's `cart.total` and `cart:total`.
  if (callee.type === 'dot_index_expression' || callee.type === 'method_index_expression') {
    const table = child(callee, 'table'), field = child(callee, 'field', 'method');
    return table && field ? { receiver: table, member: text(field) } : null;
  }
  // C#'s member_access_expression holds its receiver as `expression`.
  const receiver = child(callee, 'object', 'value', 'argument', 'operand', 'expression');
  const field = child(callee, 'property', 'attribute', 'field', 'name');
  if (receiver && field && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(text(field))) return { receiver, member: text(field) };
  if (language === 'kotlin' && callee.type === 'navigation_expression') {
    const member = [...walkNodes(callee)].reverse().find(item => item.type === 'simple_identifier');
    if (member && member.endIndex === callee.endIndex) return { receiver: callee.namedChildren[0] ?? null, member: text(member) };
  }
  // Swift's `Cart().total`: a target and a navigation suffix holding the member's name.
  if (language === 'swift' && callee.type === 'navigation_expression') {
    const member = child(callee, 'suffix')?.childForFieldName('suffix');
    if (member?.type === 'simple_identifier') return { receiver: child(callee, 'target'), member: text(member) };
  }
  return null;
}

/**
 * What a receiver the tree cannot name holds, when its source says: the result of a call (`Thing::new()`, `Entry(day)`, `make()`),
 * a construction (`new Ledger()`), or a value of a type (`Color::Red`).
 */
function receiverOf(receiver: Node | null, language: string): Held | null {
  const value = valueOf(receiver, language);
  if (value) return value;
  // `Color::Red`: a variant, or a constant, of the type named before it.
  if (receiver && ['scoped_identifier', 'field_expression', 'member_expression', 'attribute'].includes(receiver.type)) {
    const parts = pathText(receiver, language).split(/::|\./);
    if (parts.length >= 2 && /^[A-Z]/.test(parts.at(-2)!)) return { type: parts.at(-2) };
  }
  return null;
}

function callReferenceRecord(node: Node, language: string): Reference {
  const reference = callReference(node, language);
  const hint = reference.startsWith('$receiver.') ? receiverOf(memberOf(calleeOf(node), language)?.receiver ?? null, language) : null;
  return makeReference("call", node, {
    name: reference,
    reference,
    ...(hint ? { held: hint } : {}),
    ...(argumentsOf(node, language) ?? {}),
  });
}

const ARGUMENT_LISTS = new Set(['arguments', 'argument_list', 'value_arguments', 'call_suffix', 'FnCallArguments']);
const ARGUMENT_WRAPPERS = new Set(['argument', 'value_argument', 'call_argument']);
/**
 * What a call passes: each positional argument's value, and each named one's, when the source says. An object literal passed
 * whole, `{ analyzer, reader: make() }`, is kept as its fields, since a parameter destructured from it takes one of them. This is
 * what lets a method called on a parameter be found: the parameter holds what the callers pass.
 */
export function argumentsOf(node: Node, language: string): { args?: Array<Held | null>; named?: Record<string, Held> } | null {
  let list = child(node, 'arguments') ?? node.namedChildren.find(item => ARGUMENT_LISTS.has(item.type)) ?? null;
  if (list?.type === 'call_suffix') list = list.namedChildren.find(item => item.type === 'value_arguments') ?? null;
  if (!list) return null;
  const args: Array<Held | null> = [], named: Record<string, Held> = {};
  for (const item of list.namedChildren.filter(entry => !isComment(entry))) {
    // Python's `key=value`, Ruby's `key: value`, Swift's and Kotlin's labelled arguments: by name, not by position.
    const label = item.type === 'keyword_argument' || item.type === 'pair' || (item.type === 'value_argument' && child(item, 'name')) ? child(item, 'name', 'key') : null;
    if (label) {
      const held = valueOf(child(item, 'value') ?? item.namedChildren.at(-1) ?? null, language);
      if (held) named[text(label)] = held;
      continue;
    }
    const value = ARGUMENT_WRAPPERS.has(item.type) ? child(item, 'value') ?? item.namedChildren.at(-1) ?? null : item;
    args.push(value ? objectFields(value, language) ?? valueOf(value, language) : null);
  }
  const some = args.some(Boolean);
  if (!some && !Object.keys(named).length) return null;
  return { ...(some ? { args } : {}), ...(Object.keys(named).length ? { named } : {}) };
}

/**
 * An object literal's fields as what each holds: `{ analyzer }` holds the local analyzer, `{ reader: make() }` what make returns,
 * `{ update(n) {...} }` and `{ update: n => ... }` the function written there.
 */
function objectFields(node: Node, language: string): Held | null {
  if (node.type !== 'object') return null;
  const fields: Record<string, Held> = {};
  for (const item of node.namedChildren) {
    if (item.type === 'shorthand_property_identifier') fields[text(item)] = { local: text(item) };
    else if (item.type === 'pair') {
      const key = child(item, 'key'), held = valueOf(child(item, 'value'), language);
      if (key && held) fields[text(key).replace(/^["']|["']$/g, '')] = held;
    } else if (item.type === 'method_definition') {
      const key = child(item, 'name');
      if (key) fields[text(key)] = { fn: `function:${item.startIndex}` };
    }
  }
  return Object.keys(fields).length ? { fields } : null;
}

const PARAMETER_LISTS = new Set(['formal_parameters', 'parameters', 'parameter_list', 'function_value_parameters', 'method_parameters', 'ParamDeclList', 'parameter_clause', 'lambda_parameters']);
const PARAMETER_NAMES = new Set(['identifier', 'simple_identifier', 'variable_name', 'IDENTIFIER', 'field_identifier']);
/** The name a parameter binds: its own identifier, or for a typed or defaulted one, the identifier that is not its type. */
function parameterName(item: Node): string | null {
  if (PARAMETER_NAMES.has(item.type)) return text(item);
  const named = child(item, 'name', 'pattern', 'parameter');
  if (named && PARAMETER_NAMES.has(named.type)) return text(named);
  const walk = (node: Node): string | null => {
    for (const inner of node.namedChildren) {
      if (PARAMETER_NAMES.has(inner.type)) return text(inner);
      if (inner.type.endsWith('type') || inner.type.includes('type_')) continue;
      const found = walk(inner);
      if (found) return found;
    }
    return null;
  };
  return walk(named ?? item);
}

/**
 * The parameters a function declares, in order, with the property each destructured one takes from the object passed in its
 * place: `function run(files, { analyzer, reader: read })` declares files at 0, analyzer at 1 from `analyzer`, read at 1 from
 * `reader`. A rest or splat parameter holds the arguments nobody named, so it is left out.
 */
export function parametersOf(node: Node): Parameter[] {
  const list = child(node, 'parameters') ?? node.namedChildren.find(item => PARAMETER_LISTS.has(item.type)) ?? null;
  if (!list) return [];
  const params: Parameter[] = [];
  const items = list.namedChildren.filter(item => !isComment(item) && !/rest|splat|variadic|spread/.test(item.type) && item.type !== 'this');
  items.forEach((item, index) => {
    const pattern = item.type === 'object_pattern' ? item : child(item, 'pattern')?.type === 'object_pattern' ? child(item, 'pattern') : null;
    if (pattern) {
      for (const field of pattern.namedChildren) {
        if (field.type === 'shorthand_property_identifier_pattern') params.push({ name: text(field), index, field: text(field) });
        // `{ debug = () => {} }`: a destructured property with a default.
        else if (field.type === 'object_assignment_pattern' && child(field, 'left')?.type === 'shorthand_property_identifier_pattern') params.push({ name: text(child(field, 'left')), index, field: text(child(field, 'left')) });
        else if (field.type === 'pair_pattern') {
          const key = child(field, 'key'), value = child(field, 'value');
          const bound = value?.type === 'assignment_pattern' ? child(value, 'left') : value;
          if (key && bound && PARAMETER_NAMES.has(bound.type)) params.push({ name: text(bound), index, field: text(key) });
        }
      }
      return;
    }
    const name = parameterName(item);
    if (name) params.push({ name, index });
  });
  return params;
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
  if (parent.type === "arguments" || parent.type === "argument_list") return true;
  // The receiver of a member access, `R` in Scala's or Rust's `R.standard`, sits in a `value` field and is handed to nothing.
  if (parent.type === "field_expression") return false;
  // Go writes both sides of `:=`, `=` and `range` as an expression_list; the one on the left names what is assigned to.
  if (parent.type === "expression_list") {
    const left = parent.parent?.childForFieldName("left");
    return !(left && left.startIndex === parent.startIndex && left.endIndex === parent.endIndex);
  }
  for (const field of ["value", "right"]) {
    const held = parent.childForFieldName(field);
    if (held && held.startIndex === node.startIndex && held.endIndex === node.endIndex) return true;
  }
  return false;
}

/** The method a Java or Kotlin method reference names, as a call to it would: `builder.build`, `Money.plus`, `Account` for `::new`. */
function methodReferenceName(node: Node): string | null {
  const [receiver, member] = node.namedChildren.length >= 2 ? node.namedChildren : [null, node.namedChildren[0] ?? null];
  const written = node.text.slice(node.text.lastIndexOf("::") + 2).trim();
  const target = receiver ? text(receiver, 128).replace(/<.*>$/s, "") : "";
  if (written === "new") return target ? validReference(target) : null;
  const name = member?.text === written ? written : written.match(/^[\p{L}_$][\p{L}\p{N}_$]*/u)?.[0];
  if (!name) return null;
  const reference = validReference(target ? `${target}.${name}` : name);
  return reference === "<dynamic>" ? null : reference;
}

/**
 * `Limiter limiter(config, clock);` in a function body: C++ reads it as a variable constructed from two arguments, and the
 * grammar, which cannot tell a type from a value, as a function declared with two parameters. A body declares no functions.
 */
function constructedInBody(declarator: Node): boolean {
  return declarator.type === 'function_declarator' && declarator.parent?.type === 'declaration' && declarator.parent.parent?.type === 'compound_statement';
}

/**
 * `using Squares = LruCache<int, int>;` and `typedef LruCache<int, int> Squares;`: a call or a type written with the alias
 * names the class, so each reference to one is rewritten to it in place.
 */
function unaliased(index: SyntaxIndex, references: Reference[]): void {
  const aliases = new Map<string, string>();
  for (const node of index.of('alias_declaration', 'type_definition')) {
    const name = node.type === 'alias_declaration' ? child(node, 'name') : node.type === 'type_definition' ? child(node, 'declarator') : null;
    const type = name ? bareType(child(node, 'type')) : null;
    if (name?.type === 'type_identifier' && type && type !== name.text) aliases.set(name.text, type.replaceAll('::', '.'));
  }
  if (!aliases.size) return;
  const swap = (written: string) => {
    const [head, ...rest] = written.split(/::|\./);
    return aliases.has(head) ? [aliases.get(head)!, ...rest].join('.') : written;
  };
  for (const reference of references) {
    if (reference.kind === 'call') { reference.name = swap(reference.name); reference.reference = reference.name; }
    if (reference.held?.type) reference.held = { ...reference.held, type: swap(reference.held.type) };
  }
}

/** The class a C++ declaration constructs with arguments, `Cart cart(3)` or `Cart cart{3}`; not a standard library type. */
function cppConstructed(node: Node): string | null {
  const type = child(node, 'type');
  if (!type || !['type_identifier', 'qualified_identifier', 'template_type'].includes(type.type) || /^std::/.test(type.text)) return null;
  const constructs = node.namedChildren.some(item => (item.type === 'init_declarator' && ['argument_list', 'initializer_list'].includes(child(item, 'value')?.type ?? ''))
    || constructedInBody(item));
  return constructs ? bareType(type)?.replaceAll('::', '.') ?? null : null;
}

function valueReference(node: Node): Reference {
  const name = text(node, 128);
  return makeReference("value", node, { name, reference: name });
}

/**
 * Calls written inside a Rust macro's arguments. The grammar leaves a macro's arguments as a flat token tree, so
 * `assert_eq!(apply_discount(200, 10), 180)` holds no call node, and every call a test makes inside an assertion was missing
 * from the graph. In the tokens a call is a path, `f`, `cart::f` or `x.f`, followed directly by a parenthesized tree. A path
 * with anything else in it, a turbofish or a call result, is not a name the graph could resolve and is skipped.
 */
/**
 * The trait a Rust type parameter is bound by, from the type parameters and where clauses around a node: `R` under
 * `impl<'de, R: Read<'de>> Deserializer<R>` or `fn f<T>(v: T) where T: Visitor` is Read, or Visitor. Null for a name that is
 * no bounded parameter here.
 */
function rustBound(node: Node, name: string): string | null {
  const nameOf = (bound: Node | null): string | null => {
    let type = bound;
    for (let hops = 0; type && hops < 4; hops++) {
      if (type.type === 'generic_type') type = child(type, 'type') ?? type.namedChildren[0] ?? null;
      else if (type.type === 'scoped_type_identifier') type = child(type, 'name');
      else if (type.type === 'reference_type' || type.type === 'dynamic_type') type = child(type, 'type') ?? type.namedChildren.at(-1) ?? null;
      else break;
    }
    return type?.type === 'type_identifier' ? text(type) : null;
  };
  const firstBound = (bounds: Node | null): string | null => {
    for (const item of bounds?.namedChildren ?? []) { const found = nameOf(item); if (found) return found; }
    return null;
  };
  for (let parent = node.parent; parent; parent = parent.parent) {
    for (const parameters of parent.namedChildren.filter(item => item.type === 'type_parameters')) {
      for (const parameter of parameters.namedChildren) {
        if (text(child(parameter, 'name') ?? parameter.namedChildren[0] ?? null) !== name) continue;
        const bound = firstBound(child(parameter, 'bounds') ?? parameter.namedChildren.find(item => item.type === 'trait_bounds') ?? null);
        if (bound) return bound;
      }
    }
    for (const clause of parent.namedChildren.filter(item => item.type === 'where_clause')) {
      for (const predicate of clause.namedChildren) {
        if (text(child(predicate, 'left') ?? predicate.namedChildren[0] ?? null) !== name) continue;
        const bound = firstBound(child(predicate, 'bounds') ?? predicate.namedChildren.find(item => item.type === 'trait_bounds') ?? null);
        if (bound) return bound;
      }
    }
  }
  return null;
}

/**
 * The bound a struct's type parameter carries on the struct's impl blocks: `struct Deserializer<R> { read: R }` says nothing of
 * R, and `impl<'de, R: Read<'de>> Deserializer<R>` says it is a Read. The first impl of the struct in the file that bounds it.
 */
function rustImplBound(struct: Node, name: string): string | null {
  const structName = text(child(struct, 'name'));
  let root: Node = struct;
  while (root.parent) root = root.parent;
  for (const item of walkNodes(root)) {
    if (item.type !== 'impl_item' || implTypeName(item) !== structName) continue;
    const parameters = item.namedChildren.find(child => child.type === 'type_parameters');
    const probe = parameters?.namedChildren.find(child => text(child.childForFieldName('name') ?? child.namedChildren[0] ?? null) === name) ?? null;
    const bound = probe ? rustBound(probe, name) : null;
    if (bound) return bound;
  }
  return null;
}

/**
 * What a call inside a macro passes, from its argument tokens: each top-level item that is a name, `&mut de` or `de`, as the
 * local it is. Anything else is null, an argument whose value the tokens do not spell. `tri!(T::deserialize(&mut de))` hands
 * the deserializer on, and what it was handed to may run any of its methods.
 */
function macroArguments(tree: Node): Array<Held | null> {
  const tokens = Array.from({ length: tree.childCount }, (_, index) => tree.child(index)!).slice(1, -1);
  const items: Node[][] = [[]];
  for (const token of tokens) { if (token.type === ",") items.push([]); else items[items.length - 1].push(token); }
  return items.filter(item => item.length).map(item => {
    const bare = item.filter(token => !["&", "mut"].includes(token.text));
    return bare.length === 1 && bare[0].type === "identifier" ? { local: bare[0].text } : null;
  });
}

/** The standard library's macros: a call of one names nothing in the repository. */
const STD_MACROS = new Set(['assert', 'assert_eq', 'assert_ne', 'debug_assert', 'debug_assert_eq', 'debug_assert_ne', 'format', 'format_args', 'print', 'println', 'eprint', 'eprintln',
  'write', 'writeln', 'vec', 'panic', 'todo', 'unimplemented', 'unreachable', 'matches', 'dbg', 'cfg', 'env', 'option_env', 'concat', 'stringify', 'include', 'include_str', 'include_bytes',
  'line', 'column', 'file', 'module_path', 'compile_error', 'try', 'thread_local', 'macro_rules']);

function rustMacroCalls(tree: Node): Reference[] {
  const tokens = Array.from({ length: tree.childCount }, (_, index) => tree.child(index)!);
  const calls: Reference[] = [];
  // What each call's result holds, by the index of its argument list: `Version::new(1, 4, 7).bump(..)` is a bump of what new
  // returns, and `.unwrap()` or `?` on it hands the same value on.
  const results = new Map<number, Held | null>();
  for (let after = 0; after + 1 < tokens.length; after += 1) {
    const next = tokens[after + 1];
    // `json!(null)` inside another macro's arguments: a call of that macro, whose own arguments are read as a token tree of their own.
    if (next.type === "!" && tokens[after].type === "identifier" && tokens[after + 2]?.type === "token_tree") {
      const name = validReference(tokens[after].text);
      if (name !== "<dynamic>" && !STD_MACROS.has(name) && tokens[after - 1]?.type !== "::") calls.push(makeReference("call", tokens[after], { name, reference: name }));
      continue;
    }
    if (next.type !== "token_tree" || next.child(0)?.type !== "(") continue;
    // `parse::<i32>(text)` calls parse: the name is the identifier before the turbofish.
    let at = after;
    if (tokens[after].type === ">") {
      let depth = 0, open = after;
      for (; open >= 0; open -= 1) { if (tokens[open].type === ">") depth += 1; else if (tokens[open].type === "<" && --depth === 0) break; }
      if (open < 2 || tokens[open - 1].type !== "::") continue;
      at = open - 2;
    }
    if (tokens[at].type !== "identifier") continue;
    const parts = [tokens[at].text];
    let start = at, broken = false;
    while (start >= 2 && ["::", "."].includes(tokens[start - 1].type)) {
      const before = tokens[start - 2];
      if (!["identifier", "self", "super", "crate"].includes(before.type)) { broken = true; break; }
      parts.unshift(before.text, tokens[start - 1].type);
      start -= 2;
    }
    if (broken && start === at && tokens[at - 1]?.type === ".") {
      const receiver = tokens[at - 2]?.type === "?" ? at - 3 : at - 2;
      if (!results.has(receiver)) continue;
      const held = results.get(receiver) ?? null;
      if (UNWRAPS.has(tokens[at].text)) { results.set(after + 1, held); continue; }
      calls.push(makeReference("call", tokens[at], { name: `$receiver.${tokens[at].text}`, reference: `$receiver.${tokens[at].text}`, held }));
      results.set(after + 1, held ? { call: `$receiver.${tokens[at].text}`, on: held } : null);
      continue;
    }
    if (broken || (start >= 1 && ["::", ".", "fn"].includes(tokens[start - 1].type))) continue;
    const name = validReference(parts.join(""));
    if (name === "<dynamic>") continue;
    const args = macroArguments(next);
    calls.push(makeReference("call", tokens[start], { name, reference: name, ...(args.some(Boolean) ? { args } : {}) }));
    const local = parts.length === 3 && parts[1] === "." ? parts[0] : null;
    results.set(after + 1, local ? { call: `$receiver.${tokens[at].text}`, on: { local } } : { call: name });
  }
  return calls;
}

/**
 * Member access that reads through an object by name: `process.env.KEY`, `os.environ`, `config.url`. A call records its callee
 * already; this is the access nothing calls, which is how a program reads its environment and much of its configuration. Only
 * the whole chain is kept, since `a.b.c` read once is not also a read of `a.b`.
 */
const MEMBER_TYPES = new Set([
  "member_expression",
  "attribute",
  "field_access",
  "field_expression",
  "navigation_expression",
  "selector_expression",
  "member_access_expression",
]);

/** The child of a member access that holds the object it is read from. */
function memberObject(node: Node): Node | null {
  return child(node, "object", "value", "argument", "operand") ?? node.namedChildren[0] ?? null;
}

/** Whether `node` is the whole of a member chain and not the callee of a call: the part a read is recorded for. */
function isMemberRead(node: Node): boolean {
  if (!MEMBER_TYPES.has(node.type)) return false;
  // Solidity wraps the callee in an `expression` node between the call and the member access.
  const parent = node.parent?.type === 'expression' && node.parent.namedChildren.length === 1 ? node.parent.parent : node.parent;
  if (!parent) return true;
  if (MEMBER_TYPES.has(parent.type) && memberObject(parent)?.id === node.id) return false;
  // The object of a member call, `$this->cart` in `$this->cart->total()`, is part of the call rather than a read of its own.
  if (MEMBER_CALLS.has(parent.type) && child(parent, "object", "scope")?.id === node.id) return false;
  const callee = CALL_TYPES.has(parent.type) ? referenceBase(parent) : null;
  return !(callee && (callee.id === node.id || (callee.type === 'expression' && callee.namedChildren[0]?.id === node.id)));
}

const COMMONJS = new Set(["javascript", "typescript", "tsx"]);

/**
 * `export * from "./m"` and `export { a, b as c } from "./m"`: names this module passes on from another without defining them, as
 * a TypeScript barrel file does. Recorded as imports marked `reexport`, so a lookup that misses here follows them to the definition.
 */
function reexportReferences(node: Node): Reference[] {
  const module = stripModule(text(node.childForFieldName("source")));
  const record = (imported: string, alias: string | null) => makeReference("import", node, { name: module, reference: module, module, imported_name: imported, alias, reexport: true });
  const clause = node.namedChildren.find((item) => item.type === "export_clause");
  if (!clause) {
    const namespace = node.namedChildren.find((item) => item.type === "namespace_export");
    return [record("*", namespace ? text(namespace.namedChildren.at(-1) ?? null) || null : null)];
  }
  return clause.namedChildren.filter((item) => item.type === "export_specifier").map((item) => {
    const name = text(item.childForFieldName("name"));
    return record(name, text(item.childForFieldName("alias")) || name);
  });
}

/** `require("./foo")` with a literal path: CommonJS's import, which is a call to the grammar. */
function isRequire(node: Node, language: string): boolean {
  if (!COMMONJS.has(language) || node.type !== "call_expression") return false;
  const callee = referenceBase(node);
  const argument = child(node, "arguments")?.namedChildren[0] ?? null;
  return callee?.type === "identifier" && text(callee) === "require" && argument?.type === "string";
}

/** The one string a call is given, `require "cart"` or `require("cart")`, as the module it names; null for anything computed. */
function requiredModule(node: Node): string | null {
  const argument = child(node, "arguments")?.namedChildren.find(item => !isComment(item)) ?? null;
  return argument?.type === "string" ? stripModule(text(argument)) : null;
}

/**
 * Ruby's `require "cart"` and `require_relative "../lib/cart"`: the file's constants and methods become visible here, as a Python
 * `from m import *` makes a module's. A relative require is recorded with its `./` or `../` so the graph looks beside the
 * requiring file; a plain one is looked for on the load path.
 */
function rubyRequire(node: Node): Reference[] {
  if (node.type !== "call" || child(node, "receiver")) return [];
  const method = text(child(node, "method"));
  if (method !== "require" && method !== "require_relative") return [];
  const named = requiredModule(node);
  if (!named) return [];
  const module = method === "require_relative" && !/^\.\.?\//.test(named) ? `./${named}` : named;
  return [makeReference("import", node, { name: module, reference: module, module, imported_name: "*", alias: null })];
}

/**
 * Lua's `local cart = require("src.cart")` binds the module's returned table to a name, so `cart.total()` is total in that
 * module. A `require` bound to nothing loads the module for what it does on load.
 */
function luaRequire(node: Node): Reference[] {
  if (node.type !== "function_call" || text(child(node, "name")) !== "require") return [];
  const module = requiredModule(node);
  if (!module) return [];
  // `local cart = require(...)`: the one name of the assignment the call is the one value of.
  const list = node.parent?.type === "expression_list" ? node.parent : null;
  const assignment = list?.parent?.type === "assignment_statement" ? list.parent : null;
  const names = assignment?.namedChildren.find(item => item.type === "variable_list")?.namedChildren ?? [];
  const bound = list?.namedChildren.length === 1 && names.length === 1 && names[0].type === "identifier" ? text(names[0]) : null;
  return [makeReference("import", node, { name: module, reference: module, module, imported_name: "*", alias: bound })];
}

/** PHP's require and include: `require_once __DIR__ . '/../bootstrap.php'` brings a file's declarations in, as Ruby's require does. */
const PHP_INCLUDES = new Set(["require_expression", "require_once_expression", "include_expression", "include_once_expression"]);
function phpInclude(node: Node): Reference[] {
  if (!PHP_INCLUDES.has(node.type)) return [];
  const argument = node.namedChildren.find(item => !isComment(item)) ?? null;
  let module: string | null = null;
  if (argument?.type === "string" || argument?.type === "encapsed_string") module = stripModule(text(argument));
  else if (argument?.type === "binary_expression" && text(child(argument, "left")) === "__DIR__") {
    const right = child(argument, "right");
    if (right?.type === "string" || right?.type === "encapsed_string") module = `.${stripModule(text(right))}`;
  }
  if (!module) return [];
  return [makeReference("import", node, { name: module, reference: module, module, imported_name: "*", alias: null })];
}

/**
 * PHP's `use App\Cart;`, `use App\Cart as C;`, `use function App\helper;` and the group form `use App\{Cart, Money};`: each binds
 * one name from a namespace, which is the module, as a Java import binds a class from a package.
 */
function phpUseReferences(node: Node): Reference[] {
  const references: Reference[] = [];
  const group = child(node, "body");
  const prefix = group ? text(node.namedChildren.find(item => item.type === "namespace_name") ?? null) : "";
  const clauses = (group ?? node).namedChildren.filter(item => item.type === "namespace_use_clause");
  for (const clause of clauses) {
    const path = clause.namedChildren.find(item => item.type === "qualified_name" || item.type === "name");
    if (!path) continue;
    const segments = [...(prefix ? prefix.split("\\") : []), ...text(path).replace(/^\\/, "").split("\\")];
    const name = segments.pop() ?? "";
    const alias = text(child(clause, "alias")) || name;
    const module = segments.join("\\");
    references.push(makeReference("import", clause, { name: module ? `${module}\\${name}` : name, reference: module ? `${module}\\${name}` : name, module, imported_name: name, alias }));
  }
  return references;
}

/**
 * The names a `require` binds: the whole module as `x` in `const x = require("m")`, each name in `const { a, b: c } = require("m")`,
 * and the module alone when nothing is bound. Recorded as imports, so a call through them resolves as it does through `import`.
 */
function requireReferences(node: Node): Reference[] {
  const module = stripModule(text(child(node, "arguments")?.namedChildren[0] ?? null));
  const bound = node.parent?.type === "variable_declarator" ? node.parent.childForFieldName("name") : null;
  const record = (imported: string, alias: string | null) => makeReference("import", node, { name: module, reference: module, module, imported_name: imported, alias });
  if (bound?.type === "identifier") return [record("*", text(bound))];
  // `exports.request = require('./request')`: the module passes another on under a name, as `export * as request from` does.
  const assigned = node.parent?.type === "assignment_expression" ? node.parent.childForFieldName("left") : null;
  const passed = assigned && /^(?:module\.)?exports\.([\p{L}_$][\p{L}\p{N}_$]*)$/u.exec(text(assigned));
  if (passed) return [makeReference("import", node, { name: module, reference: module, module, imported_name: "*", alias: passed[1], reexport: true })];
  if (bound?.type === "object_pattern") {
    const names = bound.namedChildren.flatMap((item) => {
      if (item.type === "shorthand_property_identifier_pattern") return [record(text(item), text(item))];
      if (item.type === "pair_pattern") return [record(text(item.childForFieldName("key")), text(item.childForFieldName("value")))];
      return [];
    });
    if (names.length) return names;
  }
  return [record("*", null)];
}

/** Types that hold one value of another: an `Option<Ledger>` or a `Promise<Ledger>` is, for a call on what it gives, a Ledger. */
const WRAPPERS = new Set(['Option', 'Result', 'Box', 'Rc', 'Arc', 'RefCell', 'Cow', 'Optional', 'Promise', 'Awaitable', 'Future', 'unique_ptr', 'shared_ptr']);

/** A type as written, without its arguments or its pointer: `Ledger<T>`, `Ledger*` and `&mut Ledger` are Ledger. */
function typeName(written: string): string | null {
  let type = written.replace(/^:\s*/, '').replace(/^->\s*/, '').replace(/\s+/g, ' ').trim()
    .replace(/^(const|mut|dyn|impl|final|readonly)\s+/, '').replace(/[*&]+/g, '').replace(/^(mut|const)\s+/, '').replace(/\s+(const)$/, '').trim();
  const generic = /^([\p{L}_][\p{L}\p{N}_.:]*)\s*<(.*)>$/su.exec(type);
  if (generic) {
    const head = generic[1].split(/::|\./).at(-1)!;
    if (WRAPPERS.has(head)) {
      let depth = 0, first = '';
      for (const character of generic[2]) { if (character === '<') depth++; if (character === '>') depth--; if (character === ',' && depth === 0) break; first += character; }
      return typeName(first);
    }
    type = generic[1];
  }
  type = type.replace(/\[\]$/, '').replace(/\s/g, '');
  return /^[\p{L}_][\p{L}\p{N}_.:]*$/u.test(type) && !['var', 'auto', 'Self', 'self'].includes(type) ? type : null;
}
const bareType = (node: Node | null): string | null => {
  if (!node || ['placeholder_type_specifier', 'void_type', 'primitive_type', 'integral_type', 'floating_point_type', 'boolean_type', 'unit_type'].includes(node.type)) return null;
  // PHP's `?Cart` and `Cart|null` hold a Cart when they hold anything; `\App\Cart` is Cart by the name its file sees.
  if (node.type === 'optional_type') return bareType(node.namedChildren[0] ?? null);
  if (node.type === 'union_type') {
    const named = node.namedChildren.filter(item => item.type === 'named_type');
    return named.length === 1 ? bareType(named[0]) : null;
  }
  if (node.type === 'named_type') return typeName(text(node).split('\\').at(-1) ?? '');
  return typeName(text(node));
};

/** The class a `new` expression constructs. PHP's grammar gives the name no field: it is the first name after `new`. */
const constructedType = (node: Node): string | null =>
  bareType(child(node, 'constructor', 'type', 'name') ?? node.namedChildren.find(item => item.type === 'name' || item.type === 'qualified_name') ?? null);
/** Calls that hand back the one value they were given or hold: `Some(x)`, `Ok(x)`, `Box::new(x)`, `x.unwrap()`, `x?`. */
const PASS_THROUGH = new Set(['Some', 'Ok', 'Box::new', 'Rc::new', 'Arc::new', 'RefCell::new', 'Optional.of', 'Promise.resolve']);
// Rust's `map_err`, `ok_or` and `context` change only the error a Result or an Option carries, and `as_ref` or `borrow` only how
// the value is held: `Version::parse(v).map_err(..)?` is a Version.
const UNWRAPS = new Set(['unwrap', 'expect', 'unwrap_or_default', 'unwrap_or', 'unwrap_or_else', 'clone', 'to_owned', 'get', 'orElseThrow', 'value',
  'map_err', 'ok_or', 'ok_or_else', 'context', 'with_context', 'as_ref', 'as_mut', 'borrow', 'borrow_mut']);

/**
 * What a value is, when its source says: an instance of a class it constructs (`new Ledger()`, `Ledger { .. }`), or the result of
 * a call whose type is found later (`make()`, `Ledger::new()`, `Ledger(1)` in Python, where a class is called like a function).
 */
function valueOf(value: Node | null, language: string): Held | null {
  if (!value) return null;
  if (['parenthesized_expression', 'await_expression', 'try_expression', 'reference_expression'].includes(value.type)) return valueOf(value.namedChildren.at(-1) ?? null, language);
  // Solidity wraps each operand in `expression`, Zig each in an ErrorUnionExpr: one node that adds nothing to what is inside it.
  if (['expression', 'ErrorUnionExpr'].includes(value.type) && value.namedChildren.length === 1) return valueOf(value.namedChildren[0], language);
  // Zig's `try f()` and `await f()` hold what f returns.
  if (value.type === 'UnaryExpr' && ['try', 'await'].includes(child(value, 'operator')?.text ?? '')) return valueOf(child(value, 'left'), language);
  if (value.type === 'SuffixExpr') return zigChain(value).value;
  // `return this` or `self`: a fluent method hands back an instance of its own class.
  if (['this', 'self'].includes(value.type) || (value.type === 'identifier' && text(value) === 'self') || (value.type === 'variable_name' && text(value) === '$this')) return { type: '$self' };
  // A local handed on: `t` at the end of a Rust function, `return entry`, followed to what that local holds.
  if (value.type === 'identifier') return { local: text(value) };
  // A function written in place, `{ readSource: file => read(file) }` or `return { update }`: the value is that function.
  if (ANONYMOUS_FUNCTION_TYPES.has(value.type)) return { fn: `function:${value.startIndex}` };
  // An object literal: what each of its fields holds, so a member of it, or a parameter destructured from it, is found.
  if (value.type === 'object') return objectFields(value, language);
  // `items[0]`: an element of a typed list is of the list's element type, which is what a `Money[]` is recorded as.
  if (['subscript_expression', 'index_expression', 'subscript', 'element_reference'].includes(value.type)) return valueOf(child(value, 'object', 'value') ?? value.namedChildren[0] ?? null, language);
  if (CALL_TYPES.has(value.type)) {
    const callee = referenceBase(value);
    // Solidity's `new Cart(3)` is a call whose callee is the construction.
    const constructed = callee?.type === 'expression' ? callee.namedChildren[0] : callee;
    if (constructed?.type === 'new_expression') return { type: bareType(child(constructed, 'constructor', 'type', 'name')) };
    const argument = child(value, 'arguments')?.namedChildren.find(item => !isComment(item)) ?? null;
    if (PASS_THROUGH.has(pathText(callee, language))) return valueOf(argument, language);
    const split = memberOf(callee, language);
    if (split && UNWRAPS.has(split.member)) return valueOf(split.receiver, language);
  }
  // Scala's uniform access: `Money.zero` or `entry.imbalance` written without parentheses runs the parameterless method it names,
  // so as a value it is what that method returns, as the call `Money.zero()` would be.
  if (language === 'scala' && value.type === 'field_expression') {
    const name = validReference(pathText(value, language));
    if (name !== '<dynamic>') return { call: name };
    const split = memberOf(value, language);
    const on = split ? receiverOf(split.receiver, language) : null;
    return on && split?.member ? { call: `$receiver.${split.member}`, on } : null;
  }
  if (value.type === 'new_expression' || value.type === 'object_creation_expression') return { type: constructedType(value) };
  if (value.type === 'struct_expression') return { type: bareType(child(value, 'name')) };
  // Go: `Cart{}` and `&Cart{}` make a Cart, and `new(Cart)` a pointer to one, which is called through the same way.
  if (language === 'go') {
    if (value.type === 'unary_expression' && value.children[0]?.text === '&') return valueOf(child(value, 'operand'), language);
    const made = value.type === 'composite_literal' ? bareType(child(value, 'type'))
      : value.type === 'call_expression' && referenceBase(value)?.text === 'new' ? bareType(child(value, 'arguments')?.namedChildren[0] ?? null) : null;
    if (made) return { type: made };
  }
  // Scala's `new Cart()`: the type is the first named child after `new`.
  if (value.type === 'instance_expression') return { type: bareType(value.namedChildren.find(item => item.type.endsWith('type') || item.type === 'type_identifier') ?? null) };
  if (CALL_TYPES.has(value.type)) {
    const callee = callReference(value, language);
    if (callee === '<dynamic>') return null;
    // `Entry(day).debit(...)`: a member of what the receiver holds, kept with the receiver so a chain of them is followed.
    const on = callee.startsWith('$receiver.') ? receiverOf(memberOf(calleeOf(value), language)?.receiver ?? null, language) : null;
    return on ? { call: callee, on } : { call: callee };
  }
  return null;
}

/** `const ledger = new Ledger()`, `Ledger a(1);`, `let l: Ledger = make();`, `self.store = Store()`: a name and what it holds. */
function bindingOf(node: Node, language: string): { name: string; held: Held } | null {
  let name: Node | null, type: Node | null = null, value: Node | null = null, constructed: string | null = null;
  if (node.type === 'variable_declarator') {
    name = child(node, 'name'); value = child(node, 'value');
    // Java writes the type on the declaration around the declarator; so does C#, as a variable_declaration, with the value a
    // child of the declarator after its `=` and no field of its own.
    type = child(node, 'type') ?? (['local_variable_declaration', 'field_declaration', 'variable_declaration'].includes(node.parent?.type ?? '') ? child(node.parent!, 'type') : null);
    if (!value && node.parent?.type === 'variable_declaration') value = node.namedChildren.find(item => item !== name && !isComment(item)) ?? null;
  } else if (node.type === 'assignment' || node.type === 'assignment_expression') {
    name = child(node, 'left', 'target'); value = child(node, 'right', 'result');
    // Swift wraps the assigned name: `cart = Cart()` assigns to a directly_assignable_expression holding the identifier.
    if (name?.type === 'directly_assignable_expression') name = name.namedChildren[0] ?? null;
  } else if (node.type === 'property_declaration' && language === 'swift') {
    // `let cart = Cart()` and `var cart: Cart!`: the name is the bound identifier of the pattern, the type its annotation.
    name = child(node, 'name')?.childForFieldName('bound_identifier') ?? null;
    type = node.namedChildren.find(item => item.type === 'type_annotation')?.childForFieldName('name') ?? null;
    value = child(node, 'value');
  } else if (node.type === 'val_definition' || node.type === 'var_definition') {
    // Scala's `val cart = new Cart()` and `var cart: Cart = _`.
    name = child(node, 'pattern'); type = child(node, 'type'); value = child(node, 'value');
    if (value?.type === 'wildcard') value = null;
  } else if (node.type === 'assignment_statement' && language === 'lua') {
    // `self.c = cart.new(3)` and `local cart = require(...)`: Lua lists the names and the values side by side.
    const names = node.namedChildren.find(item => item.type === 'variable_list')?.namedChildren ?? [];
    const values = node.namedChildren.find(item => item.type === 'expression_list')?.namedChildren ?? [];
    if (names.length !== 1 || values.length !== 1) return null;
    name = names[0]; value = values[0];
  } else if (node.type === 'call' && language === 'ruby') {
    // RSpec's `let(:cart) { Cart.new(3) }` and `subject(:cart) { ... }` define a method named by the symbol, whose value is the
    // block's last expression; a test then writes `cart.total` as it would for a local.
    const method = text(child(node, 'method')), symbol = child(node, 'arguments')?.namedChildren[0], block = child(node, 'block');
    if (!['let', 'let!', 'subject'].includes(method) || child(node, 'receiver') || symbol?.type !== 'simple_symbol' || !block) return null;
    const last = child(block, 'body')?.namedChildren.filter(item => !isComment(item)).at(-1) ?? null;
    const held = valueOf(last, language);
    return held ? { name: symbol.text.slice(1), held } : null;
  } else if (node.type === 'property_declaration' && language === 'php') {
    // `private Cart $cart;` in a class: a member the class's methods reach as `$this->cart`.
    type = child(node, 'type');
    name = node.namedChildren.find(item => item.type === 'property_element')?.childForFieldName('name') ?? null;
    const written = name ? `this.${text(name).replace(/^\$/, '')}` : '';
    const declared = bareType(type);
    return written && declared ? { name: written, held: { type: declared } } : null;
  } else if (node.type === 'field_declaration' && (language === 'cpp' || language === 'c')) {
    // `Ledger book_{Currency::USD};` in a class: a member the class's methods name bare.
    type = child(node, 'type');
    const declarator = child(node, 'declarator');
    name = declarator?.type === 'pointer_declarator' || declarator?.type === 'reference_declarator' ? declarator.namedChildren.at(-1) ?? null : declarator;
  } else if (node.type === 'property_declaration' && language === 'kotlin') {
    // `val source: Source = make()`: the name and type are in the variable_declaration, the value after it.
    const variable = node.namedChildren.find(item => item.type === 'variable_declaration');
    if (!variable) return null;
    name = variable.namedChildren.find(item => item.type === 'simple_identifier') ?? null;
    type = variable.namedChildren.find(item => item.type === 'user_type' || item.type === 'nullable_type') ?? null;
    const after = node.namedChildren.slice(node.namedChildren.indexOf(variable) + 1).filter(item => !isComment(item));
    value = after.find(item => !['property_delegate', 'getter', 'setter', 'type_constraints'].includes(item.type)) ?? null;
  } else if (node.type === 'let_declaration') {
    name = child(node, 'pattern'); type = child(node, 'type'); value = child(node, 'value');
  } else if (node.type === 'init_declarator' || (node.type === 'declaration' && language !== 'python')) {
    const declaration = node.type === 'init_declarator' ? node.parent : node;
    if (declaration?.type !== 'declaration') return null;
    type = child(declaration, 'type');
    const declarator = node.type === 'init_declarator' ? child(node, 'declarator') : child(node, 'declarator');
    name = declarator?.type === 'pointer_declarator' || declarator?.type === 'reference_declarator' ? declarator.namedChildren.at(-1) ?? null
      : declarator && constructedInBody(declarator) ? child(declarator, 'declarator') : declarator;
    if (node.type === 'init_declarator') value = child(node, 'value');
    if (value?.type === 'argument_list' || value?.type === 'initializer_list') value = null;
  } else if (node.type === 'VarDecl') {
    // Zig's `const c = Cart.init(a);` and `var c: Cart = undefined;`: the type follows the colon and the value the equals sign.
    name = child(node, 'variable_type_function');
    const colon = node.children.findIndex(item => !item.isNamed && item.text === ':'), equals = node.children.findIndex(item => !item.isNamed && item.text === '=');
    type = colon >= 0 ? node.children[colon + 1] ?? null : null;
    value = equals >= 0 ? node.children[equals + 1] ?? null : null;
    // `const line = Line{ .qty = 1 }`: the type's expression and then the initializer list, side by side in the declaration.
    if (value && node.children[equals + 2]?.type === 'InitList') { constructed = typeName(text(value)); value = null; }
  } else if (node.type === 'state_variable_declaration') {
    // Solidity's `Cart internal cart;` in a contract body, which the contract's functions name bare.
    name = child(node, 'name'); type = child(node, 'type'); value = child(node, 'value');
  } else return null;
  // Ruby's `@cart` and PHP's `$this->cart` are the instance's own member, which every other language here writes `this.cart`.
  const written = text(name).replace(/^self\./, 'this.').replace(/^@(?=[\p{L}_])/u, 'this.').replace(/^\$this->/, 'this.');
  if (!written || written === '_' || !/^(this\.)?[\p{L}_$][\p{L}\p{N}_$]*$/u.test(written)) return null;
  const held = valueOf(value, language) ?? (constructed ? { type: constructed } : null);
  const declared = node.type === 'VarDecl' ? zigBareType(type) : bareType(type);
  if (!declared && !held) return null;
  // An object literal keeps its fields beside the declared type: `const OTHERS: Record<string, Reader> = { go: goTests }` is a table.
  return { name: written, held: held?.fields ? { ...held, ...(declared ? { type: declared } : {}) } : declared ? { type: declared } : held! };
}

/**
 * Go's bindings: `c := New()`, `c = New()`, `var c Cart`, `var c = New()`, and a parameter or a method's receiver, `c *Cart`.
 * `c, err := New()` hands one call's results to every name on the left; the first takes the value, the rest an error.
 */
function goBindings(node: Node): Array<{ name: string; held: Held }> {
  const bound: Array<{ name: string; held: Held }> = [];
  const identifiers = (within: Node | null) => (within?.namedChildren ?? []).filter(item => item.type === 'identifier');
  const assigns = node.type === 'assignment_statement' && (child(node, 'operator') ?? node.children.find(item => !item.isNamed))?.text === '=';
  if (node.type === 'short_var_declaration' || assigns) {
    const names = child(node, 'left')?.namedChildren ?? [], values = child(node, 'right')?.namedChildren ?? [];
    for (const [at, name] of names.entries()) {
      const value = values.length === names.length ? values[at] : at === 0 && values.length === 1 ? values[0] : null;
      const held = value ? valueOf(value, 'go') : null;
      if (name.type === 'identifier' && held) bound.push({ name: name.text, held });
    }
  } else if (node.type === 'var_spec') {
    const declared = bareType(child(node, 'type'));
    const held = declared ? { type: declared } : valueOf(child(node, 'value')?.namedChildren[0] ?? null, 'go');
    if (held) for (const name of identifiers(node)) bound.push({ name: name.text, held });
  } else if (node.type === 'parameter_declaration' || node.type === 'variadic_parameter_declaration') {
    const declared = bareType(child(node, 'type'));
    if (declared) for (const name of identifiers(node)) bound.push({ name: name.text, held: { type: declared } });
  }
  return bound;
}

/** A Go function's first result, `*Cart` in `func New() (*Cart, error)`: the value a caller binds first. */
function goResult(node: Node): Node | null {
  const result = child(node, 'result');
  if (result?.type !== 'parameter_list') return result;
  const first = result.namedChildren.find(item => item.type === 'parameter_declaration');
  return first ? child(first, 'type') ?? first : null;
}


/**
 * The classes a class extends or implements, by name: `class A(Base)`, `extends Base implements I`, `: public Base`. A Rust
 * `impl Trait for Type` makes Type one that implements Trait; an anonymous class extends the type it is made from.
 */
function basesOf(node: Node): string[] {
  const names: Node[] = [];
  if (node.type === 'impl_item') {
    let trait = child(node, 'trait');
    if (trait?.type === 'generic_type') trait = child(trait, 'type') ?? trait.namedChildren[0] ?? null;
    if (trait?.type === 'scoped_type_identifier') trait = child(trait, 'name');
    return trait ? [text(trait)] : [];
  }
  if (isAnonymousClass(node)) {
    let base = node.type === 'object_creation_expression' ? child(node, 'type')
      : node.namedChildren.find(item => item.type === 'delegation_specifier')?.namedChildren.flatMap(item => [...walkNodes(item)]).find(item => item.type === 'user_type' || item.type === 'type_identifier') ?? null;
    // Java's generic_type gives its name no field: `TypeAdapter<Boolean>` is its first child.
    if (base?.type === 'generic_type') base = child(base, 'type') ?? base.namedChildren[0] ?? null;
    return base ? [text(base).split('<')[0]] : [];
  }
  // Scala's `class A extends B with C`: the extends clause lists each type. Python's class_definition has superclasses instead.
  if (['class_definition', 'object_definition', 'trait_definition'].includes(node.type)) names.push(...(child(node, 'extend')?.namedChildren.filter(item => item.type.endsWith('type') || item.type === 'type_identifier') ?? []));
  if (node.type === 'class_definition') names.push(...(child(node, 'superclasses')?.namedChildren ?? []));
  // Solidity's `contract Inventory is Pausable, Ownable(owner)`: each inheritance specifier names a base.
  else if (node.type === 'contract_declaration') {
    for (const item of node.namedChildren.filter(item => item.type === 'inheritance_specifier')) {
      const base = child(item, 'ancestor') ?? item.namedChildren[0];
      if (base) names.push(base);
    }
  } else if (node.type === 'class_declaration' || node.type === 'class' || node.type === 'class_specifier' || node.type === 'struct_specifier') {
    const superclass = child(node, 'superclass');
    if (superclass) names.push(...superclass.namedChildren);
    // Swift's `class A: B, C` lists each as an inheritance specifier.
    for (const item of node.namedChildren.filter(item => item.type === 'inheritance_specifier')) names.push(child(item, 'inherits_from') ?? item);
    for (const list of node.namedChildren.filter(item => ['class_heritage', 'super_interfaces', 'base_class_clause', 'base_list', 'base_clause', 'class_interface_clause'].includes(item.type))) {
      for (const item of list.namedChildren) {
        if (item.type === 'extends_clause') names.push(child(item, 'value') ?? item.namedChildren[0]!);
        else if (item.type === 'implements_clause' || item.type === 'type_list') names.push(...item.namedChildren);
        else if (item.type !== 'access_specifier') names.push(item);
      }
    }
  }
  return names.map(item => typeName(text(item).replace(/^(public|private|protected|virtual)\s+/, ''))).filter((name): name is string => Boolean(name) && name !== 'object');
}

/** A parameter with a declared type: `entry: Entry`, `Entry entry`, `entry: &Entry`, `const Entry& entry`. */
function parameterOf(node: Node): { name: string; held: Held } | null {
  let name: Node | null, type: Node | null;
  if (node.type === 'typed_parameter') { name = node.namedChildren.find(item => item.type === 'identifier') ?? null; type = child(node, 'type'); }
  else if (node.type === 'typed_default_parameter') { name = child(node, 'name'); type = child(node, 'type'); }
  else if (node.type === 'required_parameter' || node.type === 'optional_parameter') { name = child(node, 'pattern'); type = child(node, 'type'); }
  // Scala's `class Quoter(card: RateCard)`: a constructor parameter the class's methods name bare.
  else if (node.type === 'formal_parameter' || node.type === 'parameter' || node.type === 'class_parameter') {
    name = child(node, 'name', 'pattern'); type = child(node, 'type');
    // Swift's parameter holds its type under a second `name` field: `parcel: Parcel` is a simple_identifier and then a user_type.
    if (!type && name?.type === 'simple_identifier') type = node.namedChildren.find(item => item.type === 'user_type' || item.type.endsWith('_type')) ?? null;
  }
  // PHP's `Cart $cart` and a constructor's `private Cart $cart`, which declares the property too.
  else if (node.type === 'simple_parameter' || node.type === 'property_promotion_parameter') { name = child(node, 'name'); type = child(node, 'type'); }
  // `for (Box b : boxes)` and `catch (StockException e)` in Java: a variable with the type written before it.
  else if (node.type === 'enhanced_for_statement') { name = child(node, 'name'); type = child(node, 'type'); }
  else if (node.type === 'catch_formal_parameter') { name = child(node, 'name'); type = node.namedChildren.find(item => item.type === 'catch_type') ?? null; }
  else if (node.type === 'parameter_declaration') {
    type = child(node, 'type');
    let declarator = child(node, 'declarator');
    while (declarator && ['reference_declarator', 'pointer_declarator'].includes(declarator.type)) declarator = declarator.namedChildren.at(-1) ?? null;
    name = declarator;
  }
  // Zig's `self: *Cart` and `line: Line`.
  else if (node.type === 'ParamDecl') { name = child(node, 'parameter'); type = node.namedChildren.find(item => item.type === 'ParamType') ?? null; }
  else return null;
  const written = text(name).replace(/^mut\s+/, '');
  const kind = node.type === 'ParamDecl' ? zigBareType(type) : bareType(type);
  return kind && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(written) ? { name: written, held: { type: kind } } : null;
}

/** A function's declared return type: Python's `-> Entry`, a TypeScript annotation, Java's method type, Rust's `-> Entry`. */
function declaredReturn(node: Node, language: string): string | null {
  if (!isFunction(node)) return null;
  // A Zig prototype ends with its return type, after the parameters and any alignment, calling convention or `!`.
  if (language === 'zig') {
    const last = node.namedChildren.find(item => item.type === 'FnProto')?.namedChildren.at(-1);
    return last && !['IDENTIFIER', 'ParamDeclList'].includes(last.type) ? zigBareType(last) : null;
  }
  // Java's method type, C#'s `returns`, Scala's `return_type`, Go's result; Swift writes the type after `->` with no field for it.
  const arrow = language === 'swift' ? node.children.findIndex(item => item.type === '->') : -1;
  const declared = child(node, 'return_type', 'returns') ?? (['java', 'cpp', 'c', 'c_sharp', 'csharp'].includes(language) ? child(node, 'type') : language === 'go' ? goResult(node) : null)
    ?? (arrow >= 0 ? node.children.slice(arrow + 1).find(item => item.isNamed) ?? null : null);
  // `sort(): this` in TypeScript and `-> Self` in Rust and `: static` or `: self` in PHP: an instance of the class the method is in, whichever that is.
  if (declared && /^(?::|->)?\s*&?\s*(?:mut\s+)?(?:this|Self|self|static)$/.test(text(declared).trim())) return '$self';
  return bareType(declared);
}

/** What a function returns, when it says: `return new Ledger()`, `return make()`, an arrow's body, a Rust block's last expression. */
function returnOf(node: Node, language: string): Node | null {
  if (node.type === 'return_statement' || node.type === 'return_expression' || node.type === 'return') {
    const value = node.namedChildren.find(item => !isComment(item)) ?? null;
    // Go returns an expression_list; its first value is the one a caller binds first. Ruby and Lua list what is returned the same
    // way: `return x` is an argument_list or an expression_list of one.
    if (value?.type === 'expression_list') return value.namedChildren[0] ?? null;
    if (value?.type === 'argument_list') return value.namedChildren.length === 1 ? value.namedChildren[0] : null;
    return value;
  }
  if (node.type === 'arrow_function') { const body = child(node, 'body'); return body && body.type !== 'statement_block' ? body : null; }
  if (language === 'rust' && node.type === 'block' && node.parent?.type === 'function_item') {
    const last = node.namedChildren.filter(item => !isComment(item)).at(-1);
    return last && !last.type.endsWith('_statement') && last.type !== 'let_declaration' ? last : null;
  }
  return null;
}

/**
 * `const { Response } = app` where `const app = require('..')`: each name taken out of a required module is an import of that
 * name from it, as `const { Response } = require('..')` would be.
 */
function destructuredRequires(references: Reference[], taken: Node[]): Reference[] {
  const modules = new Map(references.filter(item => item.kind === "import" && item.imported_name === "*" && item.alias && !item.reexport).map(item => [item.alias!, item]));
  return taken.flatMap(node => {
    const required = modules.get(text(node.childForFieldName("value")));
    if (!required?.module) return [];
    const module = required.module;
    const record = (imported: string, alias: string) => makeReference("import", node, { name: module, reference: module, module, imported_name: imported, alias });
    return (node.childForFieldName("name")?.namedChildren ?? []).flatMap(item => {
      if (item.type === "shorthand_property_identifier_pattern") return [record(text(item), text(item))];
      if (item.type === "pair_pattern") return [record(text(item.childForFieldName("key")), text(item.childForFieldName("value")))];
      return [];
    });
  });
}

/** Bash's `source file` and `. file`, and bats's `load file`: the commands that bring another file's functions into this one. */
const BASH_SOURCES = new Set(['source', '.', 'load']);
/** The builtins that are the shell's own control flow and declarations, as `return` and `let` are statements elsewhere: not calls. */
const BASH_KEYWORDS = new Set(['return', 'exit', 'break', 'continue', 'shift', 'local', 'declare', 'typeset', 'readonly', 'export', 'unset', 'set', 'true', 'false', ':']);

/** A Bash string with nothing expanded in it, as written between its quotes; null when a `$var` or `$(cmd)` is inside. */
function bashLiteral(node: Node): string | null {
  if (node.type === 'word') return node.text;
  if (node.type === 'raw_string') return node.text.slice(1, -1);
  if (node.type !== 'string') return null;
  return node.namedChildren.every(part => part.type === 'string_content') ? node.namedChildren.map(part => part.text).join('') : null;
}

/**
 * A Bash command names what it runs: a function of this file or of one it sourced, or a program outside it. The sourcing commands
 * are imports of the whole file they name, since every function in it becomes callable here. A command whose name is computed,
 * `$cmd`, or a path, `./run.sh`, calls nothing the tree can name.
 */
function bashCommand(node: Node): Reference[] {
  const name = child(node, 'name');
  const word = name?.namedChildren.length === 1 && name.namedChildren[0].type === 'word' ? name.namedChildren[0].text : null;
  if (word === null || BASH_KEYWORDS.has(word)) return [];
  if (!BASH_SOURCES.has(word)) return [callReferenceRecord(node, 'bash')];
  const target = child(node, 'argument');
  const module = target ? bashLiteral(target) : null;
  return module ? [makeReference('import', node, { name: module, reference: module, module, imported_name: '*', alias: '*' })] : [];
}

/** The references stage of the one walk: what each node calls, imports, binds, returns, extends or reads, in walk order. */
export function referenceVisitor(language: string): Visitor & { finish(index: SyntaxIndex): Reference[] } {
  const references: Reference[] = [], taken: Node[] = [];
  const enter = (node: Node): void => {
  if (isComment(node)) return;
  if (COMMONJS.has(language) && node.type === "variable_declarator" && child(node, "name")?.type === "object_pattern" && child(node, "value")?.type === "identifier") taken.push(node);
  // A class's bases: where a method or a field it does not define itself is found.
  const bases = basesOf(node);
  if (bases.length) {
    const name = node.type === 'impl_item' ? implTypeName(node) ?? '' : isAnonymousClass(node) ? qualifiedScopeName(node) ?? '' : text(child(node, 'name'));
    if (name) for (const base of bases) references.push(makeReference('extends', node, { name, reference: base }));
  }
  const bindings = language === 'go' ? goBindings(node) : [bindingOf(node, language) ?? parameterOf(node)].filter((item): item is { name: string; held: Held } => item !== null);
  if (language === 'rust') {
    // `reader: R` where `R: Read`: a value of a type parameter is, to the call graph, a value of the trait that bounds it. A
    // struct's field is bound as `this.field`, with the same substitution, so `self.read.next()` is Read's next.
    for (const binding of bindings) { const bound = binding.held.type && rustBound(node, binding.held.type); if (bound) binding.held = { ...binding.held, type: bound }; }
    if (node.type === 'field_declaration' && node.parent?.parent?.type === 'struct_item') {
      const name = text(child(node, 'name')), type = bareType(child(node, 'type'));
      if (name && type) bindings.push({ name: `this.${name}`, held: { type: rustBound(node, type) ?? rustImplBound(node.parent.parent, type) ?? type } });
    }
  }
  for (const binding of bindings) references.push(makeReference('bind', node, { name: binding.name, reference: binding.name, held: binding.held }));
  // PHP's `__construct(private Calculator $tax)` declares the property too: `$this->tax` holds what the parameter does.
  if (node.type === 'property_promotion_parameter' && bindings[0]) {
    const name = `this.${bindings[0].name.replace(/^\$/, '')}`;
    references.push(makeReference('bind', node, { name, reference: name, held: bindings[0].held }));
  }
  // Declared first, so it is what a function returns ahead of anything its body says.
  const declared = declaredReturn(node, language);
  if (declared) references.push({ ...makeReference('returns', node, { name: 'return', reference: 'return', held: { type: declared } }), source: `function:${node.startIndex}` });
  const returned = returnOf(node, language);
  if (returned) {
    const value = valueOf(returned, language);
    // Owned by the function returning it: an arrow's body and a block's tail belong to the function they are the body of.
    const owner = node.type === 'arrow_function' ? node : node.type === 'block' ? node.parent! : null;
    if (value) references.push({ ...makeReference('returns', returned, { name: 'return', reference: 'return', held: value }),
      ...(owner ? { source: `function:${owner.startIndex}` } : {}) });
  }
  if (language === "php" && node.type === "namespace_use_declaration") {
    references.push(...phpUseReferences(node));
  } else if (IMPORT_TYPES.has(node.type) || (language === "kotlin" && node.type === "import_header")) {
    // Each of these languages places a name by package or module, which its own reader records; the generic reader's record of
    // the directive as a whole would bind nothing.
    // `using` is a keyword to the TypeScript grammar: as a variable name it broke the parse of this whole file.
    if (language === "csharp" || language === "c_sharp") { const directive = csharpUsingReference(node); if (directive) references.push(directive); }
    else if (language === "swift") { const imported = swiftImportReference(node); if (imported) references.push(imported); }
    else if (language === "scala") references.push(...scalaImportReferences(node));
    else {
      if (language !== "kotlin") references.push(...importReferences(node, language));
      const binding = language === "java" || language === "kotlin" ? jvmImportReference(node, language) : null;
      if (binding) references.push(binding);
    }
  } else if (language === "php" && PHP_INCLUDES.has(node.type)) {
    references.push(...phpInclude(node));
  } else if (language === "ruby" && node.type === "call" && rubyRequire(node).length) {
    references.push(...rubyRequire(node));
  } else if (language === "lua" && node.type === "function_call" && luaRequire(node).length) {
    references.push(...luaRequire(node));
  } else if (language === 'bash' && node.type === 'command') {
    references.push(...bashCommand(node));
  } else if (language === 'groovy' && node.type === 'func') {
    const unit = node.parent, block = unit?.parent;
    // A declaration's signature also contains a func node; only uses are calls.
    if (block?.type === 'block' && block.namedChildren[0]?.id === unit?.id && callableName(block)) return;
    const name = validReference(text(node.namedChildren[0]));
    references.push(makeReference('call', node, { name, reference: name }));
  } else if (COMMONJS.has(language) && node.type === "export_statement" && node.childForFieldName("source")) {
    references.push(...reexportReferences(node));
  } else if (node.type === 'using_declaration') {
    // `using namespace ledger;` and `using ledger::Money;`: recorded among the imports, the namespace or the name as the
    // module, for calls that name it without its namespace.
    const named = node.namedChildren.find(item => item.type === 'identifier' || item.type === 'namespace_identifier' || item.type === 'qualified_identifier');
    const whole = node.children.some(item => item.type === 'namespace');
    if (named) references.push(makeReference('import', node, { name: named.text, reference: named.text, module: named.text, imported_name: whole ? '<namespace>' : '<using>' }));
  } else if (node.type === 'declaration' && (language === 'cpp') && cppConstructed(node)) {
    // `Transaction sale("invoice 1041");` and `Cart cart{3};` construct: a call to the class, which the graph takes to its
    // constructor. The declaration's binding is read above.
    const kind = cppConstructed(node)!;
    references.push(makeReference('call', node, { name: kind, reference: kind }));
  } else if (node.type === 'modifier_invocation') {
    // `function restock() external whenNotPaused`: the modifier runs around the function, as a call to it by its bare name would.
    const name = validReference(text(node.namedChildren.find(item => item.type === 'identifier')));
    if (name !== '<dynamic>') references.push(makeReference('call', node, { name, reference: name }));
  } else if (language === 'zig' && node.type === 'VarDecl') {
    const imported = zigImport(node, references.filter(item => item.kind === 'import'));
    if (imported) references.push(imported);
  } else if (language === 'zig' && node.type === 'SuffixExpr') {
    // `cart.discount(200, 10)`, `Cart.init(a).add(line)`: each call in the chain, which the grammar holds as one node.
    for (const item of zigChain(node).calls) references.push(makeReference('call', item.at, { name: item.reference, reference: item.reference, ...(item.held ? { held: item.held } : {}) }));
  } else if (node.type === 'new_expression' || node.type === 'object_creation_expression') {
    // `new Ledger()` runs Ledger's constructor: a call to the class, which the graph takes to its constructor.
    const kind = constructedType(node);
    if (kind) references.push(makeReference('call', node, { name: kind, reference: kind }));
  } else if (CALL_TYPES.has(node.type) && isRequire(node, language)) {
    references.push(...requireReferences(node));
  } else if (CALL_TYPES.has(node.type) && referenceBase(node)?.type === "import") {
    // `import("./foo")` names a module, as a dynamic import or in a type position; it calls nothing named import.
    const module = stripModule(text(child(node, "arguments")?.namedChildren[0] ?? null));
    references.push(makeReference("import", node, { name: module || "<unknown-module>", reference: module || "<unknown-module>", module: module || null }));
  } else if (CALL_TYPES.has(node.type)) {
    references.push(callReferenceRecord(node, language));
  } else if (language === "rust" && node.type === "macro_invocation") {
    // `json!(..)`: a call of the macro by its name, which may be one the repository defines. The standard library's macros,
    // `assert_eq!` and `format!`, name nothing of the repository; what their arguments call is read from the tokens.
    const name = validReference(text(child(node, "macro") ?? node.namedChildren[0] ?? null, 128));
    if (name !== "<dynamic>" && !STD_MACROS.has(name)) references.push(makeReference("call", node, { name, reference: name }));
  } else if (language === "rust" && node.type === "token_tree") {
    references.push(...rustMacroCalls(node));
  } else if (node.type === "method_reference" || node.type === "callable_reference") {
    // `builder::build`, `Money::plus`, `Account::new` in Java, `::render` and `Shop::open` in Kotlin: a method handed on by name.
    const name = methodReferenceName(node);
    if (name) references.push(makeReference("value", node, { name, reference: name }));
  } else if (IDENTIFIER_TYPES.has(node.type) && isPassedAsValue(node) && validReference(text(node, 128))) {
    references.push(valueReference(node));
  } else if (isMemberRead(node)) {
    const name = validReference(text(node, 128));
    if (name !== "<dynamic>") references.push(makeReference("read", node, { name, reference: name }));
    else if (language === 'scala') {
      // `Parcel(1, sides).girth`: a member of what the receiver holds, kept with the receiver, since in Scala the read may run
      // a parameterless method as a call would.
      const split = memberOf(node, language);
      const held = split ? receiverOf(split.receiver, language) : null;
      if (split?.member && held) references.push(makeReference("read", node, { name: `$receiver.${split.member}`, reference: `$receiver.${split.member}`, held }));
    }
  }

  };
  return {
    enter,
    finish: index => {
      references.push(...destructuredRequires(references, taken));
      if (language === 'cpp' || language === 'c') unaliased(index, references);
      return references;
    },
  };
}

/** The references of a tree on its own, outside an analysis that walks it for everything else too. */
export function collectReferences(root: Node, language: string): Reference[] {
  const visitor = referenceVisitor(language);
  return visitor.finish(walk(root, [visitor]));
}
