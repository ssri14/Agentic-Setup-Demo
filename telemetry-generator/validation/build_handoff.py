#!/usr/bin/env python3
"""Build release notes, private QC summary and compact QC previews."""
import csv, json, hashlib
from pathlib import Path
from collections import Counter
import numpy as np
import yaml
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT=Path(__file__).resolve().parents[1]
REG=yaml.safe_load((ROOT/'source_registry/master_specification.yaml').read_text())
idx=json.loads((ROOT/'evaluator_only/private_run_index.json').read_text())['entries']
val=json.loads((ROOT/'validation/validation_report.json').read_text())
rows=[]
for e in idx:
    public=e['public_run_id'];private=json.loads((ROOT/f'evaluator_only/ground_truth/{public}.json').read_text())
    public_rows=list(csv.DictReader(open(ROOT/f'agent_visible/runs/{public}/telemetry.csv')))
    t=np.array([float(r['mission_elapsed_s']) for r in public_rows])
    v=lambda name:np.array([float(r[name]) for r in public_rows])
    rec=np.array([__import__('datetime').datetime.fromisoformat(r['received_time_utc'].replace('Z','+00:00')).timestamp() for r in public_rows])
    src=np.array([__import__('datetime').datetime.fromisoformat(r['source_time_utc'].replace('Z','+00:00')).timestamp() for r in public_rows])
    rows.append({'public_run_id':public,'scenario_id':e['scenario_id'],'seed':e['seed'],'observed_rows':len(t),'missing_rows':1800-len(t),
                 'max_hlt_warning_count':int(np.max(v('hlt_warning_count'))),'fault_samples':int(sum(r['pwr_fault']=='true' for r in public_rows)),
                 'max_delivery_delay_s':round(float(np.max(rec-src)),2),
                 'max_log_backlog':int(np.max(v('log_backlog'))),
                 'max_com_gap_s':round(float(np.max(v('com_gap_s'))),2),
                 'source_time_gap_count':int(np.sum(np.diff(t)>.501)),
                 'onset_s':private['onset_s'],'offset_s':private['offset_s']})
keys=list(rows[0])
with (ROOT/'evaluator_only/private_QC_summary.csv').open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=keys,lineterminator='\n');w.writeheader();w.writerows(rows)
# Compact human-readable summary, deliberately stored in evaluator_only.
lines=['# Scenario QA Summary — Evaluator Only','',
       '**Important:** Do not index this report into the agent retrieval system. Scenario labels are private.','',
       '| Scenario | Runs | Sample count | Planned missing | Key observed signature |',
       '|---|---:|---:|---:|---|']
notes={'S01':'Nominal phase progression, no warnings',
       'S02':'Reported P3B delayed relative to independent STG event',
       'S03':'Environmental measurement drifts without thermal reference shift',
       'S04':'Source-sample dropout, cumulative DAQ count jumps after gap',
       'S05':'Incorrect early event report plus late log arrival',
       'S06':'Power warning precedes thermal warning, aggregate degraded',
       'S07':'Complete source stream with delayed communication delivery',
       'S08':'Clock holdover, receipt delay and backlog'}
for s in range(1,9):
    sid=f'S{s:02d}';rr=[r for r in rows if r['scenario_id']==sid]
    lines.append(f'| {sid} | {len(rr)} | {sum(r["observed_rows"] for r in rr):,} | {sum(r["missing_rows"] for r in rr)} | {notes[sid]} |')
lines+=['','Total '+str(sum(r['observed_rows'] for r in rows))+' observed source records.',
        'Anomaly `offset_s` in private truth marks the last affected interval; for persistent drift/power degradations it is 900 s, while plateau time is separately recorded.','']
(ROOT/'evaluator_only/PRIVATE_QA_SUMMARY.md').write_text('\n'.join(lines))

# QA-only graphics; not the approved FIG-07/09/10/11 visuals.
plots=ROOT/'validation/qa_previews';plots.mkdir(exist_ok=True)
def extract(n):
    p=ROOT/f'agent_visible/runs/BM-RUN-{n:04d}/telemetry.csv'
    return list(csv.DictReader(open(p)))
def chart(filename, series, title, limits=None):
    fig,ax=plt.subplots(figsize=(11,4.4))
    for x,y,label in series:ax.plot(x,y,label=label,linewidth=1.25)
    ax.grid(alpha=.25);ax.set_xlabel('Mission elapsed time (seconds)');ax.set_title(title);ax.legend(loc='best',frameon=False)
    if limits:ax.set_xlim(*limits)
    fig.tight_layout();fig.savefig(plots/filename,dpi=145);plt.close(fig)

r=extract(1);t=np.array([float(x['mission_elapsed_s']) for x in r])
chart('QC_nominal_health.png',[(t,np.array([float(x['pwr_bus_level_pu']) for x in r]),'Power bus (pu)'),
                               (t,np.array([float(x['daq_quality_pu']) for x in r]),'DAQ quality (pu)')],
      'QC only — nominal run BM-RUN-0001 (all data synthetic)')
r=extract(7);t=np.array([float(x['mission_elapsed_s']) for x in r])
chart('QC_sensor_drift.png',[(t,np.array([float(x['env_temp_pu']) for x in r]),'Environmental measurement (pu)'),
                             (t,np.array([float(x['thm_payload_temp_pu']) for x in r]),'Independent reference (pu)')],
      'QC only — sensor drift BM-RUN-0007',limits=(300,650))
r=extract(16);t=np.array([float(x['mission_elapsed_s']) for x in r])
chart('QC_cascading_warnings.png',[(t,np.array([float(x['pwr_bus_level_pu']) for x in r]),'Power bus (pu)'),
                                   (t,np.array([float(x['thm_core_temp_pu']) for x in r]),'Thermal core (pu)')],
      'QC only — cascading warnings BM-RUN-0016',limits=(300,600))
r=extract(19);t=np.array([float(x['mission_elapsed_s']) for x in r]);rec=np.array([__import__('datetime').datetime.fromisoformat(x['received_time_utc'].replace('Z','+00:00')).timestamp() for x in r]);src=np.array([__import__('datetime').datetime.fromisoformat(x['source_time_utc'].replace('Z','+00:00')).timestamp() for x in r])
chart('QC_delivery_delay.png',[(t,rec-src,'Receipt delay (s)'),(t,np.array([float(x['com_gap_s']) for x in r]),'Reported COM gap (s)')],
      'QC only — delivery gap and backfill BM-RUN-0019',limits=(290,385))

readme='''# Brahmastra Synthetic Telemetry — Review Candidate 1

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
'''
(ROOT/'README.md').write_text(readme)
(ROOT/'agent_visible/README_FOR_INGESTION.md').write_text('''# Agent-visible synthetic telemetry\n\nContains only opaque public run IDs, observed channel values, source/receipt timestamps, and observed event records.\n\nNo scenario labels or evaluator ground-truth records are present in this directory.\n\n**Do not ingest** any folder named `evaluator_only`, `generator` or `source_registry`. The agent must find specifications in separately approved technical documents.\n''')
print('QA summary and four distinct preview plots created')
