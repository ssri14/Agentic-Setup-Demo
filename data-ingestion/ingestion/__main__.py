import argparse
import json
import os
from pathlib import Path
from .settings import Settings
from .missions import DEFAULT_MISSION, resolve, create_mission, list_missions, ensure_registry, migrate_graph
from .telemetry import load_run


def emit(value):
    print(json.dumps(value, indent=2, default=str), flush=True)


def main():
    parser = argparse.ArgumentParser(description='Mission data ingestion and retrieval verification')
    parser.add_argument('--mission', default=os.getenv('MISSION', DEFAULT_MISSION), help='Registered mission ID (default: brahmastra)')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('init', help='Check all stores and create constraints/indexes')
    commands.add_parser('status', help='List ingestion records and active versions')
    commands.add_parser('missions', help='List registered missions and their stores')
    m = commands.add_parser('create-mission', help='Register a new mission with isolated stores')
    m.add_argument('mission_id')
    m.add_argument('name')
    m.add_argument('--description', default='')
    t = commands.add_parser('telemetry', help='Validate and ingest public run folders')
    t.add_argument('--run', help='Optional single public run ID')
    t.add_argument('--validate-only', action='store_true', help='Validate without database connections')
    d = commands.add_parser('documents', help='Extract, embed, and store PDFs')
    d.add_argument('--file', help="Filename relative to the mission's documents folder")
    d.add_argument('--enrich', action='store_true', help='Call the configured VLM for every page')
    d.add_argument('--extract-only', action='store_true', help='Write extraction JSON/artifacts without database connections or embeddings')
    q = commands.add_parser('window', help='Retrieve a source-time telemetry or event window')
    q.add_argument('dataset_id')
    q.add_argument('--start', type=float, default=0)
    q.add_argument('--end', type=float, default=10)
    q.add_argument('--channels', default='pwr_margin_pu,hlt_overall_state,daq_quality_pu')
    q.add_argument('--events', action='store_true')
    q.add_argument('--limit', type=int, default=100)
    s = commands.add_parser('search', help='Search an explicit document revision using semantic similarity')
    s.add_argument('document_id')
    s.add_argument('query')
    s.add_argument('--limit', type=int, default=5)
    n = commands.add_parser('section', help='Read a section and discover neighboring/related sections')
    n.add_argument('section_id')
    args = parser.parse_args()
    base = Settings()
    if args.mission == DEFAULT_MISSION:
        settings, record = resolve(base, args.mission)
    else:
        from pymongo import MongoClient
        client = MongoClient(host=base.mongo_host, username='ingestion', password=base.mongo_password, authSource='admin', serverSelectionTimeoutMS=10000)
        try:
            if args.command == 'create-mission':
                emit(create_mission(client, base, args.mission_id, args.name, args.description))
                return
            settings, record = resolve(base, args.mission, client)
        except (LookupError, ValueError) as exc:
            parser.error(str(exc))
        finally:
            client.close()
    if args.command == 'telemetry' and settings.telemetry_schema != 'brahmastra-rc1':
        parser.error(f'Mission {settings.mission!r} has no registered telemetry schema')
    if args.command == 'telemetry':
        if args.run and (Path(args.run).name != args.run or not args.run.startswith('BM-RUN-')):
            parser.error('--run must be a public run folder name')
        folders = [settings.telemetry / args.run] if args.run else sorted(settings.telemetry.glob('BM-RUN-*'))
        if not folders:
            parser.error('No telemetry runs found')
        if args.validate_only:
            for folder in folders:
                m, rows, events, identity = load_run(folder, settings.telemetry)
                emit({'run_id': m['run_id'], 'rows': len(rows), 'events': len(events), 'dataset_id': identity, 'status': 'valid'})
            return
    if args.command == 'documents':
        files = [settings.documents / args.file] if args.file else sorted(settings.documents.rglob('*.pdf'))
        if not files:
            parser.error('No PDFs found')
        if args.extract_only:
            from .documents import extract_pdf
            for path in files:
                metadata, sections, chunks, assets = extract_pdf(path, settings, args.enrich)
                target = settings.artifacts / metadata['_id'] / 'extraction.json'
                target.write_text(json.dumps({'document': metadata, 'sections': sections, 'chunks': chunks, 'assets': assets}, indent=2))
                emit({'document': metadata, 'report': str(target)})
            return
    from .stores import Stores
    stores = Stores(settings)
    try:
        if args.command == 'create-mission':
            emit(create_mission(stores.mongo_client, base, args.mission_id, args.name, args.description))
            return
        if args.command == 'missions':
            emit(list_missions(stores.mongo_client, base))
            return
        stores.init()
        ensure_registry(stores.mongo_client, base)
        if args.command == 'init':
            emit({'status': 'ready', 'mission': settings.mission, 'databases': ['InfluxDB 3 Core', 'Neo4j', 'MongoDB', 'Qdrant'],
                'graph_migration': migrate_graph(stores)})
        elif args.command == 'telemetry':
            from .pipeline import ingest_run
            for folder in folders:
                emit(ingest_run(folder, stores))
        elif args.command == 'documents':
            from .documents import Embedder
            from .pipeline import ingest_document
            embedder = Embedder(settings)
            for path in files:
                emit(ingest_document(path, stores, embedder, args.enrich))
        elif args.command == 'status':
            emit({'telemetry_runs': list(stores.mongo.telemetry_runs.find({}, {'manifest': 0})),
                'documents': list(stores.mongo.documents.find()), 'jobs': list(stores.mongo.ingestion_jobs.find())})
        elif args.command == 'window':
            from .retrieval import telemetry_window, events_window
            if args.events:
                emit(events_window(stores, args.dataset_id, args.start, args.end))
            else:
                emit(telemetry_window(stores, args.dataset_id, args.start, args.end, args.channels.split(','), args.limit))
        elif args.command == 'section':
            from .retrieval import section_context
            emit(section_context(stores, args.section_id))
        elif args.command == 'search':
            from .documents import Embedder
            from .retrieval import search_documents
            emit(search_documents(stores, args.query, Embedder(settings), args.document_id, args.limit))
    finally:
        stores.close()

if __name__ == '__main__':
    main()
