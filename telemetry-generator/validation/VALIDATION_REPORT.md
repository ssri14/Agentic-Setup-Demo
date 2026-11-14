# Brahmastra Telemetry Validation — RC1

**Result:** PASS
**Independent checks:** 62/62 passed, 0 failed
**Runs:** 24; **source observations:** 43,038 / 43,200 scheduled slots
**Event records:** 504
**Nominal row counts:** [1800, 1800, 1800]

## Checks covered

- Registry namespace, source version, source hashes, 48-channel schema and per-cell domains
- Source and receipt timestamps, 0.5-second sample lattice, gaps, phase/subphase consistency
- R01 readiness; R02 source clock; R03 phase order; R05 source versus communication loss
- R06 health/warnings; R07 safe-state consistency; R08 event/counter continuity
- R09 thermal derived value; R10 cumulative counters; R12 evaluator-truth isolation
- Independent scenario-specific discriminating evidence for all 8 scenario classes
- All 24 runs regenerated: telemetry CSV and event JSONL SHA-256 equality
- Six intentional defect-detection tests

## Limits of this validation

- Fully synthetic, abstract system-observation data; no real-vehicle physical model or external hardware calibration
- The registry is still v1.1.0-rc1, a review candidate; this validates the exported telemetry against it, not the unrecovered original Deep Research YAML
- Scenario-specific evidence checks are implemented here, but fine-grained agent benchmark quality and all image/document cross-links are not yet evaluated
- R04 is checked as conflicting evidence in S02/S05, not as a universal deterministic causal inference
- R11 (visual provenance) awaits plotted FIG-07, FIG-09–11
- Agent-visible paths exclude evaluator-only files; ZIP contains both areas and must be separated before ingestion
- The underlying simulator creates stylized health and event states, not physical or weapon-engineering signals

