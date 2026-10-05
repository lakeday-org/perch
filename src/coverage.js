/**
 * `perch coverage`: predictive mutation testing. Which tests reach which methods, and which mutants of those methods the tests
 * would kill.
 *
 * Nothing here runs a test. Tests are the declarations tree-sitter marked as test cases, and what a test reaches is a walk over
 * the call graph. Each reached method gets mutants, one-token edits read off its syntax tree (mutants.js), and Jev is asked,
 * per mutant and per test reaching the method, whether that test would fail against it. A mutant no test is predicted to kill
 * survived; a test predicted to kill none checks nothing; two tests predicted to kill the same mutants are one test written
 * twice. Nothing a test run wrote is read: no coverage report, no test results. Every listed problem's probability is a System
 * One answer or computed from answers. A problem whose unit could not be asked has none, and is listed with the failure.
 *
 * A test or a method that cannot be asked about is recorded as failed and stays in the report as failed. It is never counted as
 * a useful test or as a covered method, since a report that quietly fills in what it could not find out reads as complete.
 */
import { readFileSync } from 'node:fs';
import { copyFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { changedLines, listTree, readBlob, revision as commitOf } from './git.js';
import { analyzeTree } from './analyze.js';
import { frameworkScope } from './test-scope.js';
import { TOP_LEVEL } from './analysis.js';
import { buildGraph, resolveModule } from './graph.js';
import { AuthenticationError } from './systemone.js';
import { compile, parseQuestions, readAnswer } from './ask.js';
import { excerpt, leadingComment, shownLines, spanOf } from './questions.js';
import { identity, openStore, readJson } from './store.js';
import { estimateTokens, IncompleteCheckError, TOKEN_LIMITS, withTokenRetries } from './tokens.js';
import { matches, readIgnored } from './units.js';
import { covers } from './scan.js';
import { describeMutant, mutantId, mutantsOf } from './mutants.js';

/** How many calls deep a test is followed into the code it reaches, unless --depth says otherwise. */
export const DEFAULT_DEPTH = 3;
/** Tests or methods in flight at once. */
export const DEFAULT_PARALLEL = 8;
/** How many neighbours a state shows at most: the methods a test reaches, or the tests that reach a method. */
export const MAX_SHOWN = 8;

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
 * The walk is breadth first to `depth` calls. It does not enter anything in a test file, since a helper there is not code under
 * test, and it does not enter or pass through a method a mock of the test replaces.
 */
export function computeCoverage({ scan, graph, depth = DEFAULT_DEPTH, inScope = () => true, runs = () => true, named = inScope }) {
  const nodes = [...graph.nodes.values()];
  // A file's code outside every function is the scan's to read: no test calls it, so as a method it would never be reached.
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
  return { depth, tests, methods: units, files, failed };
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
  const asked = new Map();
  for (const [methodId, list] of mutants) for (const item of list) for (const [testId, p] of item.kills) {
    if (!asked.has(testId)) asked.set(testId, []);
    asked.get(testId).push({ key: `${methodId}#${mutantId(item.mutant)}`, p });
  }
  const checksNothing = new Map();
  for (const [testId, list] of asked) {
    if (list.length < 2) continue;
    const none = list.reduce((total, item) => total * (1 - item.p), 1);
    if (none >= min) checksNothing.set(testId, none);
  }
  const redundantWith = new Map(), pairProbability = new Map();
  const byKills = new Map();
  for (const test of [...tests].sort((a, b) => a.node.path.localeCompare(b.node.path) || a.node.line - b.node.line)) {
    const list = asked.get(test.id);
    if (!list || list.length < 2 || checksNothing.has(test.id)) continue;
    const sorted = [...list].sort((a, b) => a.key.localeCompare(b.key));
    if (!sorted.some(item => item.p >= min)) continue;
    const key = JSON.stringify(sorted.map(item => [item.key, item.p >= min]));
    const first = byKills.get(key);
    if (!first) { byKills.set(key, { id: test.id, mutants: sorted }); continue; }
    // Deleting this one loses nothing when the first kills every mutant it kills: the chance of that is the first's chance on
    // the mutant it is least sure of among those.
    const agree = Math.min(...sorted.map((item, at) => (item.p >= min ? first.mutants[at].p : 1)));
    if (agree < min) continue;
    redundantWith.set(test.id, first.id);
    pairProbability.set(test.id, agree);
  }
  const kills = new Map([...asked].map(([testId, list]) => [testId, list.filter(item => item.p >= min).map(item => item.key)]));
  const useful = new Set(tests.filter(test => !checksNothing.has(test.id) && !redundantWith.has(test.id)).map(test => test.id));
  return { useful, checksNothing, redundantWith, pairProbability, kills, asked: new Map([...asked].map(([testId, list]) => [testId, list.length])) };
}

/**
 * Ask System One about the tests that need asking, then about every mutant of every reached method. A test is asked only what
 * the graph left open: whether it calls a live service, when it can reach one. A method is asked once per mutant, with the tests
 * reaching it in view: `matters`, and `kills` for each test. A method no test reaches is asked nothing.
 *
 * Every unit is asked on every run: the endpoint caches answers, perch does not. A unit that fails is recorded in `failed` with
 * its error and carries no answers; an authentication failure stops the run, since every other request would get the same
 * refusal.
 */
export async function askCoverage({ coverage, graph, linesOf, systemOne, parallel = DEFAULT_PARALLEL,
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

  // Every reached method, one request per mutant, with the tests reaching it in view, nearest first. A macro the test checks
  // through is shown with it, since the check is inside the macro and no call graph reaches it.
  const sources = new Map();
  const sourceText = async path => { if (!sources.has(path)) sources.set(path, (await linesOf({ path })).join('\n')); return sources.get(path); };
  const mutantUnits = [];
  for (const method of coverage.methods) {
    if (!method.tests.length) continue;
    const { node } = method;
    const language = graph.files.get(node.path)?.file.language;
    const generated = mutantsOf({ source: await sourceText(node.path), language, line: node.line, end_line: node.end_line });
    const shown = method.tests.slice(0, MAX_SHOWN).map(item => item.id);
    for (const mutant of generated) mutantUnits.push({ id: `${method.id}#${mutantId(mutant)}`, node, method, mutant, shown });
  }
  const mutantRows = new Map();
  await settle(mutantUnits, async unit => {
    const { node, mutant, shown } = unit;
    const lines = await linesOf(node);
    const reaching = await Promise.all(shown.map(async id => ({ id, ...(await neighbourSource({ id })) })));
    const macros = await Promise.all(reaching.map(item => macrosOf(item.node, graph, linesOf)));
    // kills_1 asks about test 1, and so on: the question names the test, and the test's node in the graph is noted the same way.
    const questions = [...mattersAsked, ...shown.map((id, at) => ({ ...killsTemplate, name: `kills_${at + 1}`, ask: `This question is about test ${at + 1}, \`${id}\`. ${killsTemplate.ask}` }))];
    const build = budget => fitState((limit, count) => {
      const nodes = reaching.slice(0, count).flatMap((item, at) => [
        { id: item.id, path: item.node.path, source: excerpt(item.node, item.lines, limit), note: `test ${at + 1}` },
        ...macros[at].slice(0, 2).map(macro => ({ id: macro.id, path: macro.path, source: macro.source.split('\n').slice(0, limit).join('\n'), note: MACRO })),
      ]);
      return {
        method: { path: node.path, name: node.qualified_name, source: sourceOf(node, lines), mutation: { kind: mutant.kind, original: mutant.original.trim(), mutated: mutant.mutated.trim() } },
        graph: { nodes, edges: edgesAmong(graph, [node.id, ...nodes.map(item => item.id)]) },
      };
    }, budget, `method ${node.qualified_name}`);
    return answer({ subject: 'method', node, build, typed: () => compile(questions), questions });
  }, mutantRows, methodProgress);
  for (const unit of mutantUnits) {
    const row = mutantRows.get(unit.id);
    if (!row) continue;
    if (!mutants.has(unit.method.id)) mutants.set(unit.method.id, []);
    mutants.get(unit.method.id).push({ mutant: unit.mutant, matters: row.answers.matters, kills: unit.shown.map((id, at) => [id, row.answers[`kills_${at + 1}`]]) });
  }

  // Every request failed and none answered, which is an outage or a refusal, not a repository with nothing to say.
  if (failures && !asked) throw new Error(`nothing could be asked: ${failures} failed; last error: ${failed.at(-1).error}`);
  return { tests, mutants, failed, asked };
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
  // The tests that could go: checking nothing, or repeating another. One whose problem was closed is one someone chose to keep,
  // and one that could not be asked about is not said to check nothing.
  const dropped = new Set(coverage.tests.filter(test => (judged.checksNothing.has(test.id) && !isClosed('checks_nothing', test.id))
    || (judged.redundantWith.has(test.id) && !isClosed('redundant', test.id))).map(test => test.id));

  const methods = coverage.methods.map(method => {
    const { node } = method;
    const usefulTests = method.tests.filter(item => judged.useful.has(item.id)).map(item => item.id);
    // Each mutant: how likely it is that no test shown kills it, and that it changes behaviour at all. A mutant is killed when
    // some test is likely enough to fail against it; one that survives, and matters, is listed.
    const mutants = (answers.mutants.get(method.id) ?? []).map(({ mutant, matters, kills }) => {
      const survives = kills.reduce((total, [, p]) => total * (1 - p), 1);
      const id = mutantId(mutant);
      const item = { id, kind: mutant.kind, line: mutant.line, column: mutant.column, from: mutant.from, to: mutant.to, original: mutant.original, mutated: mutant.mutated,
        matters, survives, killed: 1 - survives >= min, killed_by: kills.filter(([, p]) => p >= min).map(([testId]) => testId), asked: kills.map(([testId]) => testId), finding: null };
      const count = kills.length;
      item.finding = add({ kind: 'survived', subject: 'method', unit: method.id, key: `${method.id}#${id}`, path: node.path, line: mutant.line, name: node.qualified_name,
        probability: survives * matters, mutant: id,
        note: `With ${describeMutant(mutant)}, ${count === 1 ? 'the 1 test reaching it still passes' : `none of the ${count} tests reaching it fails`}.` });
      return item;
    });
    return { id: method.id, path: node.path, name: node.qualified_name, line: node.line, end_line: node.end_line, risk: node.metrics?.risk_score ?? null,
      branches: method.branches, tests: method.tests, useful: usefulTests,
      mutants, killed: mutants.filter(item => item.killed).length, findings: mutants.map(item => item.finding).filter(Boolean) };
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
    const leaks = test.evidence.filter(item => LEAKS.has(item.category));
    const shown = leaks.slice(0, 3).map(item => `${item.name} at ${item.path}:${item.line}`).join(', ');
    // The call graph finds the network and database calls a test can reach; the answer decides whether it makes one to a live
    // service. A test that could not be asked keeps what the call graph found, with no probability, and is listed under failures.
    if (leaks.length) own.push(add({ kind: 'infra', subject: 'test', unit: test.id, path: node.path, line: node.line, name: node.qualified_name,
      probability: said?.infra ?? null, note: `Calls a live service with nothing mocked: ${shown}.` }));
    return { id: test.id, path: node.path, name: node.case.name, suite: node.case.suite, line: node.line, end_line: node.end_line, framework: node.case.framework,
      direct: test.direct, reach: test.reach, cuts: test.cuts, touches: test.touches, unresolved: test.unresolved ?? null,
      infra: said?.infra ?? null,
      asked: judged.asked.get(test.id) ?? 0, kills: judged.kills.get(test.id) ?? [],
      useful: judged.useful.has(test.id), redundant_with: keptId, findings: own.filter(Boolean) };
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
    const mutants = methodList.reduce((total, method) => total + method.mutants.length, 0), killed = methodList.reduce((total, method) => total + method.killed, 0);
    return { methods: methodList.length, reached: methodList.filter(method => method.tests.length).length, useful_reached: methodList.filter(method => method.useful.length).length,
      mutants, killed, score: mutants ? killed / mutants : null, survived: count(methodIds, 'survived'),
      tests: testList.length, useful: testList.filter(test => test.useful).length,
      redundant: testList.filter(test => test.redundant_with).length, weak: testList.filter(test => judged.checksNothing.has(test.id)).length, infra: count(testIds, 'infra') };
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
  return { version: 2, revision, root, target: label, github, created_at: createdAt, model, depth: coverage.depth, min,
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

const DIFF_TOTALS = ['methods', 'reached', 'mutants', 'killed', 'score', 'survived', 'tests', 'useful', 'redundant', 'weak', 'infra'];
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
  const state = method => (method ? { reached: method.tests.length > 0, mutants: method.mutants.length, killed: method.killed } : null);
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
  min = 0.5, diff = null, since = null, scanProgress = () => {}, testProgress = () => {}, methodProgress = () => {}, log = () => {}, debug = () => {} }) {
  const walk = depth ?? DEFAULT_DEPTH;
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
  const coverage = computeCoverage({ scan, graph, depth: walk, inScope, named: chosen, runs: path => !scope || scope.test(path) });
  const linesOf = lineReader(root, graph);
  const answers = await askCoverage({ coverage, graph, linesOf, systemOne, min, parallel, testProgress, methodProgress, log, debug });
  const lines = new Map();
  for (const file of coverage.files) lines.set(file.path, await linesOf({ path: file.path }));
  const report = buildReport({ coverage, answers, lines, revision, root, label, github, model: systemOne.id, min, closed: await openStore(out).closures() });
  if (scope) report.scope = { frameworks: scope.frameworks, tests: scope.tests, sources: scope.sources, left_out: scope.left_out, left_out_sample: scope.left_out_sample };
  if (changed) report.branch = branchOf(report, { ref: since, ...changed });
  // --since already says what the branch changed. The last saved run is some other commit, so it is
  // compared with only when --diff names it.
  const baseline = requested ?? (since ? null : await findBaseline({ out, root, revision }));
  if (baseline) { report.baseline = { revision: baseline.revision, created_at: baseline.created_at }; report.diff = diffReports(baseline, report); }
  await saveCoverageReport(out, report);
  return report;
}
