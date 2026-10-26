# Hermes Evals: every UI feature, end to end

This document walks through everything a user can do in the UI. For each feature it shows what the user does, which API calls the web app makes, what the API writes to Postgres, which jobs it queues, and what the worker, docker-guard, egress and the trial container do with them.

It is written for review. It follows `IMPLEMENTATION_PLAN.md` (the source of truth), the design canvas, and the code as it stands on 26 Oct 2026 (Phase 5b). Where those three disagree, or where something is not decided, the flow says so and the point is collected in [section 19, Open points](#19-open-points-found-while-writing-this).

## How to read this

- **Built** means code exists and is tested today. **Planned** means it is specified in the plan but not written yet. Each feature section starts with a status line.
- Diagrams use these participants:

| Name      | What it is                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| User      | The person in the browser                                                                                                       |
| Web       | The Vue app (served by nginx, `/api` proxied to the API)                                                                        |
| API       | NestJS HTTP API. Validates, writes Postgres, queues jobs, serves reads and SSE. Never talks to Docker                           |
| DB        | PostgreSQL: the tables in section 2, plus pg-boss's job tables                                                                  |
| Queue     | pg-boss, inside the same Postgres. Jobs are rows, so "write rows and queue jobs" commits in one transaction                     |
| Worker    | NestJS worker process. Claims jobs, prepares trial folders, drives trials through the guard, writes events, runs scorers        |
| Guard     | docker-guard: the only process holding the Docker socket. Starts nothing but hardened trial containers and verifier containers  |
| Egress    | The trial's only network path out: CONNECT proxy plus model gateway. Holds API keys. Counts tokens per attempt                  |
| Trial     | One container per attempt, running Hermes once (`hermes chat --oneshot --format stream-json`)                                   |
| NousLogin | `nous-login` service: runs Hermes's device login and writes the login into the `nous-home` volume                               |
| NousProxy | `nous-proxy` service: `hermes proxy start --provider nous`, reads that login, forwards model calls to Nous Portal               |
| Disk      | `./suites` on disk (read by the loader; written only by the save of a draft) and the blob store under `DATA_DIR/blobs/<sha256>` |

## Contents

1. [System map](#1-system-map)
2. [Data model](#2-data-model)
3. [State machines](#3-state-machines)
4. [App shell: navigation, banners, live pills](#4-app-shell-navigation-banners-live-pills)
5. [System page](#5-system-page)
6. [Connecting Nous Portal](#6-connecting-nous-portal)
7. [Nudges: where the UI blocks model work and why](#7-nudges-where-the-ui-blocks-model-work-and-why)
8. [Suites and tasks](#8-suites-and-tasks)
9. [Resources: skills, documents, MCP servers, secrets](#9-resources-skills-documents-mcp-servers-secrets)
10. [Configurations](#10-configurations)
11. [New experiment and launch](#11-new-experiment-and-launch)
12. [What happens to one run: execution](#12-what-happens-to-one-run-execution)
13. [What happens to one run: scoring](#13-what-happens-to-one-run-scoring)
14. [Experiment list and overview, live](#14-experiment-list-and-overview-live)
15. [Experiment controls](#15-experiment-controls)
16. [Comparison tab](#16-comparison-tab)
17. [Runs tab](#17-runs-tab)
18. [Run inspector](#18-run-inspector)
19. [Open points found while writing this](#19-open-points-found-while-writing-this)

---

## 1. System map

Status: **Built** (Phases 0 to 5): postgres, the api with every Phase 1 to Phase 5 endpoint, re-score and the comparison included, the worker (isolation self-test, suite loader, MCP test, `execute-run`, `evaluate-run` with all eight scorers and its dead letter, recovery), docker-guard, egress (proxy, model gateway with its per-attempt token cap, MCP gateway, the LLM judge's path on the admin socket), the trial image, nous-proxy and nous-login, and the web app, whose pages are built against the real API and parse every answer with its shared schema (Phase 5; `docs/phases/phase-5.md`); the platform additions of Phase 6 (home seeds, the agent's memory files collected, skill loading, the launch check for unset MCP variables) and the two sample MCP servers, `invoice-db` (stdio, in the trial image) and `vendor-directory` (http, Compose profile `samples`, on a network only egress shares; `docs/phases/phase-6.md`); the five sample suites and the skills and documents their arms use (Phase 6b; `docs/phases/phase-6b.md`); suite authoring in the UI, the save jobs and verifier scripts in their own containers (Phase 5b; `docs/phases/phase-5b.md`).

```mermaid
flowchart LR
  subgraph browser["Browser"]
    U(("User"))
    W["Web app<br/>Vue 3"]
  end

  subgraph backend["backend network"]
    API["api<br/>NestJS HTTP + SSE"]
    WK["worker<br/>NestJS jobs"]
    PG[("PostgreSQL<br/>tables + pg-boss")]
  end

  subgraph admin["provider-admin network (internal)"]
    NL["nous-login<br/>device login"]
  end

  G["docker-guard<br/>network: none"]
  D[["Docker Engine"]]

  subgraph slot["trial slot network (internal, one per concurrent trial)"]
    T["trial container<br/>Hermes, uid 10000<br/>/opt/data + /workspace"]
  end

  VC["verifier container (Phase 5b)<br/>network: none, python3, uid 10000<br/>inputs read-only at /check"]
  S[("./suites<br/>read-write for the save of a draft alone")]

  E["egress<br/>CONNECT proxy :3128<br/>model + MCP gateway :8080"]

  subgraph edge["edge network (internet)"]
    NP["nous-proxy<br/>holds the Nous login"]
    P[("Model providers<br/>Nous Portal, OpenRouter...")]
    MCP[("http MCP servers")]
    WEB[("Public web hosts")]
  end

  V[("volumes<br/>evaldata: blobs, skills<br/>hermes-evals-trials<br/>nous-home")]

  U --> W
  W -- "HTTP /api, SSE" --> API
  API -- "SQL, jobs" --> PG
  WK -- "SQL, jobs" --> PG
  API -- "login status, start, cancel" --> NL
  WK -- "provider guard: status only" --> NL
  WK -- "filtered Docker API<br/>unix socket" --> G
  G -- "Docker socket" --> D
  D -- "creates" --> T
  D -- "creates, one per verifier run" --> VC
  WK -- "loads suites, saves a draft<br/>through staging and rename" --> S
  WK -- "attempt tokens, LLM judge calls<br/>unix socket" --> E
  T -- "model calls with attempt token" --> E
  T -- "HTTPS via CONNECT" --> E
  T -- "http MCP calls, no headers" --> E
  E -- "Nous calls" --> NP
  E -- "API-key calls, key injected" --> P
  E -- "MCP calls, headers added" --> MCP
  E -- "only with web or browser toolsets" --> WEB
  NP --> P
  NL -- "writes login" --> V
  NP -- "reads login" --> V
  WK -- "prepares trial folders,<br/>reads outputs" --> V
```

What the picture enforces:

- The trial can reach **only egress**. Postgres, the API, the host, other trials and the internet are not on its network. Its filesystem is two mounts: its own home (`/opt/data`) and workspace (`/workspace`).
- **No provider credential enters a trial.** The trial gets a per-attempt token. Egress swaps it for the real API key, or forwards Nous calls to nous-proxy, which holds the OAuth login. The token dies when the attempt ends. The same holds for http MCP header values, which egress adds. The one exception is a stdio MCP server's env values: that server runs inside the trial, so the agent can read them, and the UI says so (section 9.4).
- **The worker and the API hold no provider key either.** Compose blanks every key in their environments, and the LLM judge's model calls go through egress's admin socket, one short-lived registration per judge call (section 13).
- **Only docker-guard can touch Docker**, and it refuses anything that is not a trial container of the pinned image with the hardened settings, or, since Phase 5b, a verifier container of one exact spec: the trial image's python3, no network, its inputs read-only (section 8.5).
- **`./suites` is written by one job only**: the worker's save of a draft, through a staging folder and renames, under the folder's lock. The loader only reads it, and the API does not mount it (sections 8.1 and 8.6).
- The API never talks to Docker. The worker never serves HTTP.

---

## 2. Data model

Status: **Built** (migrations 0000 to 0009, integrity triggers, tests on PGlite and Postgres 17). Migration 0004 added the `provider_disconnected` pause reason and `workers.host_proxy`; 0005 added `runs.next_trigger` and the `over_budget` artifact reason; 0009 the suite draft tables, `task_root_files` and the guards that keep a skill or document a configuration version names (Phase 5b).

```mermaid
erDiagram
  suite_sources ||--o{ suites : "versions of one directory"
  suite_sources |o--|| suites : "current version"
  suites ||--o{ tasks : contains
  tasks ||--o{ task_files : "fixture, verifier, rubric, expected"
  task_files }o--|| blobs : "content by sha256"
  documents }o--|| blobs : "content by sha256"
  mcp_servers ||--o{ mcp_server_versions : versions
  configurations ||--o{ configuration_versions : versions
  configuration_versions }o--o{ skills : "skill ids"
  configuration_versions }o--o{ documents : "document ids"
  configuration_versions }o--o{ mcp_server_versions : "one version per server"
  experiments }o--|| suites : "frozen suite version"
  experiments }o--o{ tasks : "selected task ids"
  experiments }o--|| configuration_versions : baseline
  experiments }o--o{ configuration_versions : candidates
  experiments ||--o{ runs : "task x config x repetition"
  runs ||--o{ attempts : "one per Hermes launch"
  runs |o--|| attempts : "current attempt"
  attempts ||--o{ run_events : "stdout lines, platform events"
  attempts ||--o{ artifacts : "files left in workspace"
  artifacts }o--o| blobs : content
  attempts ||--o{ evaluations : "scoring passes (generations)"
  evaluations ||--o{ scores : "one per verification key"
  workers ||--o{ attempts : "sandbox host"
  tasks ||--o{ task_root_files : "task.yaml, prompt.md, reference.json"
  suite_drafts }o--o| suites : "base version"
  suite_drafts ||--o{ suite_draft_tasks : "tasks, in order"
  suite_draft_tasks }o--o| tasks : "base or restored-from task"
  suite_draft_tasks ||--o{ suite_draft_files : "files by kind"
  suite_draft_files }o--|| blobs : "content by sha256"
```

The rules that matter for every flow below, all enforced by the database whatever code path writes:

- **Evidence is immutable.** Events, artifacts and scores are append-only. Suites, tasks, task files, task root files, skills, documents and blobs never change. Runs, attempts, experiments and evaluations are never deleted.
- **Only the lease holder writes.** Events and artifacts can be added only while their attempt is `running` and its lease is not revoked. Every worker write is fenced on the lease token.
- **Experiments freeze what they test.** Launch needs frozen configuration versions and valid tasks of the experiment's own suite version.
- **Publishing a score set is strict.** It needs the run's current attempt and exactly the task's declared keys, and fails if a newer generation is already published.
- **`results_revision`** on the experiment goes up whenever a run changes status or a score set is published or superseded. The comparison cache and the verdict history key off it.
- **Lock order** in every status-changing transaction: experiment, then runs, attempts, evaluations.
- **Drafts are working state, not evidence** (Phase 5b): the one mutable suite data, never launched from, deleted on save or discard. A skill or document that a configuration version names cannot be deleted.

---

## 3. State machines

Status: **Built** as vocabularies and database checks, and the API and worker code that performs the transitions (Phase 2; `docs/phases/phase-2.md` section 3.5), with the re-score transitions of an evaluation (Phase 3; `docs/phases/phase-3.md` section 3.2).

### Run

```mermaid
stateDiagram-v2
  [*] --> queued: launch inserts the run
  queued --> running: worker claims, attempt n starts
  running --> executed: Hermes printed a result
  executed --> scoring: evaluate-run claims the evaluation
  scoring --> scored: score set published
  scored --> scored: re-score publishes a newer generation
  running --> execution_error: timeout, provider, setup, disk, OOM, worker lost
  execution_error --> queued: automatic or user retry (attempt n+1)
  queued --> cancelled: cancel
  running --> cancelled: cancel (container stopped)
```

### Attempt

```mermaid
stateDiagram-v2
  [*] --> running: inserted with a fresh lease (60 s)
  running --> running: heartbeat renews the lease every 10 s
  running --> executed: result event, exit 0 or partial
  running --> execution_error: classified failure
  running --> cancelled: cancel requested
  running --> revoked: lease expired or worker gone
  revoked --> execution_error: recovery confirms the container is gone, category worker_lost
  revoked --> cancelled: if cancel had been requested
```

`revoked` is not a status of its own: it is `running` with `lease_revoked_at` set. From there the database allows only `execution_error` or `cancelled`.

### Experiment

```mermaid
stateDiagram-v2
  [*] --> running: launch
  running --> paused: user, spend ceiling, or provider disconnected
  paused --> running: resume
  running --> completed: reconcile, nothing left in flight
  paused --> completed: cancel, then reconcile
  running --> failed: circuit breaker, 14 execution errors in a row
  failed --> running: retry failed runs
  completed --> running: user retries a run
```

### Evaluation (one scoring pass)

```mermaid
stateDiagram-v2
  [*] --> queued: run executed (generation 1) or re-score (generation n+1)
  queued --> running: claimed with a claim token (10 min)
  running --> running: claim renewed after each key, or a redelivered job takes a new token
  running --> completed: publish transaction
  running --> failed: dead letter on a re-score only
  queued --> failed: dead letter on a re-score only
  completed --> superseded: a newer generation publishes
```

A first evaluation never ends `failed`: when its job dies, the dead-letter handler publishes one `error` score per key, so the run still reaches `scored`. A failed re-score leaves the previous generation current.

### Nous Portal login

```mermaid
stateDiagram-v2
  [*] --> not_connected
  not_connected --> waiting_for_approval: Connect, device code issued
  waiting_for_approval --> connected: user approves in the portal
  waiting_for_approval --> denied: user declines
  waiting_for_approval --> expired: code ran out (about 15 min)
  waiting_for_approval --> needs_subscription: portal says subscription_required
  waiting_for_approval --> failed: portal unreachable or other error
  waiting_for_approval --> not_connected: Cancel login
  denied --> waiting_for_approval: Try again
  expired --> waiting_for_approval: Get a new code
  failed --> waiting_for_approval: Try again
  needs_subscription --> waiting_for_approval: Try again after subscribing
  connected --> relogin_required: refresh failed for good
  relogin_required --> waiting_for_approval: Reconnect
  connected --> not_connected: Disconnect
```

Two more states come from outside this machine: `host` (development, `NOUS_HOST_PROXY` set and the host proxy answering) and `host_unreachable` (set, but not answering). The plan also defines `unavailable` (the login service failed its startup check); the design has no frame for it yet.

---

## 4. App shell: navigation, banners, live pills

Status: **Built** against the API (Phase 5; `docs/phases/phase-5.md`): `AppShell.vue` with the providers and system stores, the summary streamed from `/system/events` and `/providers` read again every 30 s. The API serves `/system/summary`, `/system/events` (SSE) and `/providers` (Phase 2).

What the user sees on every page: a 48 px top bar with Experiments, Suites, Configurations, Resources, then System after a divider with a status dot. On the right are the live pill ("2 running · 87 of 240 scored"), the approval pill while a Nous login is waiting, and the theme toggle. Under the bar, an amber banner when a provider that configurations use is not connected.

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (AppShell)
  participant A as API
  participant DB as DB
  participant NL as NousLogin

  U->>W: opens any page
  W->>A: GET /system/summary
  A->>DB: workers with fresh heartbeats, running experiments with scored/total counts
  A-->>W: workers, running experiments with scored/total counts, queued runs
  W->>A: GET /providers
  A->>NL: GET status (no network call, reads nous-home)
  A-->>W: Nous status, API-key providers configured or missing, which configurations use each
  W->>A: GET /system/events (SSE)
  loop every 5 s
    A->>DB: running summary, worker presence
    A-->>W: event: summary
  end
  Note over W: Banner, pills and the System dot are computed in the browser from these two answers
```

How the shell decides what to show:

```mermaid
flowchart TD
  S["Stores loaded:<br/>providers + system summary"] --> B{"Does any configuration use Nous,<br/>and is Nous not connected?"}
  B -- "relogin_required" --> R["Amber banner: 'Your Nous Portal login needs renewing.<br/>1 experiment is paused.' + Reconnect"]
  B -- "not connected" --> N["Amber banner: 'Nous Portal is not connected.<br/>Experiments that use it cannot run.' + Connect"]
  B -- "connected or host" --> NB["No banner"]
  R --> P{"Page is under /suites?"}
  N --> P
  P -- yes --> H["Hide the banner:<br/>suites never call a model"]
  P -- no --> SHOW["Show it under the top bar"]

  S --> L{"Login waiting for approval<br/>and dialog closed?"}
  L -- yes --> AP["Approval pill: 'Waiting for Nous approval · 12:41 left'<br/>click reopens ConnectDialog"]

  S --> RUN{"Experiments running?"}
  RUN -- "yes, worker heartbeating" --> LP["Live pill: 'N running · scored of total'"]
  RUN -- "yes, no worker for 60 s" --> NW["Amber pill: 'N running · no worker'"]

  S --> DOT{"Provider attention, sandbox not proven,<br/>or no worker?"}
  DOT -- yes --> AMB["System dot amber"]
  DOT -- no --> NEU["System dot neutral"]
```

Notes:

- The banner cannot be dismissed while its condition holds. It goes away by itself when the status changes.
- The banner shows on every page but Suites, Resources included (Phase 5, open point 4); on System itself it has no action. An API-key provider that configurations use and that has no key gets its own banner ("OpenRouter has no API key. Experiments that use it cannot run." · How to add it). When Nous cannot be connected from the UI (host mode with the proxy down, or the login service `unavailable`), the banner's action opens System instead of Connect.
- When the summary stream drops, a reconnecting pill shows, and after 30 s an "Offline · Retry" pill (Phase 5).
- The theme toggle only changes `data-theme` on the page and remembers the choice in the browser. Nothing goes to the server.

---

## 5. System page

Status: **Built** against the API (Phase 5; `docs/phases/phase-5.md`): model access, secrets, sandbox and workers. The worker's isolation self-test runs at every worker start, and `GET /system/sandbox` and `GET /system/workers` expose it (Phase 1).

The page has four sections:

- **Model access**: one row per provider `GET /providers` lists, with the configurations that use each.
- **Secrets**: each name, set or not set, and the MCP servers that read it (`GET /resources/secrets`).
- **Sandbox**: whether isolation is proven, with the 15 checks.
- **Workers**: one row per worker.

### 5.1 Worker start and the isolation proof

This happens when the worker starts, not when the user clicks anything. It is what the Sandbox section reports.

```mermaid
sequenceDiagram
  autonumber
  participant WK as Worker
  participant DB as DB
  participant G as Guard
  participant D as Docker
  participant E as Egress
  participant T as Probe trial

  WK->>DB: run migrations (advisory lock)
  WK->>G: GET /version (through the filtered socket)
  WK->>E: health check on the admin socket
  WK->>E: register a probe attempt token
  WK->>G: create + start probe container on a free slot network
  G->>G: check the create body field by field<br/>pinned image by id, uid 10000, read-only, no caps, two subpath mounts
  G->>D: create, start
  D->>T: run the probe script
  T->>T: only two mounts, root read-only, no Docker socket
  Note over T: postgres:5432, api:3000, host gateway,<br/>host.docker.internal and a public IP: all unreachable directly
  T->>E: CONNECT to 10.0.0.1, 127.0.0.1, 169.254.169.254 ...
  E-->>T: 403 refused (private target)
  T->>E: malformed request to the gateway
  E-->>T: 400, and egress stays up
  T-->>WK: 15 check results on stdout
  WK->>G: stop, remove probe
  WK->>E: remove probe token
  alt every check passed
    WK->>WK: state isolated, start taking execute-run jobs
  else any check failed
    WK->>WK: state failed, take no execution job, log each failing check
  end
  WK->>G: hermes tools list in a throwaway container (network none)
  WK->>E: GET /env-names (names with a value, never values)
  WK->>DB: insert workers row: concurrency, slots, Hermes version and revision,<br/>toolsets, env var names, egress env var names, the sandbox report
  WK->>DB: register load-suites and test-mcp-server, then load every suite
  loop every 10 s
    WK->>E: GET /env-names
    WK->>DB: heartbeat, env var names (Phase 2 adds lease renewal)
  end
```

What the user sees: "Isolation proven · 15 of 15 checks · checked 2 min ago at worker start", the Hermes revision and image digest, and a collapsible list of the 15 checks. If a check fails, a red banner names it, and New experiment says that runs cannot start until it passes.

The same checks can be run by hand: `docker compose run --rm --no-deps worker node dist/sandbox-cli.js selftest`.

### 5.2 Workers

`GET /system/summary` (or `/system/workers` in the web data layer) lists `workers` rows with their last heartbeat. A worker is live when its heartbeat is under 60 s old. The row shows concurrency 3, trial slots in use ("2 of 4"), its effective concurrency (`effectiveConcurrency`, the concurrency capped at the slot count: 6 with 4 slots runs 4 at once; Phase 4) and whether its sandbox is proven.

When no worker is live, queued runs simply wait in pg-boss. The UI shows the no-worker banner on running experiments and turns the System dot amber.

### 5.3 Model access rows

```mermaid
sequenceDiagram
  autonumber
  participant W as Web (System page)
  participant A as API
  participant NL as NousLogin

  W->>A: GET /providers
  A->>NL: GET /status
  NL->>NL: get_nous_auth_status_local(), reads nous-home, no network
  NL-->>A: state, portal URL, scope, relogin flag (never a token)
  A->>A: for each API-key provider: is its env var set? (presence only)
  A-->>W: rows: Nous Portal (state), OpenRouter (configured or missing), ...
```

| Row            | States the UI draws                                                                                                                   | Action                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Nous Portal    | not connected, waiting, connected, reconnect, expired, declined, subscription, error, this machine (dev), not running (dev host down) | Connect, Open dialog, Disconnect, Reconnect, Get a new code        |
| OpenRouter etc | configured, missing                                                                                                                   | Copy the `.env` line. No input field: keys never go through the UI |

**Disconnect**: `ConfirmInline` ("Disconnect Nous Portal? Experiments that use it will pause before their next run."), then `POST /providers/nous/logout`. The API calls nous-login, which does what `hermes logout --provider nous` does. Running experiments are not touched directly: the provider guard pauses them at their next claim (section 15).

**Development host login**: with `NOUS_HOST_PROXY` set in `.env`, egress forwards Nous calls to `hermes proxy start` on the host. The row reads "Using this machine's Hermes login (development)" and hides Connect. If the host proxy is down, it shows `not running` with the command to start it.

---

## 6. Connecting Nous Portal

Status: **Built** in the web app against the API (dialog, every state, polling, follow-ups; Phase 5), with a `manual` step that shows the terminal command and sends nothing when Nous cannot be connected from the UI (host mode with the proxy down, or the login service `unavailable`); and in the API: the `nous-login` service and the `providers` module (Phase 2), tested against a fake portal. **To run**: a real login approved in the browser (plan spike I14).

Nous Portal has no API keys, only an OAuth device login with rotating refresh tokens. The user connects once from the UI, and the login lives in the `nous-home` volume, never in the database or the browser.

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (ConnectDialog)
  participant A as API
  participant NL as NousLogin
  participant NP as Nous Portal
  participant V as nous-home volume
  participant PX as NousProxy

  U->>W: clicks Connect (anywhere)
  W->>W: open dialog, step Requesting
  W->>A: POST /providers/nous/login<br/>JSON body + X-Requested-With
  A->>NL: start login (cancels a pending one)
  NL->>NP: device code request
  NP-->>NL: verification URL, user code, expires in 15 min
  NL-->>A: link, user code, expiry (on_verification callback, before polling starts)
  A-->>W: waiting_for_approval, K7QD-P2MX, 15:00
  W->>W: step Waiting: big code, Copy, Open Nous Portal, countdown
  U->>NP: Open Nous Portal (new tab), signs in, approves
  par NousLogin polls the portal
    NL->>NP: poll token endpoint
    NP-->>NL: tokens
    NL->>V: save provider state + credential pool, under Hermes's file lock
  and Web polls the API every 2 s
    W->>A: GET /providers/nous/login
    A->>NL: state
    NL-->>A: waiting_for_approval ... then connected
    A-->>W: connected
  end
  W->>W: step Connected, offer the follow-up for where it was opened
  Note over PX,V: nous-proxy re-reads the auth store on every request,<br/>so it serves the new login without a restart
```

What the dialog offers when it ends depends on where it was opened:

```mermaid
flowchart LR
  C["Connected"] --> O{"Opened from"}
  O -- "New experiment" --> L["Launch now · Back to the form<br/>(never launches by itself)"]
  O -- "Paused experiment" --> RS["Resume experiment"]
  O -- "anywhere else" --> DN["Done"]

  X["Other end states"] --> EXP["expired: Get a new code"]
  X --> DEC["declined: Try again"]
  X --> SUB["needs subscription: link to the portal's billing page"]
  X --> FL["failed: message + Try again"]
```

Details that matter:

- **Closing the dialog does not cancel the login.** Polling continues, and the shell shows the approval pill until the login resolves. Polling pauses while the browser tab is hidden and resumes when it is visible again.
- **Cancel login** sends `DELETE /providers/nous/login`.
- **One login at a time.** A second Connect cancels the pending one and starts a new code.
- **Nothing secret leaves the volume.** The API only ever sees the link, user code, state, expiry and non-secret details.
- **CSRF guard.** The API has no authentication, by requirement. The three state-changing calls therefore require `content-type: application/json` and `X-Requested-With`. Another site open in the same browser cannot send those without a CORS preflight, which the API refuses.

---

## 7. Nudges: where the UI blocks model work and why

Status: **Built** in the web app against the API (SetupCard, banner, ProviderNotice, BlockedReason, summary blocker; Phase 5), and in the API: the launch 409s and the worker's provider guard (Phase 2), the 409s of launch and re-score when the LLM judge's provider is not ready (Phase 3), and the judge keys with no model in each run's `needs`, so Re-score is disabled with the fix (Phase 5).

The rule: a user should never find out at launch, or halfway through an experiment, that no model is reachable. Every place that leads to a model call checks the providers of the configurations involved.

```mermaid
flowchart TD
  start(["User is about to do model work"]) --> where{"Where?"}

  where -- "Experiments list, nothing connected at all" --> SC["SetupCard above the list:<br/>Connect Nous Portal · Use an API key instead"]
  where -- "Configuration form, provider nous" --> PN["ProviderNotice under the field:<br/>'Not connected. You can save now and connect before you launch.'<br/>Save stays enabled"]
  where -- "New experiment, a selected config's provider is down" --> NE["Row tag + summary blocker,<br/>Launch disabled with the reason,<br/>Connect Nous Portal in the panel"]
  where -- "Launch request reaches the API anyway" --> L409["POST /experiments returns 409<br/>'Nous Portal is not connected',<br/>checked before the launch transaction"]
  where -- "Retry, Resume, Re-score with an llm_judge whose judge is on Nous" --> BR["Control disabled through BlockedReason,<br/>with a Connect link"]
  where -- "Experiment already running" --> PG["Worker's provider guard pauses it:<br/>pause_reason provider_disconnected,<br/>no attempt spent"]
  where -- "Suites, reload, self-checks" --> NO["No nudge: they never call a model"]

  SC --> CD["ConnectDialog"]
  PN --> CD
  NE --> CD
  L409 --> NE
  BR --> CD
  PG --> RC["Overview: 'Paused: Nous Portal is not connected...'<br/>Reconnect (primary), Resume disabled until connected"]
  RC --> CD

  KEY{"API-key provider instead of Nous?"} -.-> STEPS["Same placements, no Connect button.<br/>Steps: add OPENROUTER_API_KEY=... to .env,<br/>then docker compose up -d egress worker"]
```

---

## 8. Suites and tasks

Status: **Built** (Phase 1): the file format, the loader in the worker with self-checks and version numbering, the suites endpoints and version history, and the first `invoices-v1` task (`total_due`); the list, suite, task and task-diff pages against the real API, without authoring (Phase 5); home seeds, the expected home and home checks in the format, the loader and Task detail, and all 12 `invoices-v1` tasks (Phase 6; `docs/phases/phase-6.md`); the four capability suites `mcp-v1`, `memory-v1`, `knowledge-v1` and `tools-v1`, so the suite list holds five suites (Phase 6b; `docs/phases/phase-6b.md`); authoring in the UI, Reload all as one job per directory, and verifier scripts in their own containers (Phase 5b; `docs/phases/phase-5b.md`).

Suites are folders under `./suites`, edited on disk with any editor or in the web app (sections 8.3 to 8.11). It shows what was loaded, whether every task passes its own self-check, and every version. The repository ships five: `invoices-v1` (12 tasks), `mcp-v1`, `memory-v1` and `knowledge-v1` (8 each) and `tools-v1` (6), each measuring one thing a configuration can vary. Each `suite.yaml` description names the experiment that measures it (Suite detail shows it), and the skills and documents its arms need are in `samples/` (plan 18.3). Since Phase 5b suites can be created and edited in the UI: edits go into a draft, and saving writes the same files and loads them as a reload does (plan section 4.6).

### 8.1 Reload from disk

Status: **Built** (Phase 1); Reload all as a scan and one job per directory, with each folder's progress on the suite list, since Phase 5b.

The user clicks **Reload all from disk** on the suite list, or **Reload from disk** on one suite. The loader runs in the **worker**, because self-checks run the suite's own verifier scripts (built in Phase 1, decision D1). The API sends a `load-suites` job and waits for its result. Since Phase 5b, Reload all first sends a scan (vanished directories are marked missing) and then one `load-suites` job per directory, and the suite list polls `GET /suites/reload/progress` to show each folder queued, loading, done or failed. The worker also loads every suite when it starts.

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web
  participant A as API
  participant Q as Queue (pg-boss)
  participant WK as Worker (suite loader)
  participant FS as ./suites on disk (the loader only reads)
  participant B as Blob store
  participant DB as DB

  U->>W: Reload from disk
  W->>A: POST /suites/reload { path } or {} for all
  A->>DB: is a worker live? (heartbeat under 60 s)
  alt no live worker
    A-->>W: 503 No worker is connected
  end
  A->>Q: send load-suites (key: the directory, or * for all)<br/>joins a queued job, waits out a running one
  Q->>WK: load-suites job
  loop each directory under SUITES_DIR
    WK->>DB: BEGIN, advisory lock on the directory
    WK->>FS: read suite.yaml and every task file (never follows a link)
    WK->>WK: hash every file, parse task.yaml, validate with zod<br/>one primary key, unique keys, known scorer types, valid params
    WK->>WK: self-check each task against its own reference answer, expected workspace or expected home<br/>(each verifier script in its own container through docker-guard, the task's timeout_s, no env but PATH)
    WK->>B: write each fixture, home seed, verifier, rubric, expected and expected-home file by sha256 (temp, fsync, rename)
    WK->>DB: insert blobs rows (new content only)
    alt same content hash and check hash as an existing version
      WK->>DB: reuse it (outcome unchanged, or reverted if it is an older one)
    else new content or new loader/scorer versions
      WK->>DB: insert suites row (version_number = highest + 1), tasks, task_files<br/>task version_number goes up only for tasks whose content changed
    end
    WK->>DB: upsert suite_sources: outcome, changes vs previous<br/>(added, removed, changed, now invalid, now valid), current pointer. COMMIT
  end
  WK-->>Q: complete, output: one entry per directory
  Q-->>A: result (A polls the job)
  A-->>W: per suite: outcome and a message such as '1 task now invalid: late_fees'
  W->>W: refresh the list, show the message in Last loaded
```

What can happen on a reload:

```mermaid
flowchart TD
  R["Reload one directory"] --> P{"Parses and validates?"}
  P -- "no: a file does not parse, an unsafe file, or the name is taken" --> ERR["outcome error: the error is recorded with file, line and column,<br/>the current pointer stays on the last good version.<br/>UI: 'The suite still serves v5...'"]
  P -- yes --> H{"Content + check hash seen before?"}
  H -- "yes, it is the current version" --> UN["outcome unchanged: nothing new"]
  H -- "yes, an older version" --> RV["outcome reverted: pointer moves back,<br/>History shows 'v2 (reverted)'"]
  H -- no --> NEW["outcome created: new suite version v6"]
  NEW --> SC{"Every task's self-check passes?"}
  SC -- yes --> OK["All tasks valid"]
  SC -- no --> INV["That task is invalid: listed with its failure,<br/>cannot be selected for new experiments.<br/>Existing experiments keep their frozen version."]
  D["Directory vanished"] --> MS["outcome missing: releases the suite name"]
```

After a load, **nothing reads `./suites` again**. Trials, verifiers, judges and the fixture endpoint read blobs by hash. So an edit on disk can never change an experiment that already exists.

### 8.2 Browsing suites and tasks

Status: **Built** (the API in Phase 1, the pages in Phase 5); since Phase 5b the list's last change is the one that created the version shown, task diffs list the root files' sizes and hashes and line diffs of small text files, and Task detail lists the experiments of every version of the task.

| User action                           | Call                                               | What the API reads                                                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open Suites                           | `GET /suites`                                      | `suite_sources` with the current `suites` row: name, v5, label 0.3, task and valid counts, last change                                                                                         |
| Open a suite                          | `GET /suites/:id`                                  | that suite version's tasks with validity and self-check failures                                                                                                                               |
| Pick an older version in the selector | `GET /suites/:olderId`                             | the same, for that version, read-only notice                                                                                                                                                   |
| History panel                         | `GET /suites/:id/history`                          | every version of the directory, its changes, and the experiments that used each                                                                                                                |
| Expand a failed self-check            | (already in the suite payload)                     | verifier output, the contract, what changed                                                                                                                                                    |
| Open a task                           | `GET /suites/:id/tasks/:key`                       | prompt, fixtures with hashes, home seeds and expected-home files (`homeFiles`, Phase 6), verification entries, hidden reference, verifier source, self-check, limits, experiments that used it |
| Task History                          | `GET /suites/:id/tasks/:key/history`               | the task key's versions and where each first appeared                                                                                                                                          |
| Open a diff                           | `GET /suites/:id/tasks/:key/diff?against=:suiteId` | prompt and task.yaml text diffs, reference JSON diff, file list changes with task.yaml, prompt.md and reference.json first, line diffs of changed text files up to 64 KiB                      |
| Preview or download a fixture         | `GET /suites/:id/tasks/:key/fixtures/:path`        | the blob by hash                                                                                                                                                                               |

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (Task detail)
  participant A as API
  participant DB as DB
  participant B as Blob store

  U->>W: opens total_due
  W->>A: GET /suites/:id/tasks/total_due
  A->>DB: task row (prompt, reference, verification, self-check, version 2)
  A->>DB: task_files for the task
  A->>DB: runs of experiments that used this task version, pass rate per configuration
  A-->>W: task detail
  W->>W: 'total_due · v2 · changed in suite v5'<br/>reference shown inside the 'Hidden from the agent' panel
  U->>W: History, opens v2
  W->>A: GET /suites/:id/tasks/total_due/diff?against=v4
  A->>DB: both task versions and their task_files
  A->>B: read prompt and yaml text for both
  A-->>W: text diff, JSON diff of the reference, file list with sizes and short hashes
  U->>W: Preview invoices.csv
  W->>A: GET /suites/:id/tasks/total_due/fixtures/invoices.csv
  A->>B: blob by sha256
  A-->>W: first rows
```

The reference answer is shown to the user (it is their own task) but marked "Hidden from the agent": it is never copied into a trial. Only task files of kind `fixture` ever enter a workspace, and only those of kind `home_seed` the home.

**Home files on Task detail** (Phase 6). A task that seeds the agent's memory (`home/memories/MEMORY.md`, `USER.md`) shows a **Home seeds** panel after Fixtures, marked visible to the agent: "Copied into the agent's memories/ before every run, in every configuration; read only with memory on". A task that declares `self_check.expected_home` shows an **Expected home** panel after the reference answer, marked hidden: what a home check expects the memory files to hold, laid over the seeds, never copied into a run. Each row has the path in the task folder, its kind, where it sits in the home (`memories/USER.md`, as the API works it out), size, hash, and the file's text (up to 16 KB), the first one open. A `file_check` with `root: home` carries a `root: home` tag, and its sentence reads "file_check: memories/USER.md in the home exists …". A home check's self-check reads "passes on the expected home; fails on the home seeds alone, as it should"; one that passes on the seeds alone makes the task invalid, "passes on the home seeds alone too, so it would pass any agent". A verifier's contract now reads `--answer <file> --workspace <dir> --home <dir>`.

### 8.3 Authoring: a new suite

Status: **Built** (Phase 5b; `docs/phases/phase-5b.md`; boards SA.1, SA.2 and Flow E steps 1 to 3).

Files stay the source of truth (plan 4.6). An edit never touches a version: it goes into a draft, one per suite folder (or new suite name), stored in Postgres and the blob store, which saves on every change and lasts until it is saved or discarded. Nothing reaches `./suites` before Save (section 8.6). Draft routes address a suite by its folder name. The suite list marks a folder that has a draft with a chip ("draft · 3 changes", "Draft based on v6, last edited 16:31" on hover) and lists new suites not saved yet above its table.

Suites › New suite (or Create a suite on the empty list) opens a 640 px form. The name is also the folder, `./suites/<name>/`, fixed after the first save; it is checked as it is typed against the folder rule and the names suites and drafts hold.

```mermaid
flowchart TD
  N["Suites › New suite"] --> NAME{"Name: a folder name,<br/>held by no suite and no draft?"}
  NAME -- "no" --> MSG["The reason under the field, Create disabled<br/>'invoices-v1 is already used by ./suites/invoices-v1.'"]
  NAME -- yes --> FROM{"Start from"}
  FROM -- "Empty" --> E["POST /suites/drafts, from empty"]
  FROM -- "Copy of a suite" --> C["POST /suites/drafts, from a copy of a version<br/>every task at that version, verify/ scripts included<br/>no confirmation: the scripts are on disk already"]
  FROM -- "A .zip file" --> Z["The import dialog (section 8.10)"]
  E --> D["The new suite's draft (section 8.4), every task added<br/>'Add at least one task to save v1.' while it has none"]
  C --> D
  Z --> D
  E -. "409: the name was taken meanwhile" .-> MSG
```

### 8.4 Authoring: drafts and the task editor

Status: **Built** (Phase 5b; boards SA.3 to SA.8 and SA.13).

A draft records its base version and every file of the folder: the texts the forms edit verbatim (`task.yaml`, `prompt.md`, `reference.json`, rubrics), every other file as a blob with its kind (fixture, expected, expected_home, home_seed, verifier, other). A draft of a folder on disk is built from its current version in the database (the API has no suites mount), with every task `unchanged`.

| User action                                                 | Call                                                             | What happens                                                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Suite detail › Add task, Edit details, a row's Edit         | `POST /suites/:suite/draft` (201 new, 200 the open one)          | a draft on the folder's current version, every task `unchanged`; the draft page is `/suites/:suite/draft`                                        |
| Add task › Blank task, Duplicate a task…, copy from a suite | `POST /suites/:suite/draft/tasks`                                | new draft tasks; a duplicated or copied task carries its files' blobs (a copied verifier check its `verify/` folder)                             |
| Edit details (label, description), drag a row               | `PATCH /suites/:suite/draft` (Edit details debounced 500 ms)     | the label, the description, or the order written to suite.yaml at save                                                                           |
| Edit the Form, prompt, reference or task.yaml tab           | `PUT /suites/:suite/draft/tasks/:key` (debounced 400 ms)         | stored at once; task.yaml is patched through the `yaml` Document API, so comments and formatting survive; readiness runs again                   |
| Drop files on Workspace, Expected or Home files             | `POST …/tasks/:key/files` (multipart `file`, `kind`, `path`)     | the file goes to the blob store first (temp file, fsync, rename), then the draft names it; over 25 MB is refused before sending (413 in the API) |
| Rename, move or delete a file                               | `PATCH` / `DELETE …/tasks/:key/files/:path`                      | any path under `verify/` is refused (400): scripts are code, edited on disk or brought by a trusted zip (section 8.10)                           |
| View a verifier script                                      | `GET …/tasks/:key/files/:path`                                   | the source, read-only, with its path, hash and Copy path                                                                                         |
| Try it on an answer check                                   | `POST …/tasks/:key/try` `{ key, reply }`                         | extraction and that check's scorer, in the API, on the pasted reply or the reference; nothing is stored and no model is called                   |
| Remove a task, Undo, Revert                                 | `DELETE …/tasks/:key`, `PUT { removed: false }`, `POST …/revert` | a base task is marked removed (its folder goes at save), an added one dropped; Revert puts the base version's files back                         |
| Discard the draft                                           | `DELETE /suites/:suite/draft`                                    | 204, after "Discard this draft? Nothing on disk changes."; nothing on disk changes                                                               |

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (task editor)
  participant A as API
  participant DB as DB
  participant B as Blob store

  U->>W: types in the Form tab
  W->>W: waits 400 ms after the last change, one write at a time
  W->>A: PUT /suites/:suite/draft/tasks/:key with the form and its revision
  A->>DB: lock the draft row, refuse while a save runs or for a stale revision (409)
  A->>A: patch task.yaml (only the changed nodes), keep prompt.md and reference.json as typed
  A->>A: readiness, the 13 rules, without running user code<br/>(shared schemas, the loader's task analysis on an in-memory folder,<br/>answer checks scored against the reference, the cross-checks)
  A->>DB: store texts, state (by content hash, so an undone edit is unchanged again), readiness, revisions
  A-->>W: the task, its files and readiness
  W->>W: the readiness panel, and a problem's Fix link opens its field
  U->>W: drops invoices.csv
  W->>A: POST …/files (multipart, kind fixture)
  A->>B: write by sha256 (temp, fsync, rename)
  A->>DB: blobs row, draft file row, readiness again
```

The form and task.yaml are never sent together, so each tab follows the other; a task.yaml the form cannot hold (an unknown key, a value of the wrong type, two primaries) locks the form under a banner, and a form sent meanwhile answers 409. A rename is sent only once the key is a free folder name. A failed write is kept, with "draft · not saved" and Try again. Leaving the editor while an upload runs asks first ("1 upload is still running. Leave anyway?").

The readiness rules, in the order the panel lists them: key and summary; task.yaml is valid; one primary check; check settings; reference.json parses; every check path resolves in the reference; file checks have an expected workspace (and home checks an expected home); the prompt asks for the answer block; files the prompt mentions exist; no text fixture holds a reference value of 4 or more characters; files within the limits; the self-check; the negative control. Problems never block saving: a task with problems is saved as invalid, as on disk.

### 8.5 Authoring: a self-check in the worker

Status: **Built** (Phase 5b; boards SA.7 and SA.8).

File checks and verifier scripts run user code or need a known-good folder, so the API cannot self-check them; the panel shows them pending until the user clicks **Run self-check**, and again after any edit.

```mermaid
sequenceDiagram
  autonumber
  participant W as Web
  participant A as API
  participant Q as Queue
  participant WK as Worker
  participant G as Guard
  participant DB as DB

  W->>A: POST /suites/:suite/draft/tasks/:key/self-check
  A->>DB: is a worker live?
  alt no live worker
    A-->>W: 503 "The worker isn't running, so file checks and scripts can't be self-checked. Your draft is kept."
  end
  A->>Q: self-check-draft with the draft task and its content hash, and wait
  Q->>WK: job
  WK->>WK: write the draft task from its blobs into scratch, analyse it with the loader
  WK->>G: each verifier in its own container (below)
  WK->>WK: the loader's own task self-check, the positive run, then the negative control
  WK-->>Q: the self-check record, with the content hash it ran on
  A->>DB: store it on the draft task, readiness again (rows 12 and 13)
  A-->>W: the results, with each verifier's command and output
```

**Every verifier runs in a container of its own** since Phase 5b (plan 14, R7): for a draft's self-check, a load's self-checks and scoring alike. The worker copies the script's folder, the answer, the workspace and the home into a scratch subpath of the trials volume and asks docker-guard for `hermes-evals-verify-<id>`, which must match the verifier policy exactly:

```mermaid
sequenceDiagram
  autonumber
  participant WK as Worker
  participant V as Trials volume
  participant G as Guard
  participant C as Verifier container

  WK->>V: copy verify/, answer.json, workspace/ and home/ into verify-ID
  WK->>G: create hermes-evals-verify-ID
  alt any other shape: a network, a writable or second mount, another image, a capability, more environment
    G-->>WK: 403 refused
    WK->>WK: VerifierUnavailable: the load records an error, scoring retries, a draft answers 503
  end
  G->>C: the trial image's python3, network none, read-only root and inputs,<br/>a 64 MiB /tmp, uid 10000, no capabilities, PATH only, pids and memory limits
  C-->>WK: the last stdout line, a JSON score and comment
  WK->>G: kill at the deadline, then remove the container
  WK->>V: remove verify-ID
```

### 8.6 Authoring: review and save

Status: **Built** (Phase 5b; boards SA.11, SaveSteps and Flow E step 7).

**Review and save** (`/suites/:suite/save`, `GET /suites/:suite/draft/review`) lists each change with its diff, every file the save writes, and each changed task's readiness; tasks with problems are named ("Save with 1 invalid task?"). **Save as vN** sends `save-suite-draft` and waits. The draft is claimed while it runs: other writes answer 409 and the page shows the steps (staging, loading, self-checks, moving).

```mermaid
sequenceDiagram
  autonumber
  participant W as Web (SaveSteps)
  participant A as API
  participant Q as Queue
  participant WK as Worker (save handler)
  participant FS as ./suites (read-write for the save alone)
  participant DB as DB

  W->>A: POST /suites/:suite/draft/save with the label and revision
  alt no live worker
    A-->>W: 503 "No worker is running. Saving needs the worker. Your draft is kept."
  end
  A->>DB: claim the draft (save_started_at)
  A->>Q: save-suite-draft, and wait
  Q->>WK: job
  WK->>DB: advisory lock on the folder, one transaction
  WK->>WK: 1. conflict check, the current version still the base,<br/>the files on disk hashing to it with its task folders
  alt the folder moved on
    WK-->>A: conflict (files edited on disk are loaded first, as the next version)
    A-->>W: 409 with the new version and the tasks both sides changed (section 8.7)
  end
  WK->>FS: 2. list the live folder, build the staging folder .draft-ID beside it,<br/>the draft's files from blobs, every entry it does not decide copied untouched
  WK->>WK: 3. load the staging folder with the loader, self-checks included
  alt a folder-level failure (a task.yaml that does not parse, an unsafe file, a taken name)
    WK->>FS: remove the staging folder
    A-->>W: 422 "Not saved. (file) line N: (message). Nothing on disk changed. Your draft is kept."
  end
  WK->>WK: 4. the disk checked again, hash, task folders and listing
  alt changed by hand during the save
    A-->>W: 409 disk_changed for a stored file, else 422, changed on disk during the save
  end
  WK->>FS: live folder aside, staging into place (nothing moves when staging hashes like the base)
  WK->>DB: record that read under the folder (a new version, or unchanged), 5. delete the draft, commit
  WK->>FS: remove the old folder
  A-->>W: "v7 saved · 1 added · 12 tasks, 12 valid", and New experiment on v7
```

What staging copies: a file is the draft's to decide when the draft holds it or the base version stored it; every other entry of the live folder (`verify/`, a README, notes, hidden files, links) is copied untouched. A save that fails after the first rename puts the live folder back. A save that outlasts `SUITE_RELOAD_TIMEOUT_S` answers 504 and goes on; the draft page shows its steps until it ends.

### 8.7 Authoring: a conflict, and Combine

Status: **Built** (Phase 5b; board SA.12).

A draft on v6 can find the folder moved on: a reload created v7 (shown as soon as the draft opens), or files were edited on disk and not reloaded (found by the save, which loads them as v7 first). The draft bar turns amber, names the new version, when it was loaded, its changes and the tasks both sides changed, and asks for one choice per such task.

```mermaid
flowchart TD
  S["Save, or open the draft"] --> C{"Current version = the draft's base,<br/>and the disk hashes to it?"}
  C -- yes --> OK["Save goes on"]
  C -- "no: a reload made v7" --> M["Conflict, version_moved"]
  C -- "no: files edited on disk" --> D["The save loads them as v7 first,<br/>then: conflict, disk_changed"]
  M --> R["Draft bar: v7's changes, your changes, the tasks both changed"]
  D --> R
  R --> P["Per overlapping task: Keep my version or Keep the version on disk"]
  P --> CB["Combine: POST /suites/:suite/draft/rebase with onto 7 and the choices"]
  CB --> N["The draft is now on v7; Review and save as v8"]
  CB -- "the folder moved again" --> R
```

Review and save is blocked while the draft carries a conflict, and a 409 at save goes back to the draft page. Discard stays available.

### 8.8 Authoring: tasks from CSV or JSONL

Status: **Built** (Phase 5b; board SA.9).

**Import tasks** (`/suites/:suite/import`, from Add task › Import from CSV or JSONL; it opens the suite's draft) makes many tasks over the same files. The file is parsed in the API: CSV (comma, semicolon or tab, read from the header line) or JSONL, UTF-8 or UTF-16 with its mark, at most 5 MB and 500 rows. Each column maps to the task key (or a key prefix generating `overdue_q01`, …), the summary (or the prompt's first 80 characters), the prompt, the whole reference, or the value at the answer path. The new tasks share workspace files (none, a task's, or uploaded), checks (new, or a task's) and limits, and the answer paragraph can be appended to every prompt.

```mermaid
flowchart TD
  U["1 Upload: POST …/draft/import/validate with the file alone"] --> P{"Readable?"}
  P -- no --> PR["The refusal in the board's words:<br/>'questions.xlsx: use CSV or JSONL.', '1,240 rows. The limit is 500 per import.'"]
  P -- yes --> M["2 Map columns (ColumnMapper)<br/>'Map one column to Prompt.' until it is done"]
  M --> S["3 Shared settings: workspace, checks, limits, answer paragraph"]
  S --> V["4 Preview: validate with the settings<br/>each row's key, reference value and readiness"]
  V --> A{"Add: POST …/draft/import"}
  A -- "a key that is not a folder name, or is taken" --> F["422 with the preview: fix the key on its row"]
  F --> A
  A -- ok --> T["201: the rows are added tasks of the draft; nothing on disk until Save"]
```

### 8.9 Authoring: download a version, restore a task

Status: **Built** (Phase 5b; boards SA.3 and SA.10).

**Download .zip** on Suite detail (and on the draft, for the version on screen): `GET /suites/:suite/versions/:n/zip` streams `<suite>-v<n>.zip` from the version's blobs; suite.yaml is written anew from the stored version, and files the loader never stored (a README) are not in it. **Restore this version into the draft** on an older version's Task detail: `POST /suites/:suite/draft/tasks` with `kind: restore`, the suite version and the key, opening the draft if needed, copies that task version's texts and files from its blobs into the draft, marked "restored from vN"; the save writes them, `verify/` included, and keeps the author's unstored files beside them.

### 8.10 Authoring: a suite from a .zip

Status: **Built** (Phase 5b; board SA.10, plan R7).

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (ImportSuiteDialog)
  participant A as API
  participant B as Blob store

  U->>W: Import .zip (up to 100 MB)
  W->>A: POST /suites/import/validate (multipart)
  A->>A: index checks before reading, no links, absolute paths or .., at most 20,000 entries,<br/>no file over 25 MB, depth 12, no paths that differ only in case, nothing encrypted
  A->>A: suite.yaml, folder names and every task.yaml checked with the loader's rules
  A->>B: stream the files into the blob store, analyse each task, no code runs
  A-->>W: the suite, its tasks (worker-only checks "self-check not run"),<br/>every verify/ file with path, size and SHA-256, a free name if the name is taken, and a token
  W->>W: "This suite contains code", Import disabled until "I trust these scripts" is ticked
  U->>W: ticks, Import as a draft
  W->>A: POST /suites/import with the token, the name and trustScripts true
  alt scripts and no tick
    A-->>W: 409 "Confirm the verifier scripts first."
  else an unknown or expired token
    A-->>W: 404 or 410, validate again
  end
  A-->>W: the draft of the new suite, every task added, saved as v1 after review (section 8.6)
```

A refused zip shows its reasons in the board's words, such as "The zip has a symbolic link at …", "… points outside the suite.", "suite.yaml: version_label is required." or "Over 20,000 files.". A taken name offers Import as a new suite named `<name>-copy`, or Open the existing suite. A zip without scripts shows no panel. Copy of a suite needs no tick: its scripts are already on disk.

### 8.11 Flow E: from nothing to a first experiment

Status: **Built** (Phase 5b; board FlowE). Walked in the browser on the Compose stack (`docs/phases/phase-5b.md` 5.4; the manual walk is `docs/flows.md`, "Flow E").

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web
  participant A as API
  participant WK as Worker
  participant G as Guard
  participant FS as ./suites

  U->>W: Suites › New suite, name and description, Create
  W->>A: POST /suites/drafts from empty
  A-->>W: the draft, no tasks, "Add at least one task to save v1."
  U->>W: Add task › Blank task, key, summary, prompt, Add answer instructions
  W->>A: PUT the task, debounced
  A-->>W: readiness, two files mentioned but not in the workspace, no reference, no check
  U->>W: drop statements.csv and ledger.csv, the reference, the answer path, a Number within tolerance check
  W->>A: POST the files, PUT the task
  A-->>W: readiness "Ready to save"
  U->>W: Try it with a pasted reply
  W->>A: POST …/try
  A-->>W: extracted, value 2, passed, nothing stored
  U->>W: Review and save as v1, Save as v1
  W->>A: POST …/draft/save
  A->>WK: save-suite-draft
  WK->>FS: staging folder, loaded with self-checks, renamed into place
  WK->>G: verifier containers for any verify/ scripts
  WK-->>A: v1 created
  A-->>W: "v1 saved · 1 added: unmatched_lines · 1 task, 1 valid"
  U->>W: New experiment on v1
  W->>W: /experiments/new with the suite preselected and its valid tasks
  U->>W: pick the configurations, Launch
  W->>A: POST /experiments, as in section 11
```

The experiment on v1 runs like any other: it is pinned to v1, and a later save creates v2 for future experiments only.

---

## 9. Resources: skills, documents, MCP servers, secrets

Status: **Built**: the tables, every endpoint and the MCP test handler (Phase 1); the http branch of Test start through the egress MCP gateway (Phase 2); the four tabs against the real API (Phase 5); deleting an unused skill or document, and a passing Test start of an unsaved MCP form kept when it is saved (Phase 5b).

Resources are the building blocks configurations point at. Every resource version is immutable once a configuration uses it.

### 9.1 Upload a skill (two steps)

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (ResourceUploadDialog)
  participant A as API
  participant TMP as Temp dir
  participant FS as evaldata: resources/skills
  participant DB as DB

  U->>W: drops invoice-method.zip
  W->>A: POST /resources/skills/validate (multipart, 20 MB cap)
  A->>TMP: unpack, refusing absolute paths, '..', symlinks, over 100 MB
  A->>A: SKILL.md at the root? frontmatter name, version, description?
  A->>A: count files, hash content
  A->>DB: does this name + version exist? with the same hash?
  A-->>W: validation report + short-lived token (nothing stored yet)
  W->>W: Step 2 of 2: report, 'new skill' or 'new version of invoice-method'
  U->>W: Confirm
  W->>A: POST /resources/skills {token}
  A->>FS: move the directory to resources/skills/<hash>/
  A->>DB: insert skills row (name, version, hash)
  A-->>W: skill
```

Refusals the dialog shows: no `SKILL.md` at the root, missing frontmatter fields, an unsafe path, too large, and "same name and version, different content" (the user must bump the version).

Skill detail (`GET /resources/skills/:id/files/:path`, `GET /resources/skills/:id/zip`) shows the files and which configurations use it.

### 9.2 Upload a document

`POST /resources/documents` (50 MB cap) stores the content in the blob store by sha256 and inserts a `documents` row. Documents attach to configurations only. At run time they are copied into the workspace under `docs/`, and the artifact list later marks them unchanged or modified.

**Delete** (Phase 5b). `DELETE /resources/skills/:id` and `DELETE /resources/documents/:id` remove a skill or document that no configuration version names, and answer 204. One that a version names stays, because a configuration version keeps what it was saved with: 409 with the configurations in `usedBy`, which the confirmation quotes. Migration 0009's guard catches a configuration saved between the check and the delete, so both never commit. The skill tree and the blob stay on disk (content may be shared).

### 9.3 Define and test an MCP server

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (McpServerForm)
  participant A as API
  participant DB as DB
  participant Q as Queue
  participant WK as Worker
  participant G as Guard
  participant T as Throwaway trial
  participant E as Egress

  U->>W: name 'invoice-db', stdio: command + env NAMES<br/>or http: URL + header ← variable NAME pairs (never values)
  W->>A: POST /resources/mcp-servers
  alt a name is a platform variable or credential, or used by both transports
    A-->>W: 400, issue on the env names field:<br/>'DATABASE_URL is a platform variable or credential, it never enters a trial'
  end
  A->>DB: insert mcp_servers + mcp_server_versions v1 (one transaction), last_test untested
  A-->>W: saved
  U->>W: Test
  W->>A: POST /resources/mcp-servers/:id/test
  A->>Q: send test-mcp-server (key: version id and definition hash)
  Q->>WK: test-mcp-server job
  WK->>DB: last_test running
  WK->>WK: refuse reserved names again, before any container
  alt stdio, every env name set in the worker
    WK->>G: create + start a trial container with only this server configured<br/>network none, its env values in the container environment only
    G->>T: start: hermes mcp test invoice-db
    T->>T: Hermes starts the server inside the container and lists its tools
    T-->>WK: tool list or error on stdout
    WK->>G: remove the container and its directory
  else stdio, a name not set
    WK->>WK: failed, naming the missing variables, no container
  else http
    WK->>WK: failed until the egress MCP gateway exists (Phase 2)
    Note over WK,E: Phase 2: tools/list to egress:8080/mcp/vendor-api,<br/>egress adds the header values from its own environment
  end
  WK->>DB: write last_test: passed + tools, or the error and missing secret names<br/>(values replaced by <from env NAME>)
  A-->>W: the result (the API waits up to MCP_TEST_TIMEOUT_S, then answers running)
  W->>W: 'Tested 15:02 · 4 tools' or the failure
```

Editing rules:

- **Edit a definition no configuration version uses**: updated in place.
- **Edit one that is frozen** (a configuration version uses it): `PUT` creates version 2. The form warns: configurations on version 1 keep it.
- **Save without testing** is allowed. The version then shows `untested`.

The form says, per transport, what the agent can read. Under a stdio server's environment variables, an amber caution: "This server runs inside each run's container. The agent can read these values. Use scoped or throwaway values." Under an http server's header names: "Egress adds these headers to each request on the way to the server. The run never sees their values." Section 9.4 explains why.

### 9.4 Secrets

Status: **Built**: the endpoint and presence reporting (Phase 1), the egress MCP gateway that adds header values (Phase 2, spike I15 passed), and the Secrets tab and the System page's secrets against the real API (Phase 5).

`GET /resources/secrets` lists every name that MCP definitions reference: set or not set, its source, what references it, its exposure, and when it was last checked. Values are never shown, stored, typed or sent to the browser. A value is set by adding it to `.env` and restarting the service that reads it (`docker compose up -d egress worker`). Egress sends an http header variable's value unchanged as the whole header, so a Bearer API needs `Bearer <key>` in the variable; for the sample `vendor-directory`, `.env` holds only the token and Compose writes the prefix for egress (Phase 6). A name that is not set also blocks Launch for the configurations that use it (section 11.1).

How a value reaches a run depends on the server's transport:

```mermaid
flowchart LR
  ENV[(".env on the user's machine")]
  ENV -- "stdio env values" --> WK["worker"]
  ENV -- "http header values" --> E["egress"]

  subgraph trial["trial container (the agent can read everything here)"]
    H["Hermes<br/>config.yaml: INVOICE_DB_URL: ${INVOICE_DB_URL}"]
    S["stdio server invoice-db<br/>env INVOICE_DB_URL = real value"]
    H -- "starts, fills ${NAME}" --> S
  end

  WK -- "container env<br/>INVOICE_DB_URL=value" --> H
  H -- "http MCP call, no header<br/>egress:8080/mcp/vendor-api" --> E
  E -- "adds Authorization from VENDOR_API_TOKEN" --> V[("vendor-api server")]
```

| Case                | The value lives in                                             | Readable by the agent? | UI label                             |
| ------------------- | -------------------------------------------------------------- | ---------------------- | ------------------------------------ |
| stdio, env variable | the trial's container environment and the server process's env | Yes                    | "Readable by the agent" (amber)      |
| http, header        | egress only; added to each request on the way to the server    | No                     | "Added by egress · never in the run" |

- **Why stdio is readable.** A stdio server is a process inside the trial, and it needs the real value to work. The agent has a terminal in the same container, so it can read `/proc/<pid>/environ` or start the same command itself. A placeholder cannot help. The UI states it as a fact in the caution style, never the failure colour, and never blocks saving: Resources › Secrets (Exposure column), the MCP form, the configuration form and detail beside the server, System › Secrets, and the run's launch record.
- **Never in a file.** `config.yaml` in the home holds `${INVOICE_DB_URL}`, which Hermes fills from its own environment when it starts the server. Launch records, stored `config.yaml` copies and stderr tails show `<from env INVOICE_DB_URL>`.
- **stdio servers have no network.** Hermes starts them with a filtered environment that drops the proxy variables, and the slot network has no other route. A server that must reach a remote service is defined as http.
- **Presence.** The worker records the names it has on its `workers` row at start, and asks egress over its admin socket which names egress has. "Check again" re-reads them. A run or a test with a missing name ends as `execution_error · setup` and names it.

---

## 10. Configurations

Status: **Built**: tables, versioning triggers (a frozen version never changes), the config hash, and every endpoint (Phase 1); `GET /configurations/new-draft` for a new configuration's form, and the list, form and detail against the real API (Phase 5); skill loading, preload or on demand, in the form, detail, list, diff, duplicate and history (Phase 6; `docs/phases/phase-6.md`).

A configuration is a record of how Hermes is set up: model, provider, toolsets, memory, skills and how they load, documents, MCP servers and limits. It is only a definition: saving one never calls a model, so Save is never blocked by provider status.

### 10.1 Create, edit, duplicate

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (ConfigurationForm)
  participant A as API
  participant DB as DB

  W->>A: GET /configurations/form-options (models with prices, providers,<br/>toolsets the live worker found in the trial image, skills, documents, MCP versions)
  W->>A: GET /providers (for the ProviderNotice under the provider field)
  U->>W: fills name, model, provider, toolsets, memory, skills (and, once one is chosen,<br/>skill loading: preload or on demand), documents, MCP servers, limits
  W->>W: unknown model? warn 'no price: cost will show as —'
  U->>W: Save
  alt new configuration
    W->>A: POST /configurations
    A->>DB: insert configurations + configuration_versions v1 (config hash)<br/>freeze the MCP definitions it uses
  else editing
    W->>A: PUT /configurations/:id
    A->>DB: lock the latest version
    alt version is frozen (an experiment used it)
      A->>DB: insert version n+1, move the latest pointer
    else not frozen
      A->>DB: update it in place, recompute config hash
    end
  end
  A-->>W: saved version
```

**Skill loading** (Phase 6). Once a skill is chosen, the Skills row shows a two-option control, **preload** or **on demand**, with one line of help: "Preload puts the skills in the prompt; on demand installs them for the agent to find, with the `skills` toolset." With no skills the control is hidden and the form saves `preload`, so it never meets the API's 400 for on demand without skills ("Skill loading applies only when the configuration has skills", shown under Skills if it comes). The aside's change summary names `skill_loading`. A change of mode alone is a change: saved in place on an unused version, a new version on a frozen one. The mode enters the config hash only when it is on demand, so every earlier version kept its hash.

The form shows the versioning rule before saving: on a configuration an experiment already used, the banner reads that saving creates version 2 and that the experiments keep version 1. The button reads **Save as version 2**.

**Duplicate** (`POST /configurations/:id/duplicate`) returns a prefilled draft, skill loading included. No row exists until the user saves. The version's history line names a change of mode ("Duplicated from with-skill v1; set skill loading to on demand").

### 10.2 List, compare, detail

| User action                  | Call                                      | Result                                                                                                                                                     |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open Configurations          | `GET /configurations`                     | name, latest version, model, provider, skill/doc/MCP counts (skills loaded on demand tagged "on demand"), used in N experiments                            |
| Select two or three, Compare | `GET /configurations/diff?versions=a,b,c` | one row per field with each value and a `differs` flag (the `skill_loading` row reads "preload" or "on demand"); same rows feed ConfigDiffTable everywhere |
| Open one                     | `GET /configurations/:id`                 | fields (a **Skill loading** row with the mode and what it does, or "(no added skills to load)"), every version, duplicated-from, used in which experiments |
| Open an older version        | `GET /configurations/:id/versions/:v`     | that version's fields, read-only                                                                                                                           |

### 10.3 What a configuration becomes at run time

A configuration version is turned into the trial's `config.yaml` and command line (section 12.2): model and provider pointed at the egress gateway, toolsets plus one `-t` entry per MCP server name, the skills copied into the home and, with preload, `-s` per skill (on demand: no `-s`, and the `skills` toolset added once, so the agent lists the skills and opens one with `skill_view`), memory on or off, max turns and time budget. The platform adds the rest itself so arms differ only where the user intended: bundled Hermes skills off, update checks off, approvals off, and the background review's intervals written at Hermes's defaults (10 and 10), the same in every arm; a one-shot run is a finite turn, for which Hermes starts no review.

Memory on puts the task's home seeds in the prompt and adds Hermes's `memory` toolset to the run, so the agent can also save (Phase 6 #1, built in Phase 6b; the launch record's `-t` list shows it).

Hermes always installs its own `hermes-agent` skill in every home and it cannot be turned off. So `baseline` has "no added skills", not "no skills": every arm has that one skill.

---

## 11. New experiment and launch

Status: **Built**: tables, the launch trigger, transactional job sending, and the endpoints: `GET /experiments/new-options`, the estimate and `POST /experiments` with its 409 checks (Phase 2); the page against the real API (Phase 5); the 409 and the per-configuration tags and blocker for MCP variables that are not set (Phase 6, Phase 5 #13; `docs/phases/phase-6.md`).

### 11.1 Filling the form

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (NewExperiment)
  participant A as API
  participant DB as DB

  W->>A: GET /experiments/new-options: suites with valid tasks, configurations with latest versions,<br/>config hashes, skill loading and the MCP variables not set where they are read
  W->>A: GET /providers
  U->>W: picks suite invoices-v1 v5, tasks (invalid ones disabled with the reason)
  U->>W: picks baseline + candidate(s)
  W->>A: GET /configurations/diff?versions=baseline,candidate
  A-->>W: differing fields, shown inline (with-skill differs in 1 field: skills)
  U->>W: repetitions 5, concurrency 3, spend ceiling, time budget override
  W->>A: GET /experiments/estimate?suite=&versions=&repetitions=&concurrency=
  A->>DB: median duration and cost of past attempts on this suite and config_hash
  A-->>W: 120 runs, 40 waves, about 36 min, $1.69 (or basis budget when no history)
  W->>W: ExperimentSummaryPanel: runs, time, cost, blockers
```

The summary panel decides whether **Launch** is enabled:

```mermaid
flowchart TD
  F["Form state"] --> V{"Name, suite, at least one task,<br/>baseline + at least one candidate?"}
  V -- no --> D1["Launch disabled: the missing field"]
  V -- yes --> PR{"Every selected configuration's provider connected?"}
  PR -- no --> D2["Launch disabled: 'Nous Portal is not connected'<br/>+ Connect Nous Portal in the panel"]
  PR -- yes --> MS{"Every chosen configuration's MCP variables set?"}
  MS -- no --> D4["Launch disabled: 'with-mcp: INVOICE_DB_URL (invoice-db,<br/>read by the worker) is not set.' + what to set, the command, Check again"]
  MS -- yes --> SB{"Sandbox proven and a worker live?"}
  SB -- no --> D3["Launch disabled: runs cannot start until the sandbox passes"]
  SB -- yes --> SP{"Estimate over the spend ceiling?"}
  SP -- yes --> WARN["Warning, Launch still allowed:<br/>the spend guard will pause at the ceiling"]
  SP -- no --> OK["Launch enabled"]
  WARN --> OK
```

### 11.2 Launch: one transaction

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web
  participant A as API
  participant NL as NousLogin
  participant DB as DB
  participant Q as Queue (pg-boss, same DB)

  U->>W: Launch
  W->>A: POST /experiments {name, suite_id, task_ids, baseline, candidates,<br/>repetitions, concurrency, spend_ceiling, expected_config_hashes}
  A->>NL: is Nous connected? (and key providers set?)
  alt a provider is not connected
    A-->>W: 409 'Nous Portal is not connected'
  end
  A->>DB: the chosen versions' MCP variables against the live worker's and egress's env names
  alt a variable is not set where it is read
    A-->>W: 409 naming each variable with its server, nothing written
  end
  A->>DB: BEGIN
  A->>DB: freeze baseline + candidate versions (UPDATE ... SET frozen_at = now() WHERE frozen_at IS NULL)
  A->>DB: SELECT config_hash FOR SHARE, compare with expected_config_hashes
  alt a configuration changed since the form loaded
    A->>DB: ROLLBACK
    A-->>W: 409 listing the changed configurations
  end
  A->>DB: Hermes version + revision from live workers (409 if none or they disagree)
  A->>DB: snapshot the price table
  A->>DB: INSERT experiment (launch trigger: frozen versions, valid tasks of this suite version)
  A->>DB: INSERT tasks x versions x repetitions runs, all queued (12 x 2 x 5 = 120)
  A->>Q: send one execute-run job per run, key runId:1, trigger initial
  A->>DB: COMMIT (rows and jobs together, or nothing)
  A-->>W: experiment id
  W->>W: go to the Overview tab, open the SSE stream
```

If the response is a 409, the form keeps everything entered and shows the reason where the panel's error sits ("Launch refused… POST /api/experiments → 409").

**MCP variables that are not set** (Phase 6). `GET /experiments/new-options` gives each configuration its `missingSecrets`: every variable its MCP server versions name that is not set where it is read, a stdio env name in the live worker's environment, an http header variable in egress's. The row carries one amber tag per variable ("INVOICE_DB_URL not set · invoice-db", the full sentence on hover). Choosing such a configuration adds a blocker with the reason ("with-mcp: INVOICE_DB_URL (invoice-db, read by the worker) is not set.", or "… (vendor-directory, added by egress) …" for an http header), the hint "Set each in .env, then recreate the worker (stdio) or egress (http) so it reads them.", the command (`docker compose up -d worker`, `egress`, or both), **Check again**, which reloads the options, and **Open Secrets**; Launch is disabled with the same reason. While no worker is live, the tags and these blockers are hidden: the no-worker blocker explains. If the state changed after the form loaded, `POST /experiments` answers 409 `MissingSecretsConflict`, one issue per variable on the field that chose its configuration (`baselineVersionId`, `candidateVersionIds.<i>`), and writes nothing; the form shows "Launch refused: an MCP server's variables are not set." and reloads the options. The Skills column reads "1 · on demand" for a configuration whose skills load on demand.

### 11.3 Duplicate, and running on a newer suite version

Experiments never change: they stay pinned to the suite version they ran. To run on edited tasks, the user duplicates.

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web
  participant A as API
  participant DB as DB

  W->>A: GET /experiments/:id (completed, ran on invoices-v1 v4)
  A->>DB: experiment + its suite + suite_sources current pointer
  A-->>W: suite v4, newer version v5 exists, 1 task changed (total_due)
  W->>W: snapshot strip notice: 'A newer version of invoices-v1 exists (v5)...' + Duplicate on v5
  U->>W: Duplicate on v5
  W->>A: POST /experiments/:id/duplicate
  A->>DB: map each task key to the current version: same, changed, removed, now invalid
  A-->>W: prefilled draft on v5 + the differences
  W->>W: New experiment form with the notice:<br/>'Duplicated from Skill vs no skill (suite v4). Now using v5. Changed since then: total_due...'<br/>removed or invalid tasks listed and left out with their reason
  U->>W: Launch (section 11.2)
```

---

## 12. What happens to one run: execution

Status: **Built and proven live** (Phase 2): the `execute-run` handler around the trial runner (claim, admission, leases and heartbeat, the cancel watcher, event batching into `run_events`, artifact collection, recovery), run on the Compose stack with real Hermes and the scripted mock model (`docs/phases/phase-2.md` section 6); home seeds copied in, the memory files collected, skill loading and the background review's intervals (Phase 6, proven live; `docs/phases/phase-6.md` section 5.4).

The user sees none of this directly. They see a run go `queued → running → executed`, its events stream into the inspector, and the counters move. This section is what happens underneath.

### 12.1 Claim and admission

```mermaid
sequenceDiagram
  autonumber
  participant Q as Queue
  participant WK as Worker
  participant DB as DB
  participant NL as NousLogin

  Q->>WK: execute-run {runId, attempt n, trigger}, singleton key runId:n
  WK->>DB: BEGIN, lock the experiment row
  alt experiment paused, failed or cancelled
    WK->>Q: complete the job, do nothing (resume re-sends it)
  end
  WK->>DB: lock the run
  alt run not queued, or attempt_count is not n-1
    WK->>Q: stale or duplicate job: complete it, do nothing
  end
  WK->>DB: count this experiment's running runs
  alt at or above the experiment's concurrency
    WK->>Q: deferJob: complete this job + send a copy starting in 5 to 15 s (one transaction)
  end
  WK->>DB: sum priced attempt costs (spend guard)
  alt at or above the spend ceiling
    WK->>DB: pause experiment, pause_reason spend_ceiling
  end
  WK->>NL: provider guard: is the configuration's provider connected? (no network call)
  alt not connected
    WK->>Q: deferJob, no attempt spent
    WK->>DB: pause experiment, pause_reason provider_disconnected
  end
  WK->>DB: INSERT attempt n: running, lease_token, lease_expires_at now+60 s, sandbox host
  WK->>DB: UPDATE run: running, current attempt
  WK->>DB: COMMIT
```

From here on, every write to the attempt is fenced: `WHERE id = $a AND lease_token = $t AND status = 'running' AND lease_revoked_at IS NULL`. Zero rows means the lease is lost: stop the container and give up.

### 12.2 The trial

```mermaid
sequenceDiagram
  autonumber
  participant WK as Worker
  participant V as Trials volume
  participant E as Egress
  participant G as Guard
  participant T as Trial (Hermes)
  participant P as Provider (via egress)
  participant DB as DB

  WK->>V: create trials/<attempt>/home and /workspace (fresh, lstat-checked)
  WK->>V: copy fixtures (hash re-checked) to workspace, documents to workspace/docs
  WK->>V: copy skills to home/skills/<name>, write home/.no-bundled-skills
  WK->>V: copy the task's home seeds to home/memories/ (hash re-checked), in every arm
  WK->>V: write home/task.txt (the prompt) and home/config.yaml<br/>(no key · stdio MCP env as ${NAME} · http MCP url = egress:8080/mcp/<name><br/>· memory and skills review intervals 10 and 10)
  WK->>DB: write the launch record: argv (-s per skill, or none on demand), container spec,<br/>config.yaml, inputs + hashes (home seeds included), skill loading, Hermes revision
  WK->>E: register attempt: token, provider, model, max tokens, expiry,<br/>http MCP routes, public mode if web toolsets
  WK->>G: POST /containers/create (trial spec, plus stdio MCP env values)
  G->>G: validate every field, pin the image by id
  WK->>G: start, then wait (registered before start)
  Note over WK: stop conditions armed now, before reading output:<br/>deadline (budget + grace), cancel, disk watchdog (2 GiB / 50,000 files, polled each second)
  WK->>G: follow logs (stdout, stderr)
  loop the agent works
    T->>E: model call with the attempt token (OpenAI-compatible)
    E->>E: token valid? model allowed? token budget left?
    E->>P: forward with the real credential (or to nous-proxy)
    P-->>E: completion (usage counted for this attempt)
    E-->>T: completion
    T->>T: tool calls run inside the container (terminal, file, MCP stdio)
    opt http MCP tool call
      T->>E: POST egress:8080/mcp/<name> with the attempt token
      E->>E: add the definition's headers, forward to its exact URL, log the call
    end
    T-->>WK: stream-json lines on stdout
    WK->>DB: run_events in batches of 50 or every 500 ms, gap-free seq (fenced on the lease)
    WK->>DB: heartbeat every 10 s renews the lease
  end
  T-->>WK: result event (final text, tokens), container exits
  WK->>G: remove the container
  WK->>E: remove the attempt: token dies, returns usage + connection log
  WK->>DB: connection log rows as platform events (allowed, refused, Hermes background call)
  WK->>V: walk workspace with lstat, never follow links, read with O_NOFOLLOW
  WK->>DB: blobs for new files, artifacts rows labelled fixture/document unchanged or modified, or agent
  WK->>V: then home/memories/ only, the same safe walk, with what is left of the budget<br/>skipping the memory tool's empty .lock files
  WK->>DB: artifacts with root home, labelled home seed unchanged or modified, or agent
  WK->>DB: BEGIN: final platform events, finish the attempt (classified)
  WK->>DB: if executed: run executed, INSERT evaluation generation 1, send evaluate-run
  WK->>DB: COMMIT
  WK->>V: delete home, keep workspace for TRIAL_RETENTION_DAYS
```

Why each piece is there:

- **A container per trial.** Hermes runs its agent loop in a detached gateway daemon, so killing a process does not stop a run, and it can read any absolute path. A container bounds its files, network and processes, and stopping it ends everything.
- **The attempt token.** The trial never holds a provider credential. It holds a token that is valid only from its slot network, for one model, until the attempt ends. The only secrets it holds are its stdio MCP servers' env values (section 9.4).
- **The safe reader.** The agent controls every file name, link and file type in its workspace and its home. The worker never follows a link and never opens a FIFO or device; of the home it reads `memories/` alone, and a `memories/` that is a link is listed, never followed.
- **Seeds in every arm.** With memory off Hermes builds no memory store and injects nothing, so the same seed in both arms isolates `memory_enabled`.
- **The answer** is always the `result` event's text, never the streamed pieces joined back together: Hermes can drop a newline-only delta.

### 12.3 How the attempt ends

```mermaid
flowchart TD
  X["Container exited or was stopped"] --> R{"result event?"}
  R -- "exit 0, text" --> EX["executed"]
  R -- "exit 1, partial (max turns)" --> EX
  R -- "error: the model gateway's token-cap 402" --> LI["execution_error · limit<br/>(never retried automatically)"]
  R -- "error: auth, 401, 403, 429, 5xx, connection" --> PV["execution_error · provider"]
  R -- none --> W{"Why did it stop?"}
  W -- "deadline: SIGTERM, SIGKILL after 10 s" --> TO["execution_error · timeout<br/>(platform result event synthesised)"]
  W -- "cancel requested" --> CA["cancelled"]
  W -- "disk cap passed" --> DK["execution_error · other (names the cap)"]
  W -- "OOM killed" --> OM["execution_error · other"]
  W -- "failed to start, Hermes failed before init,<br/>MCP server failed, exit 3 'input required'" --> SE["execution_error · setup"]
  W -- "anything else" --> OT["execution_error · other"]

  EX --> EV["run executed, evaluation queued (section 13)"]
  PV --> AR{"First attempt?"}
  TO --> AR
  AR -- yes --> RQ["automatic retry: attempt 2, 30 s later"]
  AR -- no --> FE["run stays execution_error, user may retry (up to 5 attempts)"]
  SE --> FE
  LI --> FE
  DK --> FE
  OM --> FE
  OT --> FE
  CA --> RC["reconcile"]
  FE --> CB["consecutive_execution_errors + 1<br/>at 14 the experiment fails (circuit breaker)"]
  FE --> RC
```

### 12.4 Recovery: a worker dies mid-run

```mermaid
sequenceDiagram
  autonumber
  participant WK2 as Any live worker
  participant DB as DB
  participant G as Guard
  participant Q as Queue

  loop at boot and every 15 s (one pass at a time, advisory lock)
    WK2->>DB: revoke leases that expired, whose worker stopped,<br/>or past deadline + 120 s
    WK2->>G: list containers labelled with that attempt (same Docker daemon only)
    WK2->>G: stop, wait, confirm not running, remove, list again until empty
    WK2->>DB: BEGIN (experiment, run, attempt locks)
    WK2->>DB: attempt execution_error · worker_lost (or cancelled if cancel was requested)
    WK2->>DB: requeue the run with the next attempt if under 3 recovery attempts
    WK2->>Q: send execute-run runId:n+1
    WK2->>DB: reconcile, COMMIT
    WK2->>G: sweep: remove trial containers whose attempt is not running
    WK2->>Q: re-send execute-run for queued runs and evaluate-run for expired claims<br/>(exclusive keys make these no-ops when the job exists)
  end
```

A missing heartbeat alone never proves the trial stopped. A replacement starts only after a worker on the same Docker daemon has confirmed the old container is gone.

---

## 13. What happens to one run: scoring

Status: **Built**: answer extraction, the `numeric_tolerance`, `json_match`, `exact_match`, `file_check` and `verifier_script` scorers (Phase 1); the `evaluate-run` handler with claim, publish and the dead letter (Phase 2); `text_match`, `trajectory_match`, `llm_judge` with its judge path through egress, the claim renewed after each key, and re-score (Phase 3; `docs/phases/phase-3.md`); verdict entries appended by reconcile (Phase 4; `docs/phases/phase-4.md`); `file_check` on the home's memory files (`root: home`) and `--home` for every verifier (Phase 6; `docs/phases/phase-6.md`).

Scoring is separate from execution, so a scorer bug is fixed by re-scoring. Hermes is never run again for it.

```mermaid
sequenceDiagram
  autonumber
  participant Q as Queue
  participant WK as Worker
  participant DB as DB
  participant B as Blob store
  participant E as Egress admin socket
  participant J as Judge model (via its provider)

  Q->>WK: evaluate-run {evaluationId}
  WK->>DB: claim: UPDATE evaluations SET running, new claim_token, expires in 10 min<br/>WHERE status queued or running
  alt zero rows
    WK->>Q: already finished: complete the job
  end
  WK->>DB: read attempt final_text, the task's prompt, reference and verification list,<br/>artifacts, rubric files, the experiment's frozen prices
  WK->>WK: extract the answer: last fenced json block, parse, keep start/end offsets
  loop each verification key of the task
    alt numeric_tolerance, json_match, exact_match
      WK->>WK: compare the answer (at its path) with the reference
    else text_match
      WK->>WK: look for the phrases and the pattern in the answer (at its path), 1 s per match
    else trajectory_match
      WK->>DB: tool_use/tool_result events: count the matching calls, or match the trajectory
    else file_check
      WK->>B: read the artifact of its root (workspace, or home with root home) by hash,<br/>check format, columns, rows, schema
    else verifier_script
      WK->>B: materialise verifier files, the workspace and the home files into a temp dir
      WK->>WK: python3 verify/check.py --answer tmp.json --workspace dir --home dir (30 s, outside any trial)
    else llm_judge
      WK->>E: register one judge call (the judge model only, minutes), then the chat completion
      E->>J: rubric, task and reference as facts, agent text as untrusted data,<br/>temperature 0, at most 4,096 tokens, egress's credential added
      J-->>E: score 0 to 1 and a comment
      E-->>WK: the answer and the tokens egress metered, then the registration is removed
    end
    WK->>DB: renew the claim (10 min again) while the token still matches, otherwise stop and drop the work
  end
  WK->>DB: BEGIN, lock experiment then run
  WK->>DB: re-read the evaluation FOR UPDATE with the claim token (zero rows: someone newer owns it, roll back)
  WK->>DB: insert every score, supersede the previous evaluation, complete this one
  WK->>DB: run scored, results_revision goes up (trigger)
  WK->>DB: reconcile the experiment
  WK->>DB: COMMIT
```

The judge is the platform's, not the run's: a check's own `model:`, else `JUDGE_MODEL`, on `JUDGE_PROVIDER` (`nous` when unset). Launch and Re-score answer 409 for a task whose `llm_judge` key has no judge model, with the fix in the message; a key that still has none at scoring time is `error`, never a zero. Each judge call's status and latency are kept in the score's evidence. Its tokens and cost are stored in the score's evidence as grading cost, outside the spend guard.

What each outcome means, kept apart everywhere in the UI:

| Status            | Meaning                                            | Example                                    |
| ----------------- | -------------------------------------------------- | ------------------------------------------ |
| `passed`          | the agent was right                                | total within ±0.01                         |
| `failed`          | the agent was wrong                                | total off by 1,500                         |
| `ungradable`      | nothing could be extracted                         | no fenced JSON block in the final response |
| `error`           | the check itself broke                             | verifier printed no result line            |
| `execution_error` | (a run status, not a score) no answer was produced | timeout, provider down                     |

**Re-score** (`POST /runs/:id/rescore`, or the bulk bar): inserts an evaluation with the next generation and sends `evaluate-run`, in one transaction. Only a `scored` run can be re-scored (409 "run is …, not scored"), and a task with an `llm_judge` key needs a judge model (409 "Re-score needs a judge model for the method judge: …") and the judge's provider ready (409 "Re-score needs Nous Portal for the method judge: …"). The run stays `scored`, and its previous result stays current, until the new generation publishes; the inspector and the Runs tab show the pending re-score. Only one evaluation per run can be queued or running, so double clicks collapse: a second request answers the pending one (`joinedPending`). A re-score grades the experiment's frozen task with the scorers as they are now in code, and the judge settings of the moment. If the experiment was completed, publishing raises the results revision, and reconcile appends a verdict entry per candidate with cause `rescore` (section 13.1).

**When a scoring job dies for good**: for a first evaluation, one `error` score per key is published, so the run still reaches `scored`. A failed re-score leaves the previous result current.

### 13.1 Reconcile: when is an experiment done?

Status: **Built** (Phase 2: completion; Phase 4: the verdict entries; `docs/phases/phase-4.md` section 3.8).

```mermaid
flowchart TD
  T["Any transaction that finishes a run:<br/>scores published, final execution error,<br/>cancellation, recovery, or the 15 s safety pass"] --> L["Lock the experiment row"]
  L --> F{"failed?"}
  F -- yes --> FAIL["Return: Retry failed runs reopens it"]
  F -- no --> U{"verdict_revision different from results_revision?"}
  U -- no --> SAME["Already recorded: return"]
  U -- yes --> S{"Any run queued, running, executed or scoring,<br/>or any evaluation queued or running?"}
  S -- yes --> STOP["Not settled: return"]
  S -- no --> CA{"Cause"}
  CA -- "history empty" --> I["initial"]
  CA -- "completed, results moved" --> RS["rescore, note: N runs re-scored"]
  CA -- "a retry reopened it" --> RT["retry, note: N retries"]
  I --> V["One verdict entry per candidate on the primary key,<br/>final statistics from the results under the lock"]
  RS --> V
  RT --> V
  V --> C["Conditional update: append to verdict_history,<br/>verdict_revision = results_revision,<br/>and status completed with finished_at unless already completed"]
```

Two workers finishing the last two runs at the same moment append the verdict once: the second waits for the row, then finds the revisions equal, and the append is in the same statement as the move of `verdict_revision`. An entry records the cause, a note ("1 retry", "2 runs re-scored"), Δ, the interval, the verdict or why there is none, the pass rates and counts, the task counts, the method and the results revision it was computed from. A failed experiment gets no entry until a retry reopens it and it settles; an experiment reopened by a retry and then settled by a cancel gets cause `retry`.

---

## 14. Experiment list and overview, live

Status: **Built** in the web app against the API (Phase 5; `docs/phases/phase-5.md`): the list, polled while anything runs, and the Overview, live from the experiment's SSE stream; and in the API: the list, the detail and the SSE stream (Phase 2), and the verdicts read from the verdict history, with the SSE `experiment` event's `verdicts` and `verdictUpdatedAt` (Phase 4).

### 14.1 Experiment list

`GET /experiments` returns one row per experiment, newest first: name, status chip, suite and version, configurations, runs done of total, cost, and once completed one verdict chip per candidate, from its last verdict history entry (Δ and interval included). A running, paused or failed experiment has no chip; the SSE `experiment` event carries the same `verdicts`. A verdict that is `not_computable` carries its `reason`, so the chip says why ("No interval (1 rep)"). The web polls `GET /experiments` every 5 s while anything runs and patches the rows in place (Phase 5). A failed experiment shows its failure reason in the row. Clicking a row opens the Overview tab.

### 14.2 Overview while running

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (Overview)
  participant A as API
  participant DB as DB

  U->>W: opens an experiment
  W->>A: GET /experiments/:id
  A->>DB: experiment, frozen snapshot (suite version, configurations, Hermes revision, prices),<br/>run counts by status, per-configuration progress, spend, last 10 events, verdicts
  A-->>W: header, snapshot strip, progress breakdown, feed
  W->>A: GET /experiments/:id/events (SSE)
  loop shared poller per experiment, every 1 s
    A->>DB: run status changes (with generation and pending re-score), scores landed,<br/>counts, experiment status and verdicts since last poll
    A-->>W: events
    W->>W: patch records in place (rows never reorder while live)
  end
  Note over W,A: connection lost: reconnect after 1, 2, 5, 10 s.<br/>LiveIndicator shows reconnecting, then offline with Retry
```

What the overview shows, and where each number comes from:

| On screen                                            | Source                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "87 of 120 scored · 28 queued · 3 running · 1 error" | run counts by status                                                                                                                                          |
| Per-configuration bars, provisional pass rate        | passed / scored per configuration so far                                                                                                                      |
| Spend "$0.71 of $2.00 ceiling · projected $1.69"     | sum of priced attempt costs, estimate for the rest                                                                                                            |
| Feed                                                 | the last 10 run transitions and scores                                                                                                                        |
| Snapshot strip                                       | what the experiment froze at launch: suite + version, configuration versions, Hermes revision                                                                 |
| VerdictCard (complete)                               | each candidate's last `verdict_history` entry; the entries before it, with their cause and note, give "Updated … · previously …"                              |
| VerdictCard (running)                                | the provisional figures so far, computed as the comparison computes them; `not_computable` at once with one repetition, fewer than 3 tasks, or nothing scored |
| No-worker banner                                     | no worker heartbeat for 60 s while runs are queued                                                                                                            |
| Paused banners                                       | `pause_reason`: user, spend_ceiling, provider_disconnected                                                                                                    |
| Failed banner                                        | the circuit breaker's structured failure: category, message, first stderr line, attempt                                                                       |

---

## 15. Experiment controls

Status: **Built**: the endpoints and their guards (pause, resume, cancel, retry failed, duplicate, the spend guard and the circuit breaker; Phase 2); the buttons against the real API, with `ExperimentDetail.cancelledAt` so a cancelling experiment offers neither Pause nor Cancel (Phase 5).

Every control is one transaction that locks the experiment row first.

```mermaid
flowchart TD
  subgraph user["User actions"]
    PA["Pause"]
    RE["Resume"]
    CN["Cancel (ConfirmInline)"]
    RF["Retry failed runs<br/>(failed experiment)"]
    RR["Retry a run<br/>(inspector or bulk)"]
    DU["Duplicate"]
  end

  PA --> PA1["status paused, pause_reason user.<br/>Workers that claim its jobs complete them without starting anything.<br/>In-flight trials finish."]
  RE --> RE0{"Paused for the spend ceiling?"}
  RE0 -- yes --> RE1["needs a higher ceiling"]
  RE0 -- "provider_disconnected" --> RE2["needs the provider connected<br/>(else disabled through BlockedReason)"]
  RE0 -- user --> RE3["status running"]
  RE1 --> RE3
  RE2 --> RE3
  RE3 --> RE4["send execute-run for every queued run,<br/>key runId:attempt_count+1 (no-op if still waiting)"]
  CN --> CN1["cancelled_at set. Queued runs cancelled, their jobs cancelled.<br/>Running runs get cancel_requested_at:<br/>the owning worker stops the container, attempt cancelled.<br/>Executed and scoring runs finish scoring.<br/>Reconcile completes it when nothing is in flight."]
  RF --> RF1["status running, failure cleared,<br/>queued runs re-sent like resume"]
  RR --> RR1{"execution_error and fewer than 5 attempts?"}
  RR1 -- yes --> RR2["run queued, execute-run with the next attempt.<br/>A completed experiment goes back to running."]
  RR1 -- no --> RR3["refused with the reason"]
  DU --> DU1["prefilled New experiment on the suite's current version (section 11.3)"]
```

The two automatic guards, which the user only sees as a paused experiment:

```mermaid
sequenceDiagram
  autonumber
  participant WK as Worker (claim)
  participant DB as DB
  participant NL as NousLogin
  participant W as Web (Overview)
  participant U as User

  WK->>DB: priced spend >= ceiling?
  WK->>DB: yes: pause, pause_reason spend_ceiling
  WK->>NL: Nous connected?
  NL-->>WK: not_connected
  WK->>DB: defer the job (no attempt spent), pause, pause_reason provider_disconnected
  DB-->>W: SSE: experiment paused
  W->>U: 'Paused at 15:08: Nous Portal is not connected. In-flight runs finished.'<br/>Reconnect (primary) · Resume (disabled)
  U->>W: Reconnect, approves (section 6)
  W->>W: ConnectDialog offers Resume experiment
  U->>W: Resume
  Note over W,DB: POST /experiments/:id/resume: the API sets running<br/>and re-sends execute-run for every queued run
```

A login that lapses during a trial fails that attempt as `execution_error · provider`. It is retried once automatically after Resume.

---

## 16. Comparison tab

Status: **Built** in the web app against the API (Phase 5; `docs/phases/phase-5.md`), and its contract (`ComparisonViewSchema`); the statistics module, the endpoint and its cache in the API (Phase 4; `docs/phases/phase-4.md` sections 3.3 to 3.7), with the gate's `too_few_tasks` and a failed experiment's provisional comparison (Phase 5).

The comparison answers "is the candidate better than the baseline, and how sure are we?", and links every number to the runs beneath it.

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (Comparison)
  participant A as API
  participant C as Cache
  participant DB as DB

  U->>W: opens Comparison (candidate, score key, filter in the URL)
  W->>A: GET /experiments/:id/comparison?candidate=&key=primary&filter=all
  A->>DB: BEGIN REPEATABLE READ READ ONLY, the experiment row first:<br/>results_revision, status, repetitions, tasks, configurations
  A->>A: 404 unknown experiment, 400 a candidate it does not test
  A->>DB: configuration names, in the same snapshot
  A->>C: (experiment, candidate, key, filter, results_revision, status, names) cached?
  alt cache hit
    C-->>A: response
  else miss
    A->>DB: tasks and their keys, runs with current attempts, attempt costs, current scores
    A->>A: 400 if a selected task lacks the key
    A->>A: counted runs (scored or execution_error) per task and configuration, the key's status per run
    A->>A: pass rate per task per configuration = passed / counted
    A->>A: observed difference = mean over tasks of (candidate - baseline)
    A->>A: bootstrap: resample tasks 10,000 times (mulberry32 seeded from the experiment id),<br/>2.5th and 97.5th percentiles
    A->>A: verdict better (lo > 0), worse (hi < 0), else inconclusive,<br/>provisional while running, paused or failed
    A->>A: sensitivity: same difference and interval without execution errors, error and ungradable scores
    A->>A: secondary: median duration, mean tokens, cost, error and ungradable counts
    A->>C: store
  end
  A-->>W: task grid rows with cells, rates and deltas, statistics, secondary, sensitivity
  W->>W: IntervalBar, TaskGrid with RepetitionCells, filter counts
  U->>W: clicks a cell
  W->>W: open the run inspector for that run (route runs/:runId or ?run=)
```

States the tab handles:

```mermaid
flowchart TD
  G{"At least 3 tasks, each with at least 2 counted runs<br/>per configuration?"} -- no --> NC["Statistics not computable, with the reason, in this order:<br/>single_repetition, too_few_tasks, nothing_scored, not_enough_runs"]
  G -- yes --> RUN{"Experiment running, paused or failed?"}
  RUN -- yes --> PV["Provisional: verdict chip provisional,<br/>unscored cells queued or running"]
  RUN -- no --> FIN["Final verdict"]
  F["Filter: improved / regressed / unchanged"] --> E{"Rows left?"}
  E -- no --> EM["Empty state"]
```

Because `results_revision` moves on every run status change and every published or superseded score set, a retry, cancellation, execution error or re-score can never serve a stale comparison. The status is in the cache key because completing, pausing or resuming moves no run but turns provisional into final, and the configuration names because a rename moves no run. `single_repetition` applies whatever has run; `nothing_scored` means no run of the two configurations counts yet (an execution error counts); a cell's tooltip is always the primary score's comment, while its colour follows the selected key; the candidate select's chips are the verdicts on the primary key. A failed experiment's comparison is provisional, as its Overview card is, since Retry failed runs can resume it (`docs/phases/phase-4.md` question 5, built in Phase 5). With fewer than 3 tasks there is no interval (`too_few_tasks`), even while running: the interval resamples tasks, and with fewer it cannot say how sure the difference is.

---

## 17. Runs tab

Status: **Built** in the web app against the API, its rows patched in place by the SSE `run` events (Phase 5), and `GET /experiments/:id/runs` with its filters and bulk retry (Phase 2), and bulk re-score with each row's `generation` and `rescorePending` (Phase 3), which the SSE `run` event now carries too, so a live tab shows a re-score queued and published (Phase 4).

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (Runs)
  participant A as API
  participant DB as DB
  participant Q as Queue

  U->>W: filters (configuration, task, status, score status, execution errors, ungradable), sort
  W->>W: mirror filters and sort into the URL
  W->>A: GET /experiments/:id/runs?config=&task=&status=&...&sort=
  A->>DB: runs with current attempt and current evaluation, 200 per page
  A-->>W: rows + count summary (passed, failed, error, ungradable, execution errors)
  U->>W: selects rows, Re-score or Retry in the bulk bar
  alt a selected run needs a provider that is not connected
    W->>W: bulk action disabled through BlockedReason + Connect
  else
    W->>A: POST /experiments/:id/runs/rescore (or /retry) {runIds}
    A->>DB: per run: new evaluation generation (only scored, or join the pending one),<br/>or next attempt (only execution_error, under 5 attempts)
    A->>Q: evaluate-run or execute-run per accepted run (same transaction)
    A-->>W: enqueued N, refused [{runId, reason}], and for a re-score each run's evaluation
    W->>W: refused ones listed in a banner, accepted rows go queued, then running, live
  end
  U->>W: clicks a row
  W->>W: open the run inspector, J/K moves through this filtered, sorted list
```

---

## 18. Run inspector

Status: **Built** in the web app against the API, polling the run while it is live (Phase 5), and in the API: `GET /runs/:id`, its events, artifact content and preview, retry and cancel (Phase 2), and re-score, the run's `evaluation` (current generation, pending re-score, last failure) and the structured `network` field of every network row (Phase 3); the Memory group of home artifacts and the launch record's skill loading, home seeds and background review (Phase 6; `docs/phases/phase-6.md`).

A right-hand drawer over the experiment, 75% of the window, with its own route (`/experiments/:id/runs/:runId`, or `?run=` from the comparison). Esc closes it back to where it was opened.

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (RunInspectorDrawer)
  participant A as API
  participant DB as DB
  participant B as Blob store

  U->>W: opens a run
  W->>A: GET /runs/:id
  A->>DB: run, attempts, current evaluation and scores, final text and extraction offsets,<br/>launch record, execution error and stderr tail
  A-->>W: header (task + version, configuration, repetition, attempt k of n), outcome, scores
  W->>A: GET /runs/:id/events?after=0
  A->>DB: run_events by seq (paged)
  A-->>W: timeline: text, tool calls with input/output, network rows, platform events
  W->>A: GET /runs/:id/artifacts
  A-->>W: files with root and origin (fixture or document unchanged/modified, home seed<br/>unchanged/modified, agent), size, hash
  U->>W: Preview summary.csv
  W->>A: GET /runs/:id/artifacts/:artifactId/content
  A->>B: blob by hash
  A-->>W: content (CSV and text previews)
  U->>W: A/B: same task, other configuration
  W->>A: GET /runs/:id/counterpart?version=
  A-->>W: matching run (same task, repetition), or why there is none
  opt run still running
    loop until finished
      W->>A: GET /runs/:id/events?after=<last seq>
      A-->>W: new events, 'Jump to latest'
    end
  end
```

The five sections and what each proves:

| Section        | Shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | From                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Outcome        | run status, each score key with expected vs observed and comment, or the execution error banner with category and stderr tail                                                                                                                                                                                                                                                                                                                                                                                                                                      | `scores`, `attempts`                        |
| Timeline       | every event in order with a scrubber: model text, tool calls, network rows (allowed, refused by sandbox, Hermes background call)                                                                                                                                                                                                                                                                                                                                                                                                                                   | `run_events`                                |
| Final response | the recorded final text with the extracted JSON block highlighted, the parsed value, and the reference beside it                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `attempts.final_text`, `evaluations.answer` |
| Artifacts      | what the agent left in the workspace, labelled by origin, with previews; then a **Memory** group for the home's `memories/` (`home/memories/USER.md` · home seed · modified, or written by agent), shown when the run has home files, a changed file's preview open; the memory tool's empty `*.lock` files are not collected (Phase 6b)                                                                                                                                                                                                                           | `artifacts`, blobs                          |
| Launch record  | the container (image + digest, mounts, network, limits), the exact Hermes command, `config.yaml`, inputs with hashes; each MCP secret as `<from env NAME>` with its exposure; **Skill loading** (when the run had skills: preload with `-s`, or on demand through the `skills` toolset), **Home seeds** (each `memories/X.md → /opt/data/memories/X.md` with its hash, or that `memories/` started empty) and **Background review** (`memory.nudge_interval` and `skills.creation_nudge_interval`, written the same in every run; a one-shot run starts no review) | `attempts.launch_record`                    |

Actions in the drawer:

| Action      | Call                        | Allowed when                                                                                                      |
| ----------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Re-score    | `POST /runs/:id/rescore`    | run scored; the judge's provider ready if an `llm_judge` key resolves a judge model; a pending re-score is joined |
| Retry       | `POST /runs/:id/retry`      | run execution_error, under 5 attempts, provider connected                                                         |
| Cancel      | `POST /runs/:id/cancel`     | run queued or running                                                                                             |
| Prev / Next | none (J / K)                | moves through the list the drawer was opened from                                                                 |
| A/B         | `GET /runs/:id/counterpart` | a run of the same task and repetition exists in the other configuration                                           |

---

## 19. Open points found while writing this

Each of these needs a decision or a fix before the matching code is written.

| #   | Where               | Point                                                                                                                                                                                                                                                                                                                                                                             | Suggested resolution                                                                                                                           |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | MCP secrets         | **Resolved 24 Oct 2026.** stdio env values are set in the trial's container environment and are readable by the agent; http header values are added by egress through an MCP gateway and never enter the run. Plan sections 1, 2, 5.3, 5.4, 8.2, 13, 14 and 15 and the design canvas now agree (section 9.4).                                                                     | Done. Follow-ups are points 14 to 16.                                                                                                          |
| 2   | Sandbox status      | **Resolved in Phase 1.** The last self-test report is stored on the `workers` row (`sandbox`, migration 0002) and served by `GET /system/sandbox`; each worker in `GET /system/summary` and `GET /system/workers` carries `sandboxProven` (docs/phases/phase-1.md section 2.3).                                                                                                   | Done.                                                                                                                                          |
| 3   | API surface         | **Resolved.** Phase 1 built its own routes (`GET /system/sandbox`, `GET /system/workers`, `GET /configurations/form-options`, `GET /configurations/:id/draft`, `GET /resources/counts`, `POST /resources/mcp-servers/test` and the fixture `preview` route); Phase 2 built `GET /experiments/new-options` and the artifact preview route. All are in Swagger and plan section 11. | Done (`docs/phases/phase-2.md` section 2.3).                                                                                                   |
| 4   | Banner on Resources | **Resolved in Phase 5**, as suggested: the banner shows on Resources and is hidden on Suites only. Before, the web shell hid it on Suites and Resources (designer note), while the plan and the design brief exempt only Suites.                                                                                                                                                  | Done (`docs/phases/phase-5.md` section 2.5).                                                                                                   |
| 5   | Pause reason        | **Resolved in Phase 2.** `provider_disconnected` is in migration 0004 and `packages/shared`.                                                                                                                                                                                                                                                                                      | Done (`docs/phases/phase-2.md` section 2.3).                                                                                                   |
| 6   | Network events      | **Resolved in Phase 2.** Subtype `network`, with a defined payload (kind, decision, background, and host, port, reason, status, ms, model, server, method and tokens where known).                                                                                                                                                                                                | Done (`docs/phases/phase-2.md` section 2.3).                                                                                                   |
| 7   | Host login status   | **Resolved in Phase 2**, as suggested: egress's admin `/health` reports the host forward, the worker records `workers.host_proxy`, and `GET /providers` reports `host` or `host_unreachable`.                                                                                                                                                                                     | Done (`docs/phases/phase-2.md` section 2.3).                                                                                                   |
| 8   | Load-time verifiers | **Resolved in Phase 1** (decision D1). The loader runs in the worker as the `load-suites` job, and at worker start. `POST /suites/reload` sends the job and waits for its result. The API no longer mounts `./suites` (section 8.1).                                                                                                                                              | Done. Verifiers still run with the worker's privileges, by design for a single trusted user (docs/phases/phase-1.md section 7.2).              |
| 9   | Live updates        | **Resolved in Phase 2** on the API side: SSE for `/system/events` and `/experiments/:id/events`; the list and the inspector poll. The polling is built in Phase 5: the list every 5 s while anything runs, the inspector every 1 s while a run is live.                                                                                                                           | Done (`docs/phases/phase-2.md` section 2.3).                                                                                                   |
| 10  | Spend ceiling       | **Resolved in Phase 2.** Launch is allowed over the ceiling; the spend guard pauses at it.                                                                                                                                                                                                                                                                                        | Done (`docs/phases/phase-2.md` section 2.3).                                                                                                   |
| 11  | Launch and sandbox  | **Resolved in Phase 2.** Launch answers 409 when no connected worker has proven sandbox isolation.                                                                                                                                                                                                                                                                                | Done (`docs/phases/phase-2.md` section 2.3).                                                                                                   |
| 12  | Login unavailable   | **Resolved in Phase 2** on the API side: `NOUS_STATUSES` gains `unavailable`. The web chip and text are built in Phase 5.                                                                                                                                                                                                                                                         | Done (`docs/phases/phase-2.md` section 2.3).                                                                                                   |
| 13  | Toolsets source     | **Resolved in Phase 1, differently.** The worker reads the list from `hermes tools list` in the trial image at start (17 toolsets) and stores it on its row. The configuration form reads it from `GET /configurations/form-options`; `GET /system/summary` does not carry it.                                                                                                    | Done.                                                                                                                                          |
| 14  | MCP header mapping  | **Resolved in Phase 1.** `header_names` became `headers`, a jsonb list of `{header, env}` pairs with a CHECK on each element (migration 0002), and `McpHeaderSchema` in `shared`.                                                                                                                                                                                                 | Done.                                                                                                                                          |
| 15  | Secret presence     | **Resolved in Phase 1.** Egress's admin socket answers `GET /env-names` (names only). The worker records both name sets on its row every 10 s, and `GET /resources/secrets` joins them with MCP definitions, including versions a configuration still pins.                                                                                                                       | Done. MCP definitions may not name platform variables or credentials (shared `env-names.ts`).                                                  |
| 16  | Egress allowlist    | **Resolved in Phase 2.** In allowlist mode egress refuses every CONNECT and plain-http request before any DNS lookup.                                                                                                                                                                                                                                                             | Done (`docs/phases/phase-2.md` section 2.3).                                                                                                   |
| 17  | Save refusals       | **Open (Phase 5b).** The web fixtures' `save-failed` scenario, after SA.11's sample, shows a save refused at loading for an unknown key in task.yaml ("unknown key prmary"). The API saves a task with an unknown key as invalid (section 8.6) and refuses a save only for a task.yaml or suite.yaml that does not parse, an unsafe file or a taken name.                         | Change the scenario's example to a task.yaml that does not parse, so fixtures mode shows what the API answers (`docs/phases/phase-5b.md` 6.2). |
