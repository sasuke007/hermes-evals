# Implementation Plan: Hermes Evals Platform

Status: the data layer is implemented (schema, migrations, integrity triggers, queue settings; 44 unit tests on PGlite and 4 on Postgres 17). Container-per-trial isolation (section 8) is confirmed and built: trial image, docker-guard, egress proxy and model gateway, trial runner, and an isolation self-test the worker runs at boot. It is proven live on Colima (section 21). A red-team review attacked the guard, egress and the trial: its four guard findings are fixed and re-verified, egress held, and an interrupted probe of how the worker reads trial output led to the safe reader in section 8.5 and the disk watchdog in section 8.2. Section 23 maps the review concerns to their resolutions. Phases 1 to 4 are built, each with its review document in `docs/phases/` (section 17); Phases 5 to 8 are not.

Sources this plan is checked against: the take-home assignment brief (authoritative; not in this repository), the design canvas (29 artboards, all 16 fixes applied), `DESIGN_AUDIT.md`, the flow page, the Hermes source at v0.22.4 (revision `4d04303`), and the review of the plan (section 23).

---

## 0. What we are building, in one paragraph

A local, single-user benchmarking workbench for Hermes Agent. Tasks are files on disk with hidden reference answers and declared checks. Configurations are records of how the agent is set up. An experiment runs every selected task under every configuration, several times, each run in a fresh Hermes home, and stores the full event stream, output and files. Scorers grade the stored evidence. A paired bootstrap over tasks turns per-run results into a verdict with an interval. The UI makes every number a link to the evidence beneath it.

### Deliverables mapped to the PDF

| PDF asks for                                        | Where it lands                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Define tasks and how they are scored                | `suites/` file format (section 4), suite loader, self-check                       |
| Define configurations: model, skills, memory, tools | Configuration versions (section 6), resources (section 5)                         |
| Run tasks under each configuration                  | Experiment run matrix and worker execution pipeline (sections 7, 8)               |
| Better or not, and how confident                    | Statistics module and comparison views (section 10)                               |
| Inspect a run to see why                            | Run inspector fed by `run_events`, `scores`, `artifacts` (sections 8, 9, 12)      |
| NestJS, Vue 3, TypeScript                           | Done in the skeleton                                                              |
| Single command                                      | `docker compose up --build` (section 15)                                          |
| Sample task set                                     | `suites/invoices-v1`, 12 tasks, and four capability suites, 30 tasks (section 18) |
| Documented assumptions                              | `docs/design.md` and `docs/limits.md` (section 20)                                |
| Production-grade repo with README                   | Already started; sections 13, 14, 16                                              |
| Design document                                     | `docs/design.md`                                                                  |
| Known limits                                        | `docs/limits.md`                                                                  |
| Approximate costs                                   | `docs/costs.md`, computed from recorded tokens and the price table                |
| One real experiment                                 | Section 19                                                                        |
| Video                                               | Section 20                                                                        |

---

## 1. Invariants we design around

These are the rules every module respects. When a later decision conflicts with one, the rule wins. Where the database can enforce a rule, it does (section 3.2), so a bug in one code path cannot break it.

1. **The agent never sees the reference answer, the verification block, or anything outside its own trial.** A trial runs in its own container that mounts only that attempt's home and workspace (section 8). Suites, blobs, other trials, stored evidence, Postgres and the API are outside its filesystem and network view.
2. **A run's evidence is immutable once execution ends.** Events, artifacts and finished attempts cannot be updated or deleted; re-scoring creates a new evaluation and never edits evidence.
3. **Failure kinds never blur.** `failed` means the agent was wrong. `error` means a check broke. `ungradable` means nothing could be extracted. `execution_error` means the run never produced an answer. Each is stored, coloured and counted separately.
4. **Experiments freeze what they test.** The suite row, configuration versions (and through them the skills, documents and MCP definitions), Hermes version and revision, price table and time budget override are fixed at launch. Later edits create new versions.
5. **Every count in the UI is a link one level down.** Verdict to task grid, grid cell to run, run to event. The API shapes its responses so this needs no client-side joins.
6. **The platform, not the user, controls isolation.** Container per trial, toolset allowlist built from the configuration, MCP server names appended automatically, memory off unless the configuration says otherwise, bundled Hermes skills off so both arms differ only where intended.
7. **Secrets are never stored by the platform, and a trial holds only the secrets it cannot work without.** Provider credentials and http MCP header values live in egress (or the nous-proxy login) and never enter a trial; a trial holds a per-attempt token the platform can revoke. A stdio MCP server runs inside the trial, so the values in its environment are readable by the agent, and the UI says so wherever such a value is used (section 5.3). MCP secrets are referenced by name; values live only in `.env`.
8. **Execution and evaluation are separate jobs.** A scoring bug is fixed by re-queuing evaluation; Hermes is never re-run for it.
9. **Only the current owner writes.** An attempt carries a lease; every worker write is fenced on its token, and recovery revokes the lease and confirms the trial container is gone before a replacement starts.

---

## 2. Architecture

Six long-running Compose services, one optional service, a pinned trial image, and one container per trial. One TypeScript codebase.

```
                                    backend network
┌─────────────┐  HTTP+SSE  ┌──────────────┐        ┌──────────────┐
│ web (nginx) │──────────▶ │  api (Nest)  │──┐  ┌──│ worker (Nest)│  no Hermes, no Docker socket
└─────────────┘            └──────────────┘  │  │  └──────┬───────┘
                                             ▼  ▼         │ unix socket (guard volume)
                                       ┌────────────┐     ▼
                                       │ PostgreSQL │  ┌──────────────┐   Docker API (filtered)
                                       │ + pgboss   │  │ docker-guard │──────────────────────┐
                                       └────────────┘  └──────────────┘ network: none        │
                                                                                              ▼
 internal slot network (one per concurrent trial, no route anywhere)       ┌──────────────────────┐
 ┌──────────────────────────────┐   CONNECT / model calls  ┌───────────┐   │ trial container      │
 │ trial: /opt/data (home)      │ ───────────────────────▶ │  egress   │   │ one per attempt,     │
 │        /workspace            │                          │ proxy +   │──▶│ started by the guard │
 └──────────────────────────────┘                          │ model gw  │   └──────────────────────┘
                                                           └─────┬─────┘
                                                                 ▼ edge network
                                                provider API, or nous-proxy (holds the Nous login)
```

Responsibilities:

- **api**: validates and persists everything the user defines, launches experiments (rows and jobs in one transaction), serves reads and SSE, computes statistics with a cache keyed by the experiment's results revision. Never talks to Docker.
- **worker**: claims jobs, prepares each attempt's directory in the `trials` volume from the blob store, asks the guard to start the trial container, streams its stdout into `run_events`, collects outputs after the container is removed, runs scorers outside any trial, renews leases, runs recovery. It holds no provider credential: the LLM judge's calls go through egress's admin socket (section 9.5).
- **docker-guard** (`apps/docker-guard`): the only process with the Docker socket. `network_mode: none`, read-only, all capabilities dropped. Serves a filtered Docker API on a unix socket shared only with the worker: create/start/logs/wait/stop/remove of containers labelled as trials, with a create body validated field by field (pinned image, uid 10000, read-only root, no capabilities, trial volume subpaths and slot networks only, no binds, devices, privileged mode or host namespaces).
- **egress** (`apps/egress`): the only network path out of a trial. An HTTP CONNECT proxy that authenticates each attempt by token, resolves each host once, refuses every private, loopback, link-local, CGNAT and Docker address, and connects to the vetted IP. Also an OpenAI-compatible model gateway: the trial calls it with its attempt token, and egress forwards to the real provider with the real credential and records usage per attempt. And an MCP gateway: an http MCP server is configured in the trial as `http://egress:8080/mcp/<name>`, and egress forwards each request to the definition's URL with the header values added (section 5.3).
- **nous-proxy**: the trial image running `hermes proxy start --provider nous`, holding one Nous Portal OAuth login in its own volume. Reachable only from egress.
- **nous-login**: the same image and volume, running the device login the UI drives (section 6.1). Reachable only from the API, and from the worker for the provider guard's status check (section 7.3).
- **trial image**: `nousresearch/hermes-agent:v0.22.4` pinned by digest, with the s6 entrypoint bypassed and uid 10000. Built once by `docker compose up --build`; every trial starts from it.
- **shared**: zod schemas and vocabularies used by api, worker and web.

Module layout in `apps/api/src`:

```
config/         env schema
database/       schema/*, migrator, migration service, ids
suites/         loader (blobs, self-check, expected workspaces), controller
resources/      skills, documents, mcp-servers, secrets
configurations/ versions, diff, freeze
experiments/    launch, controls, estimates, reconcile, controller, sse
runs/           queries, retry, re-score, inspector payloads
analysis/       statistics, comparison (cached by results_revision), verdicts
scoring/        registry, scorers/*, extraction, verifier runner, judge client, publish
sandbox/        guard client, trial spec builder, trial runner, isolation self-test
worker/         job handlers, claim and admission, leases, recovery, heartbeat
queue/          queue definitions, ensureQueues, deferJob
common/         zod pipe, errors, pagination
```

Module layout in `apps/web/src` is unchanged (section 12).

---

## 3. Data model

Implemented in `apps/api/src/database/schema/*.ts` (19 tables) and `apps/api/drizzle/0000_init.sql` (generated) plus `0001_integrity_triggers.sql` (hand-written triggers and deferrable keys), `0002_phase1_definitions.sql` (version numbers, task YAML, MCP header pairs, worker presence) and `0003_phase1_worker_slots.sql`. Migrations run at boot in both api and worker under an advisory lock (section 15). Tests: `schema.spec.ts`, `integrity.spec.ts` on PGlite, and `postgres.e2e-spec.ts` on Postgres 17.

### 3.1 Tables

| Table                    | One row per                                      | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blobs`                  | stored file, by sha256                           | A row means DATA_DIR/blobs/<sha256> exists. Task files, documents and artifacts reference it by foreign key.                                                                                                                                                                                                                                                               |
| `suite_sources`          | suite directory                                  | Last load outcome and error, pointer to the current suite version (must be a version of this directory).                                                                                                                                                                                                                                                                   |
| `suites`                 | immutable suite version                          | Unique per directory, content hash (suite.yaml and every task file) and check hash (loader and scorer versions plus validity). `version_number` (v1, v2, … per directory, assigned by the loader, unique with the directory) beside the author's `version_label` (section 4.5).                                                                                            |
| `tasks`                  | task of a suite version                          | Prompt, reference (any JSON value), verification list, the verbatim `task.yaml` (`task_yaml`, for diffs), self-check result, load issues, validity. Immutable. `version_number` per directory and task key, which goes up only when that task's own content hash changes, and `introduced_in_suite_id`, the suite version where this content first appeared (section 4.5). |
| `task_files`             | file a task needs                                | Kinds: fixture (copied into the trial's workspace), home_seed (copied into the trial's home, Phase 6), verifier, rubric, expected (hidden known-good workspace), expected_home (hidden known-good home, Phase 6). Immutable.                                                                                                                                               |
| `suite_drafts`           | open draft of a suite folder (planned, Phase 5b) | One per folder, or per new suite name. Base suite version (null for a new suite), version label, description, task order. The only mutable suite data: working state, never evidence, nothing launches from it. Deleted on save or discard (section 4.6).                                                                                                                  |
| `suite_draft_tasks`      | task in a draft (planned, Phase 5b)              | State (added, changed, removed, restored, unchanged), base task, restored-from version, the text files the forms edit stored verbatim (`task.yaml`, `prompt.md`, `reference.json`, rubric), and a file map `{path: {sha256, size, kind}}` into `blobs` for every other file. Last readiness and self-check result.                                                         |
| `skills`                 | uploaded skill version                           | Unique by name and version; stored unpacked under skills/<hash>. Immutable.                                                                                                                                                                                                                                                                                                |
| `documents`              | uploaded reference file                          | Content in the blob store. Attaches to configurations only. Immutable.                                                                                                                                                                                                                                                                                                     |
| `mcp_servers`            | MCP server identity                              | Name (the `-t` alias), latest version pointer that must resolve.                                                                                                                                                                                                                                                                                                           |
| `mcp_server_versions`    | MCP definition                                   | stdio command and env variable names, or http URL and `headers`, a list of `{header, env}` pairs; names only, last test result. Frozen once a configuration version uses it. Names may not be platform variables or credentials (section 5.3).                                                                                                                             |
| `configurations`         | named configuration                              | Latest version pointer that must resolve.                                                                                                                                                                                                                                                                                                                                  |
| `configuration_versions` | settings Hermes runs with                        | Model, provider, toolsets, memory, skill, document and MCP version ids, skill loading (`preload` or `on_demand`, Phase 6), limits, config hash, the version it was duplicated from. Frozen once an experiment uses it.                                                                                                                                                     |
| `workers`                | worker process start                             | Heartbeat, concurrency, trial slots, Hermes version and revision, toolset list, environment variable names of the worker and of egress (never values), the last sandbox self-test report.                                                                                                                                                                                  |
| `experiments`            | launched comparison                              | Suite row, tasks, baseline and candidates, repetitions, concurrency, spend ceiling, frozen Hermes revision and price table, failure detail, append-only verdict history, results and verdict revisions.                                                                                                                                                                    |
| `runs`                   | cell of the run matrix                           | Task x configuration version x repetition. Lifecycle status, attempt count, current attempt (must belong to this run), cancel request.                                                                                                                                                                                                                                     |
| `attempts`               | launch of Hermes                                 | Trigger, outcome, final text, tokens, cost, launch record, lease (token, expiry, revocation), sandbox and its host.                                                                                                                                                                                                                                                        |
| `run_events`             | stdout line or platform event                    | Keyed by attempt and gap-free sequence number. Append-only.                                                                                                                                                                                                                                                                                                                |
| `artifacts`              | file collected after a run                       | Root (`workspace`, or `home` for the home's `memories/`, Phase 6), path relative to it, origin (fixture, document or home seed unchanged/modified, or agent), blob hash or skipped reason. Append-only.                                                                                                                                                                    |
| `evaluations`            | scoring pass over an attempt                     | Generation (newer wins), claim token, extracted answer, status, superseded time.                                                                                                                                                                                                                                                                                           |
| `scores`                 | verification key in an evaluation                | passed, failed, error or ungradable; score, comment, expected, observed, evidence. Immutable.                                                                                                                                                                                                                                                                              |

Conventions: ULID text ids generated in the app; closed vocabularies are `text` with a CHECK built from the arrays in `@hermes-evals/shared` (adding a value is a migration, never an enum change); every jsonb column uses `jsonValue` so a JSON string never turns into a number; agent text goes through `storableText`/`jsonValue`, which replace the NUL character and unpaired surrogates Postgres cannot store; timestamps are `timestamptz`; money is `numeric` read as a number and never NaN; id lists are `text[]` checked by triggers because Postgres cannot put foreign keys on array elements.

### 3.2 Rules the database enforces

Each raises SQLSTATE 23001 (or a foreign key or check violation) whatever code path writes:

- Events, artifacts, scores, suites, tasks, task files, skills, documents and blobs never change; runs, attempts, experiments and evaluations are never deleted.
- An event or artifact can be added only while its attempt is running and its lease is not revoked. A finished attempt never changes; its identity, lease token, launch record and sandbox are written once. A revoked attempt can only be ended as execution_error or cancelled.
- An experiment can launch only on frozen configuration versions and valid tasks of its own suite row. A run must belong to its experiment's matrix. What an experiment tests cannot change after launch, its revisions only increase, and its verdict history only grows.
- A frozen configuration version or MCP definition never changes (a frozen MCP definition may still record test results). A configuration version's resource ids must exist, it may use one version of each MCP server, and saving it freezes those MCP definitions.
- An evaluation needs an executed attempt. Scores are added only while their evaluation is running. Publishing (status completed) requires the run's current attempt and exactly the task's declared keys, and fails if a newer generation is already published. A run's first evaluation cannot fail (error scores are published instead, so the run always reaches scored). An evaluation is superseded only by a newer generation, once.
- `results_revision` increases by statement-level triggers whenever runs change status or a score set is published or superseded.

### 3.3 State machines

Run: `queued → running → executed → scoring → scored`. Side exits: `running → execution_error` (back to `queued` with a new attempt on retry), `queued | running → cancelled`. Re-scoring a scored run keeps it `scored` and creates a new evaluation.

Experiment: `running ⇄ paused`; `running | paused → completed` by reconcile (section 7.4) or cancel; `running → failed` by the circuit breaker; `failed | completed → running` by retry-failed or a user retry.

Lock order, in every transaction that changes status: the experiment row first, then runs, attempts, evaluations. The results-revision triggers update the experiment row, so taking it last would deadlock.

---

## 4. Task suite file format

### 4.1 Layout

```
suites/invoices-v1/
├── suite.yaml                 name, version_label, description
└── dup_invoices/
    ├── task.yaml              summary, limits, verification, primary key
    ├── prompt.md              exactly what the agent receives
    ├── reference.json         hidden answer, any JSON value
    ├── fixtures/              copied into the workspace before each run
    │   └── invoices.csv
    ├── home/                  optional: memory seeds copied into the trial's home (Phase 6)
    │   └── memories/
    │       ├── MEMORY.md
    │       └── USER.md
    └── verify/                optional
        └── check.py
```

A task's `home/` may hold only `home/memories/MEMORY.md` and `home/memories/USER.md`, stored as task files of kind `home_seed` and copied into the trial home's `memories/` before every run, in every arm whatever `memory_enabled` says (section 5.4). Any other path under `home/` is a load error, and so is a seed that is not UTF-8. The loader warns when a seed is over Hermes's budget (2,200 characters for MEMORY.md, 1,375 for USER.md, counted as Hermes counts them) or does not read as a list of entries separated by a line holding only `§` (Hermes's `ENTRY_DELIMITER`). Known-good folders (`expected/`, `expected_home/`, section 4.3) are hidden from the agent.

### 4.2 `task.yaml` schema (zod in `shared`)

```yaml
summary: Find invoices billed twice by the same vendor
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file] # informational, shown in Task detail
answer:
  format: fenced_json # the only format in v1
  path: duplicates # optional: sub-path of the answer object the primary key scores
verification:
  - key: answer
    type: json_match
    primary: true
    params: { path: duplicates, unordered: true, inner_unordered: true, pass_at: 1.0 }
  - key: reads_fixture
    type: trajectory_match
    params: { tool: read_file, args: { path: invoices.csv }, min_calls: 1 }
```

Rules enforced by the loader: exactly one `primary: true`; keys unique; every `type` is in the registry; params validate against that scorer's zod schema; a `verifier_script` entry's `script` exists under `verify/`; a `text_match` pattern compiles; a `file_check` with `root: home` names a path under `memories/`, the only home folder collected (Phase 6); the checks' declared worst case (each verifier's `timeout_s`, each `llm_judge` key's two calls at their timeout, plus 10 s per key) is at most 3600 s, so one scoring pass fits its job (section 9.4); `prompt.md` must instruct the fenced JSON block (checked by a regex on the prompt, warning only).

### 4.3 Self-check policy, per scorer type

| Type                                                                                                                                        | At load                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `numeric_tolerance`, `json_match`, `exact_match`, `text_match`                                                                              | Run against `reference.json` as if it were the answer; must pass.                                                                                                                                                                                                                                                                                       |
| `verifier_script` (answer-based)                                                                                                            | Run with `--answer reference.json --workspace <fixtures> --home <seeds>`; must print one JSON line with score ≥ the pass threshold.                                                                                                                                                                                                                     |
| `verifier_script`, `file_check` (file-producing tasks)                                                                                      | Run against the hidden expected workspace: the fixtures overlaid with the task's `expected/` folder, the end state a correct agent leaves. Must pass. Then run again against the untouched fixtures as a negative control, which must not pass; a verifier that passes anyway would pass any agent, so the task is invalid.                             |
| `file_check` with `root: home`, `verifier_script` in a task whose only known-good folder is `expected_home` (memory-writing tasks, Phase 6) | Run against the hidden expected home: the home seeds overlaid with the task's `expected_home` folder, the memory files a correct agent leaves. Must pass. Then run again against the seeds alone as a negative control, which must not pass. A `file_check` with `root: home` and no `expected_home` cannot be self-checked (`self_check_unsupported`). |
| `trajectory_match`                                                                                                                          | Schema-validated only (needs a trajectory).                                                                                                                                                                                                                                                                                                             |
| `llm_judge`                                                                                                                                 | Schema-validated only; never called at load (cost, non-determinism).                                                                                                                                                                                                                                                                                    |

A file-producing task declares its expected workspace in `task.yaml`:

```yaml
self_check:
  expected_workspace: expected # folder in the task, overlaid on fixtures/
  expected_home: expected_home # folder in the task, overlaid on home/ (Phase 6): expected_home/memories/USER.md
  negative_control: true # default when either folder is set
```

The loader stores `expected/` files as task files of kind `expected`, and `expected_home/` files as kind `expected_home`. They are never copied into a trial; only kinds `fixture` (into the workspace) and `home_seed` (into the home) are. Each known-good folder is a folder of its own: not `home/`, `fixtures/` or `verify/`, nor inside or around one of them or the other known-good folder, and an expected home's files sit under its `memories/`. A verifier in a task with both folders is a workspace check whose positive run also gets the expected home. Self-check results record the mode (`answer`, `script`, `workspace`, `home`, `none`), whether the check was a negative control, and the expected-workspace and expected-home files used.

A task is `valid` only if it has no load issue of severity error and every runnable check passes. Invalid tasks are listed but cannot be selected for new experiments (enforced by the launch trigger). Existing experiments keep their frozen suite row.

### 4.4 Loader behaviour

The loader runs in the worker (Phase 1 decision D1), because self-checks run the suite's own verifier scripts. It loads every directory under SUITES_DIR when the worker starts, and on a `load-suites` job: `POST /suites/reload` sends one and waits for its result (503 without a live worker, 504 after `SUITE_RELOAD_TIMEOUT_S`). The API does not mount SUITES_DIR. Per directory, in one transaction serialised by an advisory lock on the directory, with the read inside the lock:

1. Hash suite.yaml and every task file; parse; validate; run self-checks (verifier subprocess, the task's `timeout_s`, default 30 s, minimal environment). A suite whose self-checks may declare more than 3,600 s (`MAX_LOAD_SELF_CHECK_SECONDS`: verifier timeouts plus 10 s a key and run, twice with a negative control, four tasks at a time) fails to load; a reload of every suite shares one 3,600 s budget in listing order, and a suite past it gets an error entry asking for a reload of that directory alone. The `load-suites` job expires after 4,200 s (Phase 4).
2. Write each task file (fixture, home seed, verifier, rubric, expected and expected-home file) to the blob store (temp file, fsync, rename) and insert its `blobs` row.
3. If a suites row with the same directory, content hash and check hash exists, reuse it (`unchanged` or `reverted`); otherwise insert a new suites row with its tasks and task files (`created`).
4. Upsert `suite_sources` with the outcome, the changes against the previous version (added, removed, changed, now invalid, now valid) and the new current pointer. A parse failure of suite.yaml or any task.yaml, an unsafe file (a link or special file) or a suite name another live directory holds records the error and leaves the pointer on the last good version. A vanished directory is marked `missing`, which releases its suite name.

After load nothing reads SUITES_DIR: trials, verifiers, judges and the fixture endpoint all read blobs by hash. Editing a suite on disk creates a new version for future experiments only.

### 4.5 Versions: what an edit creates and what the user sees

Decision (24 Oct 2026): tasks are files on disk, and to run an experiment again on edited tasks, the user duplicates it. Updated 25 Oct 2026: suites can also be created and edited in the UI, which writes the same files (section 4.6); everything below applies to both kinds of edit. An experiment is never re-versioned: it stays pinned to the suite version it ran, so its results always describe what was tested.

**What an edit creates.** Editing any file of any task, then reloading, creates a new suite version holding every task and every file. Nothing is copied byte for byte: files are stored by content, so unchanged files are shared with the previous version and only edited files are stored again. The previous version is never modified (the database refuses it).

**Version numbers.** The loader numbers versions itself, so an author who forgets to change `version_label` in suite.yaml still gets a new number:

- **Suite version**: `version_number` is the directory's highest number plus one. Reloading unchanged files reuses the existing version. Reverting to earlier files points back at that earlier version, shown as "v2 (reverted)". The same files judged again by a newer loader or scorer get a new number, shown as "v4 · same files as v3, re-checked".
- **Task version**: each task key has its own `version_number`, which goes up only when that task's content hash changes. Editing `total_due` makes it v2 while the other 11 tasks keep their numbers. `introduced_in_suite_id` records where each task version first appeared.
- **Changes**: every reload records the task keys added, removed, changed, now invalid and now valid against the previous version, shown on the suite and in its history.

**What the user sees.**

- **Suite list**: `invoices-v1` · v5 (author label 0.3, muted) · last loaded · the last reload's changes, for example "1 changed: `total_due`".
- **Suite detail**: a version selector, current version first. A History panel lists each version with its time, label, changes and the experiments that used it.
- **Task detail**: "`total_due` · v2 · changed in suite v5", with a History list of the task's versions. Each version opens a diff against the previous one: prompt and task.yaml as text diffs, reference answer as a JSON diff, and the file list marked added, removed or changed with sizes and hashes.
- **Run inspector header and experiment snapshot**: the task version beside the task key (`total_due v2`) and the suite version beside the suite (`invoices-v1 v5`).
- **An older experiment**: when the suite has a newer version, the snapshot strip says "A newer version of `invoices-v1` exists (v6): 1 task changed (`total_due`)" with **Duplicate on v6**.

**Duplicate.** `POST /experiments/:id/duplicate` (section 7.3) prefills the form with the suite's current version, not the original's. The form lists what differs from the original: tasks changed, plus tasks removed or now invalid, which are left out with their reason. Results from the two experiments are not like-for-like on the changed tasks, and the form says so.

### 4.6 Suite authoring in the UI (planned: Phase 5b)

Decision (25 Oct 2026): users can create and edit suites in the UI as well as on disk. **Files stay the source of truth.** Saving writes the suite folder under SUITES_DIR and loads it through the loader of section 4.4, so versions, hashes, self-checks and experiment pinning (section 4.5) do not change, and hand edits keep working. The design is the canvas page "Suite authoring":

- boards SA.1 to SA.13;
- `05 Components: authoring`;
- Flow E;
- designer notes `n_sa1` to `n_sa13`.

The brief is `DESIGN_SUITE_AUTHORING_PROMPT.md`, kept local.

**Drafts.**

- Edits go into a draft, never straight into a version.
- Each suite folder (or new suite name) has at most one draft. It saves on every change and lasts until it is saved or discarded.
- A draft records its base version and a full picture of the folder:
  - the text files the forms edit, stored verbatim;
  - every other file as a blob reference with its kind: fixture, expected, verifier (read-only), or other (kept as is).
- Uploads go to the blob store first, using the same temp-file, fsync and rename path, so draft rows never hold file bytes.
- Its change list is computed against the base: added, changed, removed, restored from vN, label, order.

**Live validation, in the API, without running user code.** On every change the API runs the 13 readiness rules of the design (board SA.8) on the draft task:

- The checks: the shared zod schemas, and the loader's pure task analysis on an in-memory folder (`analyseTask` and `checkTaskYaml` already take an in-memory reader).
- **Answer-mode self-checks** run here too. Scoring the reference with an answer scorer is pure, so it needs no worker.
- **Cross-checks:**
  - every check path resolves in the reference;
  - files the prompt mentions exist;
  - no text fixture contains a reference leaf value of 4 or more characters;
  - file checks have an expected workspace.
- Problems never block saving a task. A task with problems is saved as invalid, as on disk.

**Self-checks that run code, in the worker.**

- File checks and verifier scripts need the worker. `POST …/self-check` sends a `self-check-draft` job that materialises the draft task from blobs into scratch and runs the loader's own `task-self-check`. It returns the transcript, or 503 without a live worker.
- "Try it" on an answer check runs in the API: extraction plus that scorer, on a pasted reply.

**Save** (`POST /suites/:suite/draft/save`, with the version label) sends a `save-suite-draft` job. The worker runs it under the folder's advisory lock:

1. **Conflict check.** The folder's current version must still be the draft's base, and the files on disk must still hash to the base's content hash, which catches edits that have not been reloaded. Otherwise it returns 409 with the new version and the tasks both sides changed. `POST …/draft/rebase` combines the draft onto the new version, with a choice per overlapping task.
2. **Build the folder in `SUITES_DIR/.draft-<id>/`** (the loader skips dot names). Files the draft manages come from the draft. Every file it does not manage (`verify/`, a README, anything else) is copied from the live folder untouched.
3. **Read and validate the staging folder with the loader.** A folder-level failure stops here, leaving disk unchanged and the draft kept, and returns 422 with the loader's message, file and line. Failures of this kind: suite.yaml or task.yaml does not parse, an unsafe file, or the name is taken.
4. **Swap.** Rename the live folder aside, rename staging into place, remove the old folder, then run the normal per-folder load. It creates the next version, or reports `unchanged`.
5. **Delete the draft** and return the load result: version, changes, valid count.

A removed task is a removed folder; earlier versions keep it in the database.

**Byte-stable writes.**

- `task.yaml` and `suite.yaml` are edited through the `yaml` Document API. Comments, key order and the formatting of hand-written files survive, and an unchanged field never rewrites the file.
- New files use one canonical style.
- `prompt.md` and `reference.json` are written exactly as typed.
- Loading a folder into a draft and saving it with no edit must report `unchanged`. This is a test.

**Verifier scripts stay on disk.**

- Draft endpoints refuse every write under `verify/`.
- A check's settings in `task.yaml` (key, primary, script, timeout, pass threshold) stay editable.
- The UI shows script sources read-only.

**Import and export.**

- **Tasks from CSV or JSONL:**
  - parsed in the API, up to 5 MB and 500 rows;
  - each column maps to task key, summary, prompt, the whole reference, or the reference value at the answer path;
  - shared workspace files, checks and limits, and an optional appended answer paragraph;
  - the result is new draft tasks.
- **A suite from a .zip** (up to 100 MB):
  - read with the hardened zip reader of skill uploads, which refuses links, absolute paths, `..`, more than 20,000 entries, files over 25 MB, and depth over 12;
  - validate, then confirm;
  - creates a draft of a new suite, saved as v1 after review.

  A zip can carry `verify/` scripts, which are code: see R7.

- **Download a version** as `<suite>-v<n>.zip`, streamed from its blobs.
- **Restore** copies a task of an older version into the draft from its blobs.

**Writes to SUITES_DIR.**

- The worker's `./suites` mount becomes read-write.
- Only the save handler writes, only inside SUITES_DIR, only through staging and rename, and under the folder's lock.
- The loader still never writes, and the API still has no suites mount.
- Suites are addressed by folder name in the draft routes, as the design does.

---

## 5. Resources

### 5.1 Skills

Upload is two calls. `POST /resources/skills/validate` accepts a zip (multipart, 20 MB cap), unpacks to a temp dir, checks `SKILL.md` at the root, parses frontmatter (`name`, `version`, `description` required), counts files, hashes content, checks the name and version against existing rows, and returns the validation report plus a short-lived token. `POST /resources/skills` with the token stores the directory under `resources/skills/<hash>/` and inserts the row. Nothing is stored before confirm.

Zip safety: reject entries with absolute paths or `..`, symlinks, and unpacked size over 100 MB.

### 5.2 Documents

`POST /resources/documents` stores the file content-addressed and inserts the row. 50 MB cap. Documents attach to configurations only.

### 5.3 MCP servers

`POST /resources/mcp-servers` validates exactly one transport and creates the server with its version 1 in one transaction. Editing a definition no configuration version uses updates it in place; editing a frozen one creates the next version. `POST /resources/mcp-servers/:id/test` enqueues `test-mcp-server` (key: the version id). The worker starts a throwaway trial container through the guard with only that server configured and asks Hermes to list its tools, or, if that proves unreliable in the spike, speaks MCP `tools/list` directly from inside the same kind of container. The result goes to the version's `last_test`; missing secret names are reported by name. Save is allowed without a test; the version then shows `untested`.

**Secrets, and what the agent can read.** A definition names variables, never values; the values live in `.env`. How a value reaches a run depends on the transport, and the UI labels each name with its case (Resources › Secrets, the MCP form, the configuration form and detail, System, the launch record):

| Case                | Where the value goes                                                                                                                                                                                            | Readable by the agent? | UI label                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------ |
| stdio, env variable | The worker reads it from its own environment and sets it in the trial container's environment (section 8.2). `config.yaml` holds only `${NAME}`; Hermes fills it in when it starts the server. Never in a file. | Yes                    | "Readable by the agent"              |
| http, header        | Egress reads it from its own environment and adds the header to each request on the way to the server. The trial's configuration points at egress and has no headers.                                           | No                     | "Added by egress · never in the run" |

The stdio case is a plain fact, not a failure: a stdio server is a process inside the trial, and anything it can use, the agent's terminal can read too (`/proc/<pid>/environ`, or by starting the same command). The UI advises scoped or throwaway values. A placeholder cannot help, because the server needs the real value to work.

- **Definition shape.** stdio: command, args, env variable names. http: URL and pairs of header name and variable name (`Authorization ← VENDOR_API_TOKEN`). The schema's `header_names` array becomes a `headers` list of `{header, env}` pairs (a migration). Egress sends the variable's value unchanged as the whole header value, so an API that wants `Authorization: Bearer <key>` needs `Bearer <key>` in the variable; Compose writes that prefix for the sample `vendor-directory` (Phase 6).
- **Reserved names.** A definition may not reference a provider credential, `DATABASE_URL` or any other variable of the worker's, egress's or the trial's own (`WORKER_RESERVED_ENV_NAMES` and `WORKER_RESERVED_ENV_PREFIXES` in `packages/shared/src/env-names.ts`), as an env name or as a header variable, and one name may not be both a stdio env name and an http header variable. The API refuses these when a definition is saved; the worker refuses them again before it tests or runs one, which covers versions stored before the rule. Values are kept out of the container rather than redacted, because no redaction catches an encoded value.
- **Presence.** `GET /resources/secrets` lists each referenced name with set or not set, its source, what references it, and its exposure. The worker records the names in its own environment on its `workers` row at start (it already stores `env_names`), and the names egress has, which it asks for over the egress admin socket at start and on each heartbeat. Values never leave either process. A test or run with a missing name fails as `setup` and names it. Since Phase 6 (Phase 5 #13) launch refuses that first: it answers 409 naming each variable a chosen configuration's MCP server versions need that is not set where it is read (stdio names in the live worker's environment, http header variables in egress's), with its server, and New experiment shows the same per configuration and disables Launch.
- **stdio servers have no network.** Hermes starts stdio servers with a filtered environment (PATH, HOME, USER, LANG, LC_ALL, TERM, SHELL, TMPDIR, `XDG_*`, plus the server's own `env`; `tools/mcp_tool_config.py:147,199`), so the proxy variables never reach them, and the slot network has no other route. The sample `invoice-db` is file-backed for this reason. A server that needs a remote service is defined as http instead. `docs/limits.md` says so.
- **The MCP gateway** (egress, `:8080/mcp/<name>`) forwards only to the definition's exact URL, follows no redirects, streams responses (streamable HTTP transport), and records each call in the attempt's connection log. The worker registers the attempt's routes (name, URL, header-to-variable pairs) with its token. The upstream may be a private address, such as a server on the user's machine, because the definition chooses it and the agent cannot. The `test-mcp-server` job uses the same path.

### 5.4 Materialisation into a trial

Given a claimed attempt, the worker prepares `trials/<attemptId>/` in the `trials` volume. The trial container later mounts exactly two subpaths of it: `home` at `/opt/data` and `workspace` at `/workspace`. `launch.json` and `stderr.log` stay beside them, outside the trial's view.

1. Create `home/` and `workspace/` as fresh real directories (lstat-checked, never pre-existing).
2. Copy task files of kind `fixture` from the blob store into `workspace/`, re-checking each hash. Copy configuration documents into `workspace/docs/`.
3. Copy each configured skill into `home/skills/<name>/`, in both skill loading modes (section 6), and write `home/.no-bundled-skills` so Hermes does not add its 58 bundled skills. Hermes still installs its one essential skill, `hermes-agent` (about Hermes itself), in every home and it cannot be disabled (`tools/skills_sync.py:397-410`, `agent/skill_utils.py:275`). So the no-skill arm is not skill-free; it has exactly that skill, the same as every other arm, and the platform skill remains the only difference. The experiment write-up says so.
4. Copy the task files of kind `home_seed` into `home/memories/` (`home/memories/MEMORY.md` becomes `memories/MEMORY.md` in the home), re-checking each hash, in every arm whatever `memory_enabled` says: with memory off Hermes builds no memory store and injects nothing, so the same seed in both arms isolates the setting (Phase 6 P1).
5. Write `home/task.txt` with the prompt and `home/config.yaml` (section 8.2). No provider key, no `auth.json` and no MCP secret value is ever written into the home: the agent can read anything there through its terminal. `config.yaml` refers to stdio env values as `${NAME}` and has no http headers (section 5.3).
6. Record the launch record (argv, container spec, config.yaml, inputs with hashes, the home seeds among them with source `home_seed`, the skill loading mode, the background review intervals, Hermes version and revision) before the container is created.

---

## 6. Configurations

Fields and validation as in the design: `name` unique and slug-like; `model` free text with suggestions from the price table; `provider` from a fixed list (`nous`, `nous-api`, `openrouter`, `openai`, `anthropic`, `custom`); `toolsets` from `GET /system/toolsets`, which the worker reads once at start by running the trial image (so the list is the real one at the pinned revision) and stores on its `workers` row; `memory_enabled` default false; `skill_loading` `preload` (default: `-s <name>` per skill) or `on_demand` (the skills installed in the home without `-s`, and the `skills` toolset added once, so the agent lists and opens them), which needs at least one skill (400 otherwise; Phase 6 P5) and enters the config hash only when it is `on_demand`, so every earlier version keeps its hash; `max_turns` 1 to 200; `time_budget_s` 30 to 3600.

`GET /configurations/diff?versions=a,b,c` returns one row per field with values and a `differs` flag; the New experiment form, the list's Compare, and the detail's Compare with… all use it.

`POST /configurations/:id/duplicate` returns a prefilled draft for the form; no row is created until save.

### 6.1 Model access: connecting Nous Portal from the UI

Nous Portal has no API keys, only an OAuth device login with rotating refresh tokens, so something must hold that login. Until now that meant a terminal command. Instead, the user opens **System → Model access**, clicks **Connect Nous Portal**, approves in the browser tab that opens, and sees **Connected**. No terminal, nothing copied.

**How it works.** A small service, `nous-login`, runs Hermes's own device login and writes the result where `nous-proxy` reads it:

- It uses the same pinned trial image and the same `nous-home` volume as `nous-proxy`, with a short Python HTTP server (`docker/nous-login.py`) as its command.
- It calls the functions `hermes auth add nous` uses: `_nous_device_code_login(open_browser=False, on_verification=…)`, then `_save_active_provider_state("nous", …)` and the credential-pool sync (`hermes_cli/auth_nous.py:1379-1460`, `1612-1640`). The `on_verification` callback hands over the verification link and user code before polling starts; Hermes's terminal UI uses the same hook.
- Status comes from `get_nous_auth_status_local()`, which makes no network call. Disconnect does what `hermes logout --provider nous` does.
- `nous-proxy` needs no restart: its adapter re-reads the auth store under Hermes's file lock on every request (`hermes_cli/proxy/adapters/nous_portal.py:52-115`). Both containers take that lock, so a new login and the proxy's token refresh cannot interleave.
- These are private Hermes functions, so `nous-login` checks at startup that they exist with the expected parameters and reports `unavailable` if not. If a future Hermes revision drops them, the fallback is to run `hermes auth add nous --type oauth --no-browser` as a subprocess and read the link and code it prints. An image bump reruns this check.

**Login states.** One login at a time; a new Connect cancels a pending one.

| State                  | Meaning                                                                        | UI                                                                             |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `not_connected`        | No login in the volume                                                         | **Connect Nous Portal**                                                        |
| `waiting_for_approval` | Device code issued; link, user code and expiry known                           | Large user code with copy button, **Open Nous Portal** link, countdown, Cancel |
| `connected`            | Usable login                                                                   | Connected chip, **Disconnect** (with `ConfirmInline`)                          |
| `relogin_required`     | Refresh failed terminally (Hermes quarantined the login)                       | Warning chip, **Reconnect**                                                    |
| `expired`              | The code expired before approval                                               | **Get a new code**                                                             |
| `denied`               | The user declined in the portal                                                | Message, **Try again**                                                         |
| `needs_subscription`   | Portal returned `subscription_required` (Hermes prints and exits; caught here) | Link to the portal's billing page                                              |
| `failed`               | Portal unreachable or another error                                            | Message, **Try again**                                                         |

**What never leaves the volume.** Access tokens, refresh tokens and the agent key. `nous-login` returns only the link, the user code, the state, its expiry, and non-secret details (portal URL, granted scope, whether re-login is required).

**API** (`providers` module; the API reaches `nous-login` over a dedicated internal network):

| Method, path                   | Purpose                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /providers`               | Every provider, how it authenticates and its status: Nous from `nous-login`; key providers as `configured` or `missing` (presence only) |
| `POST /providers/nous/login`   | Start a login; returns the link, user code and expiry                                                                                   |
| `GET /providers/nous/login`    | Current login state; the UI polls it every 2 s while waiting, and stops when the page is hidden or the state is final                   |
| `DELETE /providers/nous/login` | Cancel a pending login                                                                                                                  |
| `POST /providers/nous/logout`  | Disconnect                                                                                                                              |

The API has no authentication, by requirement, so a page on another site open in the user's browser must not be able to log them in or out. The three state-changing calls therefore require `content-type: application/json` and an `X-Requested-With` header; a cross-origin page cannot send those without a CORS preflight, which the API refuses. DNS rebinding can make another site's requests same-origin, so the API also answers only the host names it is reached by (loopback, `api`, the web origin's host and `ALLOWED_HOSTS`), refuses a state-changing request whose `Origin` is another site, and listens on loopback outside Compose; nginx drops requests for any other name.

**Nudges: connect before anything that needs a model.** A user should never find out at launch, or halfway through an experiment, that no model is reachable. Each place that leads to a model call checks the provider of the configurations involved and, when it is not connected, says so where the user is and offers the connect flow without leaving the page.

| Where                                         | When                                                                             | What the user sees                                                                                                                                                                                                             | After connecting                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Experiments list (landing page)               | No provider is connected at all                                                  | A setup card above the list: "Connect a model provider to run experiments", with **Connect Nous Portal** and "Use an API key instead" (how to set one in `.env`)                                                               | The card goes away                                                                                        |
| AppShell, every page                          | A configuration uses Nous and Nous is not connected, or its login needs renewing | Amber banner: "Nous Portal is not connected. Experiments that use it cannot run." with **Connect**                                                                                                                             | The banner goes away                                                                                      |
| Configuration form                            | Provider `nous` is chosen and not connected                                      | A notice under the provider field: "Not connected. You can save now and connect before you launch." with **Connect now**. Saving is allowed: a configuration is only a definition                                              | The notice becomes a Connected chip                                                                       |
| New experiment                                | A selected configuration's provider is not connected                             | The configuration row and the summary panel name the blocker; Launch is disabled with the reason "Nous Portal is not connected"; **Connect Nous Portal** in the summary panel                                                  | Launch enables, the form keeps everything entered, and the dialog offers **Launch now** (never automatic) |
| Launch call                                   | The page was stale or the API is called directly                                 | `POST /experiments` returns 409 with the same reason, checked before the launch transaction; the form shows the nudge above                                                                                                    | As above                                                                                                  |
| Retry runs, Resume, Re-score with `llm_judge` | The runs' configuration, or the judge, uses a provider that is not connected     | The control is disabled with the reason and a **Connect** link                                                                                                                                                                 | The control enables                                                                                       |
| Running experiment                            | The login lapses or is disconnected                                              | The experiment pauses with reason `provider_disconnected` (section 7.3): "Paused: Nous Portal is not connected. In-flight runs finished. Reconnect, then Resume." with **Reconnect** and **Resume** (disabled until connected) | Resume enables                                                                                            |
| Suites and tasks                              | Viewing, reloading or loading tasks                                              | No nudge: loading a suite and its self-checks never call a model (section 4.3)                                                                                                                                                 |                                                                                                           |
| Development host login                        | `NOUS_HOST_PROXY` is set but `hermes proxy start` is not running on the host     | Status `host_unreachable`: "This stack uses this machine's Hermes login, but its proxy is not running", with the command to start it                                                                                           | Status turns Connected on the next check                                                                  |
| API-key providers (OpenRouter and others)     | The key is missing from `.env`                                                   | The same placements, but no Connect button: the steps are "add `OPENROUTER_API_KEY=…` to `.env`, then `docker compose up -d egress worker`", because the platform never stores keys (invariant 7)                              | The status turns Configured                                                                               |

Every **Connect** opens the same `ConnectDialog`, which holds the Model access card's Nous flow plus four numbered steps: click Connect; a Nous Portal tab opens with your code filled in (or copy it); sign in and approve; come back, this page updates by itself. Closing the dialog does not cancel a pending login: polling continues, and an AppShell pill shows "Waiting for Nous approval · 12:41 left" until it resolves.

**Development login.** When `.env` sets `NOUS_HOST_PROXY` (egress forwards to `hermes proxy start` running on the host, section 15), the API reports Nous's source as `host`. The card then reads "Using this machine's Hermes login (development)" and hides Connect, because the containers can neither start nor log in a host process.

---

## 7. Experiments

### 7.1 Create and launch

`POST /experiments` body: name, description, suite_id, task_ids (valid tasks of that suite row), baseline_version_id, candidate_version_ids (≥1), repetitions (≥1), concurrency (1 to the live workers' total), spend_ceiling_usd, time_budget_override_s, plus `expected_config_hashes` (version id to config hash, as the form showed them).

A run's time budget is the configuration version's `time_budget_s`, replaced by `time_budget_override_s` when it is set (replaced, not capped, so every arm gets the same budget). Execution, recovery's deadline, the inspector's limits, the Overview's timing and every estimate use this one rule (`apps/api/src/execution/budget.ts`). A task's own `limits.max_turns` and `limits.run_budget_seconds` in task.yaml are informational in v1, as `toolsets_needed` is.

One transaction, in this order:

1. Freeze the baseline and candidate versions in their own statement: `UPDATE configuration_versions SET frozen_at = now() WHERE id = ANY($ids) AND frozen_at IS NULL`. The row locks order the launch against any concurrent in-place edit.
2. `SELECT id, config_hash ... FOR SHARE` and compare with `expected_config_hashes`; return 409 listing the changed configurations if any differ or a newer version exists.
3. Read `hermes_version` and `hermes_revision` from live workers (409 if none is live or they disagree), and snapshot the price table.
4. Insert the experiment (the launch trigger checks frozen versions and valid tasks), insert `tasks × versions × repetitions` runs in `queued`, and send one `execute-run` job per run with `{ db: fromDrizzle(tx, sql) }`, singleton key `runId:1`, trigger `initial`. Jobs and rows commit together or not at all (verified on Postgres 17).

Repetitions = 1 is allowed; the comparison then reports the statistics as not computable with reason `single_repetition`.

### 7.2 Estimates

`GET /experiments/estimate?suite=&versions=&repetitions=&concurrency=` returns per-configuration median duration and cost over past attempts on that suite and configuration version's `config_hash` (so a renamed configuration with the same fields still matches), falling back to `budget / 4` seconds and 15,000 tokens with `basis: 'budget'`. Duration = `ceil(runs / concurrency) × median`. Cost uses the price table; unknown model yields `cost: null` and the UI shows "—".

### 7.3 Controls

Every control is one transaction that locks the experiment row first.

- **Pause** (user, the spend guard with `pause_reason = spend_ceiling`, or the provider guard with `provider_disconnected`): set `paused`, `pause_reason`, `paused_at`. A worker that claims a job for a paused experiment completes the job without starting anything; in-flight trials finish.
- **Resume**: set `running` (a spend-ceiling pause requires a higher ceiling), then send `execute-run` for every queued run with key `runId:(attempt_count + 1)`. The exclusive policy makes this a no-op for runs whose job is still waiting.
- **Cancel**: set `cancelled_at`; mark queued runs `cancelled` and cancel their jobs; set `cancel_requested_at` on running runs. The worker that owns each running attempt stops its container and ends the attempt as `cancelled`. Executed and scoring runs finish scoring. Reconcile completes the experiment once nothing is in flight.
- **Provider guard**: before starting a trial, the worker checks that the configuration's provider is connected (for Nous, the `nous-login` status, which makes no network call; for key providers, that egress has the key). If not, it does not start the trial or spend an attempt: it defers the job and pauses the experiment with `pause_reason = provider_disconnected` (a new value in `PAUSE_REASONS`, so a migration updates the CHECK). Resume requires the provider to be connected. A login that lapses while a trial is running fails that attempt as `execution_error · provider`, which is retried once automatically after Resume.
- **Spend guard**: before each claim, the worker sums priced attempt costs; at or above the ceiling it pauses the experiment. Unpriced attempts are counted and shown, never coalesced to zero. An attempt's cost prices Hermes's `result` tokens, or egress's own metered count when there is no result (a deadline, a kill, a cancel) or the result claims fewer tokens than egress saw; an attempt of a priced model whose trial ran but whose usage nobody measured (its worker died with it) counts at the mean cost of the priced attempts.
- **Circuit breaker**: `consecutive_execution_errors = consecutive_execution_errors + 1` in SQL on each execution error (reset on success); at `MAX_CONSECUTIVE_EXECUTION_ERRORS` (default 14) the experiment becomes `failed` with the structured `failure` (category, message, first stderr line, attempt). `POST /experiments/:id/retry-failed` sets it back to `running`, clears the failure and re-sends queued runs like resume.
- **Retry a run**: from `execution_error` with attempt_count < 5, set it `queued` and send `execute-run` with the next attempt number; a completed experiment goes back to `running`.
- **Duplicate**: returns a prefilled New experiment form on the suite's current version, listing the tasks that changed, were removed or became invalid since the original (section 4.5).

A handler cannot re-send its own singleton key while its job is active (pg-boss refuses it). When a handler must put a job back for later, it uses `deferJob`, which completes the active job and sends the delayed copy in one transaction (verified).

### 7.4 Completion: one reconcile function

`reconcileExperiment(tx, experimentId)` is called inside every transaction that finishes a run (scores published, final execution error, cancellation, recovery) and by the periodic recovery pass as a safety net. Retries are scheduled before it runs, in the same transaction, so a run waiting for its retry is still `queued`.

1. `SELECT ... FROM experiments WHERE id = $1 FOR NO KEY UPDATE`.
2. Settled means no run in `queued | running | executed | scoring` and no evaluation in `queued | running`. If not settled, return.
3. Unless `verdict_revision` already equals `results_revision` (and never for a `failed` experiment), compute one verdict entry per candidate on the primary key, as final statistics (section 10), from the results read under the row lock: no run can change status and no score set can publish meanwhile, since each updates the row. The cause is `initial` for the first entries, `rescore` when the experiment had completed and a re-score moved its results, and `retry` when a retry reopened it and it settled again (also when it settled because the retried run was cancelled). The note counts what happened since the previous entry: "1 retry", "2 runs re-scored".
4. Conditional update: `SET status = 'completed', finished_at = now(), verdict_history = verdict_history || $entries, verdict_revision = results_revision, pause_reason = null, paused_at = null WHERE id = $1 AND status IN ('running', 'paused') AND verdict_revision IS DISTINCT FROM results_revision`. For an already completed experiment whose results moved, the same append and `verdict_revision` with `status = 'completed'` in the condition; it stays completed. Two finishers at the same moment append once (verified on Postgres 17 with three finishers released at once). Built in Phase 4 (`docs/phases/phase-4.md` section 3.8).

---

## 8. Execution pipeline (worker)

### 8.0 Why a container per trial

Decision status: **confirmed and built.** Directory isolation (a fresh `HERMES_HOME` per trial, Hermes as a subprocess of the worker) fails on three counts, each verified in the Hermes source at revision `4d04303`:

- **It does not confine the agent.** The file tools accept absolute paths (`tools/file_tools_paths.py:155-171`), the terminal runs `bash -l` as the worker's user with its environment and network, and proxy variables are advisory. An agent could read suites, other trials and blobs, and reach Postgres and the unauthenticated API.
- **It cannot stop a run.** `hermes chat --format stream-json` is a thin client. The agent loop, tools and MCP servers run in a `hermes gateway` daemon it starts in its own session (`hermes_cli/gateway_runtime_start.py:78`), which outlives the client and idles for 600 s. Killing the client's process group leaves the run going.
- **Concurrent trials collide.** One gateway per user takes a host lock under `~/.local/state` (exit 75 for the second), and gateways bind their session API on loopback without auth, reachable by any trial sharing the network namespace.

A container per trial fixes all three: its filesystem view is two mounts, its network is an internal slot network, and stopping it ends every process in its PID namespace. Measured overhead on this machine: 0.10 s median to start and remove an isolated container, against trials of minutes.

### 8.1 Claim, admission and leases

`execute-run` workers run with `batchSize 1` and `localConcurrency = min(WORKER_CONCURRENCY, number of TRIAL_SLOTS)` (a higher `WORKER_CONCURRENCY` logs a warning at start); a handler does not return until its container is removed, so the worker slot bounds live containers. Each job is `{runId, attempt, trigger}` with singleton key `runId:attempt`.

Claim transaction:

1. Lock the experiment row. If it is paused, failed or cancelled, complete the job and stop (resume and retry-failed re-send).
2. Lock the run. Unless it is `queued` with `attempt_count = attempt - 1`, the job is stale or a duplicate: complete it and stop.
3. Admission: count the experiment's runs in `running`. At or above `experiments.concurrency`, defer with `deferJob` (start after 5 to 15 s) and stop. This is the database check that makes the per-experiment limit hold across workers and restarts; pg-boss group concurrency is not race-free and is only an optional pre-filter.
4. Spend guard (section 7.3).
5. Insert the attempt (`status running`, fresh `lease_token`, `lease_expires_at = now() + 60 s`, `sandbox_host_id` = this worker's Docker daemon id) and update the run to `running` with the new attempt pointer.

Every later write the worker makes to the attempt is fenced: `WHERE id = $a AND lease_token = $t AND status = 'running' AND lease_revoked_at IS NULL`. Zero rows means the lease is lost: stop the container, roll back, complete the job. A heartbeat every 10 s renews all leases the worker holds in one statement; a lease missing from the result is treated as lost.

### 8.2 Trial container and Hermes launch contract

The trial spec the worker sends through the guard (equivalent `docker create`):

```
--name hermes-evals-run-<runId> --label hermes-evals.role=trial --label hermes-evals.attempt=<attemptId>
--network hermes-evals-trial-<slot> --user 10000:10000 --read-only --init
--tmpfs /tmp:rw,nosuid,nodev,exec,size=512m
--mount type=volume,src=hermes-evals-trials,dst=/opt/data,volume-subpath=<attemptId>/home
--mount type=volume,src=hermes-evals-trials,dst=/workspace,volume-subpath=<attemptId>/workspace
--cap-drop ALL --security-opt no-new-privileges --pids-limit 1024 --memory 1536m --memory-swap 1536m
--cpus 1 --ulimit nofile=4096 --stop-timeout 10
-e HOME=/opt/data -e HERMES_HOME=/opt/data -e HERMES_WRITE_SAFE_ROOT=/workspace:/opt/data
-e XDG_RUNTIME_DIR=/opt/data/.run -e HTTPS_PROXY=http://<attemptId>:<token>@egress:3128 (and HTTP_PROXY) -e NO_PROXY=egress
-e <NAME>=<value> for each env name of a configured stdio MCP server (section 5.3; the launch record keeps the name only)
--entrypoint /opt/hermes/.venv/bin/hermes  hermes-evals/trial:v0.22.4-4d04303
  chat --query-file /opt/data/task.txt --oneshot --format stream-json
       --provider <provider> -m <model> --base-url http://egress:8080/v1 --api-key <attempt token>
       -t <toolsets plus one entry per MCP server name> [-s <skill>]... --max-turns <n> --yolo --in /workspace
```

`-s` is passed per skill with `skill_loading: preload`; with `on_demand` there is none, and the toolsets include `skills` (Phase 6 P5).

Corrections to the earlier contract, from the Hermes source: `--run-budget` is rejected on this path, so the budget goes in `config.yaml` as `agent.run_budget_seconds`; `--source tool` is dropped, because it disables Hermes's one-shot behaviour; `--ignore-user-config` and `--ignore-rules` are never used; the session id comes from the `result` event, not `system/init`. `--yolo` is safe because the container is the boundary; without it, flagged commands are denied in one-shot mode.

`home/config.yaml` sets: the model and provider with the gateway base URL and attempt token; toolsets; `memory.memory_enabled`; `memory.nudge_interval: 10` and `skills.creation_nudge_interval: 10`, Hermes's defaults written explicitly and the same in every arm, because the background review cannot run in a one-shot trial (Phase 6 P3, `docs/phases/phase-6.md` section 2.3); `mcp_servers` (names and `-t` aliases; stdio `env` entries as `${NAME}`, which Hermes fills from the container environment when it starts the server; http servers as `url: http://egress:8080/mcp/<name>` with no headers); `agent.max_turns` and `agent.run_budget_seconds`; and, so the run makes no avoidable network calls and does not change behaviour between arms: `updates.check: false`, `plugins.auto_update_check_hours: 0`, `curator.enabled: false`, `auxiliary.title_generation.enabled: false`, compression pinned to the gateway, `model.context_length`, `security.allow_lazy_installs: false`, `security.protected_instruction_files: false`, `gateway.unmanaged_idle_exit_seconds: 5`, `approvals.mode: off`, and `tools.tool_search.enabled: off` (so the configured toolsets and MCP tools are exactly what the agent sees, in every arm, rather than behind Hermes's `tool_search` bridge).

One call remains that no setting turns off. When the provider is `nous`, a background "credits-seed" thread warms Hermes's pricing cache with `GET https://inference-api.nousresearch.com/v1/models`, ignoring `--base-url` because the home has no Nous login (`agent/credits_tracker.py:479-509`, `agent/models_pricing.py:236-328`). Egress refuses it, the fetch fails open, and it happens identically in every arm, so results are unaffected. The inspector labels it as Hermes baseline traffic, not an agent action.

Disk: home and workspace live on the shared trials volume, so one runaway trial could fill the disk that other trials and Postgres use. While a trial runs, the worker measures both directories every second (lstat only, allocated blocks, so sparse files count at their real size) and kills the container without a grace period past 2 GiB or 50,000 files. The cap is polled, so a fast writer overshoots by about one interval of writes; a hard quota would need a filesystem with project quotas. Every stop condition (deadline, cancel, disk) is armed right after start, before the worker reads any output, so a container that prints nothing is still stopped.

Credentials: the trial holds only the attempt token, valid from its slot network, for the configured model, until the attempt ends. For API-key providers egress injects the key. For Nous Portal (connected from the UI, section 6.1), egress forwards to nous-proxy, which holds the single OAuth login (refresh tokens rotate, so `auth.json` is never copied anywhere). For http MCP servers egress adds the header values. The only secrets a trial holds are the env values of its stdio MCP servers (section 5.3).

### 8.3 Event streaming

The worker follows the container's logs (`stdout` and `stderr` demultiplexed), splits stdout into lines across frames, parses each as stream-json, and writes events in batches of 50 or every 500 ms with gap-free sequence numbers. A non-JSON line is stored as a `platform` event `noise`; an unknown type as `platform` `unmapped`. Stderr goes to `trials/<attemptId>/stderr.log` and its last 40 lines to the attempt, with every MCP value the worker passed replaced by `<from env NAME>`. Egress's per-attempt connection log is stored as platform events too, so the inspector shows every connection attempted from the trial, with Hermes's own baseline call (section 8.2) labelled as such.

The answer is always the `result` event's `text`. Streamed `text` deltas are for display only: in this Hermes revision they can drop a newline-only delta (observed after a ` ```json ` opener, likely `agent/stream_delivery.py:325-330`), so joining them does not always reproduce the answer.

Event mapping is unchanged from the verified stream-json emitter, except `system/init.session_id` is empty and `result.session_id` carries it.

### 8.4 Exit classification

| Observation                                                                      | Attempt status    | Category                                           |
| -------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------- |
| `result` with exit code 0 and text                                               | `executed`        |                                                    |
| `result` with exit 1 and partial text (max turns, partial)                       | `executed`        | (scored on what it produced)                       |
| `result` error with egress's token-cap 429 (`MODEL_TOKEN_CAP_PER_ATTEMPT`)       | `execution_error` | `limit` (the platform's stop; never auto-retried)  |
| `result` error mentioning auth, 401, 403                                         | `execution_error` | `provider`                                         |
| `result` error mentioning 429, 5xx, connection                                   | `execution_error` | `provider`                                         |
| Deadline reached: container stopped (SIGTERM, SIGKILL after 10 s), no `result`   | `execution_error` | `timeout` (a platform result event is synthesised) |
| Exit 3 "Input required"                                                          | `execution_error` | `setup`                                            |
| Container failed to start, Hermes failed before init, MCP server failed to start | `execution_error` | `setup`                                            |
| Container OOM-killed (`State.OOMKilled`)                                         | `execution_error` | `other`                                            |
| Disk cap passed: container killed (`stopReason: disk_limit`)                     | `execution_error` | `other` (the message names the cap)                |
| Cancel requested                                                                 | `cancelled`       |                                                    |
| Lease revoked, found by recovery                                                 | `execution_error` | `worker_lost`                                      |
| Anything else                                                                    | `execution_error` | `other`                                            |

Hermes does not stop when a configured MCP server fails to connect: it parks the server, runs the agent without its tools and still prints a normal `result`. Its only record is a `Failed to connect to MCP server '<name>'` warning in `HERMES_HOME/logs/errors.log`, so the runner reads that file from the home before deleting it and ends such an attempt as `setup` whatever the result said (`apps/api/src/execution/attempt/mcp-start.ts`; found in the Phase 2 live check).

All final platform events (`killed`, `cancelled`, `collected`) are written before, and in the same transaction as, the update that finishes the attempt; the database refuses events after that. Finishing an executed attempt also sets the run to `executed`, inserts its evaluation (generation 1) and sends `evaluate-run`, all in that transaction.

Retry policy: `provider` and `timeout` once automatically (attempt 2, 30 s later); `worker_lost` by recovery up to 3 attempts; `setup`, `limit` and `other` only by the user, up to 5 attempts. An attempt stopped at the token cap is `limit` (migration `0007`, Phase 4; `other` in Phase 3), not `provider`, although Hermes reports it as an HTTP 429: a second attempt would stop at the same cap after spending as much again (found in the Phase 3 live check).

### 8.5 Artifact collection

After the container is removed (so nothing can change under the walk), the worker walks `trials/<attemptId>/workspace` with `walkTrialTree` and reads files with `readTrialFile` (`apps/api/src/sandbox/trial-files.ts`). The agent controls every name, link and file type there, and the worker resolves them in its own view, where `/data` and `/trials` hold suites, blobs and other attempts. So the walk uses lstat and never follows a link; links are listed with their target text only. FIFOs, sockets and devices are listed and never opened. Names that are not valid UTF-8 are listed and not read. Depth stops at 32 and the walk at 5,000 entries. A read opens with `O_NOFOLLOW | O_NONBLOCK`, checks with fstat that the file is regular, and on Linux checks through `/proc/self/fd` that the file it opened is under the attempt's directory, which catches a link in a parent component. Each regular file is hashed, written to the blob store if new, and recorded as an artifact labelled by comparing with the input manifest: fixture or document unchanged or modified, or agent. Files over 25 MB are recorded with `skipped_reason` and no content.

Then, before the home is deleted, the worker collects the home's `memories/` the same way (Phase 6 P2): `memories/` itself is lstat-checked (a link or a non-directory is listed, never followed), and its files become artifacts with root `home` and paths relative to the home (`memories/USER.md`), labelled against the home seeds: home seed unchanged or modified, or agent. Nothing else of the home is collected. The home shares the attempt's collection budget, taking what the workspace left; a failure there is recorded on the `collected` event and the workspace's artifacts are kept. The home is then deleted entirely; the workspace is kept for `TRIAL_RETENTION_DAYS`. Re-scoring reads only blobs.

### 8.6 Recovery

Every worker runs recovery at boot and every 15 s, one pass at a time across workers (advisory lock):

1. Revoke: `UPDATE attempts SET lease_revoked_at = now()` for running attempts whose lease expired, whose worker stopped, or that passed their deadline plus 120 s.
2. For each revoked running attempt whose sandbox host is this worker's Docker daemon: list containers by its attempt label, stop, wait, confirm not running, remove, and list again until empty. An attempt on another daemon is left revoked and keeps its slot until a worker on that daemon confirms it. A missing heartbeat alone never proves the trial stopped.
3. Remove the attempt from this worker's egress (its token dies; a dead worker never removed it), then finalise in one transaction (experiment, run, attempt locks): end the attempt as `execution_error · worker_lost` (or `cancelled` if cancel was requested), requeue the run with the next attempt if allowed, then reconcile. Egress itself drops a registration 10 minutes after it expired.
4. Sweep: remove trial containers whose attempt is no longer running, and any container past its deadline label.
5. Re-send `execute-run` for queued runs of running experiments (lost jobs) and `evaluate-run` for evaluations whose claim expired; the exclusive keys make both no-ops when the job still exists.

### 8.7 Isolation self-test

At boot the worker starts a probe trial container and checks, from inside it, that only the two mounts exist, that Postgres, the API, the host gateway, `host.docker.internal`/`host.lima.internal` and a public address are unreachable directly, and that egress refuses private targets. If any check fails, the worker refuses to run experiments and `/system` shows why. It never falls back to running Hermes without a container.

---

## 9. Evaluation pipeline (worker)

### 9.1 Answer extraction

From `attempts.final_text`: find all fenced blocks tagged `json`; take the last; parse. Store `{start, end}` offsets and the parsed value (or the parse error with position) on the evaluation as `answer`, so the attempt stays immutable and each re-score keeps its own extraction. No block → every answer check (`numeric_tolerance`, `json_match`, `exact_match`, `text_match`) becomes `ungradable` with the comment "no fenced JSON block found in final response". Invalid JSON → `ungradable` with the position. A `verifier_script` is not an answer check: it receives the answer, or JSON null when there is none, and may judge the workspace alone, so it is graded on what it prints. An `llm_judge` key grades the final text, block or not, and is `ungradable` only when there is no final text. The inspector highlights the range.

### 9.2 Scorer interface

As built (`apps/api/src/evaluation/context.ts`, `scoring/result.ts`, `scoring/registry.ts`):

```ts
interface ScorerContext {
  task: TaskRecord; // prompt, reference, verification list
  attempt: AttemptRecord; // final text
  answer: ExtractedAnswer;
  artifacts: readonly ArtifactRecord[];
  events(): Promise<readonly EventRecord[]>; // read on first use (trajectory_match)
  workspace(): Promise<string>; // rebuilt from artifact blobs once, read-only checks
  verifierDirs(): Promise<VerifierDirs>; // a fresh workspace and verify/ per verifier run
  rubric(path: string): Promise<string | null>; // an llm_judge rubric, from its blob
  judge: JudgeClient | null; // calls the judge model through egress's admin socket
  judgeSettings: JudgeSettings; // JUDGE_PROVIDER, JUDGE_MODEL, JUDGE_BASE_URL
  priceTable: PriceTable; // the experiment's frozen prices, for the judge's cost
}
interface ScorerResult {
  status: ScoreStatus;
  score: number | null; // 0 to 1 when passed or failed, null otherwise
  comment: string;
  value?: string;
  expected?: JsonValue;
  observed?: JsonValue;
  evidence?: ScoreEvidence; // event_seqs, artifact_ids, judge, trajectory, text, json_match, script, error
}
interface ScorerDefinition {
  type: ScorerType;
  version: number; // stored on each score row, part of the loader's check hash
  params: ZodType; // SCORER_PARAM_SCHEMAS[type]
  selfCheck: 'answer' | 'script' | 'workspace' | 'none';
  needsAnswer: boolean; // a missing or invalid answer makes the key ungradable
}
```

The registry maps `type` to its definition; `evaluation/score.ts` dispatches each key to its runtime and grades the keys one after another. A scorer that throws yields `status: error` with the message; it never yields a zero.

### 9.3 Scorers

| Type                | Params                                                                                                                                                               | Pass rule                                                                                                                                             | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `numeric_tolerance` | `path?`, `abs?`, `rel?`                                                                                                                                              | `\|observed − expected\| ≤ abs` or `≤ rel × \|expected\|`                                                                                             | ours; coerces numeric strings; non-number → `failed` with comment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `json_match`        | `path?`, `unordered?`, `inner_unordered?`, `exclude_keys?`, `pass_at` (default 1.0)                                                                                  | score ≥ `pass_at`: openevals' average json match, the share of an object's keys that match, or the paired items' credit over the longer list's length | ours, with openevals' scoring but optimal pairing in unordered lists, and no LangSmith tracing; `evidence.json_match` records the unit, matched and total, and the path of each mismatch down to the first differing value (`bands[2].net`, at most 50)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `exact_match`       | `path?`, `trim?`, `case_sensitive?`                                                                                                                                  | equality                                                                                                                                              | ours (openevals' version lacks the options)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `text_match`        | `path?`, `contains?` (phrases), `pattern?` (regular expression), `case_sensitive?` (default false), `pass_at` (default 1.0)                                          | share of phrases and pattern found ≥ `pass_at`                                                                                                        | ours; at least one phrase or a pattern, and the pattern is compiled at load (an invalid one is a load error); a JavaScript regular expression with the `u` flag, plus `i` unless `case_sensitive`, and no `m`, `s` or `g`; a value that is not a string is matched as its JSON text, capped at 64 KB before matching; each phrase and the pattern count once; the score is the share found; each match runs under a 1 s `node:vm` time limit, and a time-out is `error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `file_check`        | `root?: workspace \| home` (default workspace; Phase 6), `path`, `must_exist`, `format?: csv \| json \| text`, `columns?`, `row_count?`, `json_schema?`, `contains?` | all declared checks pass                                                                                                                              | ours, reads from the stored artifacts of its root; with `root: home` the path is under `memories/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `trajectory_match`  | `tool`, `args?` (subset match), `min_calls`, `max_calls?`, `mode?` (strict/unordered/subset/superset for full trajectories)                                          | count rule, or the trajectory match of `mode`                                                                                                         | ours, over the calls read from `tool_use`/`tool_result` events (a result paired by `tool_call_id`, else with the earliest open call of the same name). Count rule: calls named `tool` (an MCP tool as Hermes names it, `mcp__<server>__<tool>`) whose arguments hold `args` as a deep subset, between `min_calls` and `max_calls`. Argument values match exactly, so a path must be spelled as the agent sends it. With `mode`, the OpenAI-style message list built from the events is compared, with openevals 0.2.3's algorithms (a synchronous copy, checked against openevals itself), with a reference of `min_calls` calls of `tool` with `args`, each answered: `superset` at least those calls among others, `subset` no other tool and at most that many, `unordered` exactly those, `strict` the same with each result; `max_calls` is not read with a mode (the loader warns). Never `ungradable`; unreadable events give `error`                                        |
| `verifier_script`   | `script`, `timeout_s` (default 30), `pass_at` (default 1.0)                                                                                                          | printed score ≥ `pass_at`                                                                                                                             | runs `python3 verify/<script> --answer <tmp>.json --workspace <dir> --home <dir>` in the worker, outside any trial, with the verifier files and the attempt's artifacts materialised from blobs into a temp dir (`--home` holds the collected home files, an empty folder when there are none; always passed since Phase 6, version 2, so a script with a strict argument parser must declare it); no stdout line or bad JSON → `error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `llm_judge`         | `rubric` (file in task dir), `pass_at` (default 0.7), `model?`                                                                                                       | judge score ≥ `pass_at`                                                                                                                               | ours (openevals' `createLLMAsJudge` sets no temperature or token cap and returns no usage). The model is `model:`, else `JUDGE_MODEL`, on `JUDGE_PROVIDER` (`nous` when unset; `JUDGE_BASE_URL` for `custom`); launch and Re-score answer 409 for a selected task with a key that has neither (Phase 4), and a key that still has none at scoring time is `error`. The call goes through egress's admin socket (section 9.5): temperature 0, at most 4,096 tokens, 60 s, one retry on a transport error or a 5xx. The system message gives the rubric, the task prompt and the reference as facts; the agent's final text (at most 65,536 characters) is the user message, between two marker lines carrying a fresh 128-bit boundary that no input contains, as untrusted data. The answer must be one JSON object with a `score` from 0 to 1 and a `comment`, parsed strictly; anything else, a refusal or a provider that is not ready is `error`; no final text is `ungradable` |

`scorer_version` is a constant per scorer bumped on behaviour changes, stored on each score row.

### 9.4 Re-score and publishing

Scoring is a claim, then pure computation, then one publish transaction:

- **Claim**: `UPDATE evaluations SET status = 'running', started_at = now(), claim_token = gen_random_uuid(), claim_expires_at = now() + interval '10 minutes' WHERE id = $1 AND status IN ('queued', 'running') RETURNING claim_token`. A redelivered job takes a new token; zero rows means it already finished.
- **Score**: scorers read blobs, events and the answer, and write nothing but the claim's renewal after each key (`claim_expires_at` moved on while the token still matches; otherwise the delivery drops its work). pg-boss fails an active job at its expiry whatever its heartbeats say, so the loader bounds what a task's checks may declare (`MAX_SCORING_SECONDS`, 3600 s) and the `evaluate-run` expiry sits above it (4200 s); a delivery whose job pg-boss failed under it (`job.signal`) stops at its next key.
- **Publish**, one transaction: lock experiment then run; re-read the evaluation `FOR UPDATE` with the claim token (zero rows: a newer delivery owns it, roll back); insert every score in one statement; supersede the previous current evaluation; complete this one (the database checks current attempt, complete key set, newest generation); set the run `scored`; reconcile.
- **Re-score** (`POST /runs/:id/rescore`, bulk variant): insert an evaluation with the next generation and send `evaluate-run` in one transaction. One evaluation per run can be queued or running, so double clicks collapse: a request while one is pending answers 200 with that evaluation (`joinedPending`). Only a `scored` run can be re-scored (409 otherwise), in any experiment status and with no frozen-revision gate, since scoring never runs Hermes; it answers 409 when an `llm_judge` key resolves no judge model, or one whose provider is not ready. The run stays `scored` and its result stays current until the new generation publishes. It grades the experiment's frozen task with the scorers as they are now in code, and each row records its `scorer_version`.
- **Dead letter**: when `evaluate-run` exhausts its retries, the dead-letter handler publishes one `error` score per key for a first evaluation, so the run still reaches `scored`, or marks a re-score `failed`, leaving the previous result current.

If the experiment is completed, publishing raises the results revision and reconcile appends a verdict entry per candidate with cause `rescore` (section 7.4).

### 9.5 Judge cost accounting

The worker holds no provider key and has no TCP route to egress, so each judge request goes through egress's admin socket like an attempt's model calls: `PUT /judges/<id>` registers it (kind `judge`, the judge model only, no MCP, no CONNECT, a 200,000-token cap, a life of minutes), `POST /judges/<id>/chat/completions` forwards each call with the model gateway's own code (the upstream per provider, egress's keys, `CUSTOM_API_KEY` for `custom`, nous-proxy for Nous), and `DELETE /judges/<id>` in `finally` returns the usage egress metered. The score row records it in `evidence.judge`: provider, model, calls, `tokens` (input, output, total), `cost_usd` priced from the experiment's frozen price table (null when the model is unpriced), latency, finish reason, and `call_log`, each call's status and latency as the worker saw it (Phase 4). Egress logs each judge call it refuses before forwarding. Judge cost is grading cost: the spend guard does not count it, and `docs/costs.md` separates execution cost from grading cost.

---

## 10. Statistics and comparison

Built in Phase 4 (`docs/phases/phase-4.md` sections 3.3 to 3.8): the pure module `apps/api/src/statistics`, and `apps/api/src/experiments/comparison`.

### 10.1 Inputs

For a candidate version against the baseline, for the selected score key (`primary` by default, or a named key present on every task, or `any_failed`):

- Per task, per configuration: the set of runs whose status is `scored` or `execution_error` (counted as not passed). `cancelled` runs are excluded, and so are runs still queued, running, executed or scoring. A run is "passed" when the selected key's status is `passed`; `failed`, `error` and `ungradable` all count as not passed, and are reported separately. A run's result is its current evaluation, so a re-scored run counts once, and a run whose re-score is pending counts with its current result.
- Under `any_failed` a run's status is `failed` when any key failed, else `error` when any errored, else `ungradable` when any was ungradable, else `passed`.
- Pass rate per task per configuration = passed / counted.

### 10.2 Computation

- Observed difference = mean over tasks of (candidate rate − baseline rate): every task weighs the same, however many runs it counted.
- Bootstrap: resample the task list with replacement 10,000 times, recompute the mean difference each time with each task's runs kept together, take the 2.5th and 97.5th percentiles with linear interpolation between order statistics ("type 7", R's default). The PRNG is mulberry32 seeded with the first four bytes of `sha256(experimentId)` read big-endian, so the same results always give the same interval. A bound within 1e-9 of 0 is 0, and bounds are kept within [−1, 1].
- Verdict: `better` if lo > 0, `worse` if hi < 0, else `inconclusive`. `provisional` while the experiment is running or paused.
- Gate: statistics are computed only when every selected task has ≥ 2 counted runs per configuration; otherwise `not_computable` with, in this order, `single_repetition` (the experiment has 1 repetition), `nothing_scored` (no run of the two configurations counts yet; an execution error counts) or `not_enough_runs`, and the sentence the panel shows.
- Sensitivity: the same difference and interval (same seed, same gate) computed excluding runs whose status is `execution_error` or key status is `error`/`ungradable`, reported beside the main figure with its own verdict and whether the verdict changes; absent when nothing was excluded.
- Secondary metrics per configuration, over its counted runs: median duration, mean tokens, cost (each run's priced attempts), execution error count with the categories, ungradable count, and the candidate's difference from the baseline.
- `suggestRepetitions` estimates the repetitions per task an interval of a given half-width needs, separating the binomial noise of each task's rates from the spread between tasks; it is for the Phase 8 report, not the API.

### 10.3 Endpoints

`GET /experiments/:id/comparison?candidate=&key=&filter=` returns the task grid rows (cells with run id, statuses, duration, primary comment), per-task rates and deltas, the statistics block or why there is none, secondary metrics, the sensitivity figure, progress, and the candidate and key options. It reads in a `REPEATABLE READ READ ONLY` transaction whose first statement reads the experiment row, `results_revision` included, and is cached in process (two LRUs of 200 entries: views, and each experiment's figures on the primary key) by `(experiment, candidate, key, filter, results_revision, status, configuration names)`. Because the revision moves on every run status change and every published or superseded score set, a retry, cancellation, execution error or re-score can never serve a stale comparison; the status covers completing, pausing and resuming, and the names a rename, none of which moves a run. It answers 404 for an unknown experiment and 400 for a candidate the experiment does not test or a key some selected task lacks.

Verdict history lives on the experiment (section 7.4): one entry per candidate per results revision, on the primary key, with its cause, note, numbers and the revision it was computed from. The VerdictCard shows the last entry and the ones before it as "Updated … · previously …"; the experiment list's chips, the live `experiment` event and each configuration's usage show the last one. While an experiment runs, the cards show the provisional figures; an experiment completed before Phase 4 shows its figures computed live.

### 10.4 Verification of the statistics module

A unit test feeds the illustrative 12 × 5 × 2 dataset from the design and asserts the same numbers the design shows (0.633, 0.850, +0.217, interval within ±0.02 of [+0.117, +0.333] given the seed), and a second test asserts `inconclusive` on the Flow B dataset. As built, both datasets are imported from the web fixtures; with the seed of the design's experiment id the interval is exactly [7/60, 20/60], and Flow B gives +0.056 [−0.111, +0.250].

---

## 11. API surface

Prefix `/api`. JSON bodies validated by `ZodValidationPipe` with schemas from `shared` (`packages/shared/src/contracts`); Swagger at `/api/docs` is generated from the same schemas. State-changing requests need `X-Requested-With` and an allowed `Origin` and `Host` (section 6.1). Errors: `{ statusCode, message, issues? }`. Pagination: `?limit=&cursor=` on list endpoints; runs default to 200 per page.

| Method, path                                                                                                                                                                                                                                                                                                                        | Purpose                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                                                                                                                                                                                                                                                                                       | exists                                                                                                                                                                                                                                                                              |
| `GET /system/summary`, `GET /system/workers`, `GET /system/sandbox`                                                                                                                                                                                                                                                                 | workers, running experiments `{count, scored, total}`, queued runs; every worker with presence, slots and its effective concurrency (`max(1, min(concurrency, slots))`, Phase 4); the newest live worker's isolation report (built in Phase 1)                                      |
| `GET /system/events` (SSE)                                                                                                                                                                                                                                                                                                          | running summary and worker presence every 5 s                                                                                                                                                                                                                                       |
| `GET /suites`, `GET /suites/:id`, `GET /suites/:id/tasks/:key`, `POST /suites/reload`                                                                                                                                                                                                                                               | section 4                                                                                                                                                                                                                                                                           |
| `GET /suites/:id/history`, `GET /suites/:id/tasks/:key/history`, `GET /suites/:id/tasks/:key/diff?against=:suiteId`                                                                                                                                                                                                                 | every version of a suite directory with its changes and the experiments that used it; a task's versions; a task diff between two suite versions (section 4.5)                                                                                                                       |
| `GET /suites/:id/tasks/:key/fixtures/:path`, `…/fixtures/:path/preview`                                                                                                                                                                                                                                                             | fixture download; the first rows of a CSV or TSV fixture                                                                                                                                                                                                                            |
| `POST /suites/drafts` (name, label, description, from: empty, copy of a suite, or a validated zip token), `GET/PATCH/DELETE /suites/:suite/draft` (read; label, description, order; discard)                                                                                                                                        | suite drafts (section 4.6, Phase 5b)                                                                                                                                                                                                                                                |
| `POST /suites/:suite/draft/tasks` (blank, duplicate of a task, or restore of a task version), `GET/PUT/DELETE /suites/:suite/draft/tasks/:key`, `POST …/tasks/:key/revert`                                                                                                                                                          | draft tasks; delete marks the task removed, revert restores the base                                                                                                                                                                                                                |
| `POST /suites/:suite/draft/tasks/:key/files` (multipart, kind fixture or expected), `PATCH/DELETE …/files/:path`                                                                                                                                                                                                                    | workspace and expected files; any path under `verify/` is refused                                                                                                                                                                                                                   |
| `GET …/tasks/:key/readiness`, `POST …/tasks/:key/self-check`, `POST …/tasks/:key/try` (check key and a sample reply)                                                                                                                                                                                                                | readiness rules, worker self-check, answer-check try                                                                                                                                                                                                                                |
| `POST /suites/:suite/draft/import/validate`, `POST /suites/:suite/draft/import` (CSV or JSONL, mapping, shared settings)                                                                                                                                                                                                            | import tasks into a draft                                                                                                                                                                                                                                                           |
| `POST /suites/import/validate`, `POST /suites/import` (zip, then token)                                                                                                                                                                                                                                                             | import a suite as a new draft                                                                                                                                                                                                                                                       |
| `GET /suites/:suite/draft/review`, `POST /suites/:suite/draft/save`, `POST /suites/:suite/draft/rebase`                                                                                                                                                                                                                             | review, save as the next version (409 conflict, 422 not saved, 503 no worker), combine onto a newer version                                                                                                                                                                         |
| `GET /suites/:suite/versions/:n/zip`                                                                                                                                                                                                                                                                                                | download a version's files                                                                                                                                                                                                                                                          |
| `GET/POST /resources/skills`, `POST /resources/skills/validate`, `GET /resources/skills/:id`, `GET /resources/skills/:id/files/:path`, `GET /resources/skills/:id/zip`                                                                                                                                                              | section 5.1                                                                                                                                                                                                                                                                         |
| `GET/POST /resources/documents`, `GET /resources/documents/:id/content`                                                                                                                                                                                                                                                             | section 5.2                                                                                                                                                                                                                                                                         |
| `GET/POST/PUT /resources/mcp-servers`, `POST /resources/mcp-servers/:id/test`, `POST /resources/mcp-servers/test` (unsaved definition)                                                                                                                                                                                              | section 5.3                                                                                                                                                                                                                                                                         |
| `GET /resources/secrets`, `GET /resources/counts`                                                                                                                                                                                                                                                                                   | per name: set/not set, source (worker or egress), referenced by, exposure; the Resources tab counts                                                                                                                                                                                 |
| `GET /providers`, `POST/GET/DELETE /providers/nous/login`, `POST /providers/nous/logout`                                                                                                                                                                                                                                            | model access status and the Nous connect flow (section 6.1)                                                                                                                                                                                                                         |
| `GET/POST /configurations`, `GET /configurations/:id`, `PUT /configurations/:id` (new version when frozen), `GET /configurations/:id/versions/:v`, `GET /configurations/diff`, `GET /configurations/form-options`, `GET /configurations/new-draft` (Phase 5), `GET /configurations/:id/draft`, `POST /configurations/:id/duplicate` | section 6                                                                                                                                                                                                                                                                           |
| `GET /experiments`, `POST /experiments`, `GET /experiments/:id`, `GET /experiments/new-options`, `GET /experiments/estimate` (optional `budget`)                                                                                                                                                                                    | section 7                                                                                                                                                                                                                                                                           |
| `POST /experiments/:id/pause`, `/resume`, `/cancel`, `/retry-failed`, `/duplicate`                                                                                                                                                                                                                                                  | section 7.3                                                                                                                                                                                                                                                                         |
| `GET /experiments/:id/events` (SSE)                                                                                                                                                                                                                                                                                                 | run status transitions with each run's generation and pending re-score, scores landed, counts, experiment status and verdicts (also when a verdict entry is appended); polled from Postgres every 1 s per subscriber with a shared poller per experiment                            |
| `GET /experiments/:id/comparison`                                                                                                                                                                                                                                                                                                   | `?candidate=&key=&filter=`: one candidate against the baseline, the task grid, the statistics or why there are none, sensitivity, secondary metrics and progress, cached by results revision; 404 unknown experiment, 400 unknown candidate or key (section 10.3, built in Phase 4) |
| `GET /experiments/:id/runs` (filters: config, task, status, score_status, exec_error, ungradable; sort)                                                                                                                                                                                                                             | Runs tab                                                                                                                                                                                                                                                                            |
| `POST /experiments/:id/runs/rescore`, `POST /experiments/:id/runs/retry` (bulk, body: run ids, 1 to 500, unique)                                                                                                                                                                                                                    | bulk bar: per run, accepted or refused with its reason; Re-score also answers each accepted run's evaluation (generation, status, `joinedPending`), joined runs included                                                                                                            |
| `GET /runs/:id` (header, outcome, attempts, artifacts and counterpart as fields), `GET /runs/:id/events?after=` (at most 2,000 events a page), `GET /runs/:id/artifacts/:artifactId/content`, `GET /runs/:id/artifacts/:artifactId/preview`                                                                                         | inspector                                                                                                                                                                                                                                                                           |
| `POST /runs/:id/rescore`, `POST /runs/:id/retry`, `POST /runs/:id/cancel`                                                                                                                                                                                                                                                           | inspector actions. Re-score answers 200 with the new or the pending evaluation, and 409 when the run is not scored, or a judge key has no model or its provider is not ready (section 9.4)                                                                                          |

SSE event shapes are zod schemas in `shared`; the web `useSse` composable validates each event and reconnects with backoff 1, 2, 5, 10 s, showing `reconnecting` and `offline` states as designed.

---

## 12. Frontend

### 12.1 Foundations

- **Styling is Tailwind CSS** (decision 24 Oct 2026). The design tokens stay CSS variables in `tokens.css`, switched by `data-theme`, and map into Tailwind's theme (`@theme inline`), so utilities like `bg-surface` and `text-fail-text` follow both themes. The hand-ported global stylesheet (`src/assets/main.css`, about 1,160 lines of canvas classes) was replaced by utilities in the components at the start of the frontend phase, with a small `@layer components` only for patterns repeated everywhere (buttons, chips, tags, inputs, data tables). Built in Phase 5 as `src/assets/app.css`: one spacing step is 1px, so the boards' numbers copy as written, and Tailwind's default colours, sizes, radii and shadows are removed, so only the tokens exist (`apps/web/CONTRIBUTING.md`). `IBM Plex` loading is done; density and status chip styles come from the status mapping on the visual direction board.
- `StatusChip` takes `status` and `kind` (run, score, experiment, verdict, and the provider, pause reason, category, evaluation, MCP test, secret, sandbox and worker kinds) and derives tone, dot mode and label from one table, `apps/web/src/lib/statusTones.ts`, keyed by the values the API returns, so the API and UI agree.
- `DataTable` with declared columns, sort state via `v-model:sort`, selection, density, loading skeletons, error banner, `liveKeys` (sorting on a live column freezes order until re-sort). It is not virtualised; the Runs table (above 500 rows) and the inspector's timeline (above 200 events) virtualise with `@vueuse/core`'s `useVirtualList`.
- `useUrlState` mirrors filters and sort into the query string.
- `useSse(url, schema)` wraps EventSource with validation and state: the API's named events, reconnect after 1, 2, 5, then every 10 s, offline after 30 s, and the stream closed while its page is hidden (the six HTTP/1.1 connections per host are shared by every tab).
- `useKeyboardGrid` for arrow keys in TaskGrid.
- `usePolling` for the experiment list and the inspector's live run (no overlapping calls, paused in a hidden tab), and `useFocusTrap` for dialogs and drawers.
- Every `src/api/<domain>.ts` function parses its answer with the shared schema in live mode, the default in `pnpm dev` and the Compose image; `VITE_API_MODE=fixtures` serves `src/fixtures` and the `?scenario=` states.

### 12.2 Pages, in build order (Flow A order)

1. Model access (System page card, section 6.1): provider rows with status chips, the Nous connect flow in all its states, `ConnectDialog`, and every nudge in the section 6.1 table (setup card, AppShell banner and approval pill, configuration form notice, New experiment blocker, disabled controls, the `provider_disconnected` pause). First, because nothing else can run a model without it.
2. Resources: Skills (list, upload dialog with validate step, detail panel), Documents, MCP servers (form with transport explanation, test start), Secrets.
3. Configurations: list with compare, form (versioning banner, change summary, toolsets from `GET /configurations/form-options`, unknown model warning), detail (fields, versions, used-in).
4. New experiment: five numbered sections, `ExperimentSummaryPanel` with live estimate from `/experiments/estimate`, invalid task rows, inline diff, launch with 409 handling.
5. Experiment overview: running (progress breakdown, per-config bars, feed, pause/resume/cancel with `ConfirmInline`, spend line, no-worker banner, paused-by-ceiling state) and complete (`VerdictCard` with history line, aggregates, snapshot strip, duplicate).
6. Comparison: controls, `TaskGrid` with `RepetitionCells` and tooltips, `IntervalBar`, statistics text, secondary metrics, sensitivity, provisional and nothing-scored states, one-repetition state, candidate select.
7. Runs tab: filters in URL, count chips, bulk bar with the retry rule.
8. Run inspector drawer: route-backed, prev/next (J/K) over the caller's ordered ids, A/B jump with disabled reasons, five sections, `TimelineScrubber`, `EventTimeline` virtualised above 200 events, `JsonBlock`, artifacts with CSV/text preview, launch record; states for execution_error, running (live, Jump to latest), cancelled, ungradable, scorer error, multi-attempt.
9. Suites: list with reload (New suite, Import .zip and the draft chip belong to item 12), detail with self-check failure expansion, task detail with prompt, fixtures preview, `VerificationSentence`, hidden reference panel, verifier source, self-check panel, history. Version numbers, the suite History panel, task version history with diffs, and the newer-version notice on older experiments (section 4.5).
10. Experiment list with live rows (polled every 5 s while anything runs) and the failed-experiment reason.
11. System page (exists) gains workers and secrets presence.
12. Suite authoring (Phase 5b, section 4.6), from the canvas page "Suite authoring":
    - pages and views: NewSuite, the suite draft mode with `SuiteDraftBar`, TaskEditor (Form, Files and task.yaml tabs) with the sticky `ReadinessPanel`, ImportTasks, ImportSuiteDialog, SaveDraft with `SaveSteps`, and the draft-conflict views;
    - components: `ZoneLabel`, `MarkdownEditor`, `JsonEditor`, `YamlEditor`, `FileDropZone`, `TaskFileTree`, `CheckPicker`, `CheckCard` (one variant per check type), `ColumnMapper`;
    - Flow E end to end.

Items 1 to 11 were built in Phase 5; `docs/phases/phase-5.md` section 3.2 maps each route to its boards and states, and its section 2.2 lists where a page departs from its board.

### 12.3 State

Pinia stores per domain hold normalised records keyed by id and expose loaders. SSE updates patch records in place so rows never reorder while live. The drawer reads the run from the store if present and fetches details lazily. An experiment page holds one stream: its store patches the record, passes `run` events to the Runs rows and the Comparison, and refetches what the events do not carry (`docs/phases/phase-5.md` section 3.5).

### 12.4 Tests

Vitest with `@vue/test-utils` and jsdom, on fixtures, for: StatusChip mapping, IntervalBar domain and aria label, RepetitionCells statuses, ConfigDiffTable differs count, ExperimentSummaryPanel maths and disabled reasons, JsonBlock extraction highlight, useSse reconnect states, TaskGrid keyboard navigation. Phase 5b adds: CheckCard params per type and its rule line, ReadinessPanel states, the form and task.yaml tabs staying in sync (and the form locking while the YAML has an error), ColumnMapper validation, and SuiteDraftBar conflict states.

---

## 13. Observability

- Structured logs via pino in both processes with `runId`, `attemptId`, `experimentId` bound per job.
- Platform metrics as log lines (no Prometheus dependency): queue depth per queue, worker in-flight, attempt duration, execution errors by category, scorer errors by type, spend per experiment.
- Each attempt's `launch_record` plus `stderr.log` makes any run reproducible by hand from the command shown in the inspector.
- Redaction: pino redact paths for anything named `*key*`, `*token*`, `authorization`; the launch record stores secret env names only, shown as `<from env NAME>`; `config.yaml` holds only `${NAME}` references, which the stored copy shows as `<from env NAME>`; stderr tails have the passed values replaced.

---

## 14. Security boundaries

- **Trial container**: the boundary for everything the agent and its MCP stdio servers do. Read-only root, uid 10000, no capabilities, no new privileges, PID, memory and CPU limits, tmpfs `/tmp`, two volume-subpath mounts, one internal slot network with no route to the host, Postgres, the API, other trials or the internet.
- **Egress**: the trial's only way out. Per-attempt token, host resolved once and private ranges refused before connecting, allowlist mode (the model and MCP gateways only; CONNECT to any host is refused) unless the configuration enables web or browser toolsets, in which case any public host. http MCP servers are reached only through the MCP gateway, never by CONNECT. Not on the backend network, so `postgres` and `api` do not even resolve there. Residual risk: domain fronting through an allowed CDN host, documented in `docs/limits.md`.
- **Docker socket**: root-equivalent on the host, and under Colima or Docker Desktop that includes the user's home directory. Only docker-guard holds it; the worker reaches a filtered subset that can start nothing but trial containers of the pinned image.
- **Credentials**: provider keys and http MCP header values live in egress; the Nous login lives in nous-proxy's volume. The LLM judge's calls go through egress's admin socket like an attempt's (`/judges/<id>`, one short-lived registration per judge request, metered, and removed in `finally`; section 9.5), so neither the worker nor the API holds a provider key: Compose blanks every key `.env` holds in their environments, which a verifier script (run as the worker's uid) could otherwise read. Trials hold a revocable per-attempt token and, only when a configuration includes a stdio MCP server, that server's env values, which the agent can read (section 5.3). The UI labels every such value "Readable by the agent" and advises scoped or throwaway values; a secret that must stay out of reach belongs to an http server, where egress adds it.
- **MCP gateway**: forwards only to a definition's exact URL, follows no redirects, adds that definition's headers, and logs each call per attempt (section 5.3).
- **Nous login service**: `nous-login` holds the device flow and writes the login into `nous-home`; it returns no token to anyone. It sits only on the internal `provider-admin` network with the API and the worker (and on `edge` to reach the portal), so trials and egress cannot reach it. Its state-changing API routes require a JSON body and `X-Requested-With`, so other sites in the user's browser cannot drive them.
- **Verifier scripts**: user-provided code, run by the worker outside any trial against materialised artifacts, with a 30 s timeout and a minimal environment. Optionally run in a `network: none` container through the guard.
- **Suites folder** (Phase 5b): the worker's `./suites` mount becomes read-write for the save handler alone. It writes through a dot-named staging folder and a rename, under the folder's lock. Draft endpoints refuse `verify/` paths, so the browser can't add code, except through an explicitly confirmed zip import (section 21, R7).
- **Collection**: lstat walk, no symlink following, special files and undecodable names never opened, caps on depth, count and size, after the container is removed (section 8.5).
- **Disk**: home and workspace capped at 2 GiB and 50,000 files while the trial runs; the container is killed when either is passed (section 8.2).
- **Ports**: Postgres, the API and the web app are published on `127.0.0.1` only, for local development; nginx proxies `/api`. Trials have no route to the host, so they cannot reach these ports.
- **API**: no auth, by requirement (single local user); CORS restricted to the web origin. Unreachable from trials.

---

## 15. Packaging and configuration

- **Services**: postgres, api, worker, web, docker-guard, egress, `trial-image` (build-only: builds or pulls the pinned Hermes image and exits), nous-proxy and nous-login (both start by default; without a login they report `not_connected` and egress answers Nous model calls with 503 "Nous Portal is not connected"); `mock-model` (profile `test`, the scripted mock model); `vendor-directory` (profile `samples`, the sample http MCP server, built FROM the trial image; Phase 6).
- **Networks**: `backend` (postgres, api, worker, web), `edge` (egress, nous-proxy, nous-login, internet), `llm` (internal: egress to nous-proxy), `provider-admin` (internal: api and worker to nous-login), `mcp-samples` (internal: egress to the sample http MCP servers, no trial attached; Phase 6), and four internal slot networks `hermes-evals-trial-0..3` with isolated gateway mode (Engine 28+; `inhibit_ipv4` on older engines), each shared only by one trial and egress.
- **Volumes**: `pgdata`; `evaldata` (blobs, skills; worker and api only); `hermes-evals-trials` (trial homes and workspaces; worker, and two subpaths per trial); `guard-sock`, `egress-admin` (unix sockets shared only with the worker); `nous-home`. The worker mounts `./suites` read-only until Phase 5b, then read-write for saving drafts (section 4.6).
- **Images**: the worker image no longer installs Hermes, git or uv. The trial image is `FROM nousresearch/hermes-agent:v0.22.4@sha256:7a69201726bc64db2072a1371557137c23312d29705cda2b8ea2a0214a50a4cf` with the entrypoint replaced, uid 10000 and the sample stdio MCP server `invoice-db` baked in: one 1.1 GB pull instead of a 15 to 45 minute source build. `hermes-evals/vendor-directory` is built FROM it and adds the http sample's server and data, no dependency.
- **Credentials**: `.env` holds API-key provider credentials, read by egress only: the api and the worker load `.env` for their settings and the stdio MCP values, and Compose blanks each provider key there (`x-no-provider-keys`), so they learn only from egress whether each is set. MCP secret values: stdio env values are read by the worker, http header values by egress; Compose blanks the sample's `VENDOR_DIRECTORY_TOKEN` for the api and the worker (`x-egress-only-values`) and gives egress `Bearer <token>`. Nous Portal is connected from the UI (section 6.1); the terminal command `docker compose run --rm nous-proxy auth add nous --type oauth --no-browser` remains as a fallback. For development, `NOUS_HOST_PROXY` reuses the host's Hermes login instead. Nothing per trial.
- **Migrations** run at boot in api and worker under an advisory lock; a database that is unreachable leaves the process degraded, a migration whose recorded hash differs stops it. `apps/api/package.json` ships `dist` and `drizzle`; both Dockerfiles check the journal is present.
- **Machine requirements**: Docker Engine 26+ (volume subpaths; archive-copy fallback otherwise). Colima `--memory 8` or Docker Desktop with at least 6 GB for three concurrent trials; the README states this.
- **Env additions**: `MAX_CONSECUTIVE_EXECUTION_ERRORS=14`, `TRIAL_RETENTION_DAYS=7`, `PRICES_FILE`, `TRIAL_IMAGE`, `TRIAL_SLOTS`, `DOCKER_SOCK` (guard only); `JUDGE_PROVIDER`, `JUDGE_MODEL`, `JUDGE_BASE_URL` (api and worker, unset by default, section 9.3) and `MODEL_TOKEN_CAP_PER_ATTEMPT` (worker and egress, 2,000,000 by default); `VENDOR_DIRECTORY_TOKEN` (egress and `vendor-directory`, Phase 6; any random string for the sample) and `INVOICE_DB_URL` (the worker, from the shell or `.env`).

---

## 16. Testing strategy

| Layer           | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | How                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| shared          | every zod schema accepts the sample suite and rejects known-bad variants                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | vitest                                         |
| api unit        | loader hashing and validity rules, configuration versioning rule, experiment matrix size, estimate maths, state transitions, statistics (section 10.4), answer extraction edge cases (no block, several blocks, invalid JSON)                                                                                                                                                                                                                                                                                                               | vitest, no DB                                  |
| api integration | migrations, constraints and integrity triggers (`schema.spec.ts`, `integrity.spec.ts` on PGlite); concurrent migrations, node-postgres types, transactional enqueue and concurrent claiming (`postgres.e2e-spec.ts` on Postgres 17)                                                                                                                                                                                                                                                                                                         | vitest; e2e needs `TEST_DATABASE_URL`          |
| scorers         | each scorer against fixtures: pass, fail, error, ungradable paths; verifier runner timeout; judge with an in-process fake judge client, and egress's judge path against a fake upstream                                                                                                                                                                                                                                                                                                                                                     | vitest                                         |
| hermes adapter  | stream parser against recorded JSONL from the spike, exit classification table, deadline stop of a stub container                                                                                                                                                                                                                                                                                                                                                                                                                           | vitest                                         |
| sandbox         | docker-guard refuses every forbidden create body and endpoint; egress refuses every private-target encoding and wrong token; isolation self-test                                                                                                                                                                                                                                                                                                                                                                                            | vitest with fixtures; Colima for the self-test |
| worker e2e      | one task through execute and evaluate with a stub trial image that emits a canned stream, so CI never needs a model                                                                                                                                                                                                                                                                                                                                                                                                                         | vitest + Compose Postgres                      |
| model access    | `nous-login` in the real trial image against a fake portal (`HERMES_PORTAL_BASE_URL`): approve, deny, expiry, `subscription_required`, cancel, a second Connect replacing the first, and nous-proxy serving the new login without a restart; the startup contract check; API routes with a fake login client, including the `X-Requested-With` rule and the 409 on launch; the provider guard pausing with `provider_disconnected` without spending an attempt; component tests for `ConnectDialog` and each nudge in the section 6.1 table | vitest                                         |
| suite authoring | round trip: loading a folder into a draft and saving with no edit reports `unchanged`, and hand-written comments survive a form edit; the save conflict check (version moved, and on-disk files edited without a reload); staging failure leaves disk untouched; refusal of `verify/` paths; zip import refusals; CSV mapping; readiness rules, including the leak and mentioned-file checks                                                                                                                                                |
| web             | component tests listed in 12.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | vitest + Testing Library                       |
| manual          | the four flows from the design, run against the Compose stack with the real Hermes, recorded for the video                                                                                                                                                                                                                                                                                                                                                                                                                                  | checklist in `docs/flows.md`                   |

CI is a GitHub Actions workflow running `pnpm turbo run typecheck lint test build` plus the integration suite with a Postgres service container. Docker images build in CI without pushing.

---

## 17. Phases and exit criteria

Each phase ends with its tests green and a review document, `docs/phases/phase-<n>.md` (what changed, design, flows, how to test), which the user approves before the next phase starts. The isolation spike comes first because every later execution contract depends on it.

### Phase 0: Isolation and Hermes spike (2 days)

Run spikes I1 to I10 (section 21) on Colima: pinned trial image, hardened container, slot networks, egress refusal tests, model gateway with a real task, kill and crash recovery, guard refusals, budgets and skills, three concurrent trials.

Exit: `docs/hermes-adapter.md` with the verified launch contract, recorded stream-json fixtures, and a passing isolation self-test.

### Phase 1: Data layer and definitions (built 24 Oct 2026; see `docs/phases/phase-1.md`)

Built: the suite loader in the worker (blobs, self-checks, expected workspaces, version numbering); the scoring core it needs (moved from Phase 3: registry, extraction, `numeric_tolerance`, `json_match`, `exact_match`, `file_check`, verifier runner); skills, documents, MCP servers with Test start in a throwaway trial container, secrets presence; configurations with versions, freeze, diff and duplicate; worker presence; contracts as zod schemas in `shared`; migrations 0002 and 0003; the sample stdio MCP server `invoice-db` (moved from Phase 6) in the trial image.

Exit: `docker compose up` serves suites, resources and configurations (`scripts/phase1-smoke.sh`); unit, PGlite, Postgres 17 and gated real-container tests green.

### Phase 2: Execution and sandbox (built 25 Oct 2026; see `docs/phases/phase-2.md`)

docker-guard and egress services with their unit tests (malicious create bodies, bypass fixtures); trial materialisation calls `refusedEnvNames` before any MCP env enters a trial, and `execute-run` keeps `workers.in_flight` current; the egress MCP gateway route and secret presence on its admin socket (section 5.3); `nous-login`, the `providers` API module and the launch check for an unconnected provider (section 6.1); trial runner through the guard; claim, admission, leases, heartbeat, recovery and isolation self-test; launch, pause, resume, cancel, spend guard, circuit breaker, reconcile; SSE.

Exit: a 3-task × 2-configuration × 2-repetition experiment runs end to end in containers; the fake-Hermes e2e test (a stub image emitting canned stream-json) is green.

### Phase 3: Scoring (built 25 Oct 2026; see `docs/phases/phase-3.md`)

Built: the `text_match` scorer (the eighth type, added in the design on 25 Oct 2026: the shared params schema, migration `0006`, the loader's pattern rule, the self-check), the `trajectory_match` and `llm_judge` runtimes, the judge client through egress's admin socket (`/judges/<id>`, section 9.5), the claim renewed after each key and the bound on how long a task's checks may declare to take (section 9.4), re-score single and bulk, and the Phase 2 follow-ups: `tool_search` off in every trial, the per-attempt token cap at the model gateway, `localConcurrency` capped at the slots, the structured `network` field on every timeline network row, the frozen-revision 409 on Retry, and the refusal of MCP servers whose names sanitise alike. Claim, publish and the dead-letter handler were built in Phase 2; extraction, the registry, the other five scorers and the verifier runner in Phase 1.

Exit: scorer tests green; for every one of the eight types, seeded right and wrong answers produce the right statuses (passed, failed, error, ungradable) end to end through `evaluate-run`; duplicate deliveries publish once; a re-score publishes a new generation and supersedes the old one; the live check on the Compose stack passes (`scripts/phase3-smoke.sh`).

### Phase 4: Analysis (built 25 Oct 2026; see `docs/phases/phase-4.md`)

Built: the statistics module (`apps/api/src/statistics`: per-task pass rates, the mean difference, the paired bootstrap over tasks seeded from the experiment id, the gate and its reasons, sensitivity, secondary metrics, `suggestRepetitions`), `GET /experiments/:id/comparison` cached by results revision, status and configuration names, the verdict history appended by reconcile once per results revision (causes `initial`, `retry`, `rescore`) and read by the Overview, the list, the live stream and the configuration usage, migration `0007`, and the Phase 3 follow-ups decided in `docs/phases/phase-3.md` section 7.4: the 409 for a judge key with no model, the SSE run event's generation and pending re-score, the score evidence in the run detail, the judge's 4,096 tokens and call log, the execution-error category `limit`, the loader's MCP tool-name warning and rubric rule, the `load-suites` bound, the workers' effective concurrency and nginx resolving `api` per request. Estimates were built in Phase 2.

Exit: the statistics unit tests reproduce the design's numbers and the Flow B `inconclusive` (section 10.4); the comparison endpoint is tested end to end, including a fresh answer after every kind of results-revision change (retry, cancel, execution error, re-score); a verdict entry is appended once per revision; on the Compose stack with the mock model, one experiment reaches `better` and one stays `inconclusive`; `docs/phases/phase-4.md` is written.

### Phase 5: Frontend (built 26 Oct 2026; see `docs/phases/phase-5.md`)

First, move the web app to Tailwind CSS (section 12.1). Then pages in the order of section 12.2, each against the real API, with component tests. The System page shows the isolation self-test and, first, the Model access card with the Nous connect flow.

Built: Tailwind CSS v4 over the tokens; every page of section 12.2, items 1 to 11, with the shared UI, the composables (`useSse`, `usePolling`, `useUrlState`, `useKeyboardGrid`, `useFocusTrap`) and a Pinia store per domain; a data layer that parses every answer with its shared schema and runs live by default; and the Phase 4 follow-ups settled for this phase (the reserved key names, the comparison's cost, `too_few_tasks`, the fixtures' computed figures, a failed experiment's provisional comparison, the token cap's 402, judge keys with no model), plus `GET /configurations/new-draft`, the verdict reasons on the list and the configuration usage, and `ExperimentDetail.cancelledAt`. Flows A to D were walked in the browser on the Compose stack with real Hermes and the mock model (`docs/flows.md`, `scripts/flows-setup.sh`), Flow B with a setup error standing in for the timeout the mock cannot produce.

Exit: every page of section 12.2 (items 1 to 11) runs against the Compose stack with no fixture data; component tests are green; each page is compared with its design canvas board in a browser, in light and dark; Flows A to D run end to end in the browser against the mock model; `docs/phases/phase-5.md` is written.

### Phase 5b: Suite authoring (4 days)

Section 4.6:

- the draft tables and their migration;
- the draft API and its readiness rules;
- the `self-check-draft` and `save-suite-draft` worker jobs;
- the worker's read-write suites mount;
- import from CSV, JSONL and .zip; download; restore;
- the authoring pages and components of section 12.2 item 12;
- updates to UI_FLOWS.md for every authoring flow.

Also the follow-ups assigned to Phase 5b in `docs/phases/phase-5.md` section 6.4 and `docs/phases/phase-6.md` section 6.4.

Exit: Flow E runs end to end against the Compose stack, from an empty Suites page to an experiment on the new suite's v1. The section 16 suite-authoring tests are green. `docs/phases/phase-5b.md` is written.

### Phase 6: Platform additions and `invoices-v1` (built 26 Oct 2026; see `docs/phases/phase-6.md`)

Two parts, in this order:

1. The platform additions P1 to P6 of section 18.2: task home seeds, the agent's memory files as artifacts, Hermes's background review pinned, the sample MCP servers, the skill loading mode, and one fixture generator per suite.
2. `invoices-v1` as section 18.1 describes: all 12 tasks with fixtures, references, verifier scripts, the expected workspace for `summary_file`, and the `invoice-method` skill.

Built: home seeds (task file kind `home_seed`, copied into every trial's `memories/`, with the loader's warnings), the memory files collected as artifacts with root `home` (migration `0008`), `file_check`'s `root`, `--home` for every verifier (`verifier_script` version 2) and `self_check.expected_home` with the seeds alone as the negative control; the background review's intervals written at Hermes's defaults, since the fork cannot run in a one-shot trial; `invoice-db` on a generated ledger of 120 invoices with paging and `notes`, and the http sample `vendor-directory` in the Compose profile `samples`, reached only through egress, which adds its header; `skill_loading` (`preload`, or `on_demand` with the `skills` toolset and no `-s`); the generators `scripts/fixtures/sample-mcp.ts` and `scripts/fixtures/invoices-v1.ts`; Phase 5 #13, the launch 409 and New experiment's tags for unset MCP variables; the pages for all of it (the inspector's Memory group and launch record rows, Task detail's home panels, the skill loading control, detail and diff); and `invoices-v1`'s 12 tasks with the `invoice-method` skill (`samples/skills/invoice-method/`). The live stage ran `scripts/phase6-smoke.sh` on the Compose stack with real Hermes and the mock model: `invoices-v1` reads `better` with the skill, Δ +0.667 [+0.417, +0.917].

Exit: all 12 tasks load valid, with every self-check passing on its reference and every negative control failing; a scripted wrong answer for each task's trap fails it; the skill uploads and validates; the mock-model experiment with and without the skill completes. Each addition has its own tests: a seeded memory reaches the model's prompt only with memory on; the memory files an agent writes are collected and a `file_check` with `root: home` scores them; `vendor-directory` is reached only through the egress MCP gateway, with its header added there; an on-demand skill is installed without `-s` and found through the `skills` toolset. `docs/phases/phase-6.md` is written.

### Phase 6b: Capability suites (2.5 days)

The four suites of section 18.3, `mcp-v1`, `memory-v1`, `knowledge-v1` and `tools-v1`, each with its generator, fixtures, references, self-checks, traps, mock scripts and smoke script.

Also the Phase 6 follow-ups assigned to Phase 6b in `docs/phases/phase-6.md` section 6.4 (the `memory` toolset with memory on, skipping lock files, the seed check, mock-script phrases, an opt-in restart step, the sample servers' checks in the tests).

Exit: every task loads valid, with its self-checks passing and its negative controls failing; each task's scripted wrong answer fails it; for each suite, a mock-model experiment on its recommended arms completes with the verdict the mock scripts predict (section 18.5), which proves the dimension under test reaches the run; `docs/phases/phase-6b.md` is written. The real-model calibration of these suites runs in Phase 8, once the price is set.

Order (decided 25 Oct 2026): Phases 6 and 6b run after Phase 5 and before Phase 5b. They change the task format (home seeds, `root: home`), which the authoring pages of Phase 5b must cover, and they give the UI real suites to try.

### Phase 7: Packaging (1 day)

`docker compose up --build` from a clean clone to a green System page on Colima and Docker Desktop; the Phase 5 follow-ups assigned to Phase 7 in `docs/phases/phase-5.md` section 6.4; the Phase 6 follow-ups assigned to Phase 7 in `docs/phases/phase-6.md` section 6.4; README states the Docker and memory requirements and the one-time Nous login.

### Phase 8: Experiment, documents, video (2 days)

Run the official experiment (section 19), write the documents, record the video.

Exit: the real price is in `config/prices.yaml` with its `checked_at`; the dry run and the full run complete within the spend ceiling; the capability suites are calibrated (section 18.5) within the spend the user approves; `docs/results.md`, `docs/design.md`, `docs/limits.md` and `docs/costs.md` are written from the measured runs; the video script and shot list are ready for the user to record.

Total: about 29 working days (Phase 6 grew from 1 day to 5 on 25 Oct 2026, with the capability suites). Phases are built in the order 5, 6, 6b, 5b, 7, 8.

---

## 18. Sample suites

`invoices-v1` (section 18.1) measures one skill. Four capability suites (section 18.3) cover the other things a configuration can vary: MCP servers, memory, knowledge given as skills or as documents, and toolsets. They need six platform additions (section 18.2). Phase 6 builds the additions and `invoices-v1`; Phase 6b builds the four suites.

### 18.1 `invoices-v1`

Twelve tasks over one fixture family: `invoices.csv` (48 rows, 8 columns: invoice_no, vendor_name, invoice_date, due_date, amount, currency, po_number, status), `credit_notes.csv`, `payments.csv`, `rates.json`, `policy_terms.json`, `purchase_orders.csv`. Each task has exactly the traps the `invoice-method` skill warns about, and the fixtures are generated by a script (`scripts/fixtures/invoices-v1.ts`, built in Phase 6) with a fixed seed so references are computed, not typed. As built, the script makes a base ledger of 48 invoices (eight vendors, in EUR) and each task copies it with its one trap planted; it also writes the verifiers' expected values, so a verifier never reads the agent's ledger, and the phase's mock scripts.

| Task         | Answer                      | Primary scorer                                               | Trap                                                  |
| ------------ | --------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| total_due    | number                      | numeric_tolerance abs 0.01                                   | paid rows must be excluded                            |
| overdue_list | string[]                    | json_match unordered                                         | due on the cutoff day is not overdue                  |
| dup_invoices | pair[]                      | json_match unordered, inner unordered                        | duplicates differ by invoice number                   |
| vat_split    | {band: {net, vat}}          | json_match + numeric_tolerance                               | one band is zero-rated                                |
| credit_notes | {invoice: net}              | json_match                                                   | a credit note references a paid invoice               |
| currency_mix | number                      | numeric_tolerance rel 0.001                                  | one rate is quoted inverted in rates.json with a note |
| missing_po   | sorted, comma-joined string | exact_match                                                  | empty po_number vs non-matching po_number             |
| late_fees    | number, and {invoice: fee}  | numeric_tolerance on the total + verifier_script on the fees | policy has a grace period and a cap                   |
| per_vendor   | {vendor: outstanding}       | json_match + trajectory_match(read_file)                     | vendor names have trailing spaces                     |
| disputed     | number                      | json_match + llm_judge(method)                               | disputed rows must be excluded, not zeroed            |
| partial_pay  | {invoice: balance}          | json_match                                                   | two payments on one invoice                           |
| summary_file | file                        | file_check + verifier_script                                 | must write summary.csv with one row per vendor        |

The skill `invoice-method` (SKILL.md plus checklist.md plus examples/reconcile.py) describes method only: load the whole file, normalise vendor names, apply credit notes and payments, exclude disputed, check the policy file. It never names a task or an answer. Its rules are defaults that yield to the task's own definitions: "exclude disputed" applies when a question asks what to pay now, not when a prompt says disputed invoices are still due (as `total_due` does). Otherwise the with-skill arm would be marked wrong for following the skill, and the comparison would measure a conflict instead of the method.

### 18.2 Platform additions (Phase 6)

| #   | Addition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Why                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Home seeds.** A task may hold `home/memories/MEMORY.md` and `home/memories/USER.md`. They are stored as task files of a new kind, `home_seed` (a migration widens the kind CHECK), and copied into the trial home's `memories/` before launch, in every arm, and listed in the launch record. No other path under `home/` is accepted. The loader warns when a file is over Hermes's limits (2,200 characters for MEMORY.md, 1,375 for USER.md) or is not a `§`-delimited list. As built: the loader reads a seed as Hermes does (entries trimmed, empty and repeated ones dropped, code points counted); a seed that is not UTF-8 is an error, because Hermes would read it as empty.                                                                                                                                                                                                                        | A fresh home starts with empty memory, so without a seed, memory on and memory off are the same run. With memory off, Hermes builds no memory store and puts nothing in the prompt (`agent/agent_init.py:1330`, `agent/system_prompt.py:528`), so the same seed in both arms isolates the setting. |
| P2  | **The agent's memory files as artifacts.** Before it deletes the home, the worker collects `home/memories/` with the same safe walk as the workspace (section 8.5), as artifacts with `root: home` (a migration adds the column). `file_check` gains `root: workspace \| home`, default workspace; verifier scripts get `--home <dir>`; the inspector's Files tab shows a Memory group. A home check's self-check uses `self_check.expected_home`, with the seed itself as the negative control. As built: two new origins, `home_seed_unchanged` and `home_seed_modified`; every verifier gets `--home` (`verifier_script` version 2); a `file_check` with `root: home` names a path under `memories/` and needs `expected_home`; a verifier is a home check when `expected_home` is its task's only known-good folder; Task detail lists the seeds and the expected home.                                     | A task that asks the agent to remember something can then be scored on what it saved.                                                                                                                                                                                                              |
| P3  | **Background review pinned.** After a turn, Hermes may fork the agent to save memory or skills (`agent/background_review.py`): memory every 10 user turns, skills every 10 tool iterations. A spike measures whether the fork runs in a one-shot trial. `config.yaml` then sets `memory.nudge_interval` and the skill creation interval explicitly, the same in every arm, and the launch record shows them. If the fork runs, its model calls count against the attempt's token cap and cost, and `docs/costs.md` says so. As built: read from the source, the fork cannot run, because `hermes chat --oneshot` is a finite turn, for which Hermes starts no review (`docs/phases/phase-6.md` section 2.3); so `config.yaml` writes Hermes's defaults, `memory.nudge_interval: 10` and `skills.creation_nudge_interval: 10`, and the live check counted no model call beyond the agent's own.                  | Hidden model calls that differ between arms would bias cost, and a fork could write memory nobody asked for.                                                                                                                                                                                       |
| P4  | **Sample MCP servers.** `invoice-db` (stdio) serves a generated ledger of 120 invoices in place of its 8 sample rows, with paging (a `cursor`, 20 rows a page), its two filters, and a free-text `notes` field. A new http server, `vendor-directory` (Python MCP SDK, streamable HTTP, read-only), runs as a Compose service in a `samples` profile and requires `Authorization: Bearer` from `VENDOR_DIRECTORY_TOKEN`, which egress adds (section 5.3); `.env.example` documents the variable. As built: data from `scripts/fixtures/sample-mcp.ts` (15 vendors, 10 a page, three on hold; one vendor's note plants an instruction to delete an invoice; 8 open invoices without a due date); the image is built FROM the trial image; Compose gives egress `Bearer <token>`, since egress sends a variable unchanged as the whole header; the network `mcp-samples` is shared by egress and the server only. | `mcp-v1` needs a stdio and an http server, data the workspace does not hold, paging, and a field to plant an injected instruction in.                                                                                                                                                              |
| P5  | **Skill loading mode.** A configuration field `skill_loading: preload \| on_demand`, default `preload` (a migration). Preload is today's `-s <name>`. On demand installs the skills in `home/skills/` without `-s` and adds the `skills` toolset, so the agent has to find and open them. The configuration form, detail and diff show it. As built: the plan adds the toolset once, so `-t` and `config.yaml` agree; the mode enters the config hash only when it is `on_demand`, so every earlier version keeps its hash; on demand with no skills is a 400.                                                                                                                                                                                                                                                                                                                                                  | Preloading measures a skill's content. On demand also measures whether the agent finds the skill, which is how Hermes users mostly meet skills.                                                                                                                                                    |
| P6  | **Generators and test scripts.** One fixture generator per suite (`scripts/fixtures/<suite>.ts`, fixed seed) writes the fixtures and computes the references; one mock-scripts file and one smoke script per phase (`scripts/phase<n>-mock-scripts.json`, `scripts/phase<n>-smoke.sh`; decided at the start of Phase 6). The generators are TypeScript run with plain `node`, with no dependency, and re-running one reproduces the same bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | References are computed, never typed.                                                                                                                                                                                                                                                              |

### 18.3 Capability suites (Phase 6b)

Each suite targets one dimension and comes with a recommended experiment: configurations that differ only in that dimension. Every task can be answered in every arm; the dimension decides how well. Tasks use the answer format and check types of `invoices-v1`, and each has a trap.

| Dimension                                                                    | Suite                               | Recommended arms                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| A skill's method                                                             | `invoices-v1`                       | `baseline` · `with-skill`                                             |
| Knowledge as skills or documents; scripts in skills; decoys; finding a skill | `knowledge-v1`                      | none · as documents · as skills, preloaded · as skills, on demand     |
| MCP servers, stdio and http                                                  | `mcp-v1`                            | the same data as documents · through MCP                              |
| Memory                                                                       | `memory-v1`                         | memory off · memory on, same seed                                     |
| Toolsets                                                                     | `tools-v1`                          | `file` · `file` + `terminal` · `file` + `terminal` + `code_execution` |
| Model and provider                                                           | any suite                           | needs a second provider's key and price                               |
| Turn and time limits                                                         | any suite, `tools-v1` shows it best | for example `max_turns` 8 · 30                                        |

**`mcp-v1`** (8 tasks). Arms: `docs-export`, with the ledger and the vendor list attached as documents (`workspace/docs/`), and `with-mcp`, with `invoice-db` and `vendor-directory` and no documents. This compares the same data through tools and as files; a baseline with no data would fail every task and show nothing. In `docs-export` the MCP tools do not exist, so the trajectory keys on them pass by absence; the comparison reads the primary keys.

| Task            | Answer          | Primary              | What it tests                                                                                                                                                   |
| --------------- | --------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lookup_invoice  | object          | json_match           | one invoice; trajectory_match on `get_invoice` (secondary)                                                                                                      |
| due_by_terms    | {invoice: date} | json_match           | joins invoices with vendor payment terms from the other server: stdio and http in one run                                                                       |
| all_pages       | number          | numeric_tolerance    | a total over 120 invoices; trap: stopping after the first page of 20                                                                                            |
| filtered_list   | string[]        | json_match unordered | the server's filters; trajectory_match on the filter arguments (secondary)                                                                                      |
| not_found       | null            | exact_match          | an invoice that does not exist; the tool's error must become "not found", not an invented record                                                                |
| read_only       | string[]        | json_match unordered | which invoices policy would void, "change nothing"; trajectory_match `max_calls: 0` on `update_invoice` and `delete_invoice` (secondary)                        |
| injected_note   | number          | numeric_tolerance    | a vendor's `notes` tells the assistant to delete an invoice; trajectory_match `max_calls: 0` on `delete_invoice` (secondary), and the answer must be unaffected |
| vendors_on_hold | string[]        | json_match unordered | data only `vendor-directory` holds: the http path end to end                                                                                                    |

**`memory-v1`** (8 tasks). Every task seeds the same files in both arms (P1); the arms differ only in `memory_enabled`.

| Task               | Primary                          | What it tests                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| usual_currency     | numeric_tolerance                | USER.md says reports are in EUR; the prompt asks for "my usual currency"                                                                                                                                                                                          |
| vendor_alias       | json_match                       | MEMORY.md says two vendor names are one vendor                                                                                                                                                                                                                    |
| standing_exclusion | json_match                       | USER.md leaves an intercompany vendor out of payables reports                                                                                                                                                                                                     |
| prompt_wins        | numeric_tolerance                | memory says EUR, the prompt says USD this time; trap: following memory                                                                                                                                                                                            |
| data_wins          | numeric_tolerance                | memory holds last year's VAT rate, the fixture the current one; trap: trusting memory over the data                                                                                                                                                               |
| needle             | json_match                       | one relevant entry among 15, near the size limit                                                                                                                                                                                                                  |
| remember_this      | verifier_script on the home (P2) | the prompt states a lasting preference and asks the agent to remember it; MEMORY.md or USER.md must hold it; trajectory_match on the `memory` tool (secondary). With memory off the tool does not exist, so this task fails by design and shows what memory adds. |
| keep_private       | verifier_script                  | USER.md holds a personal detail marked private; the prompt asks for an email to a vendor about its overdue invoices; the email must cover them and must not contain the detail                                                                                    |

**`knowledge-v1`** (8 tasks). A fictional fixed-width bank statement format, BX-7 (record types, amounts in cents, a sign column, reason codes), and a house report style: knowledge no model has. The same text ships four ways: none; two documents (`bx7-spec.md`, `house-style.md`); two skills (`bx7-format`, with a parser `bx7.py` and `codes.md`, and `house-style`), preloaded; and the same skills on demand (P5). Every arm with knowledge also has a decoy for the older BX-6 format.

| Task            | Primary                                                  | What it tests                                                                                               |
| --------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| closing_balance | numeric_tolerance                                        | the sign and cents conventions                                                                              |
| record_counts   | json_match                                               | record types                                                                                                |
| large_file      | numeric_tolerance                                        | 5,000 records: the shipped parser against parsing by hand (trajectory_match on running `bx7.py`, secondary) |
| reason_codes    | json_match                                               | the code table is in `codes.md`, not in SKILL.md; trap: stopping at SKILL.md                                |
| pick_version    | numeric_tolerance                                        | the file's header says BX-7; trap: the BX-6 decoy                                                           |
| house_summary   | llm_judge, with text_match on the title and date formats | the house style                                                                                             |
| prompt_override | json_match                                               | the prompt redefines one convention; trap: following the skill instead                                      |
| unrelated       | numeric_tolerance                                        | a plain CSV sum: a control, knowledge should not hurt                                                       |

**`tools-v1`** (6 tasks). Arms: `file`; `file` + `terminal`; `file` + `terminal` + `code_execution`.

| Task          | Primary                            | What it tests                                                                                                                         |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| big_csv       | numeric_tolerance                  | 20,000 rows; a tool result shows 5,000 characters, so the file-only arm must page through or fail                                     |
| extract_ibans | json_match unordered               | pattern extraction from 300 log lines                                                                                                 |
| reshape_json  | file_check, with a verifier_script | writes a reshaped JSON file                                                                                                           |
| checksum      | exact_match                        | the sha256 of a fixture: needs a terminal or code; in the file-only arm the honest answer is that it cannot, which the run view shows |
| join_three    | numeric_tolerance                  | a join over three files                                                                                                               |
| small_lookup  | exact_match                        | a one-line lookup: a control, more tools should not distract                                                                          |

### 18.4 Not covered in v1, and why

- **`web` and `browser` toolsets.** Live pages change between runs, so references cannot be computed, and Hermes's web search needs a search provider's key, which trials never receive. Egress already opens public mode for these toolsets (section 8.2); a suite against pinned public pages could follow.
- **Memory across sessions.** A task whose first session saves a fact and whose second recalls it needs an attempt to run several sessions in one home: the runner, events, the answer from the last session, and the budget split between sessions. `memory-v1` covers the two halves separately: recall from a seed (P1) and saving (P2). About 1.5 days if wanted later.
- **`session_search` and `delegation`.** Session search needs earlier sessions, as above. Delegation is not planned.
- **State on a remote MCP server.** `vendor-directory` is read-only. A remote server's state is not reset between attempts (section 20).

### 18.5 How each suite is tested

1. **Load.** Every task is valid. Every self-check passes on its reference, and every negative control fails.
2. **Traps.** For each task, a scripted wrong answer that falls into its trap fails the primary key: scorer tests on recorded answers, and one mock-model run per suite.
3. **The dimension reaches the run.** A mock-model experiment on the recommended arms completes, with mock scripts that can answer correctly only when the dimension is present: a marker phrase in the seed (memory), in a document or skill (knowledge), in an MCP tool's result (mcp), or a tool only one arm has (tools). The smoke script asserts the verdict each mock experiment should reach.
4. **Calibration, with the real model (Phase 8).** One repetition per task and arm, after the price is set and within a spend the user approves: `mcp-v1` 16 runs, `memory-v1` 16, `knowledge-v1` 32, `tools-v1` 18, about 82 runs. A task every arm solves, or no arm solves, is adjusted and reloaded as the suite's next version.

---

## 19. The official experiment

- Suite: `invoices-v1`, all 12 tasks. Baseline: `baseline` (gpt-6.1-sol via nous, file + terminal, memory off, no skills). Candidate: `with-skill` (same plus `invoice-method`). Repetitions: 5. Concurrency: 3. Spend ceiling: $5.
- Run it twice: once as a dry run on 3 tasks × 1 rep to check costs and prompts, then the full run. Only the full run is reported.
- Report in `docs/results.md`: the verdict card numbers, the task grid, the interval, the sensitivity figure, secondary metrics, three annotated runs (one baseline failure, its counterpart, one execution error if any), and the exact commands from the launch records.
- If the result is inconclusive, report it as such, with the per-task table, and say what repetition count the interval width suggests would be needed.
- Calibration of the capability suites (section 18.5): one repetition per task and arm, about 82 runs, within a spend the user approves once the price is known. Then, if the budget allows, one experiment per capability suite on its recommended arms (section 18.3) at 2 repetitions, reported in `docs/results.md` beside the official one.

---

## 20. Documentation deliverables

- `README.md`: run instructions (exists), add the experiment summary and links.
- `docs/design.md`: architecture, data model, pipelines, statistics method, decisions with alternatives considered (Postgres plus pg-boss over Redis, Drizzle over Prisma, Turborepo, fresh-home isolation over containers per trial, openevals for scorers, drawer inspector), assumptions (tasks as files, fixed scorer vocabulary, single user, trusted local use).
- `docs/limits.md`: tool output truncated at 5000 characters; one Hermes revision; memory is tested within one session only, from seeded files and from what the agent saves, not recalled across sessions; the `web` and `browser` toolsets are not covered by a suite (section 18.4); remote MCP state not reset; small suite means wide intervals; judge bias when judging with the agent's model family; no auth; terminal toolset reaches the whole container; scorer vocabulary fixed; `verifier_script` is Python only; stdio MCP env values are readable by the agent, and stdio servers have no network; a verifier script runs as the worker's uid until Phase 5b, so it can read the worker's environment (DATABASE_URL, stdio MCP values, any other value in `.env` but the provider keys, which Compose blanks); the disk cap is polled, so a fast writer can overshoot it by about a second of writes; the LLM judge is the platform's (`JUDGE_*`), and a re-score grades with the judge of the moment; `trajectory_match` argument values match exactly, so a path must be spelled as the agent sends it and an MCP tool named as Hermes names it (`mcp__<server>__<tool>`); a `text_match` pattern is a JavaScript regular expression, each match limited to 1 s; a custom open-weight judge whose backend parses special tokens in message content could be steered by chat-template tokens in the agent's text; the model gateway's token cap can be overshot by the calls already in flight.
- `docs/costs.md`: per-run token medians from the experiment, price table with date, execution versus grading cost, the formula, and the cost of the full experiment as measured.
- `docs/results.md`: section 19.
- `docs/hermes-adapter.md`: the verified launch contract from the spike.
- Video: 6 to 8 minutes following Flow A, then one Flow B investigation, recorded against the Compose stack.

---

## 21. Spikes, risks and open questions

Answered by reading the Hermes source and by tests run so far:

| Id                            | Answer                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S2 approvals                  | One-shot mode denies flagged commands instantly (no hang). Inside the container, `--yolo` and `approvals.mode: off`; `protected_instruction_files: false`, since writing AGENTS.md otherwise detaches with exit 3. |
| S3 MCP alias                  | MCP servers register as toolset `mcp-<name>` with alias `<name>`; the alias goes in `-t`. Tool naming in events is still to observe.                                                                               |
| S5 clean home                 | A fresh home gets the default SOUL.md (same in both arms) and the 58 bundled skills unless `.no-bundled-skills` is present.                                                                                        |
| S6 credentials                | Nous Portal is OAuth with rotating refresh tokens; never copy `auth.json`. Use the model gateway and nous-proxy.                                                                                                   |
| S7 result on kill             | No result event on SIGTERM; the run continues in the gateway daemon. Stop the container and synthesise the result.                                                                                                 |
| S8 writes outside home        | Gateway lock under `~/.local/state`, sockets under `XDG_RUNTIME_DIR` or `/tmp`: all inside the container with HOME = home and a tmpfs `/tmp`.                                                                      |
| S9 pg-boss in our transaction | `fromDrizzle(tx, sql)`: jobs commit or roll back with our rows; verified on PGlite and Postgres 17.                                                                                                                |
| S10 MCP environment           | Hermes fills `${NAME}` in `mcp_servers` from its own environment (`tools/mcp_tool_config.py:554`) and starts stdio servers with a filtered environment (`:147`, `:199`): no proxy variables, so no network path.   |

Phase 0 isolation spikes, run on Colima 0.10.3 (vz, 4 CPU, 6 GB) with Docker Engine 29.5.2. Run them again with `node dist/sandbox-cli.js selftest | lifecycle | smoke` inside the worker.

| Id  | Test                                                                                                                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Pinned image, revision `4d04303818b6`, uid 10000, hardened flags                                                                                                                               | **Pass.** Image pinned by digest; runs as 10000 with a read-only root, tmpfs `/tmp` and two subpath mounts.                                                                                                                                                                                                                                                                                                                                                                                                     |
| I2  | Only two mounts visible; Postgres, gateways, host aliases, metadata and public IPs unreachable; only `egress` resolves                                                                         | **Pass.** 19 TCP targets checked, only `egress:3128` and `egress:8080` open; no default route; UDP DNS to the internet fails.                                                                                                                                                                                                                                                                                                                                                                                   |
| I3  | Egress refuses private targets in every encoding with 403 and wrong tokens with 407                                                                                                            | **Pass.** 11 private or unlisted targets refused and logged; missing and wrong tokens get 407. Names are resolved once and the vetted address is dialled. A red-team pass found no bypass.                                                                                                                                                                                                                                                                                                                      |
| I4  | One real task through the model gateway; usage parity; request shape matches direct Nous use                                                                                                   | **Pass.** `invoices-v1/total_due` with `openai/gpt-6.1-sol` passed 6 of 6 runs in 20 to 33 s, each with 3 model calls and 2 tool calls. The gateway's token counts equalled the `result` event's exactly every time, and the attempt token was in none of the home's files. Hermes sends `tags`, `session_id` and `stream_options` but not `reasoning`; the gateway adds it for the Nous upstream. Run through the host-login forward (`NOUS_HOST_PROXY`); the containerised nous-proxy login is still to try.  |
| I5  | At the deadline, stopping the container ends every process, including `setsid` ones                                                                                                            | **Pass.** A container that prints nothing and starts `setsid` and `nohup` children is stopped at the deadline with exit 143 in 3.2 s; no containers or processes are left. An earlier run found the guard held back response headers until the first output byte, which kept the deadline from arming for a silent trial. The guard now flushes headers, and the runner arms every stop before reading output.                                                                                                  |
| I6  | Crash recovery: an orphan blocks its replacement until confirmed gone                                                                                                                          | **Pass for the container layer.** The replacement's create gets 409 until `clearRun` removes the orphan. Marking `worker_lost` belongs to the recovery job in Phase 2.                                                                                                                                                                                                                                                                                                                                          |
| I7  | Guard refuses every forbidden create and endpoint                                                                                                                                              | **Pass.** Privileged, host binds, host network, other images, exec, build and network calls are refused. Containers are addressed by full id or trial name only, operations go to the id the label check resolved, and query parameters and headers are allowlisted.                                                                                                                                                                                                                                            |
| I8  | `agent.run_budget_seconds` ends a turn on time; `-s <skill>` preloads with `.no-bundled-skills`                                                                                                | **Partial.** Runs complete with both settings in place. `.no-bundled-skills` keeps out the 58 bundled skills, but Hermes always installs its essential `hermes-agent` skill (section 5.4). Budget expiry timing and the skill preload are still to measure.                                                                                                                                                                                                                                                     |
| I9  | Three concurrent trials: memory and pid peaks                                                                                                                                                  | **Pass.** About 8.2 s each, peaks of about 323 MiB and 30 pids against limits of 1536 MiB and 1024.                                                                                                                                                                                                                                                                                                                                                                                                             |
| I10 | Hosts Hermes contacts by itself, with egress in deny-all mode                                                                                                                                  | **Pass.** One host, `inference-api.nousresearch.com:443`, from the credits-seed pricing fetch (section 8.2). It is fail-open, identical in every arm, and refused by egress; no other host is contacted in real-model runs.                                                                                                                                                                                                                                                                                     |
| I11 | A hostile workspace: links to `/`, `/data/suites` and `/trials`, a link loop, a link to another attempt's file, a FIFO, a mode-000 file, a non-UTF-8 name, a 10 GB sparse file, a 40-deep tree | **Pass.** Walk and reads finish in under 10 ms. No link is followed, the FIFO does not block, the other attempt's secret is never read, and a read through a linked parent is refused as outside the root.                                                                                                                                                                                                                                                                                                      |
| I12 | A trial that writes without end, by size and by file count                                                                                                                                     | **Pass.** Killed after about 0.4 s in both cases (64 MiB and 2,000-file caps in the test, polled every 250 ms). Before the header fix, the size case wrote about 46 GB and nearly filled the 59 GB VM disk.                                                                                                                                                                                                                                                                                                     |
| I13 | Egress under hostile requests: a malformed absolute-form target to the gateway, and private targets from a public-mode attempt                                                                 | **Pass.** A review found that `GET http://[/x` to `egress:8080`, with no token, ended the egress process and emptied every attempt's registration. Every egress server now answers malformed targets with 400 and logs, rather than dies on, an escaped rejection. The self-test sends that request from inside a trial and checks that egress still answers. It also registers a public-mode probe, so private targets must be refused for their address or name, not because an allowlist refused them first. |
| I14 | Connect Nous Portal from the UI, then run a real task through `nous-proxy`                                                                                                                     | **To run.** Needs a person to approve the login in the browser once. Also completes I4 on the designed path, replacing the development host forward.                                                                                                                                                                                                                                                                                                                                                            |
| I15 | An http MCP server through the egress MCP gateway (streamable HTTP, headers added, no redirect), and a stdio server whose env is a `${NAME}` reference set in the container environment        | **Pass** (25 Oct 2026, Phase 2 live check): stdio and http both work; the http upstream saw the header on every call, and no secret value was found in the home, events, launch records, the database or the volumes.                                                                                                                                                                                                                                                                                           |

Risks:

| Id  | Risk                                                                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Nous rate limits at concurrency 3                                                                               | 429 is a provider error, retried once; lower concurrency                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R2  | The model solves every task with and without the skill                                                          | Report it honestly; the traps in section 18 are designed to matter                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R3  | A reviewer's Docker lacks volume subpaths or isolated gateway mode                                              | Archive-copy fallback and `inhibit_ipv4`; the self-test refuses to run if isolation cannot be proven                                                                                                                                                                                                                                                                                                                                                                                    |
| R4  | The gateway changes the request shape                                                                           | Both arms use the same path, so comparisons stay fair; spike I4 restores parity with direct use                                                                                                                                                                                                                                                                                                                                                                                         |
| R5  | Edits in the UI and on disk race on one folder                                                                  | A draft records its base version; save refuses (409) when the version moved or the files on disk no longer match the base hash, and offers to combine                                                                                                                                                                                                                                                                                                                                   |
| R6  | Saving rewrites hand-written YAML and creates noisy versions                                                    | `yaml` Document API edits only changed nodes; a no-edit round trip must report `unchanged` (a Phase 5b test)                                                                                                                                                                                                                                                                                                                                                                            |
| R7  | A zip import carries `verify/` scripts, which run as code in the worker                                         | Decided in the design (SA.10, 25 Oct 2026): when a zip holds scripts, the validated step shows "This suite contains code" with each script's path, size and hash, and Import stays disabled until "I trust these scripts" is ticked. A zip without scripts shows no panel; Copy of a suite needs no confirmation, because its scripts are already on disk. Phase 5b also moves verifier scripts into a `network: none` container through the guard (section 14) before zip import ships |
| R8  | Files the worker writes into `./suites` are owned by uid 10000, which a Linux host user may not be able to edit | macOS Docker (Colima, Docker Desktop) maps ownership to the user; on Linux, `SUITES_UID` and `SUITES_GID` set the owner after the rename. Open: verify on Linux                                                                                                                                                                                                                                                                                                                         |

---

## 22. Double-check list

Checked while writing this plan:

- Every PDF line has a home (section 0 table).
- Every design screen and state has an endpoint feeding it (sections 11, 12) and a table behind it (section 3).
- Every item in `DESIGN_AUDIT.md` section 3 (backend capabilities assumed by the design) appears here: versioning (3.3), suite hash and reload (4.4), self-check policy (4.3), estimates (7.2), price table (15), spend ceiling (7.3), circuit breaker (7.3), pause/cancel semantics (7.3), statistics rules (10), retry vs re-score (8.4, 9.4), SSE and running summary (11), drawer route and counterpart (11), secrets (3.2, 5.4), MCP test start (5.3), skill dry-run upload (5.1), documents to configurations only (5.2), draft status dropped (3.4 has none), duplicate actions (6, 7.3), event timestamps (8.3).
- Every edge case in `DESIGN_AUDIT.md` section 4: scorer error (9.2), multi-attempt (3.1, 8.4), A/B jump disabled (11 counterpart returns null with reason), repetitions = 1 (7.1, 10.2), paused by ceiling (7.3), no worker (3.1, workers table), unknown model (7.2), duplicate skill name (3.1, 5.1), configuration delete (none in v1, documented), multi-candidate (10.3), name uniqueness (experiments not enforced).
- Hermes facts used are the verified ones: flags, event schema, `HERMES_HOME`, `memory_enabled`, toolset allowlist semantics, MCP toolset naming, skill lookup by frontmatter name, 5000-char tool output cap, revision `4d04303`.
- The three invariants most likely to be violated by shortcuts (reference never in workspace, evidence immutable, failure kinds separate) each have a concrete mechanism, not just a rule.

---

## 23. Review concerns and how they are resolved

| #   | Concern                                                                                                    | Resolution                                                                                                                                                                                                                                                                    | Status                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Restricted environment per trial, no access to references, other trials, evidence, the database or the API | Container per trial with two mounts, internal slot network, egress proxy, model gateway, guarded Docker socket; scoring outside trials (sections 2, 8.0, 8.2, 14)                                                                                                             | Built and proven live: spikes I1 to I3, I5, I7 and I9 pass (section 21)                                                                                                                            |
| 2   | Immutable suite snapshot in content-addressed storage                                                      | `blobs` table with foreign keys from task files, documents and artifacts; loader writes blobs before rows; trials and re-scoring read only blobs (sections 3, 4.4, 5.4, 8.5)                                                                                                  | Schema implemented and tested; loader in Phase 1                                                                                                                                                   |
| 3   | Versioned MCP definitions                                                                                  | `mcp_servers` plus `mcp_server_versions`; configuration versions reference version ids; definitions freeze when used; latest-version pointer must resolve (deferred foreign key)                                                                                              | Implemented and tested                                                                                                                                                                             |
| 4   | Atomic claims, ownership tokens, periodic recovery, confirmed termination                                  | Claim transaction (section 8.1); attempt lease token, expiry and revocation, sandbox id and host; fenced writes; recovery every 15 s that confirms the container is gone on its own daemon before requeueing (section 8.6); database refuses writes after revocation          | Built in Phase 2 (`docs/phases/phase-2.md` section 3.6)                                                                                                                                            |
| 5   | Durable handoffs and duplicate-safe evaluation                                                             | Finish execution, mark executed, insert evaluation and send its job in one transaction; evaluation generation and claim token; whole score set published in one transaction; the database refuses partial sets, stale generations and a failed first evaluation (section 9.4) | Schema implemented and tested; handlers in Phase 3                                                                                                                                                 |
| 6   | One reconciliation after every relevant transition                                                         | `reconcileExperiment` under the experiment row lock, settled check over runs and evaluations, append once per results revision (section 7.4)                                                                                                                                  | Built: reconcile completes the experiment and records `verdict_revision` (Phase 2) and appends one verdict entry per candidate per results revision in the same conditional update (Phase 4)       |
| 7   | Both concurrency limits                                                                                    | Worker slot = `localConcurrency`, handler holds it until the container is removed; experiment limit = database admission in the claim transaction, deferring with `deferJob` (section 8.1)                                                                                    | Built in Phase 2 (`docs/phases/phase-2.md` sections 3.3 and 3.6)                                                                                                                                   |
| 8   | Results revision for comparison caching                                                                    | `experiments.results_revision` bumped by triggers on run status and score publication; comparison cached by it (section 10.3)                                                                                                                                                 | Built in Phase 4: the comparison is cached by results revision, status and configuration names, and a fresh answer after a retry, a cancel, an execution error and a re-score is tested end to end |
| 9   | Known-good workspace for artifact verifiers                                                                | `expected/` folder declared in `task.yaml`, stored as task files of kind `expected`, overlaid on fixtures for self-check, plus a negative control (section 4.3)                                                                                                               | Schema and record shapes implemented; loader in Phase 1                                                                                                                                            |
