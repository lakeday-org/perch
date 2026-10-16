/**
 * `perch coverage`: mutation testing that runs the repository's own tests, with a model to say which survivors matter.
 *
 * A runner runs the suite once in a copy of the repository at the commit, recording which lines each test runs. Each method's
 * mutants, one-token edits read off its syntax tree (mutants.js), are planted one at a time in a copy and run against exactly
 * the tests that run their lines. A test that fails kills the mutant. Jev is asked only about the survivors: whether a caller
 * could ever see the change. A test that kills nothing it runs checks nothing, and two tests in one file that kill exactly the
 * same mutants are one test written twice; both come from the run. The call graph says what each test reaches for the questions
 * the run cannot answer: whether a test can reach a live service, and whether it mocks everything it calls.
 *
 * A survivor or a test that cannot be asked about is recorded as failed and stays in the report as failed, with no probability,
 * since a report that quietly fills in what it could not find out reads as complete.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { changedLines, listTree, readBlob, revision as commitOf } from './git.js';
import { analyzeTree } from './analyze.js';
import { frameworkScope } from './test-scope.js';
import { TOP_LEVEL } from './analysis.js';
import { buildGraph } from './graph.js';
import { AuthenticationError } from './systemone.js';
import { compile, parseQuestions, readAnswer } from './ask.js';
import { excerpt, leadingComment, shownLines, spanOf } from './questions.js';
import { identity, openStore } from './store.js';
import { estimateTokens, IncompleteCheckError, TOKEN_LIMITS, withTokenRetries } from './tokens.js';
import { matches, readIgnored } from './units.js';
import { covers } from './scan.js';
import { describeMutant, mutantId, mutantsOf } from './mutants.js';
import { copiesOf, runnersFor } from './runners/index.js';
import { sandboxKind } from './runners/sandbox.js';

/** Tests or methods in flight at once. */
export const DEFAULT_PARALLEL = 8;
/** How many neighbours a test's state shows at most: the methods it reaches, and its helpers. */
export const MAX_SHOWN = 8;

/** The questions perch asks about tests and methods, read once from the file they are declared in. */
/** What an answer is kept under: what was shown, which questions were asked, and who answered. Any of them changing asks again. */
const QUESTIONS = parseQuestions(readFileSync(new URL('../coverage.yaml', import.meta.url), 'utf8'), 'coverage.yaml');

/** What is asked of tests and of methods. */
export const coverageQuestions = () => ({ test: QUESTIONS.filter(question => question.each === 'test'), method: QUESTIONS.filter(question => question.each === 'method') });
const questionNamed = name => QUESTIONS.find(question => question.name === name);
/** What a node in a test's request is, when it is not code the test reaches: a helper of its own. */
const HELPER = "the test's own helper, which it calls through to the code under test";


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
export function computeCoverage({ scan, graph, inScope = () => true, runs = () => true, named = inScope, run = null }) {
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
    // A test that ran code in scope is the suite's, whatever the graph found it reaching.
    const ranInScope = [...(run?.executed.get(node.id)?.keys() ?? [])].some(path => inScope(path));
    if (!named(node.path) && !ranInScope && !reached.some(item => inScopeIds.has(item.id))) continue;
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
  const units = methods.sort(byPosition).map(node => ({ id: node.id, node, language: graph.files.get(node.path)?.file.language, branches: node.branches,
    tests: (reachedBy.get(node.id) ?? []).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)) }));
  // A file the parser could not read has tests and methods nobody can see, and says so rather than looking empty.
  for (const item of scan.coverage?.parser_diagnostics ?? []) {
    if (item.status === 'parsed' || !inScope(item.path)) continue;
    failed.push({ unit: item.path, subject: 'file', path: item.path, name: item.path, error: item.message ?? item.status });
  }
  const paths = new Set([...units.map(unit => unit.node.path), ...tests.map(test => test.node.path)]);
  const files = scan.files.filter(file => paths.has(file.path)).sort((a, b) => a.path.localeCompare(b.path));
  const coverage = { tests, methods: units, files, failed };
  if (run) measured(coverage, graph, run);
  return coverage;
}

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
 * What the runner's suite run says about each test and method: the lines each test ran, its worst result, and the tests that ran
 * each method's body. `run.executed` is each test's lines by file, by perch's test id; `run.results` each case the runner ran, with
 * the test it belongs to. A test id the run names that the parse has no test for is listed in `unmatched`.
 */
function measured(coverage, graph, { executed, results }) {
  const statuses = new Map();
  for (const result of results.values()) statuses.set(result.test, [...(statuses.get(result.test) ?? []), result.status]);
  for (const test of coverage.tests) {
    test.executed = executed.get(test.id) ?? new Map();
    test.status = statuses.has(test.id) ? worst(statuses.get(test.id)) : null;
  }
  const known = id => graph.nodes.get(id)?.case;
  coverage.unmatched = [...new Set([...executed.keys(), ...[...results.values()].map(result => result.test)])].filter(id => !known(id)).sort();
  for (const method of coverage.methods) {
    const { from, to } = bodyLines(method.node);
    const depthOf = new Map(method.tests.map(item => [item.id, item.depth]));
    method.tests = coverage.tests.filter(test => [...(test.executed.get(method.node.path) ?? [])].some(line => line >= from && line <= to))
      .map(test => ({ id: test.id, depth: depthOf.get(test.id) ?? 1 })).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  }
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
 * Which tests are worth keeping, from what each did against the mutants it ran. `mutants` is each method's mutants with, per
 * mutant, `kills`: every test that ran it, with 1 when the test failed and 0 when it passed. A test that ran two mutants or more
 * and failed against none checks nothing. Among the tests left, two in one file that ran the same three mutants or more and
 * failed against exactly the same ones, at least one, are one test written twice, and the first by line is kept: tests in
 * different files reach the same code from different callers.
 */
export function judgeTests(tests, mutants) {
  // A test that runs a mutant a branch run left unrun, or one it was not run against once another test had killed it, has not
  // said everything about those, and is judged on nothing.
  const incomplete = new Set([...mutants.values()].flat().filter(item => item.skipped).flatMap(item => item.tests));
  for (const item of [...mutants.values()].flat()) {
    if (!item.covers || item.timeout || item.invalid) continue;
    const run = new Set(item.kills.map(([testId]) => testId));
    for (const testId of item.covers) if (!run.has(testId)) incomplete.add(testId);
  }
  const ran = new Map();
  for (const [methodId, list] of mutants) for (const item of list) for (const [testId, failed] of item.kills) {
    if (!ran.has(testId)) ran.set(testId, []);
    ran.get(testId).push({ key: `${methodId}#${mutantId(item.mutant)}`, killed: failed === 1 });
  }
  const checksNothing = new Set([...ran].filter(([testId, list]) => !incomplete.has(testId) && list.length >= 2 && !list.some(item => item.killed)).map(([testId]) => testId));
  const redundantWith = new Map(), byKills = new Map();
  for (const test of [...tests].sort((a, b) => a.node.path.localeCompare(b.node.path) || a.node.line - b.node.line)) {
    const list = ran.get(test.id);
    if (!list || list.length < 3 || incomplete.has(test.id) || checksNothing.has(test.id) || !list.some(item => item.killed)) continue;
    const key = `${test.node.path}\0${JSON.stringify([...list].sort((a, b) => a.key.localeCompare(b.key)).map(item => [item.key, item.killed]))}`;
    if (byKills.has(key)) redundantWith.set(test.id, byKills.get(key));
    else byKills.set(key, test.id);
  }
  const kills = new Map([...ran].map(([testId, list]) => [testId, list.filter(item => item.killed).map(item => item.key)]));
  const useful = new Set(tests.filter(test => !checksNothing.has(test.id) && !redundantWith.has(test.id)).map(test => test.id));
  // How many mutants each test runs, whether or not it was run against every one.
  const asked = new Map();
  for (const item of [...mutants.values()].flat()) if (item.covers && !item.timeout && !item.invalid) for (const testId of item.covers) asked.set(testId, (asked.get(testId) ?? 0) + 1);
  for (const [testId, list] of ran) if (!asked.has(testId)) asked.set(testId, list.length);
  return { useful, checksNothing, redundantWith, kills, asked };
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
export async function askCoverage({ coverage, graph, linesOf, systemOne, parallel = DEFAULT_PARALLEL, ran,
  testProgress = () => {}, methodProgress = () => {}, log = () => {}, debug = () => {} }) {
  const { test: testAsked } = coverageQuestions();
  const mattersAsked = [questionNamed('matters')];
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

  // The mutants the test run left alive, each asked whether a caller could see the change.
  await triage({ coverage, graph, linesOf, ran, mutants, settle, answer, mattersAsked, neighbourSource, methodProgress });
  // Every request failed and none answered, which is an outage or a refusal, not a repository with nothing to say.
  if (failures && !asked) throw new Error(`nothing could be asked: ${failures} failed; last error: ${failed.at(-1).error}`);
  return { tests, mutants, failed, asked };
}

/**
 * Each covered method's mutants, and for each the tests that run it: those the suite run saw run one of the lines its edit is in.
 * An edit in the signature, such as a default value, runs whenever the function does, so every test that runs the method runs
 * it. A mutant no test runs has no coverage, and goes in `uncovered`. A test that did not pass before anything was changed can
 * kill nothing, and is left out.
 */
async function planMutants({ coverage, generated, base }) {
  const byTest = new Map(coverage.tests.map(test => [test.id, test]));
  const units = [], uncovered = new Set();
  for (const method of coverage.methods) {
    const { node } = method;
    const tests = method.tests.map(item => item.id).filter(id => byTest.get(id).status === 'passed');
    // A runner that wrote the method's mutants into the code with switches says exactly which test reached each; otherwise the
    // lines each test ran do.
    const exact = base.hitMethods?.has(method.id);
    for (const mutant of generated.get(method.id)) {
      const key = `${method.id}#${mutantId(mutant)}`;
      // An edit with no place to run is run anyway, by the tests of its method, so it is reported invalid and not uncovered.
      const running = exact ? (base.unplaced?.has(key) ? tests : tests.filter(id => base.hits.get(id)?.has(key)))
        : mutant.statements.length ? tests.filter(id => mutant.statements.some(line => byTest.get(id).executed.get(node.path)?.has(line))) : tests;
      // An edit the compiler rejects is invalid whether or not a test reaches it, as Stryker counts a compile error.
      if (!running.length && !(exact && base.unplaced?.has(key))) { uncovered.add(mutant); continue; }
      units.push({ id: key, node, method, mutant, tests: running, language: method.language });
    }
  }
  return { units, uncovered };
}

/** Every mutant of every method, by method id, made before anything runs: a runner that writes them all into the code needs them first. */
export async function generateMutants({ methods, graph, sourceText }) {
  const generated = new Map();
  // A function inside another is a method of its own, and its edits are made once, in it: the one around it would make them
  // again, and each would be counted and run twice.
  const made = new Set();
  const sized = [...methods].sort((a, b) => (a.node.end_line - a.node.line) - (b.node.end_line - b.node.line));
  for (const method of sized) {
    const { node } = method;
    const mutants = mutantsOf({ source: await sourceText(node.path), language: graph.files.get(node.path)?.file.language, line: node.line, end_line: node.end_line });
    generated.set(method.id, mutants.filter(mutant => {
      const key = `${node.path}\0${mutantId(mutant)}`;
      return !made.has(key) && made.add(key);
    }));
  }
  return new Map(methods.map(method => [method.id, generated.get(method.id)]));
}

/**
 * Every planned mutant run for real, through the runner's session: started once, it takes each mutant as the mutated file's text
 * and the tests that run it, `parallel` at a time. A mutant is killed when one of its tests fails or the run passes its time
 * limit; invalid when the mutated code could not even be loaded, which says the edit broke the code rather than that a test
 * caught it.
 *
 * A mutant's run stops at the first test that fails, as Stryker's does, with the tests that have killed nothing yet first, so
 * every test gets its chance to be the one. What the tests are worth is then settled with as few runs again as it takes: a test
 * that killed nothing runs alone against the rest of its mutants until it kills one, or has run them all and checks nothing;
 * and tests in one file that run exactly the same mutants run against all of them, so whether they kill the same ones is known.
 *
 * `ran` is each method's mutants in order: `{ mutant, uncovered }` for one no test ran, else `{ mutant, status, kills, covers }`,
 * `covers` the tests that run it and `kills` each of them it was run against, 1 for a failure and 0 for a pass.
 */
export async function runMutants({ coverage, generated, sourceText, runner, tool, copies, base, parallel, known = new Map(), keyOf = () => null, only = () => true,
  progress = () => {}, debug = () => {} }) {
  const nodesOf = new Map(), timeOf = new Map();
  for (const [node, result] of base.results) {
    if (result.status !== 'passed') continue;
    if (!nodesOf.has(result.test)) nodesOf.set(result.test, []);
    nodesOf.get(result.test).push(node);
    timeOf.set(node, result.time);
  }
  const secondsOf = new Map([...nodesOf].map(([test, nodes]) => [test, nodes.reduce((sum, node) => sum + (timeOf.get(node) ?? 0), 0)]));
  const { units: planned, uncovered } = await planMutants({ coverage, generated, base });
  const results = new Map(), files = new Map(), outcomes = new Map(), byId = new Map(planned.map(unit => [unit.id, unit]));
  // A mutant whose code, tests, and every file those tests ran are as they were when it last ran has that run's outcome; one
  // outside what was asked for, on a branch, and with no such outcome, is not run.
  const units = [];
  for (const unit of planned) {
    unit.key = keyOf(unit);
    const before = unit.key && known.get(unit.key);
    if (before) results.set(unit.id, { ...before, covers: unit.tests, reused: true });
    else if (only(unit)) units.push(unit);
    else results.set(unit.id, { status: 'skipped', kills: [], tests: unit.tests });
  }
  // The file as committed, which the mutants were made from: a runner may have written its copy over.
  const fileOf = path => { if (!files.has(path)) files.set(path, sourceText(path).then(text => Buffer.from(text))); return files.get(path); };
  const credited = new Set();
  for (const result of results.values()) for (const [test, failed] of result.kills) if (failed) credited.add(test);

  /** The tests that failed and that passed in a run that ran. */
  const verdicts = outcome => {
    const failed = new Set(), passed = new Set();
    for (const [, result] of outcome.results) (result.status === 'failed' || result.status === 'error' ? failed : passed).add(result.test);
    return { failed, passed };
  };
  /** One run of `tests` against the unit's mutant; its outcome is folded into what the unit has. */
  const runOnce = async (session, unit, tests, bail) => {
    const { node, mutant } = unit;
    const mutated = applyMutant(await fileOf(node.path), mutant);
    // Stryker's limit: half as long again as the tests took unmutated, and five seconds. A mutant that makes a loop never end
    // is caught by it.
    const run = (list, stop) => session.run({ path: node.path, source: mutated, mutant, method: unit.method, nodes: list.flatMap(id => nodesOf.get(id)),
      timeout: Math.round((list.reduce((sum, id) => sum + secondsOf.get(id), 0) * 1.5 + 5) * 1000), bail: stop, language: unit.language });
    const outcome = mutated ? await run(tests, bail) : { status: 'invalid' };
    const had = results.get(unit.id);
    if (outcome.status !== 'ran') {
      // A later run that timed out or would not load says nothing more about the tests; the first decides the mutant.
      if (!had) results.set(unit.id, { status: outcome.status, kills: [], covers: unit.tests });
      return outcome;
    }
    const { failed, passed } = verdicts(outcome);
    // A test can fail for the machine rather than the mutant: every worker at once can run out of local ports, or a timer fire
    // late. A failure counts once the test fails again, run by itself against the same mutant; one that passes then is set
    // aside, and the tests a stopped run never reached run in its place.
    if (failed.size) {
      const again = await run([...failed], false);
      const flaky = again.status === 'ran' ? [...failed].filter(id => verdicts(again).passed.has(id)) : [];
      for (const id of flaky) failed.delete(id);
      if (flaky.length) debug(`${unit.node.qualified_name} ${describeMutant(mutant)}: ${flaky.join(', ')} failed once and passed again, so it is not counted`);
      if (bail && flaky.length && !failed.size) {
        const rest = tests.filter(id => !passed.has(id) && !flaky.includes(id));
        if (passed.size) foldIn(unit, tests, failed, passed);
        return rest.length ? runOnce(session, unit, rest, bail) : outcome;
      }
    }
    foldIn(unit, tests, failed, passed);
    return outcome;
  };
  /** What a run said about each of `tests`, folded into what the unit has. */
  const foldIn = (unit, tests, failed, passed) => {
    const had = results.get(unit.id);
    const kills = new Map(had?.kills ?? []);
    for (const id of tests) if (failed.has(id) || passed.has(id)) kills.set(id, failed.has(id) ? 1 : 0);
    for (const id of failed) credited.add(id);
    results.set(unit.id, { status: had?.status ?? 'ran', kills: unit.tests.filter(id => kills.has(id)).map(id => [id, kills.get(id)]), covers: unit.tests });
  };
  const pool = async (items, work) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, async () => { while (next < items.length) await work(items[next++]); }));
  };

  let done = 0;
  progress(0, units.length);
  const session = units.length ? await runner.session({ copies, tool, parallel }) : null;
  try {
    // Every mutant, stopping at its first failure: the tests that have killed nothing yet first, then the quickest.
    await pool(units, async unit => {
      const order = [...unit.tests].sort((a, b) => Number(credited.has(a)) - Number(credited.has(b)) || secondsOf.get(a) - secondsOf.get(b));
      const outcome = await runOnce(session, unit, order, true);
      const killed = results.get(unit.id).kills.some(([, failed]) => failed);
      debug(`${unit.node.qualified_name} ${describeMutant(unit.mutant)}: ${outcome.status}${outcome.error ? ` (${outcome.error.trim().split('\n').at(-1)})` : ''}${killed ? ' killed' : ''}`);
      progress(++done, units.length);
    });
    if (session) {
      // Which mutants each test runs, among those that ran, and which it has not been run against yet.
      const coversOf = new Map();
      for (const [id, result] of results) {
        if (result.status !== 'ran') continue;
        for (const test of result.covers) { if (!coversOf.has(test)) coversOf.set(test, []); coversOf.get(test).push(id); }
      }
      const unknown = test => coversOf.get(test).filter(id => !results.get(id).kills.some(([other]) => other === test));
      // A test that killed nothing: alone against the rest of its mutants, until it kills one.
      const idle = [...coversOf.keys()].filter(test => !credited.has(test) && coversOf.get(test).length >= 2 && unknown(test).length);
      debug(`running ${idle.length} tests that killed nothing against the rest of their mutants`);
      await pool(idle, async test => {
        for (const id of unknown(test)) {
          if (credited.has(test)) break;
          await runOnce(session, byId.get(id), [test], true);
        }
      });
      // Tests in one file that run exactly the same mutants, three or more: each against all of them, to compare what they kill.
      const groups = Map.groupBy([...coversOf.keys()].filter(test => coversOf.get(test).length >= 3), test => `${test.split('::')[0]}\0${[...coversOf.get(test)].sort().join('\0')}`);
      // Tests in a group part on the first mutant they do differently against, so the group first runs a few of the mutants one of
      // its tests is known to kill, the likeliest to part them, all at once. Only tests still alike after that, which may be one
      // written twice, run every mutant they have not; one run per mutant, of every test that still needs it.
      const outcomeOf = (test, id) => results.get(id).kills.find(([other]) => other === test)?.[1];
      const alike = (a, b) => coversOf.get(a).every(id => { const x = outcomeOf(a, id), y = outcomeOf(b, id); return x === undefined || y === undefined || x === y; });
      const settling = [...groups.values()].filter(group => group.length > 1);
      const parting = settling.flatMap(group => coversOf.get(group[0]).filter(id => group.some(test => outcomeOf(test, id) === 1)).slice(0, 3)
        .map(id => ({ id, tests: group.filter(test => outcomeOf(test, id) === undefined) })).filter(item => item.tests.length));
      debug(`running ${parting.length} mutants against groups of tests that run exactly the same mutants, to part them`);
      await pool(parting, ({ id, tests }) => runOnce(session, byId.get(id), tests, false));
      const fill = new Map();
      for (const group of settling) {
        for (const test of group.filter(item => group.some(other => other !== item && alike(item, other)))) {
          for (const id of unknown(test)) { if (!fill.has(id)) fill.set(id, []); fill.get(id).push(test); }
        }
      }
      debug(`running ${fill.size} mutants again against the tests still alike, to compare them`);
      await pool([...fill], ([id, tests]) => runOnce(session, byId.get(id), tests, false));
    }
  } finally { await session?.close(); }
  for (const unit of planned) if (unit.key && results.get(unit.id).status !== 'skipped') outcomes.set(unit.key, results.get(unit.id));
  const ran = new Map();
  for (const [methodId, list] of generated) {
    ran.set(methodId, list.map(mutant => (uncovered.has(mutant) ? { mutant, uncovered: true } : { mutant, ...results.get(`${methodId}#${mutantId(mutant)}`) })));
  }
  return { ran, outcomes };
}

/** The files whose content decides a run's outcomes besides the code: what the dependencies are, and how the tests are set up. */
const MANIFESTS = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|pyproject\.toml|setup\.(py|cfg)|tox\.ini|pytest\.ini|requirements[^/]*\.txt|poetry\.lock|uv\.lock|Pipfile(\.lock)?|conftest\.py|Cargo\.(toml|lock)|go\.(mod|sum)|[^/]+\.(csproj|fsproj|sln)|Directory\.(Build|Packages)\.props|Package\.(swift|resolved)|pom\.xml|build\.gradle(\.kts)?|vitest\.config\.[^/]+|jest\.config\.[^/]+|\.mocharc[^/]*|tsconfig[^/]*\.json)$/;

/**
 * Each mutant's fingerprint for reusing its outcome: the runner, the method, the edit, the tests that run it, and the content, by
 * git's blob id, of every file those tests ran, the tests' own files, and the manifests. Whatever changed in any of those, the
 * mutant runs again.
 */
function outcomeKeys({ runner, tree, coverage }) {
  const shaOf = new Map(tree.map(item => [item.path, item.sha]));
  const manifests = tree.filter(item => MANIFESTS.test(item.path)).map(item => `${item.path}\0${item.sha}`).sort();
  const byTest = new Map(coverage.tests.map(test => [test.id, test]));
  return unit => {
    const paths = new Set([unit.node.path]);
    for (const id of unit.tests) { const test = byTest.get(id); paths.add(test.node.path); for (const path of test.executed.keys()) paths.add(path); }
    const files = [...paths].sort().map(path => `${path}\0${shaOf.get(path) ?? ''}`);
    return createHash('sha256').update(JSON.stringify([runner.name, unit.method.id, mutantId(unit.mutant), unit.mutant.from, unit.mutant.to, [...unit.tests].sort(), files, manifests])).digest('hex');
  };
}

/** The outcomes saved by the last run, by fingerprint. */
async function readOutcomes(out) {
  return new Map(await openStore(out).readLines(coveragePaths(out).outcomes));
}

/** This run's outcomes, replacing the last run's, so the file holds what the code at this commit gives and nothing older. */
async function saveOutcomes(out, outcomes) {
  await openStore(out).writeLines(coveragePaths(out).outcomes, [...outcomes].map(([key, { status, kills }]) => [key, { status, kills }]));
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
      : { mutant: item.mutant, matters: rows.get(`${methodId}#${mutantId(item.mutant)}`) ?? null, kills: item.kills, covers: item.covers,
        ...(item.status === 'timeout' ? { timeout: true } : {}), ...(item.status === 'invalid' ? { invalid: true } : {}),
        ...(item.status === 'skipped' ? { skipped: true, tests: item.tests } : {}) })));
  }
}


const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const findingIdOf = (kind, unit) => identity('coverage', kind, unit).slice(0, 8);

/**
 * The report every view of a run reads: the terminal tables, the HTML page and the diff against the next run. Everything in it is
 * counted from the coverage, the answers and the lines it is given; nothing is looked up again.
 */
export function buildReport({ coverage, answers, lines, revision, root, label = root, github = null, createdAt = new Date().toISOString(), model = null, min = 0.5, usage = {}, closed = new Map() }) {
  const judged = judgeTests(coverage.tests, answers.mutants);
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
    // Each mutant as the test run left it: killed when a test that runs it failed, or the run passed its time limit; survived
    // when every test that runs it passed. A survivor is listed when the model says a caller could see the change, and left out
    // of the score as equivalent when it says none could. A mutant no test runs has no coverage, and counts against the score.
    const mutants = (answers.mutants.get(method.id) ?? []).map(({ mutant, matters, kills, covers = [], uncovered, timeout, invalid, skipped }) => {
      const id = mutantId(mutant);
      const base = { id, kind: mutant.kind, line: mutant.line, column: mutant.column, from: mutant.from, to: mutant.to, original: mutant.original, mutated: mutant.mutated };
      // An edit the code cannot be built or loaded with broke the code: it is no mutant a test could catch or miss, reached or
      // not, and is left out of the score, as Stryker leaves out a compile error.
      if (invalid) return { ...base, matters: null, survives: null, killed: false, invalid: true, killed_by: [], asked: [], finding: null };
      if (!covered || uncovered) return { ...base, matters: null, survives: null, killed: false, no_coverage: true, killed_by: [], asked: [], finding: null };
      // Outside what a branch run asked for, with no outcome saved from before: not run, and left out of the score.
      if (skipped) return { ...base, matters: null, survives: null, killed: false, skipped: true, killed_by: [], asked: [], finding: null };
      // A run that passed its time limit is caught: the edit made something never finish, which a test run notices. fails is
      // each test's result in asked's order, 1 for a failure and 0 for a pass.
      const killed = Boolean(timeout) || kills.some(([, failed]) => failed === 1);
      const equivalent = !killed && matters !== null && matters < min;
      const item = { ...base, matters, survives: killed ? 0 : 1, killed, ...(equivalent ? { equivalent: true } : {}), killed_by: kills.filter(([, failed]) => failed === 1).map(([testId]) => testId),
        // asked is every test that runs it; fails each one's result against it, null for one never run once another had failed.
        asked: covers, fails: covers.map(testId => kills.find(([id]) => id === testId)?.[1] ?? null), ...(timeout ? { timeout: true } : {}), finding: null };
      const count = kills.length;
      // A survivor the model could not be asked about is still listed, with no probability, and the failure is listed with it.
      if (!killed) item.finding = add({ kind: 'survived', subject: 'method', unit: method.id, key: `${method.id}#${id}`, path: node.path, line: mutant.line, name: node.qualified_name,
        probability: matters, mutant: id,
        note: `With ${describeMutant(mutant)}, ${count === 1 ? 'the 1 test that runs it still passes' : `none of the ${count} tests that run it fails`}.` });
      return item;
    });
    // The tests asked about its mutants: every test that may run it, where `tests` holds every test that reaches it at all.
    const askedTests = new Set(mutants.flatMap(item => item.asked)).size;
    return { id: method.id, path: node.path, name: node.qualified_name, line: node.line, end_line: node.end_line, risk: node.metrics?.risk_score ?? null,
      branches: method.branches, tests: method.tests, asked_tests: askedTests, useful: usefulTests, covered,
      mutants, killed: mutants.filter(item => item.killed).length, equivalent: mutants.filter(item => item.equivalent).length, invalid: mutants.filter(item => item.invalid).length, skipped: mutants.filter(item => item.skipped).length, findings: mutants.map(item => item.finding).filter(Boolean) };
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
      own.push(add({ kind: 'redundant', subject: 'test', unit: test.id, path: node.path, line: node.line, name: node.qualified_name, probability: 1,
        note: `Kills the same mutants as ${like}, and no others.` }));
    }
    if (judged.checksNothing.has(test.id)) own.push(add({ kind: 'checks_nothing', subject: 'test', unit: test.id, path: node.path, line: node.line, name: node.qualified_name,
      probability: 1, note: `Kills none of the ${plural(judged.asked.get(test.id), 'mutant')} in the code it reaches.` }));
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
    const invalid = methodList.reduce((total, method) => total + method.invalid, 0), skipped = methodList.reduce((total, method) => total + method.skipped, 0);
    const mutants = methodList.reduce((total, method) => total + method.mutants.length, 0) - equivalent - invalid - skipped, killed = methodList.reduce((total, method) => total + method.killed, 0);
    const no_coverage = methodList.reduce((total, method) => total + method.mutants.filter(item => item.no_coverage).length, 0);
    return { methods: methodList.length, covered: methodList.filter(method => method.covered).length, useful_covered: methodList.filter(method => method.useful.length).length,
      mutants, killed, equivalent, invalid, skipped, no_coverage, score: mutants ? killed / mutants : null, covered_score: mutants - no_coverage ? killed / (mutants - no_coverage) : null, survived: count(methodIds, 'survived'),
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

const DIFF_TOTALS = ['methods', 'covered', 'mutants', 'killed', 'equivalent', 'invalid', 'no_coverage', 'score', 'covered_score', 'survived', 'tests', 'useful', 'redundant', 'weak', 'infra'];
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
  return { dir, reports: join(dir, 'reports'), latest: join(dir, 'latest.jsonl'), html: join(dir, 'index.html'), outcomes: join(dir, 'outcomes.jsonl') };
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
  min = 0.5, diff = null, since = null, runner: given = null, scanProgress = () => {}, testProgress = () => {}, methodProgress = () => {}, log = () => {}, debug = () => {} }) {
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
  const tree = await listTree(root, revision);
  const scope = await frameworkScope({ root, tree, scan, graph, ignored: path => ignored.some(glob => matches(glob, path)), debug });
  for (const framework of scope?.frameworks ?? []) if (framework.error) log(`could not load ${framework.config}: ${framework.error}`);
  // The repository's own tests, run by perch: once for which tests run each line, then once per mutant. Nothing is estimated: a
  // repository whose tests perch cannot run is one it cannot measure, and it says what is missing.
  const runner = given ?? await runnersFor({ scope, root, graph });
  if (!runner) throw new Error(`perch coverage runs your tests itself, and has no runner for ${(scope?.frameworks ?? []).filter(item => item.tests).map(item => item.name).join(', ') || 'what it found'} yet; it runs pytest, Vitest, Jest, Mocha, Jasmine, Karma, Cucumber, node:test, cargo, go test, dotnet test, and JUnit, TestNG, ScalaTest and MUnit on Gradle, Maven or sbt`);
  const tool = await runner.available({ root });
  if (tool.reason) throw new Error(`${runner.name} cannot run here: ${tool.reason}`);
  if (!sandboxKind()) log(`${runner.name} runs unsandboxed here: install bubblewrap so a mutated test can write only inside its copy`);
  // Only the code of the languages the runner runs: a TypeScript file in a repository whose pytest suite perch runs is no test of
  // that suite's to cover, and its own tests are a framework perch cannot run yet.
  const languageOf = path => graph.files.get(path)?.file.language;
  const runnable = path => runner.languages.has(languageOf(path));
  const otherwise = (scope?.tests ? [...new Set(scan.files.filter(file => file.test && !runnable(file.path)).map(file => file.language))] : []);
  if (otherwise.length) log(`perch has no runner for the ${otherwise.join(', ')} tests here yet, so the code only they test is left out`);
  const chosen = path => covered(path) && !ignored.some(glob => matches(glob, path));
  const inScope = path => chosen(path) && (!scope || scope.source(path)) && runnable(path);
  const runs = path => (!scope || scope.test(path)) && runnable(path);
  const linesOf = lineReader(root, graph);
  let coverage, ran, measured;
  const { copies, remove } = await copiesOf({ root, revision, count: runner.copiesFor(parallel) });
  try {
    const sourceText = async path => (await linesOf({ path })).join('\n');
    const generated = await generateMutants({ methods: computeCoverage({ scan, graph, inScope, named: chosen, runs }).methods, graph, sourceText });
    await runner.prepare?.({ copies, generated, graph, tool });
    debug(`running ${runner.name} once with per-test coverage`);
    const base = await runner.coverageRun({ copy: copies[0].dir, scratch: copies[0].scratch, tool, copies });
    coverage = computeCoverage({ scan, graph, inScope, named: chosen, runs, run: base });
    if (coverage.unmatched.length) log(`${runner.name} ran ${coverage.unmatched.length} tests perch found no test for, so what they kill is not counted: ${coverage.unmatched.slice(0, 3).join(', ')}${coverage.unmatched.length > 3 ? ', ...' : ''}`);
    // On a branch, the mutants in code it changed and the ones its changed tests run; the rest only where an outcome is saved.
    const touched = (unit, node = unit) => (changed.files.get(node.path) ?? []).some(line => line >= node.line && line <= node.end_line);
    const testNode = new Map(coverage.tests.map(test => [test.id, test.node]));
    const only = changed ? unit => touched(unit.node) || unit.tests.some(id => touched(testNode.get(id))) : () => true;
    const { ran: result, outcomes } = await runMutants({ coverage, generated, sourceText, runner, tool, copies, base, parallel, known: await readOutcomes(out),
      keyOf: outcomeKeys({ runner, tree, coverage }), only, progress: methodProgress, debug });
    ran = result;
    await saveOutcomes(out, outcomes);
    const statuses = [...ran.values()].flat();
    measured = { runner: runner.name, sandbox: sandboxKind(), suite_seconds: Math.round(base.seconds),
      mutants_run: statuses.filter(item => !item.uncovered && !item.reused && item.status !== 'skipped').length,
      reused: statuses.filter(item => item.reused).length, skipped: statuses.filter(item => item.status === 'skipped').length,
      timeouts: statuses.filter(item => item.status === 'timeout').length, unmatched_tests: coverage.unmatched.length, invalid: statuses.filter(item => item.status === 'invalid').length,
      ...(otherwise.length ? { left_out_languages: otherwise } : {}) };
  } finally { await remove(); }
  const answers = await askCoverage({ coverage, graph, linesOf, systemOne, min, parallel, ran, testProgress, methodProgress, log, debug });
  const lines = new Map();
  for (const file of coverage.files) lines.set(file.path, await linesOf({ path: file.path }));
  const report = buildReport({ coverage, answers, lines, revision, root, label, github, model: systemOne.id, min, closed: await openStore(out).closures() });
  if (scope) report.scope = { frameworks: scope.frameworks, tests: scope.tests, sources: scope.sources, left_out: scope.left_out, left_out_sample: scope.left_out_sample };
  report.measured = measured;
  if (changed) report.branch = branchOf(report, { ref: since, ...changed });
  // --since already says what the branch changed. The last saved run is some other commit, so it is
  // compared with only when --diff names it.
  const baseline = requested ?? (since ? null : await findBaseline({ out, root, revision }));
  if (baseline) { report.baseline = { revision: baseline.revision, created_at: baseline.created_at }; report.diff = diffReports(baseline, report); }
  await saveCoverageReport(out, report);
  return report;
}
