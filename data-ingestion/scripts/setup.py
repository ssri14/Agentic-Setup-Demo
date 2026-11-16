"""Create local credentials and copy ONLY approved demo inputs. No database changes."""
from pathlib import Path
import argparse
import json
import secrets
import shutil

root = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--seed-demo', action='store_true', help='Copy freshly generated runs from ../telemetry-generator/agent_visible/runs into missions/brahmastra/telemetry if absent (the repository already contains them)')
args = p.parse_args()
(root / 'secrets').mkdir(exist_ok=True)
(root / 'artifacts').mkdir(exist_ok=True)
(root / 'missions').mkdir(exist_ok=True)
env = root / '.env'
if not env.exists():
    env.write_text((root / '.env.example').read_text())
    env.chmod(0o600)
token = root / 'secrets/influx-admin.json'
if not token.exists():
    token.write_text(json.dumps({'token': 'apiv3_' + secrets.token_urlsafe(48), 'name': 'ingestion-admin'}))
    token.chmod(0o600)


def fill(generated, heading):
    """Give each key a value: fill it in where .env has it empty, append it where it is missing. Never change a set value."""
    lines = env.read_text().splitlines()
    present = {line.split('=', 1)[0]: i for i, line in enumerate(lines) if '=' in line and not line.lstrip().startswith('#')}
    appended = []
    for key, value in generated:
        if key in present:
            if lines[present[key]].split('=', 1)[1].strip() == '':
                lines[present[key]] = f'{key}={value}'
        else:
            appended.append(f'{key}={value}')
    text = '\n'.join(lines).rstrip('\n') + '\n'
    if appended:
        text += f'\n# {heading}\n' + '\n'.join(appended) + '\n'
    env.write_text(text)


# Store credentials (the stores keep the values they were created with: never rotate them here).
fill([('NEO4J_PASSWORD', secrets.token_hex(24)), ('MONGO_PASSWORD', secrets.token_hex(24))], 'Store credentials')
# Read-only browser viewers (mongo-express login user: viewer).
fill([('VIEWER_PASSWORD', secrets.token_hex(12)), ('VIEWER_SESSION_SECRET', secrets.token_hex(32))], 'Read-only browser viewers (mongo-express login user: viewer)')
# Mission Analysis Agent: its own MongoDB user and the first superuser's initial password.
fill([('AGENT_MONGO_PASSWORD', secrets.token_hex(24)), ('AGENT_ADMIN_USER', 'admin'), ('AGENT_ADMIN_PASSWORD', secrets.token_urlsafe(12)),
      ('INFLUX_TOKEN', json.loads(token.read_text())['token'])], 'Mission Analysis Agent (the admin password must be changed at first sign-in)')
values = dict(line.split('=', 1) for line in env.read_text().splitlines() if '=' in line and not line.lstrip().startswith('#'))
explorer = root / 'secrets/explorer'
explorer.mkdir(exist_ok=True)
explorer.chmod(0o755)
config = explorer / 'config.json'
if not config.exists():
    config.write_text(json.dumps({'DEFAULT_INFLUX_SERVER': 'http://influxdb:8181',
        'DEFAULT_INFLUX_DATABASE': values.get('INFLUX_DATABASE', 'brahmastra'),
        'DEFAULT_API_TOKEN': json.loads(token.read_text())['token'],
        'DEFAULT_SERVER_NAME': 'Brahmastra telemetry'}, indent=2))
    config.chmod(0o644)
if args.seed_demo:
    source = root.parent / 'telemetry-generator' / 'agent_visible' / 'runs'
    mission = root / 'missions' / 'brahmastra'
    for folder in ['documents', 'telemetry']:
        (mission / folder).mkdir(parents=True, exist_ok=True)
    if not (mission / 'documents/Mission Document.pdf').exists():
        print('Note: missions/brahmastra/documents/Mission Document.pdf is missing; restore it from the repository.')
    for run in sorted(source.glob('BM-RUN-*')):
        dst = mission / 'telemetry' / run.name
        dst.mkdir(exist_ok=True)
        for name in ['run_manifest.json', 'telemetry.csv', 'events.jsonl']:
            if not (dst / name).exists():
                shutil.copy2(run / name, dst / name)
print('Local configuration ready. Existing configuration and inputs were preserved.')
