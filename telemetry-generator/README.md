# Brahmastra Synthetic Telemetry — Review Candidate 1

> **In this repository:** `agent_visible/` and `evaluator_only/` are created by `generator/generate.py` and are not committed (see `.gitignore`); the public runs are already versioned in `../data-ingestion/missions/brahmastra/telemetry/`, byte-identical to the generator's output. Install with `pip install -r requirements.txt`; copy runs into a mission with `scripts/copy_runs.py`. Step-by-step: [`../docs/02-telemetry.md`](../docs/02-telemetry.md). The original release notes follow.

## Scope

This package contains synthetic, **non-operational** aerospace health-monitoring data derived from the project’s reconstructed **Master Registry v1.1.0-rc1**. It is intended for multimodal Agentic AI diagnosis, not engineering design, flight dynamics, guidance, weapons operation, or real-world fault thresholds.

- 14 subsystems; 48 explicitly defined channels
- 7 phases, 14 subphases; P0A through P6B
- 8 scenario families; 3 deterministic seeds per scenario
- 24 runs of 900 seconds at a scheduled 2 Hz
- 1,800 scheduled source samples per run = 43,200 scheduled slots
- 43,038 observed source records; **162 intentionally absent** in the 3 source-dropout runs
- 504 time-stamped public events
- Independent validator: 62/62 checks passed (see `validation/VALIDATION_REPORT.md`)

## Read this before connecting data to an agent

**INDEX ONLY `agent_visible/` into the future application.** The full distribution deliberately contains an `evaluator_only/` directory and the original registry in `source_registry/`. `evaluator_only/` includes cause labels, run-scenario mapping and benchmark answer information. Those records **must never enter agent retrieval tools, embeddings, VLM figure contexts, or chat prompts**. Restrict file-system permissions as well as retrieval scope.

Agent-facing IDs are opaque (`BM-RUN-0001` to `BM-RUN-0024`). There are no scenario codes in their filenames or public manifests. The private index maps each to its underlying S01–S08 scenario; use only for scoring and quality assurance.

## Files

- `source_registry/master_specification.yaml`: complete local reconstructed registry, not the unrecovered original research YAML
- `agent_visible/runs/<run>/telemetry.csv`: 48 data channels + six record metadata columns
- `agent_visible/runs/<run>/events.jsonl`: ordered by *source event time*, not receipt time
- `agent_visible/runs/<run>/run_manifest.json`: source/version hashes, row counts, timing semantics
- `evaluator_only/private_run_index.json`: internal scenario ID, seed, public ID association
- `evaluator_only/ground_truth/<run>.json`: evaluator-only anomaly cause/times/evidence
- `generator/generate.py`: reproducible Python/NumPy generator
- `validation/validate.py`: independent exported-data, event and scenario validator
- `validation/VALIDATION_REPORT.md`: high-level validation outcome and limitations
- `validation/qa_previews/`: non-authoritative visual QA plots; not the final document figures

## Timestamp policy

Samples use a **half-open** 900-second interval `[0,900)` at 0.5-second grid steps, from `2026-01-01T00:00:00.000Z` (a fictional source epoch). `source_time_utc` records acquisition time, while `received_time_utc` represents delivery/receipt; in delivery incidents, receive time can be tens of seconds later. Files are sorted by source time, and backfilled receipt times are not necessarily monotonic in source order.

A *source dropout* removes recorded source rows entirely and increments the DAQ cumulative missing counter on recovery; a *communication interruption* preserves source rows and marks delayed rows as `BACKFILLED` with delayed receipt times. This is intentional.

Numeric `_pu` channels are arbitrary normalized units and have no real-world calibrated engineering meaning. Values are synthetic, including temperature/pressure analogues.

## Reproducibility

From the package root, with Python, NumPy and PyYAML installed:

```bash
python generator/generate.py
python validation/validate.py
```

The validator reloads exported CSV/JSONL, independently checks each row, regenerates all 24 runs in temporary directories, and compares SHA-256 hashes of regenerated telemetry and event files. It also checks the integrity of public manifests and truth isolation.

## Status and gates

- **Complete for RC1:** source telemetry, time-stamped events, public manifests, evaluator ground truth, scenario coverage, exported-file validation, 24-run hash reproducibility
- **Pending:** human review of scenario behavior; approval of Master Registry RC1 as an authoritative spec; FIG-07 and FIG-09/10/11 generated and audited from these actual records; figure-to-document links and 34 agent benchmark executions

As RC1 is not a frozen, approved canonical system registry, treat this release as a **validated simulation candidate**, not final production data.
