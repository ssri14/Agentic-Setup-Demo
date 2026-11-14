# 2. Generating and ingesting telemetry

Brahmastra's telemetry is **synthetic and non-operational**. It is generated from a registry of 14 fictional subsystems and 48 channels, to give an agent realistic diagnostic puzzles. This guide covers how the data is shaped, how to regenerate and validate it, and how to load it into the stores.

The repository already contains the 24 generated runs in `data-ingestion/missions/brahmastra/telemetry/`. If you only want to load them, skip to [Ingest](#4-ingest).

- [The dataset](#the-dataset)
- [1. Generate](#1-generate)
- [2. Validate](#2-validate)
- [3. Copy into the mission](#3-copy-into-the-mission)
- [4. Ingest](#4-ingest)
- [5. Check what was stored](#5-check-what-was-stored)
- [Re-ingesting and revisions](#re-ingesting-and-revisions)
- [Troubleshooting](#troubleshooting)

## The dataset

| | |
|---|---|
| Subsystems | 14: `CFG PWR THM CLK HLT DAQ COM SUP SEQ STG ENV ACT SAF LOG` |
| Channels | 48, typed (float `_pu` normalized units, integer counters, Booleans, enum states) |
| Mission phases | 7 phases, 14 subphases (`P0A` … `P6B`): Preparation → Readiness → Initial observation → Stage transition → Continued observation → Terminal safe state → Post-run reconciliation |
| Runs | 24 (`BM-RUN-0001` … `BM-RUN-0024`): 8 scenario families × 3 deterministic seeds |
| Length | 900 s at 2 Hz = 1,800 scheduled samples per run; 43,200 slots in total |
| Observed | 43,038 rows: 162 intentionally missing in the three source-dropout runs (`BM-RUN-0010`, `-0011`, `-0012`) |
| Events | 504 time-stamped events |

Each run is a folder with three files:

| File | Contents |
|---|---|
| `telemetry.csv` | 6 record columns (`run_id, sample_index, mission_elapsed_s, source_time_utc, received_time_utc, delivery_state`) + 48 channel columns, sorted by source time |
| `events.jsonl` | One JSON event per line (`event_seq, type, subsystem_id, message, source_time_utc, received_time_utc, mission_elapsed_s, …`) |
| `run_manifest.json` | Counts, sampling rate, time bounds, generator and registry versions, SHA-256 of the two data files |

**Two clocks, deliberately.** `source_time_utc` is when a sample was acquired; `received_time_utc` is when it was delivered. All runs start at the fictional epoch `2026-01-01T00:00:00Z` and cover the half-open interval `[0, 900)` s.

- A **source dropout** removes rows entirely: the `sample_index` sequence jumps, and the DAQ cumulative counter `daq_missing_samples` rises when acquisition recovers. Example: `BM-RUN-0010` loses samples 643–693, from 322.0 to 346.5 s.
- A **communication interruption** keeps every row but delivers some late: they are marked `delivery_state = BACKFILLED`, with receive times tens of seconds after their source times.

Telling these apart is one of the questions the agent is built to answer, so the loader never fills gaps and never re-times rows.

**Ground truth is kept apart.** Generating also writes `evaluator_only/`: each run's scenario, cause and onset/offset times, i.e. the answers. That folder is excluded from Git (`telemetry-generator/.gitignore`). It must **never** be copied into a mission folder, embedded, or shown to the agent. Use it only to score answers.

## 1. Generate

Needs Python 3.10+ with NumPy and PyYAML.

```bash
cd telemetry-generator
python3 -m venv .venv && . .venv/bin/activate        # optional; Windows: .venv\Scripts\activate
pip install -r requirements.txt
python3 generator/generate.py
```

Output:

```
Generated 24 deterministic synthetic runs, 43,038 observed source rows.
```

This writes:

- `agent_visible/runs/BM-RUN-*/`: the public runs (what a mission ingests)
- `evaluator_only/private_run_index.json` and `evaluator_only/ground_truth/BM-RUN-*.json`: the answers
- `validation/generated_run_inventory.json`: per-run row and event counts

The generator is deterministic: the registry (`source_registry/master_specification.yaml`) and fixed seeds produce byte-identical files every time. The runs committed in `data-ingestion/missions/brahmastra/telemetry/` are exactly this output.

**Changing the data.** Scenarios, channels, phases and rules are defined in `source_registry/master_specification.yaml`; the signal model is in `generator/generate.py`. After any change, bump `GENERATOR_VERSION` in `generate.py`, regenerate and validate. The ingestion loader validates against the 48-channel schema in `data-ingestion/config/telemetry_schema.json`, so adding or renaming channels also needs that schema and the agent's channel dictionary updated.

## 2. Validate

```bash
python3 validation/validate.py
```

```
Status PASS; 62/62 checks; 43,038 observed samples; 504 events
```

The validator is independent of the generator. It reloads the exported CSV and JSONL and checks:

- every cell against the registry: types, ranges, enums;
- the 0.5 s sample grid, the gaps and the phase/subphase consistency;
- the telemetry interpretation rules;
- the scenario-specific evidence for all 8 families;
- that evaluator truth is isolated from the public files;
- that all 24 runs regenerate to identical SHA-256 hashes.

It writes `validation/VALIDATION_REPORT.md` (summary) and `validation/validation_report.json`. The JSON names each run's scenario, so it stays out of Git.

Optional: `python3 validation/build_handoff.py` (needs matplotlib) writes a private QC summary and preview plots into `evaluator_only/`.

## 3. Copy into the mission

Only the three public files of each run go into the mission folder. The helper checks each file against its manifest hash, and it refuses to read from `evaluator_only/`.

```bash
# from the repository root
python3 telemetry-generator/scripts/copy_runs.py --to data-ingestion/missions/brahmastra/telemetry
# replace existing runs, or copy just one:
python3 telemetry-generator/scripts/copy_runs.py --to data-ingestion/missions/brahmastra/telemetry --force
python3 telemetry-generator/scripts/copy_runs.py --to data-ingestion/missions/brahmastra/telemetry --run BM-RUN-0010 --force
```

`data-ingestion/missions/<mission>/telemetry/` is mounted into the ingestion containers as `/missions/<mission>/telemetry`.

## 4. Ingest

The stores must be running ([Guide 1](01-infrastructure.md)). There are two ways to load the runs.

**From the dashboard.** Open http://localhost:8090, pick **Brahmastra**, and press **Ingest runs** in the Telemetry bar; after a first load the button reads **Re-validate & load runs**. Progress and a log line per run appear in the job queue.

**From the command line**, in `data-ingestion/`:

```bash
docker compose run --rm ingest telemetry --validate-only     # preflight: no database connections
docker compose run --rm ingest telemetry                     # all runs
docker compose run --rm ingest telemetry --run BM-RUN-0010   # one run
```

Jobs run one at a time. Don't start CLI ingestion while a dashboard job is running.

For each run, the loader:

1. verifies both content hashes and the manifest counts;
2. checks all 54 columns, every typed value, the public enums, the UTC timestamps, the source sample grid and that cumulative counters never decrease;
3. refuses private labels (scenario or cause fields) in a manifest;
4. writes `telemetry` and `mission_events` measurements to InfluxDB in batches of 500. The source timestamp is the time index; `run_id`, `dataset_id` and (for events) `event_id` are tags;
5. stores the manifest and status in MongoDB (`telemetry_runs`) and the channel dictionary in `telemetry_channels`;
6. marks the run complete only after InfluxDB's counts match the file.

**Telemetry and missions.** Telemetry ingestion currently supports the Brahmastra RC1 schema (`telemetry_schema: brahmastra-rc1` in the mission registry). Missions created later start with documents only; their telemetry bar is hidden in the dashboard.

## 5. Check what was stored

```bash
docker compose run --rm ingest status          # runs, dataset IDs, completion
# paste a dataset_id from status:
docker compose run --rm ingest window DATASET_ID --start 310 --end 350 --channels daq_missing_samples,daq_quality_pu,pwr_margin_pu
docker compose run --rm ingest window DATASET_ID --start 310 --end 350 --events
```

In a browser:

- **InfluxDB 3 Explorer** (http://localhost:8888, `--profile viewers`): database `brahmastra`; paste queries from [`data-ingestion/viewers/influx_demo.sql`](../data-ingestion/viewers/influx_demo.sql), for example samples per run:
  ```sql
  SELECT run_id, count(*) AS samples FROM telemetry
  WHERE time >= '2026-01-01T00:00:00Z' AND time < '2026-01-01T00:15:00Z'
  GROUP BY run_id ORDER BY run_id;
  ```
  Set the chart's time range to 2026-01-01 00:00–00:15 UTC. Otherwise the x-axis spans months and the lines look flat.
- **mongo-express** (http://localhost:8081): database `brahmastra`, collection `telemetry_runs`, query `{"manifest.observed_samples": {"$lt": 1800}}` shows the three dropout runs.
- **The agent**: as a superuser, *Administration → Tool bench → `list_runs`*, or `telemetry_window` with `{"run_id": "BM-RUN-0010", "channels": ["daq_missing_samples"], "start": 300, "end": 360}`.

## Re-ingesting and revisions

- Loading **identical files again** rewrites the same points (same identities) and re-verifies the counts. It is safe and changes nothing.
- A **changed** manifest or data file creates a new **dataset revision** (a new `dataset_id`) instead of overwriting history. Queries and the agent use the latest complete revision of each run.
- A run that failed part-way can be retried with the same command. MongoDB only marks complete runs as complete.

## Troubleshooting

| Message | Meaning and fix |
|---|---|
| `BM-RUN-…: hash mismatch in telemetry.csv` (loader) or `does not match its manifest hash` (copy helper) | A file was edited or truncated after generation. Regenerate and copy again |
| `Restricted source folder` / `Private labels found in public manifest` | Something from `evaluator_only/` reached the mission folder. Remove it |
| `Cumulative counter decreased`, `Invalid sample time grid`, `Invalid enum …` | The data no longer follows the schema; validate it with `validation/validate.py` |
| `This mission has no registered telemetry schema` | Only Brahmastra-schema missions take telemetry (see above) |
| `No run folders found` | Folders must be named `BM-RUN-*` directly under `missions/<mission>/telemetry/` |
| Explorer shows nothing | Time range: the data is in 2026-01-01 00:00–00:15 UTC |
