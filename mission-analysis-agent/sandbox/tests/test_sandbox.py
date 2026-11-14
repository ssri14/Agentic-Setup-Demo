import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402
from policy import PolicyError  # noqa: E402

CSV = 'mission_elapsed_s,pwr_margin_pu,hlt_warning_count\n' + '\n'.join(f'{i/2},{0.8 - i*0.001:.4f},{1 if i > 100 else 0}' for i in range(200))


def test_analysis_returns_stdout_tables_and_charts():
    code = '''
df = load_input('window')
print('rows', len(df))
first = df.loc[df.hlt_warning_count > 0, 'mission_elapsed_s'].min()
print('first warning at', first)
show_table(df.describe().reset_index(), 'summary')
fig, ax = plt.subplots()
ax.plot(df.mission_elapsed_s, df.pwr_margin_pu)
show_chart(fig, 'margin')
'''
    result = server.run(code, {'window': CSV})
    assert result['error'] is None, result
    assert 'rows 200' in result['stdout'] and 'first warning at 50.5' in result['stdout']
    assert result['tables'][0]['name'] == 'summary' and 'pwr_margin_pu' in result['tables'][0]['csv']
    assert result['charts'][0]['png_base64'].startswith('iVBOR')


@pytest.mark.parametrize('code', [
    'import os', 'import subprocess', 'from os import path', 'import socket', 'import importlib',
    "open('/etc/passwd').read()", "eval('1+1')", "__import__('os')", 'x = ().__class__.__bases__',
    "pd.read_csv('/etc/passwd')", "load_input('window').to_csv('/tmp/x.csv')", "getattr(pd, 'read_csv')",
    'import matplotlib.backends', 'from . import policy',
])
def test_policy_blocks_escape_routes(code):
    with pytest.raises(PolicyError):
        server.run(code, {'window': CSV})


def test_runtime_errors_report_the_line():
    result = server.run("df = load_input('window')\nx = 1\nprint(df['missing'])", {'window': CSV})
    assert result['error'].startswith("KeyError (line 3)")
    missing = server.run("load_input('nope')", {'window': CSV})
    assert 'available: window' in missing['error']


def test_wall_clock_limit(monkeypatch):
    monkeypatch.setitem(server.LIMITS, 'wall_seconds', 2)
    result = server.run('while True:\n    pass', {})
    assert result['error'].startswith('TimeoutError')


def test_memory_limit(monkeypatch):
    monkeypatch.setitem(server.LIMITS, 'memory_bytes', 600 * 2**20)
    result = server.run('x = np.ones((400, 1000, 1000))', {})
    assert result['error'] and 'Memory' in result['error'] or 'stopped' in (result['error'] or '')


def test_input_names_are_validated():
    with pytest.raises(PolicyError):
        server.run('print(1)', {'../evil': 'a,b'})
