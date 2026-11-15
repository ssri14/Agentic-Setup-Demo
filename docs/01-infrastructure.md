# 1. Setting up the infrastructure with Docker Compose

This guide takes a machine from nothing to a running stack: four data stores, the ingestion dashboard, the analysis sandbox and the Mission Analysis Agent web app. The steps are the same on macOS, Linux and Windows (Docker Desktop with Linux containers).

- [What runs](#what-runs)
- [Requirements](#requirements)
- [Install](#install): [A. published images](#a-use-the-published-images) or [B. build from source](#b-build-from-source)
- [Check that it works](#check-that-it-works)
- [Configuration reference](#configuration-reference)
- [Day-to-day operations](#day-to-day-operations)
- [Upgrading, backing up and moving](#upgrading-backing-up-and-moving)
- [Publishing images](#publishing-images)
- [Troubleshooting](#troubleshooting)

## What runs

All services belong to one Compose project, `brahmastra-ingestion`, defined in [`data-ingestion/compose.yaml`](../data-ingestion/compose.yaml). Every port is bound to `127.0.0.1` only.

| Service | Image | Port | Role |
|---|---|---|---|
| `influxdb` | `influxdb:3.12.2-core` | 8181 | Telemetry and events, queried with SQL |
| `mongo` | `mongo:8.0.4` | 27017 | Documents, sections, chunks, run manifests, mission registry, the app's users, chats and run logs |
| `neo4j` | `neo4j:5.26.0-community` | 7474, 7687 | Document graph: sections, chunks, references, entities, related sections |
| `qdrant` | `qdrant/qdrant:v1.13.4` | 6333 | Chunk embeddings for semantic search |
| `dashboard` | `ssri14/mission-analysis-ingestion` | 8090 | Ingestion dashboard: service health, missions, PDF upload, ingestion jobs; also serves query embeddings to the agent |
| `ingest` *(profile `cli`)* | same image | – | The ingestion command line (`docker compose run --rm ingest …`) |
| `analysis-sandbox` | `ssri14/mission-analysis-sandbox` | – | Runs the agent's model-written Python. Only on the internal `sandbox` network, which has no route out |
| `agent-web` | `ssri14/mission-analysis-agent` | 8095 | The Mission Analysis Agent web app |
| `agent-provision` *(profile `setup`)* | same image | – | One-time: creates the app's least-privilege MongoDB user |
| `mongo-viewer` *(profile `viewers`)* | `mongo-express:1.0.2` | 8081 | Read-only MongoDB browser |
| `influx-explorer` *(profile `viewers`)* | `influxdata/influxdb3-ui:1.11.2` | 8888 | InfluxDB 3 Explorer (query mode) |

```mermaid
flowchart LR
  subgraph default network
    D[dashboard :8090] --> M[(mongo)]
    D --> I[(influxdb)]
    D --> Q[(qdrant)]
    D --> N[(neo4j)]
    A[agent-web :8095] --> M
    A --> I
    A --> Q
    A --> N
    A -- query embeddings --> D
  end
  subgraph sandbox network - internal, no internet
    A -- analysis code --> S[analysis-sandbox]
  end
  A -. HTTPS .-> L[LLM: LAN server / OpenRouter / Groq]
  D -. HTTPS .-> V[VLM for page enrichment, optional]
```

Named volumes hold the data: `influx_data`, `mongo_data`, `neo4j_data`, `qdrant_data`, `model_cache` (embedding model weights) and `explorer_db`. The folders `data-ingestion/missions/` (inputs) and `data-ingestion/artifacts/` (rendered pages, crops, extraction reports) are bind-mounted.

## Requirements

- **Docker** Engine or Desktop with **Compose v2** (`docker compose version`). Give Docker at least **8 GB of memory** (Docker Desktop → Settings → Resources) and about **15 GB** of disk for images, models and data.
- **Python 3.9+** on the host, only to run `scripts/setup.py` (standard library only) and, optionally, the telemetry generator.
- **Git**, to clone the repository.
- **Network access** on first start: Docker Hub (images) and Hugging Face (the 90 MB embedding model `sentence-transformers/all-MiniLM-L6-v2`, downloaded once into the `model_cache` volume).
- **A language model** for the agent: an OpenAI-compatible endpoint. The reference setup uses `openai/gpt-oss-120b` on a LAN server; OpenRouter or Groq keys work too. Optional: a vision model (VLM) for document enrichment.

## Install

```bash
git clone https://github.com/ssri14/Agentic-Setup-Demo.git
cd Agentic-Setup-Demo/data-ingestion
python3 scripts/setup.py          # Windows: python scripts\setup.py
```

`setup.py` creates, once, everything that must stay on this machine and never enters Git:

| File | Contents |
|---|---|
| `.env` | Random passwords for Neo4j, MongoDB, the viewers, the agent's MongoDB user and the first superuser; model endpoints; agent limits; image names |
| `secrets/influx-admin.json` | The InfluxDB admin token (also copied into `.env` as `INFLUX_TOKEN`) |
| `secrets/explorer/config.json` | InfluxDB Explorer's preconfigured connection |

Running it again is safe: it keeps every existing value and only adds missing ones.

Now open `.env` and set the language model (see [Configuration reference](#configuration-reference)):

```dotenv
LLM_BASE_URL=http://10.20.30.57:8000/v1     # your OpenAI-compatible server, including /v1
LLM_MODEL=openai/gpt-oss-120b
LLM_API_KEY=                                 # empty if the server needs no key
# and/or
OPENROUTER_API_KEY=sk-or-...
GROQ_API_KEY=gsk_...
```

Containers reach a model running on the host itself at `http://host.docker.internal:<port>/v1`.

### A. Use the published images

Fastest: nothing is compiled. The images are multi-architecture (amd64 and arm64).

```bash
docker compose pull dashboard agent-web analysis-sandbox influxdb mongo neo4j qdrant
```

### B. Build from source

Use this when you change code, or have no access to Docker Hub.

```bash
docker compose build dashboard agent-web analysis-sandbox
```

The first ingestion build downloads PyTorch (CPU) and can take 10–20 minutes. On Apple Silicon, `python3 scripts/cache_linux_wheels.py` pre-downloads the Linux arm64 wheels in parallel into `_wheels/` first, which makes the build much faster.

### Start the stack

The same for A and B:

```bash
docker compose up -d influxdb neo4j mongo qdrant                # the four stores
docker compose run --rm ingest init                             # check stores, create indexes and the mission registry
docker compose --profile setup run --rm agent-provision         # create the agent's MongoDB user (once)
docker compose up -d dashboard analysis-sandbox agent-web       # dashboard :8090, agent :8095
```

Optional browser viewers for the stores (see [`data-ingestion/viewers/README.md`](../data-ingestion/viewers/README.md)):

```bash
docker compose --profile viewers up -d                          # mongo-express :8081, InfluxDB Explorer :8888
```

The stack is running but empty. Load data next:

1. Telemetry: [Guide 2](02-telemetry.md), or press **Ingest runs** in the dashboard.
2. Documents: [Guide 3](03-documents.md), or press **Ingest** next to the Mission Document in the dashboard.
3. Users: [Guide 4](04-administrators.md). Sign in at http://localhost:8095 as `admin` with `AGENT_ADMIN_PASSWORD` from `.env`.

## Check that it works

```bash
docker compose ps                                   # all services "running"; mongo and neo4j "healthy"
curl -s http://localhost:8095/api/health            # {"ok":true}
curl -s http://localhost:8090/api/health | python3 -m json.tool
```

Open http://localhost:8090. The **Services** panel shows a green, amber or red light for each dependency: MongoDB, InfluxDB, Qdrant, Neo4j, the embedding model, the VLM, the text LLM, the viewers, the analysis sandbox, the agent and free artifact space. Amber for the VLM or a viewer is fine if you don't use them.

Run the test suites inside the containers:

```bash
docker compose run --rm --entrypoint python ingest -m pytest -q tests/test_ingestion.py tests/test_dashboard.py
docker compose run --rm -e RUN_INTEGRATION=1 --entrypoint python ingest -m pytest -q tests/test_integration.py   # needs the stores
docker compose exec analysis-sandbox python -m pytest -q -p no:cacheprovider tests                                   # sandbox policy
```

The agent's own tests (104, no stores needed) run from source: `cd ../mission-analysis-agent && npm ci && npm test`.

## Configuration reference

Everything is set in `data-ingestion/.env`. Restart the affected service after a change: `docker compose up -d agent-web` (or `dashboard`).

**Language models (agent)**

| Key | Meaning |
|---|---|
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | OpenAI-compatible LAN or self-hosted server. Shown as provider "LAN" |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | OpenRouter (hosted). Default model `openai/gpt-oss-120b` |
| `GROQ_API_KEY`, `GROQ_MODEL` | Groq (hosted) |

The superuser chooses provider and model per agent role (planner, verifier, analyst, reporter) under **Administration → Models**; these keys only make providers available.

**Agent limits, per question**

| Key | Default | When reached |
|---|---|---|
| `AGENT_MAX_TOOL_CALLS` | 48 | The agent answers with what it has and states the limit |
| `AGENT_MAX_REVISIONS` | 5 | No further replans |
| `AGENT_MAX_MODEL_CALLS` | 100 | As above |
| `AGENT_MAX_MINUTES` | 15 | As above |
| `AGENT_MAX_RETRIES` | 2 | Per failed task or model step; then recovery revises the plan or answers partially |

**Document ingestion**

| Key | Default | Meaning |
|---|---|---|
| `VLM_BASE_URL`, `VLM_MODEL`, `VLM_API_KEY`, `VLM_TIMEOUT` | LAN Nemotron | Vision model for **Ingest + VLM** |
| `EMBEDDING_MODEL`, `EMBEDDING_REVISION` | MiniLM-L6-v2, pinned | Local embedding model. Changing it needs new stores (see Guide 3) |
| `CHUNK_CHARS` | 1800 | Target chunk size |
| `SIMILARITY_THRESHOLD`, `SIMILARITY_TOP_K`, `KEYWORD_MIN_SHARED` | 0.65, 5, 2 | Density of related-section links in the graph |
| `MAX_UPLOAD_MB` | 200 | Dashboard upload limit |

**Credentials** (generated; don't edit once the stores exist): `NEO4J_PASSWORD`, `MONGO_PASSWORD`, `INFLUX_TOKEN`, `VIEWER_PASSWORD`, `VIEWER_SESSION_SECRET`, `AGENT_MONGO_PASSWORD`, `AGENT_ADMIN_USER`, `AGENT_ADMIN_PASSWORD`.

**Ports**: `INFLUX_PORT`, `NEO4J_HTTP_PORT`, `NEO4J_BOLT_PORT`, `MONGO_PORT`, `QDRANT_PORT`, `DASHBOARD_PORT`, `AGENT_PORT`, `MONGO_VIEWER_PORT`, `INFLUX_EXPLORER_PORT`. Change one if it clashes with something already on the host.

**Images**: `IMAGE_NAMESPACE` (default `ssri14`) and `IMAGE_TAG` (default `1.0.8`).

## Day-to-day operations

```bash
docker compose ps
docker compose logs -f agent-web                  # or dashboard, analysis-sandbox, mongo …
docker compose restart agent-web
docker compose stop                               # stop everything, keep data
docker compose up -d influxdb neo4j mongo qdrant dashboard analysis-sandbox agent-web   # start again
docker compose down                               # remove containers, keep volumes (data)
```

Never add `-v` to `down` unless you mean to delete every database and the model cache.

When `agent-web` restarts, questions that were in progress are marked *interrupted* in their chats; users can ask them again.

## Upgrading, backing up and moving

**Upgrade to a new release**: `git pull`, set `IMAGE_TAG` in `.env` to the new version, then `docker compose pull` (or `build`), then `docker compose up -d dashboard analysis-sandbox agent-web`. Data volumes are kept.

**Back up** these three things together; one is useless without the others:

1. The volumes. With the stack stopped:
   ```bash
   for v in mongo_data influx_data neo4j_data qdrant_data; do
     docker run --rm -v brahmastra-ingestion_$v:/data -v "$PWD/backup":/backup alpine tar czf /backup/$v.tgz -C /data .
   done
   ```
2. `data-ingestion/.env` and `data-ingestion/secrets/`. The stored data is protected by these credentials.
3. `data-ingestion/artifacts/` and any missions you created under `data-ingestion/missions/`.

**Move to another machine**: either restore the backup there (same `.env` and `secrets/`), or start empty. Clone, run `setup.py`, pull, start, and ingest again; ingestion is deterministic, so the same inputs give the same IDs.

**Changing passwords**: editing `.env` does not change a password already stored in a database volume. Rotate inside the database first, then update `.env`, or start from empty volumes.

## Publishing images

The three application images are published as `ssri14/mission-analysis-ingestion`, `ssri14/mission-analysis-agent` and `ssri14/mission-analysis-sandbox`, each for `linux/amd64` and `linux/arm64`. There are two ways to publish a new version.

**From your machine** (needs Docker with buildx, which Docker Desktop includes):

```bash
docker login                                   # as ssri14
./scripts/publish-images.sh 1.0.1              # from the repository root; also tags "latest"
```

**From GitHub Actions**: add the repository secrets `DOCKERHUB_USERNAME` (`ssri14`) and `DOCKERHUB_TOKEN` (a Docker Hub access token with *Read & Write*). Then push a tag:

```bash
git tag v1.0.1 && git push origin v1.0.1
```

The `images` workflow builds and pushes all three images. It can also be started by hand from the **Actions** tab.

Building amd64 on Apple Silicon (or arm64 on an x86 machine) runs under emulation and takes a while, mostly installing PyTorch in the ingestion image. The GitHub workflow caches layers between runs.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `required variable … is missing a value: Run python3 scripts/setup.py first` | No `.env` in `data-ingestion/`. Run `setup.py` from that folder |
| Mongo or Neo4j "authentication failed" after re-creating `.env` | The volumes keep the first passwords. Restore the old `.env`/`secrets/`, or `docker compose down -v` to start empty (deletes data) |
| Agent: "No language model is configured" | Set `LLM_BASE_URL`/`OPENROUTER_API_KEY`/`GROQ_API_KEY` in `.env`, then `docker compose up -d agent-web` |
| Dashboard: embedding model red, or ingestion stuck at "embedding" | No access to huggingface.co. Allow it once, or copy a populated `model_cache` volume from another machine |
| Agent `run_analysis` fails with "cannot reach analysis-sandbox" | `docker compose up -d analysis-sandbox`; check `docker compose logs analysis-sandbox` |
| Port already in use | Change the matching `*_PORT` in `.env` |
| `docker compose up` builds instead of using the published images | Run `docker compose pull …` first (step A). Compose builds only when an image is missing locally |
| Very slow first build on a Mac | `python3 scripts/cache_linux_wheels.py`, then build again; or use the published images |
| Windows: `python3` not found | Use `python` |
