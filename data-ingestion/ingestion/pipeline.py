from datetime import datetime, timezone
import json
from pymongo import ReplaceOne
from . import PIPELINE_VERSION
from .telemetry import load_run, line_protocol
from .documents import extract_pdf, related_sections, stable_id


def now():
    return datetime.now(timezone.utc)


def put_many(collection, records):
    if records:
        collection.bulk_write([ReplaceOne({'_id': row['_id']}, row, upsert=True) for row in records], ordered=True)


def ingest_run(folder, stores):
    if stores.settings.telemetry_schema != 'brahmastra-rc1':
        raise ValueError(f'Mission {stores.settings.mission!r} has no registered telemetry schema')
    manifest, rows, events, dataset_id = load_run(folder, stores.settings.telemetry)
    record = {'_id': dataset_id, 'run_id': manifest['run_id'], 'manifest': manifest,
        'source_relative_path': folder.name, 'status': 'loading', 'updated_at': now(), 'pipeline_version': PIPELINE_VERSION}
    stores.mongo.telemetry_runs.replace_one({'_id': dataset_id}, record, upsert=True)
    try:
        stores.write_lines([line_protocol('telemetry', row, dataset_id) for row in rows])
        stores.write_lines([line_protocol('mission_events', event, dataset_id) for event in events])
        counts = {}
        for table in ['telemetry', 'mission_events']:
            result = stores.sql(f'SELECT count(*) AS n FROM {table} WHERE dataset_id = $dataset AND time >= $start AND time <= $end',
                {'dataset': dataset_id, 'start': manifest['source_time_min'], 'end': manifest['source_time_max']})
            counts[table] = result[0]['n']
        if counts != {'telemetry': len(rows), 'mission_events': len(events)}:
            raise ValueError(f'Persisted counts differ from validated source: {counts}')
        stores.mongo.telemetry_runs.update_one({'_id': dataset_id}, {'$set': {'status': 'complete', 'counts': counts, 'updated_at': now()}})
    except Exception as exc:
        stores.mongo.telemetry_runs.update_one({'_id': dataset_id}, {'$set': {'status': 'failed', 'error_type': type(exc).__name__, 'updated_at': now()}})
        raise
    return {'run_id': manifest['run_id'], 'dataset_id': dataset_id, **counts, 'status': 'complete'}


def ingest_document(path, stores, embedder, enrich=False, progress=None):
    settings = stores.settings
    mission = settings.mission
    report_stage = progress or (lambda stage, current=None, total=None: None)
    # Every embedding in the index must be comparable. Changing the model/revision
    # requires a separate database/collection, rather than mixing unrelated vector spaces.
    model = {'model': settings.embedding_model, 'revision': settings.embedding_revision, 'dimensions': embedder.dimensions}
    stores.mongo.configuration.update_one({'_id': 'embedding'}, {'$setOnInsert': model}, upsert=True)
    stored = stores.mongo.configuration.find_one({'_id': 'embedding'})
    if any(stored[k] != v for k, v in model.items()):
        raise ValueError('Embedding model/revision differs from this database; use a new database and vector index')
    extraction_job = stable_id('extraction', str(path), settings.embedding_model, enrich)
    stores.mongo.ingestion_jobs.replace_one({'_id': extraction_job}, {'_id': extraction_job, 'source_name': path.name, 'stage': 'extraction', 'status': 'loading', 'updated_at': now()}, upsert=True)
    try:
        metadata, sections, chunks, assets = extract_pdf(path, settings, enrich, progress)
    except Exception as exc:
        stores.mongo.ingestion_jobs.update_one({'_id': extraction_job}, {'$set': {'status': 'failed', 'error_type': type(exc).__name__, 'updated_at': now()}})
        raise
    stores.mongo.ingestion_jobs.update_one({'_id': extraction_job}, {'$set': {'status': 'complete', 'document_id': metadata['_id'], 'updated_at': now()}})
    docid = metadata['_id']
    # Neo4j is shared by all missions. The same PDF/profile would yield the same graph IDs,
    # so a document revision may belong to only one mission.
    owner = stores.cypher('MATCH (d:Document {id:$id}) RETURN d.mission AS mission', id=docid)
    if owner and owner[0]['mission'] not in (None, mission):
        raise ValueError(f'This document revision is already ingested for mission {owner[0]["mission"]!r}')
    report = settings.artifacts / docid / 'extraction.json'
    report.write_text(json.dumps({'document': metadata, 'sections': sections, 'chunks': chunks, 'assets': assets}, indent=2))
    job_id = stable_id(docid, 'job')
    stores.mongo.ingestion_jobs.replace_one({'_id': job_id}, {'_id': job_id, 'document_id': docid, 'status': 'loading', 'updated_at': now()}, upsert=True)
    stores.mongo.documents.replace_one({'_id': docid}, {**metadata, 'mission': mission, 'status': 'loading', 'updated_at': now()}, upsert=True)
    stores.cypher('MERGE (d:Document {id:$id}) SET d.status="loading", d.name=$name, d.mission=$mission', id=docid, name=path.name, mission=mission)
    try:
        report_stage('embedding', None, len(chunks))
        vectors = embedder.encode([c['text'] for c in chunks])
        semantic, keyword = related_sections(sections, chunks, vectors, settings)
        report_stage('publishing')
        put_many(stores.mongo.sections, sections)
        put_many(stores.mongo.chunks, chunks)
        put_many(stores.mongo.assets, assets)
        stores.vector_index(embedder.dimensions)
        stores.write_vectors(chunks, vectors)
        # All document graph writes form one Neo4j transaction. Mongo publication
        # follows verification; cross-database atomic transactions are not claimed.
        with stores.graph.session() as session:
            def publish(tx):
                tx.run('MATCH (d:Document {id:$id}) SET d.source_sha256=$sha, d.embedding_model=$model', id=docid, sha=metadata['source_sha256'], model=settings.embedding_model).consume()
                tx.run('''UNWIND $rows AS r MATCH (d:Document {id:r.document_id})
                  MERGE (s:Section {id:r._id}) SET s += {document_id:r.document_id, mission:$mission, label:r.label, title:r.title, ordinal:r.ordinal, page_start:r.page_start, page_end:r.page_end}
                  MERGE (d)-[:HAS_SECTION]->(s)''', rows=sections, mission=mission).consume()
                next_rows = [{'a': a['_id'], 'b': b['_id']} for a, b in zip(sections, sections[1:])]
                tx.run('''UNWIND $rows AS r MATCH (a:Section {id:r.a}), (b:Section {id:r.b})
                  MERGE (a)-[:NEXT]->(b) MERGE (b)-[:PREVIOUS]->(a)''', rows=next_rows).consume()
                for offset in range(0, len(chunks), 100):
                    batch = chunks[offset:offset+100]
                    tx.run('''UNWIND $rows AS r MATCH (s:Section {id:r.section_id})
                      MERGE (c:Chunk {id:r._id}) SET c += {document_id:r.document_id, mission:$mission, section_id:r.section_id, text:r.text, ordinal:r.ordinal, page:r.page, kind:r.kind}
                      MERGE (s)-[:HAS_CHUNK]->(c)
                      WITH c,r UNWIND r.entities AS name MERGE (e:Entity {id:$mission + ':' + name}) SET e.name=name, e.mission=$mission MERGE (c)-[:MENTIONS]->(e)''', rows=batch, mission=mission).consume()
                tx.run('''UNWIND $rows AS r MATCH (s:Section {id:r.section_id})
                  MERGE (a:Asset {id:r._id}) SET a.document_id=r.document_id, a.mission=$mission, a.page=r.page, a.kind=r.kind
                  MERGE (s)-[:HAS_ASSET]->(a)''', rows=assets, mission=mission).consume()
                tx.run('''UNWIND $rows AS r MATCH (a:Section {id:r.source}), (b:Section {id:r.target})
                  MERGE (a)-[e:RELATED_SEMANTIC]->(b) SET e.score=r.score, e.model=$model''', rows=semantic, model=settings.embedding_model).consume()
                tx.run('''UNWIND $rows AS r MATCH (a:Section {id:r.source}), (b:Section {id:r.target})
                  MERGE (a)-[e:RELATED_KEYWORD]->(b) SET e.keywords=r.keywords''', rows=keyword).consume()
                references = []
                targets = {s['label']: s['_id'] for s in sections}
                import re
                for c in chunks:
                    for label in set(re.findall(r'\bSEC-\d{2}\b', c['text'])):
                        if label in targets and targets[label] != c['section_id']:
                            references.append({'source': c['_id'], 'target': targets[label]})
                tx.run('''UNWIND $rows AS r MATCH (c:Chunk {id:r.source}), (s:Section {id:r.target}) MERGE (c)-[:REFERS_TO]->(s)''', rows=references).consume()
                # Also preserve reading order inside each section.
                links = [{'a': a['_id'], 'b': b['_id']} for a, b in zip(chunks, chunks[1:]) if a['section_id'] == b['section_id']]
                tx.run('''UNWIND $rows AS r MATCH (a:Chunk {id:r.a}), (b:Chunk {id:r.b}) MERGE (a)-[:NEXT_CHUNK]->(b)''', rows=links).consume()
            session.execute_write(publish)
        report_stage('verifying')
        counts = stores.cypher('''MATCH (d:Document {id:$id})-[:HAS_SECTION]->(s:Section)
          OPTIONAL MATCH (s)-[:HAS_CHUNK]->(c:Chunk) RETURN count(DISTINCT s) AS sections, count(c) AS chunks''', id=docid)[0]
        if counts != {'sections': len(sections), 'chunks': len(chunks)}:
            raise ValueError(f'Graph counts differ from extracted source: {counts}')
        for name, expected in [('sections', len(sections)), ('chunks', len(chunks)), ('assets', len(assets))]:
            if stores.mongo[name].count_documents({'document_id': docid}) != expected:
                raise ValueError(f'MongoDB {name} count mismatch')
        from qdrant_client import models
        vector_count = stores.vectors.count(settings.qdrant_collection, count_filter=models.Filter(must=[models.FieldCondition(key='document_id', match=models.MatchValue(value=docid))]), exact=True).count
        if vector_count != len(chunks):
            raise ValueError('Qdrant vector count mismatch')
        stores.cypher('MATCH (d:Document {id:$id}) SET d.status="complete"', id=docid)
        stores.mongo.documents.update_one({'_id': docid}, {'$set': {'status': 'complete', 'updated_at': now()}})
        stores.mongo.ingestion_jobs.update_one({'_id': job_id}, {'$set': {'status': 'complete', 'updated_at': now()}})
    except Exception as exc:
        stores.mongo.documents.update_one({'_id': docid}, {'$set': {'status': 'failed', 'error_type': type(exc).__name__}})
        stores.mongo.ingestion_jobs.update_one({'_id': job_id}, {'$set': {'status': 'failed', 'error_type': type(exc).__name__, 'updated_at': now()}})
        stores.cypher('MATCH (d:Document {id:$id}) SET d.status="failed"', id=docid)
        raise
    return {'document_id': docid, **counts, 'assets': len(assets), 'status': 'complete', 'extraction_status': metadata['extraction_status'], 'warnings': metadata['warnings']}
