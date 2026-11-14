"""Mission registry. Each mission gets isolated stores; Brahmastra maps onto the original ones.

The registry lives in its own MongoDB database. Store names are derived from the
mission ID when a mission is created and are then fixed in its record, so a later
naming change cannot silently re-point a mission at different data.
"""
import re
from dataclasses import replace
from datetime import datetime, timezone

REGISTRY_DATABASE = 'mission_registry'
DEFAULT_MISSION = 'brahmastra'
MISSION_ID = re.compile(r'^[a-z][a-z0-9_]{1,30}$')
RESERVED = {'admin', 'config', 'local', REGISTRY_DATABASE}


def now():
    return datetime.now(timezone.utc).isoformat()


def default_record(base):
    """Brahmastra keeps the database, bucket and collection names it was ingested with."""
    return {'_id': DEFAULT_MISSION, 'name': 'Brahmastra',
        'description': 'Fictional missile health-monitoring demonstration: mission document and 24 telemetry runs.',
        'mongo_database': base.mongo_database, 'influx_database': base.influx_database,
        'qdrant_collection': base.qdrant_collection, 'telemetry_schema': 'brahmastra-rc1'}


def new_record(mission_id, name, description=''):
    mission_id = (mission_id or '').strip()
    if not MISSION_ID.match(mission_id) or mission_id in RESERVED or mission_id.startswith('mission_'):
        raise ValueError('Mission ID must be 2-31 characters: lowercase letter first, then lowercase letters, digits or _')
    name = (name or '').strip()
    if not name or len(name) > 80:
        raise ValueError('Mission name is required (at most 80 characters)')
    return {'_id': mission_id, 'name': name, 'description': (description or '').strip()[:500],
        'mongo_database': f'mission_{mission_id}', 'influx_database': f'mission_{mission_id}',
        'qdrant_collection': f'{mission_id}_chunks', 'telemetry_schema': None, 'created_at': now()}


def settings_for(base, record):
    root = base.missions_root / record['_id']
    return replace(base, mission=record['_id'], mongo_database=record['mongo_database'],
        influx_database=record['influx_database'], qdrant_collection=record['qdrant_collection'],
        telemetry_schema=record.get('telemetry_schema'), documents=root / 'documents', telemetry=root / 'telemetry')


def registry(mongo_client):
    return mongo_client[REGISTRY_DATABASE].missions


def ensure_registry(mongo_client, base):
    missions = registry(mongo_client)
    missions.update_one({'_id': DEFAULT_MISSION}, {'$setOnInsert': {**default_record(base), 'created_at': now()}}, upsert=True)
    return missions


def list_missions(mongo_client, base):
    return list(ensure_registry(mongo_client, base).find().sort('_id', 1))


def get_mission(mongo_client, base, mission_id):
    record = ensure_registry(mongo_client, base).find_one({'_id': mission_id})
    if not record:
        raise LookupError(f'Unknown mission {mission_id!r}')
    return record


def create_mission(mongo_client, base, mission_id, name, description=''):
    record = new_record(mission_id, name, description)
    missions = ensure_registry(mongo_client, base)
    if missions.find_one({'_id': record['_id']}):
        raise ValueError(f'Mission {record["_id"]!r} already exists')
    taken = {r['mongo_database'] for r in missions.find({}, {'mongo_database': 1})}
    if record['mongo_database'] in taken or record['mongo_database'] in mongo_client.list_database_names():
        raise ValueError(f'Database {record["mongo_database"]!r} is already in use')
    missions.insert_one(record)
    for folder in ('documents', 'telemetry'):
        (base.missions_root / record['_id'] / folder).mkdir(parents=True, exist_ok=True)
    return record


def resolve(base, mission_id, mongo_client=None):
    """Settings for a mission. Brahmastra resolves without a database connection."""
    if mission_id == DEFAULT_MISSION:
        record = default_record(base)
        if mongo_client is not None:
            record = get_mission(mongo_client, base, mission_id)
        return settings_for(base, record), record
    if mongo_client is None:
        raise ValueError('Resolving a non-default mission requires the MongoDB registry')
    record = get_mission(mongo_client, base, mission_id)
    return settings_for(base, record), record


def migrate_graph(stores):
    """One-time, idempotent: tag pre-registry Brahmastra nodes and scope its entities."""
    tagged = stores.cypher('''MATCH (n) WHERE (n:Document OR n:Section OR n:Chunk OR n:Asset) AND n.mission IS NULL
      SET n.mission = $mission RETURN count(n) AS n''', mission=DEFAULT_MISSION)[0]['n']
    entities = stores.cypher('''MATCH (e:Entity) WHERE e.mission IS NULL
      SET e.mission = $mission, e.name = coalesce(e.name, e.id), e.id = $mission + ':' + coalesce(e.name, e.id)
      RETURN count(e) AS n''', mission=DEFAULT_MISSION)[0]['n']
    return {'nodes_tagged': tagged, 'entities_scoped': entities}
