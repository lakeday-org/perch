import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseXml, readCobertura, readCoverageJson, readJacoco, readJunit, readLcov, repoPath } from '../src/test-reports.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Expects `run` to throw an Error whose message starts with `path:line:` and mentions `what`. */
const throwsAt = (run, path, line, what) => {
  let thrown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'expected an error').toBeInstanceOf(Error);
  expect(thrown.message.startsWith(`${path}:${line}: `), thrown.message).toBe(true);
  if (what) expect(thrown.message).toMatch(what);
};

describe('parseXml', () => {
  it('decodes entities', () => {
    const root = parseXml(`<a one="&lt;&gt;&amp;&quot;&apos;" two='say "hi"' three="&#65;&#x42;&#x1F600;">x &amp; y &lt; z&#10;</a>`, 'e.xml');
    expect(root.attributes).toEqual({ one: `<>&"'`, two: 'say "hi"', three: 'AB\u{1F600}' });
    expect(root.text).toBe('x & y < z\n');
  });

  it('keeps CDATA text', () => {
    const root = parseXml('<out>before <![CDATA[<b>&amp;]]>&#xA;<![CDATA[after]]> end</out>', 'c.xml');
    expect(root.text).toBe('before <b>&amp;\nafter end');
  });

  it('leaves markup in CDATA undecoded', () => {
    expect(parseXml('<a><![CDATA[1 < 2 && x > y &foo;]]></a>', 'c.xml').text).toBe('1 < 2 && x > y &foo;');
  });

  it('skips the prolog, comments and instructions', () => {
    const xml = [
      '﻿<?xml version="1.0" encoding="UTF-8"?>',
      '<!-- a comment -->',
      '<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd" [',
      '  <!ELEMENT coverage (sources?)> <!-- ] > inside the subset -->',
      '  <!ATTLIST coverage version CDATA "a>b">',
      ']>',
      '<?xml-stylesheet href="x.xsl"?>',
      '<coverage version="1">',
      '  <!-- inside -->',
      '  <?pi data?>',
      '  <sources/>',
      '  <packages>',
      '    <package name="p"></package>',
      '  </packages>',
      '</coverage>',
      '<!-- trailing comment -->',
      '',
    ].join('\r\n');
    const root = parseXml(xml, 'd.xml');
    expect(root.name).toBe('coverage');
    expect(root.line).toBe(8);
    expect(root.children.map(child => [child.name, child.line])).toEqual([['sources', 11], ['packages', 12]]);
    expect(root.children[1].children[0]).toEqual({ name: 'package', attributes: { name: 'p' }, children: [], text: '', line: 13 });
    expect(root.text.trim()).toBe('');
  });

  it('normalizes newlines in attributes', () => {
    expect(parseXml('<a m="one\ntwo&#10;three"/>', 'n.xml').attributes.m).toBe('one two\nthree');
  });

  it('handles an attribute named __proto__', () => {
    const root = parseXml('<a __proto__="x"/>', 'p.xml');
    expect(Object.keys(root.attributes)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(root.attributes)).toBe(Object.prototype);
  });

  it('reports malformed XML with file and line', () => {
    throwsAt(() => parseXml('<a>\n<b>\n</a>', 'm.xml'), 'm.xml', 3, /<\/a> closes <b>, which opened on line 2/);
    throwsAt(() => parseXml('<a>\n  <b>text', 'u.xml'), 'u.xml', 2, /<b> is never closed/);
    throwsAt(() => parseXml('<a>\n&foo;</a>', 'e.xml'), 'e.xml', 2, /unknown entity &foo;/);
    throwsAt(() => parseXml('<a>fish & chips</a>', 'e.xml'), 'e.xml', 1, /"&" that does not start/);
    throwsAt(() => parseXml('<a x="&amp"/>', 'e.xml'), 'e.xml', 1, /"&" that does not start/);
    throwsAt(() => parseXml('<a>&#0;</a>', 'e.xml'), 'e.xml', 1, /character reference &#0;/);
    throwsAt(() => parseXml('<a/>\n\ntrailing', 't.xml'), 't.xml', 3, /text after the root element <a>/);
    throwsAt(() => parseXml('<a/>\n<b/>', 't.xml'), 't.xml', 2, /markup after the root element <a>/);
    throwsAt(() => parseXml('<a x="1" x="2"/>', 'a.xml'), 'a.xml', 1, /appears twice/);
    throwsAt(() => parseXml('<a x=1/>', 'a.xml'), 'a.xml', 1, /not quoted/);
    throwsAt(() => parseXml('<a x="1"y="2"/>', 'a.xml'), 'a.xml', 1, /not separated/);
    throwsAt(() => parseXml('<a x="<"/>', 'a.xml'), 'a.xml', 1, /"<" in the value/);
    throwsAt(() => parseXml('<a>\n<!-- never ends</a>', 'c.xml'), 'c.xml', 2, /comment is never closed/);
    throwsAt(() => parseXml('<a><![CDATA[open</a>', 'c.xml'), 'c.xml', 1, /CDATA section is never closed/);
    throwsAt(() => parseXml('<a>x ]]> y</a>', 'c.xml'), 'c.xml', 1, /"]]>" in text/);
    throwsAt(() => parseXml('<a>\u0001</a>', 'f.xml'), 'f.xml', 1, /U\+0001 is not allowed/);
    throwsAt(() => parseXml('', 'empty.xml'), 'empty.xml', 1, /no root element/);
    throwsAt(() => parseXml('text<a/>', 'b.xml'), 'b.xml', 1, /text before the root element/);
    throwsAt(() => parseXml('<a/>\n<?xml version="1.0"?><a/>', 'two.xml'), 'two.xml', 2, /markup after the root element/);
    throwsAt(() => parseXml('<!DOCTYPE a [ <!ELEMENT a ANY>\n', 'dt.xml'), 'dt.xml', 1, /DOCTYPE is never closed/);
  });
});

describe('readJunit', () => {
  // pytest's --junitxml, default junit_family=xunit2, with a class, a parametrized case, a failure, a skip and a teardown error.
  // https://docs.pytest.org/en/stable/how-to/output.html#creating-junitxml-format-files
  // https://github.com/jenkinsci/xunit-plugin/blob/master/src/main/resources/org/jenkinsci/plugins/xunit/types/model/xsd/junit-10.xsd
  const pytest = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="5" time="0.051" timestamp="2026-09-28T10:00:00.000000+00:00" hostname="ci"><testcase classname="tests.test_cart.TestCart" name="test_total[2-4]" time="0.002" /><testcase classname="tests.test_cart" name="test_empty" time="0.010"><failure message="assert 1 == 0">def test_empty():
&gt;       assert total([]) == 0
E       assert 1 == 0

tests/test_cart.py:12: AssertionError</failure></testcase><testcase classname="tests.test_cart" name="test_db" time="0.000"><skipped type="pytest.skip" message="needs a database">tests/test_cart.py:30: needs a database</skipped></testcase><testcase classname="tests.test_cart" name="test_teardown" time="0.004"><failure message="assert False">...</failure><error message="failed on teardown with &quot;OSError: disk&quot;">...</error></testcase><testcase classname="tests.test_cart" name="test_where" file="tests/test_cart.py" line="40" time="1.5e-3"><system-out>ok</system-out></testcase></testsuite></testsuites>`;

  it('reads pytest', () => {
    expect(readJunit(pytest, 'pytest.xml')).toEqual([
      { name: 'test_total[2-4]', classname: 'tests.test_cart.TestCart', file: null, line: null, time: 0.002, status: 'passed', suite: 'pytest', suites: ['pytest'] },
      { name: 'test_empty', classname: 'tests.test_cart', file: null, line: null, time: 0.01, status: 'failed', suite: 'pytest', suites: ['pytest'] },
      { name: 'test_db', classname: 'tests.test_cart', file: null, line: null, time: 0, status: 'skipped', suite: 'pytest', suites: ['pytest'] },
      { name: 'test_teardown', classname: 'tests.test_cart', file: null, line: null, time: 0.004, status: 'error', suite: 'pytest', suites: ['pytest'] },
      { name: 'test_where', classname: 'tests.test_cart', file: 'tests/test_cart.py', line: 40, time: 0.0015, status: 'passed', suite: 'pytest', suites: ['pytest'] },
    ]);
  });

  // Vitest's junit reporter: one testsuite per file, classname the file, name the describe chain joined with " > ".
  // https://vitest.dev/guide/reporters#junit-reporter
  const vitest = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="1" errors="0" time="0.012">
    <testsuite name="src/cart.test.ts" timestamp="2026-09-28T10:00:00.000Z" hostname="ci" tests="3" failures="1" errors="0" skipped="1" time="0.008">
        <testcase classname="src/cart.test.ts" name="cart &gt; total &gt; adds items" time="0.002">
        </testcase>
        <testcase classname="src/cart.test.ts" name="cart &gt; rejects a negative quantity" time="0.003">
            <failure message="expected 1 to be 0 // Object.is equality" type="AssertionError">
AssertionError: expected 1 to be 0 // Object.is equality
 ❯ src/cart.test.ts:12:21
            </failure>
        </testcase>
        <testcase classname="src/cart.test.ts" name="cart &gt; todo" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>
`;

  it('reads Vitest', () => {
    expect(readJunit(vitest, 'vitest.xml')).toEqual([
      { name: 'cart > total > adds items', classname: 'src/cart.test.ts', file: null, line: null, time: 0.002, status: 'passed', suite: 'src/cart.test.ts', suites: ['src/cart.test.ts'] },
      { name: 'cart > rejects a negative quantity', classname: 'src/cart.test.ts', file: null, line: null, time: 0.003, status: 'failed', suite: 'src/cart.test.ts', suites: ['src/cart.test.ts'] },
      { name: 'cart > todo', classname: 'src/cart.test.ts', file: null, line: null, time: 0, status: 'skipped', suite: 'src/cart.test.ts', suites: ['src/cart.test.ts'] },
    ]);
  });

  // Surefire's TEST-*.xml: a lone testsuite as the root, properties, and rerun elements beside the final result.
  // https://maven.apache.org/surefire/maven-surefire-plugin/xsd/surefire-test-report-3.0.xsd
  const surefire = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://maven.apache.org/surefire/maven-surefire-plugin/xsd/surefire-test-report-3.0.xsd" version="3.0" name="com.example.CartTest" time="0.045" tests="4" errors="1" skipped="1" failures="0">
  <properties>
    <property name="java.version" value="21"/>
  </properties>
  <testcase name="totalAddsItems" classname="com.example.CartTest" time="0.012"/>
  <testcase name="retriesFlaky" classname="com.example.CartTest" time="0.020">
    <flakyFailure message="boom" type="java.lang.AssertionError"><stackTrace>at CartTest.java:30</stackTrace></flakyFailure>
  </testcase>
  <testcase name="[1] 2, 4" classname="com.example.CartTest" time="0.001">
    <skipped message="disabled"/>
  </testcase>
  <testcase name="loadsPrices()" classname="com.example.CartTest" time="0.004">
    <error message="Connection refused" type="java.net.ConnectException"><![CDATA[java.net.ConnectException: Connection refused
	at com.example.CartTest.loadsPrices(CartTest.java:44)]]></error>
    <system-out><![CDATA[connecting]]></system-out>
  </testcase>
</testsuite>`;

  it('reads Surefire', () => {
    expect(readJunit(surefire, 'TEST-com.example.CartTest.xml').map(run => [run.name, run.classname, run.time, run.status, run.suite])).toEqual([
      ['totalAddsItems', 'com.example.CartTest', 0.012, 'passed', 'com.example.CartTest'],
      ['retriesFlaky', 'com.example.CartTest', 0.02, 'passed', 'com.example.CartTest'],
      ['[1] 2, 4', 'com.example.CartTest', 0.001, 'skipped', 'com.example.CartTest'],
      ['loadsPrices()', 'com.example.CartTest', 0.004, 'error', 'com.example.CartTest'],
    ]);
  });

  // GoogleTest's --gtest_output=xml, with a disabled test (status="notrun") and a GTEST_SKIP (result="skipped").
  // https://google.github.io/googletest/advanced.html#generating-an-xml-report
  const gtest = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="4" failures="1" disabled="1" errors="0" time="0.035" timestamp="2026-09-28T10:00:00.000" name="AllTests">
  <testsuite name="MathTest" tests="2" failures="1" disabled="0" skipped="0" errors="0" time="0.015" timestamp="2026-09-28T10:00:00.000">
    <testcase name="Addition" file="test.cpp" line="7" status="run" result="completed" time="0.007" timestamp="2026-09-28T10:00:00.000" classname="MathTest">
      <failure message="test.cpp:9&#x0A;Value of: add(1, 1)&#x0A;  Actual: 3&#x0A;Expected: 2" type=""><![CDATA[test.cpp:9
Value of: add(1, 1)
  Actual: 3
Expected: 2]]></failure>
    </testcase>
    <testcase name="Subtraction" file="test.cpp" line="12" status="run" result="completed" time="0.005" timestamp="2026-09-28T10:00:00.000" classname="MathTest" />
  </testsuite>
  <testsuite name="LogicTest" tests="2" failures="0" disabled="1" skipped="1" errors="0" time="0" timestamp="2026-09-28T10:00:00.000">
    <testcase name="DISABLED_NonContradiction" file="test.cpp" line="20" status="notrun" result="suppressed" time="0" timestamp="2026-09-28T10:00:00.000" classname="LogicTest" />
    <testcase name="SkipsOnCi" file="test.cpp" line="25" status="run" result="skipped" time="0" timestamp="2026-09-28T10:00:00.000" classname="LogicTest">
      <skipped message="test.cpp:26&#x0A;"><![CDATA[test.cpp:26
]]></skipped>
    </testcase>
  </testsuite>
</testsuites>`;

  it('reads GoogleTest', () => {
    expect(readJunit(gtest, 'gtest.xml')).toEqual([
      { name: 'Addition', classname: 'MathTest', file: 'test.cpp', line: 7, time: 0.007, status: 'failed', suite: 'MathTest', suites: ['MathTest'] },
      { name: 'Subtraction', classname: 'MathTest', file: 'test.cpp', line: 12, time: 0.005, status: 'passed', suite: 'MathTest', suites: ['MathTest'] },
      { name: 'DISABLED_NonContradiction', classname: 'LogicTest', file: 'test.cpp', line: 20, time: 0, status: 'skipped', suite: 'LogicTest', suites: ['LogicTest'] },
      { name: 'SkipsOnCi', classname: 'LogicTest', file: 'test.cpp', line: 25, time: 0, status: 'skipped', suite: 'LogicTest', suites: ['LogicTest'] },
    ]);
    expect(parseXml(gtest, 'gtest.xml').children[0].children[0].children[0].attributes.message).toBe('test.cpp:9\nValue of: add(1, 1)\n  Actual: 3\nExpected: 2');
  });

  // cargo's libtest `--format junit`: one single-line document per test binary on stdout, back to back, newlines in captured
  // output written as ]]>&#xA;<![CDATA[, and after merged doctests a <report> element outside any document's root.
  // https://github.com/rust-lang/rust/blob/master/library/test/src/formatters/junit.rs
  const libtest = [
    '<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="test" package="test" id="0" errors="0" failures="1" tests="2" skipped="0" ><testcase classname="cart::tests" name="adds_up" time="0.001"/><testcase classname="crate" name="top_level" time="0.25"><failure message="assertion failed: ok" type="assert"/><system-out><![CDATA[line one]]>&#xA;<![CDATA[line two]]></system-out></testcase><system-out/><system-err/></testsuite></testsuites>',
    '<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="test" package="test" id="0" errors="0" failures="0" tests="1" skipped="0" ><testcase classname="integration" name="checkout_flow" time="0.002"/><system-out/><system-err/></testsuite></testsuites>',
    '<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="test" package="test" id="0" errors="0" failures="0" tests="1" skipped="0" ><testcase classname="src/lib.rs" name="line 3" time="0"/><system-out/><system-err/></testsuite></testsuites>',
    '<report total_time="1.25" compilation_time="0.9"></report>',
    '',
  ].join('\n');

  it('reads libtest, one document per test binary', () => {
    expect(readJunit(libtest, 'cargo.xml')).toEqual([
      { name: 'adds_up', classname: 'cart::tests', file: null, line: null, time: 0.001, status: 'passed', suite: 'test', suites: ['test'] },
      { name: 'top_level', classname: 'crate', file: null, line: null, time: 0.25, status: 'failed', suite: 'test', suites: ['test'] },
      { name: 'checkout_flow', classname: 'integration', file: null, line: null, time: 0.002, status: 'passed', suite: 'test', suites: ['test'] },
      { name: 'line 3', classname: 'src/lib.rs', file: null, line: null, time: 0, status: 'passed', suite: 'test', suites: ['test'] },
    ]);
  });

  it('takes names from the nearest suite', () => {
    const nested = `<testsuites>
  <testsuite name="outer" file="tests/test_a.py">
    <testsuite name="inner">
      <testcase classname="tests.test_a" name="test_one"/>
      <testcase classname="tests.test_a" name="test_two" file="tests/other.py" line="3" time="2"/>
    </testsuite>
    <testcase name="test_three"/>
  </testsuite>
</testsuites>`;
    expect(readJunit(nested, 'n.xml')).toEqual([
      { name: 'test_one', classname: 'tests.test_a', file: 'tests/test_a.py', line: null, time: null, status: 'passed', suite: 'inner', suites: ['outer', 'inner'] },
      { name: 'test_two', classname: 'tests.test_a', file: 'tests/other.py', line: 3, time: 2, status: 'passed', suite: 'inner', suites: ['outer', 'inner'] },
      { name: 'test_three', classname: null, file: 'tests/test_a.py', line: null, time: null, status: 'passed', suite: 'outer', suites: ['outer'] },
    ]);
  });

  it('reads a report with no tests as no runs', () => {
    expect(readJunit('<testsuites tests="0"/>', 'none.xml')).toEqual([]);
  });

  it('reports errors with file and line', () => {
    throwsAt(() => readJunit('<testsuites>\n<testsuite>\n<testcase classname="a"/>\n</testsuite></testsuites>', 'j.xml'), 'j.xml', 3, /no name/);
    throwsAt(() => readJunit('<testsuite>\n\n<testcase name="a" time="1,234.5"/></testsuite>', 'j.xml'), 'j.xml', 3, /not a number of seconds/);
    throwsAt(() => readJunit('<testsuite><testcase name="a" line="x"/></testsuite>', 'j.xml'), 'j.xml', 1, /not a whole number/);
    throwsAt(() => readJunit('<?xml version="1.0"?>\n<coverage/>', 'j.xml'), 'j.xml', 2, /not a JUnit report/);
    throwsAt(() => readJunit('<testsuites><testsuite name="a">\n</testsuites>', 'j.xml'), 'j.xml', 2, /<\/testsuites> closes <testsuite>/);
    // libtest writes a failure message into an attribute without escaping it; a quote inside it is malformed XML.
    throwsAt(() => readJunit('<testsuites><testsuite><testcase name="a"><failure message="left: "1"" type="assert"/></testcase></testsuite></testsuites>', 'j.xml'), 'j.xml', 1);
    throwsAt(() => readJunit('<testsuites/>\ntrailing', 'j.xml'), 'j.xml', 2, /text after the root/);
  });
});

describe('readLcov', () => {
  // Every record geninfo(1) documents, including both function formats, an exception branch, string branch expressions (one
  // holding commas), '-' for a branch whose block never ran, MC/DC records, a DA checksum, comments and blank lines.
  // https://github.com/linux-test-project/lcov/blob/master/docs/man/geninfo.rst (TRACEFILE FORMAT)
  const tracefile = `#written by hand from geninfo(1)
TN:test_cart
SF:/repo/src/cart.c
VER:4c1f0a
FNL:0,3,9
FNA:0,2,total
FN:12,20,discount
FNDA:0,discount
FNF:2
FNH:1
BRDA:5,0,0,2
BRDA:5,0,1,-
BRDA:10,e1,0,0
BRDA:11,0,enable,1
BRDA:11,0,!enable,0
BRDA:12,U0,f(a, b),3
BRF:6
BRH:3
MCDC:10,2,f,0,0,enable
MCDC:10,2,t,1,0,enable
MCF:2
MCH:1

DA:3,2
DA:4,2,dGhpcyBpcyBhIGNoZWNrc3Vt
DA:12,0
LF:3
LH:2
end_of_record
SF:/repo/src/tax.c
DA:1,7
end_of_record
TN:
KF:src/other.c
DA:1,1
end_of_record
TN:test_cart
SF:/repo/src/cart.c
DA:3,1
end_of_record
`;

  it('reads every record, grouped by test', () => {
    expect(readLcov(tracefile, 'lcov.info')).toEqual({
      tests: [
        {
          name: 'test_cart',
          files: [
            {
              path: '/repo/src/cart.c',
              lines: [[3, 2], [4, 2], [12, 0]],
              branches: [[5, 0, 0, 2], [5, 0, 1, null], [10, 1, 0, 0], [11, 0, 'enable', 1], [11, 0, '!enable', 0], [12, 0, 'f(a, b)', 3]],
              functions: [[3, 2], [12, 0]],
            },
            { path: '/repo/src/tax.c', lines: [[1, 7]], branches: [], functions: [] },
            { path: '/repo/src/cart.c', lines: [[3, 1]], branches: [], functions: [] },
          ],
        },
        { name: '', files: [{ path: 'src/other.c', lines: [[1, 1]], branches: [], functions: [] }] },
      ],
    });
  });

  it('reads CRLF line endings', () => {
    expect(readLcov('SF:a.js\r\nDA:1,1\r\nend_of_record\r\n', 'crlf.info').tests[0].files[0].lines).toEqual([[1, 1]]);
  });

  it('reports errors with file and line', () => {
    throwsAt(() => readLcov('TN:x\nDA:1,1\n', 'l.info'), 'l.info', 2, /DA: outside any SF: section/);
    throwsAt(() => readLcov('SF:a.c\nTN:x\nend_of_record\n', 'l.info'), 'l.info', 2, /TN: inside the section for a.c/);
    throwsAt(() => readLcov('SF:a.c\nDA:1,1\nSF:b.c\nend_of_record\n', 'l.info'), 'l.info', 3, /before the section for a.c/);
    throwsAt(() => readLcov('end_of_record\n', 'l.info'), 'l.info', 1, /no SF: section open/);
    throwsAt(() => readLcov('\nSF:a.c\nDA:1,1\n', 'l.info'), 'l.info', 2, /has no end_of_record/);
    throwsAt(() => readLcov('SF:a.c\nXYZ:1\nend_of_record\n', 'l.info'), 'l.info', 2, /XYZ: is not a record geninfo\(1\) documents/);
    throwsAt(() => readLcov('SF:a.c\nDA:1,1\nend_of_recordTN:x\n', 'l.info'), 'l.info', 3, /is not a record geninfo/);
    throwsAt(() => readLcov('SF:a.c\nDA:3,many\nend_of_record\n', 'l.info'), 'l.info', 2, /does not have the form DA:/);
    throwsAt(() => readLcov('SF:a.c\nDA:0,1\nend_of_record\n', 'l.info'), 'l.info', 2, /DA line is 0/);
    throwsAt(() => readLcov('SF:a.c\nBRDA:4,0,0\nend_of_record\n', 'l.info'), 'l.info', 2, /does not have the form BRDA:/);
    throwsAt(() => readLcov('SF:a.c\nBRDA:4,0,0,x\nend_of_record\n', 'l.info'), 'l.info', 2, /BRDA/);
    throwsAt(() => readLcov('SF:a.c\nFNL:0,x\nend_of_record\n', 'l.info'), 'l.info', 2, /FNL:/);
    throwsAt(() => readLcov('SF:a.c\nLF:-1\nend_of_record\n', 'l.info'), 'l.info', 2, /LF count/);
    throwsAt(() => readLcov('SF:\nend_of_record\n', 'l.info'), 'l.info', 1, /names no file/);
    throwsAt(() => readLcov('#only a comment\n', 'l.info'), 'l.info', 2, /no SF: section/);
    throwsAt(() => readLcov('', 'l.info'), 'l.info', 1, /no SF: section/);
  });
});

describe('readCobertura', () => {
  // The coverage-04 DTD shape as coverage.py's `coverage xml` writes it: sources, then packages > classes > class, each class
  // with methods (whose lines repeat the class's) and lines, branch lines carrying condition-coverage.
  // http://cobertura.sourceforge.net/xml/coverage-04.dtd
  // https://coverage.readthedocs.io/en/latest/commands/cmd_xml.html
  const cobertura = `<?xml version="1.0" ?>
<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">
<coverage line-rate="0.8" branch-rate="0.5" lines-covered="4" lines-valid="5" branches-covered="3" branches-valid="4" complexity="0" version="7.6.1" timestamp="1727520000000">
	<!-- Generated by coverage.py: https://coverage.readthedocs.io/en/7.6.1 -->
	<sources>
		<source>/home/runner/work/shop/shop/src</source>
		<source>lib</source>
	</sources>
	<packages>
		<package name="shop" line-rate="0.8" branch-rate="0.5" complexity="0">
			<classes>
				<class name="cart.py" filename="shop/cart.py" complexity="0" line-rate="0.8" branch-rate="0.5">
					<methods>
						<method name="total" signature="()" line-rate="1" branch-rate="1">
							<lines><line number="3" hits="2"/></lines>
						</method>
					</methods>
					<lines>
						<line number="3" hits="2"/>
						<line number="4" hits="2" branch="true" condition-coverage="50% (1/2)" missing-branches="7"/>
						<line number="5" hits="1"/>
						<line number="7" hits="0"/>
						<line number="8" hits="1" branch="false"/>
					</lines>
				</class>
				<class name="cart.py$Inner" filename="shop/cart.py" complexity="0" line-rate="1" branch-rate="1">
					<methods/>
					<lines>
						<line number="12" hits="3" branch="true" condition-coverage="100% (2/2)">
							<conditions><condition number="0" type="jump" coverage="100%"/></conditions>
						</line>
						<line number="5" hits="4"/>
					</lines>
				</class>
			</classes>
		</package>
		<package name="shop.tax" line-rate="0" branch-rate="0" complexity="0">
			<classes>
				<class name="rates.py" filename="shop/tax/rates.py" complexity="0" line-rate="0" branch-rate="0">
					<methods/>
					<lines/>
				</class>
			</classes>
		</package>
	</packages>
</coverage>
`;

  it('reads lines and branches per file', () => {
    expect(readCobertura(cobertura, 'coverage.xml')).toEqual({
      sources: ['/home/runner/work/shop/shop/src', 'lib'],
      files: [
        { path: 'shop/cart.py', lines: [[3, 2], [4, 2], [5, 4], [7, 0], [8, 1], [12, 3]], branches: [[4, 1, 2], [12, 2, 2]] },
        { path: 'shop/tax/rates.py', lines: [], branches: [] },
      ],
    });
  });

  it('reads a report with no sources element', () => {
    expect(readCobertura('<coverage><packages/></coverage>', 'c.xml')).toEqual({ sources: [], files: [] });
  });

  const wrap = lines => `<coverage>\n<packages>\n<package name="p">\n<classes>\n<class name="a" filename="a.py">\n<lines>\n${lines}\n</lines>\n</class>\n</classes>\n</package>\n</packages>\n</coverage>`;

  it('reports errors with file and line', () => {
    throwsAt(() => readCobertura(wrap('<line number="4" hits="1" branch="true" condition-coverage="half"/>'), 'c.xml'), 'c.xml', 7, /not like "50% \(1\/2\)"/);
    throwsAt(() => readCobertura(wrap('<line number="4" hits="1" branch="true"/>'), 'c.xml'), 'c.xml', 7, /no condition-coverage/);
    throwsAt(() => readCobertura(wrap('<line number="4" hits="1" branch="true" condition-coverage="300% (3/1)"/>'), 'c.xml'), 'c.xml', 7, /covers 3 of 1/);
    throwsAt(() => readCobertura(wrap('<line number="4" hits="1" branch="yes"/>'), 'c.xml'), 'c.xml', 7, /not "true" or "false"/);
    throwsAt(() => readCobertura(wrap('<line number="4"/>'), 'c.xml'), 'c.xml', 7, /has no hits/);
    throwsAt(() => readCobertura(wrap('<line hits="4"/>'), 'c.xml'), 'c.xml', 7, /has no number/);
    throwsAt(() => readCobertura(wrap('<line number="x" hits="4"/>'), 'c.xml'), 'c.xml', 7, /not a whole number/);
    throwsAt(() => readCobertura(wrap('<line number="1" hits="-1"/>'), 'c.xml'), 'c.xml', 7, /not a whole number/);
    throwsAt(() => readCobertura(wrap('<row number="1" hits="1"/>'), 'c.xml'), 'c.xml', 7, /<row> inside <lines>/);
    throwsAt(() => readCobertura('<coverage>\n<packages><package><classes>\n<class name="a"><lines/></class></classes></package></packages></coverage>', 'c.xml'), 'c.xml', 3, /has no filename/);
    throwsAt(() => readCobertura('<coverage>\n<packages><package><classes>\n<class filename="a.py"/></classes></package></packages></coverage>', 'c.xml'), 'c.xml', 3, /0 <lines> elements/);
    throwsAt(() => readCobertura('<?xml version="1.0"?>\n<coverage line-rate="1">\n</coverage>', 'c.xml'), 'c.xml', 2, /0 <packages> elements/);
    throwsAt(() => readCobertura('<report/>', 'c.xml'), 'c.xml', 1, /not a Cobertura report/);
    throwsAt(() => readCobertura('<coverage><packages>\n</coverage>', 'c.xml'), 'c.xml', 2, /<\/coverage> closes <packages>/);
  });
});

describe('readJacoco', () => {
  // JaCoCo's report.dtd ("-//JACOCO//DTD Report 1.1//EN"), as its XMLFormatter writes it: one line, sessioninfo first, then a group
  // (a module in a multi-module report) holding packages, each package its classes and then one sourcefile per source file, whose
  // line elements carry nr, mi (missed instructions), ci (covered instructions), mb (missed branches) and cb (covered branches),
  // and counters closing every level. The package name is in VM notation, with slashes. The default package is named "".
  // https://github.com/jacoco/jacoco/blob/master/org.jacoco.report/src/org/jacoco/report/xml/report.dtd
  // https://www.jacoco.org/jacoco/trunk/doc/counters.html
  const jacoco = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">'
    + '<report name="shop"><sessioninfo id="ci-1a2b" start="1727520000000" dump="1727520003000"/>'
    + '<group name="shop-core">'
    + '<package name="com/shop"><class name="com/shop/Cart" sourcefilename="Cart.java">'
    + '<method name="total" desc="(I)I" line="5"><counter type="INSTRUCTION" missed="2" covered="9"/><counter type="BRANCH" missed="1" covered="1"/></method>'
    + '<counter type="CLASS" missed="0" covered="1"/></class>'
    + '<sourcefile name="Cart.java">'
    + '<line nr="5" mi="0" ci="3" mb="0" cb="0"/><line nr="6" mi="0" ci="4" mb="1" cb="1"/><line nr="7" mi="2" ci="0" mb="0" cb="0"/>'
    + '<line nr="9" mi="1" ci="2" mb="3" cb="1"/><counter type="LINE" missed="1" covered="3"/></sourcefile>'
    + '<sourcefile name="Tax.kt"><line nr="3" mi="4" ci="0" mb="2" cb="0"/></sourcefile>'
    + '<counter type="LINE" missed="2" covered="3"/></package>'
    + '<counter type="LINE" missed="2" covered="3"/></group>'
    + '<package name=""><sourcefile name="Main.java"><line nr="2" mi="0" ci="1"/></sourcefile></package>'
    + '<counter type="LINE" missed="2" covered="4"/></report>';

  it('reads files by package', () => {
    expect(readJacoco(jacoco, 'jacoco.xml')).toEqual({
      files: [
        { path: 'com/shop/Cart.java', lines: [[5, 1], [6, 1], [7, 0], [9, 1]], branches: [[6, 1, 2], [9, 1, 4]] },
        { path: 'com/shop/Tax.kt', lines: [[3, 0]], branches: [[3, 0, 2]] },
        { path: 'Main.java', lines: [[2, 1]], branches: [] },
      ],
    });
  });

  const wrap = lines => `<report name="r">\n<package name="p">\n<sourcefile name="A.java">\n${lines}\n</sourcefile>\n</package>\n</report>`;

  it('reports errors with file and line', () => {
    throwsAt(() => readJacoco(wrap('<line mi="0" ci="1"/>'), 'j.xml'), 'j.xml', 4, /has no nr/);
    throwsAt(() => readJacoco(wrap('<line nr="0" ci="1"/>'), 'j.xml'), 'j.xml', 4, /nr is 0, and must be at least 1/);
    throwsAt(() => readJacoco(wrap('<line nr="3" mi="x" ci="1"/>'), 'j.xml'), 'j.xml', 4, /mi on line 3 is "x", not a whole number/);
    throwsAt(() => readJacoco(wrap('<line nr="3" mi="0" ci="0"/>'), 'j.xml'), 'j.xml', 4, /line 3 of p\/A.java has no instructions/);
    throwsAt(() => readJacoco(wrap('<line nr="3" ci="1"/>\n<line nr="3" ci="2"/>'), 'j.xml'), 'j.xml', 5, /line 3 of p\/A.java appears twice/);
    throwsAt(() => readJacoco(wrap('<row nr="3" ci="1"/>'), 'j.xml'), 'j.xml', 4, /<row> inside <sourcefile>, which report.dtd does not allow/);
    throwsAt(() => readJacoco('<report name="r">\n<package name="p">\n<sourcefile>\n</sourcefile></package></report>', 'j.xml'), 'j.xml', 3, /<sourcefile> in package "p" has no name/);
    throwsAt(() => readJacoco('<report name="r">\n<package>\n</package></report>', 'j.xml'), 'j.xml', 2, /<package> has no name/);
    throwsAt(() => readJacoco('<report name="r">\n<sourcefile name="A.java"/></report>', 'j.xml'), 'j.xml', 2, /<sourcefile> inside <report>/);
    throwsAt(() => readJacoco('<report name="r">\n<package name="p"><class name="p/A"/></package>\n</report>', 'j.xml'), 'j.xml', 1, /holds no <sourcefile>/);
    throwsAt(() => readJacoco('<coverage/>', 'j.xml'), 'j.xml', 1, /not a JaCoCo report/);
  });
});

describe('readCoverageJson', () => {
  // coverage.py's `coverage json --show-contexts` with branch measurement, pretty-printed: meta, then files keyed by path with
  // executed_lines, missing_lines, contexts by line, and executed_branches/missing_branches as [from, to] arcs (a negative `to`
  // leaves the function). Format 3 adds functions and classes, which are not read.
  // https://coverage.readthedocs.io/en/latest/commands/cmd_json.html
  // https://github.com/nedbat/coveragepy/blob/master/coverage/jsonreport.py
  const json = `{
    "meta": {
        "format": 3,
        "version": "7.6.1",
        "timestamp": "2026-09-28T10:00:00.000000",
        "branch_coverage": true,
        "show_contexts": true
    },
    "files": {
        "shop/cart.py": {
            "executed_lines": [1, 3, 4, 5],
            "summary": {"covered_lines": 4, "num_statements": 5},
            "missing_lines": [7],
            "excluded_lines": [],
            "contexts": {
                "1": [""],
                "3": ["tests/test_cart.py::test_total|run"],
                "4": ["tests/test_cart.py::test_total|run", "tests/test_cart.py::TestCart::test_empty|setup"],
                "5": ["tests/test_cart.py::test_total|run"]
            },
            "executed_branches": [[4, 5]],
            "missing_branches": [[4, 7], [5, -2]],
            "functions": {},
            "classes": {}
        },
        "shop/tax.py": {
            "executed_lines": [],
            "summary": {"covered_lines": 0, "num_statements": 2},
            "missing_lines": [1, 2],
            "excluded_lines": [],
            "contexts": {},
            "executed_branches": [],
            "missing_branches": []
        }
    },
    "totals": {"covered_lines": 4, "num_statements": 7}
}`;

  it('reads lines, contexts and arcs', () => {
    expect(readCoverageJson(json, 'coverage.json')).toEqual({
      files: [
        {
          path: 'shop/cart.py',
          executed: [1, 3, 4, 5],
          missing: [7],
          contexts: {
            1: [''],
            3: ['tests/test_cart.py::test_total|run'],
            4: ['tests/test_cart.py::test_total|run', 'tests/test_cart.py::TestCart::test_empty|setup'],
            5: ['tests/test_cart.py::test_total|run'],
          },
          branches: [[4, 5, true], [4, 7, false], [5, -2, false]],
        },
        { path: 'shop/tax.py', executed: [], missing: [1, 2], contexts: {}, branches: [] },
      ],
    });
  });

  it('skips unmeasured branches', () => {
    const lines = JSON.stringify({ meta: { format: 3, branch_coverage: false, show_contexts: true },
      files: { 'a.py': { executed_lines: [1], missing_lines: [], excluded_lines: [], contexts: { 1: ['t|run'] } } } });
    expect(readCoverageJson(lines, 'c.json')).toEqual({ files: [{ path: 'a.py', executed: [1], missing: [], contexts: { 1: ['t|run'] } }] });
  });

  it('reports errors with file and line', () => {
    throwsAt(() => readCoverageJson('{\n  "meta": {},\n  "files": {,}\n}', 'c.json'), 'c.json', 3, /not valid JSON/);
    throwsAt(() => readCoverageJson('{\n  "meta": {}\n  x', 'c.json'), 'c.json', 3, /not valid JSON/);
    throwsAt(() => readCoverageJson('\n\nnope', 'c.json'), 'c.json', 3, /not valid JSON/);
    throwsAt(() => readCoverageJson('', 'c.json'), 'c.json', 1, /not valid JSON/);
    throwsAt(() => readCoverageJson('[]', 'c.json'), 'c.json', 1, /needs "meta" and "files"/);
    throwsAt(() => readCoverageJson(json.replace('"show_contexts": true', '"show_contexts": false'), 'c.json'), 'c.json', 2, /without --show-contexts/);
    throwsAt(() => readCoverageJson(json.replace('"executed_lines": [1, 3, 4, 5],', ''), 'c.json'), 'c.json', 10, /shop\/cart.py: executed_lines/);
    throwsAt(() => readCoverageJson(json.replace('"3": [', '"three": ['), 'c.json'), 'c.json', 10, /"three", not a line number/);
    throwsAt(() => readCoverageJson(json.replace('"missing_branches": []\n', '"missing_branches": 4\n'), 'c.json'),
      'c.json', 26, /shop\/tax.py: missing_branches/);
    throwsAt(() => readCoverageJson(json.replace('"executed_branches": [[4, 5]],', ''), 'c.json'), 'c.json', 10, /executed_branches is not a list/);
    throwsAt(() => readCoverageJson(json.replace('"contexts": {},', ''), 'c.json'), 'c.json', 26, /has no contexts/);
    // Python's json escapes a non-ASCII path, and the error still points at that file's entry.
    const escaped = '{\n  "meta": {"show_contexts": true},\n  "files": {\n    "caf\\u00e9.py": {\n      "executed_lines": "no"\n    }\n  }\n}';
    throwsAt(() => readCoverageJson(escaped, 'c.json'), 'c.json', 4, /café\.py: executed_lines is not a list/);
  });
});

describe('repoPath', () => {
  const paths = new Set(['src/cart.py', 'shop/cart.py', 'src/x.py', 'lib/x.py']);
  const root = '/repo';

  it('makes an absolute path under the root relative', () => {
    expect(repoPath('/repo/src/cart.py', { root, paths })).toBe('src/cart.py');
    expect(repoPath('/repo/src/../shop/cart.py', { root, paths })).toBe('shop/cart.py');
    expect(repoPath('/repo/src/untracked.py', { root, paths })).toBeNull();
  });

  it('joins a relative path to the root', () => {
    expect(repoPath('src/cart.py', { root, paths })).toBe('src/cart.py');
    expect(repoPath('./src/cart.py', { root, paths })).toBe('src/cart.py');
  });

  it('joins paths through Cobertura sources', () => {
    expect(repoPath('cart.py', { root, sources: ['/repo/shop'], paths })).toBe('shop/cart.py');
    expect(repoPath('cart.py', { root, sources: ['shop'], paths })).toBe('shop/cart.py');
    expect(repoPath('src/cart.py', { root, sources: ['/repo'], paths })).toBe('src/cart.py');
  });

  it('is null outside the repository', () => {
    expect(repoPath('/elsewhere/src/cart.py', { root, paths })).toBeNull();
    expect(repoPath('/home/runner/work/shop/shop/src/cart.py', { root, paths })).toBeNull();
    expect(repoPath('cart.py', { root, sources: ['/home/runner/work/shop/shop/shop'], paths })).toBeNull();
    expect(repoPath('cart.py', { root, paths })).toBeNull();
    expect(repoPath('../repo/src/cart.py', { root, paths })).toBe('src/cart.py');
    expect(repoPath('../outside/cart.py', { root, paths })).toBeNull();
    expect(repoPath('/repo', { root, paths })).toBeNull();
  });

  it('is null for an ambiguous path', () => {
    expect(repoPath('x.py', { root, sources: ['src', 'lib'], paths })).toBeNull();
    expect(repoPath('x.py', { root, sources: ['src', 'elsewhere'], paths })).toBe('src/x.py');
  });
});

/** The real reports CI's tools wrote for the fixture apps, and the reader for each by its file name. */
const READERS = [
  [/^junit.*\.xml$|^TEST-.*\.xml$/, (text, path) => readJunit(text, path).length],
  [/\.info$/, (text, path) => readLcov(text, path).tests.reduce((sum, test) => sum + test.files.length, 0)],
  [/^cobertura.*\.xml$|^coverage\.xml$/, (text, path) => readCobertura(text, path).files.length],
  [/^coverage\.json$/, (text, path) => readCoverageJson(text, path).files.length],
  [/^jacoco\.xml$/, (text, path) => readJacoco(text, path).files.length],
];
/** Every report file under test/fixtures/<app>/reports/<runner>/, a `junit/` directory of per-class files included. */
const walk = dir => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
const realReports = readdirSync(FIXTURES, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(FIXTURES, entry.name, 'reports')))
  .flatMap(entry => walk(join(FIXTURES, entry.name, 'reports')).map(path => path.slice(FIXTURES.length).replace(/^\//, '')));

describe.runIf(realReports.length > 0)('fixture report files', () => {
  it.each(realReports)('%s parses', report => {
    const file = report.split('/').pop();
    const reader = READERS.find(([pattern]) => pattern.test(file));
    expect(reader, `no reader for ${file}`).toBeDefined();
    const path = join(FIXTURES, report);
    expect(reader[1](readFileSync(path, 'utf8'), path)).toBeGreaterThan(0);
  });
});

describe('coverage.py JSON error lines', () => {
  // Several of V8's messages name no position ("Unexpected token '}', ... is not valid JSON", "Unexpected end of JSON input"),
  // so the line comes from walking the grammar. Each line here is where the text first stops being JSON, counted by hand.
  it.each([
    ['{"a":1,}', 1], ['{\n"a":\n}', 3], ['[1,2', 1], ['{"a":[1,\n2,,3]}', 2], ['{"a":tru}', 1],
    ['{\n  "meta": {}\n  "files": {}\n}', 3], ['{"a":"x\ny"}', 1], ['{} x', 1], ['', 1],
  ])('%j fails at line %i', (text, line) => {
    expect(() => readCoverageJson(text, 'c.json')).toThrow(new RegExp(`^c\\.json:${line}: not valid JSON`));
  });
});
