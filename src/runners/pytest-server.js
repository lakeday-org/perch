/**
 * The pytest plugin perch's mutant server runs as, written to the scratch directory and loaded with `-p perch_server`. pytest
 * collects the suite once; the plugin then takes the run over and answers mutants from perch instead of running the tests.
 *
 * Each mutant runs in a child forked from the collected session, so nothing it does reaches the next one, and nothing is imported
 * or collected again. The child swaps the mutated function's code into the functions already loaded: the module's mutated source
 * is compiled, never run, and the function's code object is taken out of it. Every function object sharing the original code gets
 * the new one, so `from shop import add` in a test sees the mutant too. A function not loaded yet, one defined inside another, is
 * swapped through the nearest function around it that is; a module nobody has imported yet is imported from the mutated source.
 * An edit to a default value is evaluated again into the function's defaults, since Python evaluates those once, at `def`.
 *
 * Commands come in on file descriptor 3 and results go out on 4, a JSON object a line. A child writes a line per test as it
 * finishes, so a child that dies mid-run names the test it died in.
 */
export const SERVER = String.raw`
import ast
import gc
import json
import os
import selectors
import signal
import sys
import time
import traceback
from collections import deque
import importlib.abc
import importlib.machinery
import importlib.util

import pytest

PARALLEL = int(os.environ.get('PERCH_PARALLEL', '1'))


class MutantLoadError(Exception):
    pass


def first_line(node):
    return min([node.lineno] + [item.lineno for item in getattr(node, 'decorator_list', [])])


def find_def(tree, line, name):
    """The def perch means, and the defs and classes around it, outermost first."""
    found = []

    def walk(node, chain):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                here = chain + [child]
                if not isinstance(child, ast.ClassDef) and child.name == name and line in (child.lineno, first_line(child)):
                    found.append(here)
                walk(child, here)
            else:
                walk(child, chain)

    walk(tree, [])
    if len(found) != 1:
        raise MutantLoadError('found %d definitions of %s at line %d' % (len(found), name, line))
    return found[0]


def code_in(code, chain):
    """The code object for the last of chain, found by name and first line through the constants of the module's code."""
    for node in chain:
        code = next((item for item in code.co_consts if hasattr(item, 'co_consts') and item.co_name == node.name
                     and item.co_firstlineno == first_line(node)), None)
        if code is None:
            raise MutantLoadError('no code for %s at line %d in the mutated module' % (node.name, first_line(node)))
    return code


FUNCTIONS = {}


def index_functions():
    for item in gc.get_objects():
        code = getattr(item, '__code__', None)
        if type(item).__name__ == 'function' and code is not None:
            FUNCTIONS.setdefault((code.co_filename, code.co_firstlineno, code.co_name), []).append(item)


def live(filename, node):
    return FUNCTIONS.get((filename, first_line(node), node.name), [])


class MutatedModule(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def __init__(self, filename, source):
        self.filename, self.source = filename, source

    def find_spec(self, fullname, path, target=None):
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec is None or not spec.origin or os.path.realpath(spec.origin) != self.filename:
            return None
        return importlib.util.spec_from_file_location(fullname, spec.origin, loader=self, submodule_search_locations=spec.submodule_search_locations)

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        exec(compile(self.source, self.filename, 'exec'), module.__dict__)


def apply(command, root):
    filename = os.path.realpath(os.path.join(root, command['path']))
    source = command['source']
    tree = ast.parse(source, filename)
    chain = find_def(tree, command['line'], command['name'])
    loaded = any(os.path.realpath(getattr(module, '__file__', None) or '') == filename for module in list(sys.modules.values()))
    if not loaded:
        sys.meta_path.insert(0, MutatedModule(filename, source))
        return
    # The nearest function, from the mutated one outwards, that is loaded: a function defined inside another is made each time
    # the outer one runs, from the outer one's code.
    level = next((at for at in range(len(chain) - 1, -1, -1) if not isinstance(chain[at], ast.ClassDef) and live(filename, chain[at])), None)
    if level is None:
        raise MutantLoadError('%s is in a loaded module but no function around it is loaded' % command['name'])
    functions = live(filename, chain[level])
    original = functions[0].__code__
    swapped = chain[level]
    code = code_in(compile(tree, filename, 'exec'), chain[:level + 1])
    missing = [name for name in original.co_freevars if name not in code.co_freevars]
    if missing:
        # An edit that drops the last use of a variable from around the function drops it from the function's closure, and a code
        # object is swapped in only with the closure it had. A lambda that names them keeps them.
        keep = ast.Expr(ast.Lambda(args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
                                   body=ast.Tuple([ast.Name(name, ast.Load()) for name in missing], ast.Load())))
        swapped.body.insert(0, keep)
        ast.fix_missing_locations(tree)
        code = code_in(compile(tree, filename, 'exec'), chain[:level + 1])
    if code.co_freevars != original.co_freevars:
        raise MutantLoadError('the mutant changes the variables %s closes over' % command['name'])
    for function in functions:
        function.__code__ = code
    if command.get('signature') and level == len(chain) - 1:
        args = swapped.args
        evaluate = lambda expression, function: eval(compile(ast.Expression(expression), filename, 'eval'), function.__globals__)
        for function in functions:
            if args.defaults:
                function.__defaults__ = tuple(evaluate(item, function) for item in args.defaults)
            kw = {arg.arg: evaluate(item, function) for arg, item in zip(args.kwonlyargs, args.kw_defaults) if item is not None}
            if kw:
                function.__kwdefaults__ = kw


def run_child(command, items, root, out):
    from _pytest.runner import runtestprotocol
    def say(record):
        os.write(out, (json.dumps(record) + '\n').encode())
    started = time.monotonic()
    try:
        apply(command, root)
    except Exception as error:
        say({'invalid': '%s: %s' % (type(error).__name__, error)})
        return
    nodes = [items[node] for node in command['nodes'] if node in items]
    say({'started': [item.nodeid for item in nodes], 'apply': time.monotonic() - started})
    for at, item in enumerate(nodes):
        reports = runtestprotocol(item, nextitem=nodes[at + 1] if at + 1 < len(nodes) else None, log=False)
        failed = any(report.failed for report in reports)
        say({'node': item.nodeid, 'status': 'failed' if failed else 'passed'})
        if failed and command.get('bail'):
            break
    say({'done': True, 'seconds': time.monotonic() - started})


def serve(session):
    items = {item.nodeid: item for item in session.items}
    root = os.environ['PERCH_ROOT']
    index_functions()
    commands = 3
    results = os.fdopen(4, 'w', buffering=1)
    results.write(json.dumps({'ready': True, 'tests': len(items)}) + '\n')
    selector = selectors.DefaultSelector()
    selector.register(commands, selectors.EVENT_READ, None)
    queue, running, pending, closed = deque(), {}, b'', False

    def finish(pid, child, timed_out):
        # The child and anything it started go with it. A group already gone is what was wanted; macOS refuses to signal one left
        # holding only exited processes.
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        selector.unregister(child['read'])
        os.close(child['read'])
        records = [json.loads(line) for line in child['buffer'].decode().splitlines() if line.strip()]
        out = {'id': child['id'], 'elapsed': time.monotonic() - child['forked'],
               'apply': next((record['apply'] for record in records if 'apply' in record), None), 'child': next((record['seconds'] for record in records if 'done' in record), None)}
        invalid = next((record['invalid'] for record in records if 'invalid' in record), None)
        statuses = [record for record in records if 'node' in record]
        started = next((record['started'] for record in records if 'started' in record), [])
        if invalid is not None:
            out.update(status='invalid', error=invalid)
        elif timed_out:
            out.update(status='timeout', results=statuses)
        elif not any('done' in record for record in records):
            # The child died inside a test: the mutant ended the process, which that test noticed.
            done = {record['node'] for record in statuses}
            dying = next((node for node in started if node not in done), None)
            out.update(status='ran', results=statuses + ([{'node': dying, 'status': 'failed'}] if dying else []))
        else:
            out.update(status='ran', results=statuses)
        results.write(json.dumps(out) + '\n')

    while not closed or queue or running:
        while queue and len(running) < PARALLEL:
            command = queue.popleft()
            read, write = os.pipe()
            pid = os.fork()
            if pid == 0:
                status = 0
                try:
                    os.setsid()
                    os.close(read)
                    os.close(commands)
                    run_child(command, items, root, write)
                except BaseException:
                    try:
                        os.write(write, (json.dumps({'invalid': traceback.format_exc(limit=3)}) + '\n').encode())
                    except BaseException:
                        pass
                    status = 1
                finally:
                    os._exit(status)
            os.close(write)
            selector.register(read, selectors.EVENT_READ, pid)
            running[pid] = {'id': command['id'], 'read': read, 'buffer': b'', 'forked': time.monotonic(), 'deadline': time.monotonic() + command['timeout'] / 1000}
        now = time.monotonic()
        wait = min([child['deadline'] for child in running.values()], default=now + 60) - now
        for key, _ in selector.select(max(0, wait)):
            if key.fd == commands:
                chunk = os.read(commands, 1 << 20)
                if not chunk:
                    closed = True
                    selector.unregister(commands)
                    continue
                pending += chunk
                *lines, pending = pending.split(b'\n')
                queue.extend(json.loads(line) for line in lines if line.strip())
            else:
                child = running[key.data]
                chunk = os.read(key.fd, 1 << 20)
                if chunk:
                    child['buffer'] += chunk
                else:
                    finish(key.data, running.pop(key.data), False)
        now = time.monotonic()
        for pid in [pid for pid, child in running.items() if child['deadline'] <= now]:
            finish(pid, running.pop(pid), True)


@pytest.hookimpl(tryfirst=True)
def pytest_runtestloop(session):
    serve(session)
    return True
`;
