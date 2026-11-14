"""Child process: runs one checked analysis script with helpers, then prints a JSON result on fd 3."""
import base64
import contextlib
import io
import json
import os
import resource
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import policy  # noqa: E402

LIMITS = json.loads(os.environ['SANDBOX_LIMITS'])
resource.setrlimit(resource.RLIMIT_CPU, (LIMITS['cpu_seconds'], LIMITS['cpu_seconds']))
resource.setrlimit(resource.RLIMIT_AS, (LIMITS['memory_bytes'], LIMITS['memory_bytes']))
resource.setrlimit(resource.RLIMIT_FSIZE, (LIMITS['file_bytes'], LIMITS['file_bytes']))
resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

work = sys.argv[1]
code = open(os.path.join(work, 'script.py')).read()
inputs = json.load(open(os.path.join(work, 'inputs.json')))
tables, charts = [], []


def load_input(name):
    """Return one named CSV input as a pandas DataFrame."""
    if name not in inputs:
        raise KeyError(f'No input named {name!r}; available: {", ".join(inputs) or "none"}')
    return pd.read_csv(os.path.join(work, 'inputs', inputs[name]))


def list_inputs():
    return list(inputs)


def show_table(df, name='table', max_rows=200):
    """Return a DataFrame (at most max_rows rows) as a result table."""
    if len(tables) >= LIMITS['max_tables']:
        raise RuntimeError(f'At most {LIMITS["max_tables"]} tables per run')
    frame = pd.DataFrame(df)
    tables.append({'name': str(name)[:80], 'rows_total': int(len(frame)), 'csv': frame.head(min(max_rows, 200)).to_csv(index=False)})


def show_chart(fig=None, name='chart'):
    """Return a matplotlib figure (default: the current one) as a PNG result."""
    if len(charts) >= LIMITS['max_charts']:
        raise RuntimeError(f'At most {LIMITS["max_charts"]} charts per run')
    figure = fig or plt.gcf()
    buffer = io.BytesIO()
    figure.savefig(buffer, format='png', dpi=110, bbox_inches='tight')
    plt.close(figure)
    charts.append({'name': str(name)[:80], 'png_base64': base64.b64encode(buffer.getvalue()).decode()})


policy.check(code)
safe_builtins = {k: v for k, v in __builtins__.__dict__.items() if k not in policy.BLOCKED_NAMES}
real_import = __builtins__.__import__


def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    top = name.split('.')[0]
    if level or (name not in policy.ALLOWED_IMPORTS and top not in {'pandas', 'numpy', 'matplotlib'}):
        raise ImportError(f'Import of {name!r} is not allowed')
    return real_import(name, globals, locals, fromlist, level)


safe_builtins['__import__'] = guarded_import
scope = {'__builtins__': safe_builtins, '__name__': '__analysis__', 'pd': pd, 'np': np, 'plt': plt,
         'load_input': load_input, 'list_inputs': list_inputs, 'show_table': show_table, 'show_chart': show_chart}
stdout = io.StringIO()
error = None
try:
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stdout):
        exec(compile(code, 'analysis.py', 'exec'), scope)
except MemoryError:
    error = 'MemoryError: the analysis exceeded its memory limit'
except Exception as exc:  # The model sees its own error and can correct the code.
    import traceback
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == 'analysis.py']
    line = f' (line {frames[-1].lineno})' if frames else ''
    error = f'{type(exc).__name__}{line}: {exc}'
text = stdout.getvalue()
result = {'stdout': text[:LIMITS['stdout_chars']], 'stdout_truncated': len(text) > LIMITS['stdout_chars'],
          'tables': tables, 'charts': charts, 'error': error}
with os.fdopen(int(os.environ['SANDBOX_RESULT_FD']), 'w') as out:
    json.dump(result, out)
