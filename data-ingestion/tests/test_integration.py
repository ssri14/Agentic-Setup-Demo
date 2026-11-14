"""Live four-store checks, explicitly enabled with RUN_INTEGRATION=1."""
import os
from pathlib import Path
import pytest
from ingestion.settings import Settings
from ingestion.stores import Stores
from ingestion.pipeline import ingest_run
from ingestion.retrieval import telemetry_window, events_window

pytestmark = pytest.mark.skipif(os.getenv('RUN_INTEGRATION') != '1', reason='Live databases not requested')


def test_reingestion_and_time_semantics():
    settings = Settings()
    stores = Stores(settings)
    try:
        stores.init()
        result = ingest_run(settings.telemetry / 'BM-RUN-0001', stores)
        again = ingest_run(settings.telemetry / 'BM-RUN-0001', stores)
        assert result['dataset_id'] == again['dataset_id']
        assert again['telemetry'] == 1800
        events = events_window(stores, result['dataset_id'], 0, 1)
        assert len(events) == 2  # RUN_STARTED and SUBPHASE_ENTER must both survive.
        rows = telemetry_window(stores, result['dataset_id'], 0, 1, ['cfg_integrity_ok', 'pwr_margin_pu'])
        assert len(rows) == 2
        assert rows[0]['cfg_integrity_ok'] is True
        assert rows[0]['received_time_utc'] != rows[0]['source_time_utc']
    finally:
        stores.close()


def test_document_roundtrip_and_graph_navigation(tmp_path):
    """Exercise actual stores using isolated test data and deterministic test vectors."""
    import uuid
    import numpy as np
    import pymupdf
    from ingestion.pipeline import ingest_document
    from ingestion.retrieval import search_documents, section_context
    name = 'ingestion_test_' + uuid.uuid4().hex
    path = tmp_path / 'reference.pdf'
    with pymupdf.open() as pdf:
        for i, text in enumerate(['Source acquisition evidence', 'Delivery latency evidence'], start=1):
            page = pdf.new_page()
            page.insert_text((50,80), f'SEC-0{i} / REFERENCE')
            page.insert_text((50,180), text + ' ' + name)
        pdf.save(path)
    settings = Settings(documents=tmp_path, artifacts=tmp_path / 'assets', mongo_database=name, mission=name, telemetry_schema=None,
        qdrant_collection=name, embedding_model='test-vectors', embedding_revision='test-only')
    class TestEmbedder:
        dimensions = 3
        def encode(self, texts):
            vectors = np.array([[1, 1 if 'Source' in t else 0, 1 if 'Delivery' in t else 0] for t in texts], dtype=float)
            return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    stores = Stores(settings)
    docid = None
    try:
        stores.init()
        result = ingest_document(path, stores, TestEmbedder())
        docid = result['document_id']
        again = ingest_document(path, stores, TestEmbedder())
        assert result['chunks'] == again['chunks'] == 2
        hits = search_documents(stores, 'Source acquisition', TestEmbedder(), docid, 1)
        assert hits[0]['evidence']['page'] == 1
        context = section_context(stores, hits[0]['section_id'])
        assert any(link['relationship'] == 'NEXT' and link['label'] == 'SEC-02' for link in context['links'])
        second = next(link['section_id'] for link in context['links'] if link['relationship'] == 'NEXT')
        assert any(link['relationship'] == 'PREVIOUS' for link in section_context(stores, second)['links'])
    finally:
        if docid:
            stores.cypher('MATCH (n) WHERE n.document_id=$id DETACH DELETE n', id=docid)
            stores.cypher('MATCH (d:Document {id:$id}) DETACH DELETE d', id=docid)
            stores.cypher('MATCH (e:Entity {mission:$m}) DETACH DELETE e', m=name)
        if stores.vectors.collection_exists(name):
            stores.vectors.delete_collection(name)
        stores.mongo_client.drop_database(name)
        stores.close()
