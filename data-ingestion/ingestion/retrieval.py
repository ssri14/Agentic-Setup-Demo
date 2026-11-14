"""Bounded retrieval primitives for ingestion checks, ready for future tool wrappers."""
from .telemetry import CHANNELS


def telemetry_window(stores, dataset_id, start, end, channels, limit=100):
    if not 0 <= start < end <= 900 or not 1 <= limit <= 1800:
        raise ValueError('Require 0 <= start < end <= 900 and limit 1..1800')
    if not channels or set(channels) - CHANNELS:
        raise ValueError('Unknown or empty channel selection')
    run = stores.mongo.telemetry_runs.find_one({'_id': dataset_id, 'status': 'complete'})
    if not run:
        raise ValueError('Dataset is not completely ingested')
    # Column names are drawn from the registered allowlist, never arbitrary SQL.
    select = ', '.join('"' + c + '"' for c in channels)
    return stores.sql(f'''SELECT time, sample_index, mission_elapsed_s, source_time_utc, received_time_utc, delivery_state, {select}
      FROM telemetry WHERE dataset_id=$dataset AND time >= $epoch_start AND time <= $epoch_end
      AND mission_elapsed_s >= $start AND mission_elapsed_s < $end ORDER BY time LIMIT {limit}''',
      {'dataset': dataset_id, 'epoch_start': run['manifest']['source_time_min'], 'epoch_end': run['manifest']['source_time_max'], 'start': start, 'end': end})


def events_window(stores, dataset_id, start, end):
    if not 0 <= start < end <= 900:
        raise ValueError('Require 0 <= start < end <= 900')
    run = stores.mongo.telemetry_runs.find_one({'_id': dataset_id, 'status': 'complete'})
    if not run:
        raise ValueError('Dataset is not completely ingested')
    return stores.sql('''SELECT * FROM mission_events WHERE dataset_id=$dataset AND time >= $epoch_start AND time <= $epoch_end
      AND mission_elapsed_s >= $start AND mission_elapsed_s < $end ORDER BY time, event_seq LIMIT 1000''',
      {'dataset': dataset_id, 'epoch_start': run['manifest']['source_time_min'], 'epoch_end': run['manifest']['source_time_max'], 'start': start, 'end': end})


def section_context(stores, section_id):
    section = stores.mongo.sections.find_one({'_id': section_id})
    if not section or not stores.mongo.documents.find_one({'_id': section['document_id'], 'status': 'complete'}):
        raise ValueError('Section is not in a completely ingested document')
    links = stores.cypher('''MATCH (s:Section {id:$id})-[r:NEXT|PREVIOUS|RELATED_KEYWORD|RELATED_SEMANTIC]->(other:Section)
      RETURN type(r) AS relationship, other.id AS section_id, other.label AS label, other.title AS title,
      r.score AS score, r.keywords AS keywords ORDER BY relationship, score DESC''', id=section_id)
    chunks = list(stores.mongo.chunks.find({'section_id': section_id}, {'_id': 1, 'text': 1, 'page': 1, 'bbox': 1, 'kind': 1}).sort('ordinal', 1))
    return {'section': section, 'chunks': chunks, 'links': links}


def search_documents(stores, query, embedder, document_id, limit=5):
    if not 1 <= limit <= 20:
        raise ValueError('Search limit must be 1..20')
    metadata = stores.mongo.documents.find_one({'_id': document_id, 'status': 'complete'})
    if not metadata:
        raise ValueError('Select a completely ingested document revision')
    profile = metadata['profile']
    if (profile['embedding_model'], profile['embedding_revision']) != (stores.settings.embedding_model, stores.settings.embedding_revision):
        raise ValueError('Query embedder must match the ingestion profile')
    vector = embedder.encode([query])[0].tolist()
    from qdrant_client import models
    points = stores.vectors.query_points(stores.settings.qdrant_collection, query=vector,
        query_filter=models.Filter(must=[models.FieldCondition(key='document_id', match=models.MatchValue(value=document_id))]),
        limit=limit, with_payload=True).points
    hits = [{'chunk_id': p.payload['chunk_id'], 'section_id': p.payload['section_id'], 'score': p.score} for p in points]
    for hit in hits:
        hit['evidence'] = stores.mongo.chunks.find_one({'_id': hit['chunk_id']}, {'entities': 0})
    return hits
