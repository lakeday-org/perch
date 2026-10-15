import assert from 'node:assert/strict';
import { readJunit, parseXml } from './src/test-reports.js';

/** Leading and trailing XML miscellany does not change a successfully parsed document or report. */
export function check_xml_misc_is_ignored(v, result) {
  const decorated = `<!-- leading --><?tool ignored?>${v.text}<!-- trailing -->`;
  const other = v.case === 'read_junit' ? readJunit(decorated, v.path) : parseXml(decorated, v.path);
  assert.deepStrictEqual(other, result, `XML miscellany changed the result: input=${v.text} original=${JSON.stringify(result)} decorated=${JSON.stringify(other)}`);
}

/** Decimal and hexadecimal references for the same character parse identically. */
export function check_xml_character_reference_equivalence(v, result) {
  if (!v.text.includes('&#65;')) return;
  const equivalent = v.text.replaceAll('&#65;', '&#x41;');
  const other = v.case === 'read_junit' ? readJunit(equivalent, v.path) : parseXml(equivalent, v.path);
  assert.deepStrictEqual(other, result, `equivalent references disagreed: input=${v.text} original=${JSON.stringify(result)} equivalent=${JSON.stringify(other)}`);
}

/** XML newline normalization gives the same parsed values for LF, CRLF, and CR input. */
export function check_cwe436_xml_newline_normalization(v, result) {
  const crlf = v.text.replace(/\r?\n/g, '\r\n');
  const cr = v.text.replace(/\r?\n/g, '\r');
  const parse = text => v.case === 'read_junit' ? readJunit(text, v.path) : parseXml(text, v.path);
  const crlfResult = parse(crlf);
  const crResult = parse(cr);
  assert.deepStrictEqual(crlfResult, result, `CRLF normalization disagreed: input=${v.text} original=${JSON.stringify(result)} CRLF=${JSON.stringify(crlfResult)}`);
  assert.deepStrictEqual(crResult, result, `CR normalization disagreed: input=${v.text} original=${JSON.stringify(result)} CR=${JSON.stringify(crResult)}`);
}

/** Removing the external doctype leaves the parsed document unchanged and does not require accessing its identifier. */
export function check_cwe611_external_doctype_is_ignored(v, result) {
  const declaration = '<!DOCTYPE node SYSTEM "https://example.invalid/external.dtd">';
  if (!v.text.includes(declaration)) return;
  const without = v.text.replace(declaration, '');
  const other = parseXml(without, v.path);
  assert.deepStrictEqual(other, result, `external doctype changed parsed data: input=${v.text} original=${JSON.stringify(result)} without=${JSON.stringify(other)}`);
}

/** Parsed XML structure cannot contain more elements or testcases than the input can encode. */
export function check_cwe776_expansion_is_bounded(v, result) {
  if (v.case === 'read_junit') {
    assert(result.length <= v.text.length, `testcase count exceeds input length: input=${v.text} result=${JSON.stringify(result)}`);
    return;
  }
  let count = 0;
  const visit = element => {
    count++;
    for (const child of element.children) visit(child);
  };
  visit(result);
  assert(count <= v.text.length, `element count exceeds input length: input=${v.text} elementCount=${count} result=${JSON.stringify(result)}`);
}

/** Successful reports retain a nonempty string testcase name rather than treating a missing name as a valid default. */
export function check_cwe20_testcase_names_are_present(v, result) {
  if (v.case !== 'read_junit') return;
  for (const testcase of result) {
    assert(typeof testcase.name === 'string' && testcase.name.length > 0, `invalid testcase name: input=${v.text} testcase=${JSON.stringify(testcase)}`);
  }
}

/** Returned testcase metadata uses nullable values and preserves valid scalar types. */
export function check_cwe843_testcase_fields_keep_their_types(v, result) {
  if (v.case !== 'read_junit') return;
  for (const testcase of result) {
    assert(typeof testcase.name === 'string' && (testcase.classname === null || typeof testcase.classname === 'string') && (testcase.file === null || typeof testcase.file === 'string') && (testcase.line === null || Number.isInteger(testcase.line)) && (testcase.time === null || typeof testcase.time === 'number'), `unexpected testcase field types: input=${v.text} testcase=${JSON.stringify(testcase)}`);
  }
}

/** A returned inherited or explicit testcase line is a positive integer. */
export function check_cwe476_testcase_line_is_valid(v, result) {
  if (v.case !== 'read_junit') return;
  for (const testcase of result) {
    if (testcase.line !== null) assert(Number.isInteger(testcase.line) && testcase.line > 0, `invalid testcase line: input=${v.text} testcase=${JSON.stringify(testcase)}`);
  }
}

/** Successfully parsed testcase metadata is not silently replaced with an empty or zero conversion default. */
export function check_cwe755_conversions_are_not_defaults(v, result) {
  if (v.case !== 'read_junit') return;
  for (const testcase of result) {
    assert(testcase.name.length > 0, `accepted testcase has an empty name: input=${v.text} testcase=${JSON.stringify(testcase)}`);
    if (testcase.line !== null) assert(testcase.line > 0, `accepted testcase has a zero line: input=${v.text} testcase=${JSON.stringify(testcase)}`);
    if (testcase.time !== null) assert(Number.isFinite(testcase.time) && testcase.time >= 0, `accepted testcase has invalid time: input=${v.text} testcase=${JSON.stringify(testcase)}`);
  }
}

/** Successful recursive XML parsing returns a finite element tree whose size is bounded by its source text. */
export function check_cwe674_recursion_returns_a_bounded_tree(v, result) {
  if (v.case === 'read_junit') return;
  let count = 0;
  const visit = element => {
    count++;
    for (const child of element.children) visit(child);
  };
  visit(result);
  assert(Number.isSafeInteger(count) && count <= v.text.length, `recursive parse returned an unbounded tree: inputLength=${v.text.length} elementCount=${count}`);
}