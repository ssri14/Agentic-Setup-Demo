# Mission Analysis Agent

A web application for investigating a mission's documents and telemetry with an agent that plans, executes, verifies, recovers and replans, and whose every answer can be replayed. User and administrator guides: [`../docs/05-users.md`](../docs/05-users.md), [`../docs/04-administrators.md`](../docs/04-administrators.md). This README is the technical reference.

**Version 1.0.6.**

| Works now | Arrives later |
|---|---|
| Sign-in, forced first-time password change, own password change | |
| Superuser administration: add users, grant missions, change roles, disable, unlock, reset passwords | Memory notes, feedback, demo script (Phase 5) |
| Mission switcher limited to granted missions; chats per mission: create, rename, delete | |
| Ten mission tools and the analysis sandbox, with a **Tool bench** for the superuser | |
| **The agent**: questions in the chat, a live nested plan with task statuses, clarification questions, Stop, answers with confidence, cited evidence, rejected alternatives and open uncertainties | |
| Per-role model selection (Administration → Models): LAN server, OpenRouter, Groq | |

## Run it

The app runs as the `agent-web` service of the Compose project in `../data-ingestion`, next to the stores ([setup guide](../docs/01-infrastructure.md)). From that folder:

```bash
python3 scripts/setup.py                                  # adds AGENT_* settings to .env once; keeps existing values
docker compose --profile setup run --rm agent-provision   # creates the least-privilege MongoDB user "agent" (once)
docker compose up -d dashboard analysis-sandbox agent-web   # http://localhost:8095 (add --build after code changes)
```

Sign in as `admin` with the `AGENT_ADMIN_PASSWORD` value from `.env`; you must choose a new password at first sign-in. The superuser is created only when no account with that name exists; changing `.env` later does not change an existing password. Then open **Administration → Add user**, create the demo user (for example `analyst`), tick **Brahmastra**, and pass on the temporary password.

## The agent

A LangGraph.js loop (`server/src/agent/graph.ts`) around plans the model writes:

```
intake → plan → execute → verify ─┬→ execute   continue with the plan
           ↑                       ├→ plan      replan (at most 5 revisions)
           └── clarify ←───────────┼→ clarify   ask the user (once per question; the run waits)
                                   └→ report (draft) → check claims ─┬→ end      every claim verified
                                                                      ├→ report   rewrite from the evidence
                                                                      └→ plan     retrieve what is missing
```

- **Plan** (planner model): an objective, competing hypotheses with what would confirm or refute each, and 2–6 steps of 1–4 tool tasks with dependencies. Tool arguments are validated against each tool's schema; invalid plans go back to the model with the errors.
- **Execute**: ready tasks run in parallel (at most 3). Tasks can use earlier results through task references: `run_analysis` names its inputs (`@S2.1`), and the analyst model writes the Python when those inputs exist (one chance to fix failing code); `read_section` accepts `"section": "@S1.1"`, resolved to the section of that task's best result. A task waits for the tasks it references, even in its own step, and is skipped if they failed. References anywhere else are rejected when the plan is validated, and so are incompatible ones: `run_analysis` inputs must return CSV (`get_table`, `telemetry_window`, `events_window`, `run_analysis`), and `read_section` references must return document results; references into earlier plan versions are checked the same way.
- **Verify** (verifier model): after each step, rates every hypothesis (supported, refuted, conflicting, insufficient) with the rule and evidence it rests on, and chooses continue, replan, clarify or report.
- **Report** (reporter model): the answer from verified findings, citing evidence as `[E3]`; citations that do not exist are dropped.
- **Check claims** (checker model): the draft lists each factual claim with its evidence and either an exact quote or a table cell (row, column, value). The support must be found in the cited evidence's text: tables, including one-cell-per-line tables in passages, are shown to every model as labelled rows; quote fragments must lie in one row or paragraph; a reworded claim may be located in its own row or in a sentence that says more than a list of names. Verdicts are supported, contradicted, insufficient, or validation_error (checker says supported but the citation could not be matched: confidence at most medium, never treated as a contradiction); the checker then looks for evidence that contradicts each claim, seeing the lines anywhere in the evidence that mention the same identifiers. Failures go back to the reporter or the planner, at most twice; confidence is capped by what was verified, and claims that still fail are flagged in the answer. See `server/src/agent/evidence.ts`.
- **Budgets**: 48 tool calls, 5 plan revisions, 100 model calls, 15 minutes per question; override with `AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_REVISIONS`, `AGENT_MAX_MODEL_CALLS` and `AGENT_MAX_MINUTES` in `.env`. When one runs out, the agent reports what it has and lists the limit as an open uncertainty.
- **Event log**: every node, model call, tool call, task status, verdict and decision is an ordered event in `agent_app.run_events`; the chat streams it live (server-sent events) and the replay plays it back. Prompts and full tool results are kept in `run_blobs`.

Configure models in `.env` (`LLM_BASE_URL`/`LLM_MODEL` for the LAN server, `OPENROUTER_API_KEY`, `GROQ_API_KEY`), then choose per role under **Administration → Models**. Hosted providers receive mission content in prompts; the page says so when one is selected.

## Recovery suite

Modelled on the desktop HR agent's recoverer. Anything that fails goes to a **Recover** node instead of ending the run: a tool task (an error, a timeout, a bad argument), the planner model, or the verifier model. The recovery model (the verifier role) reads the error, the plan, what has been gathered and the budgets, and chooses one action:

| Action | What happens | Guard |
|---|---|---|
| **Retry failed stage** | The task runs again, optionally with corrected arguments (checked against the tool's schema; an invalid correction goes back to the model). A failed planner or verifier is called again. `run_analysis` rewrites its code on a retry. | 2 retries per task or node (`AGENT_MAX_RETRIES`); once used up, a retry becomes a plan revision, or a partial answer |
| **Continue without it** | The plan carries on; an analysis whose input failed is skipped; the verifier judges what was gathered. | Only for tool failures |
| **Revise remaining plan** | The planner replaces the pending steps, told what failed. | Plan revision budget |
| **Ask for clarification** | The run pauses with a question (for example a run that does not exist). | One clarification per run |
| **Build partial response** | The reporter answers with the evidence gathered and states what is missing. | Always available |

Fallbacks without a model: if the recovery model itself fails, the run finishes with a partial answer; if the reporter fails, a partial answer is assembled from the verified hypotheses and completed tasks. At most 10 recoveries per run.

**Fault injection for demos** (Admin → Models): make the first *n* calls of a chosen tool fail as a 30 s timeout, and/or the first planner call fail as HTTP 503. It applies to every new question while it is on, so remember to switch it off.

## Replay

Every finished answer has a **▶ Replay graph** button; failed or stopped runs have a *Replay what happened* link. The popup rebuilds the run from its event log, one event per second:

- **Agent graph**: the current node is highlighted, visited nodes are filled, and each edge shows how many times it was taken (replans show as Verify → Plan; failures as → Recover, in red).
- **Plan**: drawn like the desktop HR agent's Live Plan. Step cards are laid out by their dependencies (chains run down, independent steps sit side by side) and coloured by status (grey waiting, blue active, green done, red failed, dashed skipped); a final *Response* card closes the plan. On the right, dashed links run from every step to the **Recovery decision** hub and on to its five routes: retry failed stage, continue without it, revise remaining plan, ask for clarification, build final / partial response. Links from a failed step turn red; the hub turns amber while the recovery model (or the verifier) decides; the route taken turns green, with how often it has been taken. The verifier's own decisions light the matching routes (replan → revise, report → finish). The header reads *Version n | x of y tasks completed*. *List* shows the nested bullets instead; the version tabs (v1, v2…) show earlier plans.
- **Event / See state / See context**: *Event* shows the model call, tool arguments (or the analyst's code), tool result, verdict or decision. *Show prompt / full response / full result* loads the stored text. *See state* is the agent's state at that moment; *See context* is the latest prompt a model was given and the mission context loaded at intake.
- **Controls**: ⏮ ◀ ▶/❚❚ ▶ ⏭, speeds 0.5×–4×, and the keyboard (space, ←, →, Home, End). Click or drag the scrubber to jump; ticks are coloured by event type and red flags mark replans.
- **State** and **Memory and context** summaries at the bottom.

Stepping backwards is exact: each position is rebuilt by folding the events from the start.

Chat titles are written by the model from the first question (3 to 7 words); the truncated question stays if that call fails.

## Mission tools

Each tool is bound to one mission, validates its arguments, reads through fixed query shapes only, and returns a short summary, the data, evidence references and, for tabular results, CSV artifacts.

| Tool | What it returns | Reads |
|---|---|---|
| `search_documents` | Best passages for a question, with section, page, kind and score | Qdrant + MongoDB; query embedded by the ingestion service |
| `read_section` | A section in reading order, with previous/next, referenced and related sections | MongoDB + Neo4j |
| `get_table` | Native or VLM tables by page, ID or contained text, as rows and CSV | MongoDB |
| `get_figure` | Figure captions and VLM descriptions, anchored figure versus references | MongoDB |
| `lookup_channels` | Channel dictionary entries plus the document rows that define them | MongoDB |
| `list_runs` | Runs with observed versus expected samples and event counts | MongoDB |
| `telemetry_window` | Channels of one run over [start, end) s: summaries, states, delivery, source gaps, CSV | InfluxDB (SQL template; channels checked against the dictionary) |
| `events_window` | A run's events in source-time order with receipt delays, CSV | InfluxDB (SQL template) |
| `run_analysis` | Python (pandas, NumPy, matplotlib) over CSV artifacts: printed findings, tables, charts | Analysis sandbox |
| `graph_neighbours` | Where an entity is mentioned, by section, and what is mentioned with it | Neo4j |

Documents: when a source has several ingested revisions, tools read the VLM-enriched one, else the newest. Search refuses to run if the embedding service's model or revision differs from the one the mission was indexed with.

**Analysis sandbox** (`sandbox/`): a separate container on an internal network with no route out, read-only file system, no Linux capabilities, a non-root user, and per-run limits (30 s wall clock, 25 s CPU, 768 MB memory). Code is checked before it runs: only data-analysis imports, no file, network, `eval`/`exec` or double-underscore access; inputs arrive only through `load_input(name)`. Run its tests with `python -m pytest sandbox/tests`.

## Access rules

- The server checks the user's mission grant on every request. Superusers see every mission; users see only granted missions.
- Users see and change only their own chats. Revoking a grant hides that mission's chats without deleting them.
- Passwords: at least 10 characters, not containing the username, stored as Argon2id hashes. Temporary passwords set by the superuser must be changed at first sign-in.
- Sessions: an httpOnly, SameSite=Strict cookie with an 8-hour idle timeout (`SESSION_IDLE_MINUTES`), plus a CSRF token on every state-changing request.
- Five failed sign-ins within 10 minutes lock the account for 10 minutes; the superuser can unlock it sooner.
- At least one active superuser always remains; superusers cannot demote or disable themselves.
- MongoDB: the app connects as `agent`, which can read every database (mission data and the mission registry) and write only `agent_app`. Missions are never created or changed here; create them in the ingestion dashboard.

## Development

```bash
npm install
npm test                 # API and access-control tests (in-memory store)
npm run typecheck
npm run dev:server       # API on :8095 (set MONGO_HOST and AGENT_MONGO_PASSWORD, or AGENT_MONGO_URI)
npm run dev:client       # web client on :5173, proxying /api to :8095
```

| Path | Contents |
|---|---|
| `server/src/app.ts` | Routes, session handling, access rules |
| `server/src/auth.ts` | Password hashing, tokens, password policy |
| `server/src/store/` | Store interface; MongoDB implementation and an in-memory one for tests |
| `server/src/provision.ts` | Creates the `agent` MongoDB user with the administrator's credentials |
| `client/src/` | React client: sign-in, chat layout, administration |
| `server/src/agent/` | The agent: graph, prompts, output schemas, model client, event log, run manager |
| `client/src/Conversation.tsx`, `PlanList.tsx`, `AnswerCard.tsx` | Chat thread, live plan, answer card and evidence drawer |
| `server/src/tools/` | The ten tools (`registry.ts`) and their read-only data sources (`sources.ts`) |
| `client/src/ToolBench.tsx` | The superuser's tool bench |
| `sandbox/` | Analysis sandbox service, its code policy and tests |
| `tests/` | Vitest tests: access rules; every tool against real Brahmastra extraction and telemetry samples (`tests/fixtures/`); the agent's plan, replan, clarification, failure, stop and budget paths with a scripted model |
