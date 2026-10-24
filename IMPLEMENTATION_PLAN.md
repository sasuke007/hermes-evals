# Implementation Plan: Hermes Evals Platform

Status: the data layer is implemented (schema, migrations, integrity triggers, queue settings; 44 unit tests on PGlite and 4 on Postgres 17). Container-per-trial isolation (section 8) is confirmed and built: trial image, docker-guard, egress proxy and model gateway, trial runner, and an isolation self-test the worker runs at boot. It is proven live on Colima (section 21). A red-team review attacked the guard, egress and the trial: its four guard findings are fixed and re-verified, egress held, and an interrupted probe of how the worker reads trial output led to the safe reader in section 8.5 and the disk watchdog in section 8.2. Section 23 maps the review concerns to their resolutions. The claim, recovery, scoring and frontend work is not built yet.

Sources this plan is checked against: the take-home assignment brief (authoritative; not in this repository), the design canvas (29 artboards, all 16 fixes applied), `DESIGN_AUDIT.md`, the flow page, the Hermes source at v0.22.4 (revision `4d04303`), and the review of the plan (section 23).

---

## 0. What we are building, in one paragraph

A local, single-user benchmarking workbench for Hermes Agent. Tasks are files on disk with hidden reference answers and declared checks. Configurations are records of how the agent is set up. An experiment runs every selected task under every configuration, several times, each run in a fresh Hermes home, and stores the full event stream, output and files. Scorers grade the stored evidence. A paired bootstrap over tasks turns per-run results into a verdict with an interval. The UI makes every number a link to the evidence beneath it.

### Deliverables mapped to the PDF

| PDF asks for                                        | Where it lands                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Define tasks and how they are scored                | `suites/` file format (section 4), suite loader, self-check                  |
| Define configurations: model, skills, memory, tools | Configuration versions (section 6), resources (section 5)                    |
| Run tasks under each configuration                  | Experiment run matrix and worker execution pipeline (sections 7, 8)          |
| Better or not, and how confident                    | Statistics module and comparison views (section 10)                          |
| Inspect a run to see why                            | Run inspector fed by `run_events`, `scores`, `artifacts` (sections 8, 9, 12) |
| NestJS, Vue 3, TypeScript                           | Done in the skeleton                                                         |
| Single command                                      | `docker compose up --build` (section 15)                                     |
| Sample task set                                     | `suites/invoices-v1`, 12 tasks (section 18)                                  |
| Documented assumptions                              | `docs/design.md` and `docs/limits.md` (section 20)                           |
| Production-grade repo with README                   | Already started; sections 13, 14, 16                                         |
| Design document                                     | `docs/design.md`                                                             |
| Known limits                                        | `docs/limits.md`                                                             |
| Approximate costs                                   | `docs/costs.md`, computed from recorded tokens and the price table           |
| One real experiment                                 | Section 19                                                                   |
| Video                                               | Section 20                                                                   |

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
- **worker**: claims jobs, prepares each attempt's directory in the `trials` volume from the blob store, asks the guard to start the trial container, streams its stdout into `run_events`, collects outputs after the container is removed, runs scorers outside any trial, renews leases, runs recovery. It holds no provider credential except for the LLM judge.
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

| Table                    | One row per                       | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blobs`                  | stored file, by sha256            | A row means DATA_DIR/blobs/<sha256> exists. Task files, documents and artifacts reference it by foreign key.                                                                                                                                                                                                                                                               |
| `suite_sources`          | suite directory                   | Last load outcome and error, pointer to the current suite version (must be a version of this directory).                                                                                                                                                                                                                                                                   |
| `suites`                 | immutable suite version           | Unique per directory, content hash (suite.yaml and every task file) and check hash (loader and scorer versions plus validity). `version_number` (v1, v2, … per directory, assigned by the loader, unique with the directory) beside the author's `version_label` (section 4.5).                                                                                            |
| `tasks`                  | task of a suite version           | Prompt, reference (any JSON value), verification list, the verbatim `task.yaml` (`task_yaml`, for diffs), self-check result, load issues, validity. Immutable. `version_number` per directory and task key, which goes up only when that task's own content hash changes, and `introduced_in_suite_id`, the suite version where this content first appeared (section 4.5). |
| `task_files`             | file a task needs                 | Kinds: fixture (the only kind copied into a trial), verifier, rubric, expected (hidden known-good workspace). Immutable.                                                                                                                                                                                                                                                   |
| `skills`                 | uploaded skill version            | Unique by name and version; stored unpacked under skills/<hash>. Immutable.                                                                                                                                                                                                                                                                                                |
| `documents`              | uploaded reference file           | Content in the blob store. Attaches to configurations only. Immutable.                                                                                                                                                                                                                                                                                                     |
| `mcp_servers`            | MCP server identity               | Name (the `-t` alias), latest version pointer that must resolve.                                                                                                                                                                                                                                                                                                           |
| `mcp_server_versions`    | MCP definition                    | stdio command and env variable names, or http URL and `headers`, a list of `{header, env}` pairs; names only, last test result. Frozen once a configuration version uses it. Names may not be platform variables or credentials (section 5.3).                                                                                                                             |
| `configurations`         | named configuration               | Latest version pointer that must resolve.                                                                                                                                                                                                                                                                                                                                  |
| `configuration_versions` | settings Hermes runs with         | Model, provider, toolsets, memory, skill, document and MCP version ids, limits, config hash, the version it was duplicated from. Frozen once an experiment uses it.                                                                                                                                                                                                        |
| `workers`                | worker process start              | Heartbeat, concurrency, trial slots, Hermes version and revision, toolset list, environment variable names of the worker and of egress (never values), the last sandbox self-test report.                                                                                                                                                                                  |
| `experiments`            | launched comparison               | Suite row, tasks, baseline and candidates, repetitions, concurrency, spend ceiling, frozen Hermes revision and price table, failure detail, append-only verdict history, results and verdict revisions.                                                                                                                                                                    |
| `runs`                   | cell of the run matrix            | Task x configuration version x repetition. Lifecycle status, attempt count, current attempt (must belong to this run), cancel request.                                                                                                                                                                                                                                     |
| `attempts`               | launch of Hermes                  | Trigger, outcome, final text, tokens, cost, launch record, lease (token, expiry, revocation), sandbox and its host.                                                                                                                                                                                                                                                        |
| `run_events`             | stdout line or platform event     | Keyed by attempt and gap-free sequence number. Append-only.                                                                                                                                                                                                                                                                                                                |
| `artifacts`              | file found in the workspace       | Origin (fixture or document unchanged/modified, or agent), blob hash or skipped reason. Append-only.                                                                                                                                                                                                                                                                       |
| `evaluations`            | scoring pass over an attempt      | Generation (newer wins), claim token, extracted answer, status, superseded time.                                                                                                                                                                                                                                                                                           |
| `scores`                 | verification key in an evaluation | passed, failed, error or ungradable; score, comment, expected, observed, evidence. Immutable.                                                                                                                                                                                                                                                                              |

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
    └── verify/                optional
        └── check.py
```

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

Rules enforced by the loader: exactly one `primary: true`; keys unique; every `type` is in the registry; params validate against that scorer's zod schema; a `verifier_script` entry's `script` exists under `verify/`; `prompt.md` must instruct the fenced JSON block (checked by a regex on the prompt, warning only).

### 4.3 Self-check policy, per scorer type

| Type                                                   | At load                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `numeric_tolerance`, `json_match`, `exact_match`       | Run against `reference.json` as if it were the answer; must pass.                                                                                                                                                                                                                                                           |
| `verifier_script` (answer-based)                       | Run with `--answer reference.json --workspace <fixtures>`; must print one JSON line with score ≥ the pass threshold.                                                                                                                                                                                                        |
| `verifier_script`, `file_check` (file-producing tasks) | Run against the hidden expected workspace: the fixtures overlaid with the task's `expected/` folder, the end state a correct agent leaves. Must pass. Then run again against the untouched fixtures as a negative control, which must not pass; a verifier that passes anyway would pass any agent, so the task is invalid. |
| `trajectory_match`                                     | Schema-validated only (needs a trajectory).                                                                                                                                                                                                                                                                                 |
| `llm_judge`                                            | Schema-validated only; never called at load (cost, non-determinism).                                                                                                                                                                                                                                                        |

A file-producing task declares its expected workspace in `task.yaml`:

```yaml
self_check:
  expected_workspace: expected # folder in the task, overlaid on fixtures/
  negative_control: true # default when expected_workspace is set
```

The loader stores `expected/` files as task files of kind `expected`. They are never copied into a trial; only kind `fixture` is. Self-check results record the mode (`answer`, `script`, `workspace`, `none`), whether the check was a negative control, and the expected-workspace files used.

A task is `valid` only if it has no load issue of severity error and every runnable check passes. Invalid tasks are listed but cannot be selected for new experiments (enforced by the launch trigger). Existing experiments keep their frozen suite row.

### 4.4 Loader behaviour

The loader runs in the worker (Phase 1 decision D1), because self-checks run the suite's own verifier scripts. It loads every directory under SUITES_DIR when the worker starts, and on a `load-suites` job: `POST /suites/reload` sends one and waits for its result (503 without a live worker, 504 after `SUITE_RELOAD_TIMEOUT_S`). The API does not mount SUITES_DIR. Per directory, in one transaction serialised by an advisory lock on the directory, with the read inside the lock:

1. Hash suite.yaml and every task file; parse; validate; run self-checks (verifier subprocess, the task's `timeout_s`, default 30 s, minimal environment).
2. Write each fixture, verifier, rubric and expected file to the blob store (temp file, fsync, rename) and insert its `blobs` row.
3. If a suites row with the same directory, content hash and check hash exists, reuse it (`unchanged` or `reverted`); otherwise insert a new suites row with its tasks and task files (`created`).
4. Upsert `suite_sources` with the outcome, the changes against the previous version (added, removed, changed, now invalid, now valid) and the new current pointer. A parse failure of suite.yaml or any task.yaml, an unsafe file (a link or special file) or a suite name another live directory holds records the error and leaves the pointer on the last good version. A vanished directory is marked `missing`, which releases its suite name.

After load nothing reads SUITES_DIR: trials, verifiers, judges and the fixture endpoint all read blobs by hash. Editing a suite on disk creates a new version for future experiments only.

### 4.5 Versions: what an edit creates and what the user sees

Decision (24 Oct 2026): tasks are edited as files on disk and stay read-only in the UI; to run an experiment again on edited tasks, the user duplicates it. An experiment is never re-versioned: it stays pinned to the suite version it ran, so its results always describe what was tested.

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

- **Definition shape.** stdio: command, args, env variable names. http: URL and pairs of header name and variable name (`Authorization ← VENDOR_API_TOKEN`). The schema's `header_names` array becomes a `headers` list of `{header, env}` pairs (a migration).
- **Reserved names.** A definition may not reference a provider credential, `DATABASE_URL` or any other variable of the worker's, egress's or the trial's own (`WORKER_RESERVED_ENV_NAMES` and `WORKER_RESERVED_ENV_PREFIXES` in `packages/shared/src/env-names.ts`), as an env name or as a header variable, and one name may not be both a stdio env name and an http header variable. The API refuses these when a definition is saved; the worker refuses them again before it tests or runs one, which covers versions stored before the rule. Values are kept out of the container rather than redacted, because no redaction catches an encoded value.
- **Presence.** `GET /resources/secrets` lists each referenced name with set or not set, its source, what references it, and its exposure. The worker records the names in its own environment on its `workers` row at start (it already stores `env_names`), and the names egress has, which it asks for over the egress admin socket at start and on each heartbeat. Values never leave either process. A test or run with a missing name fails as `setup` and names it.
- **stdio servers have no network.** Hermes starts stdio servers with a filtered environment (PATH, HOME, USER, LANG, LC_ALL, TERM, SHELL, TMPDIR, `XDG_*`, plus the server's own `env`; `tools/mcp_tool_config.py:147,199`), so the proxy variables never reach them, and the slot network has no other route. The sample `invoice-db` is file-backed for this reason. A server that needs a remote service is defined as http instead. `docs/limits.md` says so.
- **The MCP gateway** (egress, `:8080/mcp/<name>`) forwards only to the definition's exact URL, follows no redirects, streams responses (streamable HTTP transport), and records each call in the attempt's connection log. The worker registers the attempt's routes (name, URL, header-to-variable pairs) with its token. The upstream may be a private address, such as a server on the user's machine, because the definition chooses it and the agent cannot. The `test-mcp-server` job uses the same path.

### 5.4 Materialisation into a trial

Given a claimed attempt, the worker prepares `trials/<attemptId>/` in the `trials` volume. The trial container later mounts exactly two subpaths of it: `home` at `/opt/data` and `workspace` at `/workspace`. `launch.json` and `stderr.log` stay beside them, outside the trial's view.

1. Create `home/` and `workspace/` as fresh real directories (lstat-checked, never pre-existing).
2. Copy task files of kind `fixture` from the blob store into `workspace/`, re-checking each hash. Copy configuration documents into `workspace/docs/`.
3. Copy each configured skill into `home/skills/<name>/`, and write `home/.no-bundled-skills` so Hermes does not add its 58 bundled skills. Hermes still installs its one essential skill, `hermes-agent` (about Hermes itself), in every home and it cannot be disabled (`tools/skills_sync.py:397-410`, `agent/skill_utils.py:275`). So the no-skill arm is not skill-free; it has exactly that skill, the same as every other arm, and the platform skill remains the only difference. The experiment write-up says so.
4. Write `home/task.txt` with the prompt and `home/config.yaml` (section 8.2). No provider key, no `auth.json` and no MCP secret value is ever written into the home: the agent can read anything there through its terminal. `config.yaml` refers to stdio env values as `${NAME}` and has no http headers (section 5.3).
5. Record the launch record (argv, container spec, config.yaml, inputs with hashes, Hermes version and revision) before the container is created.

---

## 6. Configurations

Fields and validation as in the design: `name` unique and slug-like; `model` free text with suggestions from the price table; `provider` from a fixed list (`nous`, `nous-api`, `openrouter`, `openai`, `anthropic`, `custom`); `toolsets` from `GET /system/toolsets`, which the worker reads once at start by running the trial image (so the list is the real one at the pinned revision) and stores on its `workers` row; `memory_enabled` default false; `max_turns` 1 to 200; `time_budget_s` 30 to 3600.

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
- **Spend guard**: before each claim, the worker sums priced attempt costs; at or above the ceiling it pauses the experiment. Unpriced attempts are counted and shown, never coalesced to zero.
- **Circuit breaker**: `consecutive_execution_errors = consecutive_execution_errors + 1` in SQL on each execution error (reset on success); at `MAX_CONSECUTIVE_EXECUTION_ERRORS` (default 14) the experiment becomes `failed` with the structured `failure` (category, message, first stderr line, attempt). `POST /experiments/:id/retry-failed` sets it back to `running`, clears the failure and re-sends queued runs like resume.
- **Retry a run**: from `execution_error` with attempt_count < 5, set it `queued` and send `execute-run` with the next attempt number; a completed experiment goes back to `running`.
- **Duplicate**: returns a prefilled New experiment form on the suite's current version, listing the tasks that changed, were removed or became invalid since the original (section 4.5).

A handler cannot re-send its own singleton key while its job is active (pg-boss refuses it). When a handler must put a job back for later, it uses `deferJob`, which completes the active job and sends the delayed copy in one transaction (verified).

### 7.4 Completion: one reconcile function

`reconcileExperiment(tx, experimentId)` is called inside every transaction that finishes a run (scores published, final execution error, cancellation, recovery) and by the periodic recovery pass as a safety net. Retries are scheduled before it runs, in the same transaction, so a run waiting for its retry is still `queued`.

1. `SELECT ... FROM experiments WHERE id = $1 FOR NO KEY UPDATE`.
2. Settled means no run in `queued | running | executed | scoring` and no evaluation in `queued | running`. If not settled, return.
3. Compute the verdict entries from the current scores in the same transaction.
4. Conditional update: `SET status = 'completed', finished_at = now(), verdict_history = verdict_history || $entries, verdict_revision = results_revision WHERE id = $1 AND verdict_revision IS DISTINCT FROM results_revision`. Two finishers at the same moment append once (verified). For an already completed experiment that was re-scored, the same append with cause `rescore` when `verdict_revision < results_revision`.

---

## 8. Execution pipeline (worker)

### 8.0 Why a container per trial

Decision status: **confirmed and built.** Directory isolation (a fresh `HERMES_HOME` per trial, Hermes as a subprocess of the worker) fails on three counts, each verified in the Hermes source at revision `4d04303`:

- **It does not confine the agent.** The file tools accept absolute paths (`tools/file_tools_paths.py:155-171`), the terminal runs `bash -l` as the worker's user with its environment and network, and proxy variables are advisory. An agent could read suites, other trials and blobs, and reach Postgres and the unauthenticated API.
- **It cannot stop a run.** `hermes chat --format stream-json` is a thin client. The agent loop, tools and MCP servers run in a `hermes gateway` daemon it starts in its own session (`hermes_cli/gateway_runtime_start.py:78`), which outlives the client and idles for 600 s. Killing the client's process group leaves the run going.
- **Concurrent trials collide.** One gateway per user takes a host lock under `~/.local/state` (exit 75 for the second), and gateways bind their session API on loopback without auth, reachable by any trial sharing the network namespace.

A container per trial fixes all three: its filesystem view is two mounts, its network is an internal slot network, and stopping it ends every process in its PID namespace. Measured overhead on this machine: 0.10 s median to start and remove an isolated container, against trials of minutes.

### 8.1 Claim, admission and leases

`execute-run` workers run with `batchSize 1` and `localConcurrency = WORKER_CONCURRENCY`; a handler does not return until its container is removed, so the worker slot bounds live containers. Each job is `{runId, attempt, trigger}` with singleton key `runId:attempt`.

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

Corrections to the earlier contract, from the Hermes source: `--run-budget` is rejected on this path, so the budget goes in `config.yaml` as `agent.run_budget_seconds`; `--source tool` is dropped, because it disables Hermes's one-shot behaviour; `--ignore-user-config` and `--ignore-rules` are never used; the session id comes from the `result` event, not `system/init`. `--yolo` is safe because the container is the boundary; without it, flagged commands are denied in one-shot mode.

`home/config.yaml` sets: the model and provider with the gateway base URL and attempt token; toolsets; `memory.memory_enabled`; `mcp_servers` (names and `-t` aliases; stdio `env` entries as `${NAME}`, which Hermes fills from the container environment when it starts the server; http servers as `url: http://egress:8080/mcp/<name>` with no headers); `agent.max_turns` and `agent.run_budget_seconds`; and, so the run makes no avoidable network calls and does not change behaviour between arms: `updates.check: false`, `plugins.auto_update_check_hours: 0`, `curator.enabled: false`, `auxiliary.title_generation.enabled: false`, compression pinned to the gateway, `model.context_length`, `security.allow_lazy_installs: false`, `security.protected_instruction_files: false`, `gateway.unmanaged_idle_exit_seconds: 5`, and `approvals.mode: off`.

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

All final platform events (`killed`, `cancelled`, `collected`) are written before, and in the same transaction as, the update that finishes the attempt; the database refuses events after that. Finishing an executed attempt also sets the run to `executed`, inserts its evaluation (generation 1) and sends `evaluate-run`, all in that transaction.

Retry policy: `provider` and `timeout` once automatically (attempt 2, 30 s later); `worker_lost` by recovery up to 3 attempts; `setup` and `other` only by the user, up to 5 attempts.

### 8.5 Artifact collection

After the container is removed (so nothing can change under the walk), the worker walks `trials/<attemptId>/workspace` with `walkTrialTree` and reads files with `readTrialFile` (`apps/api/src/sandbox/trial-files.ts`). The agent controls every name, link and file type there, and the worker resolves them in its own view, where `/data` and `/trials` hold suites, blobs and other attempts. So the walk uses lstat and never follows a link; links are listed with their target text only. FIFOs, sockets and devices are listed and never opened. Names that are not valid UTF-8 are listed and not read. Depth stops at 32 and the walk at 5,000 entries. A read opens with `O_NOFOLLOW | O_NONBLOCK`, checks with fstat that the file is regular, and on Linux checks through `/proc/self/fd` that the file it opened is under the attempt's directory, which catches a link in a parent component. Each regular file is hashed, written to the blob store if new, and recorded as an artifact labelled by comparing with the input manifest: fixture or document unchanged or modified, or agent. Files over 25 MB are recorded with `skipped_reason` and no content. The home is then deleted entirely; the workspace is kept for `TRIAL_RETENTION_DAYS`. Re-scoring reads only blobs.

### 8.6 Recovery

Every worker runs recovery at boot and every 15 s, one pass at a time across workers (advisory lock):

1. Revoke: `UPDATE attempts SET lease_revoked_at = now()` for running attempts whose lease expired, whose worker stopped, or that passed their deadline plus 120 s.
2. For each revoked running attempt whose sandbox host is this worker's Docker daemon: list containers by its attempt label, stop, wait, confirm not running, remove, and list again until empty. An attempt on another daemon is left revoked and keeps its slot until a worker on that daemon confirms it. A missing heartbeat alone never proves the trial stopped.
3. Finalise in one transaction (experiment, run, attempt locks): end the attempt as `execution_error · worker_lost` (or `cancelled` if cancel was requested), requeue the run with the next attempt if allowed, then reconcile.
4. Sweep: remove trial containers whose attempt is no longer running, and any container past its deadline label.
5. Re-send `execute-run` for queued runs of running experiments (lost jobs) and `evaluate-run` for evaluations whose claim expired; the exclusive keys make both no-ops when the job still exists.

### 8.7 Isolation self-test

At boot the worker starts a probe trial container and checks, from inside it, that only the two mounts exist, that Postgres, the API, the host gateway, `host.docker.internal`/`host.lima.internal` and a public address are unreachable directly, and that egress refuses private targets. If any check fails, the worker refuses to run experiments and `/system` shows why. It never falls back to running Hermes without a container.

---

## 9. Evaluation pipeline (worker)

### 9.1 Answer extraction

From `attempts.final_text`: find all fenced blocks tagged `json`; take the last; parse. Store `{start, end}` offsets and the parsed value (or the parse error with position) on the evaluation as `answer`, so the attempt stays immutable and each re-score keeps its own extraction. No block → every answer-based key becomes `ungradable` with the comment "no fenced JSON block found in final response". Invalid JSON → `ungradable` with the position. The inspector highlights the range.

### 9.2 Scorer interface

```ts
interface ScorerContext {
  task: TaskRecord;
  attempt: AttemptRecord;
  answer: ExtractedAnswer;
  events: RunEvent[];
  artifacts: ArtifactRecord[];
  workspaceDir: string | null;
  judge: JudgeClient | null;
}
interface ScorerResult {
  key: string;
  status: ScoreStatus;
  score: number | null;
  value?: string;
  comment: string;
  expected?: unknown;
  observed?: unknown;
  evidence?: { eventSeqs?: number[]; artifactIds?: string[] };
}
interface Scorer<P> {
  type: string;
  params: ZodType<P>;
  selfCheck: 'answer' | 'script' | 'none';
  run(ctx: ScorerContext, params: P): Promise<ScorerResult>;
}
```

The registry maps `type` to a scorer. A scorer that throws yields `status: error` with the message; it never yields a zero.

### 9.3 Scorers

| Type                | Params                                                                                                                      | Pass rule                                                      | Implementation                                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `numeric_tolerance` | `path?`, `abs?`, `rel?`                                                                                                     | `                                                              | observed − expected                                                                                                                                                                                                                      | ≤ abs`or`≤ rel ×         | expected                          | `   | ours; coerces numeric strings; non-number → `failed` with comment |
| `json_match`        | `path?`, `unordered?`, `inner_unordered?`, `exclude_keys?`, `pass_at` (default 1.0)                                         | openevals `createJsonMatchEvaluator` score ≥ `pass_at`         | wrapper normalises lists when unordered before calling                                                                                                                                                                                   |
| `exact_match`       | `path?`, `trim?`, `case_sensitive?`                                                                                         | equality                                                       | ours (openevals' version lacks the options)                                                                                                                                                                                              |
| `file_check`        | `path`, `must_exist`, `format?: csv                                                                                         | json                                                           | text`, `columns?`, `row_count?`, `json_schema?`, `contains?`                                                                                                                                                                             | all declared checks pass | ours, reads from stored artifacts |
| `trajectory_match`  | `tool`, `args?` (subset match), `min_calls`, `max_calls?`, `mode?` (strict/unordered/subset/superset for full trajectories) | count rule, or openevals trajectory match when `mode` is given | builds the OpenAI-style message list from `tool_use`/`tool_result` events                                                                                                                                                                |
| `verifier_script`   | `script`, `timeout_s` (default 30), `pass_at` (default 1.0)                                                                 | printed score ≥ `pass_at`                                      | runs `python3 verify/<script> --answer <tmp>.json --workspace <dir>` in the worker, outside any trial, with the verifier files and the attempt's artifacts materialised from blobs into a temp dir; no stdout line or bad JSON → `error` |
| `llm_judge`         | `rubric` (file in task dir), `pass_at` (default 0.7), `model?`                                                              | judge score ≥ `pass_at`                                        | openevals `createLLMAsJudge` with an OpenAI SDK client pointed at the configured provider base URL; agent text is wrapped as untrusted data in the prompt; the reference and rubric are given as facts                                   |

`scorer_version` is a constant per scorer bumped on behaviour changes, stored on each score row.

### 9.4 Re-score and publishing

Scoring is a claim, then pure computation, then one publish transaction:

- **Claim**: `UPDATE evaluations SET status = 'running', started_at = now(), claim_token = gen_random_uuid(), claim_expires_at = now() + interval '10 minutes' WHERE id = $1 AND status IN ('queued', 'running') RETURNING claim_token`. A redelivered job takes a new token; zero rows means it already finished.
- **Score**: scorers read blobs, events and the answer, and write nothing.
- **Publish**, one transaction: lock experiment then run; re-read the evaluation `FOR UPDATE` with the claim token (zero rows: a newer delivery owns it, roll back); insert every score in one statement; supersede the previous current evaluation; complete this one (the database checks current attempt, complete key set, newest generation); set the run `scored`; reconcile.
- **Re-score** (`POST /runs/:id/rescore`, bulk variant): insert an evaluation with the next generation and send `evaluate-run` in one transaction. One evaluation per run can be queued or running, so double clicks collapse.
- **Dead letter**: when `evaluate-run` exhausts its retries, the dead-letter handler publishes one `error` score per key for a first evaluation, so the run still reaches `scored`, or marks a re-score `failed`, leaving the previous result current.

If the experiment is completed, publishing raises the results revision and reconcile appends a verdict with cause `rescore`.

### 9.5 Judge cost accounting

Judge calls record their own tokens on the score row's `evidence.judge_tokens`; `docs/costs.md` separates execution cost from grading cost.

---

## 10. Statistics and comparison

### 10.1 Inputs

For a candidate version against the baseline, for the selected score key (`primary` by default, or a named key present on every task, or `any_failed`):

- Per task, per configuration: the set of runs whose status is `scored` or `execution_error` (counted as not passed). `cancelled` runs are excluded. A run is "passed" when the selected key's status is `passed`; `failed`, `error` and `ungradable` all count as not passed, and are reported separately.
- Pass rate per task per configuration = passed / counted.

### 10.2 Computation

- Observed difference = mean over tasks of (candidate rate − baseline rate).
- Bootstrap: resample the task list with replacement 10,000 times, recompute the mean difference each time with each task's runs kept together, take the 2.5th and 97.5th percentiles. Seeded RNG (seed = experiment id hash) so results are reproducible.
- Verdict: `better` if lo > 0, `worse` if hi < 0, else `inconclusive`. `provisional` while the experiment is running.
- Gate: statistics are computed only when every selected task has ≥ 2 counted runs per configuration; otherwise the response says why.
- Sensitivity: the same difference computed excluding runs whose status is `execution_error` or key status is `error`/`ungradable`, reported beside the main figure.
- Secondary metrics per configuration: median duration, mean tokens, cost, execution error count, ungradable count.

### 10.3 Endpoints

`GET /experiments/:id/comparison?candidate=&key=&filter=` returns the task grid rows (cells with run id, statuses, duration, primary comment), per-task rates and deltas, the statistics block, secondary metrics and the sensitivity figure. It reads in a `REPEATABLE READ READ ONLY` transaction, reading `results_revision` first, and is cached by `(experiment, candidate, key, filter, results_revision)`. Because the revision moves on every run status change and every published or superseded score set, a retry, cancellation, execution error or re-score can never serve a stale comparison.

Verdict history lives on the experiment and is shown on the VerdictCard as "Updated … · previously …".

### 10.4 Verification of the statistics module

A unit test feeds the illustrative 12 × 5 × 2 dataset from the design and asserts the same numbers the design shows (0.633, 0.850, +0.217, interval within ±0.02 of [+0.117, +0.333] given the seed), and a second test asserts `inconclusive` on the Flow B dataset.

---

## 11. API surface

Prefix `/api`. JSON bodies validated by `ZodValidationPipe` with schemas from `shared` (`packages/shared/src/contracts`); Swagger at `/api/docs` is generated from the same schemas. State-changing requests need `X-Requested-With` and an allowed `Origin` and `Host` (section 6.1). Errors: `{ statusCode, message, issues? }`. Pagination: `?limit=&cursor=` on list endpoints; runs default to 200 per page.

| Method, path                                                                                                                                                                                                                                                                             | Purpose                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                                                                                                                                                                                                                                            | exists                                                                                                                                                                 |
| `GET /system/summary`, `GET /system/workers`, `GET /system/sandbox`                                                                                                                                                                                                                      | workers, running experiments `{count, scored, total}`, queued runs; every worker with presence and slots; the newest live worker's isolation report (built in Phase 1) |
| `GET /system/events` (SSE)                                                                                                                                                                                                                                                               | running summary and worker presence every 5 s                                                                                                                          |
| `GET /suites`, `GET /suites/:id`, `GET /suites/:id/tasks/:key`, `POST /suites/reload`                                                                                                                                                                                                    | section 4                                                                                                                                                              |
| `GET /suites/:id/history`, `GET /suites/:id/tasks/:key/history`, `GET /suites/:id/tasks/:key/diff?against=:suiteId`                                                                                                                                                                      | every version of a suite directory with its changes and the experiments that used it; a task's versions; a task diff between two suite versions (section 4.5)          |
| `GET /suites/:id/tasks/:key/fixtures/:path`, `…/fixtures/:path/preview`                                                                                                                                                                                                                  | fixture download; the first rows of a CSV or TSV fixture                                                                                                               |
| `GET/POST /resources/skills`, `POST /resources/skills/validate`, `GET /resources/skills/:id`, `GET /resources/skills/:id/files/:path`, `GET /resources/skills/:id/zip`                                                                                                                   | section 5.1                                                                                                                                                            |
| `GET/POST /resources/documents`, `GET /resources/documents/:id/content`                                                                                                                                                                                                                  | section 5.2                                                                                                                                                            |
| `GET/POST/PUT /resources/mcp-servers`, `POST /resources/mcp-servers/:id/test`, `POST /resources/mcp-servers/test` (unsaved definition)                                                                                                                                                   | section 5.3                                                                                                                                                            |
| `GET /resources/secrets`, `GET /resources/counts`                                                                                                                                                                                                                                        | per name: set/not set, source (worker or egress), referenced by, exposure; the Resources tab counts                                                                    |
| `GET /providers`, `POST/GET/DELETE /providers/nous/login`, `POST /providers/nous/logout`                                                                                                                                                                                                 | model access status and the Nous connect flow (section 6.1)                                                                                                            |
| `GET/POST /configurations`, `GET /configurations/:id`, `PUT /configurations/:id` (new version when frozen), `GET /configurations/:id/versions/:v`, `GET /configurations/diff`, `GET /configurations/form-options`, `GET /configurations/:id/draft`, `POST /configurations/:id/duplicate` | section 6                                                                                                                                                              |
| `GET /experiments`, `POST /experiments`, `GET /experiments/:id`, `GET /experiments/estimate`                                                                                                                                                                                             | section 7                                                                                                                                                              |
| `POST /experiments/:id/pause`, `/resume`, `/cancel`, `/retry-failed`, `/duplicate`                                                                                                                                                                                                       | section 7.3                                                                                                                                                            |
| `GET /experiments/:id/events` (SSE)                                                                                                                                                                                                                                                      | run status transitions, scores landed, counts, experiment status; polled from Postgres every 1 s per subscriber with a shared poller per experiment                    |
| `GET /experiments/:id/comparison`                                                                                                                                                                                                                                                        | section 10                                                                                                                                                             |
| `GET /experiments/:id/runs` (filters: config, task, status, score_status, exec_error, ungradable; sort)                                                                                                                                                                                  | Runs tab                                                                                                                                                               |
| `POST /experiments/:id/runs/rescore`, `POST /experiments/:id/runs/retry` (bulk, body: run ids)                                                                                                                                                                                           | bulk bar                                                                                                                                                               |
| `GET /runs/:id` (header, outcome, attempts), `GET /runs/:id/events?after=`, `GET /runs/:id/artifacts`, `GET /runs/:id/artifacts/:artifactId/content`, `GET /runs/:id/counterpart?version=`                                                                                               | inspector                                                                                                                                                              |
| `POST /runs/:id/rescore`, `POST /runs/:id/retry`, `POST /runs/:id/cancel`                                                                                                                                                                                                                | inspector actions                                                                                                                                                      |

SSE event shapes are zod schemas in `shared`; the web `useSse` composable validates each event and reconnects with backoff 1, 2, 5, 10 s, showing `reconnecting` and `offline` states as designed.

---

## 12. Frontend

### 12.1 Foundations

- **Styling is Tailwind CSS** (decision 24 Oct 2026). The design tokens stay CSS variables in `tokens.css`, switched by `data-theme`, and map into Tailwind's theme (`@theme inline`), so utilities like `bg-surface` and `text-fail-text` follow both themes. The hand-ported global stylesheet (`src/assets/main.css`, about 1,160 lines of canvas classes) is replaced by utilities in the components at the start of the frontend phase, with a small `@layer components` only for patterns repeated everywhere (buttons, chips, data tables). `IBM Plex` loading is done; density and status chip styles come from the status mapping on the visual direction board.
- `StatusChip` takes `status` and `kind` (run, score, experiment, verdict) and derives tone and dot mode from one table in `shared` so the API and UI agree.
- `DataTable` with declared columns, sort state via `v-model:sort`, selection, density, loading skeletons, error banner, `liveKeys` (sorting on a live column freezes order until re-sort).
- `useUrlState` mirrors filters and sort into the query string.
- `useSse(url, schema)` wraps EventSource with validation and state.
- `useKeyboardGrid` for arrow keys in TaskGrid.

### 12.2 Pages, in build order (Flow A order)

1. Model access (System page card, section 6.1): provider rows with status chips, the Nous connect flow in all its states, `ConnectDialog`, and every nudge in the section 6.1 table (setup card, AppShell banner and approval pill, configuration form notice, New experiment blocker, disabled controls, the `provider_disconnected` pause). First, because nothing else can run a model without it.
2. Resources: Skills (list, upload dialog with validate step, detail panel), Documents, MCP servers (form with transport explanation, test start), Secrets.
3. Configurations: list with compare, form (versioning banner, change summary, toolsets from `/system/summary`, unknown model warning), detail (fields, versions, used-in).
4. New experiment: six sections, `ExperimentSummaryPanel` with live estimate from `/experiments/estimate`, invalid task rows, inline diff, launch with 409 handling.
5. Experiment overview: running (progress breakdown, per-config bars, feed, pause/resume/cancel with `ConfirmInline`, spend line, no-worker banner, paused-by-ceiling state) and complete (`VerdictCard` with history line, aggregates, snapshot strip, duplicate).
6. Comparison: controls, `TaskGrid` with `RepetitionCells` and tooltips, `IntervalBar`, statistics text, secondary metrics, sensitivity, provisional and nothing-scored states, one-repetition state, candidate select.
7. Runs tab: filters in URL, count chips, bulk bar with the retry rule.
8. Run inspector drawer: route-backed, prev/next (J/K) over the caller's ordered ids, A/B jump with disabled reasons, five sections, `TimelineScrubber`, `EventTimeline` virtualised above 200 events, `JsonBlock`, artifacts with CSV/text preview, launch record; states for execution_error, running (live, Jump to latest), cancelled, ungradable, scorer error, multi-attempt.
9. Suites: list with reload, detail with self-check failure expansion, task detail with prompt, fixtures preview, `VerificationSentence`, hidden reference panel, verifier source, self-check panel, history. Version numbers, the suite History panel, task version history with diffs, and the newer-version notice on older experiments (section 4.5).
10. Experiment list with live rows and the failed-experiment reason.
11. System page (exists) gains workers and secrets presence.

### 12.3 State

Pinia stores per domain hold normalised records keyed by id and expose loaders. SSE updates patch records in place so rows never reorder while live. The drawer reads the run from the store if present and fetches details lazily.

### 12.4 Tests

Vitest with Testing Library for: StatusChip mapping, IntervalBar domain and aria label, RepetitionCells statuses, ConfigDiffTable differs count, ExperimentSummaryPanel maths and disabled reasons, JsonBlock extraction highlight, useSse reconnect states, TaskGrid keyboard navigation.

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
- **Credentials**: provider keys and http MCP header values live in egress (and provider keys in the worker, for the LLM judge); the Nous login lives in nous-proxy's volume. Trials hold a revocable per-attempt token and, only when a configuration includes a stdio MCP server, that server's env values, which the agent can read (section 5.3). The UI labels every such value "Readable by the agent" and advises scoped or throwaway values; a secret that must stay out of reach belongs to an http server, where egress adds it.
- **MCP gateway**: forwards only to a definition's exact URL, follows no redirects, adds that definition's headers, and logs each call per attempt (section 5.3).
- **Nous login service**: `nous-login` holds the device flow and writes the login into `nous-home`; it returns no token to anyone. It sits only on the internal `provider-admin` network with the API and the worker (and on `edge` to reach the portal), so trials and egress cannot reach it. Its state-changing API routes require a JSON body and `X-Requested-With`, so other sites in the user's browser cannot drive them.
- **Verifier scripts**: user-provided code, run by the worker outside any trial against materialised artifacts, with a 30 s timeout and a minimal environment. Optionally run in a `network: none` container through the guard.
- **Collection**: lstat walk, no symlink following, special files and undecodable names never opened, caps on depth, count and size, after the container is removed (section 8.5).
- **Disk**: home and workspace capped at 2 GiB and 50,000 files while the trial runs; the container is killed when either is passed (section 8.2).
- **Ports**: Postgres, the API and the web app are published on `127.0.0.1` only, for local development; nginx proxies `/api`. Trials have no route to the host, so they cannot reach these ports.
- **API**: no auth, by requirement (single local user); CORS restricted to the web origin. Unreachable from trials.

---

## 15. Packaging and configuration

- **Services**: postgres, api, worker, web, docker-guard, egress, `trial-image` (build-only: builds or pulls the pinned Hermes image and exits), nous-proxy and nous-login (both start by default; without a login they report `not_connected` and egress answers Nous model calls with 503 "Nous Portal is not connected").
- **Networks**: `backend` (postgres, api, worker, web), `edge` (egress, nous-proxy, nous-login, internet), `llm` (internal: egress to nous-proxy), `provider-admin` (internal: api and worker to nous-login), and four internal slot networks `hermes-evals-trial-0..3` with isolated gateway mode (Engine 28+; `inhibit_ipv4` on older engines), each shared only by one trial and egress.
- **Volumes**: `pgdata`; `evaldata` (blobs, skills; worker and api only); `hermes-evals-trials` (trial homes and workspaces; worker, and two subpaths per trial); `guard-sock`, `egress-admin` (unix sockets shared only with the worker); `nous-home`.
- **Images**: the worker image no longer installs Hermes, git or uv. The trial image is `FROM nousresearch/hermes-agent:v0.22.4@sha256:7a69201726bc64db2072a1371557137c23312d29705cda2b8ea2a0214a50a4cf` with the entrypoint replaced, uid 10000 and the sample MCP servers baked in: one 1.1 GB pull instead of a 15 to 45 minute source build.
- **Credentials**: `.env` holds API-key provider credentials, read by egress and the worker only (the API sees only whether each is set), and MCP secret values: stdio env values are read by the worker, http header values by egress. Nous Portal is connected from the UI (section 6.1); the terminal command `docker compose run --rm nous-proxy auth add nous --type oauth --no-browser` remains as a fallback. For development, `NOUS_HOST_PROXY` reuses the host's Hermes login instead. Nothing per trial.
- **Migrations** run at boot in api and worker under an advisory lock; a database that is unreachable leaves the process degraded, a migration whose recorded hash differs stops it. `apps/api/package.json` ships `dist` and `drizzle`; both Dockerfiles check the journal is present.
- **Machine requirements**: Docker Engine 26+ (volume subpaths; archive-copy fallback otherwise). Colima `--memory 8` or Docker Desktop with at least 6 GB for three concurrent trials; the README states this.
- **Env additions**: `MAX_CONSECUTIVE_EXECUTION_ERRORS=14`, `TRIAL_RETENTION_DAYS=7`, `PRICES_FILE`, `TRIAL_IMAGE`, `TRIAL_SLOTS`, `DOCKER_SOCK` (guard only).

---

## 16. Testing strategy

| Layer           | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | How                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| shared          | every zod schema accepts the sample suite and rejects known-bad variants                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | vitest                                         |
| api unit        | loader hashing and validity rules, configuration versioning rule, experiment matrix size, estimate maths, state transitions, statistics (section 10.4), answer extraction edge cases (no block, several blocks, invalid JSON)                                                                                                                                                                                                                                                                                                               | vitest, no DB                                  |
| api integration | migrations, constraints and integrity triggers (`schema.spec.ts`, `integrity.spec.ts` on PGlite); concurrent migrations, node-postgres types, transactional enqueue and concurrent claiming (`postgres.e2e-spec.ts` on Postgres 17)                                                                                                                                                                                                                                                                                                         | vitest; e2e needs `TEST_DATABASE_URL`          |
| scorers         | each scorer against fixtures: pass, fail, error, ungradable paths; verifier runner timeout; judge with a stubbed OpenAI client                                                                                                                                                                                                                                                                                                                                                                                                              | vitest                                         |
| hermes adapter  | stream parser against recorded JSONL from the spike, exit classification table, deadline stop of a stub container                                                                                                                                                                                                                                                                                                                                                                                                                           | vitest                                         |
| sandbox         | docker-guard refuses every forbidden create body and endpoint; egress refuses every private-target encoding and wrong token; isolation self-test                                                                                                                                                                                                                                                                                                                                                                                            | vitest with fixtures; Colima for the self-test |
| worker e2e      | one task through execute and evaluate with a stub trial image that emits a canned stream, so CI never needs a model                                                                                                                                                                                                                                                                                                                                                                                                                         | vitest + Compose Postgres                      |
| model access    | `nous-login` in the real trial image against a fake portal (`HERMES_PORTAL_BASE_URL`): approve, deny, expiry, `subscription_required`, cancel, a second Connect replacing the first, and nous-proxy serving the new login without a restart; the startup contract check; API routes with a fake login client, including the `X-Requested-With` rule and the 409 on launch; the provider guard pausing with `provider_disconnected` without spending an attempt; component tests for `ConnectDialog` and each nudge in the section 6.1 table | vitest                                         |
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

### Phase 2: Execution and sandbox (5 days)

docker-guard and egress services with their unit tests (malicious create bodies, bypass fixtures); trial materialisation calls `refusedEnvNames` before any MCP env enters a trial, and `execute-run` keeps `workers.in_flight` current; the egress MCP gateway route and secret presence on its admin socket (section 5.3); `nous-login`, the `providers` API module and the launch check for an unconnected provider (section 6.1); trial runner through the guard; claim, admission, leases, heartbeat, recovery and isolation self-test; launch, pause, resume, cancel, spend guard, circuit breaker, reconcile; SSE.

Exit: a 3-task × 2-configuration × 2-repetition experiment runs end to end in containers; the fake-Hermes e2e test (a stub image emitting canned stream-json) is green.

### Phase 3: Scoring (2 days)

The `trajectory_match` and `llm_judge` runtimes, judge client, a common scorer context, claim and publish, dead-letter handler, re-score. Extraction, the registry, the other five scorers and the verifier runner were built in Phase 1.

Exit: scorer tests green; seeded wrong answers produce the right statuses; duplicate deliveries publish once.

### Phase 4: Analysis (1 day)

Statistics, comparison endpoint cached by results revision, verdict history, estimates.

### Phase 5: Frontend (5 days)

First, move the web app to Tailwind CSS (section 12.1). Then pages in the order of section 12.2, each against the real API, with component tests. The System page shows the isolation self-test and, first, the Model access card with the Nous connect flow.

### Phase 6: Sample suite and skill (1 day, overlaps Phase 5)

All 12 tasks with fixtures, references, verifier scripts, the expected workspace for `summary_file`, and the `invoice-method` skill. The example stdio MCP server `invoice-db` (file-backed, since stdio servers have no network; section 5.3) is already in the trial image (Phase 1); this phase only extends its data if a task needs it.

### Phase 7: Packaging (1 day)

`docker compose up --build` from a clean clone to a green System page on Colima and Docker Desktop; README states the Docker and memory requirements and the one-time Nous login.

### Phase 8: Experiment, documents, video (2 days)

Run the official experiment (section 19), write the documents, record the video.

Total: about 21 working days. Phases 5 and 6 can run alongside Phases 2 to 4 once the API contracts in `shared` are frozen.

---

## 18. Sample suite: `invoices-v1`

Twelve tasks over one fixture family: `invoices.csv` (48 rows, 8 columns: invoice_no, vendor_name, invoice_date, due_date, amount, currency, po_number, status), `credit_notes.csv`, `payments.csv`, `rates.json`, `policy_terms.json`, `purchase_orders.csv`. Each task has exactly the traps the `invoice-method` skill warns about, and the fixtures are generated by a script (`scripts/gen-fixtures.ts`) with a fixed seed so references are computed, not typed.

| Task         | Answer                | Primary scorer                           | Trap                                                  |
| ------------ | --------------------- | ---------------------------------------- | ----------------------------------------------------- |
| total_due    | number                | numeric_tolerance abs 0.01               | paid rows must be excluded                            |
| overdue_list | string[]              | json_match unordered                     | due on the cutoff day is not overdue                  |
| dup_invoices | pair[]                | json_match unordered, inner unordered    | duplicates differ by invoice number                   |
| vat_split    | {band: {net, vat}}    | json_match + numeric_tolerance           | one band is zero-rated                                |
| credit_notes | {invoice: net}        | json_match                               | a credit note references a paid invoice               |
| currency_mix | number                | numeric_tolerance rel 0.001              | one rate is quoted inverted in rates.json with a note |
| missing_po   | string[]              | exact_match on sorted join               | empty po_number vs non-matching po_number             |
| late_fees    | {invoice: fee}        | numeric_tolerance + verifier_script      | policy has a grace period and a cap                   |
| per_vendor   | {vendor: outstanding} | json_match + trajectory_match(read_file) | vendor names have trailing spaces                     |
| disputed     | number                | json_match + llm_judge(method)           | disputed rows must be excluded, not zeroed            |
| partial_pay  | {invoice: balance}    | json_match                               | two payments on one invoice                           |
| summary_file | file                  | file_check + verifier_script             | must write summary.csv with one row per vendor        |

The skill `invoice-method` (SKILL.md plus checklist.md plus examples/reconcile.py) describes method only: load the whole file, normalise vendor names, apply credit notes and payments, exclude disputed, check the policy file. It never names a task or an answer. Its rules are defaults that yield to the task's own definitions: "exclude disputed" applies when a question asks what to pay now, not when a prompt says disputed invoices are still due (as `total_due` does). Otherwise the with-skill arm would be marked wrong for following the skill, and the comparison would measure a conflict instead of the method.

---

## 19. The official experiment

- Suite: `invoices-v1`, all 12 tasks. Baseline: `baseline` (gpt-6.1-sol via nous, file + terminal, memory off, no skills). Candidate: `with-skill` (same plus `invoice-method`). Repetitions: 5. Concurrency: 3. Spend ceiling: $5.
- Run it twice: once as a dry run on 3 tasks × 1 rep to check costs and prompts, then the full run. Only the full run is reported.
- Report in `docs/results.md`: the verdict card numbers, the task grid, the interval, the sensitivity figure, secondary metrics, three annotated runs (one baseline failure, its counterpart, one execution error if any), and the exact commands from the launch records.
- If the result is inconclusive, report it as such, with the per-task table, and say what repetition count the interval width suggests would be needed.
- Optional second experiment if budget allows: `baseline` vs `with-mcp` with the example MCP server, to demonstrate the MCP dimension.

---

## 20. Documentation deliverables

- `README.md`: run instructions (exists), add the experiment summary and links.
- `docs/design.md`: architecture, data model, pipelines, statistics method, decisions with alternatives considered (Postgres plus pg-boss over Redis, Drizzle over Prisma, Turborepo, fresh-home isolation over containers per trial, openevals for scorers, drawer inspector), assumptions (tasks as files, fixed scorer vocabulary, single user, trusted local use).
- `docs/limits.md`: tool output truncated at 5000 characters; one Hermes revision; memory not an experimented dimension; remote MCP state not reset; small suite means wide intervals; judge bias when judging with the agent's model family; no auth; terminal toolset reaches the whole container; scorer vocabulary fixed; `verifier_script` is Python only; stdio MCP env values are readable by the agent, and stdio servers have no network; the disk cap is polled, so a fast writer can overshoot it by about a second of writes.
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
| I15 | An http MCP server through the egress MCP gateway (streamable HTTP, headers added, no redirect), and a stdio server whose env is a `${NAME}` reference set in the container environment        | **To run.** Phase 2, with the gateway route. Also checks that neither value appears in any file under the home.                                                                                                                                                                                                                                                                                                                                                                                                 |

Risks:

| Id  | Risk                                                               | Mitigation                                                                                           |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| R1  | Nous rate limits at concurrency 3                                  | 429 is a provider error, retried once; lower concurrency                                             |
| R2  | The model solves every task with and without the skill             | Report it honestly; the traps in section 18 are designed to matter                                   |
| R3  | A reviewer's Docker lacks volume subpaths or isolated gateway mode | Archive-copy fallback and `inhibit_ipv4`; the self-test refuses to run if isolation cannot be proven |
| R4  | The gateway changes the request shape                              | Both arms use the same path, so comparisons stay fair; spike I4 restores parity with direct use      |

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

| #   | Concern                                                                                                    | Resolution                                                                                                                                                                                                                                                                    | Status                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Restricted environment per trial, no access to references, other trials, evidence, the database or the API | Container per trial with two mounts, internal slot network, egress proxy, model gateway, guarded Docker socket; scoring outside trials (sections 2, 8.0, 8.2, 14)                                                                                                             | Built and proven live: spikes I1 to I3, I5, I7 and I9 pass (section 21) |
| 2   | Immutable suite snapshot in content-addressed storage                                                      | `blobs` table with foreign keys from task files, documents and artifacts; loader writes blobs before rows; trials and re-scoring read only blobs (sections 3, 4.4, 5.4, 8.5)                                                                                                  | Schema implemented and tested; loader in Phase 1                        |
| 3   | Versioned MCP definitions                                                                                  | `mcp_servers` plus `mcp_server_versions`; configuration versions reference version ids; definitions freeze when used; latest-version pointer must resolve (deferred foreign key)                                                                                              | Implemented and tested                                                  |
| 4   | Atomic claims, ownership tokens, periodic recovery, confirmed termination                                  | Claim transaction (section 8.1); attempt lease token, expiry and revocation, sandbox id and host; fenced writes; recovery every 15 s that confirms the container is gone on its own daemon before requeueing (section 8.6); database refuses writes after revocation          | Schema implemented and tested; worker in Phase 2                        |
| 5   | Durable handoffs and duplicate-safe evaluation                                                             | Finish execution, mark executed, insert evaluation and send its job in one transaction; evaluation generation and claim token; whole score set published in one transaction; the database refuses partial sets, stale generations and a failed first evaluation (section 9.4) | Schema implemented and tested; handlers in Phase 3                      |
| 6   | One reconciliation after every relevant transition                                                         | `reconcileExperiment` under the experiment row lock, settled check over runs and evaluations, append once per results revision (section 7.4)                                                                                                                                  | Column and append rule implemented and tested; function in Phase 2      |
| 7   | Both concurrency limits                                                                                    | Worker slot = `localConcurrency`, handler holds it until the container is removed; experiment limit = database admission in the claim transaction, deferring with `deferJob` (section 8.1)                                                                                    | `deferJob` implemented and tested; admission in Phase 2                 |
| 8   | Results revision for comparison caching                                                                    | `experiments.results_revision` bumped by triggers on run status and score publication; comparison cached by it (section 10.3)                                                                                                                                                 | Implemented and tested                                                  |
| 9   | Known-good workspace for artifact verifiers                                                                | `expected/` folder declared in `task.yaml`, stored as task files of kind `expected`, overlaid on fixtures for self-check, plus a negative control (section 4.3)                                                                                                               | Schema and record shapes implemented; loader in Phase 1                 |
