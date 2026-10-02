import { decodeComponent, encodeComponent } from '../encode';
import { QueryError } from '../errors';

type Part = { kind: 'literal'; text: string } | { kind: 'param'; name: string; rest: boolean };

const PARAM = /\{(\*?)([A-Za-z_][A-Za-z0-9_]*)\}/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A route such as `/users/{id}/files/{*path}`: `{name}` is one segment, `{*name}` the rest of the path. */
export class PathTemplate {
  readonly pattern: string;
  readonly names: string[];
  readonly #parts: Part[];
  readonly #matcher: RegExp;

  constructor(pattern: string) {
    this.pattern = pattern;
    this.#parts = PathTemplate.compile(pattern);
    this.names = this.#parts.flatMap(part => (part.kind === 'param' ? [part.name] : []));
    const source = this.#parts.map(part => (part.kind === 'literal' ? escapeRegExp(part.text) : part.rest ? '(.+)' : '([^/]+)')).join('');
    this.#matcher = new RegExp(`^${source}/?$`);
  }

  /** The literal text and parameters of a template, in order. */
  static compile(pattern: string): Part[] {
    if (/[{}]/.test(pattern.replace(PARAM, ''))) throw new QueryError('unbalanced brace in template', pattern);
    const parts: Part[] = [];
    let end = 0;
    for (const match of pattern.matchAll(PARAM)) {
      if (match.index > end) parts.push({ kind: 'literal', text: pattern.slice(end, match.index) });
      parts.push({ kind: 'param', name: match[2], rest: match[1] === '*' });
      end = match.index + match[0].length;
    }
    if (end < pattern.length) parts.push({ kind: 'literal', text: pattern.slice(end) });
    const rest = parts.findIndex(part => part.kind === 'param' && part.rest);
    if (rest !== -1 && rest !== parts.length - 1) throw new QueryError('a {*rest} parameter must come last', pattern);
    return parts;
  }

  /** The parameters `path` fills in, decoded, or null when it does not fit the template. */
  match(path: string): Record<string, string> | null {
    const found = this.#matcher.exec(path);
    if (!found) return null;
    const params: Record<string, string> = {};
    for (let index = 0; index < this.names.length; index++) params[this.names[index]] = decodeComponent(found[index + 1]);
    return params;
  }

  /** The path with each parameter filled in and encoded. A rest parameter keeps its slashes. */
  expand(params: Record<string, string | number>): string {
    let out = '';
    for (const part of this.#parts) {
      if (part.kind === 'literal') {
        out += part.text;
        continue;
      }
      const value = params[part.name];
      if (value === undefined) throw new QueryError(`missing parameter "${part.name}"`, this.pattern);
      out += part.rest ? String(value).split('/').map(segment => encodeComponent(segment)).join('/') : encodeComponent(String(value));
    }
    return out;
  }
}
