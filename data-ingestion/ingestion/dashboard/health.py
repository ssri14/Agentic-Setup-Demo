"""Service health probes. Each probe is bounded and reports latency, version and detail."""
import os
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

TIMEOUT = float(os.getenv('HEALTH_TIMEOUT', '3'))


def plural(n, word):
    return f'{n:,} {word}' + ('' if n == 1 else 's')


def _result(name, role, status, started, detail='', version='', required=True, url=''):
    return {'name': name, 'role': role, 'status': status, 'latency_ms': round((time.perf_counter() - started) * 1000),
        'detail': detail, 'version': version, 'required': required, 'url': url}


def _probe(name, role, fn, required=True, url=''):
    started = time.perf_counter()
    try:
        status, detail, version = fn()
        return _result(name, role, status, started, detail, version, required, url)
    except Exception as exc:  # A failing service must surface as a result, never break the page.
        return _result(name, role, 'down' if required else 'off', started, f'{type(exc).__name__}: {str(exc)[:160]}', '', required, url)


def mongo_probe(client):
    def fn():
        client.admin.command('ping')
        info = client.admin.command('buildInfo')
        return 'ok', plural(len(client.list_database_names()), 'database'), info.get('version', '')
    return fn


def influx_probe(settings):
    def fn():
        headers = {'Authorization': f'Bearer {settings.influx_token}'}
        with httpx.Client(base_url=settings.influx_url, timeout=TIMEOUT, headers=headers) as http:
            http.get('/health').raise_for_status()
            ping = http.get('/ping')
            version = ping.headers.get('x-influxdb-version', '')
            if ping.status_code == 200:
                try:
                    version = ping.json().get('version', version)
                except ValueError:
                    pass
            dbs = http.get('/api/v3/configure/database', params={'format': 'json'})
            detail = plural(len(dbs.json()), 'database') if dbs.status_code == 200 else 'healthy'
        return 'ok', detail, version
    return fn


def qdrant_probe(settings):
    def fn():
        with httpx.Client(base_url=settings.qdrant_url, timeout=TIMEOUT) as http:
            root = http.get('/')
            root.raise_for_status()
            collections = http.get('/collections').json()['result']['collections']
        return 'ok', plural(len(collections), 'collection'), root.json().get('version', '')
    return fn


def neo4j_probe(driver):
    def fn():
        driver.verify_connectivity()
        with driver.session() as session:
            row = session.run('CALL dbms.components() YIELD versions, edition RETURN versions[0] AS v, edition AS e').single()
            nodes = session.run('MATCH (n) RETURN count(n) AS n').single()['n']
        return 'ok', f"{row['e']} · " + plural(nodes, 'node'), row['v']
    return fn


def openai_compatible_probe(base_url, model, key):
    def fn():
        if not base_url or not model:
            return 'off', 'Not configured in .env', ''
        headers = {'Authorization': f'Bearer {key}'} if key else {}
        with httpx.Client(timeout=TIMEOUT, headers=headers) as http:
            response = http.get(base_url.rstrip('/') + '/models')
            response.raise_for_status()
            served = [m.get('id') for m in response.json().get('data', [])]
        if model in served:
            return 'ok', model, ''
        return 'warn', f'Reachable, but {model} is not listed', ''
    return fn


def http_probe(url):
    def fn():
        with httpx.Client(timeout=TIMEOUT) as http:
            response = http.get(url)
        # Viewers may answer 401 for the login prompt: that still means they are running.
        if response.status_code < 500:
            return 'ok', f'HTTP {response.status_code}', ''
        return 'warn', f'HTTP {response.status_code}', ''
    return fn


def embedding_probe(settings):
    def fn():
        hub = Path(os.getenv('HF_HOME', str(Path.home() / '.cache/huggingface'))) / 'hub'
        folder = hub / ('models--' + settings.embedding_model.replace('/', '--')) / 'snapshots' / settings.embedding_revision
        if folder.exists():
            return 'ok', f'{settings.embedding_model.split("/")[-1]} cached locally', settings.embedding_revision[:8]
        return 'warn', 'Not cached yet: downloads on first ingestion', settings.embedding_revision[:8]
    return fn


def storage_probe(settings):
    def fn():
        usage = shutil.disk_usage(settings.artifacts)
        free = usage.free / 2**30
        return ('ok' if free > 5 else 'warn'), f'{free:,.1f} GB free for artifacts', ''
    return fn


def check_all(settings, mongo_client, neo4j_driver):
    vlm_url, llm_url = os.getenv('VLM_BASE_URL', ''), os.getenv('LLM_BASE_URL', '')
    probes = [
        ('MongoDB', 'Documents, chunks, manifests', mongo_probe(mongo_client), True, 'http://localhost:8081'),
        ('InfluxDB 3', 'Telemetry time series', influx_probe(settings), True, 'http://localhost:8888'),
        ('Qdrant', 'Vector search', qdrant_probe(settings), True, 'http://localhost:6333/dashboard'),
        ('Neo4j', 'Knowledge graph', neo4j_probe(neo4j_driver), True, 'http://localhost:7474'),
        ('Embedding model', 'Local text embeddings', embedding_probe(settings), True, ''),
        ('Vision model (VLM)', 'Tables and figures', openai_compatible_probe(vlm_url, os.getenv('VLM_MODEL', ''), os.getenv('VLM_API_KEY', '')), False, ''),
        ('Text LLM', 'Reserved for the agent', openai_compatible_probe(llm_url, os.getenv('LLM_MODEL', ''), os.getenv('LLM_API_KEY', '')), False, ''),
        ('Mongo viewer', 'Optional browser viewer', http_probe(os.getenv('MONGO_VIEWER_URL', 'http://mongo-viewer:8081')), False, 'http://localhost:8081'),
        ('Influx Explorer', 'Optional browser viewer', http_probe(os.getenv('INFLUX_EXPLORER_URL', 'http://influx-explorer:8080')), False, 'http://localhost:8888'),
        ('Analysis sandbox', 'Runs agent analysis code', http_probe(os.getenv('SANDBOX_HEALTH_URL', 'http://analysis-sandbox:8097/health')), False, ''),
        ('Mission Analysis Agent', 'Web app for users', http_probe(os.getenv('AGENT_WEB_URL', 'http://agent-web:8095/api/health')), False, 'http://localhost:8095'),
        ('Artifact storage', 'Rendered pages and VLM cache', storage_probe(settings), True, ''),
    ]
    with ThreadPoolExecutor(max_workers=len(probes)) as pool:
        futures = [pool.submit(_probe, name, role, fn, required, url) for name, role, fn, required, url in probes]
        return [f.result() for f in futures]
