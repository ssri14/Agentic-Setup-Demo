"""Dashboard and mission-registry behaviour against an in-memory MongoDB and fake stores."""
import time

import mongomock
import pytest

pytest.importorskip('fastapi')
from fastapi.testclient import TestClient

from ingestion import missions
from ingestion.settings import Settings

PDF = b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'


class FakeStores:
    client = None

    def __init__(self, settings):
        self.settings = settings
        self.mongo_client = FakeStores.client
        self.mongo = self.mongo_client[settings.mongo_database]
        self.graph = None

        class Vectors:
            def collection_exists(self, name):
                return False
        self.vectors = Vectors()

    def init(self):
        pass

    def close(self):
        pass

    def cypher(self, query, **params):
        return []


@pytest.fixture
def dashboard(tmp_path, monkeypatch):
    from ingestion.dashboard import app as module
    from ingestion.dashboard.jobs import JobManager
    FakeStores.client = mongomock.MongoClient()
    base = Settings(missions_root=tmp_path / 'missions', artifacts=tmp_path / 'artifacts')
    monkeypatch.setattr(module, 'Stores', FakeStores)
    state = module.state
    monkeypatch.setattr(state, 'base', base)
    monkeypatch.setattr(state, 'root', FakeStores(base))
    monkeypatch.setattr(state, 'stores', {})
    missions.ensure_registry(FakeStores.client, base)
    monkeypatch.setattr(state, 'jobs', JobManager(FakeStores.client))
    (base.missions_root / 'brahmastra' / 'documents').mkdir(parents=True)
    return TestClient(module.app), state, base


def wait_for(client, mission, predicate, timeout=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        jobs = client.get('/api/jobs', params={'mission': mission}).json()
        if jobs and predicate(jobs[0]):
            return jobs[0]
        time.sleep(0.05)
    raise AssertionError(f'Job did not reach the expected state: {jobs}')


def test_mission_ids_are_validated_and_stores_isolated():
    record = missions.new_record('trishul', 'Trishul')
    assert (record['mongo_database'], record['influx_database'], record['qdrant_collection']) == ('mission_trishul', 'mission_trishul', 'trishul_chunks')
    for bad in ['', 'A', 'Trishul', '1abc', 'admin', 'mission_x', 'has-dash', 'x' * 40]:
        with pytest.raises(ValueError):
            missions.new_record(bad, 'Name')
    base = Settings()
    settings, default = missions.resolve(base, 'brahmastra')
    assert (default['mongo_database'], default['qdrant_collection']) == (base.mongo_database, base.qdrant_collection)
    assert settings.documents == base.missions_root / 'brahmastra' / 'documents'
    with pytest.raises(ValueError):
        missions.resolve(base, 'trishul')


def test_registry_create_and_list(dashboard):
    client, state, base = dashboard
    assert [m['_id'] for m in client.get('/api/missions').json()] == ['brahmastra']
    created = client.post('/api/missions', json={'id': 'trishul', 'name': 'Trishul', 'description': 'Second mission'})
    assert created.status_code == 201
    assert (base.missions_root / 'trishul' / 'documents').is_dir()
    assert client.post('/api/missions', json={'id': 'trishul', 'name': 'Again'}).status_code == 400
    assert client.post('/api/missions', json={'id': 'Bad-ID', 'name': 'X'}).status_code == 400
    assert [m['_id'] for m in client.get('/api/missions').json()] == ['brahmastra', 'trishul']
    summary = client.get('/api/missions/trishul/summary').json()
    assert summary['stores']['qdrant_collection'] == 'trishul_chunks'
    assert summary['telemetry']['supported'] is False
    assert client.post('/api/missions/trishul/telemetry').status_code == 400
    assert client.get('/api/missions/unknown/summary').status_code == 404


def test_upload_validation_and_listing(dashboard):
    client, state, base = dashboard
    files = {'files': ('notes.txt', b'hello', 'text/plain')}
    assert client.post('/api/missions/brahmastra/documents', files=files).status_code == 400
    fake = {'files': ('fake.pdf', b'not a pdf', 'application/pdf')}
    assert client.post('/api/missions/brahmastra/documents', files=fake).status_code == 400
    folder = base.missions_root / 'brahmastra' / 'documents'
    assert not any(folder.iterdir()), 'Rejected uploads must not leave files behind'
    ok = client.post('/api/missions/brahmastra/documents', files={'files': ('../../Mission Plan.pdf', PDF, 'application/pdf')})
    assert ok.status_code == 201 and ok.json()['saved'][0]['file'] == 'Mission Plan.pdf'
    assert (folder / 'Mission Plan.pdf').read_bytes() == PDF
    again = client.post('/api/missions/brahmastra/documents', files={'files': ('Mission Plan.pdf', PDF, 'application/pdf')})
    assert again.status_code == 409
    listing = client.get('/api/missions/brahmastra/documents').json()
    assert [f['file'] for f in listing['files']] == ['Mission Plan.pdf'] and listing['files'][0]['revisions'] == []
    digest = listing['files'][0]['sha256']
    FakeStores.client['brahmastra'].documents.insert_one({'_id': 'rev1', 'source_sha256': digest, 'status': 'complete',
        'extraction_status': 'native_only', 'page_count': 1, 'chunk_count': 3})
    revision = client.get('/api/missions/brahmastra/documents').json()['files'][0]['revisions'][0]
    assert (revision['document_id'], revision['chunks']) == ('rev1', 3)


def test_ingestion_job_progress_and_failure(dashboard, monkeypatch):
    client, state, base = dashboard
    from ingestion import pipeline
    (base.missions_root / 'brahmastra' / 'documents' / 'a.pdf').write_bytes(PDF)
    monkeypatch.setattr(state, 'get_embedder', lambda: object())
    calls = []

    def fake_ingest(path, stores, embedder, enrich=False, progress=None):
        calls.append((path.name, stores.settings.mission, enrich))
        progress('extracting', 1, 2)
        progress('extracting', 2, 2)
        if enrich:
            raise ValueError('VLM unavailable')
        return {'document_id': 'd1', 'sections': 1, 'chunks': 2, 'assets': 3, 'status': 'complete'}
    monkeypatch.setattr(pipeline, 'ingest_document', fake_ingest)
    assert client.post('/api/missions/brahmastra/ingest', json={'file': '../secrets.pdf'}).status_code == 404
    assert client.post('/api/missions/brahmastra/ingest', json={'file': 'a.pdf'}).status_code == 202
    job = wait_for(client, 'brahmastra', lambda j: j['status'] == 'complete')
    assert job['result']['chunks'] == 2 and any('extracting' in line for line in job['log'])
    client.post('/api/missions/brahmastra/ingest', json={'file': 'a.pdf', 'enrich': True})
    failed = wait_for(client, 'brahmastra', lambda j: j['status'] == 'failed')
    assert 'VLM unavailable' in failed['error']
    assert calls == [('a.pdf', 'brahmastra', False), ('a.pdf', 'brahmastra', True)]
    persisted = FakeStores.client[missions.REGISTRY_DATABASE].dashboard_jobs.find_one({'_id': failed['id']})
    assert persisted['status'] == 'failed'


def test_restart_marks_unfinished_jobs_interrupted():
    from ingestion.dashboard.jobs import JobManager
    client = mongomock.MongoClient()
    client[missions.REGISTRY_DATABASE].dashboard_jobs.insert_one({'_id': 'x', 'mission': 'brahmastra', 'status': 'running',
        'created_at': '2026-01-01', 'log': []})
    manager = JobManager(client)
    assert manager.list()[0]['status'] == 'interrupted'


def test_health_reports_down_services_without_failing():
    from ingestion.dashboard import health

    class Broken:
        def __getattr__(self, name):
            raise ConnectionError('refused')
    settings = Settings(influx_url='http://127.0.0.1:9', qdrant_url='http://127.0.0.1:9')
    results = {r['name']: r for r in health.check_all(settings, Broken(), Broken())}
    assert results['MongoDB']['status'] == 'down' and results['Neo4j']['status'] == 'down'
    assert results['Mongo viewer']['status'] == 'off' and results['Mongo viewer']['required'] is False
    assert all('latency_ms' in r for r in results.values())


def test_dashboard_page_is_served(dashboard):
    client, _, _ = dashboard
    page = client.get('/')
    assert page.status_code == 200 and 'Mission Ingestion' in page.text


def test_embed_endpoint_returns_model_identity_and_validates(dashboard, monkeypatch):
    import numpy as np
    client, state, base = dashboard

    class Fake:
        def encode(self, texts):
            return np.ones((len(texts), 4), dtype=np.float32) / 2
    monkeypatch.setattr(state, 'get_embedder', lambda: Fake())
    ok = client.post('/api/embed', json={'texts': ['power margin', 'dropout']}).json()
    assert (ok['model'], ok['revision'], ok['dimensions']) == (base.embedding_model, base.embedding_revision, 4)
    assert len(ok['vectors']) == 2 and ok['vectors'][0] == [0.5] * 4
    assert client.post('/api/embed', json={'texts': []}).status_code == 400
    assert client.post('/api/embed', json={'texts': ['x' * 4001]}).status_code == 400
    assert client.post('/api/embed', json={'texts': ['ok'] * 33}).status_code == 400
