/**
 * The files CI's test run leaves behind, read strictly: JUnit XML for which tests ran and how long they took, and LCOV, Cobertura,
 * JaCoCo XML or coverage.py's JSON for which lines ran. perch never runs tests; it reads these, and a report it cannot read is an error that
 * names the file and the line, never a report treated as empty. Nothing here depends on a package: the XML reader is the small,
 * correct subset these tools write.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
const SECTION_RECORDS = new Set(['VER', 'FN', 'FNDA', 'FNF', 'FNH', 'FNL', 'FNA', 'BRDA', 'BRF', 'BRH', 'MCDC', 'MCF', 'MCH', 'DA', 'LF', 'LH']);

/**
 * An LCOV tracefile as `{ tests: [{ name, files: [{ path, lines: [[line, hits]], branches: [[line, block, branch, taken]] }] }] }`.
 * Sections are grouped by the TN: record in force before them (`''` when there is none), in the order the names first appear; a
 * TN: holds until the next one, as geninfo writes it once at the top. `path` is SF: as written. `taken` is null for `-`, a branch
 * whose expression never ran; `branch` is a number when the tool numbers branches, and the expression string when it names them.
 * Every record geninfo(1) documents is checked, and anything it does not document, or a record out of place, is an error.
 */
export function readLcov(text, path) {
  const tests = [];
  const byName = new Map();
  let testName = '';
  let section = null;
  let opened = 0;
  let sections = 0;
  const lines = withoutBom(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const record = lines[index];
    const at = index + 1;
    if (record.trim() === '' || record.startsWith('#')) continue;
    if (record === 'end_of_record') {
      if (!section) fail(path, at, 'end_of_record with no SF: section open');
      let test = byName.get(testName);
      if (!test) {
        test = { name: testName, files: [] };
        byName.set(testName, test);
        tests.push(test);
      }
      const { starts: _starts, indexed: _indexed, ...read } = section;
      test.files.push(read);
      section = null;
      sections++;
      continue;
    }
    const colon = record.indexOf(':');
    const key = colon === -1 ? record : record.slice(0, colon);
    const value = colon === -1 ? '' : record.slice(colon + 1);
    if (colon === -1) fail(path, at, `${JSON.stringify(record)} is not an LCOV record`);
    if (key === 'TN') {
      if (section) fail(path, at, `TN: inside the section for ${section.path}, which opened on line ${opened}`);
      testName = value;
      continue;
    }
    if (key === 'SF' || key === 'KF') {
      if (section) fail(path, at, `${key}: before the section for ${section.path}, which opened on line ${opened}, has its end_of_record`);
      if (value === '') fail(path, at, `${key}: names no file`);
      section = { path: value, lines: [], branches: [], functions: [], starts: new Map(), indexed: new Map() };
      opened = at;
      continue;
    }
    if (!SECTION_RECORDS.has(key)) fail(path, at, `${key}: is not a record geninfo(1) documents`);
    if (!section) fail(path, at, `${key}: outside any SF: section`);
    const malformed = shape => fail(path, at, `${key}:${value} does not have the form ${key}:${shape}`);
    switch (key) {
      case 'VER':
        break;
      case 'DA': {
        const match = /^(\d+),(\d+)(?:,(.*))?$/.exec(value);
        if (!match) malformed('<line>,<count>[,<checksum>]');
        section.lines.push([whole(match[1], path, at, 'DA line', 1), whole(match[2], path, at, 'DA count')]);
        break;
      }
      case 'BRDA': {
        // <line>,[e|f][U]<block>,<branch>,<taken>, where <branch> may be an expression that itself holds commas.
        const match = /^(\d+),([ef]?U?)(\d+),(.+),(\d+|-)$/.exec(value);
        if (!match) malformed('<line>,[<exception>][<fallthrough>][<unreachable>]<block>,<branch>,<taken>');
        const branch = /^\d+$/.test(match[4]) ? Number(match[4]) : match[4];
        const taken = match[5] === '-' ? null : whole(match[5], path, at, 'BRDA taken');
        section.branches.push([whole(match[1], path, at, 'BRDA line', 1), Number(match[3]), branch, taken]);
        break;
      }
      // A function's start line and how many times it was called: FN and FNDA by name, or FNL and FNA by index in LCOV 2.
      case 'FN': {
        const match = /^(\d+),(?:\d+,)?(.+)$/.exec(value);
        if (!match) malformed('<start line>,[<end line>,]<name>');
        section.starts.set(match[2], Number(match[1]));
        break;
      }
      case 'FNDA': {
        const match = /^(\d+),(.+)$/.exec(value);
        if (!match) malformed('<count>,<name>');
        if (section.starts.has(match[2])) section.functions.push([section.starts.get(match[2]), Number(match[1])]);
        break;
      }
      case 'FNL': {
        const match = /^(\d+),(\d+)(?:,\d+)?$/.exec(value);
        if (!match) malformed('<index>,<start line>[,<end line>]');
        section.indexed.set(match[1], Number(match[2]));
        break;
      }
      case 'FNA': {
        const match = /^(\d+),(\d+),.+$/.exec(value);
        if (!match) malformed('<index>,<count>,<name>');
        if (section.indexed.has(match[1])) section.functions.push([section.indexed.get(match[1]), Number(match[2])]);
        break;
      }
      case 'MCDC':
        if (!/^[1-9]\d*,U?\d+,[tf],\d+,\d+,.+$/.test(value)) malformed('<line>,[<unreachable>]<group size>,<sense>,<taken>,<index>,<expression>');
        break;
      default:
        // FNF, FNH, BRF, BRH, MCF, MCH, LF, LH: a count.
        whole(value, path, at, `${key} count`);
    }
  }
  if (section) fail(path, opened, `the section for ${section.path} has no end_of_record`);
  if (!sections) fail(path, lines.length, 'holds no SF: section, so it records no coverage');
  return { tests };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Cobertura
// ---------------------------------------------------------------------------------------------------------------------------------

const CONDITION_COVERAGE = /^\s*\d+(?:\.\d+)?%\s*\((\d+)\/(\d+)\)\s*$/;

/** The one child element named `name`, or an error: the coverage-04 DTD requires it and allows only one. */
function only(element, name, path) {
  const found = element.children.filter(child => child.name === name);
  if (found.length !== 1) fail(path, element.line, `<${element.name}> has ${found.length} <${name}> elements, and must have one`);
  return found[0];
}

/** The children of a list element, each of which must be `name`. */
function each(list, name, path) {
  for (const child of list.children) {
    if (child.name !== name) fail(path, child.line, `<${child.name}> inside <${list.name}>, which holds only <${name}>`);
  }
  return list.children;
}

/**
 * A Cobertura XML report (the coverage-04 DTD) as `{ sources, files: [{ path, lines: [[line, hits]], branches: [[line, covered,
 * total]] }] }`. `path` is a class's `filename` as written; classes sharing a file are one entry. Lines come from each class's
 * `<lines>`, not from its methods', which repeat them. A line several classes of one file report is counted once, at its highest
 * hits, since each class is reporting the same line and adding them would count one run twice. Branch counts come from the
 * `condition-coverage` of a line marked `branch="true"`, written like "50% (1/2)".
 */
export function readCobertura(text, path) {
  const root = parseXml(text, path);
  if (root.name !== 'coverage') fail(path, root.line, `<${root.name}> is not a Cobertura report; the root element is <coverage>`);
  const sourceLists = root.children.filter(child => child.name === 'sources');
  if (sourceLists.length > 1) fail(path, sourceLists[1].line, '<coverage> has more than one <sources>');
  const sources = sourceLists.length ? each(sourceLists[0], 'source', path).map(source => source.text.trim()) : [];
  const files = new Map();
  for (const pkg of each(only(root, 'packages', path), 'package', path)) {
    for (const cls of each(only(pkg, 'classes', path), 'class', path)) {
      const filename = attribute(cls, 'filename');
      if (!filename) fail(path, cls.line, `<class${attribute(cls, 'name') ? ` name="${attribute(cls, 'name')}"` : ''}> has no filename`);
      let file = files.get(filename);
      if (!file) {
        file = { lines: new Map(), branches: new Map() };
        files.set(filename, file);
      }
      for (const line of each(only(cls, 'lines', path), 'line', path)) {
        const numberText = attribute(line, 'number');
        const hitsText = attribute(line, 'hits');
        if (numberText === undefined) fail(path, line.line, '<line> has no number');
        if (hitsText === undefined) fail(path, line.line, `<line number="${numberText}"> has no hits`);
        const number = whole(numberText, path, line.line, 'line number', 1);
        const hits = whole(hitsText, path, line.line, `hits on line ${number}`);
        file.lines.set(number, Math.max(hits, file.lines.get(number) ?? 0));
        const branch = attribute(line, 'branch');
        if (branch === undefined || branch === 'false') continue;
        if (branch !== 'true') fail(path, line.line, `branch on line ${number} is ${JSON.stringify(branch)}, not "true" or "false"`);
        const condition = attribute(line, 'condition-coverage');
        if (condition === undefined) fail(path, line.line, `line ${number} is a branch with no condition-coverage`);
        const match = CONDITION_COVERAGE.exec(condition);
        if (!match) fail(path, line.line, `condition-coverage on line ${number} is ${JSON.stringify(condition)}, not like "50% (1/2)"`);
        const covered = Number(match[1]);
        const total = Number(match[2]);
        if (covered > total) fail(path, line.line, `condition-coverage on line ${number} covers ${covered} of ${total}`);
        const before = file.branches.get(number);
        if (!before || total > before[1] || (total === before[1] && covered > before[0])) file.branches.set(number, [covered, total]);
      }
    }
  }
  return {
    sources,
    files: [...files].map(([filename, file]) => ({
      path: filename,
      lines: [...file.lines],
      branches: [...file.branches].map(([line, [covered, total]]) => [line, covered, total]),
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// JaCoCo
// ---------------------------------------------------------------------------------------------------------------------------------

/** What each element of JaCoCo's report.dtd (Report 1.1) may hold, for the elements this reader walks. */
const JACOCO_CHILDREN = {
  report: ['sessioninfo', 'group', 'package', 'counter'],
  group: ['group', 'package', 'counter'],
  package: ['class', 'sourcefile', 'counter'],
  sourcefile: ['line', 'counter'],
};

/** The children of a JaCoCo element, each of which must be one report.dtd allows there. */
function jacocoChildren(element, path) {
  for (const child of element.children) {
    if (!JACOCO_CHILDREN[element.name].includes(child.name)) fail(path, child.line, `<${child.name}> inside <${element.name}>, which report.dtd does not allow`);
  }
  return element.children;
}

/**
 * A JaCoCo XML report (report.dtd, "-//JACOCO//DTD Report 1.1//EN") as `{ files: [{ path, lines: [[line, hits]], branches: [[line,
 * covered, total]] }] }`, one entry per `<sourcefile>`. `path` is the package's VM name and the source file's name, `example/Cart.java`
 * for `<package name="example"><sourcefile name="Cart.java">`, and the file's name alone in the default package: the file as it
 * sits under a source root, which the report does not name. Groups, which a multi-module report nests packages in, are walked.
 *
 * A `<line nr mi ci mb cb>` counts instructions and branches, not runs, so hits is 1 when an instruction on the line was covered
 * and 0 when none was. Its branches are `cb` of `mb + cb`, for a line that has any. The DTD leaves the four counts implied; JaCoCo
 * writes all of them, and one it leaves out is read as zero. A line with no instructions at all is not one JaCoCo writes, and is
 * an error, as is a report with no `<sourcefile>`, which records no line coverage.
 */
export function readJacoco(text, path) {
  const root = parseXml(text, path);
  if (root.name !== 'report') fail(path, root.line, `<${root.name}> is not a JaCoCo report; the root element is <report>`);
  const files = [];
  const count = (line, key, nr) => {
    const value = attribute(line, key);
    return value === undefined ? 0 : whole(value, path, line.line, `${key} on line ${nr}`);
  };
  const walk = element => {
    for (const child of jacocoChildren(element, path)) {
      if (child.name === 'group') walk(child);
      if (child.name !== 'package') continue;
      const pkg = attribute(child, 'name');
      if (pkg === undefined) fail(path, child.line, '<package> has no name');
      for (const source of jacocoChildren(child, path)) {
        if (source.name !== 'sourcefile') continue;
        const name = attribute(source, 'name');
        if (!name) fail(path, source.line, `<sourcefile> in package ${JSON.stringify(pkg)} has no name`);
        const file = { path: pkg ? `${pkg}/${name}` : name, lines: [], branches: [] };
        const seen = new Set();
        for (const line of jacocoChildren(source, path)) {
          if (line.name !== 'line') continue;
          const nrText = attribute(line, 'nr');
          if (nrText === undefined) fail(path, line.line, `<line> in ${file.path} has no nr`);
          const nr = whole(nrText, path, line.line, 'nr', 1);
          if (seen.has(nr)) fail(path, line.line, `line ${nr} of ${file.path} appears twice`);
          seen.add(nr);
          const [mi, ci, mb, cb] = ['mi', 'ci', 'mb', 'cb'].map(key => count(line, key, nr));
          if (mi + ci === 0) fail(path, line.line, `line ${nr} of ${file.path} has no instructions, missed or covered`);
          file.lines.push([nr, ci > 0 ? 1 : 0]);
          if (mb + cb > 0) file.branches.push([nr, cb, mb + cb]);
        }
        files.push(file);
      }
    }
  };
  walk(root);
  if (!files.length) fail(path, root.line, 'holds no <sourcefile>, so it records no line coverage');
  return { files };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// coverage.py JSON
// ---------------------------------------------------------------------------------------------------------------------------------

/** Where JSON.parse gave up, found by walking the JSON grammar, since V8 does not always say. */
function jsonErrorOffset(text) {
  let i = 0;
  const WS = /[ \t\n\r]*/y;
  const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null/y;
  const ESCAPE = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/y;
  const ws = () => {
    WS.lastIndex = i;
    WS.exec(text);
    i = WS.lastIndex;
  };
  const stop = () => {
    throw { at: i };
  };
  const string = () => {
    i++;
    for (;;) {
      const ch = text[i];
      if (ch === undefined || ch < ' ') stop();
      if (ch === '"') {
        i++;
        return;
      }
      if (ch === '\\') {
        ESCAPE.lastIndex = i;
        if (!ESCAPE.exec(text)) stop();
        i = ESCAPE.lastIndex;
      } else i++;
    }
  };
  const value = () => {
    ws();
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      i++;
      ws();
      if (text[i] === close) {
        i++;
        return;
      }
      for (;;) {
        if (ch === '{') {
          ws();
          if (text[i] !== '"') stop();
          string();
          ws();
          if (text[i] !== ':') stop();
          i++;
        }
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === close) {
          i++;
          return;
        } else stop();
      }
    }
    if (ch === '"') return string();
    LITERAL.lastIndex = i;
    if (!LITERAL.exec(text)) stop();
    i = LITERAL.lastIndex;
  };
  try {
    value();
    ws();
    if (i < text.length) stop();
  } catch (thrown) {
    if (thrown && typeof thrown.at === 'number') return thrown.at;
    throw thrown;
  }
  return text.length;
}

const lineAt = (text, offset) => {
  let line = 1;
  for (let next = text.indexOf('\n'); next !== -1 && next < offset; next = text.indexOf('\n', next + 1)) line++;
  return line;
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isLine = value => Number.isInteger(value) && value >= 1;

/**
 * coverage.py's `coverage json --show-contexts` as `{ files: [{ path, executed: [line], missing: [line], contexts: { [line]: [context] },
 * branches?: [[from, to, taken]] }] }`. `path` is the key under `files` as written. `branches` is there when the report measured
 * branches (meta.branch_coverage), one entry per arc from executed_branches (taken true) and missing_branches (taken false); `to`
 * is negative for an arc that leaves the code object, as coverage.py writes it. A report written without --show-contexts has no
 * per-test data and is an error, as is any file entry missing a key the format gives it.
 */
export function readCoverageJson(text, path) {
  const source = withoutBom(text);
  let data;
  try {
    data = JSON.parse(source);
  } catch (error) {
    fail(path, lineAt(source, jsonErrorOffset(source)), `not valid JSON: ${error.message.split('\n')[0]}`);
  }
  if (!isObject(data) || !isObject(data.meta) || !isObject(data.files)) {
    fail(path, 1, 'is not a coverage.py JSON report: it needs "meta" and "files" objects');
  }
  const filesAt = source.indexOf('"files"');
  // coverage.py writes with Python's json defaults, which escape every non-ASCII character as \uXXXX, so a path is looked for as
  // written either way.
  const ascii = text => text.replace(/[\u0080-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const lineOfKey = key => {
    const found = [JSON.stringify(key), ascii(JSON.stringify(key))].map(quoted => source.indexOf(quoted, filesAt)).filter(at => at !== -1);
    return lineAt(source, found.length ? Math.min(...found) : filesAt);
  };
  if (data.meta.show_contexts !== true) {
    fail(path, lineAt(source, source.indexOf('"meta"')), 'was written without --show-contexts, so it says nothing about which test ran which line');
  }
  const branchCoverage = data.meta.branch_coverage === true;
  const files = [];
  for (const [file, entry] of Object.entries(data.files)) {
    const wrong = message => fail(path, lineOfKey(file), `${file}: ${message}`);
    if (!isObject(entry)) wrong('the entry is not an object');
    for (const key of ['executed_lines', 'missing_lines']) {
      if (!Array.isArray(entry[key]) || !entry[key].every(isLine)) wrong(`${key} is not a list of line numbers`);
    }
    if (!isObject(entry.contexts)) wrong('has no contexts object');
    const contexts = {};
    for (const [line, names] of Object.entries(entry.contexts)) {
      if (!/^[1-9]\d*$/.test(line)) wrong(`contexts has the key ${JSON.stringify(line)}, not a line number`);
      if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) wrong(`contexts for line ${line} is not a list of strings`);
      contexts[line] = names;
    }
    const result = { path: file, executed: entry.executed_lines, missing: entry.missing_lines, contexts };
    const hasBranches = entry.executed_branches !== undefined || entry.missing_branches !== undefined;
    if (branchCoverage || hasBranches) {
      const arcs = key => {
        const list = entry[key];
        const arc = pair => Array.isArray(pair) && pair.length === 2 && isLine(pair[0]) && Number.isInteger(pair[1]);
        if (!Array.isArray(list) || !list.every(arc)) wrong(`${key} is not a list of [from, to] arcs`);
        return list;
      };
      result.branches = [
        ...arcs('executed_branches').map(([from, to]) => [from, to, true]),
        ...arcs('missing_branches').map(([from, to]) => [from, to, false]),
      ];
    }
    files.push(result);
  }
  return { files };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------------------------

/** `absolute` relative to `root` with forward slashes, or null when it is not inside it. */
function inside(root, absolute) {
  const rel = relative(root, absolute);
  if (rel === '' || isAbsolute(rel) || rel.split(sep)[0] === '..') return null;
  return rel.split(sep).join('/');
}

/**
 * A path a report wrote, as the repository-relative path of a tracked file, or null. An absolute path must lie under `root`. A
 * relative one is tried against each Cobertura source and then against the root. The candidate that is exactly a member of
 * `paths` is the answer; none is null, and so is more than one, since two tracked files a report could mean is not a match.
 */
export function repoPath(reported, { root, sources = [], paths }) {
  if (typeof reported !== 'string' || reported === '') return null;
  const base = resolve(root);
  if (isAbsolute(reported)) {
    const rel = inside(base, resolve(reported));
    return rel !== null && paths.has(rel) ? rel : null;
  }
  const candidates = new Set();
  for (const source of [...sources, base]) {
    const rel = inside(base, resolve(base, source, reported));
    if (rel !== null && paths.has(rel)) candidates.add(rel);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}
