/**
 * `perch coverage`: predictive mutation testing. Which tests reach which methods, and which mutants of those methods the tests
 * would kill.
 *
 * Nothing here runs a test. Tests are the declarations tree-sitter marked as test cases, and what a test reaches is a walk over
 * the call graph. Each reached method gets mutants, one-token edits read off its syntax tree (mutants.js), and Jev is asked,
 * per mutant and per test reaching the method, whether that test would fail against it. A mutant no test is likely enough to
 * kill survived; a test predicted to kill none checks nothing; two tests asked about the same mutants and predicted to kill
 * exactly the same ones, at least one, are one test written twice. Nothing a test run wrote is read: no coverage report, no
 * test results. Every listed problem's probability is a System
 * One answer or computed from answers. A problem whose unit could not be asked has none, and is listed with the failure.
 *
 * A test or a method that cannot be asked about is recorded as failed and stays in the report as failed. It is never counted as
 * a useful test or as a covered method, since a report that quietly fills in what it could not find out reads as complete.
 */
import { readFileSync } from 'node:fs';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { changedLines, listTree, readBlob, revision as commitOf } from './git.js';
import { readCobertura, readCoverageDb, readCoverageJson, readJacoco, readJunit, readLcov, repoPath } from './test-reports.js';
import { namesOf, patternsOf, rootsOf, runNames } from './runs/index.js';
import { languages as jvmLanguages } from './runs/jvm.js';
import { shownPath } from './runs/paths.js';
import { analyzeTree } from './analyze.js';
import { frameworkScope } from './test-scope.js';
import { TOP_LEVEL } from './analysis.js';
import { buildGraph, resolveModule } from './graph.js';
import { AuthenticationError } from './systemone.js';
import { compile, parseQuestions, readAnswer } from './ask.js';
import { excerpt, leadingComment, shownLines, spanOf } from './questions.js';
import { identity, openStore } from './store.js';
import { estimateTokens, IncompleteCheckError, TOKEN_LIMITS, withTokenRetries } from './tokens.js';
import { matches, readIgnored } from './units.js';
import { covers } from './scan.js';
import { describeMutant, mutantId, mutantsOf } from './mutants.js';
import { copiesOf, runnerFor } from './runners/index.js';

/** Tests or methods in flight at once. */
export const DEFAULT_PARALLEL = 8;
/** How many neighbours a test's state shows at most: the methods it reaches, and its helpers. */
export const MAX_SHOWN = 8;
/**
 * How many tests one request about a mutant asks at once. Every test that may run the method is asked, a batch at a time, until
 * one is likely enough to fail; this only decides how many go in one request. A batch too large for the budget is halved.
 */
export const KILL_BATCH = 16;
/**
 * The floor on a test's answer for its kill to count, as min is the floor on a finding's answer for it to be listed. It sits
 * higher than min because the model's kill answers run high; docs/coverage.md has the measurement against real test runs.
 */
export const KILLED = 0.7;

/** The questions perch asks about tests and methods, read once from the file they are declared in. */
/** What an answer is kept under: what was shown, which questions were asked, and who answered. Any of them changing asks again. */
const QUESTIONS = parseQuestions(readFileSync(new URL('../coverage.yaml', import.meta.url), 'utf8'), 'coverage.yaml');

/** What is asked of tests and of methods. `kills` is a template: it is asked once per test shown, as `kills_1` and so on. */
export const coverageQuestions = () => ({ test: QUESTIONS.filter(question => question.each === 'test'), method: QUESTIONS.filter(question => question.each === 'method') });
const questionNamed = name => QUESTIONS.find(question => question.name === name);
/** What a node in a test's request is, when it is not code the test reaches: a helper of its own. */
const HELPER = "the test's own helper, which it calls through to the code under test";
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
 * The walk is breadth first and follows every call until there are no more: how far a test's reach goes is the code's to say.
 * It does not enter anything in a test file, since a helper there is not code under test, and it does not enter or pass through
 * a method a mock of the test replaces.
 */
export function computeCoverage({ scan, graph, inScope = () => true, runs = () => true, named = inScope, reports = null }) {
  const nodes = [...graph.nodes.values()];
  // A file's code outside every function is the scan's to read: no test calls it, so as a method it would never be reached.
  const methods = nodes.filter(node => !node.test && node.qualified_name !== TOP_LEVEL && inScope(node.path));
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
    for (let level = 1; frontier.length; level++) {
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
    // What the test reaches through calls the source writes, as against through an interface's implementations or a value it
    // handed to code the graph cannot see: a test reaching a method only those ways may run it, and usually runs another.
    const written = new Set(), seen = new Set([node.id]);
    for (let frontier = [node.id]; frontier.length;) {
      const next = [];
      for (const from of frontier) {
        for (const callee of graph.callees(from)) {
          if (seen.has(callee) || cut.has(callee) || graph.isDynamic(from, callee)) continue;
          const target = graph.nodes.get(callee);
          if (!target || target.case) continue;
          seen.add(callee);
          if (!target.test) written.add(callee);
          next.push(callee);
        }
      }
      frontier = next;
    }
    const reached = [...reach].map(([id, at]) => ({ id, depth: at, ...(written.has(id) ? {} : { dispatch: true }) }));
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
    // A test that mocks every method it calls tests its own mocks. Both halves are the graph's: the calls it and its helpers make
    // resolved to methods of the repository, and each of those is replaced by a mock the test sets up. A call the graph could
    // not resolve is not evidence either way, so it does not count.
    const resolved = [...new Set([node.id, ...through].flatMap(id => graph.callees(id)))].filter(id => { const target = graph.nodes.get(id); return target && !target.test; });
    const mocked = resolved.length > 0 && resolved.every(id => cut.has(id));
    const test = { id: node.id, node, direct, reach: reached, cuts: [...cut].sort(), mocks, touches, evidence, mocked, ...(helpers.length ? { helpers } : {}) };
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
    reachedBy.get(item.id).push({ id: test.id, depth: item.depth, ...(item.dispatch ? { dispatch: true } : {}) });
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
  const coverage = { tests, methods: units, files, failed, measurement: null };
  if (reports) {
    coverage.measurement = measure(coverage, graph, reports);
    measuredReach(coverage);
  }
  return coverage;
}

/**
 * What the test run measured, in place of the call graph's guess. A method in a file measured test by test is run by exactly the
 * tests that executed one of its lines. A method in a file measured as a whole that ran no line is run by no test, whatever the
 * graph says reaches it; one that ran keeps the graph's tests, since the report does not say which ran it. A file no report
 * measured keeps the graph's guess, and is marked so.
 */
function measuredReach(coverage) {
  const files = coverage.measurement.files;
  for (const method of coverage.methods) {
    const file = files.get(method.node.path);
    if (!file) continue;
    method.measured_by = file.per_test ? 'test' : 'run';
    if (file.per_test) {
      const { from, to } = bodyLines(method.node);
      const depthOf = new Map(method.tests.map(item => [item.id, item.depth]));
      method.tests = coverage.tests.filter(test => [...(test.executed?.get(method.node.path) ?? [])].some(line => line >= from && line <= to))
        .map(test => ({ id: test.id, depth: depthOf.get(test.id) ?? 1 })).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
    } else if (method.measured && method.measured.lines.hit === 0) method.tests = [];
  }
}

// ------------------------------------------------------------------------------------------------ What CI's test run wrote

const REPORT_NAMES = { junit: 'JUnit XML', lcov: 'LCOV', cobertura: 'Cobertura XML', jacoco: 'JaCoCo XML', contexts: 'coverage.py JSON' };

/** Whether a file is an SQLite database, as coverage.py's `.coverage` is, by the header every one starts with. */
async function isSqlite(path) {
  const handle = await (await import('node:fs/promises')).open(path, 'r').catch(() => null);
  if (!handle) return false;
  try { const { buffer, bytesRead } = await handle.read(Buffer.alloc(16), 0, 16, 0); return bytesRead === 16 && buffer.toString('latin1') === 'SQLite format 3\0'; } finally { await handle.close(); }
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
    // coverage.py's own data file, rather than its JSON: the same contexts, test by test, without a name per line per test.
    if (kind === 'contexts' && await isSqlite(path)) {
      const input = { kind, path: report };
      inputs.push(input);
      const read = await readCoverageDb(path);
      for (const item of read.files) {
        const at = where(item.path, report);
        if (at === null) continue;
        const file = fileIn(byKind.contexts, at, input);
        const executed = new Set();
        for (const [context, lines] of item.contexts) {
          for (const line of lines) executed.add(line);
          // The empty context is what ran outside any test, at import or collection, which is no one test's doing.
          if (context === '') continue;
          const nodeid = context.replace(CONTEXT_PHASE, '');
          ranIn(`ctx\0${nodeid}`, { kind: 'contexts', report, context: nodeid }, at, [...lines]);
        }
        // The data file holds what ran, not what could have: a line in it ran, and one not in it did not run or holds no statement.
        addLines(file, [...executed].map(line => [line, 1]));
        file.executed_only = true;
      }
      input.files = read.files.length;
      continue;
    }
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
 * Which tests are worth keeping, from what each is predicted to kill. `mutants` is each method's mutants with, per mutant, the
 * tests asked about it and how likely each is to fail against it. A test checks nothing when, over at least two mutants it was
 * asked about, the chance it kills none is at the floor or over it. Among the tests left, two asked about the same mutants that
 * are predicted to kill exactly the same ones, at least one, are one test written twice; the first by path and line is kept, and
 * the kept test's chance on the mutant it is least sure of is the duplicate's probability.
 */
export function judgeTests(tests, mutants, min) {
  // Every answer a test gave, and the ones from a mutant's first batch, where every test asked was asked the same thing: a later
  // batch holds only mutants the tests before it missed, the hardest, and a test asked only those would look as if it checks
  // nothing.
  const all = new Map(), asked = new Map();
  for (const [methodId, list] of mutants) for (const item of list) for (const [testId, p, round = 0] of item.kills) {
    const entry = { key: `${methodId}#${mutantId(item.mutant)}`, p };
    if (!all.has(testId)) all.set(testId, []);
    all.get(testId).push(entry);
    if (round > 0) continue;
    if (!asked.has(testId)) asked.set(testId, []);
    asked.get(testId).push(entry);
  }
  const checksNothing = new Map();
  for (const [testId, list] of asked) {
    if (list.length < 2) continue;
    const none = list.reduce((total, item) => total * (1 - item.p), 1);
    if (none >= min) checksNothing.set(testId, none);
  }
  const redundantWith = new Map(), pairProbability = new Map();
  const byKills = new Map();
  // Two tests are one written twice only in one file, asked the same three mutants or more: tests in different files reach the
  // same code from different callers, and two asked about one or two mutants have said too little to be told apart.
  for (const test of [...tests].sort((a, b) => a.node.path.localeCompare(b.node.path) || a.node.line - b.node.line)) {
    const list = asked.get(test.id);
    if (!list || list.length < 3 || checksNothing.has(test.id)) continue;
    const sorted = [...list].sort((a, b) => a.key.localeCompare(b.key));
    if (!sorted.some(item => item.p >= KILLED)) continue;
    const key = `${test.node.path}\0${JSON.stringify(sorted.map(item => [item.key, item.p >= KILLED]))}`;
    const first = byKills.get(key);
    if (!first) { byKills.set(key, { id: test.id, mutants: sorted }); continue; }
    // Deleting this one loses nothing when the first kills every mutant it kills: the chance of that is the first's chance on
    // the mutant it is least sure of among those.
    const agree = Math.min(...sorted.map((item, at) => (item.p >= KILLED ? first.mutants[at].p : 1)));
    if (agree < min) continue;
    redundantWith.set(test.id, first.id);
    pairProbability.set(test.id, agree);
  }
  const kills = new Map([...all].map(([testId, list]) => [testId, list.filter(item => item.p >= KILLED).map(item => item.key)]));
  const useful = new Set(tests.filter(test => !checksNothing.has(test.id) && !redundantWith.has(test.id)).map(test => test.id));
  return { useful, checksNothing, redundantWith, pairProbability, kills, asked: new Map([...asked].map(([testId, list]) => [testId, list.length])) };
}

/**
 * Ask System One about the tests that need asking, then about every mutant of every covered method. A test is asked only what
 * the graph left open: whether it calls a live service, when it can reach one. A method is asked once per mutant, with the tests
 * reaching it in view: `matters`, and `kills` for each test. A method no test reaches has its mutants made and asked nothing:
 * they have no coverage, and count against the score as Stryker and PIT count them.
 *
 * Every unit is asked on every run: the endpoint caches answers, perch does not. A unit that fails is recorded in `failed` with
 * its error and carries no answers; an authentication failure stops the run, since every other request would get the same
 * refusal.
 */
export async function askCoverage({ coverage, graph, linesOf, systemOne, parallel = DEFAULT_PARALLEL, min = 0.5, ran = null,
  testProgress = () => {}, methodProgress = () => {}, log = () => {}, debug = () => {} }) {
  const { test: testAsked } = coverageQuestions();
  const killsTemplate = questionNamed('kills'), mattersAsked = [questionNamed('matters')];
  const initial = systemOne.limits?.state ?? TOKEN_LIMITS.state;
  const tests = new Map(), mutants = new Map(), failed = [...coverage.failed];
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
          failed.push({ unit: unit.node.id, subject: unit.node.case ? 'test' : 'method', path: unit.node.path, name: unit.node.qualified_name, error: error.message });
        } finally { progress(++done, units.length); }
      }
    }));
  };

  const neighbourSource = async ({ id }) => { const node = graph.nodes.get(id); return { node, lines: await linesOf(node) }; };

  // Only a test with a network or database call in reach is asked anything: whether it makes it to a live service.
  const testUnits = coverage.tests.map(test => ({ ...test, questions: testAsked.filter(question => question.name === 'infra' && test.evidence.some(item => LEAKS.has(item.category))) }))
    .filter(test => test.questions.length);
  await settle(testUnits, async test => {
    const { node, questions } = test;
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
    const build = budget => fitState((limit, shown) => {
      const nodes = [
        ...helpers.slice(0, shown).map(item => ({ id: item.node.id, path: item.node.path, source: excerpt(item.node, item.lines, limit), note: HELPER }) ),
        ...reached.slice(0, shown).map(item => ({ id: item.id, path: item.node.path, source: excerpt(item.node, item.lines, limit) })),
        ...holders.slice(0, Math.ceil(shown / 2)).map(item => ({ id: item.id, path: item.node.path, source: excerpt(item.node, item.lines, limit) })),
      ];
      return {
        test: { path: node.path, name: node.qualified_name, framework: node.case.framework, source, mocks, reachable_io },
        graph: { nodes, edges: edgesAmong(graph, [node.id, ...nodes.map(item => item.id)]) },
      };
    }, budget, `test ${node.qualified_name}`);
    return answer({ subject: 'test', node, build, typed: () => compile(questions), questions });
  }, tests, testProgress);

  // Every reached method, one mutant at a time, asked of the tests that may run it: most likely to check it first, a batch to a
  // request, until one is likely enough to fail. A mutant is called survived only when every one of them has been asked. A macro
  // the test checks through is shown with it, since the check is inside the macro and no call graph reaches it.
  const sources = new Map();
  const sourceText = async path => { if (!sources.has(path)) sources.set(path, (await linesOf({ path })).join('\n')); return sources.get(path); };
  // A test's file name, its name and its code, as the words in them: what it names. Not its directory, which every test of a
  // module shares: `gson/src/test/...` named Gson in every gson test.
  const testTokens = new Map();
  const testWords = async id => {
    if (!testTokens.has(id)) {
      const test = graph.nodes.get(id);
      const text = `${test.path.split('/').at(-1)}\n${test.qualified_name}\n${(await linesOf(test)).slice(test.line - 1, test.end_line).join('\n')}`.toLowerCase();
      testTokens.set(id, new Set(text.split(/[^a-z0-9_]+/).filter(Boolean)));
    }
    return testTokens.get(id);
  };
  // A word more than half the tests name says nothing about which of them check a method: `json` in a JSON library's tests.
  const allTests = coverage.tests.map(test => test.id);
  const tokenLists = new Map();
  for (const id of allTests) tokenLists.set(id, [...await testWords(id)]);
  const commonness = new Map();
  const common = word => {
    if (!commonness.has(word)) commonness.set(word, allTests.filter(id => tokenLists.get(id).some(token => token.includes(word))).length > allTests.length / 2);
    return commonness.get(word);
  };
  const testText = async id => ({ tokens: await testWords(id), common });
  if (ran) {
    await triage({ coverage, graph, linesOf, ran, mutants, settle, answer, mattersAsked, neighbourSource, methodProgress });
    if (failures && !asked && ran.size) throw new Error(`nothing could be asked: ${failures} failed; last error: ${failed.at(-1).error}`);
    return { tests, mutants, failed, asked };
  }
  const { units: mutantUnits, generatedOf, uncovered } = await planMutants({ coverage, graph, sourceText, order: method => testsToAsk(method, testText) });
  const mutantRows = new Map();
  await settle(mutantUnits, async unit => {
    const { node, mutant, order } = unit;
    const lines = await linesOf(node);
    const kills = [];
    let matters = null;
    /** One request: the mutant, and these tests, each asked whether it fails against it; `matters` with the first. */
    const ask = async (shown, first) => {
      const reaching = await Promise.all(shown.map(async id => ({ id, ...(await neighbourSource({ id })) })));
      const macros = await Promise.all(reaching.map(item => macrosOf(item.node, graph, linesOf)));
      // kills_1 asks about test 1, and so on: the question names the test, and the test's node in the graph is noted the same way.
      const questions = [...(first ? mattersAsked : []), ...shown.map((id, at) => ({ ...killsTemplate, name: `kills_${at + 1}`, ask: `This question is about test ${at + 1}, \`${id}\`. ${killsTemplate.ask}` }))];
      const make = limit => {
        const nodes = reaching.flatMap((item, at) => [
          { id: item.id, path: item.node.path, source: excerpt(item.node, item.lines, limit), note: `test ${at + 1}` },
          ...macros[at].slice(0, 2).map(macro => ({ id: macro.id, path: macro.path, source: macro.source.split('\n').slice(0, limit).join('\n'), note: MACRO })),
        ]);
        return {
          method: { path: node.path, name: node.qualified_name, source: sourceOf(node, lines), mutation: { kind: mutant.kind, edit: describeMutant(mutant), original: mutant.original.trim(), mutated: mutant.mutated.trim() } },
          graph: { nodes, edges: edgesAmong(graph, [node.id, ...nodes.map(item => item.id)]) },
        };
      };
      // Every test of the batch is in the state, each shortened as far as it takes; a batch that does not fit at all is split.
      const build = budget => {
        for (const limit of [80, 40, 20, 8, 3]) { const state = make(limit); if (estimateTokens(state) <= budget) return state; }
        throw new IncompleteCheckError(`method ${node.qualified_name} with ${shown.length} tests does not fit the ${budget}-token budget`);
      };
      return answer({ subject: 'method', node, build, typed: () => compile(questions), questions });
    };
    for (let start = 0, round = 0; start < order.length; round++) {
      let size = Math.min(KILL_BATCH, order.length - start), row = null;
      while (!row) {
        try { row = await ask(order.slice(start, start + size), round === 0); } catch (error) {
          if (!(error instanceof IncompleteCheckError) || size === 1) throw error;
          size = Math.ceil(size / 2);
        }
      }
      if (round === 0) matters = row.answers.matters;
      const batch = order.slice(start, start + size).map((id, at) => [id, row.answers[`kills_${at + 1}`], round]);
      kills.push(...batch);
      start += size;
      if (batch.some(([, p]) => p >= KILLED)) break;
      // An edit no caller could observe is an equivalent mutant: no test can kill it, so asking more tests finds nothing, and it
      // is left out of the score rather than counted against the tests.
      if (round === 0 && matters < min) break;
      // A test already likely enough to fail that the mutant can no longer be listed as survived: what is listed is settled, and
      // more tests could only move it from undecided to killed. It is counted as undecided beside the score.
      if ((1 - Math.max(...kills.map(([, p]) => p))) * matters < min) break;
    }
    return { matters, kills };
  }, mutantRows, methodProgress);
  // Each method's mutants in the order they sit in it: a mutant no test ran with no answers, the rest with theirs.
  const answered = new Map(mutantUnits.map(unit => [unit.mutant, mutantRows.get(unit.id)]));
  for (const [methodId, generated] of generatedOf) {
    const list = [];
    for (const mutant of generated) {
      if (uncovered.has(mutant)) { list.push({ mutant, matters: null, kills: [], uncovered: true }); continue; }
      const row = answered.get(mutant);
      if (row) list.push({ mutant, matters: row.matters, kills: row.kills });
    }
    mutants.set(methodId, list);
  }

  // Every request failed and none answered, which is an outage or a refusal, not a repository with nothing to say.
  if (failures && !asked) throw new Error(`nothing could be asked: ${failures} failed; last error: ${failed.at(-1).error}`);
  return { tests, mutants, failed, asked };
}

/**
 * What perch's own test run measured, for the report to say beside its numbers: how many source files were measured test by
 * test, as a whole, or not at all, and what in its output matched nothing here.
 */
function measuredSummary(coverage) {
  const { measurement } = coverage;
  const by = { test: 0, run: 0, none: 0 };
  for (const path of new Set(coverage.methods.map(method => method.node.path))) {
    const file = measurement.files.get(path);
    by[!file ? 'none' : file.per_test ? 'test' : 'run']++;
  }
  return { files: by, unmatched_runs: measurement.unmatched_runs.length, unmatched_paths: measurement.unmatched_paths.length };
}

/** Words too common in tests to say a test is about a method: a method named `get` is not checked by every test that gets. */
const COMMON_WORDS = new Set(['test', 'tests', 'spec', 'init', 'main', 'self', 'this', 'from', 'into', 'call', 'value', 'data', 'index', 'utils', 'util',
  'helper', 'helpers', 'common', 'core', 'base', 'mod', 'lib', 'impl', 'default', 'create', 'build', 'make', 'read', 'write', 'parse', 'run', 'new', 'get', 'set']);
/** The words a test's code would name if it were about a method: the method's own name, its class's, and its file's. */
function methodWords(node) {
  const parts = node.qualified_name.split('.');
  const stem = node.path.split('/').at(-1).replace(/\.[^.]+$/, '');
  return [...new Set([parts.at(-1), parts.at(-2), stem].filter(Boolean).map(word => word.replace(/^_+|_+$/g, '').toLowerCase()))]
    .filter(word => word.length >= 4 && !COMMON_WORDS.has(word));
}

/**
 * The tests to ask about a method's mutants, most likely to check it first. Every test that calls into it through calls the
 * source writes may run it; a test that reaches it only through an interface's implementations or a value handed to code the
 * graph cannot see usually runs another implementation, and is asked when its code names the method, its class or its file.
 * When no test does either, every test reaching it is asked. Tests naming the method come first, then tests reaching it through
 * written calls, nearest first.
 */
async function testsToAsk(method, testText) {
  const words = methodWords(method.node);
  const ranked = await Promise.all(method.tests.map(async item => {
    const { tokens, common } = await testText(item.id);
    const telling = words.filter(word => !common(word));
    return { ...item, named: [...tokens].some(token => telling.some(word => token.includes(word))) };
  }));
  const candidates = ranked.filter(item => !item.dispatch || item.named);
  return (candidates.length ? candidates : ranked)
    .sort((a, b) => Number(b.named) - Number(a.named) || Number(Boolean(a.dispatch)) - Number(Boolean(b.dispatch)) || a.depth - b.depth || a.id.localeCompare(b.id))
    .map(item => item.id);
}

/**
 * Each covered method's mutants, and for each the tests that may kill it, in `order`'s order: exactly the tests that ran its
 * statements when the run measured them test by test, else every test `order` gives. A mutant whose statements never ran has no
 * coverage, and goes in `uncovered`. A test the run skipped, or that failed before anything was changed, kills nothing and is
 * left out.
 */
async function planMutants({ coverage, graph, sourceText, order }) {
  const unusable = new Set(coverage.tests.filter(test => test.run && test.run.status !== 'passed').map(test => test.id));
  const byTest = new Map(coverage.tests.map(test => [test.id, test]));
  const executedIn = (testId, path) => byTest.get(testId)?.executed?.get(path) ?? null;
  const units = [], generatedOf = new Map(), uncovered = new Set();
  for (const method of coverage.methods) {
    const { node } = method;
    const language = graph.files.get(node.path)?.file.language;
    const generated = mutantsOf({ source: await sourceText(node.path), language, line: node.line, end_line: node.end_line });
    generatedOf.set(method.id, generated);
    if (!method.tests.length) { for (const mutant of generated) uncovered.add(mutant); continue; }
    const ordered = (await order(method)).filter(id => !unusable.has(id));
    const measured = coverage.measurement?.files.get(node.path) ?? null;
    for (const mutant of generated) {
      // The lines a coverage tool records the edit's statements under. A report that wrote what could have run, with a count of
      // zero for what did not, says so of a line; coverage.py's data file holds only what ran, so in a method it measured, a
      // statement line it does not hold did not run.
      // None for an edit in the signature: it runs when the function does, so the tests that run the function decide it.
      const lines = mutant.statements ?? [mutant.line];
      const known = !measured ? [] : measured.executed_only ? (method.measured || method.tests.length ? lines : []) : lines.filter(line => measured.lines.has(line));
      const ran = line => (measured?.lines.get(line) ?? 0) > 0;
      // A mutant whose statements never ran has no coverage, as the run measured it: no test can kill it.
      if (known.length && !known.some(ran)) { uncovered.add(mutant); continue; }
      // Measured test by test: exactly the tests that ran its statements. What ran under no test, at import, is no test's.
      let tests = ordered;
      if (measured?.per_test && known.length) {
        tests = ordered.filter(id => known.some(line => executedIn(id, node.path)?.has(line)));
        if (!tests.length) { uncovered.add(mutant); continue; }
      }
      if (!tests.length) { uncovered.add(mutant); continue; }
      units.push({ id: `${method.id}#${mutantId(mutant)}`, node, method, mutant, order: tests });
    }
  }
  return { units, generatedOf, uncovered };
}

/**
 * Every planned mutant run for real: written into a copy of the repository, the tests that may kill it run against it in one
 * process, and the file put back. Each copy is one worker's, so mutants run side by side without seeing each other's edits. A
 * mutant is killed when one of its tests fails or the run passes its time limit; invalid when the tests could not even be
 * collected, which says the edit broke the code rather than that a test caught it.
 *
 * `ran` is each method's mutants in order: `{ mutant, uncovered }` for one no test ran, else `{ mutant, status, kills }` with every
 * test that ran it and 1 for a failure, 0 for a pass.
 */
export async function runMutants({ coverage, graph, sourceText, runner, python, copies, base, progress = () => {}, debug = () => {} }) {
  const nodesOf = new Map(), timeOf = new Map();
  for (const [node, result] of base.results) {
    if (result.status !== 'passed') continue;
    if (!nodesOf.has(result.test)) nodesOf.set(result.test, []);
    nodesOf.get(result.test).push(node);
    timeOf.set(node, result.time);
  }
  const { units, generatedOf, uncovered } = await planMutants({ coverage, graph, sourceText, order: method => method.tests.map(item => item.id) });
  const results = new Map();
  let next = 0, done = 0;
  progress(0, units.length);
  await Promise.all(copies.map(async (copy, worker) => {
    while (next < units.length) {
      const unit = units[next++];
      const { node, mutant } = unit;
      const nodes = unit.order.flatMap(id => nodesOf.get(id) ?? []);
      if (!nodes.length) { results.set(unit.id, { status: 'ran', kills: [] }); progress(++done, units.length); continue; }
      const file = join(copy.dir, node.path);
      const original = await readFile(file);
      const mutated = applyMutant(original, mutant);
      if (!mutated) { results.set(unit.id, { status: 'invalid', kills: [] }); progress(++done, units.length); continue; }
      // Three times what the tests took unmutated, and time to start: a mutant that makes a loop never end is caught by its timeout.
      const seconds = nodes.reduce((sum, item) => sum + (timeOf.get(item) ?? 0), 0);
      const timeout = Math.round((seconds * 3 + 15) * 1000);
      await writeFile(file, mutated);
      let outcome;
      try { outcome = await runner.runTests({ copy: copy.dir, python, scratch: copy.scratch, nodes, timeout, tag: worker }); } finally { await writeFile(file, original); }
      if (outcome.status === 'ran') {
        const failed = new Set(), passed = new Set();
        for (const [, result] of outcome.results) (result.status === 'failed' || result.status === 'error' ? failed : passed).add(result.test);
        const kills = unit.order.filter(id => failed.has(id) || passed.has(id)).map(id => [id, failed.has(id) ? 1 : 0, 0]);
        results.set(unit.id, { status: 'ran', kills });
      } else results.set(unit.id, { status: outcome.status, kills: [] });
      debug(`${node.qualified_name} ${describeMutant(mutant)}: ${results.get(unit.id).status}${results.get(unit.id).kills.some(([, p]) => p) ? ' killed' : ''}`);
      progress(++done, units.length);
    }
  }));
  const ran = new Map();
  for (const [methodId, generated] of generatedOf) {
    ran.set(methodId, generated.map(mutant => (uncovered.has(mutant) ? { mutant, uncovered: true }
      : { mutant, ...(results.get(`${methodId}#${mutantId(mutant)}`) ?? { status: 'invalid', kills: [] }) })));
  }
  return ran;
}

/** The file with the mutant's edit made at its byte offset, or null when the text there is not what the mutant replaces. */
function applyMutant(original, mutant) {
  let start = 0;
  for (let line = 1; line < mutant.line; line++) { start = original.indexOf(10, start) + 1; if (start === 0) return null; }
  const at = start + mutant.column, from = Buffer.from(mutant.from);
  if (!original.subarray(at, at + from.length).equals(from)) return null;
  return Buffer.concat([original.subarray(0, at), Buffer.from(mutant.to), original.subarray(at + from.length)]);
}

/**
 * The survivors of a real run, each asked whether the edit is a defect a caller could observe: one request per survivor, with the
 * method's callers in view, since whether an input can happen is theirs to say. A killed mutant is a fact, and nothing is asked
 * about it; nor about one that timed out, was invalid, or that no test ran.
 */
async function triage({ coverage, graph, linesOf, ran, mutants, settle, answer, mattersAsked, neighbourSource, methodProgress }) {
  const methods = new Map(coverage.methods.map(method => [method.id, method]));
  const units = [];
  for (const [methodId, list] of ran) {
    for (const item of list) {
      if (item.uncovered || item.status !== 'ran' || !item.kills.length || item.kills.some(([, p]) => p)) continue;
      units.push({ id: `${methodId}#${mutantId(item.mutant)}`, node: methods.get(methodId).node, mutant: item.mutant });
    }
  }
  const rows = new Map();
  await settle(units, async unit => {
    const { node, mutant } = unit;
    const lines = await linesOf(node);
    const callers = await Promise.all(graph.callers(node.id).filter(id => !graph.nodes.get(id)?.test).slice(0, 4).map(async id => ({ id, ...(await neighbourSource({ id })) })));
    const build = budget => {
      for (const limit of [80, 40, 20, 8, 3]) {
        const nodes = callers.map(item => ({ id: item.id, path: item.node.path, source: excerpt(item.node, item.lines, limit), note: 'a caller' }));
        const state = {
          method: { path: node.path, name: node.qualified_name, source: sourceOf(node, lines), mutation: { kind: mutant.kind, edit: describeMutant(mutant), original: mutant.original.trim(), mutated: mutant.mutated.trim() } },
          graph: { nodes, edges: edgesAmong(graph, [node.id, ...nodes.map(item => item.id)]) },
        };
        if (estimateTokens(state) <= budget) return state;
      }
      throw new IncompleteCheckError(`method ${node.qualified_name} does not fit the ${budget}-token budget`);
    };
    return (await answer({ subject: 'method', node, build, typed: () => compile(mattersAsked), questions: mattersAsked })).answers.matters;
  }, rows, methodProgress);
  for (const [methodId, list] of ran) {
    mutants.set(methodId, list.map(item => (item.uncovered ? { mutant: item.mutant, matters: null, kills: [], uncovered: true }
      : { mutant: item.mutant, matters: rows.get(`${methodId}#${mutantId(item.mutant)}`) ?? null, kills: item.kills,
        ...(item.status === 'timeout' ? { timeout: true } : {}), ...(item.status === 'invalid' ? { invalid: true } : {}) })));
  }
}

/**
 * The macros a test calls, as nodes for its request: a C, C++ or Rust test's assertions are often inside one, and no call graph
 * reaches a macro. One defined in the test's file, or in a file it includes, is found by its name.
 */
async function macrosOf(node, graph, linesOf) {
  const file = graph.files.get(node.path)?.file;
  if (!file || !MACRO_LANGUAGES.has(file.language)) return [];
  const included = (file.imports ?? []).map(item => resolveModule(node.path, item.module, file.language, new Set(graph.files.keys()))).filter(Boolean);
  const names = [...new Set(graph.external(node.id).map(call => String(call.name).replace(/!$/, '')).filter(name => /^\w+$/.test(name)))];
  const macros = [];
  for (const path of [node.path, ...included]) {
    const fileLines = await linesOf({ path });
    for (const name of names) {
      if (macros.some(item => item.name === name)) continue;
      const found = macroIn(fileLines, name);
      if (found) macros.push({ name, id: `${path}::${name}`, path, source: found.text });
    }
  }
  return macros;
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const findingIdOf = (kind, unit) => identity('coverage', kind, unit).slice(0, 8);

/**
 * The report every view of a run reads: the terminal tables, the HTML page and the diff against the next run. Everything in it is
 * counted from the coverage, the answers and the lines it is given; nothing is looked up again.
 */
export function buildReport({ coverage, answers, lines, revision, root, label = root, github = null, createdAt = new Date().toISOString(), model = null, min = 0.5, usage = {}, closed = new Map() }) {
  const judged = judgeTests(coverage.tests, answers.mutants, min);
  const findings = [];
  const listed = finding => finding.probability === null || finding.probability >= min;
  // A problem someone closed with `perch close` stays closed: it is kept apart, so perch reopen can find it, and listed nowhere.
  // A mutant's problem is keyed by the mutant, since a method can have several; every other problem by its unit.
  const isClosed = (kind, key) => closed.get(findingIdOf(kind, key))?.kinds.has(kind) ?? false;
  const closedFindings = [];
  const add = finding => {
    const key = finding.key ?? finding.unit;
    const full = { id: findingIdOf(finding.kind, key), ...finding };
    delete full.key;
    if (!listed(full)) return null;
    if (isClosed(full.kind, key)) { closedFindings.push({ ...full, reason: closed.get(full.id).reason }); return null; }
    findings.push(full);
    return full.id;
  };
  // The tests that could go: checking nothing, mocking what they test, or repeating another. One whose problem was closed is
  // one someone chose to keep, and one that could not be asked about is not said to check nothing.
  const dropped = new Set(coverage.tests.filter(test => (judged.checksNothing.has(test.id) && !isClosed('checks_nothing', test.id))
    || (test.mocked && !isClosed('mocked', test.id))
    || (judged.redundantWith.has(test.id) && !isClosed('redundant', test.id))).map(test => test.id));

  const methods = coverage.methods.map(method => {
    const { node } = method;
    const usefulTests = method.tests.filter(item => judged.useful.has(item.id)).map(item => item.id);
    const covered = method.tests.length > 0;
    // Each mutant: how likely it is that no test shown kills it, and that it changes behaviour at all. A mutant is killed when
    // one test is likely enough to fail against it, KILLED or over, and survives by the chance that the likeliest misses. The
    // answers are not multiplied across tests: eight tests each a little likely to fail multiplied into a near-certain kill,
    // and against real runs three in four of those kills were wrong, while every mutant no single test was likely to kill had
    // survived. One that survives, and matters, is listed. A mutant of a method no test reaches has no coverage: nothing was
    // asked, nothing is listed, and it counts against the score.
    const mutants = (answers.mutants.get(method.id) ?? []).map(({ mutant, matters, kills, uncovered, timeout, invalid }) => {
      const id = mutantId(mutant);
      const base = { id, kind: mutant.kind, line: mutant.line, column: mutant.column, from: mutant.from, to: mutant.to, original: mutant.original, mutated: mutant.mutated };
      if (!covered || uncovered) return { ...base, matters: null, survives: null, killed: false, no_coverage: true, killed_by: [], asked: [], finding: null };
      // An edit the tests could not even be collected against broke the code: it is no mutant a test could catch or miss, and is
      // left out of the score, as Stryker leaves out a compile error.
      if (invalid) return { ...base, matters: null, survives: null, killed: false, invalid: true, killed_by: [], asked: [], finding: null };
      // A run that passed its time limit is caught: the edit made something never finish, which a test run notices.
      const survives = timeout ? 0 : 1 - Math.max(0, ...kills.map(([, p]) => p));
      // fails is the chance each test in asked fails against the mutant, in the same order: 1 or 0 when the tests were run.
      const killed = 1 - survives >= KILLED;
      const equivalent = !killed && matters !== null && matters < min, undecided = !killed && !equivalent && survives * (matters ?? 1) < min;
      const item = { ...base, matters, survives, killed, ...(equivalent ? { equivalent: true } : {}), ...(undecided ? { undecided: true } : {}), killed_by: kills.filter(([, p]) => p >= KILLED).map(([testId]) => testId),
        asked: kills.map(([testId]) => testId), fails: kills.map(([, p]) => p), ...(timeout ? { timeout: true } : {}), finding: null };
      const count = kills.length;
      item.finding = add({ kind: 'survived', subject: 'method', unit: method.id, key: `${method.id}#${id}`, path: node.path, line: mutant.line, name: node.qualified_name,
        probability: survives * matters, mutant: id,
        note: `With ${describeMutant(mutant)}, ${count === 1 ? 'the 1 test that runs it still passes' : `none of the ${count} tests that run it fails`}.` });
      return item;
    });
    // The tests asked about its mutants: every test that may run it, where `tests` holds every test that reaches it at all.
    const askedTests = new Set(mutants.flatMap(item => item.asked)).size;
    return { id: method.id, path: node.path, name: node.qualified_name, line: node.line, end_line: node.end_line, risk: node.metrics?.risk_score ?? null,
      branches: method.branches, tests: method.tests, asked_tests: askedTests, useful: usefulTests, covered, measured_by: method.measured_by ?? null,
      mutants, killed: mutants.filter(item => item.killed).length, equivalent: mutants.filter(item => item.equivalent).length, findings: mutants.map(item => item.finding).filter(Boolean) };
  });
  const testById = new Map(coverage.tests.map(test => [test.id, test]));

  const tests = coverage.tests.map(test => {
    const { node } = test;
    const said = answers.tests.get(test.id)?.answers ?? null;
    const own = [];
    const keptId = judged.redundantWith.get(test.id) ?? null;
    if (keptId) {
      const kept = testById.get(keptId).node;
      const like = `${kept.qualified_name}${kept.path === node.path ? '' : ` in ${kept.path}`} at line ${kept.line}`;
      own.push(add({ kind: 'redundant', subject: 'test', unit: test.id, path: node.path, line: node.line, name: node.qualified_name, probability: judged.pairProbability.get(test.id),
        note: `Kills the same mutants as ${like}, and no others.` }));
    }
    if (judged.checksNothing.has(test.id)) own.push(add({ kind: 'checks_nothing', subject: 'test', unit: test.id, path: node.path, line: node.line, name: node.qualified_name,
      probability: judged.checksNothing.get(test.id), note: `Kills none of the ${plural(judged.asked.get(test.id), 'mutant')} in the code it reaches.` }));
    // A fact of the graph, with no answer behind it: the calls resolved, and every one is cut by a mock of the test's own.
    if (test.mocked) own.push(add({ kind: 'mocked', subject: 'test', unit: test.id, path: node.path, line: node.line, name: node.qualified_name, probability: null,
      note: `Mocks every method it calls: ${test.cuts.map(id => id.split('::').at(-1)).join(', ')}.` }));
    const leaks = test.evidence.filter(item => LEAKS.has(item.category));
    const shown = leaks.slice(0, 3).map(item => `${item.name} at ${item.path}:${item.line}`).join(', ');
    // The call graph finds the network and database calls a test can reach; the answer decides whether it makes one to a live
    // service. A test that could not be asked keeps what the call graph found, with no probability, and is listed under failures.
    if (leaks.length) own.push(add({ kind: 'infra', subject: 'test', unit: test.id, path: node.path, line: node.line, name: node.qualified_name,
      probability: said?.infra ?? null, note: `Calls a live service with nothing mocked: ${shown}.` }));
    return { id: test.id, path: node.path, name: node.case.name, suite: node.case.suite, line: node.line, end_line: node.end_line, framework: node.case.framework,
      direct: test.direct, reach: test.reach, cuts: test.cuts, touches: test.touches, unresolved: test.unresolved ?? null,
      infra: said?.infra ?? null, mocked: test.mocked,
      asked: judged.asked.get(test.id) ?? 0, kills: judged.kills.get(test.id) ?? [],
      useful: judged.useful.has(test.id) && !test.mocked, redundant_with: keptId, findings: own.filter(Boolean) };
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
  const totalsOf = (methodList, testList) => {
    const testIds = new Set(testList.map(test => test.id)), methodIds = new Set(methodList.map(method => method.id));
    // The score as mutation testing defines it: killed of every mutant but the equivalent ones, the ones no test reaches included.
    // An equivalent mutant changes nothing a caller could observe, so no test can kill it; Stryker and PIT cannot tell one and
    // count it against the tests. The covered score leaves out the mutants no test reaches and says how the tests do on the rest.
    const equivalent = methodList.reduce((total, method) => total + method.equivalent, 0);
    const invalid = methodList.reduce((total, method) => total + method.mutants.filter(item => item.invalid).length, 0);
    // Mutants some test is likely to kill but none surely: neither killed in the score nor listed as survived.
    const undecided = methodList.reduce((total, method) => total + method.mutants.filter(item => item.undecided).length, 0);
    const mutants = methodList.reduce((total, method) => total + method.mutants.length, 0) - equivalent - invalid, killed = methodList.reduce((total, method) => total + method.killed, 0);
    const no_coverage = methodList.reduce((total, method) => total + method.mutants.filter(item => item.no_coverage).length, 0);
    return { methods: methodList.length, covered: methodList.filter(method => method.covered).length, useful_covered: methodList.filter(method => method.useful.length).length,
      mutants, killed, equivalent, undecided, invalid, no_coverage, score: mutants ? killed / mutants : null, covered_score: mutants - no_coverage ? killed / (mutants - no_coverage) : null, survived: count(methodIds, 'survived'),
      tests: testList.length, useful: testList.filter(test => test.useful).length,
      redundant: testList.filter(test => test.redundant_with).length, weak: testList.filter(test => judged.checksNothing.has(test.id) || test.mocked).length, infra: count(testIds, 'infra') };
  };
  const methodsIn = Map.groupBy(methods, method => method.path), testsIn = Map.groupBy(tests, test => test.path);
  const files = coverage.files.map(file => {
    const own = methodsIn.get(file.path) ?? [], ownTests = testsIn.get(file.path) ?? [];
    return { path: file.path, kind: file.test ? 'test' : 'source', language: file.language, lines: lines.get(file.path) ?? [],
      methods: own.map(method => method.id), tests: ownTests.map(test => test.id), totals: totalsOf(own, ownTests) };
  });
  // The tests that could go, and what dropping them would cost in reach: the methods only dropped tests reach. Counted, since
  // "nothing" is a claim.
  const drop = { count: tests.filter(test => dropped.has(test.id)).length,
    unreached: methods.filter(method => method.tests.length && method.tests.every(item => dropped.has(item.id))).map(method => method.id) };
  const totals = { ...totalsOf(methods, tests), drop };
  return { revision, root, target: label, github, created_at: createdAt, model, min,
    totals, files, methods, tests, findings, failed: answers.failed, closed: closedFindings, baseline: null, diff: null, usage };
}

/**
 * What a branch changed since its merge base: the methods and tests whose lines it touched, and the problems on them. Nothing
 * here asks anything.
 */
export function branchOf(report, { ref, base, files: changed }) {
  const touched = unit => (changed.get(unit.path) ?? []).some(line => line >= unit.line && line <= unit.end_line);
  const units = [...report.methods, ...report.tests].filter(touched).map(unit => unit.id).sort();
  const changedUnits = new Set(units);
  return { ref, base, units, findings: report.findings.filter(finding => changedUnits.has(finding.unit)).map(finding => finding.id) };
}

const DIFF_TOTALS = ['methods', 'covered', 'mutants', 'killed', 'equivalent', 'undecided', 'no_coverage', 'score', 'covered_score', 'survived', 'tests', 'useful', 'redundant', 'weak', 'infra'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/**
 * What changed between two saved reports, unit by unit. Methods, tests, files and findings are matched by id, so a method whose
 * share went down while another's went up is two changes rather than a total that did not move.
 */
export function diffReports(before, after) {
  const totals = Object.fromEntries(DIFF_TOTALS.map(metric => [metric, { before: before.totals[metric] ?? null, after: after.totals[metric] ?? null }]));
  const union = (a, b) => [...new Set([...a, ...b])];
  const filesBefore = new Map(before.files.map(file => [file.path, file.totals])), filesAfter = new Map(after.files.map(file => [file.path, file.totals]));
  const files = union(filesBefore.keys(), filesAfter.keys()).sort()
    .map(path => ({ path, before: filesBefore.get(path) ?? null, after: filesAfter.get(path) ?? null }))
    .filter(change => !same(change.before, change.after));
  const state = method => (method ? { covered: method.covered, mutants: method.mutants.length - method.equivalent, killed: method.killed } : null);
  const methodsBefore = new Map(before.methods.map(method => [method.id, method])), methodsAfter = new Map(after.methods.map(method => [method.id, method]));
  const methods = union(methodsBefore.keys(), methodsAfter.keys()).sort().map(id => {
    const was = methodsBefore.get(id), is = methodsAfter.get(id), either = is ?? was;
    return { id, path: either.path, name: either.name, before: state(was), after: state(is) };
  }).filter(change => !same(change.before, change.after));
  const testsBefore = new Set(before.tests.map(test => test.id)), testsAfter = new Set(after.tests.map(test => test.id));
  // A problem closed since is set aside, not fixed; and one reopened since is not new.
  const findingsBefore = new Set([...before.findings, ...before.closed].map(finding => finding.id));
  const findingsAfter = new Set([...after.findings, ...after.closed].map(finding => finding.id));
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

/** A report saved by writeReport. Null when there is none. */
async function readReport(path) {
  const [header, ...rows] = await openStore(dirname(path)).readLines(path);
  if (!header) return null;
  for (const [key, item] of rows) header[key].push(item);
  return header;
}

/** The problems in the last coverage run whose id starts with `ref`, listed or closed, for `perch close` and `perch reopen`. */
export async function coverageFindings(out, ref) {
  const { latest: path } = coveragePaths(out);
  const latest = await readReport(path);
  return latest ? [...latest.findings, ...latest.closed].filter(finding => finding.id.startsWith(ref)) : [];
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
  const names = (await readdir(reports).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => name.endsWith('.jsonl'))
    .sort((a, b) => b.localeCompare(a));
  for (const name of names) {
    if (!named(name.slice(0, -'.jsonl'.length).slice(-7))) continue;
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
export async function coverageRepository({ root, revision, label = root, github = null, out, systemOne, analyzer, paths = [], named = [], parallel = DEFAULT_PARALLEL,
  min = 0.5, diff = null, since = null, run = true, scanProgress = () => {}, testProgress = () => {}, methodProgress = () => {}, log = () => {}, debug = () => {} }) {
  // A baseline asked for by name is found before anything is asked, so naming a commit with no report costs no requests.
  const requested = diff === null || diff === undefined ? null : await findBaseline({ out, root, revision, diff });
  // So is what the branch changed since --since: a ref git cannot find fails here, not after the questions.
  const changed = since ? await changedLines(root, since, revision) : null;
  const scan = await analyzeTree({ root, revision, out, analyzer, label, github, progress: scanProgress, log, debug });
  const graph = buildGraph(scan.files, { crates: scan.crates, modules: scan.modules });
  const coversNamed = glob => named.some(path => matches(glob, path) || matches(glob, `${path.replace(/\/$/, '')}/file`));
  const ignored = (await readIgnored(root, revision)).filter(glob => !coversNamed(glob));
  const covered = covers(paths);
  // Only the code the repository's own test frameworks run and measure: a release script or a CI action is no test's to cover.
  const scope = await frameworkScope({ root, tree: await listTree(root, revision), scan, graph, ignored: path => ignored.some(glob => matches(glob, path)), debug });
  for (const framework of scope?.frameworks ?? []) if (framework.error) log(`could not load ${framework.config}: ${framework.error}`);
  const chosen = path => covered(path) && !ignored.some(glob => matches(glob, path));
  const inScope = path => chosen(path) && (!scope || scope.source(path));
  const runs = path => !scope || scope.test(path);
  const linesOf = lineReader(root, graph);
  // The repository's own tests, run by perch: once for which tests run each line, then once per mutant. A framework perch has no
  // runner for, or one that cannot run here, leaves the call graph to estimate what runs and the model to predict what fails.
  const runner = run ? runnerFor(scope) : null;
  const usable = runner ? await runner.available({ root }) : null;
  if (runner && !usable.python) log(`${runner.name} cannot run here, so what the tests run and catch is estimated: ${usable.reason}`);
  let coverage, ran = null, measured = null;
  if (runner && usable.python) {
    const { copies, remove } = await copiesOf({ root, revision, count: parallel });
    try {
      debug(`running ${runner.name} once with per-test coverage`);
      const base = await runner.coverageRun({ copy: copies[0].dir, python: usable.python, scratch: copies[0].scratch });
      const tree = new Set((await listTree(root, revision)).map(item => item.path));
      const reports = await readReports({ root: copies[0].dir, files: [{ kind: 'contexts', path: base.data }, { kind: 'junit', path: base.xml }], paths: tree });
      coverage = computeCoverage({ scan, graph, inScope, named: chosen, runs, reports });
      const sourceText = async path => (await linesOf({ path })).join('\n');
      ran = await runMutants({ coverage, graph, sourceText, runner, python: usable.python, copies, base, progress: methodProgress, debug });
      const statuses = [...ran.values()].flat();
      measured = { runner: runner.name, suite_seconds: Math.round(base.seconds), mutants_run: statuses.filter(item => !item.uncovered).length,
        timeouts: statuses.filter(item => item.status === 'timeout').length, invalid: statuses.filter(item => item.status === 'invalid').length };
    } finally { await remove(); }
  } else coverage = computeCoverage({ scan, graph, inScope, named: chosen, runs });
  const answers = await askCoverage({ coverage, graph, linesOf, systemOne, min, parallel, ran, testProgress, methodProgress, log, debug });
  const lines = new Map();
  for (const file of coverage.files) lines.set(file.path, await linesOf({ path: file.path }));
  const report = buildReport({ coverage, answers, lines, revision, root, label, github, model: systemOne.id, min, closed: await openStore(out).closures() });
  if (scope) report.scope = { frameworks: scope.frameworks, tests: scope.tests, sources: scope.sources, left_out: scope.left_out, left_out_sample: scope.left_out_sample };
  report.measured = coverage.measurement ? { ...measuredSummary(coverage), ...measured } : null;
  if (changed) report.branch = branchOf(report, { ref: since, ...changed });
  // --since already says what the branch changed. The last saved run is some other commit, so it is
  // compared with only when --diff names it.
  const baseline = requested ?? (since ? null : await findBaseline({ out, root, revision }));
  if (baseline) { report.baseline = { revision: baseline.revision, created_at: baseline.created_at }; report.diff = diffReports(baseline, report); }
  await saveCoverageReport(out, report);
  return report;
}
