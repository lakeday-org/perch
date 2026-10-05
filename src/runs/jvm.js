/**
 * Surefire's and Gradle's names for a test: the binary class name and the method. Both write every framework's testcase the same
 * way, JUnit 5, JUnit 4 and TestNG alike: `classname="example.CartTest"`, and the method as its name. Surefire writes the method
 * bare, `takesTenPercentOff`; Gradle writes JUnit 5's legacy reporting name, `takesTenPercentOff()`. TestNG under Surefire writes
 * every class into one TEST-TestSuite.xml, and each testcase still carries its own classname. None of them needs configuring.
 */
export const family = 'jvm';
export const languages = new Set(['java', 'kotlin']);
export const roots = () => [];

/** The classname is the binary class name, package then classes, a nested class after a `$`. */
export function testNames(node, { file }) {
  const { case: test } = node, suite = test.suite ?? [];
  const binary = [...(file.package ? [file.package] : []), suite.join('$')].join('.');
  // Also under its class alone, for an invocation whose name Gradle 9 writes without the method: one parameterized test in the
  // class is the one it is; with two, the invocation could be either and is left unmatched.
  const parameterized = test.framework === 'ParameterizedTest' ? [`jvm\0${binary}\0${PARAMETERIZED}`] : [];
  return { keys: [`jvm\0${binary}\0${test.name}`, ...parameterized], full: [`${binary}.${test.name}`] };
}

const PARAMETERIZED = '[parameterized]';

/**
 * The method a testcase's name is: the name it starts with. JUnit Platform's legacy reporting name adds the parameter types,
 * `()` or `(int, String)`; an invocation adds its index, `[1]`, or under TestNG its data, `allows[DRAFT, ISSUED](1)`; a display
 * name configured to lead with the method, `parses(String) [1] usd`; a bare method name is Surefire's JUnit 4 and TestNG.
 * Gradle 9 writes a parameterized test's invocation as `[1] usd` alone, which says only that it is one.
 */
export function runNames(run) {
  if (/^\[\d+\]/.test(run.name)) return [`jvm\0${run.classname ?? ''}\0${PARAMETERIZED}`];
  const method = /^([\p{L}_$][\p{L}\p{N}_$]*)(?:[([\s]|$)/u.exec(run.name);
  return method ? [`jvm\0${run.classname ?? ''}\0${method[1]}`] : [];
}
