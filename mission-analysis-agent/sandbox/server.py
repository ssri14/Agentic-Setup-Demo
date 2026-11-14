"""Analysis sandbox HTTP service: POST /run {code, inputs: {name: csv_text}} -> stdout, tables, charts.
Runs each script in a fresh child process with CPU, memory, file and process limits.
The container is meant to sit on an internal network with no route out."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import policy

HERE = os.path.dirname(os.path.abspath(__file__))
LIMITS = {
    'wall_seconds': int(os.getenv('SANDBOX_WALL_SECONDS', '30')), 'cpu_seconds': int(os.getenv('SANDBOX_CPU_SECONDS', '25')),
    'memory_bytes': int(os.getenv('SANDBOX_MEMORY_MB', '768')) * 2**20, 'file_bytes': 50 * 2**20,
    'stdout_chars': 20_000, 'max_tables': 5, 'max_charts': 4,
}
MAX_BODY = 30 * 2**20
NAME = re.compile(r'^[A-Za-z][A-Za-z0-9_.-]{0,63}$')
SLOTS = int(os.getenv('SANDBOX_CONCURRENCY', '2'))
running = 0


def run(code, inputs):
    policy.check(code)
    if not isinstance(inputs, dict) or len(inputs) > 10:
        raise policy.PolicyError('inputs must be an object of at most 10 named CSV texts')
    work = tempfile.mkdtemp(prefix='run-')
    try:
        os.makedirs(os.path.join(work, 'inputs'))
        names = {}
        for i, (name, csv_text) in enumerate(inputs.items()):
            if not NAME.match(str(name)) or not isinstance(csv_text, str):
                raise policy.PolicyError(f'Invalid input name {name!r}')
            names[name] = f'input-{i}.csv'
            with open(os.path.join(work, 'inputs', names[name]), 'w') as f:
                f.write(csv_text)
        with open(os.path.join(work, 'script.py'), 'w') as f:
            f.write(code)
        with open(os.path.join(work, 'inputs.json'), 'w') as f:
            json.dump(names, f)
        read_fd, write_fd = os.pipe()
        env = {'PATH': '/usr/bin:/bin', 'SANDBOX_LIMITS': json.dumps(LIMITS), 'SANDBOX_RESULT_FD': str(write_fd), 'MPLCONFIGDIR': os.getenv('MPL_CACHE_DIR', work),
               'HOME': work, 'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1'}
        started = time.monotonic()
        proc = subprocess.Popen([sys.executable, '-I', '-B', os.path.join(HERE, 'runner.py'), work],
                                cwd=work, env=env, pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                start_new_session=True)
        os.close(write_fd)
        try:
            _, err = proc.communicate(timeout=LIMITS['wall_seconds'])
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, 9)
            proc.communicate()
            os.close(read_fd)
            return {'error': f'TimeoutError: the analysis ran longer than {LIMITS["wall_seconds"]} s', 'stdout': '', 'tables': [], 'charts': [],
                    'duration_ms': round((time.monotonic() - started) * 1000)}
        with os.fdopen(read_fd) as r:
            raw = r.read()
        duration = round((time.monotonic() - started) * 1000)
        if not raw:
            reason = 'CPU time limit' if proc.returncode in (-24, -9) else f'exit code {proc.returncode}'
            tail = err.decode(errors='replace').strip().splitlines()[-1:] if err else []
            return {'error': f'ProcessError: the analysis stopped ({reason}). {" ".join(tail)}'.strip(), 'stdout': '', 'tables': [], 'charts': [], 'duration_ms': duration}
        return {**json.loads(raw), 'duration_ms': duration}
    finally:
        shutil.rmtree(work, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = 'analysis-sandbox/1'

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/health':
            return self.reply(200, {'ok': True, 'limits': LIMITS, 'allowed_imports': sorted(policy.ALLOWED_IMPORTS)})
        self.reply(404, {'error': 'Not found'})

    def do_POST(self):
        global running
        if self.path != '/run':
            return self.reply(404, {'error': 'Not found'})
        length = int(self.headers.get('Content-Length') or 0)
        if not 0 < length <= MAX_BODY:
            return self.reply(413, {'error': 'Request body missing or too large'})
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            return self.reply(400, {'error': 'Body must be JSON'})
        if running >= SLOTS:
            return self.reply(429, {'error': 'Sandbox busy; retry shortly'})
        running += 1
        try:
            self.reply(200, run(str(body.get('code', '')), body.get('inputs') or {}))
        except policy.PolicyError as exc:
            self.reply(400, {'error': f'PolicyError: {exc}'})
        finally:
            running -= 1

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


if __name__ == '__main__':
    port = int(os.getenv('PORT', '8097'))
    print(f'analysis sandbox on :{port}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
