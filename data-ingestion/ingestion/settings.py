import json
import os
from dataclasses import dataclass, field
from pathlib import Path


def _missions_root():
    return Path(os.getenv('MISSIONS_ROOT', 'missions'))


def _mission():
    return os.getenv('MISSION', 'brahmastra')


@dataclass
class Settings:
    influx_url: str = field(default_factory=lambda: os.getenv('INFLUX_URL', 'http://localhost:8181'))
    influx_database: str = field(default_factory=lambda: os.getenv('INFLUX_DATABASE', 'brahmastra'))
    neo4j_uri: str = field(default_factory=lambda: os.getenv('NEO4J_URI', 'bolt://localhost:7687'))
    neo4j_password: str = field(default_factory=lambda: os.environ.get('NEO4J_PASSWORD', ''))
    mongo_host: str = field(default_factory=lambda: os.getenv('MONGO_HOST', 'localhost'))
    mongo_password: str = field(default_factory=lambda: os.environ.get('MONGO_PASSWORD', ''))
    mongo_database: str = field(default_factory=lambda: os.getenv('MONGO_DATABASE', 'brahmastra'))
    # A mission owns one document folder, one telemetry folder, one MongoDB database,
    # one InfluxDB database and one Qdrant collection. Neo4j nodes carry its ID.
    mission: str = field(default_factory=_mission)
    telemetry_schema: str | None = 'brahmastra-rc1'
    missions_root: Path = field(default_factory=_missions_root)
    documents: Path = field(default_factory=lambda: Path(os.getenv('DOCUMENT_INPUT') or _missions_root() / _mission() / 'documents'))
    telemetry: Path = field(default_factory=lambda: Path(os.getenv('TELEMETRY_INPUT') or _missions_root() / _mission() / 'telemetry'))
    artifacts: Path = field(default_factory=lambda: Path(os.getenv('ARTIFACT_ROOT', 'artifacts')))
    embedding_model: str = field(default_factory=lambda: os.getenv('EMBEDDING_MODEL', 'sentence-transformers/all-MiniLM-L6-v2'))
    embedding_revision: str = field(default_factory=lambda: os.getenv('EMBEDDING_REVISION', 'c9745ed1d9f207416be6d2e6f8de32d1f16199bf'))
    chunk_chars: int = field(default_factory=lambda: int(os.getenv('CHUNK_CHARS', '1800')))
    similarity_threshold: float = field(default_factory=lambda: float(os.getenv('SIMILARITY_THRESHOLD', '0.65')))
    similarity_top_k: int = field(default_factory=lambda: int(os.getenv('SIMILARITY_TOP_K', '5')))
    keyword_min_shared: int = field(default_factory=lambda: int(os.getenv('KEYWORD_MIN_SHARED', '2')))

    qdrant_url: str = field(default_factory=lambda: os.getenv('QDRANT_URL', 'http://localhost:6333'))
    qdrant_collection: str = field(default_factory=lambda: os.getenv('QDRANT_COLLECTION', 'document_chunks'))

    @property
    def influx_token(self):
        return json.loads(Path(os.getenv('INFLUX_TOKEN_FILE', 'secrets/influx-admin.json')).read_text())['token']
