-- Brahmastra telemetry — demo queries for InfluxDB 3 Explorer (database: brahmastra).
-- All runs share the fictional source window 2026-01-01 00:00–00:15 UTC; run_id selects a run.

-- 1. Records and events stored per run (dropout runs have fewer than 1,800 samples)
SELECT run_id, count(*) AS samples
FROM telemetry
WHERE time >= '2026-01-01T00:00:00Z' AND time < '2026-01-01T00:15:00Z'
GROUP BY run_id
ORDER BY run_id;

-- 2. One run's power and health signals over time (switch the result to a line chart)
SELECT time, pwr_bus_level_pu, pwr_margin_pu, hlt_warning_count
FROM telemetry
WHERE run_id = 'BM-RUN-0001'
  AND time >= '2026-01-01T00:00:00Z' AND time < '2026-01-01T00:15:00Z'
ORDER BY time;

-- 3. Phase progression in one run: when each subphase starts
SELECT seq_subphase_id, min(mission_elapsed_s) AS starts_at_s, max(mission_elapsed_s) AS ends_at_s
FROM telemetry
WHERE run_id = 'BM-RUN-0001'
  AND time >= '2026-01-01T00:00:00Z' AND time < '2026-01-01T00:15:00Z'
GROUP BY seq_subphase_id
ORDER BY starts_at_s;

-- 4. Source loss versus delivery delay: delivery states and the DAQ missing-sample counter per run
SELECT run_id, delivery_state, count(*) AS samples, max(daq_missing_samples) AS missing_counter
FROM telemetry
WHERE time >= '2026-01-01T00:00:00Z' AND time < '2026-01-01T00:15:00Z'
GROUP BY run_id, delivery_state
ORDER BY run_id, delivery_state;

-- 5. The event log of one run, in source-time order
SELECT mission_elapsed_s, event_seq, subsystem_id, "type", message
FROM mission_events
WHERE run_id = 'BM-RUN-0001'
  AND time >= '2026-01-01T00:00:00Z' AND time < '2026-01-01T00:15:00Z'
ORDER BY time, event_seq;

-- 6. Compare one signal across three runs (line chart, grouped by run_id)
SELECT time, run_id, thm_core_temp_pu
FROM telemetry
WHERE run_id IN ('BM-RUN-0001', 'BM-RUN-0007', 'BM-RUN-0016')
  AND time >= '2026-01-01T00:00:00Z' AND time < '2026-01-01T00:15:00Z'
ORDER BY time;
