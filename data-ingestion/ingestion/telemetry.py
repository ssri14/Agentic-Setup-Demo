"""Strict public-run validation and deterministic InfluxDB line protocol."""
import csv
import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

METADATA = ['run_id', 'sample_index', 'mission_elapsed_s', 'source_time_utc', 'received_time_utc', 'delivery_state']
STRINGS = '''cfg_profile_id cfg_revision_id clk_lock_state hlt_overall_state com_link_state sup_state sup_mode seq_phase_id seq_subphase_id stg_state act_state saf_state'''.split()
BOOLS = '''cfg_integrity_ok pwr_fault thm_warning hlt_degraded seq_pending stg_event act_fault saf_interlock_ok log_integrity_ok'''.split()
INTS = '''clk_resync_count hlt_warning_count daq_missing_samples sup_fault_count saf_event_count log_seq log_backlog'''.split()
FLOATS = '''pwr_bus_level_pu pwr_load_pu pwr_margin_pu thm_core_temp_pu thm_payload_temp_pu thm_delta_pu clk_offset_ms daq_rate_hz daq_quality_pu daq_buffer_pct com_loss_pct com_latency_ms com_gap_s sup_heartbeat_age_s seq_delay_s stg_ack_age_s env_pressure_pu env_temp_pu env_vibration_pu act_response_lag_ms'''.split()
CHANNELS = set(STRINGS + BOOLS + INTS + FLOATS)
ENUMS = {
    'cfg_profile_id': {'PROFILE-A', 'PROFILE-B'},
    'clk_lock_state': {'LOCKED', 'HOLDOVER', 'UNLOCKED'},
    'hlt_overall_state': {'NOMINAL', 'WARNING', 'DEGRADED', 'UNKNOWN'},
    'com_link_state': {'CONNECTED', 'DEGRADED', 'DISCONNECTED'},
    'sup_state': {'IDLE', 'READY', 'ACTIVE', 'SAFE', 'ARCHIVED'},
    'sup_mode': {'NORMAL', 'CAUTION', 'RECOVERY'},
    'seq_phase_id': {f'P{i}' for i in range(7)},
    'seq_subphase_id': {f'P{i}{s}' for i in range(7) for s in 'AB'},
    'stg_state': {'NOT_APPLICABLE', 'PENDING', 'CONFIRMED', 'UNKNOWN'},
    'act_state': {'IDLE', 'ACTIVE', 'DEGRADED', 'UNKNOWN'},
    'saf_state': {'CHECKING', 'READY', 'MONITORING', 'SAFE', 'UNKNOWN'},
}
COUNTERS = ['clk_resync_count', 'daq_missing_samples', 'sup_fault_count', 'saf_event_count', 'log_seq']

def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def utc_ns(value: str) -> int:
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None or dt.utcoffset().total_seconds() != 0:
        raise ValueError('Source and receipt timestamps must explicitly use UTC')
    delta = dt - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * 1_000_000_000 + delta.microseconds * 1000

def public_path(path: Path, root: Path):
    path.resolve().relative_to(root.resolve())
    forbidden = {'evaluator_only', 'source_registry', 'generator', 'validation'}
    if forbidden.intersection(path.resolve().parts):
        raise ValueError('Restricted source folder')

def load_run(folder: Path, root: Path):
    public_path(folder, root)
    manifest = json.loads((folder / 'run_manifest.json').read_text())
    run_id = manifest['run_id']
    if not re.fullmatch(r'BM-RUN-\d{4}', run_id) or run_id != folder.name:
        raise ValueError('Invalid or mismatched public run ID')
    if manifest.get('agent_visible_only') is not True:
        raise ValueError('Run is not explicitly agent-visible')
    if manifest.get('model_kind') != 'fictional_non_operational_telemetry':
        raise ValueError('Unsupported source model')
    forbidden_keys = {'scenario', 'scenario_id', 'seed', 'ground_truth', 'hidden_cause'}
    if forbidden_keys.intersection(manifest):
        raise ValueError('Private labels found in public manifest')
    for filename, key in [('telemetry.csv', 'telemetry_sha256'), ('events.jsonl', 'events_sha256')]:
        public_path(folder / filename, root)
        if sha256(folder / filename) != manifest[key]:
            raise ValueError(f'{run_id}: hash mismatch in {filename}')
    with (folder / 'telemetry.csv').open(newline='') as f:
        reader = csv.DictReader(f)
        if len(reader.fieldnames) != 54 or set(reader.fieldnames) != set(METADATA) | CHANNELS:
            raise ValueError('Expected six metadata columns and exactly 48 registered channels')
        raw = list(reader)
    rows = []
    previous = None
    epoch = utc_ns(manifest['source_time_min'])
    for item in raw:
        if None in item or any(v is None or v == '' for v in item.values()):
            raise ValueError('Malformed or missing CSV value')
        row = dict(item)
        if row['run_id'] != run_id or row['delivery_state'] not in {'DELIVERED', 'BACKFILLED'}:
            raise ValueError('Invalid row identity or delivery state')
        for name in BOOLS:
            if row[name] not in {'true', 'false'}:
                raise ValueError(f'Invalid Boolean {name}')
            row[name] = row[name] == 'true'
        for name in INTS + ['sample_index']:
            row[name] = int(row[name])
            if row[name] < 0:
                raise ValueError(f'Negative counter {name}')
        for name in FLOATS + ['mission_elapsed_s']:
            row[name] = float(row[name])
            if not math.isfinite(row[name]):
                raise ValueError(f'Non-finite channel {name}')
        for name, allowed in ENUMS.items():
            if row[name] not in allowed:
                raise ValueError(f'Invalid enum {name}')
        if not re.fullmatch(r'REV-\d{3}', row['cfg_revision_id']):
            raise ValueError('Invalid configuration revision')
        source = utc_ns(row['source_time_utc'])
        received = utc_ns(row['received_time_utc'])
        elapsed = row['sample_index'] / manifest['sampling_hz']
        if row['mission_elapsed_s'] != elapsed or not 0 <= elapsed < manifest['duration_s']:
            raise ValueError('Invalid sample time grid')
        if source != epoch + round(elapsed * 1e9) or received < source:
            raise ValueError('Source grid or receipt time invalid')
        if previous:
            if row['sample_index'] <= previous['sample_index']:
                raise ValueError('Duplicate or non-increasing sample index')
            if any(row[k] < previous[k] for k in COUNTERS):
                raise ValueError('Cumulative counter decreased')
        previous = row
        rows.append(row)
    events = [json.loads(line) for line in (folder / 'events.jsonl').read_text().splitlines() if line.strip()]
    seen = set()
    previous_time = -1
    for event in events:
        required = {'run_id', 'event_seq', 'mission_elapsed_s', 'source_time_utc', 'received_time_utc', 'subsystem_id', 'type', 'message'}
        if set(event) != required or event['run_id'] != run_id:
            raise ValueError('Invalid public event schema')
        if not isinstance(event['event_seq'], int) or event['event_seq'] in seen:
            raise ValueError('Duplicate or invalid event sequence')
        seen.add(event['event_seq'])
        source = utc_ns(event['source_time_utc'])
        if source < previous_time or utc_ns(event['received_time_utc']) < source:
            raise ValueError('Invalid event timestamp ordering')
        if source != epoch + round(float(event['mission_elapsed_s']) * 1e9):
            raise ValueError('Event elapsed time differs from source timestamp')
        previous_time = source
    if len(rows) != manifest['observed_samples'] or len(events) != manifest['event_count']:
        raise ValueError('Manifest count mismatch')
    if not rows or rows[-1]['source_time_utc'] != manifest['source_time_max']:
        raise ValueError('Manifest maximum timestamp mismatch')
    dataset_id = hashlib.sha256((sha256(folder / 'run_manifest.json') + manifest['telemetry_sha256'] + manifest['events_sha256']).encode()).hexdigest()
    return manifest, rows, events, dataset_id

def lp_tag(value):
    return str(value).replace('\\', '\\\\').replace(' ', '\\ ').replace(',', '\\,').replace('=', '\\=')

def lp_field(value):
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, int):
        return f'{value}i'
    if isinstance(value, float):
        return repr(value)
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r') + '"'

def line_protocol(table, row, dataset_id):
    tags = {'run_id': row['run_id'], 'dataset_id': dataset_id}
    # Multiple events share a source instant: event_seq is part of event point identity.
    if table == 'mission_events':
        tags['event_id'] = str(row['event_seq'])
    fields = {k: v for k, v in row.items() if k != 'run_id'}
    fields['received_time_ns'] = utc_ns(row['received_time_utc'])
    tag_string = ','.join(f'{k}={lp_tag(v)}' for k, v in tags.items())
    field_string = ','.join(f'{k}={lp_field(v)}' for k, v in sorted(fields.items()))
    return f'{table},{tag_string} {field_string} {utc_ns(row["source_time_utc"])}'
