"""Mission ingestion dashboard: service health, mission overview, PDF upload and ingestion jobs."""
import hashlib
import os
import re
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..missions import (DEFAULT_MISSION, create_mission, ensure_registry, get_mission, list_missions,
    migrate_graph, settings_for)
from ..settings import Settings
from ..stores import Stores
from . import health
from .jobs import JobManager

STATIC = Path(__file__).parent / 'static'
MAX_UPLOAD_BYTES = int(os.getenv('MAX_UPLOAD_MB', '200')) * 2**20
SAFE_NAME = re.compile(r'[^A-Za-z0-9 ._()\-]+')

app = FastAPI(title='Mission ingestion dashboard', docs_url='/api/docs', redoc_url=None)


class State:
    def __init__(self):
        self.base = Settings()
        self.root = Stores(self.base)          # Shared clients: registry, health and the graph.
        self.stores = {}
        self.lock = threading.Lock()
        self.jobs = None
        self.bootstrap_error = 'Starting'
        self.embedder = None
        self.embedder_lock = threading.Lock()
        self.hash_cache = {}

    def bootstrap(self):
        """Registry, Brahmastra indexes and the one-time graph migration; retried until the stores are up."""
        while self.jobs is None:
            try:
                ensure_registry(self.root.mongo_client, self.base)
                self.root.init()
                migrate_graph(self.root)
                self.jobs = JobManager(self.root.mongo_client)
                self.bootstrap_error = None
            except Exception as exc:
                self.bootstrap_error = f'{type(exc).__name__}: {str(exc)[:200]}'
                time.sleep(5)

    def mission(self, mission_id):
        self.ready()
        try:
            record = get_mission(self.root.mongo_client, self.base, mission_id)
        except LookupError as exc:
            raise HTTPException(404, str(exc))
        return record, settings_for(self.base, record)

    def mission_stores(self, mission_id):
        record, settings = self.mission(mission_id)
        with self.lock:
            if mission_id not in self.stores:
                self.stores[mission_id] = Stores(settings)
            return record, self.stores[mission_id]

    def ready(self):
        if self.jobs is None:
            raise HTTPException(503, f'Stores not ready yet: {self.bootstrap_error}')

    def get_embedder(self):
        with self.embedder_lock:
            if self.embedder is None:
                from ..documents import Embedder
                self.embedder = Embedder(self.base)
            return self.embedder

    def file_hash(self, path):
        stat = path.stat()
        key = (str(path), stat.st_size, stat.st_mtime_ns)
        if key not in self.hash_cache:
            digest = hashlib.sha256()
            with path.open('rb') as f:
                for block in iter(lambda: f.read(2**20), b''):
                    digest.update(block)
            self.hash_cache[key] = digest.hexdigest()
        return self.hash_cache[key]


state = State()
threading.Thread(target=state.bootstrap, daemon=True, name='bootstrap').start()


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


@app.get('/')
def index():
    return FileResponse(STATIC / 'index.html')


@app.get('/api/health')
def service_health():
    return {'ready': state.jobs is not None, 'bootstrap_error': state.bootstrap_error,
        'services': health.check_all(state.base, state.root.mongo_client, state.root.graph),
        'busy': bool(state.jobs and state.jobs.busy())}


@app.get('/api/missions')
def missions():
    state.ready()
    return list_missions(state.root.mongo_client, state.base)


class NewMission(BaseModel):
    id: str
    name: str
    description: str = ''


@app.post('/api/missions', status_code=201)
def new_mission(body: NewMission):
    state.ready()
    try:
        record = create_mission(state.root.mongo_client, state.base, body.id, body.name, body.description)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    _, stores = state.mission_stores(record['_id'])
    stores.init()
    return record


@app.get('/api/missions/{mission_id}/summary')
def summary(mission_id: str):
    record, stores = state.mission_stores(mission_id)
    mongo = stores.mongo
    documents = safe(lambda: list(mongo.documents.find({}, {'status': 1, 'extraction_status': 1})), [])
    runs = safe(lambda: list(mongo.telemetry_runs.find({}, {'status': 1, 'counts': 1})), [])
    graph = safe(lambda: {r['label']: r['n'] for r in stores.cypher(
        'MATCH (n) WHERE n.mission = $m RETURN labels(n)[0] AS label, count(*) AS n', m=mission_id)}, {})
    vectors = safe(lambda: stores.vectors.count(stores.settings.qdrant_collection, exact=True).count
        if stores.vectors.collection_exists(stores.settings.qdrant_collection) else 0)
    folder = stores.settings.telemetry
    return {
        'mission': record,
        'documents': {'revisions': len(documents), 'complete': sum(d.get('status') == 'complete' for d in documents),
            'failed': sum(d.get('status') == 'failed' for d in documents),
            'enriched': sum(d.get('extraction_status') == 'enriched' and d.get('status') == 'complete' for d in documents)},
        'mongo': {name: safe(lambda name=name: mongo[name].estimated_document_count(), 0) for name in ('sections', 'chunks', 'assets')},
        'vectors': vectors,
        'graph': graph,
        'telemetry': {
            'supported': record.get('telemetry_schema') == 'brahmastra-rc1',
            'folder_runs': len(list(folder.glob('BM-RUN-*'))) if folder.exists() else 0,
            'complete_runs': sum(r.get('status') == 'complete' for r in runs),
            'records': sum((r.get('counts') or {}).get('telemetry', 0) for r in runs if r.get('status') == 'complete'),
            'events': sum((r.get('counts') or {}).get('mission_events', 0) for r in runs if r.get('status') == 'complete'),
        },
        'stores': {'mongo_database': record['mongo_database'], 'influx_database': record['influx_database'],
            'qdrant_collection': record['qdrant_collection']},
    }


@app.get('/api/missions/{mission_id}/documents')
def documents(mission_id: str):
    record, stores = state.mission_stores(mission_id)
    folder = stores.settings.documents
    revisions = safe(lambda: list(stores.mongo.documents.find({}, {'profile': 0, 'warnings': 0})), [])
    by_hash = {}
    for rev in revisions:
        by_hash.setdefault(rev.get('source_sha256'), []).append({
            'document_id': rev['_id'], 'extraction_status': rev.get('extraction_status'), 'status': rev.get('status'),
            'pages': rev.get('page_count'), 'sections': rev.get('section_count'), 'chunks': rev.get('chunk_count'),
            'assets': rev.get('asset_count'), 'updated_at': rev.get('updated_at'), 'error_type': rev.get('error_type')})
    files, seen = [], set()
    for path in sorted(folder.rglob('*.pdf')) if folder.exists() else []:
        digest = state.file_hash(path)
        seen.add(digest)
        files.append({'file': str(path.relative_to(folder)), 'bytes': path.stat().st_size, 'sha256': digest,
            'revisions': by_hash.get(digest, [])})
    orphans = [{'file': rev.get('name') or rev['_id'][:12], 'bytes': None, 'sha256': h, 'missing_source': True,
        'revisions': by_hash[h]} for h in by_hash if h not in seen
        for rev in [next(r for r in revisions if r.get('source_sha256') == h)]]
    return {'folder': str(folder), 'files': files + orphans}


@app.post('/api/missions/{mission_id}/documents', status_code=201)
async def upload(mission_id: str, files: list[UploadFile] = File(...)):
    _, settings = state.mission(mission_id)
    settings.documents.mkdir(parents=True, exist_ok=True)
    saved = []
    for upload_file in files:
        name = SAFE_NAME.sub('_', Path(upload_file.filename or '').name).strip(' .')
        if not name.lower().endswith('.pdf') or len(name) < 5:
            raise HTTPException(400, f'{upload_file.filename!r}: only .pdf files are accepted')
        target = settings.documents / name
        if target.exists():
            raise HTTPException(409, f'{name} already exists in this mission; rename the file to add another version')
        temporary = settings.documents / f'.{name}.uploading'
        size = 0
        try:
            with temporary.open('wb') as out:
                head = await upload_file.read(1024)
                if not head.startswith(b'%PDF-'):
                    raise HTTPException(400, f'{name} is not a PDF file')
                out.write(head)
                size = len(head)
                while chunk := await upload_file.read(2**20):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, f'{name} exceeds {MAX_UPLOAD_BYTES // 2**20} MB')
                    out.write(chunk)
            temporary.rename(target)
        finally:
            if temporary.exists():
                temporary.unlink()
        saved.append({'file': name, 'bytes': size})
    return {'saved': saved}


class IngestRequest(BaseModel):
    file: str
    enrich: bool = False


@app.post('/api/missions/{mission_id}/ingest', status_code=202)
def ingest(mission_id: str, body: IngestRequest):
    _, settings = state.mission(mission_id)
    path = (settings.documents / body.file).resolve()
    if settings.documents.resolve() not in path.parents or path.suffix.lower() != '.pdf' or not path.is_file():
        raise HTTPException(404, 'Select a PDF from this mission\'s documents folder')

    def runner(progress, log):
        from ..pipeline import ingest_document
        stores = Stores(settings)
        try:
            progress('connecting')
            stores.init()
            progress('loading embedding model')
            embedder = state.get_embedder()
            log(f'{"VLM-enriched" if body.enrich else "Native"} ingestion of {body.file}')
            result = ingest_document(settings.documents / body.file, stores, embedder, body.enrich, progress)
            log(f"{result['chunks']} chunks, {result['sections']} sections, {result['assets']} assets")
            return result
        finally:
            stores.close()

    return state.jobs.submit(mission_id, 'document', body.file, runner, enrich=body.enrich)


@app.post('/api/missions/{mission_id}/telemetry', status_code=202)
def ingest_telemetry(mission_id: str):
    record, settings = state.mission(mission_id)
    if record.get('telemetry_schema') != 'brahmastra-rc1':
        raise HTTPException(400, 'This mission has no registered telemetry schema')
    folders = sorted(settings.telemetry.glob('BM-RUN-*'))
    if not folders:
        raise HTTPException(404, 'No run folders found in this mission\'s telemetry folder')

    def runner(progress, log):
        from ..pipeline import ingest_run
        stores = Stores(settings)
        try:
            stores.init()
            totals = {'runs': 0, 'telemetry': 0, 'mission_events': 0}
            for i, folder in enumerate(folders, start=1):
                progress('validating and loading runs', i, len(folders))
                result = ingest_run(folder, stores)
                log(f"{result['run_id']}: {result['telemetry']} samples, {result['mission_events']} events")
                totals['runs'] += 1
                totals['telemetry'] += result['telemetry']
                totals['mission_events'] += result['mission_events']
            return totals
        finally:
            stores.close()

    return state.jobs.submit(mission_id, 'telemetry', f'{len(folders)} runs', runner)


class EmbedRequest(BaseModel):
    texts: list[str]


@app.post('/api/embed')
def embed(body: EmbedRequest):
    """Query embeddings for other services (the Mission Analysis Agent), with the model and
    pinned revision that embedded the stored chunks, so query and document vectors are comparable."""
    if not 1 <= len(body.texts) <= 32 or any(not t.strip() or len(t) > 4000 for t in body.texts):
        raise HTTPException(400, 'Send 1-32 non-empty texts of at most 4000 characters each')
    vectors = state.get_embedder().encode(body.texts)
    return {'model': state.base.embedding_model, 'revision': state.base.embedding_revision,
        'dimensions': int(vectors.shape[1]), 'vectors': [[round(float(x), 7) for x in v] for v in vectors]}


@app.get('/api/jobs')
def jobs(mission: str | None = None):
    state.ready()
    return state.jobs.list(mission)
