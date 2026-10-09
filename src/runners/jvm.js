/**
 * Java on Gradle or Maven, run by perch as PIT runs it: every mutant written into the code once behind a switch, the project
 * built once by its own build, and each mutant run in a JVM kept warm, through JUnit's or TestNG's own launcher, with the
 * mutant set in a static field. A mutant the compiler rejects is traced to the edit at the error's line and column, taken out,
 * and the project built again; it is invalid.
 *
 * Which test reaches which mutant comes from the suite run: each test runs alone, named in the switch as it does, so every
 * switch it reaches is put down to it.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { mutantId } from '../mutants.js';
import { instrument } from './schemata.js';
import { startWorkers } from './workers.js';

const run = promisify(execFile);

/** The switch every module with mutants gets: the mutant to run, set by the worker, and the test running, while coverage is read. */
const SWITCH = `package perch;

/**
 * Everything it knows comes from system properties, read as the class loads, so every copy of it a class loader makes, one per
 * mutant or one a test framework makes for itself, does the same: the mutant to run, and while coverage is read, the file it is
 * written to and the test running, which is looked up at each switch reached.
 */
public final class PerchSwitch {
    public static volatile int active = parse(System.getProperty("perch.mutant", System.getenv("PERCH_MUTANT")));
    private static final java.io.PrintStream HITS = open(System.getProperty("perch.hits"));
    private static final java.util.Set<String> SEEN = java.util.concurrent.ConcurrentHashMap.newKeySet();

    private PerchSwitch() {}

    private static int parse(String value) {
        try { return value == null ? -1 : Integer.parseInt(value); } catch (NumberFormatException error) { return -1; }
    }

    private static java.io.PrintStream open(String path) {
        if (path == null || path.isEmpty()) return null;
        try { return new java.io.PrintStream(new java.io.FileOutputStream(path, true), true, "UTF-8"); } catch (java.io.IOException error) { return null; }
    }

    public static boolean on(int id) {
        if (HITS != null) {
            String test = System.getProperty("perch.current");
            if (test != null && SEEN.add(test + "\\t" + id)) {
                synchronized (HITS) { HITS.println(id + "\\t" + test); }
            }
        }
        return active == id;
    }
}
`;

/**
 * The worker: commands as JSON strings on standard input, tab-separated, and answers as JSON on lines that start with
 * `@@perch`, the tests' own output going to standard error. Each test runs alone through the engine its annotations name.
 */
const WORKER = `import java.io.*;
import java.lang.reflect.*;
import java.util.*;

public final class PerchWorker {
    public interface Engine { boolean[] run(Class<?> type, String name, Method method) throws Exception; }

    static PrintStream protocol;

    static String json(String text) {
        StringBuilder out = new StringBuilder("\\"");
        for (char c : text.toCharArray()) {
            if (c == '"' || c == '\\\\') out.append('\\\\').append(c);
            else if (c < 0x20 || c == 0x2028 || c == 0x2029) out.append(String.format("\\\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }

    static String unquote(String line) {
        StringBuilder out = new StringBuilder();
        for (int at = 1; at < line.length() - 1; at++) {
            char c = line.charAt(at);
            if (c != '\\\\') { out.append(c); continue; }
            char next = line.charAt(++at);
            switch (next) {
                case 't': out.append('\\t'); break;
                case 'n': out.append('\\n'); break;
                case 'r': out.append('\\r'); break;
                case 'u': out.append((char) Integer.parseInt(line.substring(at + 1, at + 5), 16)); at += 4; break;
                default: out.append(next);
            }
        }
        return out.toString();
    }

    static final Map<String, Engine> ENGINES = new HashMap<>();
    static Engine engine(String name) {
        return ENGINES.computeIfAbsent(name, key -> {
            try { return (Engine) Class.forName(key).getDeclaredConstructor().newInstance(); } catch (Throwable error) { return null; }
        });
    }

    /**
     * The engine a test runs on: the one its method's annotations name, JUnit 5's, JUnit 4's or TestNG's; ScalaTest's for a test of
     * a ScalaTest suite, which is no method; JUnit 4's for one of a class a JUnit 4 runner runs, as MUnit's suites are.
     */
    static Engine engineFor(Class<?> type, Method method) {
        if (method == null) {
            Class<?> suite = classOrNullPlain("org.scalatest.Suite", type.getClassLoader());
            if (suite != null && suite.isAssignableFrom(type)) return engine("ScalatestEngine");
            for (Class<?> at = type; at != null; at = at.getSuperclass()) for (java.lang.annotation.Annotation annotation : at.getDeclaredAnnotations()) {
                if (annotation.annotationType().getName().equals("org.junit.runner.RunWith")) return engine("Junit4Engine");
            }
            return null;
        }
        for (java.lang.annotation.Annotation annotation : method.getAnnotations()) {
            String name = annotation.annotationType().getName();
            if (name.startsWith("org.junit.jupiter.")) return engine("Junit5Engine");
            if (name.equals("org.junit.Test")) return engine("Junit4Engine");
            if (name.startsWith("org.testng.")) return engine("TestngEngine");
        }
        for (java.lang.annotation.Annotation annotation : method.getDeclaringClass().getAnnotations()) if (annotation.annotationType().getName().equals("org.testng.annotations.Test")) return engine("TestngEngine");
        return null;
    }

    static Class<?> classOrNullPlain(String name, ClassLoader loader) {
        try { return Class.forName(name, false, loader); } catch (Throwable error) { return null; }
    }

    /** The test method by its name: an annotated one first, else any, as TestNG takes every public method of a class marked @Test. */
    static Method methodOf(Class<?> type, String name) {
        Method plain = null;
        for (Class<?> at = type; at != null; at = at.getSuperclass()) {
            for (Method method : at.getDeclaredMethods()) {
                if (!method.getName().equals(name)) continue;
                if (method.getAnnotations().length > 0) return method;
                if (plain == null) plain = method;
            }
        }
        return plain;
    }

    /**
     * The project's own classes and resources load afresh for every mutant, in a loader of their own over the dependencies, which
     * stay loaded: what a run leaves in a static field, or a constant a static initializer set, is not the next run's. The mutant
     * is a system property the new loader's switch reads as it loads, as the program with the edit written in would start.
     */
    public static void main(String[] args) throws Exception {
        protocol = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        System.setOut(System.err);
        List<java.net.URL> urls = new ArrayList<>();
        for (String path : System.getenv("PERCH_OWN").split(File.pathSeparator)) if (!path.isEmpty()) urls.add(new File(path).toURI().toURL());
        java.net.URL[] own = urls.toArray(new java.net.URL[0]);
        ClassLoader shared = PerchWorker.class.getClassLoader();
        java.net.URLClassLoader coverLoader = null;
        protocol.println("@@perch\\t{\\"ready\\":true}");
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
        for (String line; (line = input.readLine()) != null;) {
            String[] parts = unquote(line).split("\\t", -1);
            String kind = parts[0], id = parts[1];
            boolean cover = kind.equals("COVER");
            System.setProperty("perch.mutant", cover ? "-1" : parts[2]);
            if (cover) System.setProperty("perch.hits", parts[2]); else System.clearProperty("perch.hits");
            java.net.URLClassLoader loader;
            if (cover) { if (coverLoader == null) coverLoader = new java.net.URLClassLoader(own, shared); loader = coverLoader; }
            else loader = new java.net.URLClassLoader(own, shared);
            Thread.currentThread().setContextClassLoader(loader);
            System.setProperty("perch.runpath", String.join(" ", urls.stream().map(url -> url.getPath()).toArray(String[]::new)));
            boolean bail = !cover && parts[3].equals("1");
            StringBuilder results = new StringBuilder();
            for (int at = 4; at < parts.length; at++) {
                String selector = parts[at];
                String status;
                long started = System.nanoTime();
                try {
                    Class<?> type = Class.forName(selector.substring(0, selector.indexOf('#')), false, loader);
                    String name = selector.substring(selector.indexOf('#') + 1);
                    Method method = methodOf(type, name);
                    Engine engine = engineFor(type, method);
                    if (engine == null) continue;
                    if (cover) System.setProperty("perch.current", selector);
                    boolean[] outcome = engine.run(type, name, method);
                    if (!outcome[0]) continue;
                    status = outcome[1] ? "failed" : "passed";
                } catch (Throwable error) {
                    error.printStackTrace();
                    status = "failed";
                } finally {
                    System.clearProperty("perch.current");
                }
                if (results.length() > 0) results.append(',');
                results.append('[').append(json(selector)).append(',').append(json(status)).append(',').append((System.nanoTime() - started) / 1e9).append(']');
                if (bail && status.equals("failed")) break;
            }
            if (!cover) loader.close();
            protocol.println("@@perch\\t{\\"id\\":" + json(id) + ",\\"results\\":[" + results + "]}");
        }
    }
}
`;

/** JUnit 5 through the platform launcher: the method selected, and whether it or anything around it failed. */
const JUNIT5 = `import java.lang.reflect.Method;
import org.junit.platform.engine.TestExecutionResult;
import org.junit.platform.engine.discovery.DiscoverySelectors;
import org.junit.platform.launcher.*;
import org.junit.platform.launcher.core.*;

public final class Junit5Engine implements PerchWorker.Engine {
    private final Launcher launcher = LauncherFactory.create();
    public boolean[] run(Class<?> type, String name, Method method) {
        boolean[] outcome = { false, false };
        LauncherDiscoveryRequest request = LauncherDiscoveryRequestBuilder.request().selectors(DiscoverySelectors.selectMethod(type, method)).build();
        launcher.execute(request, new TestExecutionListener() {
            @Override public void executionFinished(TestIdentifier id, TestExecutionResult result) {
                if (id.isTest()) outcome[0] = true;
                if (result.getStatus() != TestExecutionResult.Status.SUCCESSFUL) { outcome[0] = true; outcome[1] = true; }
            }
        });
        return outcome;
    }
}
`;

/** JUnit 4, and the runners it takes, Parameterized's and MUnit's among them: the method's cases, `name` and `name[2]`. */
const JUNIT4 = `import java.lang.reflect.Method;
import org.junit.runner.*;
import org.junit.runner.manipulation.Filter;

public final class Junit4Engine implements PerchWorker.Engine {
    public boolean[] run(Class<?> type, String name, Method method) {
        Filter only = new Filter() {
            @Override public boolean shouldRun(Description description) {
                if (description.isTest()) {
                    String method = description.getMethodName();
                    return method != null && (method.equals(name) || method.startsWith(name + "["));
                }
                for (Description child : description.getChildren()) if (shouldRun(child)) return true;
                return false;
            }
            @Override public String describe() { return name; }
        };
        Result result = new JUnitCore().run(Request.aClass(type).filterWith(only));
        return new boolean[] { result.getRunCount() > 0 || result.getFailureCount() > 0, !result.wasSuccessful() };
    }
}
`;

const TESTNG = `import java.lang.reflect.Method;
import java.util.*;
import org.testng.*;
import org.testng.xml.*;

public final class TestngEngine implements PerchWorker.Engine {
    public boolean[] run(Class<?> type, String name, Method method) {
        XmlSuite suite = new XmlSuite();
        suite.setName("perch");
        XmlTest test = new XmlTest(suite);
        test.setName("perch");
        XmlClass xmlClass = new XmlClass(type);
        xmlClass.setIncludedMethods(Collections.singletonList(new XmlInclude(name)));
        test.setXmlClasses(Collections.singletonList(xmlClass));
        TestNG testng = new TestNG(false);
        testng.setVerbose(0);
        testng.setXmlSuites(Collections.singletonList(suite));
        TestListenerAdapter listener = new TestListenerAdapter();
        testng.addListener(listener);
        testng.run();
        int ran = listener.getPassedTests().size() + listener.getFailedTests().size();
        return new boolean[] { ran > 0 || testng.hasFailure(), testng.hasFailure() || !listener.getFailedTests().isEmpty() || !listener.getConfigurationFailures().isEmpty() };
    }
}
`;

/**
 * ScalaTest through its own runner: the suite and the one test by its full name, a reporter of perch's counting what ran and
 * what failed. A suite that aborts fails the test.
 */
const SCALATEST = `import java.lang.reflect.Method;

public final class ScalatestEngine implements PerchWorker.Engine {
    public boolean[] run(Class<?> type, String name, Method method) {
        PerchScalatestReporter.reset();
        org.scalatest.tools.Runner.run(new String[] { "-R", System.getProperty("perch.runpath"), "-s", type.getName(), "-t", name, "-C", "PerchScalatestReporter" });
        return new boolean[] { PerchScalatestReporter.ran > 0 || PerchScalatestReporter.failed > 0, PerchScalatestReporter.failed > 0 };
    }
}
`;

const SCALATEST_REPORTER = `public final class PerchScalatestReporter implements org.scalatest.Reporter {
    static volatile int ran = 0, failed = 0;
    static void reset() { ran = 0; failed = 0; }
    public void apply(org.scalatest.events.Event event) {
        if (event instanceof org.scalatest.events.TestSucceeded) ran++;
        else if (event instanceof org.scalatest.events.TestFailed || event instanceof org.scalatest.events.SuiteAborted) failed++;
    }
}
`;

/** Gradle's test classpath of every Java project, each written to a file of its own, and the tests compiled. */
const GRADLE_INIT = `allprojects {
  afterEvaluate { project ->
    if (project.plugins.hasPlugin('java')) {
      project.tasks.register('perchClasspath') {
        def out = new File(System.getenv('PERCH_CLASSPATHS'), project.path.replace(':', '_') + '.txt')
        def files = project.sourceSets.test.runtimeClasspath
        doLast { out.text = files.files.join(File.pathSeparator) }
      }
    }
  }
}
`;

export const name = 'jvm';
export const languages = new Set(['java', 'kotlin', 'scala']);
export const copiesFor = () => 1;

let ids = new Map(), keys = new Map(), unplaced = new Map(), classpath = '', workerDir = '', selectors = new Map(), tests = new Map(), build = null;

/** The build tool: Gradle where there is a Gradle build, Maven where there is a pom. */
function buildOf(root) {
  if (['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'].some(file => existsSync(join(root, file)))) {
    return { kind: 'gradle', command: existsSync(join(root, 'gradlew')) ? './gradlew' : 'gradle' };
  }
  if (existsSync(join(root, 'pom.xml'))) return { kind: 'maven', command: existsSync(join(root, 'mvnw')) ? './mvnw' : 'mvn' };
  if (existsSync(join(root, 'build.sbt'))) return { kind: 'sbt', command: 'sbt' };
  return null;
}

export async function available({ root }) {
  const found = buildOf(root);
  if (!found) return { reason: 'there is no Gradle build, pom.xml or build.sbt at the repository\'s root' };
  for (const command of ['java', 'javac']) {
    try { await run(command, ['-version']); } catch { return { reason: `${command} is not on PATH` }; }
  }
  if (!found.command.startsWith('./')) {
    try { await run(found.command, found.kind === 'sbt' ? ['--script-version'] : ['--version'], { cwd: root }); } catch { return { reason: `${found.command} is not on PATH` }; }
  }
  return { root, build: found };
}

/** javac's errors, as Gradle prints them, `/path/File.java:12: error: message`, with the column from the caret line under it. */
function gradleErrors(output) {
  const lines = output.split('\n'), errors = [];
  // Kotlin's compiler: `e: file:///path/File.kt:12:34 message`.
  for (const match of output.matchAll(/^e: (?:file:\/\/)?(\/.+?\.kts?):(\d+):(\d+) (.+)$/gm)) errors.push({ file: match[1], line: Number(match[2]), column: Number(match[3]), message: match[4] });
  for (const [at, line] of lines.entries()) {
    const match = /^(\/.+?\.java):(\d+): error: (.+)$/.exec(line.trim());
    if (!match) continue;
    const caret = lines[at + 2]?.indexOf('^');
    errors.push({ file: match[1], line: Number(match[2]), column: caret >= 0 ? caret + 1 : undefined, message: match[3] });
  }
  return errors;
}

/** scalac's errors as sbt prints them, Scala 3's `-- [E007] ... /path/File.scala:12:34` and Scala 2's `/path/File.scala:12:34: message`. */
function sbtErrors(output) {
  const errors = [];
  for (const match of output.matchAll(/^\[error\]\s*(?:-- \[E\d+\] ([^:]+): )?(\/[^\s:]+\.(?:scala|java)):(\d+):(\d+):?\s*(.*)$/gm)) {
    errors.push({ file: match[2], line: Number(match[3]), column: Number(match[4]), message: (match[1] ?? match[5].replace(/-+$/, '').trim()) || 'error' });
  }
  return errors;
}

/** Maven's compiler errors, `[ERROR] /path/File.java:[12,34] message`. */
const mavenErrors = output => [...output.matchAll(/\[ERROR\]\s+(\/.+?\.java):\[(\d+),(\d+)\]\s+(.+)/g)].map(match => ({ file: match[1], line: Number(match[2]), column: Number(match[3]), message: match[4] }));

/** The directory of the build file nearest a file: the module it is part of. */
const moduleOf = (dir, path) => {
  for (let at = dirname(join(dir, path)); at.startsWith(dir); at = dirname(at)) {
    if (['build.gradle', 'build.gradle.kts', 'pom.xml', 'build.sbt'].some(file => existsSync(join(at, file)))) return at;
    if (at === dir) break;
  }
  return dir;
};

/** The selector a JUnit or TestNG launcher takes for a perch test: the class's binary name, nested ones after `$`, then the method. */
function selectorOf(node, file) {
  const prefix = file.package ? `${file.package}.` : '';
  // A Scala test is its suite and its full name, which may hold dots of its own.
  if (file.language === 'scala') return `${prefix}${node.qualified_name.slice(0, node.qualified_name.indexOf('.'))}#${node.qualified_name.slice(node.qualified_name.indexOf('.') + 1)}`;
  // Kotlin names a test in backticks, `adds up the cart`, which the JVM knows without them.
  const parts = node.qualified_name.replace(/`/g, '').split('.');
  const method = parts.pop();
  return `${file.package ? `${file.package}.` : ''}${parts.join('$')}#${method}`;
}

/** The project made ready: the switch in each module with mutants, every mutant written in, and the tests built until they build. */
export async function prepare({ copies: [copy], generated, graph, tool }) {
  ids = new Map(); keys = new Map(); unplaced = new Map(); selectors = new Map(); tests = new Map();
  build = tool.build;
  for (const node of graph.nodes.values()) {
    const file = graph.files.get(node.path)?.file;
    if (!node.case || !languages.has(file?.language)) continue;
    const selector = selectorOf(node, file);
    selectors.set(node.id, selector);
    tests.set(selector, node.id);
  }
  const byFile = new Map();
  let next = 0;
  for (const [methodId, mutants] of generated) {
    const node = graph.nodes.get(methodId);
    if (!byFile.has(node.path)) byFile.set(node.path, []);
    for (const mutant of mutants) {
      const key = `${methodId}#${mutantId(mutant)}`, id = next++;
      ids.set(key, id);
      keys.set(id, { key, mutant, path: node.path });
      byFile.get(node.path).push({ id, mutant });
    }
  }
  for (const module of new Set([...byFile.keys()].map(path => moduleOf(copy.dir, path)))) {
    await mkdir(join(module, 'src/main/java/perch'), { recursive: true });
    await writeFile(join(module, 'src/main/java/perch/PerchSwitch.java'), SWITCH);
  }
  const sources = new Map();
  for (const path of byFile.keys()) sources.set(path, await readFile(join(copy.dir, path), 'utf8'));
  const classpaths = join(copy.scratch, 'classpaths');
  await mkdir(classpaths, { recursive: true });
  await writeFile(join(copy.scratch, 'perch-init.gradle'), GRADLE_INIT);
  let sbtOutput = '';
  for (let round = 0; ; round++) {
    const placed = new Map();
    for (const [path, mutants] of byFile) {
      const result = instrument({ source: sources.get(path), language: graph.files.get(path).file.language, mutants: mutants.filter(item => !unplaced.has(item.id)) });
      for (const { id, reason } of result.unplaced) unplaced.set(id, reason);
      placed.set(path, result);
      await writeFile(join(copy.dir, path), result.text);
    }
    const args = build.kind === 'gradle'
      ? ['testClasses', 'perchClasspath', '--init-script', join(copy.scratch, 'perch-init.gradle'), '--console=plain', '--no-configuration-cache', '-q']
      : build.kind === 'sbt' ? ['-batch', '-no-colors', 'Test/compile', 'export Test/fullClasspath']
        : ['-B', '-q', 'test-compile', 'dependency:build-classpath', '-Dmdep.outputFile=perch-classpath.txt', '-Dmdep.includeScope=test'];
    let output, failed = false;
    try {
      const done = await run(build.command, args, { cwd: copy.dir, env: { ...process.env, PERCH_CLASSPATHS: classpaths }, maxBuffer: 1 << 28 });
      output = `${done.stdout}${done.stderr}`;
    } catch (error) { output = `${error.stdout ?? ''}${error.stderr ?? ''}`; failed = true; }
    const errors = ({ gradle: gradleErrors, maven: mavenErrors, sbt: sbtErrors })[build.kind](output);
    if (!failed) { if (build.kind === 'sbt') sbtOutput = output; break; }
    const rejected = new Map();
    for (const error of errors) for (const id of placed.get(relative(copy.dir, error.file))?.locate(error.line, error.column) ?? []) if (!rejected.has(id)) rejected.set(id, error.message);
    if (!rejected.size || round > 20) throw new Error(`the project does not build: ${(errors.length ? errors.slice(0, 3).map(error => `${relative(copy.dir, error.file)}:${error.line}: ${error.message}`) : output.trim().split('\n').slice(-6)).join(' | ')}`);
    for (const [id, message] of rejected) unplaced.set(id, `the compiler rejects it: ${message}`);
  }
  // One classpath for every module's tests: each module's own classes ahead of what they depend on.
  const entries = [];
  if (build.kind === 'gradle') {
    for (const file of await readdir(classpaths)) entries.push(...(await readFile(join(classpaths, file), 'utf8')).split(delimiter));
  } else if (build.kind === 'sbt') {
    // sbt prints each project's test classpath as a line of its own.
    for (const line of sbtOutput.split('\n')) if (!line.startsWith('[') && line.includes(delimiter) && /\.jar|classes/.test(line)) entries.push(...line.trim().split(delimiter));
  } else {
    const { stdout } = await run('find', [copy.dir, '-name', 'perch-classpath.txt'], { maxBuffer: 1 << 20 });
    for (const file of stdout.split('\n').filter(Boolean)) {
      entries.push(join(dirname(file), 'target/classes'), join(dirname(file), 'target/test-classes'), ...(await readFile(file, 'utf8')).trim().split(delimiter));
    }
  }
  const unique = [...new Set(entries.filter(Boolean))];
  const own = unique.filter(entry => entry.startsWith(copy.dir));
  classpath = [...own, ...unique.filter(entry => !entry.startsWith(copy.dir))];
  ownEntries = own;
  // JUnit 5 is run through its launcher, which a Maven build gets from Surefire rather than the test classpath: it is fetched,
  // at the version of the platform the tests use, when the project does not have it.
  const jar = name => classpath.find(entry => entry.split('/').at(-1).startsWith(name));
  const platform = jar('junit-platform-engine-');
  if (platform && !jar('junit-platform-launcher-')) {
    const version = /junit-platform-engine-(.+)\.jar$/.exec(platform)?.[1];
    const target = join(copy.scratch, `junit-platform-launcher-${version}.jar`);
    const response = await fetch(`https://repo1.maven.org/maven2/org/junit/platform/junit-platform-launcher/${version}/junit-platform-launcher-${version}.jar`);
    if (!response.ok) throw new Error(`could not fetch JUnit's platform launcher ${version}: HTTP ${response.status}`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    classpath.push(target);
  }
  workerDir = join(copy.scratch, 'perch-worker');
  await mkdir(workerDir, { recursive: true });
  const sources2 = { 'PerchWorker.java': WORKER };
  if (jar('junit-platform-launcher-') || classpath.some(entry => /junit-platform-launcher-/.test(entry))) sources2['Junit5Engine.java'] = JUNIT5;
  if (jar('junit-4.') || jar('junit-4')) sources2['Junit4Engine.java'] = JUNIT4;
  if (jar('testng-')) sources2['TestngEngine.java'] = TESTNG;
  if (classpath.some(entry => /scalatest-core/.test(entry.split('/').at(-1)))) Object.assign(sources2, { 'ScalatestEngine.java': SCALATEST, 'PerchScalatestReporter.java': SCALATEST_REPORTER });
  for (const [file, text] of Object.entries(sources2)) await writeFile(join(workerDir, file), text);
  await run('javac', ['-nowarn', '-cp', classpath.join(delimiter), '-d', workerDir, ...Object.keys(sources2).map(file => join(workerDir, file))], { maxBuffer: 1 << 24 });
}

/** The worker's JVM: perch's worker and the dependencies on its classpath; the project's own classes, in PERCH_OWN, it loads itself. */
const workerCommand = () => ({ command: 'java', args: ['-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-cp', [workerDir, ...classpath.filter(entry => !ownEntries.includes(entry))].join(delimiter), 'PerchWorker'] });
let ownEntries = [];

/** Every test once, alone, named in the switch as it runs: what each reached, and each result. */
export async function coverageRun({ copy, scratch }) {
  const hits = join(scratch, 'hits.tsv');
  await writeFile(hits, '');
  const started = Date.now();
  const workers = await startWorkers({ command: workerCommand(), count: 1, scratch, writable: [copy, scratch], cwd: copy, env: { PERCH_OWN: ownEntries.join(delimiter) } });
  let reply;
  // COVER, id, the hits file, and an unused field where a mutant's run says whether to stop at the first failure: the tests
  // start at the fifth field in both.
  try { reply = await workers.run(['COVER', 'coverage', hits, '0', ...selectors.values()].join('\t'), 0); } finally { await workers.close(); }
  if (reply.crashed) throw new Error(`the test worker stopped: ${reply.output.trim().split('\n').slice(-6).join(' | ')}`);
  const results = new Map();
  for (const [selector, status, time] of reply.results) results.set(selector, { test: tests.get(selector), status, time });
  const reached = new Map(), executed = new Map();
  for (const line of (await readFile(hits, 'utf8')).split('\n').filter(Boolean)) {
    const [id, selector] = line.split('\t');
    const test = tests.get(selector);
    if (!test) continue;
    if (!reached.has(test)) { reached.set(test, new Set()); executed.set(test, new Map()); }
    const { key, mutant, path } = keys.get(Number(id));
    reached.get(test).add(key);
    const lines = executed.get(test);
    if (!lines.has(path)) lines.set(path, new Set());
    for (const item of mutant.statements.length ? mutant.statements : [mutant.line]) lines.get(path).add(item);
  }
  const hitMethods = new Set([...keys.values()].map(({ key }) => key.slice(0, key.lastIndexOf('#'))));
  return { executed, hits: reached, hitMethods, unplaced: new Set([...unplaced.keys()].map(id => keys.get(id).key)), results, seconds: (Date.now() - started) / 1000 };
}

/** Each mutant run in a warm JVM: its number set, and only its tests run, each alone. */
export async function session({ copies: [copy], parallel = 1 }) {
  const workers = await startWorkers({ command: workerCommand(), count: parallel, scratch: copy.scratch, writable: [copy.dir, copy.scratch], cwd: copy.dir,
    env: { PERCH_OWN: ownEntries.join(delimiter) } });
  let count = 0;
  return {
    async run({ mutant, method, nodes, timeout, bail = false }) {
      const id = ids.get(`${method.id}#${mutantId(mutant)}`);
      if (unplaced.has(id)) return { status: 'invalid', error: unplaced.get(id) };
      const reply = await workers.run(['RUN', String(count++), String(id), bail ? '1' : '0', ...nodes].join('\t'), timeout);
      if (reply.timedOut) return { status: 'timeout' };
      // The JVM died under the mutant, a crash or an exit it made: every test it was given failed.
      if (reply.crashed) return { status: 'ran', results: new Map(nodes.map(node => [node, { test: tests.get(node), status: 'failed' }])) };
      return { status: 'ran', results: new Map(reply.results.map(([selector, status]) => [selector, { test: tests.get(selector), status }])) };
    },
    close: () => workers.close(),
  };
}
