# Showing the stored data in a browser

Four browser views, one per store. All bind to `localhost` only, and the two added viewers run read-only.

| Store | Viewer | URL | Login |
|---|---|---|---|
| All services | Ingestion dashboard (health, missions, ingestion) | http://localhost:8090 | none |
| MongoDB | mongo-express (read-only) | http://localhost:8081 | `viewer` / `VIEWER_PASSWORD` from `.env` |
| Qdrant | Built-in dashboard | http://localhost:6333/dashboard | none |
| InfluxDB 3 | InfluxDB 3 Explorer (query mode) | http://localhost:8888 | none (preconfigured server) |
| Neo4j | Neo4j Browser | http://localhost:7474 | `neo4j` / `NEO4J_PASSWORD` from `.env` |

## Start

From `data-ingestion/`:

```bash
python3 scripts/setup.py                    # adds viewer secrets; preserves existing credentials
docker compose up -d influxdb neo4j mongo qdrant
docker compose --profile viewers up -d      # adds mongo-viewer and influx-explorer
docker compose --profile viewers ps
```

Stop only the viewers with `docker compose --profile viewers stop mongo-viewer influx-explorer`. The data stores are unaffected.

## MongoDB — mongo-express

Each mission has its own database: `brahmastra` for Brahmastra, `mission_<id>` for missions created later, and `mission_registry` for the mission list and dashboard job history. Useful Brahmastra collections, in teaching order:

| Collection | What to show |
|---|---|
| `documents` | One record per document revision: source hash, profile, `extraction_status` (`native_only` / `enriched`) |
| `sections` | `SEC-01` … `SEC-10` with page ranges |
| `chunks` | Evidence units with `page`, `bbox`, `kind`, `entities` |
| `assets` | Rendered pages, image crops, native/VLM tables and figure descriptions |
| `telemetry_runs` | Run manifests, content hashes, completion status |
| `telemetry_channels` | The 48-channel dictionary |
| `ingestion_jobs` | Job status and failure types |

Paste these into a collection's **Simple query** box:

- `chunks`: `{"kind": "vlm_table"}` shows the tables a VLM transcribed.
- `chunks`: `{"kind": "vlm_description"}` shows the figure descriptions.
- `chunks`: `{"entities": "daq_missing_samples"}` shows where a channel is discussed.
- `telemetry_runs`: `{"manifest.observed_samples": {"$lt": 1800}}` shows the runs with missing source samples.

## Qdrant — dashboard

**Collections → `document_chunks`**: browse points and their payload (`chunk_id`, `section_id`, `page`, `kind`).

The **Visualize** tab projects all 151 embeddings into 2-D. Paste:

```json
{ "limit": 200, "color_by": { "payload": "kind" } }
```

Then colour by `section_id` to show that chunks from one section cluster together. The **Console** tab accepts REST calls, for example:

```
POST collections/document_chunks/points/scroll
{ "limit": 5, "filter": { "must": [ { "key": "kind", "match": { "value": "vlm_table" } } ] }, "with_payload": true }
```

## InfluxDB 3 — Explorer

Explorer opens connected to the `brahmastra` database. In **Data Explorer**, run the SQL from `influx_demo.sql` and switch the result to a line chart. All 24 runs share the same fictional source window (2026-01-01 00:00–00:15 UTC) and are distinguished by the `run_id` tag.

## Neo4j — Browser

1. Log in, then run `:style` and drag `neo4j_style.grass` onto the style panel. This gives labels and colours to sections, chunks and entities.
2. Run the `:param` line at the top of `neo4j_demo.cypher`, then any query below it.

Both document revisions are in the graph. The parameter selects the VLM-enriched revision.
