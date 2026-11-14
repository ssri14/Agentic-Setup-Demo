"""Small database adapters. Driver errors propagate; no silent success."""
import time
import json
from pathlib import Path
import httpx
from pymongo import MongoClient
from qdrant_client import QdrantClient, models
import uuid
from neo4j import GraphDatabase

class Stores:
    def __init__(self, settings):
        self.settings = settings
        self.http = httpx.Client(base_url=settings.influx_url, headers={'Authorization': f'Bearer {settings.influx_token}'}, timeout=120)
        self.mongo_client = MongoClient(host=settings.mongo_host, username='ingestion', password=settings.mongo_password, authSource='admin', serverSelectionTimeoutMS=10000)
        self.mongo = self.mongo_client[settings.mongo_database]
        self.vectors = QdrantClient(url=settings.qdrant_url, timeout=120)
        self.graph = GraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password))

    def close(self):
        self.http.close()
        self.mongo_client.close()
        self.graph.close()
        self.vectors.close()

    def ready(self):
        for attempt in range(30):
            try:
                r = self.http.get('/health')
                r.raise_for_status()
                self.mongo.command('ping')
                self.vectors.get_collections()
                self.graph.verify_connectivity()
                return
            except Exception:
                if attempt == 29:
                    raise
                time.sleep(2)

    def init(self):
        self.ready()
        # The write endpoint creates the database on first write; no retention policy
        # is set because the source epoch is deliberately historical.
        for collection, keys in [('chunks', [('document_id', 1), ('ordinal', 1)]), ('sections', [('document_id', 1), ('ordinal', 1)]), ('assets', [('document_id', 1), ('page', 1)]), ('telemetry_runs', [('run_id', 1)])]:
            self.mongo[collection].create_index(keys)
        self.mongo.chunks.create_index([('text', 'text')])
        if self.settings.telemetry_schema == 'brahmastra-rc1':
            catalog = json.loads((Path(__file__).resolve().parents[1] / 'config/telemetry_schema.json').read_text())
            for channel in catalog['channels']:
                self.mongo.telemetry_channels.replace_one({'_id': channel['id']}, {'_id': channel['id'], **channel}, upsert=True)
        for label in ['Document', 'Section', 'Chunk', 'Asset', 'Entity']:
            self.cypher(f'CREATE CONSTRAINT {label.lower()}_id IF NOT EXISTS FOR (n:{label}) REQUIRE n.id IS UNIQUE')
            self.cypher(f'CREATE INDEX {label.lower()}_mission IF NOT EXISTS FOR (n:{label}) ON (n.mission)')
        self.cypher('CREATE FULLTEXT INDEX chunk_text IF NOT EXISTS FOR (c:Chunk) ON EACH [c.text]')

    def cypher(self, query, **params):
        with self.graph.session() as session:
            return [r.data() for r in session.run(query, **params)]

    def sql(self, query, params=None):
        r = self.http.post('/api/v3/query_sql', json={'db': self.settings.influx_database, 'q': query, 'format': 'json', 'params': params or {}})
        r.raise_for_status()
        return r.json()

    def write_lines(self, lines):
        for start in range(0, len(lines), 500):
            r = self.http.post('/api/v3/write_lp', params={'db': self.settings.influx_database, 'precision': 'nanosecond', 'accept_partial': 'false'}, content='\n'.join(lines[start:start + 500]), headers={'Content-Type': 'text/plain'})
            r.raise_for_status()

    def vector_index(self, dimensions):
        name = self.settings.qdrant_collection
        if not self.vectors.collection_exists(name):
            self.vectors.create_collection(name, vectors_config=models.VectorParams(size=dimensions, distance=models.Distance.COSINE))
        config = self.vectors.get_collection(name).config.params.vectors
        if config.size != dimensions or config.distance != models.Distance.COSINE:
            raise ValueError('Qdrant collection vector configuration differs from embedder')
        self.vectors.create_payload_index(name, 'document_id', models.PayloadSchemaType.KEYWORD, wait=True)
        self.vectors.create_payload_index(name, 'section_id', models.PayloadSchemaType.KEYWORD, wait=True)

    def write_vectors(self, chunks, vectors):
        for start in range(0, len(chunks), 100):
            points = [models.PointStruct(id=str(uuid.uuid5(uuid.NAMESPACE_URL, chunk['_id'])), vector=vectors[i].tolist(),
                payload={'chunk_id': chunk['_id'], 'document_id': chunk['document_id'], 'section_id': chunk['section_id'], 'page': chunk['page'], 'kind': chunk['kind']})
                for i, chunk in enumerate(chunks[start:start+100], start=start)]
            self.vectors.upsert(self.settings.qdrant_collection, points, wait=True)
