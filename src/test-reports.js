/**
 * The files perch's own test runs write, read strictly: JUnit XML for which tests ran and passed and how long they took, and
 * coverage.py's data file for which lines each test ran. One a run left unreadable is an error naming the file and the line,
 * never a run treated as empty. Nothing here depends on a package: the XML reader is the small, correct subset these tools write.
 */
const fail = (path, line, message) => {
  throw new Error(`${path}:${line}: ${message}`);
};

const withoutBom = text => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// ---------------------------------------------------------------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------------------------------------------------------------

const NAME = /[A-Za-z_:\u00C0-\uFFFF][-.\w:\u00B7-\uFFFF]*/y;
const SPACE = /[ \t\n]*/y;
const ENTITY = /&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z_:][-.\w:]*)?(;)?/g;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// Characters XML 1.0 does not allow anywhere in a document, not even escaped as text. Control characters are the point here.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

const allowedCodePoint = code => code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff)
  || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);

/** Sets a key on a plain object even when the key is `__proto__`, which an attribute is allowed to be called. */
const define = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

/**
 * One XML document, or with `many` a run of them back to back. That second shape is what `cargo test -- --format junit` writes to
 * stdout: one document per test binary, one after another, each with its own XML declaration.
 */
function parseDocuments(input, path, many) {
  const src = withoutBom(input).replace(/\r\n?/g, '\n');
  let pos = 0;
  let countedTo = 0;
  let countedLine = 1;
  const lineOf = at => {
    if (at < countedTo) {
      countedTo = 0;
      countedLine = 1;
    }
    for (let next = src.indexOf('\n', countedTo); next !== -1 && next < at; next = src.indexOf('\n', next + 1)) {
      countedLine++;
      countedTo = next + 1;
    }
    return countedLine;
  };
  const error = (at, message) => fail(path, lineOf(at), message);

  const forbidden = FORBIDDEN.exec(src);
  if (forbidden) error(forbidden.index, `character U+${forbidden[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} is not allowed in XML`);

  const space = () => {
    SPACE.lastIndex = pos;
    SPACE.exec(src);
    const moved = SPACE.lastIndex > pos;
    pos = SPACE.lastIndex;
    return moved;
  };
  const name = () => {
    NAME.lastIndex = pos;
    const match = NAME.exec(src);
    if (!match) return null;
    pos = NAME.lastIndex;
    return match[0];
  };
  const decode = (raw, at) => {
    if (!raw.includes('&')) return raw;
    return raw.replace(ENTITY, (whole, body, semicolon, offset) => {
      if (!body || !semicolon) error(at + offset, `"&" that does not start an entity reference: ${JSON.stringify(raw.slice(offset, offset + 12))}`);
      if (body[0] !== '#') {
        if (!Object.hasOwn(NAMED, body)) error(at + offset, `unknown entity &${body};`);
        return NAMED[body];
      }
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!allowedCodePoint(code)) error(at + offset, `character reference ${whole} names a character XML does not allow`);
      return String.fromCodePoint(code);
    });
  };
  const isDeclaration = at => src.startsWith('<?xml', at) && (at + 5 >= src.length || /[\s?]/.test(src[at + 5]));
  const instruction = () => {
    const open = pos;
    pos += 2;
    const target = name();
    if (!target) error(open, 'processing instruction with no target');
    const end = src.indexOf('?>', pos);
    if (end === -1) error(open, `processing instruction <?${target} is never closed`);
    pos = end + 2;
  };
  const comment = () => {
    const open = pos;
    const end = src.indexOf('-->', pos + 4);
    if (end === -1) error(open, 'comment is never closed');
    const body = src.slice(pos + 4, end);
    if (body.includes('--') || body.endsWith('-')) error(open, '"--" inside a comment');
    pos = end + 3;
  };
  // Whitespace, comments and processing instructions between top-level constructs. Stops at an XML declaration, which is only
  // allowed at the start of a document and so is the caller's to judge.
  const misc = () => {
    for (;;) {
      space();
      if (src.startsWith('<!--', pos)) comment();
      else if (src.startsWith('<?', pos) && !isDeclaration(pos)) instruction();
      else return;
    }
  };
  const doctype = () => {
    const open = pos;
    let at = pos + 9;
    if (!/[ \t\n]/.test(src[at] ?? '')) error(open, 'malformed DOCTYPE');
    let subset = false;
    while (at < src.length) {
      const ch = src[at];
      if (ch === '"' || ch === "'") {
        const end = src.indexOf(ch, at + 1);
        if (end === -1) break;
        at = end + 1;
      } else if (subset && src.startsWith('<!--', at)) {
        const end = src.indexOf('-->', at + 4);
        if (end === -1) break;
        at = end + 3;
      } else if (ch === '[' && !subset) {
        subset = true;
        at++;
      } else if (ch === ']' && subset) {
        subset = false;
        at++;
      } else if (ch === '>' && !subset) {
        pos = at + 1;
        return;
      } else {
        at++;
      }
    }
    error(open, 'DOCTYPE is never closed');
  };

  const element = () => {
    const open = pos;
    const line = lineOf(open);
    pos++;
    const tag = name();
    if (!tag) error(open, `expected an element name after "<", found ${JSON.stringify(src.slice(pos, pos + 10))}`);
    const attributes = {};
    for (;;) {
      const spaced = space();
      if (src.startsWith('/>', pos)) {
        pos += 2;
        return { name: tag, attributes, children: [], text: '', line };
      }
      if (src[pos] === '>') {
        pos++;
        break;
      }
      if (pos >= src.length) error(open, `start tag <${tag} is never closed`);
      const at = pos;
      const attribute = name();
      if (!attribute) error(at, `unexpected ${JSON.stringify(src[at])} in the start tag <${tag}>`);
      if (!spaced) error(at, `attribute ${attribute} on <${tag}> is not separated from what comes before it`);
      space();
      if (src[pos] !== '=') error(at, `attribute ${attribute} on <${tag}> has no value`);
      pos++;
      space();
      const quote = src[pos];
      if (quote !== '"' && quote !== "'") error(at, `the value of attribute ${attribute} on <${tag}> is not quoted`);
      const end = src.indexOf(quote, pos + 1);
      if (end === -1) error(at, `the value of attribute ${attribute} on <${tag}> is never closed`);
      const raw = src.slice(pos + 1, end);
      if (raw.includes('<')) error(at, `"<" in the value of attribute ${attribute} on <${tag}>`);
      if (Object.hasOwn(attributes, attribute)) error(at, `attribute ${attribute} appears twice on <${tag}>`);
      // Attribute-value normalization: a literal tab or newline is a space; one written as a character reference is kept.
      define(attributes, attribute, decode(raw.replace(/[\t\n]/g, ' '), pos + 1));
      pos = end + 1;
    }
    const children = [];
    let text = '';
    for (;;) {
      const lt = src.indexOf('<', pos);
      if (lt === -1) error(open, `<${tag}> is never closed`);
      if (lt > pos) {
        const chunk = src.slice(pos, lt);
        const bad = chunk.indexOf(']]>');
        if (bad !== -1) error(pos + bad, '"]]>" in text outside a CDATA section');
        text += decode(chunk, pos);
        pos = lt;
      }
      if (src.startsWith('</', pos)) {
        const close = pos;
        pos += 2;
        const closing = name();
        if (closing !== tag) {
          error(close, closing ? `</${closing}> closes <${tag}>, which opened on line ${line}` : 'expected an element name after "</"');
        }
        space();
        if (src[pos] !== '>') error(close, `end tag </${tag}> is not closed with ">"`);
        pos++;
        return { name: tag, attributes, children, text, line };
      }
      if (src.startsWith('<!--', pos)) comment();
      else if (src.startsWith('<![CDATA[', pos)) {
        const end = src.indexOf(']]>', pos + 9);
        if (end === -1) error(pos, 'CDATA section is never closed');
        text += src.slice(pos + 9, end);
        pos = end + 3;
      } else if (src.startsWith('<?', pos)) {
        if (isDeclaration(pos)) error(pos, 'an XML declaration inside an element');
        instruction();
      } else if (src.startsWith('<!', pos)) error(pos, `unexpected "<!" inside <${tag}>`);
      else children.push(element());
    }
  };

  const documents = [];
  for (;;) {
    if (isDeclaration(pos)) instruction();
    misc();
    if (src.startsWith('<!DOCTYPE', pos)) {
      doctype();
      misc();
    }
    if (isDeclaration(pos)) error(pos, 'an XML declaration that is not at the start of the document');
    if (pos >= src.length) error(pos, 'no root element');
    if (src[pos] !== '<') error(pos, 'text before the root element');
    const root = element();
    documents.push(root);
    misc();
    if (pos >= src.length) return documents;
    // In a run of documents the next one opens with its declaration, or, as libtest writes its <report> after merged
    // doctests, with its root element alone.
    if (!many || src[pos] !== '<') {
      error(pos, src[pos] === '<' ? `markup after the root element <${root.name}> ends` : `text after the root element <${root.name}> ends`);
    }
  }
}

/**
 * An XML document's root element as `{ name, attributes, children, text, line }`: `attributes` decoded, `children` the child
 * elements in order, `text` the text and CDATA directly inside it joined, `line` where its start tag begins. Comments, processing
 * instructions and a DOCTYPE are skipped; a DOCTYPE's own entity declarations are not read, so an entity only it defines is an
 * error. Malformed XML is an Error naming the file and the line.
 */
export function parseXml(text, path) {
  return parseDocuments(text, path, false)[0];
}

const attribute = (element, key) => (Object.hasOwn(element.attributes, key) ? element.attributes[key] : undefined);

// ---------------------------------------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------------------------------------

/** A whole number written in a report, at least `least`, or an error saying which field held what. */
function whole(value, path, line, what, least = 0) {
  if (!/^\d+$/.test(value)) fail(path, line, `${what} is ${JSON.stringify(value)}, not a whole number`);
  const number = Number(value);
  if (number < least) fail(path, line, `${what} is ${number}, and must be at least ${least}`);
  return number;
}

/** Seconds as JUnit writes them, a plain decimal. */
function seconds(value, path, line, what) {
  if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)) fail(path, line, `${what} is ${JSON.stringify(value)}, not a number of seconds`);
  return Number(value);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// JUnit
// ---------------------------------------------------------------------------------------------------------------------------------

const STATUS_RANK = { passed: 0, skipped: 1, failed: 2, error: 3 };

/**
 * The status one testcase element records. A `<failure>` is failed, an `<error>` is error and a `<skipped>` is skipped, and when
 * a testcase holds more than one, the worst. GoogleTest also marks a test it did not run with `status="notrun"` (a disabled
 * test) or `result="skipped"`/`"suppressed"` and no child at all. Surefire's `<flakyFailure>` and `<rerunFailure>` sit beside
 * the result of the final run and do not change it.
 */
function caseStatus(testcase) {
  let status = 'passed';
  const worse = next => {
    if (STATUS_RANK[next] > STATUS_RANK[status]) status = next;
  };
  for (const child of testcase.children) {
    if (child.name === 'failure') worse('failed');
    else if (child.name === 'error') worse('error');
    else if (child.name === 'skipped') worse('skipped');
  }
  const run = attribute(testcase, 'status');
  const result = attribute(testcase, 'result');
  if (run === 'notrun' || result === 'skipped' || result === 'suppressed') worse('skipped');
  return status;
}

/**
 * Every testcase in a JUnit XML report, in order, as `{ name, classname, file, line, time, status, suite }`. `testsuites` holds
 * `testsuite` elements, which may nest; a testcase takes `file` and `line` from its own attributes, else from the nearest
 * testsuite that has them, and `suite` is the nearest testsuite's name. An attribute the report does not write is null. Text
 * holding several documents back to back, as cargo's libtest writes one per test binary, is read as all of them.
 */
export function readJunit(text, path) {
  const runs = [];
  const walk = (element, suites) => {
    for (const child of element.children) {
      if (child.name === 'testsuite') walk(child, [child, ...suites]);
      else if (child.name === 'testcase') runs.push(testcase(child, suites));
    }
  };
  const fromSuites = (suites, key) => suites.find(suite => attribute(suite, key) !== undefined);
  const testcase = (element, suites) => {
    const name = attribute(element, 'name');
    if (name === undefined || name === '') fail(path, element.line, '<testcase> has no name');
    const time = attribute(element, 'time');
    const fileOwner = attribute(element, 'file') !== undefined ? element : fromSuites(suites, 'file');
    const lineOwner = attribute(element, 'line') !== undefined ? element : fromSuites(suites, 'line');
    return {
      name,
      classname: attribute(element, 'classname') ?? null,
      file: fileOwner ? attribute(fileOwner, 'file') : null,
      line: lineOwner ? whole(attribute(lineOwner, 'line'), path, lineOwner.line, `line on <${lineOwner.name}>`) : null,
      time: time === undefined ? null : seconds(time, path, element.line, `time on <testcase name="${name}">`),
      status: caseStatus(element),
      suite: suites.length ? attribute(suites[0], 'name') ?? null : null,
      // Every enclosing testsuite's name, outermost first: node:test writes each describe block as a testsuite around its tests.
      suites: suites.map(suite => attribute(suite, 'name')).filter(name => name !== undefined).reverse(),
    };
  };
  for (const root of parseDocuments(text, path, true)) {
    if (root.name === 'testsuites') walk(root, []);
    else if (root.name === 'testsuite') walk({ children: [root] }, []);
    // libtest writes `<report total_time=".." compilation_time="..">` after the merged doctests' document. It holds no tests.
    else if (root.name !== 'report') fail(path, root.line, `<${root.name}> is not a JUnit report; the root element is <testsuites> or <testsuite>`);
  }
  return runs;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// LCOV
// ---------------------------------------------------------------------------------------------------------------------------------

/** The records geninfo(1) lists as coverpoints and summaries, which mean something only inside an SF: section. */

/**
 * coverage.py's own data file, `.coverage`, read test by test: `{ files: [{ path, contexts: Map<context, Set<line>> }] }`. Each
 * context's lines come from its arcs, when branches were measured, or its line bitmaps: bit n of byte k set is line 8k + n. A file it cannot open is an error naming it. Reading SQLite takes Node
 * 22.13 or later.
 */
export async function readCoverageDb(path) {
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { fail(path, 1, `is coverage.py's data file, which takes Node 22.13 or later to read; this is ${process.version}`); }
  let db;
  try { db = new sqlite.DatabaseSync(path, { readOnly: true }); } catch (error) { fail(path, 1, `cannot be opened as coverage.py's data file: ${error.message}`); }
  try {
    const tables = new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map(row => row.name));
    if (!['file', 'context', 'line_bits', 'arc'].every(table => tables.has(table))) fail(path, 1, 'is not coverage.py\'s data file: it needs the file, context, line_bits and arc tables');
    const paths = new Map(db.prepare('select id, path from file').all().map(row => [row.id, row.path]));
    const contexts = new Map(db.prepare('select id, context from context').all().map(row => [row.id, row.context]));
    const files = new Map();
    const lines = (fileId, contextId) => {
      const path = paths.get(fileId), context = contexts.get(contextId);
      if (!files.has(path)) files.set(path, new Map());
      const byContext = files.get(path);
      if (!byContext.has(context)) byContext.set(context, new Set());
      return byContext.get(context);
    };
    for (const row of db.prepare('select file_id, context_id, fromno, tono from arc').iterate()) {
      const into = lines(row.file_id, row.context_id);
      if (row.fromno > 0) into.add(row.fromno);
      if (row.tono > 0) into.add(row.tono);
    }
    for (const row of db.prepare('select file_id, context_id, numbits from line_bits').iterate()) {
      const into = lines(row.file_id, row.context_id), bits = row.numbits;
      for (let at = 0; at < bits.length; at++) for (let bit = 0; bit < 8; bit++) if (bits[at] & (1 << bit)) into.add(at * 8 + bit);
    }
    return { files: [...files].map(([file, byContext]) => ({ path: file, contexts: byContext })) };
  } finally { db.close(); }
}
