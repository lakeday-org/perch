/**
 * `perch coverage`: which tests reach which methods, what each test decides, and which branch of each tested method no test takes.
 *
 * Nothing here runs a test. Tests are the declarations tree-sitter marked as test cases, and what a test reaches is a walk over
 * the call graph. When CI's test run wrote JUnit XML and a coverage report, those are read: a test's time and result, the lines
 * and branches of each method that ran, and with per-test data, the lines each test ran. A number a report holds is measured and
 * says so; what no report covers is Jev's estimate or a fact of the graph, and says which. The call graph and the reports find a
 * problem, and Jev decides whether it is one: every listed problem's probability is a System One answer or computed from
 * answers. A problem whose unit could not be asked has none, and is listed with the failure.
 *
 * A test or a method that cannot be asked about is recorded as failed and stays in the report as failed. It is never counted as
 * a useful test or as a covered method, since a report that quietly fills in what it could not find out reads as complete.
 */
import { readFileSync } from 'node:fs';
import { copyFile, glob, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { changedLines, listTree, readBlob, revision as commitOf } from './git.js';
import { readCobertura, readCoverageJson, readJacoco, readJunit, readLcov, repoPath } from './test-reports.js';
import { analyzeTree } from './analyze.js';
import { frameworkScope } from './test-scope.js';
import { TOP_LEVEL } from './analysis.js';
import { buildGraph, resolveModule } from './graph.js';
import { AuthenticationError } from './systemone.js';
import { compile, parseQuestions, readAnswer } from './ask.js';
import { excerpt, leadingComment, shownLines, spanOf } from './questions.js';
import { identity, openStore, readJson } from './store.js';
import { estimateTokens, IncompleteCheckError, TOKEN_LIMITS, withTokenRetries } from './tokens.js';
import { matches, readCoverageReports, readIgnored } from './units.js';
import { covers } from './scan.js';
import { namesOf, patternsOf, rootsOf, runNames } from './runs/index.js';
import { languages as jvmLanguages } from './runs/jvm.js';
import { shownPath } from './runs/paths.js';

/** How many calls deep a test is followed into the code it reaches, unless --depth says otherwise. */
export const DEFAULT_DEPTH = 3;
/** Tests or methods in flight at once. */
export const DEFAULT_PARALLEL = 8;
/** How many neighbours a state shows at most: the methods a test reaches, or the tests that reach a method. */
export const MAX_SHOWN = 8;

/** The questions perch asks about tests and methods, read once from the file they are declared in. */
/** What an answer is kept under: what was shown, which questions were asked, and who answered. Any of them changing asks again. */
const QUESTIONS = parseQuestions(readFileSync(new URL('../coverage.yaml', import.meta.url), 'utf8'), 'coverage.yaml');

/**
 * What is asked of every test and of every tested method. gap_line is declared with `none` as its only option; the method's own
 * branch lines are added when it is asked, by `methodQuestions`, since they are different for every method.
 */
export const coverageQuestions = () => ({ test: QUESTIONS.filter(question => question.each === 'test'), method: QUESTIONS.filter(question => question.each === 'method') });
const questionNamed = name => QUESTIONS.find(question => question.name === name);
/** Whether a method is untested: measured, none of its lines ran, whatever reaches it; unmeasured, no test reaches it. */
const isUntested = method => (method.measured ? method.measured.lines.hit === 0 : !method.tests.length);
/** What a node in a test's request is, when it is not code the test reaches: a helper of its own, or the test it may repeat. */
const HELPER = "the test's own helper, which it calls through to the code under test";
const EARLIER = 'the earlier test this one may repeat';
const MACRO = "a macro the test uses, which may hold its assertions";

/**
 * Where a C or C++ `#define NAME(...)` or a Rust `macro_rules! NAME` starts in a file's lines, and the lines it runs to: a #define
 * to the first line not continued with a backslash, a macro_rules! to the brace that closes it.
 */
function macroIn(lines, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex(line => new RegExp(`^\\s*#\\s*define\\s+${escaped}\\s*\\(|^\\s*macro_rules!\\s*${escaped}\\b`).test(line));
  if (start < 0) return null;
  let end = start;
  if (/^\s*#/.test(lines[start])) while (end < lines.length - 1 && /\\\s*$/.test(lines[end])) end++;
  else for (let depth = 0, opened = false; end < lines.length; end++) {
    for (const char of lines[end]) { if (char === '{') { depth++; opened = true; } else if (char === '}') depth--; }
    if (opened && depth <= 0) break;
  }
  return { line: start + 1, text: lines.slice(start, end + 1).join('\n') };
}
const MACRO_LANGUAGES = new Set(['c', 'cpp', 'rust']);
/** Asked of a method only once the call graph or the report has found no test runs it, and never with the branch questions. */
const NEEDS_TEST = 'needs_test';

/**
 * A branch line as gap_line names it: its place within the method, `line_3` for the method's third line. A file line number
 * changed whenever code above the method moved, and with it the question, so a method nobody touched was asked again.
 */
const branchKey = (node, line) => `line_${line - node.line + 1}`;
/** The file line a gap_line answer names, or null for `none`. */
const branchLine = (node, choice) => { const match = /^line_(\d+)$/.exec(choice ?? ''); return match ? node.line + Number(match[1]) - 1 : null; };

/** The typed questions for one method, gap_line offering that method's branch lines, each shown with the line's own text. */
export function methodQuestions(node, branches, lines) {
  const typed = compile(coverageQuestions().method.filter(question => question.name !== NEEDS_TEST));
  const gap = questionNamed('gap_line');
  typed.gap_line = { ...typed.gap_line, criteria: { ...Object.fromEntries(branches.map(line => [branchKey(node, line), (lines[line - 1] ?? '').trim()])), ...gap.options } };
  return typed;
}

/**
 * A unit's text as a request shows it: the comment above it, which is its contract, then its lines, with no line numbers. The
 * answer is cached under the request, so a number in it made code below an inserted line a request nobody had asked.
 */
const sourceOf = (node, lines) => [leadingComment(lines, node.line), shownLines(spanOf(node, lines))].filter(Boolean).join('\n');

/** The calls between the units a request shows: the edges drawn from code in view, to code in view. */
const edgesAmong = (graph, ids) => {
  const shown = new Set(ids);
  return [...shown].flatMap(from => graph.callees(from).filter(to => shown.has(to)).sort().map(to => `${from} -> ${to}`));
};

/**
 * Calls and reads that leave the process, by language and by kind. A read is member access nothing calls, `process.env.KEY` or
 * `os.environ`, which is how a program reads its environment. A call is matched on its name once its head is resolved through the
 * file's imports, so `fs.readFileSync` after `import fs from 'node:fs'` reads as `fs.readFileSync` and `get` after
 * `from requests import get` reads as `requests.get`. Only calls that resolve to nothing in the repository are matched: a call
 * into the repository is followed instead, and its own calls are matched where they are made.
 *
 * An entry matches a call whose name starts with it, segment by segment, so `requests` covers `requests.get` and `std::fs`
 * covers `std::fs::read_to_string`.
 */
const JAVASCRIPT = {
  network: ['fetch', 'XMLHttpRequest', 'WebSocket', 'axios', 'node-fetch', 'got', 'undici', 'superagent', 'ws', 'http', 'https', 'net', 'dgram', 'tls', 'http2'],
  database: ['pg', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'mongodb', 'mongoose', 'redis', 'ioredis', '@prisma/client', 'PrismaClient', 'knex', 'typeorm', 'sequelize'],
  filesystem: ['fs', 'fs/promises', 'fs-extra', 'Deno.readTextFile', 'Deno.writeTextFile', 'Deno.readFile', 'Deno.writeFile', 'Deno.open', 'Deno.remove', 'Deno.mkdir'],
  process: ['child_process', 'execa', 'Deno.Command', 'Deno.run'],
  environment: ['dotenv', 'process.env', 'import.meta.env', 'Deno.env'],
  clock: ['Date.now', 'performance.now', 'setTimeout', 'setInterval'],
};
export const INFRA = {
  python: {
    network: ['requests', 'httpx', 'aiohttp', 'urllib.request', 'urllib3', 'http.client', 'socket', 'smtplib', 'ftplib', 'boto3', 'botocore', 'grpc', 'websockets'],
    database: ['sqlite3', 'psycopg2', 'psycopg', 'asyncpg', 'pymysql', 'MySQLdb', 'sqlalchemy.create_engine', 'pymongo', 'redis', 'motor'],
    filesystem: ['open', 'io.open', 'os.open', 'os.remove', 'os.unlink', 'os.rename', 'os.makedirs', 'os.mkdir', 'os.rmdir', 'os.listdir', 'os.scandir', 'os.walk', 'os.stat',
      'os.path.exists', 'os.path.isfile', 'os.path.isdir', 'os.path.getsize', 'shutil', 'tempfile', 'glob.glob'],
    process: ['subprocess', 'os.system', 'os.popen', 'os.fork', 'os.execv', 'os.execvp', 'os.spawnl', 'os.spawnv', 'multiprocessing'],
    environment: ['os.getenv', 'os.environ', 'os.putenv', 'getenv', 'dotenv', 'load_dotenv'],
    clock: ['time.time', 'time.sleep', 'time.monotonic', 'time.perf_counter', 'datetime.now', 'datetime.utcnow', 'datetime.today', 'date.today',
      'datetime.datetime.now', 'datetime.datetime.utcnow', 'datetime.date.today'],
  },
  javascript: JAVASCRIPT,
  typescript: JAVASCRIPT,
  tsx: JAVASCRIPT,
  rust: {
    network: ['reqwest', 'hyper', 'ureq', 'std::net', 'tokio::net', 'TcpStream::connect', 'UdpSocket::bind'],
    database: ['sqlx', 'diesel', 'rusqlite', 'postgres', 'tokio_postgres', 'redis', 'mongodb'],
    filesystem: ['std::fs', 'tokio::fs', 'File::open', 'File::create', 'fs::read_to_string', 'fs::write', 'fs::read'],
    process: ['std::process', 'tokio::process', 'Command::new'],
    environment: ['std::env', 'env::var', 'dotenv', 'dotenvy'],
    clock: ['std::time::SystemTime::now', 'std::time::Instant::now', 'SystemTime::now', 'Instant::now', 'std::thread::sleep', 'thread::sleep', 'tokio::time::sleep',
      'chrono::Utc::now', 'chrono::Local::now', 'Utc::now', 'Local::now'],
  },
  go: {
    network: ['http', 'net', 'grpc'],
    database: ['sql.Open', 'sqlx', 'gorm', 'pgx', 'redis', 'mongo'],
    filesystem: ['os.Open', 'os.OpenFile', 'os.Create', 'os.ReadFile', 'os.WriteFile', 'os.Remove', 'os.RemoveAll', 'os.Mkdir', 'os.MkdirAll', 'os.ReadDir', 'os.Stat',
      'ioutil.ReadFile', 'ioutil.WriteFile', 'ioutil.ReadDir'],
    process: ['exec.Command', 'exec.CommandContext', 'os.StartProcess', 'syscall.Exec'],
    environment: ['os.Getenv', 'os.LookupEnv', 'os.Environ', 'os.Setenv', 'godotenv'],
    clock: ['time.Now', 'time.Sleep', 'time.Since', 'time.After', 'time.Tick', 'time.NewTimer', 'time.NewTicker'],
  },
  java: {
    network: ['java.net', 'HttpClient', 'HttpURLConnection', 'Socket', 'ServerSocket', 'RestTemplate', 'WebClient', 'OkHttpClient'],
    database: ['java.sql', 'DriverManager', 'JdbcTemplate', 'EntityManager'],
    filesystem: ['java.nio.file', 'Files', 'Paths', 'FileInputStream', 'FileOutputStream', 'FileReader', 'FileWriter', 'RandomAccessFile'],
    process: ['Runtime.getRuntime', 'ProcessBuilder'],
    environment: ['System.getenv', 'System.getProperty'],
    clock: ['System.currentTimeMillis', 'System.nanoTime', 'Instant.now', 'LocalDateTime.now', 'LocalDate.now', 'ZonedDateTime.now', 'Clock.systemUTC', 'Thread.sleep'],
  },
  c: {
    network: ['socket', 'connect', 'getaddrinfo', 'gethostbyname', 'curl_easy_init', 'curl_easy_perform'],
    database: ['sqlite3_open', 'sqlite3_open_v2', 'sqlite3_exec', 'PQconnectdb', 'mysql_real_connect'],
    filesystem: ['fopen', 'open', 'remove', 'unlink', 'mkdir', 'opendir', 'std::filesystem', 'std::ifstream', 'std::ofstream', 'std::fstream'],
    process: ['system', 'popen', 'fork', 'execv', 'execvp', 'execl', 'execlp', 'posix_spawn'],
    environment: ['getenv', 'std::getenv', 'secure_getenv', 'setenv'],
    clock: ['time', 'clock', 'gettimeofday', 'clock_gettime', 'sleep', 'usleep', 'std::chrono::system_clock::now', 'std::chrono::steady_clock::now',
      'std::chrono::high_resolution_clock::now', 'std::this_thread::sleep_for'],
  },
};
INFRA.kotlin = INFRA.java;
INFRA.cpp = INFRA.c;
/**
 * The kinds of I/O a test is asked about: a live service it does not own. A test's disk, processes and environment are almost
 * always its own temporary directory, fixtures and the variables it runs under, and reading them as a problem flagged half of
 * every suite. The clock makes a test slow or flaky, not a leak.
 */
const LEAKS = new Set(['network', 'database']);

const segments = name => String(name).split(/::|\./).filter(Boolean);
const JS_FAMILY = new Set(['javascript', 'typescript', 'tsx']);
/**
 * A call's name with its head replaced by what the file imported under that name. A JavaScript module specifier is one segment,
 * since `fs/promises` is a name and not a path to walk; everywhere else a module is dotted or `::`-separated like a call.
 */
function canonical(name, file) {
  const parts = segments(name);
  const imported = (file.imports ?? []).find(item => item.alias === parts[0]);
  if (!imported) return parts;
  const module = JS_FAMILY.has(file.language) ? [String(imported.module).replace(/^node:/, '')] : segments(imported.module);
  const named = imported.name === 'default' || imported.name === '*' ? [] : [imported.name];
  return [...module, ...named, ...parts.slice(1)];
}
const startsWith = (parts, prefix) => prefix.length <= parts.length && prefix.every((part, index) => parts[index] === part);

/** The kinds of I/O one call makes, by the table for the language of the file it is made in. */
export function infraOf(name, file) {
  const table = INFRA[file.language];
  if (!table) return [];
  const parts = canonical(name, file);
  return Object.keys(table).filter(category => table[category].some(entry => startsWith(parts, segments(entry))));
}

/** A Python file's dotted module path, which is what `patch('a.b.name')` names a call site by. */
const pythonModule = path => path.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.');

/**
 * Whether one of a test's mocks replaces a call that leaves the repository. graph.mocks answers this for calls into the
 * repository; a mocked library call has no node to cut, so it is matched here against the call as its own file names it.
 */
function mockedCall(mocks, name, file) {
  const raw = segments(name), full = canonical(name, file);
  return mocks.some(({ target }) => {
    if (target.kind === 'module') return JS_FAMILY.has(file.language) ? full[0] === String(target.module).replace(/^node:/, '') : startsWith(full, segments(target.module));
    if (target.kind === 'member') return startsWith(raw, [...segments(target.object), ...segments(target.name)]) || startsWith(full, [...segments(target.object), ...segments(target.name)]);
    if (target.kind === 'class') return raw[0] === target.name || full.includes(target.name);
    if (target.kind === 'path') {
      const path = segments(target.path);
      // Patched where it is looked up, `app.client.requests.get`, or where it is defined, `requests.get`.
      if (startsWith(full, path) || startsWith(raw, path)) return true;
      const site = [...segments(pythonModule(file.path)), ...raw];
      for (let start = 0; start < site.length; start++) if (startsWith(site.slice(start), path) && path.length > raw.length) return true;
    }
    return false;
  });
}

/** Mock targets as a reader of the test state sees them. */
const describeMock = ({ target, line }) => {
  const what = target.kind === 'module' ? `module ${target.module}` : target.kind === 'path' ? target.path
    : target.kind === 'member' ? `${target.object}.${target.name}` : `class ${target.name}`;
  return `${what} (line ${line})`;
};

/**
 * The static half of coverage: for every test, what it reaches through the call graph and what its mocks cut, and for every method
 * in scope, which tests reach it and how far away they are. No model is asked anything here.
 *
 * The walk is breadth first to `depth` calls. It does not enter anything in a test file, since a helper there is not code under
 * test, and it does not enter or pass through a method a mock of the test replaces.
 */
export function computeCoverage({ scan, graph, depth = DEFAULT_DEPTH, inScope = () => true, runs = () => true, named = inScope, reports = null }) {
  const nodes = [...graph.nodes.values()];
  // A file's code outside every function is the scan's to read: no test calls it, so as a method it would always be untested.
  const methods = nodes.filter(node => !node.test && node.qualified_name !== TOP_LEVEL && inScope(node.path));
  for (const node of methods) if (!Array.isArray(node.branches)) throw new Error(`${node.id} was analyzed without branch lines; the analysis is from an older perch`);
  const inScopeIds = new Set(methods.map(node => node.id));
  const byPosition = (a, b) => a.path.localeCompare(b.path) || a.line - b.line;
  const tests = [];
  const failed = [];
  // A test no framework of the repository runs is not part of its suite, whatever it reaches.
  for (const node of nodes.filter(node => node.case && runs(node.path)).sort(byPosition)) {
    const cut = new Set(graph.mocks(node.id));
    const reach = new Map();
    // A helper in the test's own code, `run(repo)` calling the code under test, is part of the test: it is walked through at the
    // depth of the call to it and never counted as reached. Stopping at it left a test that tests through a helper reaching nothing.
    const through = new Set([node.id]);
    let frontier = [node.id];
    for (let level = 1; level <= depth && frontier.length; level++) {
      const next = [], expand = [...frontier];
      while (expand.length) {
        for (const callee of graph.callees(expand.pop()).sort()) {
          const target = graph.nodes.get(callee);
          if (callee === node.id || reach.has(callee) || cut.has(callee) || !target || target.case) continue;
          if (target.test) { if (!through.has(callee)) { through.add(callee); expand.push(callee); } continue; }
          reach.set(callee, level);
          next.push(callee);
        }
      }
      frontier = next;
    }
    const reached = [...reach].map(([id, at]) => ({ id, depth: at }));
    if (!named(node.path) && !reached.some(item => inScopeIds.has(item.id))) continue;
    const direct = reached.filter(item => item.depth === 1).map(item => item.id).sort();
    const testFile = graph.files.get(node.path).file;
    const mocks = (testFile.mocks ?? []).filter(mock => mock.owner === node.id || mock.owner === 'file');
    // What leaves the process, from the test's own calls and those of everything it reaches, less what one of its mocks replaces.
    const evidence = [];
    for (const id of [node.id, ...reached.map(item => item.id)]) {
      const at = graph.nodes.get(id), file = graph.files.get(at.path).file;
      for (const use of [...graph.external(id), ...graph.reads(id)]) {
        if (mockedCall(mocks, use.name, file)) continue;
        for (const category of infraOf(use.name, file)) evidence.push({ category, name: use.name, path: at.path, line: use.line, from: id });
      }
    }
    const touches = [...new Set(evidence.map(item => item.category))].sort();
    // The test's own helpers it calls through, shown with it: what a test asserts on often comes back from one.
    const helpers = [...through].filter(id => id !== node.id).sort();
    const test = { id: node.id, node, direct, reach: reached, cuts: [...cut].sort(), mocks, touches, evidence, ...(helpers.length ? { helpers } : {}) };
    tests.push(test);
    // A test none of whose calls resolve to a method in the repository is still asked about: a test that asserts on a stub it
    // built itself reaches nothing, and that is exactly what the decides question is for. That its calls resolve to nothing is a
    // fact of the graph, and the report says so beside whatever the answers say, since the same fact also describes a test
    // whose target perch could not resolve.
    if (!graph.callees(node.id).length && !graph.usesRepository(node.id)) test.unresolved = [...new Set(graph.external(node.id).map(call => call.name))].sort();
  }
  const reachedBy = new Map();
  for (const test of tests) for (const item of test.reach) {
    // Appended in place: copying the list for every test that reaches a method made a helper that every test reaches quadratic.
    if (!reachedBy.has(item.id)) reachedBy.set(item.id, []);
    reachedBy.get(item.id).push({ id: test.id, depth: item.depth });
  }
  const units = methods.sort(byPosition).map(node => ({ id: node.id, node, branches: node.branches,
    tests: (reachedBy.get(node.id) ?? []).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)) }));
  // A file the parser could not read has tests and methods nobody can see, and says so rather than looking empty.
  for (const item of scan.coverage?.parser_diagnostics ?? []) {
    if (item.status === 'parsed' || !inScope(item.path)) continue;
    failed.push({ unit: item.path, subject: 'file', path: item.path, name: item.path, error: item.message ?? item.status });
  }
  const paths = new Set([...units.map(unit => unit.node.path), ...tests.map(test => test.node.path)]);
  const files = scan.files.filter(file => paths.has(file.path)).sort((a, b) => a.path.localeCompare(b.path));
  const coverage = { depth, tests, methods: units, files, failed, measurement: null };
  if (reports) coverage.measurement = measure(coverage, graph, reports);
  return coverage;
}

// ------------------------------------------------------------------------------------------------ What CI's test run wrote

/** The kinds of report perch reads, as `--junit`, `--lcov`, `--cobertura`, `--jacoco` and `--contexts` name them and perch.yaml lists them. */
export const REPORT_KINDS = ['junit', 'lcov', 'cobertura', 'jacoco', 'contexts'];
const REPORT_NAMES = { junit: 'JUnit XML', lcov: 'LCOV', cobertura: 'Cobertura XML', jacoco: 'JaCoCo XML', contexts: 'coverage.py JSON' };

/** A report path with a glob in it: `*`, `**`, `?`, a `[...]` class or a `{a,b}` list. */
const isPattern = path => /[*?[\]{}]/.test(path);

/**
 * The report files a run reads. A flag replaces perch.yaml's list for the kind it names and leaves the other kinds alone. A
 * flag's paths are relative to where perch was run, perch.yaml's to the repository. Both are read from the working tree, since
 * these files are what CI's test run just wrote and are never committed.
 *
 * A path with a glob in it, `reports/junit/*.xml`, is every file on disk it matches, in name order. A pattern that matches no
 * file is an error naming it, as a path that is not there is when it is read: a run whose reports are missing is not a run that
 * has none.
 */
export async function reportFiles({ root, cwd = process.cwd(), flags = {}, configured = null }) {
  const files = [];
  for (const kind of REPORT_KINDS) {
    const [base, list] = flags[kind] ? [cwd, flags[kind]] : [root, configured?.[kind] ?? []];
    for (const path of list) {
      if (!isPattern(path)) { files.push({ kind, path: resolve(base, path) }); continue; }
      const found = [];
      for await (const match of glob(path, { cwd: base })) {
        const absolute = resolve(base, match);
        if ((await stat(absolute)).isFile()) found.push(absolute);
      }
      if (!found.length) throw new Error(`${path}: no ${REPORT_NAMES[kind]} report matches this pattern in ${base}; CI's test run writes them, and none was there`);
      for (const match of found.sort()) files.push({ kind, path: match });
    }
  }
  return files;
}


/** The phase a pytest-cov context ends in: `tests/test_x.py::test_a|run`. The three phases of one test are one test. */
const CONTEXT_PHASE = /\|(setup|run|teardown)$/;

// One file's measurement from one kind of source: hits by line, arms by line, conditions by line, and the inputs it came from.
// `functions` is calls by a function's start line, where the report says: LCOV's FN and FNDA.
const blank = () => ({ lines: new Map(), arms: new Map(), conditions: new Map(), functions: new Map(), inputs: new Set() });
const fileIn = (store, path, input) => {
  if (!store.has(path)) store.set(path, blank());
  const file = store.get(path);
  file.inputs.add(input);
  return file;
};
const addLines = (file, lines) => { for (const [line, hits] of lines) file.lines.set(line, (file.lines.get(line) ?? 0) + hits); };
const addArm = (file, line, key, taken) => {
  if (!file.arms.has(line)) file.arms.set(line, new Map());
  file.arms.get(line).set(key, (file.arms.get(line).get(key) ?? 0) + taken);
};
// Cobertura and JaCoCo say only how many of a line's conditions were covered, so across shards the larger count stands.
const addConditions = (file, branches) => {
  for (const [line, covered, total] of branches) {
    const was = file.conditions.get(line) ?? { total: 0, taken: 0 };
    file.conditions.set(line, { total: Math.max(was.total, total), taken: Math.max(was.taken, covered) });
  }
};

/**
 * Read every report file into one measurement.
 *
 * Reports of one kind add up: shards of one run each write a part, so line hits are summed over every LCOV file, every Cobertura
 * or JaCoCo file and every coverage.py JSON file, and a branch line keeps each LCOV arm by its block and branch, and each
 * coverage.py arc by where it goes, so two shards taking different arms of one line take both. Cobertura and JaCoCo say only how
 * many of a line's conditions were covered, so across their shards the larger count stands: which conditions two shards took
 * cannot be told apart.
 *
 * Reports of two kinds about one file are one run written twice, since a coverage tool writes LCOV, Cobertura and JSON from the
 * same data, and adding them would count every line twice. Such a file is taken from one kind alone: coverage.py's JSON, whose
 * arcs name each arm, then LCOV, whose arms are numbered, then Cobertura, then JaCoCo. Each input the file was not taken from
 * lists it under `replaced_by` with the reports it was taken from. coverage.py's executed lines are one hit and its missing lines
 * none. That choice is made by `settleReports` once the JaCoCo files are placed, which needs the parsed source.
 *
 * A path a report names that is not a file in the repository is listed as unmatched rather than dropped or guessed at. A file
 * that does not exist, or cannot be read as its kind, is an error naming it.
 */
export async function readReports({ root, files, paths }) {
  const runs = [], perTest = new Map(), inputs = [], unmatchedPaths = [], jacoco = [];
  const seenUnmatched = new Set();
  const where = (reported, report, sources = []) => {
    const path = repoPath(reported, { root, sources, paths });
    if (path === null && !seenUnmatched.has(`${report}\0${reported}`)) { seenUnmatched.add(`${report}\0${reported}`); unmatchedPaths.push({ path: report, reported }); }
    return path;
  };
  // Each kind's own measurement of each file, before one kind is chosen per file.
  const byKind = { contexts: new Map(), lcov: new Map(), cobertura: new Map() };
  // What one test ran: its lines by file, and, where the report says, the sides of branches it took, as `line\0arm`.
  const ranIn = (key, entry, path, lines, arms = []) => {
    if (!perTest.has(key)) perTest.set(key, { ...entry, files: new Map(), arms: new Map() });
    const record = perTest.get(key);
    if (!record.files.has(path)) record.files.set(path, new Set());
    for (const line of lines) record.files.get(path).add(line);
    if (!arms.length) return;
    if (!record.arms.has(path)) record.arms.set(path, new Set());
    for (const arm of arms) record.arms.get(path).add(arm);
  };
  for (const { kind, path } of files) {
    const report = shownPath(root, path);
    let text;
    try { text = await readFile(path, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`${report}: no such ${REPORT_NAMES[kind]} report; CI's test run writes it, and it was not there`, { cause: error });
      throw new Error(`${report}: ${error.message}`, { cause: error });
    }
    const input = { kind, path: report };
    inputs.push(input);
    if (kind === 'junit') {
      const read = readJunit(text, report);
      for (const run of read) runs.push({ ...run, report });
      input.runs = read.length;
    } else if (kind === 'lcov') {
      const read = readLcov(text, report);
      const named = new Set();
      for (const test of read.tests) for (const item of test.files) {
        named.add(item.path);
        const at = where(item.path, report);
        if (at === null) continue;
        const file = fileIn(byKind.lcov, at, input);
        addLines(file, item.lines);
        for (const [line, calls] of item.functions ?? []) file.functions.set(line, (file.functions.get(line) ?? 0) + calls);
        for (const [line, block, branch, taken] of item.branches) addArm(file, line, `${block}\0${branch}`, taken ?? 0);
        // A record under a test name is what that test ran; an unnamed one is the whole run's.
        if (test.name) ranIn(`tn\0${test.name}`, { kind: 'lcov', report, classname: '', name: test.name }, at, item.lines.filter(([, hits]) => hits > 0).map(([line]) => line),
          item.branches.filter(([, , , taken]) => taken > 0).map(([line, block, branch]) => `${line}\0${block}\0${branch}`));
      }
      input.files = named.size;
    } else if (kind === 'cobertura') {
      const read = readCobertura(text, report);
      for (const item of read.files) {
        const at = where(item.path, report, read.sources);
        if (at === null) continue;
        const file = fileIn(byKind.cobertura, at, input);
        addLines(file, item.lines);
        addConditions(file, item.branches);
      }
      input.files = read.files.length;
    } else if (kind === 'jacoco') {
      // Placed by settleReports: which repository file `example/Cart.java` is depends on the package each Java file declares.
      const read = readJacoco(text, report);
      jacoco.push({ input, report, files: read.files });
      input.files = new Set(read.files.map(item => item.path)).size;
    } else if (kind === 'contexts') {
      const read = readCoverageJson(text, report);
      for (const item of read.files) {
        const at = where(item.path, report);
        if (at === null) continue;
        const file = fileIn(byKind.contexts, at, input);
        addLines(file, [...item.executed.map(line => [line, 1]), ...item.missing.map(line => [line, 0])]);
        for (const [from, to, taken] of item.branches ?? []) addArm(file, from, String(to), taken ? 1 : 0);
        for (const [line, contexts] of Object.entries(item.contexts ?? {})) for (const context of contexts) {
          // The empty context is what ran outside any test, at import or collection, which is no one test's doing.
          if (context === '') continue;
          const nodeid = context.replace(CONTEXT_PHASE, '');
          ranIn(`ctx\0${nodeid}`, { kind: 'contexts', report, context: nodeid }, at, [Number(line)]);
        }
      }
      input.files = read.files.length;
    }
  }
  return { root, inputs, runs, kinds: byKind, jacoco, perTest, unmatched_paths: unmatchedPaths, paths };
}

/**
 * The reports' measurement of each file, one kind per file, with the JaCoCo files placed. JaCoCo names a file by its package and its
 * name, `example/Cart.java`, and never says which source root it sits under. The file it means is the Java or Kotlin file that
 * declares that package and has that name, which the parse says; one that no parsed file is, or that several are, is unmatched.
 */
function settleReports(reports, graph) {
  const kinds = { ...reports.kinds, jacoco: new Map() };
  const unmatched = [...reports.unmatched_paths];
  if (reports.jacoco.length) {
    const declared = new Map();
    for (const [path, { file }] of graph.files) {
      if (!jvmLanguages.has(file.language)) continue;
      const name = `${file.package ? `${file.package.split('.').join('/')}/` : ''}${path.split('/').at(-1)}`;
      declared.set(name, [...(declared.get(name) ?? []), path]);
    }
    const seen = new Set();
    for (const { input, report, files } of reports.jacoco) for (const item of files) {
      const found = declared.get(item.path) ?? [];
      if (found.length !== 1) {
        if (!seen.has(`${report}\0${item.path}`)) { seen.add(`${report}\0${item.path}`); unmatched.push({ path: report, reported: item.path }); }
        continue;
      }
      const file = fileIn(kinds.jacoco, found[0], input);
      addLines(file, item.lines);
      addConditions(file, item.branches);
    }
  }
  for (const input of reports.inputs) delete input.replaced_by;
  const measured = new Map(), sourceOf = new Map();
  for (const kind of ['contexts', 'lcov', 'cobertura', 'jacoco']) for (const [path, file] of kinds[kind]) {
    if (!measured.has(path)) { measured.set(path, file); sourceOf.set(path, kind); continue; }
    const supplied = [...measured.get(path).inputs].map(input => input.path);
    for (const input of file.inputs) (input.replaced_by ??= []).push({ path, by: supplied });
  }
  for (const file of measured.values()) {
    file.branches = new Map();
    for (const line of new Set([...file.arms.keys(), ...file.conditions.keys()])) {
      const arms = [...(file.arms.get(line)?.values() ?? [])];
      const conditions = file.conditions.get(line) ?? { total: 0, taken: 0 };
      file.branches.set(line, { total: Math.max(arms.length, conditions.total), taken: Math.max(arms.filter(hits => hits > 0).length, conditions.taken) });
    }
  }
  return { measured, sourceOf, unmatched };
}

/** A context or a test name from a per-test coverage record, as the names a test indexes: pytest-cov's node id, or LCOV's TN. */
const perTestNames = (key, entry) => (entry.kind === 'contexts' ? [`ctx\0${entry.context.replace(/\[.*\]$/s, '')}`] : [key]);

/**
 * A coverage.py context as a classname and a name, for a report that lists it unmatched: pytest's node id is the file then the
 * test after `::`, and unittest's id is dotted, the test being its last part.
 */
const contextParts = context => {
  const at = context.includes('::') ? context.indexOf('::') : context.lastIndexOf('.');
  return at < 0 ? { classname: '', name: context } : { classname: context.slice(0, at), name: context.slice(at + (context.includes('::') ? 2 : 1)) };
};

/** A statuses' worst: an error over a failure over a pass over a skip, so a test is only as good as its worst case. */
const STATUS_ORDER = ['skipped', 'passed', 'failed', 'error'];
const worst = statuses => statuses.reduce((a, b) => (STATUS_ORDER.indexOf(b) > STATUS_ORDER.indexOf(a) ? b : a));

/**
 * The lines that say whether a method ran: those after its first. A declaration's first line runs when the declaration is
 * evaluated, which in Python is at import, so a `def` line is hit for every function in a module a test imported, called or
 * not. A method written on one line has only that line.
 */
const bodyLines = node => (node.end_line > node.line ? { from: node.line + 1, to: node.end_line } : { from: node.line, to: node.line });

/**
 * What the reports say about each test and method: the runs matched to each test, the lines each test ran, and each method's
 * measured lines and branches. A run or a per-test record that names no test perch found, or names more than one, is listed as
 * unmatched with the names it had. No run is matched by a name being like another.
 */
function measure(coverage, graph, reports) {
  const root = reports.root ?? '';
  const context = { root, roots: rootsOf(reports.paths) };
  const { measured, sourceOf, unmatched } = settleReports(reports, graph);
  const index = new Map();
  for (const node of graph.nodes.values()) {
    if (!node.case) continue;
    const file = graph.files.get(node.path)?.file;
    if (!file) continue;
    for (const name of new Set(namesOf(node, file, context))) {
      if (!index.has(name)) index.set(name, new Set());
      index.get(name).add(node.id);
    }
  }
  // A parametrized test's runs carry filled-in titles, so they are found by the test's title pattern, and only when no test
  // has the run's name exactly: an exact name always says more than a pattern that also fits it.
  const templates = [];
  for (const node of graph.nodes.values()) {
    if (!node.case?.parametrized) continue;
    const file = graph.files.get(node.path)?.file;
    if (file) for (const { prefix, pattern } of patternsOf(node, file, context)) templates.push({ prefix, pattern, id: node.id });
  }
  const exactly = names => new Set(names.flatMap(name => [...(index.get(name) ?? [])]));
  const lookup = names => {
    const found = exactly(names);
    if (found.size || !templates.length) return found;
    return new Set(templates.filter(({ prefix, pattern }) => names.some(name => name.startsWith(prefix) && pattern.test(name.slice(prefix.length)))).map(({ id }) => id));
  };
  const unmatchedRuns = [];
  const casesOf = new Map();
  for (const run of reports.runs) {
    let found = lookup(runNames(run, context));
    // A report that says which file a testcase is in narrows it to tests in that file.
    const file = run.file ? repoPath(run.file, { root, sources: [], paths: reports.paths }) : null;
    if (file) found = new Set([...found].filter(id => graph.nodes.get(id).path === file));
    if (found.size !== 1) { unmatchedRuns.push({ path: run.report, classname: run.classname, name: run.name }); continue; }
    const [id] = found;
    casesOf.set(id, [...(casesOf.get(id) ?? []), run]);
  }
  const executedBy = new Map(), armsBy = new Map();
  for (const [key, entry] of reports.perTest) {
    const found = lookup(perTestNames(key, entry));
    if (found.size !== 1) {
      unmatchedRuns.push(entry.kind === 'contexts' ? { path: entry.report, ...contextParts(entry.context) }
        : { path: entry.report, classname: entry.classname, name: entry.name });
      continue;
    }
    const [id] = found;
    if (!executedBy.has(id)) executedBy.set(id, new Map());
    const into = executedBy.get(id);
    for (const [path, lines] of entry.files) {
      if (!into.has(path)) into.set(path, new Set());
      for (const line of lines) into.get(path).add(line);
    }
    if (!armsBy.has(id)) armsBy.set(id, new Map());
    const took = armsBy.get(id);
    for (const [path, arms] of entry.arms) {
      if (!took.has(path)) took.set(path, new Set());
      for (const arm of arms) took.get(path).add(arm);
    }
  }
  // A file measured by a kind of report that said what each test ran is one whose lines can be put down to the tests that ran
  // them; LCOV says which sides of its branches each test took too, and coverage.py's contexts only which lines.
  const perTestKinds = new Set([...reports.perTest.values()].map(entry => entry.kind));
  for (const [path, file] of measured) {
    file.per_test = perTestKinds.has(sourceOf.get(path));
    file.per_test_arms = file.per_test && sourceOf.get(path) === 'lcov';
  }
  // Which methods a set of executed lines ran, by the methods' own lines.
  const methodsByPath = new Map();
  for (const node of graph.nodes.values()) {
    if (node.test) continue;
    methodsByPath.set(node.path, [...(methodsByPath.get(node.path) ?? []), node]);
  }
  const testFile = path => Boolean(graph.files.get(path)?.file.test);
  for (const test of coverage.tests) {
    const cases = casesOf.get(test.id);
    const timed = cases?.filter(run => typeof run.time === 'number') ?? [];
    test.run = cases ? { time: timed.length ? timed.reduce((sum, run) => sum + run.time, 0) : null, status: worst(cases.map(run => run.status)), cases: cases.length } : null;
    const executed = executedBy.get(test.id) ?? null;
    test.executed = executed;
    test.arms = armsBy.get(test.id) ?? null;
    test.executed_methods = executed ? [...executed].flatMap(([path, lines]) => (methodsByPath.get(path) ?? [])
      .filter(node => { const { from, to } = bodyLines(node); return [...lines].some(line => line >= from && line <= to); }).map(node => node.id)).sort() : null;
    // What the test ran of the code under test, which is what two tests are compared on: its own lines are not, since two
    // tests never share those.
    test.executed_key = executed ? JSON.stringify([...executed].filter(([path]) => !testFile(path)).sort(([a], [b]) => a.localeCompare(b))
      .map(([path, lines]) => [path, [...lines].sort((a, b) => a - b)]).filter(([, lines]) => lines.length)) : null;
  }
  for (const method of coverage.methods) {
    const file = measured.get(method.node.path);
    method.measured = null;
    method.untaken = [];
    if (!file) continue;
    const { from, to } = bodyLines(method.node);
    const lines = [...file.lines].filter(([line]) => line >= from && line <= to);
    // A measured file with no line of this method in it has nothing to say about the method: no instrumented line is not zero.
    if (!lines.length) continue;
    const branches = [...file.branches].filter(([line]) => line >= method.node.line && line <= method.node.end_line).sort(([a], [b]) => a - b);
    // A function the report says was never called never ran, though the statement declaring it did: `exports.f = function` runs
    // when the module loads, so its first line counts a hit.
    const called = file.functions?.get(method.node.line);
    method.measured = {
      lines: { hit: called === 0 ? 0 : lines.filter(([, hits]) => hits > 0).length, total: lines.length },
      branches: { hit: branches.reduce((sum, [, branch]) => sum + branch.taken, 0), total: branches.reduce((sum, [, branch]) => sum + branch.total, 0) },
    };
    method.untaken = branches.filter(([, branch]) => branch.taken < branch.total).map(([line]) => line);
  }
  const suiteRuns = reports.runs;
  const suite = reports.inputs.some(input => input.kind === 'junit') ? {
    seconds: suiteRuns.reduce((sum, run) => sum + (typeof run.time === 'number' ? run.time : 0), 0), runs: suiteRuns.length,
    failed: suiteRuns.filter(run => run.status === 'failed' || run.status === 'error').length, skipped: suiteRuns.filter(run => run.status === 'skipped').length,
  } : null;
  // Which kinds of report the measured lines came from, for a page that says what measured them.
  const tools = [...new Set(sourceOf.values())].sort();
  return { inputs: reports.inputs, tools, unmatched_runs: unmatchedRuns, unmatched_paths: unmatched, suite, files: measured };
}

/**
 * Build a state no larger than `budget`: neighbours' excerpts shortened first, then fewer neighbours, never the unit's own source.
 * A unit read in part would be asked which branch no test takes while some of its branches were out of view.
 */
function fitState(build, budget, what) {
  for (const limit of [80, 40, 20, 8, 3]) { const state = build(limit, MAX_SHOWN); if (estimateTokens(state) <= budget) return state; }
  for (const fewer of [4, 2, 1, 0]) { const state = build(3, fewer); if (estimateTokens(state) <= budget) return state; }
  throw new IncompleteCheckError(`${what} does not fit the ${budget}-token budget even with nothing around it`);
}

/** Every declared question answered, read into what is kept. A missing answer is an error, not a default. */
function readAll(questions, answers) {
  const read = {};
  for (const question of questions) {
    if (!answers?.[question.name]) throw new Error(`System One gave no answer for ${question.name}`);
    read[question.name] = readAnswer(question, answers[question.name]);
  }
  return read;
}

/**
 * Which answered tests are worth keeping. A test checks nothing when the answer says no change to the code under test would make
 * it fail, at the floor or over it. Among the tests left, two that were said to decide the same behavior are one test written twice when
 * they run the same code: measured, when the coverage report says which lines each test ran and both ran exactly the same lines
 * of the code under test; otherwise, when either has no such record, when they call exactly the same methods. The first by
 * path and line is kept.
 */
export function judgeTests(tests, answered, min, repeats = null) {
  const clean = [], checksNothing = new Set(), redundantWith = new Map(), pairProbability = new Map(), redundantBasis = new Map();
  for (const test of tests) {
    const answers = answered.get(test.id)?.answers;
    if (!answers) continue;
    // That no change to the code under test would make it fail is judged at the floor like any other answer: under it, the
    // test is not held to have checked nothing.
    if (answers.decides.choice === 'nothing' && (answers.decides.probabilities.nothing ?? 0) >= min) { checksNothing.add(test.id); continue; }
    clean.push(test);
  }
  const decided = test => answered.get(test.id).answers.decides.choice;
  // Two tests that ran none of the code under test did not run the same code; they ran none. Only a nonempty record counts.
  const ranSomething = test => test.executed_key !== '[]';
  // The same code is the same lines run when both tests have a record of what ran, and otherwise the same direct calls. The
  // first kept test with the same behavior and the same code is looked up by key: scanning every kept test for each one was
  // quadratic, and 167,000 tests took longer than asking about all of them.
  const directKey = test => (test.direct.length ? JSON.stringify(test.direct) : null);
  const byRun = new Map(), byCalls = new Map(), byCallsUnmeasured = new Map();
  const remember = (index, key, test) => { if (key !== null && !index.has(key)) index.set(key, test); };
  const kept = [], order = new Map();
  for (const test of [...clean].sort((a, b) => a.node.path.localeCompare(b.node.path) || a.node.line - b.node.line)) {
    const behavior = decided(test), calls = directKey(test);
    // A test whose likeliest answer is that it decides nothing, below the floor, has no behavior to compare, so it repeats none.
    const candidates = behavior === 'nothing' ? []
      : test.executed_key
        ? [[ranSomething(test) ? byRun.get(`${behavior}\0${test.executed_key}`) : null, 'measured'], [calls === null ? null : byCallsUnmeasured.get(`${behavior}\0${calls}`), 'static']]
        : [[calls === null ? null : byCalls.get(`${behavior}\0${calls}`), 'static']];
    const [first, basis] = candidates.filter(([other]) => other).sort(([a], [b]) => order.get(a) - order.get(b))[0] ?? [null, null];
    if (!first) {
      order.set(test, kept.length);
      kept.push(test);
      if (test.executed_key && ranSomething(test)) remember(byRun, `${behavior}\0${test.executed_key}`, test);
      if (calls !== null) remember(byCalls, `${behavior}\0${calls}`, test);
      if (calls !== null && !test.executed_key) remember(byCallsUnmeasured, `${behavior}\0${calls}`, test);
      continue;
    }
    // The call graph finds the pair; whether the test checks a case the first does not is the answer's to say. Two tests calling
    // one function with different input are two cases, and listing one as a duplicate told people to delete a real test.
    const said = repeats?.get(test.id)?.answers.repeats;
    if (said !== undefined && said < min) { order.set(test, kept.length); kept.push(test); continue; }
    redundantWith.set(test.id, first.id);
    redundantBasis.set(test.id, basis);
    pairProbability.set(test.id, said ?? null);
  }
  const useful = new Set(clean.filter(test => !redundantWith.has(test.id)).map(test => test.id));
  return { useful, checksNothing, redundantWith, pairProbability, redundantBasis };
}

/**
 * Ask System One about every test, then about every method a useful test reaches that has branches. Tests go first because which
 * tests are useful, and what each decides, is what a method is asked over.
 *
 * Every unit is asked on every run: the endpoint caches answers, perch does not. A unit that fails is recorded in `failed` with
 * its error and carries no answers; an authentication failure stops the run, since every other request would get the same
 * refusal.
 */
export async function askCoverage({ coverage, graph, linesOf, systemOne, min = 0.5, parallel = DEFAULT_PARALLEL,
  testProgress = () => {}, methodProgress = () => {}, log = () => {}, debug = () => {} }) {
  const { test: testAsked, method: allMethodQuestions } = coverageQuestions();
  const methodAsked = allMethodQuestions.filter(question => question.name !== NEEDS_TEST);
  const needsAsked = allMethodQuestions.filter(question => question.name === NEEDS_TEST);
  const initial = systemOne.limits?.state ?? TOKEN_LIMITS.state;
  const tests = new Map(), methods = new Map(), needs = new Map(), repeats = new Map(), failed = [...coverage.failed];
  let asked = 0, failures = 0;

  /** One unit, asked at the full budget and again at smaller ones when its state is too large. */
  const answer = async ({ subject, node, build, typed, questions, check = () => {} }) => {
    const first = build(initial);
    const response = await withTokenRetries(async budget => {
      const state = budget === initial ? first : build(budget);
      debug(`asking ${systemOne.id} about ${subject} ${node.qualified_name} in ${node.path}:${node.line}`);
      return systemOne.ask(state, typed(state));
    }, initial);
    const answers = readAll(questions, response.answers);
    check(answers);
    asked++;
    return { subject, unit: node.id, path: node.path, name: node.qualified_name, model: response.model ?? systemOne.id, at: new Date().toISOString(), answers };
  };

  const settle = async (units, one, into, progress) => {
    let done = 0;
    progress(0, units.length);
    // A rolling pool: each of `parallel` workers takes the next unit as soon as its last one is answered. Batches waited on the
    // slowest request in each, so one retried question held the other 31 slots empty.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(parallel, units.length) }, async () => {
      while (next < units.length) {
        const unit = units[next++];
        try {
          into.set(unit.id, await one(unit));
        } catch (error) {
          if (error instanceof AuthenticationError) throw error;
          failures++;
          log(`${unit.node.qualified_name} in ${unit.node.path}: ${error.message}`);
          failed.push({ unit: unit.id, subject: unit.node.case ? 'test' : 'method', path: unit.node.path, name: unit.node.qualified_name, error: error.message });
        } finally { progress(++done, units.length); }
      }
    }));
  };

  const neighbourSource = async ({ id }) => { const node = graph.nodes.get(id); return { node, lines: await linesOf(node) }; };

  await settle(coverage.tests, async test => {
    const { node } = test;
    const lines = await linesOf(node);
    const reached = await Promise.all(test.reach.slice(0, MAX_SHOWN).map(async item => ({ ...item, ...(await neighbourSource(item)) })));
    const helpers = await Promise.all((test.helpers ?? []).slice(0, MAX_SHOWN).map(id => neighbourSource({ id })));
    const mocks = test.mocks.map(describeMock), source = sourceOf(node, lines);
    // The network and database calls in reach, where they are, and the methods making them in view: whether one is made is a
    // matter of the branch around it, which the method's source shows and a list of kinds does not.
    const leaks = test.evidence.filter(item => LEAKS.has(item.category));
    const reachable_io = leaks.slice(0, MAX_SHOWN).map(item => `${item.name} at ${item.path}:${item.line}`);
    const shownIds = new Set(reached.slice(0, MAX_SHOWN).map(item => item.id));
    const holders = await Promise.all([...new Set(leaks.map(item => item.from))].filter(id => id !== node.id && !shownIds.has(id) && graph.nodes.get(id) && !graph.nodes.get(id).test)
      .slice(0, MAX_SHOWN / 2).map(id => neighbourSource({ id }).then(item => ({ id, ...item }))));
    // A macro the test calls is no method, so the call graph does not reach it, and an EXPECT_EQ or an assert! inside one is the
    // check the test makes. One defined in the test's file, or in a file it includes, is shown with it.
    const macros = [];
    if (MACRO_LANGUAGES.has(graph.files.get(node.path)?.file.language)) {
      const testFile = graph.files.get(node.path).file;
      const included = (testFile.imports ?? []).map(item => resolveModule(node.path, item.module, testFile.language, new Set(graph.files.keys()))).filter(Boolean);
      const names = [...new Set(graph.external(node.id).map(call => String(call.name).replace(/!$/, '')).filter(name => /^\w+$/.test(name)))];
      for (const path of [node.path, ...included]) {
        const fileLines = await linesOf({ path });
        for (const name of names) {
          if (macros.some(item => item.name === name)) continue;
          const found = macroIn(fileLines, name);
          if (found) macros.push({ name, id: `${path}::${name}`, path, source: found.text });
        }
      }
    }
    // The test, then the code it reaches and the helpers it calls through as the nodes of its call graph, nearest first, as a
    // scan shows a method.
    const build = budget => fitState((limit, shown) => {
      const nodes = [
        ...macros.slice(0, shown).map(item => ({ id: item.id, path: item.path, source: item.source.split('\n').slice(0, limit).join('\n'), note: MACRO })),
        ...helpers.slice(0, shown).map(item => ({ id: item.node.id, path: item.node.path, source: excerpt(item.node, item.lines, limit), note: HELPER }) ),
        ...reached.slice(0, shown).map(item => ({ id: item.id, path: item.node.path, source: excerpt(item.node, item.lines, limit) })),
        ...holders.slice(0, Math.ceil(shown / 2)).map(item => ({ id: item.id, path: item.node.path, source: excerpt(item.node, item.lines, limit) })),
      ];
      return {
        test: { path: node.path, name: node.qualified_name, framework: node.case.framework, source, mocks, reachable_io },
        graph: { nodes, edges: edgesAmong(graph, [node.id, ...nodes.map(item => item.id)]) },
      };
    }, budget, `test ${node.qualified_name}`);
    // A test the JUnit report timed is not asked what it costs: the report says, in seconds. Whether it tests anything here is
    // asked only of a test the call graph found calling nothing in the repository, and whether it calls a live service only of
    // one that can reach a network or database call.
    const skip = new Set(['repeats', ...(typeof test.run?.time === 'number' ? ['cost'] : []), ...(test.unresolved ? [] : ['tests_nothing_here']),
      ...(leaks.length ? [] : ['infra'])]);
    const questions = testAsked.filter(question => !skip.has(question.name));
    return answer({ subject: 'test', node, build, typed: () => compile(questions), questions });
  }, tests, testProgress);

  // A test the call graph pairs with an earlier one is asked, with both in view, whether it checks a case the earlier one does not.
  const candidates = judgeTests(coverage.tests, tests, min);
  const testById = new Map(coverage.tests.map(test => [test.id, test]));
  const repeatsAsked = testAsked.filter(question => question.name === 'repeats');
  await settle([...candidates.redundantWith.keys()].map(id => testById.get(id)), async test => {
    const earlier = testById.get(candidates.redundantWith.get(test.id)).node, { node } = test;
    const [lines, earlierLines] = [await linesOf(node), await linesOf(earlier)];
    const build = budget => fitState(() => ({
      test: { path: node.path, name: node.qualified_name, source: sourceOf(node, lines) },
      graph: { nodes: [{ id: earlier.id, path: earlier.path, source: sourceOf(earlier, earlierLines), note: EARLIER }], edges: [] },
    }), budget, `test ${node.qualified_name}`);
    return answer({ subject: 'test', node, build, typed: () => compile(repeatsAsked), questions: repeatsAsked });
  }, repeats, testProgress);
  const { useful } = judgeTests(coverage.tests, tests, min, repeats);
  // A measured method is asked only which untaken branch matters, and only when it ran and the report shows a branch line with a
  // side no test took: what share of its branches the tests take is what the report measured. An unmeasured one is asked as
  // before, when it has branches and a useful test reaches it.
  const worthAsking = coverage.methods.filter(method => (method.measured ? method.measured.lines.hit > 0 && method.untaken.length > 0
    : method.branches.length && method.tests.some(item => useful.has(item.id))));
  const gapAsked = methodAsked.filter(question => question.name !== 'exercised');
  await settle(worthAsking, async method => {
    const { node, branches, measured } = method;
    const lines = await linesOf(node);
    const reaching = await Promise.all(method.tests.filter(item => useful.has(item.id)).slice(0, MAX_SHOWN).map(async item => ({ ...item, ...(await neighbourSource(item)) })));
    const offered = measured ? method.untaken : branches;
    const typed = methodQuestions(node, offered, lines);
    if (measured) delete typed.exercised;
    // Branch lines by their text: the same branch reads the same wherever the method has moved to.
    const named = offered.map(line => (lines[line - 1] ?? '').trim());
    const build = budget => fitState((limit, shown) => {
      const nodes = reaching.slice(0, shown).map(item => ({ id: item.id, path: item.node.path, source: excerpt(item.node, item.lines, limit) }));
      return {
        method: { path: node.path, name: node.qualified_name, source: sourceOf(node, lines), ...(measured ? { untaken_branches: named } : { branches: named }) },
        graph: { nodes, edges: edgesAmong(graph, [node.id, ...nodes.map(item => item.id)]) },
      };
    }, budget, `method ${node.qualified_name}`);
    // A line the method was not offered is not a line of this method, and reading it as one would put a finding somewhere else.
    const check = answers => { if (!Object.hasOwn(typed.gap_line.criteria, answers.gap_line.choice)) throw new Error(`gap_line picked ${answers.gap_line.choice}, which was not offered`); };
    return answer({ subject: 'method', node, build, typed: () => typed, questions: measured ? gapAsked : methodAsked, check });
  }, methods, methodProgress);

  // A method no test runs is asked whether it needs one, with how perch knows no test runs it.
  const untested = coverage.methods.filter(isUntested);
  await settle(untested, async method => {
    const { node } = method;
    const lines = await linesOf(node);
    const how = method.measured ? 'The coverage report shows none of its lines ran.' : `No test reaches it within ${coverage.depth} calls.`;
    const build = budget => fitState(() => ({
      method: { path: node.path, name: node.qualified_name, source: sourceOf(node, lines), note: how }, graph: { nodes: [], edges: [] },
    }), budget, `method ${node.qualified_name}`);
    return answer({ subject: 'method', node, build, typed: () => compile(needsAsked), questions: needsAsked });
  }, needs, methodProgress);

  // Every request failed and none answered, which is an outage or a refusal, not a repository with nothing to say.
  if (failures && !asked) throw new Error(`nothing could be asked: ${failures} failed; last error: ${failed.at(-1).error}`);
  return { tests, methods, needs, repeats, failed, asked };
}

/** The level of a score most of its mass sits on. */
const likeliest = probabilities => {
  const top = Object.entries(probabilities ?? {}).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];
  return top ? Number(top[0]) : null;
};
/** The case no test covers, named: the method in the situation the missing test would put it in. One per gap_kind option. */
const GAP_CASES = {
  boundary: method => `Untested case: ${method} at the edge of its range.`,
  empty_or_absent_input: method => `Untested case: ${method} with empty, missing or zero input.`,
  error_path: method => `Untested case: ${method} failing.`,
  invalid_input: method => `Untested case: ${method} with invalid input.`,
  state_after_call: method => `Untested case: ${method} from the state that takes this branch.`,
  ordering: method => `Untested case: ${method} with input in another order.`,
};
/** What an infra category is, as a person says it. */
/** A score's expected level, as a share of its top level: 0 for the first level, 1 for the last. */
const expectedShare = (score, levels) => (levels > 1 ? Object.entries(score.probabilities).reduce((total, [level, p]) => total + p * Number(level) / (levels - 1), 0) : null);
const mean = values => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : null);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const findingIdOf = (kind, unit) => identity('coverage', kind, unit).slice(0, 8);

/**
 * The report every view of a run reads: the terminal tables, the HTML page and the diff against the next run. Everything in it is
 * counted from the coverage, the answers and the lines it is given; nothing is looked up again.
 */
export function buildReport({ coverage, answers, lines, revision, root, label = root, github = null, createdAt = new Date().toISOString(), model = null, min = 0.5, usage = {}, closed = new Map() }) {
  const { test: testAsked } = coverageQuestions();
  const costLevels = testAsked.find(question => question.name === 'cost').levels.length;
  const exercisedLevels = questionNamed('exercised').levels.length;
  const judged = judgeTests(coverage.tests, answers.tests, min, answers.repeats);
  const failedUnits = new Set(answers.failed.map(item => item.unit));
  const anything = answers.tests.size + answers.methods.size > 0 || coverage.methods.some(method => method.measured);
  const findings = [];
  const listed = finding => finding.probability === null || finding.probability >= min;
  // A problem someone closed with `perch close` stays closed: it is kept apart, so perch reopen can find it, and listed nowhere.
  const isClosed = (kind, unit) => closed.get(findingIdOf(kind, unit))?.kinds.has(kind) ?? false;
  const closedFindings = [];
  const add = finding => {
    const full = { id: findingIdOf(finding.kind, finding.unit), ...finding };
    if (!listed(full)) return null;
    if (isClosed(full.kind, full.unit)) { closedFindings.push({ ...full, reason: closed.get(full.id).reason }); return null; }
    findings.push(full);
    return full.id;
  };
  const tiers = () => Object.fromEntries(Array.from({ length: costLevels }, (_, level) => [level, 0]));
  const measurement = coverage.measurement;
  // The tests that could go: checking nothing, or repeating another. One whose problem was closed is one someone chose to keep,
  // and one that could not be asked about is not said to check nothing.
  const dropped = new Set(coverage.tests.filter(test => (judged.checksNothing.has(test.id) && !isClosed('checks_nothing', test.id)) || (judged.redundantWith.has(test.id) && !isClosed('redundant', test.id))).map(test => test.id));
  // What the tests kept ran and what the dropped tests ran, file by file, from the reports' per-test records.
  const kept = { lines: new Map(), arms: new Map() }, gone = { lines: new Map(), arms: new Map() };
  const gather = (into, files) => {
    for (const [path, items] of files ?? []) {
      if (!into.has(path)) into.set(path, new Set());
      for (const item of items) into.get(path).add(item);
    }
  };
  for (const test of coverage.tests) {
    const into = dropped.has(test.id) ? gone : kept;
    gather(into.lines, test.executed);
    gather(into.arms, test.arms);
  }
  // Ran only by tests that could go: a dropped test ran it and no kept test did. What ran outside any test, or under a run
  // perch could not match, is no dropped test's doing and stays.
  const onlyDropped = (part, path) => {
    const theirs = gone[part].get(path), ours = kept[part].get(path);
    return item => Boolean(theirs?.has(item)) && !ours?.has(item);
  };
  /**
   * A measured method's lines and branches, less what only duplicate tests and tests that check nothing ran. Where the report says what each test
   * ran, that is the lines and branch sides only dropped tests ran, and is measured; coverage.py's contexts say lines but not
   * sides, so a side goes when only dropped tests ran its line, an estimate. Without per-test records it is estimated from the
   * call graph: none of the method counts when every test reaching it is dropped, and all of it otherwise.
   */
  const effectiveOf = method => {
    const { measured, node } = method;
    if (!measured) return null;
    const file = measurement.files.get(node.path);
    if (!file.per_test) {
      const lost = method.tests.length > 0 && method.tests.every(item => dropped.has(item.id));
      return { lines: { hit: lost ? 0 : measured.lines.hit, total: measured.lines.total, basis: 'estimated' },
        branches: { hit: lost ? 0 : measured.branches.hit, total: measured.branches.total, basis: 'estimated' } };
    }
    const lineGone = onlyDropped('lines', node.path);
    const { from, to } = bodyLines(node);
    const lines = measured.lines.hit === 0 ? 0 : [...file.lines].filter(([line, hits]) => line >= from && line <= to && hits > 0 && !lineGone(line)).length;
    const branchLines = [...file.branches.keys()].filter(line => line >= node.line && line <= node.end_line);
    let branches;
    if (file.per_test_arms) {
      const armGone = onlyDropped('arms', node.path);
      branches = branchLines.reduce((sum, line) => sum + [...(file.arms.get(line) ?? [])].filter(([arm, taken]) => taken > 0 && !armGone(`${line}\0${arm}`)).length, 0);
    } else branches = branchLines.reduce((sum, line) => sum + (lineGone(line) ? 0 : file.branches.get(line).taken), 0);
    return { lines: { hit: lines, total: measured.lines.total, basis: 'measured' },
      branches: { hit: branches, total: measured.branches.total, basis: file.per_test_arms || !measured.branches.total ? 'measured' : 'estimated' } };
  };

  const methods = coverage.methods.map(method => {
    const { node } = method;
    const usefulTests = method.tests.filter(item => judged.useful.has(item.id)).map(item => item.id);
    const said = answers.methods.get(method.id)?.answers;
    const measured = method.measured ?? null;
    const executed = measured ? measured.lines.hit > 0 : null;
    // A measured method's share is the report's: the branches taken of those it counted, or, with none, whether it ran at all.
    // Otherwise it is an answer when it was asked, and follows from the answers about its tests when it was not: none of them
    // useful is none of it exercised, and a useful test reaching a method with no branches takes the only path there is. No
    // test reaching it at all is a fact of the graph. When the answer that would decide it failed, it is unknown, not zero and
    // not whole.
    let exercised, basis;
    if (measured) [exercised, basis] = [measured.branches.total ? measured.branches.hit / measured.branches.total : executed ? 1 : 0, 'measured'];
    else if (said?.exercised) [exercised, basis] = [expectedShare(said.exercised, exercisedLevels), 'estimated'];
    else if (!method.tests.length) [exercised, basis] = [0, 'static'];
    else if (!usefulTests.length) [exercised, basis] = method.tests.some(item => failedUnits.has(item.id)) ? [null, null] : [0, 'estimated'];
    else [exercised, basis] = !method.branches.length ? [1, 'estimated'] : [null, null];
    const gapLine = said ? branchLine(node, said.gap_line.choice) : null;
    const gap = gapLine === null ? null : { line: gapLine, text: (lines.get(node.path)?.[gapLine - 1] ?? '').trim(), kind: said.gap_kind.choice, probability: said.gap_line.probability };
    // Measured, a method is untested when none of its lines ran, whatever the call graph says reaches it; and one the call graph
    // misses is tested when the report shows it ran. Unmeasured, it is untested when no test reaches it.
    const untested = isUntested(method);
    const own = [];
    // That no test runs it is the report's or the call graph's; whether that is a problem is Jev's. An unasked one stays listed.
    const needsTest = answers.needs?.get(method.id)?.answers.needs_test ?? null;
    if (untested) own.push(add({ kind: 'untested', subject: 'method', unit: method.id, path: node.path, line: node.line, name: node.qualified_name, probability: needsTest,
      note: measured ? `None of its lines ran.${method.tests.length ? ` ${plural(method.tests.length, 'test')} ${method.tests.length === 1 ? 'calls' : 'call'} it.` : ''}`
        : `No test reaches it within ${plural(coverage.depth, 'call')}.` }));
    if (gap) own.push(add({ kind: 'edge_case', subject: 'method', unit: method.id, path: node.path, line: gap.line, name: node.qualified_name, probability: gap.probability,
      note: GAP_CASES[gap.kind]?.(node.name ?? node.qualified_name) ?? `Untested case: the other side of line ${gap.line}.` }));
    return { id: method.id, path: node.path, name: node.qualified_name, line: node.line, end_line: node.end_line, risk: node.metrics?.risk_score ?? null,
      branches: method.branches, tests: method.tests, useful: usefulTests, exercised, exercised_basis: basis, measured, effective: effectiveOf(method), executed,
      untaken: measured ? method.untaken : null, untested, gap, findings: own.filter(Boolean) };
  });
  const testById = new Map(coverage.tests.map(test => [test.id, test]));

  const tests = coverage.tests.map(test => {
    const { node } = test;
    const said = answers.tests.get(test.id)?.answers ?? null;
    const own = [];
    const keptId = judged.redundantWith.get(test.id) ?? null;
    const redundantBasis = keptId ? judged.redundantBasis.get(test.id) : null;
    if (keptId) {
      const kept = testById.get(keptId).node;
      const like = `${kept.qualified_name}${kept.path === node.path ? '' : ` in ${kept.path}`} at line ${kept.line}`;
      own.push(add({ kind: 'redundant', subject: 'test', unit: test.id, path: node.path, line: node.line, name: node.qualified_name, probability: judged.pairProbability.get(test.id),
        note: `Same checks and ${redundantBasis === 'measured' ? 'lines' : 'calls'} as ${like}.` }));
    }
    if (judged.checksNothing.has(test.id)) own.push(add({ kind: 'checks_nothing', subject: 'test', unit: test.id, path: node.path, line: node.line, name: node.qualified_name,
      probability: said.decides.probabilities.nothing, note: 'Passes whatever the code it calls does.' }));
    const leaks = test.evidence.filter(item => LEAKS.has(item.category));
    const shown = leaks.slice(0, 3).map(item => `${item.name} at ${item.path}:${item.line}`).join(', ');
    // The call graph finds the network and database calls a test can reach; the answer decides whether it makes one to a live
    // service. A test that could not be asked keeps what the call graph found, with no probability, and is listed under failures.
    if (leaks.length) own.push(add({ kind: 'infra', subject: 'test', unit: test.id, path: node.path, line: node.line, name: node.qualified_name,
      probability: said?.infra ?? null, note: `Calls a live service with nothing mocked: ${shown}.` }));
    if (test.unresolved) own.push(add({ kind: 'unresolved', subject: 'test', unit: test.id, path: node.path, line: node.line, name: node.qualified_name, probability: said ? said.tests_nothing_here : null,
      note: `Calls nothing in this repository${test.unresolved.length ? `: ${test.unresolved.slice(0, 6).join(', ')}` : ''}.` }));
    const run = test.run ?? null;
    // A timed test's cost is the report's seconds; an untimed one's is the tier Jev put it in.
    const cost = typeof run?.time === 'number' ? { seconds: run.time, basis: 'measured' }
      : said?.cost && likeliest(said.cost.probabilities) !== null ? { tier: likeliest(said.cost.probabilities), probabilities: said.cost.probabilities, basis: 'estimated' } : null;
    return { id: test.id, path: node.path, name: node.case.name, suite: node.case.suite, line: node.line, end_line: node.end_line, framework: node.case.framework,
      direct: test.direct, reach: test.reach, cuts: test.cuts, touches: test.touches, unresolved: test.unresolved ?? null,
      decides: said ? { choice: said.decides.choice, probability: said.decides.probability } : null,
      infra: said?.infra ?? null, cost, run, executed_methods: test.executed_methods ?? null,
      useful: judged.useful.has(test.id), redundant_with: keptId, redundant_basis: redundantBasis, findings: own.filter(Boolean) };
  });

  // Counted from an index of each kind's units: scanning every finding once per file was quadratic in a large repository.
  const unitsOf = new Map();
  for (const finding of findings) {
    if (!unitsOf.has(finding.kind)) unitsOf.set(finding.kind, new Map());
    const units = unitsOf.get(finding.kind);
    units.set(finding.unit, (units.get(finding.unit) ?? 0) + 1);
  }
  const count = (list, kind) => {
    const units = unitsOf.get(kind);
    let total = 0;
    if (units) for (const unit of list) total += units.get(unit) ?? 0;
    return total;
  };
  const share = list => (anything ? mean(list.map(method => method.exercised).filter(value => value !== null)) : null);
  // Whether a share is the report's, an estimate, or a fact of the graph: estimated when any part of it is.
  const basisOf = list => {
    const bases = new Set(list.filter(method => method.exercised !== null).map(method => method.exercised_basis));
    return bases.has('estimated') ? 'estimated' : bases.has('measured') ? 'measured' : bases.has('static') ? 'static' : null;
  };
  const measuredOf = list => {
    const counted = list.filter(method => method.measured);
    if (!counted.length) return null;
    const sum = (part, key) => counted.reduce((total, method) => total + method.measured[part][key], 0);
    return { lines: { hit: sum('lines', 'hit'), total: sum('lines', 'total') }, branches: { hit: sum('branches', 'hit'), total: sum('branches', 'total') } };
  };
  // Summed like the measured figures, and estimated when any method's part of it is.
  const effectiveOfAll = list => {
    const counted = list.filter(method => method.effective);
    if (!counted.length) return null;
    const part = name => ({ hit: counted.reduce((total, method) => total + method.effective[name].hit, 0), total: counted.reduce((total, method) => total + method.effective[name].total, 0),
      basis: counted.some(method => method.effective[name].total && method.effective[name].basis === 'estimated') ? 'estimated' : 'measured' });
    return { lines: part('lines'), branches: part('branches') };
  };
  const timeOf = list => {
    const timed = list.filter(test => typeof test.run?.time === 'number');
    return { seconds: timed.length ? timed.reduce((total, test) => total + test.run.time, 0) : null, timed: timed.length };
  };
  const totalsOf = (methodList, testList) => {
    const testIds = new Set(testList.map(test => test.id));
    // Reached is what ran when the coverage report measured the method, and what the call graph reaches when it did not: the same
    // rule untested follows, so the two columns never disagree about one method.
    return { methods: methodList.length, reached: methodList.filter(method => !method.untested).length, useful_reached: methodList.filter(method => method.useful.length).length,
      exercised: share(methodList), exercised_basis: basisOf(methodList), measured: measuredOf(methodList), effective: effectiveOfAll(methodList), tests: testList.length, useful: testList.filter(test => test.useful).length,
      redundant: testList.filter(test => test.redundant_with).length, weak: testList.filter(test => judged.checksNothing.has(test.id)).length, infra: count(testIds, 'infra'),
      ...timeOf(testList), dropped_seconds: timeOf(testList.filter(test => dropped.has(test.id))).seconds ?? 0 };
  };
  const methodsIn = Map.groupBy(methods, method => method.path), testsIn = Map.groupBy(tests, test => test.path);
  const files = coverage.files.map(file => {
    const own = methodsIn.get(file.path) ?? [], ownTests = testsIn.get(file.path) ?? [];
    return { path: file.path, kind: file.test ? 'test' : 'source', language: file.language, lines: lines.get(file.path) ?? [],
      hits: hitsOf(measurement?.files?.get(file.path)),
      methods: own.map(method => method.id), tests: ownTests.map(test => test.id), totals: totalsOf(own, ownTests) };
  });
  const cost = tiers(), drop = { count: 0, cost: tiers() };
  // What dropping them would cost in reach: the methods only dropped tests reach. Counted, since "nothing" is a claim.
  const droppedTests = tests.filter(test => dropped.has(test.id));
  for (const test of tests) {
    if (test.cost?.basis !== 'estimated') continue;
    cost[test.cost.tier]++;
    if (dropped.has(test.id)) drop.cost[test.cost.tier]++;
  }
  drop.count = droppedTests.length;
  const droppedTime = timeOf(droppedTests);
  drop.seconds = droppedTime.seconds;
  drop.timed = droppedTime.timed;
  drop.unreached = methods.filter(method => method.tests.length && method.tests.every(item => dropped.has(item.id))).map(method => method.id);
  const methodIds = new Set(methods.map(method => method.id));
  const totals = { ...totalsOf(methods, tests), unresolved: count(new Set(tests.map(test => test.id)), 'unresolved'),
    untested: methods.filter(method => method.untested).length, edge_cases: count(methodIds, 'edge_case'), cost, drop, suite: measurement?.suite ?? null };
  return { version: 1, revision, root, target: label, github, created_at: createdAt, model, depth: coverage.depth, min,
    inputs: measurement?.inputs ?? [], measured_by: measurement?.tools ?? [], unmatched_runs: measurement?.unmatched_runs ?? [], unmatched_paths: measurement?.unmatched_paths ?? [],
    totals, files, methods, tests, findings, failed: answers.failed, closed: closedFindings, baseline: null, diff: null, usage };
}

/**
 * What a branch did, from the report and the lines it changed since its merge base: patch coverage, the share of the changed source
 * lines the coverage report counts that ran, per file and in all, and the methods and tests whose lines the branch touched with the
 * problems on them. `sources` is every source file the run read, test files left out since a test's own lines run by being the
 * test, each with the coverage report's hits for it or null; a file with no methods, such as a script, counts as much as any. A
 * changed source file no coverage report covers has no patch figure rather than a zero. Nothing here asks anything.
 */
export function branchOf(report, { ref, base, files: changed }, sources) {
  const touched = unit => (changed.get(unit.path) ?? []).some(line => line >= unit.line && line <= unit.end_line);
  const units = [...report.methods, ...report.tests].filter(touched).map(unit => unit.id).sort();
  const changedUnits = new Set(units);
  const files = [...changed].filter(([path, lines]) => lines.length && sources.has(path)).sort(([a], [b]) => a.localeCompare(b)).map(([path, lines]) => {
    const hits = sources.get(path);
    if (!hits) return { path, changed: lines.length, patch: null };
    // A line the coverage report counts is one that could have run; the rest (blank lines, comments, braces) are not code to cover.
    const counted = new Map(hits.lines);
    const code = lines.filter(line => counted.has(line));
    const missed = code.filter(line => counted.get(line) === 0);
    return { path, changed: lines.length, patch: { hit: code.length - missed.length, total: code.length }, missed };
  });
  const measured = files.filter(file => file.patch);
  const patch = measured.length ? { hit: measured.reduce((sum, file) => sum + file.patch.hit, 0), total: measured.reduce((sum, file) => sum + file.patch.total, 0) } : null;
  return { ref, base, files, patch, units, findings: report.findings.filter(finding => changedUnits.has(finding.unit)).map(finding => finding.id) };
}

/** A file's measured lines and branch lines, line by line, for a page that marks each one: `[line, hits]` and `[line, taken, total]`. */
const hitsOf = file => (file ? { lines: [...file.lines].sort(([a], [b]) => a - b),
  branches: [...file.branches].sort(([a], [b]) => a - b).map(([line, branch]) => [line, branch.taken, branch.total]) } : null);

const DIFF_TOTALS = ['methods', 'reached', 'exercised', 'tests', 'useful', 'redundant', 'weak', 'infra', 'untested', 'edge_cases', 'unresolved'];
/** The measured totals a diff compares, as shares and seconds, read off a report's totals. */
const MEASURED_TOTALS = {
  measured_lines: totals => (totals.measured?.lines.total ? totals.measured.lines.hit / totals.measured.lines.total : null),
  measured_branches: totals => (totals.measured?.branches.total ? totals.measured.branches.hit / totals.measured.branches.total : null),
  effective_lines: totals => (totals.effective?.lines.total ? totals.effective.lines.hit / totals.effective.lines.total : null),
  effective_branches: totals => (totals.effective?.branches.total ? totals.effective.branches.hit / totals.effective.branches.total : null),
  suite_seconds: totals => totals.suite?.seconds ?? null,
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/**
 * What changed between two saved reports, unit by unit. Methods, tests, files and findings are matched by id, so a method whose
 * share went down while another's went up is two changes rather than a total that did not move.
 */
export function diffReports(before, after) {
  const totals = Object.fromEntries(DIFF_TOTALS.map(metric => [metric, { before: before.totals[metric] ?? null, after: after.totals[metric] ?? null }]));
  for (const [metric, read] of Object.entries(MEASURED_TOTALS)) totals[metric] = { before: read(before.totals), after: read(after.totals) };
  const union = (a, b) => [...new Set([...a, ...b])];
  const filesBefore = new Map(before.files.map(file => [file.path, file.totals])), filesAfter = new Map(after.files.map(file => [file.path, file.totals]));
  const files = union(filesBefore.keys(), filesAfter.keys()).sort()
    .map(path => ({ path, before: filesBefore.get(path) ?? null, after: filesAfter.get(path) ?? null }))
    .filter(change => !same(change.before, change.after));
  const state = method => (method ? { reached: !method.untested, exercised: method.exercised, executed: method.executed ?? null, measured: method.measured ?? null } : null);
  const methodsBefore = new Map(before.methods.map(method => [method.id, method])), methodsAfter = new Map(after.methods.map(method => [method.id, method]));
  const methods = union(methodsBefore.keys(), methodsAfter.keys()).sort().map(id => {
    const was = methodsBefore.get(id), is = methodsAfter.get(id), either = is ?? was;
    return { id, path: either.path, name: either.name, before: state(was), after: state(is) };
  }).filter(change => !same(change.before, change.after));
  const testsBefore = new Set(before.tests.map(test => test.id)), testsAfter = new Set(after.tests.map(test => test.id));
  // A problem closed since is set aside, not fixed; and one reopened since is not new. Older reports carry no closed list.
  const findingsBefore = new Set([...before.findings, ...(before.closed ?? [])].map(finding => finding.id));
  const findingsAfter = new Set([...after.findings, ...(after.closed ?? [])].map(finding => finding.id));
  return {
    from: { revision: before.revision, created_at: before.created_at }, to: { revision: after.revision, created_at: after.created_at },
    totals, files, methods,
    tests: { added: [...testsAfter].filter(id => !testsBefore.has(id)).sort(), removed: [...testsBefore].filter(id => !testsAfter.has(id)).sort() },
    findings: { fixed: before.findings.filter(finding => !findingsAfter.has(finding.id)), new: after.findings.filter(finding => !findingsBefore.has(finding.id)) },
  };
}

/** Where a coverage run keeps what it saves, under --out. */
export const coveragePaths = out => {
  const dir = join(out, 'coverage');
  return { dir, reports: join(dir, 'reports'), latest: join(dir, 'latest.jsonl'), html: join(dir, 'index.html') };
};

/** A report's file name: when it was made, then the commit, so the names sort in the order the runs happened. */
const reportName = report => `${report.created_at.replace(/[:.]/g, '-')}-${String(report.revision).slice(0, 7)}.jsonl`;

/**
 * A saved report is a line of everything but its lists, then a line per file, method, test and problem: `["methods", {...}]`.
 * As one JSON document, the report of a 50,000-file repository was longer than any string Node can build, so it could be neither
 * written nor read back.
 */
const REPORT_LISTS = ['files', 'methods', 'tests', 'findings', 'closed', 'failed'];
async function writeReport(path, report) {
  const header = Object.fromEntries(Object.entries(report).map(([key, value]) => [key, REPORT_LISTS.includes(key) && Array.isArray(value) ? [] : value]));
  const rows = [header, ...REPORT_LISTS.flatMap(key => (Array.isArray(report[key]) ? report[key].map(item => [key, item]) : []))];
  await openStore(dirname(path)).writeLines(path, rows);
}

/** A report saved by writeReport, or by an earlier perch as one JSON document. Null when there is none. */
async function readReport(path) {
  if (path.endsWith('.json')) return readJson(path, null);
  const [header, ...rows] = await openStore(dirname(path)).readLines(path);
  if (!header) return null;
  for (const [key, item] of rows) header[key].push(item);
  return header;
}

/** The problems in the last coverage run whose id starts with `ref`, listed or closed, for `perch close` and `perch reopen`. */
export async function coverageFindings(out, ref) {
  const { latest: path } = coveragePaths(out);
  const latest = await readReport(path) ?? await readReport(path.replace(/\.jsonl$/, '.json'));
  return [...(latest?.findings ?? []), ...(latest?.closed ?? [])].filter(finding => finding.id.startsWith(ref));
}

/** A report without each file's text, which is the repository's and is read again from it. It was most of a saved report. */
export const withoutSource = report => ({ ...report, files: report.files.map(({ lines, ...file }) => file) });

/** Save a report under reports/ and as latest.jsonl. Returns the path it was saved at. */
export async function saveCoverageReport(out, report) {
  const paths = coveragePaths(out);
  const path = join(paths.reports, reportName(report));
  await writeReport(path, withoutSource(report));
  await copyFile(path, paths.latest);
  return path;
}

/** The newest saved report `wanted` accepts. `named(revision7)` narrows by file name first, so only candidates are read whole. */
async function newestReport(out, named, wanted) {
  const { reports } = coveragePaths(out);
  const names = (await readdir(reports).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => /\.jsonl?$/.test(name))
    .sort((a, b) => b.replace(/\.jsonl?$/, '').localeCompare(a.replace(/\.jsonl?$/, '')));
  for (const name of names) {
    if (!named(name.replace(/\.jsonl?$/, '').slice(-7))) continue;
    const report = await readReport(join(reports, name));
    if (report && wanted(report)) return report;
  }
  return null;
}

/**
 * The report a run is compared with. Named by --diff, it is the newest saved at that commit, and there being none is an error:
 * a comparison that was asked for and quietly left out reads as nothing having changed. Otherwise it is the newest saved report
 * at any other commit, and none is simply a first run.
 */
export async function findBaseline({ out, root, revision, diff = null }) {
  if (diff === null || diff === undefined) return newestReport(out, () => true, report => report.revision !== revision);
  let sha;
  try { sha = await commitOf(root, diff); } catch (error) { throw new Error(`--diff ${diff} does not name a commit: ${error.message}`, { cause: error }); }
  const report = await newestReport(out, short => short === sha.slice(0, 7), candidate => candidate.revision === sha);
  if (!report) throw new Error(`no coverage report is saved at ${diff} (${sha.slice(0, 7)}); run perch coverage at that commit first`);
  return report;
}

/** Source lines by file, read from the commit rather than the working tree, so a report is about the revision it names. */
const lineReader = (root, graph) => {
  const sources = new Map();
  return async node => {
    if (!sources.has(node.path)) {
      const file = graph.files.get(node.path)?.file;
      if (!file?.blob) throw new Error(`No source blob for ${node.path}`);
      sources.set(node.path, readBlob(root, file.blob).then(text => text.split('\n')));
    }
    return sources.get(node.path);
  };
};

/**
 * One coverage run over a repository: analyze the revision, work out what each test reaches, ask about the tests and the tested
 * methods, and save the report beside the one it is compared with.
 *
 * `paths` narrows which methods and tests are reported, not what is parsed: a test outside it is still followed when it reaches a
 * method inside. `named` paths are read even when perch.yaml's ignore covers them, as a scan does.
 */
export async function coverageRepository({ root, revision, label = root, github = null, out, systemOne, analyzer, paths = [], named = [], depth, parallel = DEFAULT_PARALLEL,
  min = 0.5, diff = null, since = null, reportFlags = {}, cwd = process.cwd(), scanProgress = () => {}, testProgress = () => {}, methodProgress = () => {}, log = () => {}, debug = () => {} }) {
  const walk = depth ?? DEFAULT_DEPTH;
  // A baseline asked for by name is found before anything is asked, so naming a commit with no report costs no requests.
  const requested = diff === null || diff === undefined ? null : await findBaseline({ out, root, revision, diff });
  // So is what the branch changed since --since: a ref git cannot find fails here, not after the questions.
  const changed = since ? await changedLines(root, since, revision) : null;
  // So is every report file: one that is missing or unreadable fails the run before anything is parsed or asked.
  const files = await reportFiles({ root, cwd, flags: reportFlags, configured: await readCoverageReports(root, revision) });
  const reports = files.length ? await readReports({ root, files, paths: new Set((await listTree(root, revision)).map(item => item.path)) }) : null;
  for (const file of files) debug(`reading ${REPORT_NAMES[file.kind]} ${file.path}`);
  const scan = await analyzeTree({ root, revision, out, analyzer, label, github, progress: scanProgress, log, debug });
  const graph = buildGraph(scan.files, { crates: scan.crates });
  const coversNamed = glob => named.some(path => matches(glob, path) || matches(glob, `${path.replace(/\/$/, '')}/file`));
  const ignored = (await readIgnored(root, revision)).filter(glob => !coversNamed(glob));
  const covered = covers(paths);
  // Only the code the repository's own test frameworks run and measure: a release script or a CI action is no test's to cover.
  const scope = await frameworkScope({ root, tree: await listTree(root, revision), scan, graph, ignored: path => ignored.some(glob => matches(glob, path)), debug });
  for (const framework of scope?.frameworks ?? []) if (framework.error) log(`could not load ${framework.config}: ${framework.error}`);
  const chosen = path => covered(path) && !ignored.some(glob => matches(glob, path));
  const inScope = path => chosen(path) && (!scope || scope.source(path));
  const coverage = computeCoverage({ scan, graph, depth: walk, inScope, named: chosen, runs: path => !scope || scope.test(path), reports });
  const linesOf = lineReader(root, graph);
  const answers = await askCoverage({ coverage, graph, linesOf, systemOne, min, parallel, testProgress, methodProgress, log, debug });
  const lines = new Map();
  for (const file of coverage.files) lines.set(file.path, await linesOf({ path: file.path }));
  const report = buildReport({ coverage, answers, lines, revision, root, label, github, model: systemOne.id, min, closed: await openStore(out).closures() });
  if (scope) report.scope = { frameworks: scope.frameworks, tests: scope.tests, sources: scope.sources, left_out: scope.left_out, left_out_sample: scope.left_out_sample };
  if (changed) {
    const sources = new Map(scan.files.filter(file => !file.test && inScope(file.path)).map(file => [file.path, hitsOf(coverage.measurement?.files?.get(file.path))]));
    report.branch = branchOf(report, { ref: since, ...changed }, sources);
  }
  // --since already says what the changes did, measured from the branch point. The last saved run is some other commit, so it is
  // compared with only when --diff names it.
  const baseline = requested ?? (since ? null : await findBaseline({ out, root, revision }));
  if (baseline) { report.baseline = { revision: baseline.revision, created_at: baseline.created_at }; report.diff = diffReports(baseline, report); }
  await saveCoverageReport(out, report);
  return report;
}
