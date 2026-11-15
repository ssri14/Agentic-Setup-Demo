# 4. Guide for administrators

Administrators are **superusers** of the Mission Analysis Agent. They:

- manage accounts and mission access;
- choose the language models;
- test the mission tools;
- prepare demonstrations;
- keep the stack healthy.

Superusers also see every mission and can use the chat like any user ([Guide 5](05-users.md)).

Infrastructure and data loading are covered in Guides [1](01-infrastructure.md), [2](02-telemetry.md) and [3](03-documents.md). This guide covers running the application.

- [First sign-in](#first-sign-in)
- [Users and access](#users-and-access)
- [Missions](#missions)
- [Models](#models)
- [Tool bench](#tool-bench)
- [Agent limits and recovery](#agent-limits-and-recovery)
- [Fault injection for demonstrations](#fault-injection-for-demonstrations)
- [Where things are stored](#where-things-are-stored)
- [Security model](#security-model)
- [Operating checklist](#operating-checklist)

## First sign-in

1. Open http://localhost:8095.
2. Sign in as `admin` (`AGENT_ADMIN_USER`) with the `AGENT_ADMIN_PASSWORD` value from `data-ingestion/.env`.
3. Choose a new password. A new password is required at first sign-in. It must be at least 10 characters and must not contain the username.

The first superuser is created when `agent-web` starts and no account with that name exists. After that, `.env` no longer controls the password. Changing `AGENT_ADMIN_PASSWORD` does not reset an existing account. If every superuser is locked out, see [Recovering access](#recovering-access).

Open **Administration** from the left panel. It has four tabs: **Users**, **Missions**, **Models**, **Tool bench**.

## Users and access

The **Users** table lists each account: role, missions, last sign-in, and status (*Active*, *Must change password*, *Locked*, *Disabled*).

**Add a user**:

1. **Add user**.
2. Enter a **Username**: 3–32 characters, lowercase letter first, then `a-z 0-9 . _ -`. It cannot be changed later.
3. Enter a **Display name**.
4. Choose or type a **Temporary password**. **Generate** makes a strong one.
5. Choose a **Role**:
   - *User* sees only the missions you tick.
   - *Superuser* sees all missions and Administration.
6. Under **Mission access**, tick the missions this user may work on (for example *Brahmastra*).
7. Save, and pass the username and temporary password to the person securely. They must choose their own password at first sign-in.

**Edit** a user to change display name, role or missions, or to tick **Account disabled**. Disabling signs the user out at once and blocks sign-in; their chats are kept. Saving the dialog also unlocks a locked account.

**Reset password** sets a new temporary password. The user is signed out everywhere and must change it at next sign-in. This also clears a lock.

Rules the system enforces:

- You cannot demote or disable your own account.
- At least one active superuser must always remain.
- **Lockout**: 5 failed sign-ins within 10 minutes lock the account for 10 minutes. Sign-in attempts are also rate-limited per client (20 a minute).
- **Sessions** expire after 8 hours without activity (`SESSION_IDLE_MINUTES`). Sign-out ends the session on the server.

A user's mission access decides what they see:

- the mission picker;
- the chats they can open;
- the data every agent tool can read for them.

Removing a mission from a user hides its chats from them; it does not delete those chats.

### Recovering access

If no superuser can sign in, ask another superuser to reset the password. If there is none, an operator with shell access can remove the account so it is recreated from `.env` at the next start. This deletes only that user record:

```bash
cd data-ingestion
docker compose exec mongo mongosh -u ingestion -p "$(grep ^MONGO_PASSWORD= .env | cut -d= -f2)" --authenticationDatabase admin \
  --eval 'db.getSiblingDB("agent_app").users.deleteOne({username: "admin"})'
docker compose restart agent-web      # recreates "admin" with AGENT_ADMIN_PASSWORD from .env
```

## Missions

The **Missions** tab lists every registered mission:

- whether it has telemetry;
- its document and telemetry-run counts;
- its MongoDB database;
- how many users can see it.

Missions are created and filled in the **ingestion dashboard** (http://localhost:8090) or the ingestion CLI ([Guide 3, New missions](03-documents.md#new-missions)). They appear here automatically. Then grant users access under **Users**.

A mission with no completely ingested documents can still be opened, but the agent's document tools will report that nothing is ingested yet.

## Models

The agent uses five model **roles**:

| Role | Job |
|---|---|
| **Planner** | Writes and revises the investigation plan: objective, hypotheses, steps and tool calls |
| **Verifier** | Tests the hypotheses after each step and decides what happens next. Also makes recovery decisions when something fails |
| **Analyst** | Writes the Python that `run_analysis` executes in the sandbox |
| **Reporter** | Drafts the answer from verified findings, listing each factual claim with the evidence and the exact words that state it. Also titles new chats |
| **Checker** | Judges every claim of a draft against the evidence before it is published (supported, contradicted, not established). Quotes and table cells are also matched to the text without a model. Settings saved before version 1.0.2 use the verifier's model for it; an independent model is a good choice |

For each role, choose a **Provider** and a **Model**, then **Save**. New questions use the new settings; questions already running keep theirs. Providers appear only when their keys are set in `.env` ([Guide 1](01-infrastructure.md#configuration-reference)):

- **LAN** (`LLM_BASE_URL`): any OpenAI-compatible server. In the reference setup this is `openai/gpt-oss-120b` inside the lab.
- **OpenRouter** and **Groq**: hosted services. **Prompts include mission content** (document passages, telemetry excerpts), and the page warns when a hosted provider is selected. Use them only where that is acceptable.

Reasonable choices:

- **One strong model for every role.** This is the default.
- **A cheaper or faster model for the reporter.**
- **Code-capable model for the analyst.** If `run_analysis` often fails, give the analyst a model that writes better code.

Each answer's replay shows which model handled every call.

## Tool bench

**Tool bench** runs any of the agent's ten tools directly, with the same code and permissions the agent uses. Use it to check that data is loaded, or to see what the agent would see.

1. Pick a mission and a tool. The arguments box is pre-filled with an example; the tool's description and parameters are shown.
2. **Run**. The result shows a summary, the evidence it would cite, the data and any artifacts. Telemetry windows and analyses produce CSV files and charts.
3. `run_analysis` takes the artifact ID of a CSV from an earlier `telemetry_window` result (the recent artifacts are listed) and Python code using `load_input(name)`. It runs in the sandbox, exactly as for the agent.

| Tool | Reads |
|---|---|
| `search_documents` | Semantic search over document chunks |
| `read_section` | A whole section with its neighbours and related sections |
| `get_table`, `get_figure` | Tables (native and VLM) and figure descriptions |
| `lookup_channels` | The channel dictionary and what the documents say about each channel |
| `graph_neighbours` | Entities, references and related sections in the knowledge graph |
| `list_runs` | Telemetry runs with sample counts, gaps and event counts |
| `telemetry_window` | Selected channels of one run over a time window; gaps and delivery states |
| `events_window` | A run's events, optionally for one subsystem |
| `run_analysis` | Python (pandas, NumPy, matplotlib) over earlier CSV results, in the sandbox |

## Agent limits and recovery

Each question runs under the budgets in `.env`: 48 tool calls, 5 plan revisions, 100 model calls, 15 minutes, and 2 retries per failed step. When a budget runs out, the agent answers with what it has and lists the limit under the answer's uncertainties. Raise a budget for harder questions; lower it for quicker demos. Restart `agent-web` after changing one.

When anything fails, the run goes to the **Recover** node instead of stopping. Failures include a tool error or timeout, a bad argument, and the planner or verifier model failing. There, the verifier model chooses one action:

- **Retry failed stage**, optionally with corrected arguments
- **Continue without it**
- **Revise remaining plan**
- **Ask for clarification**
- **Build partial response**

Guards that the model cannot override:

- the retry budget, after which a retry becomes a plan revision or a partial answer;
- the revision budget;
- one clarification per question;
- at most 10 recoveries.

There are two further fallbacks. If the recovery model fails, the agent answers with the evidence gathered so far. If the reporter fails, a partial answer is assembled without a model. Recoveries appear in the live chat as notes and in the replay as the red **Recover** node and the recovery lane.

## Fault injection for demonstrations

At the bottom of **Models**, **Fault injection (demonstration)** makes parts of every new question fail on purpose, so the audience can watch the recovery suite work:

- **Fail the first *n* call(s) of *tool***: the call fails as a 30-second timeout. One failure shows a retry that succeeds. Choose 3 or more to use up the retries and force a plan revision or a partial answer.
- **Fail the first *n* planner call(s)**: the planner fails as "HTTP 503 from the model provider", and recovery retries it.

Switch it **On**, ask a question, and open the replay to step through the recovery. **Switch it off afterwards.** While it is on, it affects every new question from every user. Injected failures are labelled `injected fault` everywhere they appear.

A good first demonstration: `list_runs` × 1, then ask *"Which runs show missing source samples, and how is that different from delayed delivery?"*

## Where things are stored

The app's own data is in the MongoDB database `agent_app`:

| Collection | Contents | Kept |
|---|---|---|
| `users`, `sessions` | Accounts (Argon2id password hashes), sessions (token hashes) | Sessions until expiry or sign-out |
| `chats`, `messages` | Conversations per user and mission | Until the user deletes the chat |
| `runs`, `run_events`, `run_blobs` | Every question's run, its ordered event log, and full prompts and tool results | With the chat (the replay reads these) |
| `artifacts` | CSVs and charts produced by tools | 30 days |
| `settings` | Model choices, fault injection | Until changed |

Deleting a chat deletes its messages, runs, events and blobs. Mission data lives in the mission databases and is never written by the app.

## Security model

- **Network**: every port is bound to `127.0.0.1`. To offer the app to other machines, put a TLS reverse proxy in front of port 8095 and set `SECURE_COOKIES=true` for `agent-web`. Don't expose the store ports.
- **Least privilege**: the app connects to MongoDB as `agent`, which can read all databases and write only `agent_app`. Neo4j queries run in read sessions, and telemetry SQL is built from fixed templates with parameters.
- **Sessions**: an httpOnly, SameSite=Strict cookie plus a CSRF header on every change.
- **Sandbox**: model-written code runs in `analysis-sandbox`, which is:
  - read-only, with all capabilities dropped and no-new-privileges;
  - limited to 2 GB of memory, 128 processes and 30 seconds per analysis;
  - checked against an AST policy that refuses imports outside the allow-list and file, network and OS access;
  - attached only to an internal network with no route out.
- **Ground truth** never enters the stores ([Guide 2](02-telemetry.md#the-dataset)).
- **Secrets**: `.env` and `secrets/` stay on the machine and out of Git and images. Hosted model keys are only in `.env`.

## Operating checklist

**Before a session or demonstration**

- All lights green in the dashboard (http://localhost:8090), at least MongoDB, InfluxDB, Qdrant, Neo4j, the embedding model, the text LLM, the sandbox and the agent.
- The Missions tab shows the documents and 24 telemetry runs for Brahmastra.
- **Models**: the intended providers are selected; **fault injection is off** unless you are about to demonstrate it.
- A demonstration user exists with the right missions, and you have signed in as them once.

**After a restart**

- Questions that were running are marked *interrupted* and can be asked again.

**When answers look wrong**

1. Open the answer's **Replay graph**: the plan, each tool result and the verifier's verdicts.
2. Use **See context** to read the exact prompt a model was given.
3. Re-run a single tool in the **Tool bench**.
4. Check the logs with `docker compose logs --tail 200 agent-web`.
