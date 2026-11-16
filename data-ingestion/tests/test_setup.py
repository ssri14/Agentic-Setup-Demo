"""scripts/setup.py on a fresh checkout and on an existing installation (standard library only)."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
# scripts/ is not copied into the ingestion image: this test runs on the host, from a checkout.
pytestmark = pytest.mark.skipif(not (ROOT / 'scripts/setup.py').is_file(), reason='needs scripts/setup.py from a checkout')
GENERATED = ['NEO4J_PASSWORD', 'MONGO_PASSWORD', 'VIEWER_PASSWORD', 'VIEWER_SESSION_SECRET',
             'AGENT_MONGO_PASSWORD', 'AGENT_ADMIN_USER', 'AGENT_ADMIN_PASSWORD', 'INFLUX_TOKEN']


def checkout(tmp_path):
    (tmp_path / 'scripts').mkdir()
    shutil.copy(ROOT / 'scripts/setup.py', tmp_path / 'scripts/setup.py')
    shutil.copy(ROOT / '.env.example', tmp_path / '.env.example')
    return tmp_path


def run(folder):
    subprocess.run([sys.executable, str(folder / 'scripts/setup.py')], check=True, capture_output=True)
    return dict(line.split('=', 1) for line in (folder / '.env').read_text().splitlines() if '=' in line and not line.startswith('#'))


def test_fresh_checkout_gets_every_credential(tmp_path):
    values = run(checkout(tmp_path))
    for key in GENERATED:
        assert values.get(key), f'{key} is empty after setup.py'
    assert values['AGENT_ADMIN_USER'] == 'admin'
    assert values['INFLUX_TOKEN'].startswith('apiv3_')
    assert (tmp_path / 'secrets/influx-admin.json').is_file() and (tmp_path / 'secrets/explorer/config.json').is_file()
    assert not values['LLM_BASE_URL'] and not values['VLM_BASE_URL']      # no endpoint of the reference setup leaks into a new install


def test_rerun_changes_nothing_and_keeps_set_values(tmp_path):
    folder = checkout(tmp_path)
    run(folder)
    env = folder / '.env'
    before = env.read_text().replace('OPENROUTER_API_KEY=\n', 'OPENROUTER_API_KEY=sk-or-test\n')
    env.write_text(before)
    run(folder)
    assert env.read_text() == before


def test_older_env_without_agent_keys_is_completed(tmp_path):
    folder = checkout(tmp_path)
    first = run(folder)
    env = folder / '.env'
    env.write_text(''.join(line + '\n' for line in env.read_text().splitlines() if not line.startswith(('VIEWER_', 'AGENT_', 'INFLUX_TOKEN='))))
    values = run(folder)
    for key in GENERATED:
        assert values.get(key), key
    assert values['NEO4J_PASSWORD'] == first['NEO4J_PASSWORD'] and values['MONGO_PASSWORD'] == first['MONGO_PASSWORD']
