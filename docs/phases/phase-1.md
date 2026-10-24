# Phase 1: data layer and definitions

Status: built and checked on 24 Oct 2026, waiting for review. Nothing is committed yet.

This document is for the review before Phase 1 is approved. It covers what Phase 1 changed, why, how it is designed, every endpoint it adds, and how to test it. Section numbers such as "plan 4.4" point at `IMPLEMENTATION_PLAN.md`. "UI_FLOWS 19 #8" means open point 8 in section 19 of `UI_FLOWS.md`.

Contents:

1. [What Phase 1 delivers](#1-what-phase-1-delivers)
2. [Decisions](#2-decisions)
3. [Design](#3-design)
4. [Endpoints](#4-endpoints)
5. [What changed](#5-what-changed)
6. [How to test it](#6-how-to-test-it)
7. [Known limitations and what Phase 2 picks up](#7-known-limitations-and-what-phase-2-picks-up)

---

## 1. What Phase 1 delivers

Phase 1 puts a working definitions layer on top of the schema. The worker loads each directory under `./suites` into an immutable, numbered suite version. The files go to the blob store, and every task is judged by its own self-check. The API serves those suites and their history and diffs. Users can upload skills and documents, define MCP servers and test them in a throwaway trial container, see which secret names are set, and save configurations as versions they can diff and duplicate. Each worker registers itself and reports its sandbox proof, toolsets and env names. Nothing runs an agent yet: launch, execution and run scoring come in Phases 2 and 3.

Exit criteria (plan 17, as refined for this phase):

| Criterion                                                       | Status | Evidence                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose up` serves suites, resources and configurations | Met    | Live check on the Compose stack: all six images rebuilt, migrations `0000` to `0003` applied, the worker passed 15 of 15 isolation checks and loaded `invoices-v1` as v1. `scripts/phase1-smoke.sh` passed 54 of 54 steps three times: without `INVOICE_DB_URL`, with it, and through nginx on `:8080`. |
| Unit and PGlite integration tests green                         | Met    | Run for this document: api 81 files, 727 passed, 5 skipped (section 6.1). shared, web, egress and docker-guard are all green.                                                                                                                                                                           |
| Postgres 17 e2e tests green                                     | Met    | Run for this document: 10 files, 44 passed, including the full-application spec `apps/api/test/phase1.e2e-spec.ts`.                                                                                                                                                                                     |
| Typecheck, lint and build green                                 | Met    | `pnpm turbo run typecheck lint test build --force`: 20 of 20 tasks, none cached.                                                                                                                                                                                                                        |
| Real-container tests (gated) green                              | Met    | `RUN_SANDBOX_TESTS=1` through a host docker-guard: 3 files, 22 passed.                                                                                                                                                                                                                                  |

---

## 2. Decisions

### 2.1 Decisions taken for this phase

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                               | Why                                                                                                                                                                                                                                                    | Resolves                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| D1  | The suite loader runs in the **worker**, as the pg-boss job `load-suites`. The worker also loads every suite when it starts. `POST /suites/reload` sends the job, waits for its output (`sendAndWait`) and returns the `SuiteReloadResult`.                                                                                                                                            | Verifier scripts are user code. Plan 14 says the worker runs them, outside any trial, and only the worker image has python3. The API no longer mounts or reads `./suites`.                                                                             | UI_FLOWS 19 #8. Plan 4.4 said "API start"; the worker's start replaces it.                              |
| D2  | The scoring core moves into Phase 1, because self-checks need it. That means the scorer registry with strict param schemas for all seven types, the answer extractor, `numeric_tolerance`, `json_match`, `exact_match`, `file_check` and the verifier runner. `trajectory_match` and `llm_judge` are schema-checked only; their runtimes are Phase 3.                                  | Plan 4.3 runs each runnable check against the task's own reference or expected workspace at load.                                                                                                                                                      | Plan 4.3, 9.1, 9.3 (part)                                                                               |
| D3  | The API contracts move from `apps/web/src/api/types` into `packages/shared` as zod schemas with the same names. The web types re-export them. Every response is the camelCase view model, and tests parse every response with its shared schema.                                                                                                                                       | One definition for both sides. Drift fails a test instead of breaking a page.                                                                                                                                                                          | Plan 11 ("schemas from `shared`")                                                                       |
| D4  | MCP secrets model. A stdio server names env variables: their values come from the worker's environment and are readable by the agent (`readable_by_agent`). An http server has `{header, env}` pairs: their values come from egress's environment (`egress_only`). A value is never stored, logged or returned. An http test fails in Phase 1, saying it needs the egress MCP gateway. | Plan 5.3 and invariant 7. The gateway is Phase 2.                                                                                                                                                                                                      | UI_FLOWS 19 #14 (`header_names` becomes `headers`)                                                      |
| D5  | Worker presence. Each worker start inserts a `workers` row and heartbeats it every 10 s. The row holds env variable names (never values), egress env names, toolsets and the sandbox self-test report. Leases are Phase 2.                                                                                                                                                             | The API serves the System and Secrets pages and must know whether a worker is live before it sends a job.                                                                                                                                              | UI_FLOWS 19 #2 (sandbox report stored on the row), #15 (names from egress)                              |
| D6  | Toolsets come from `hermes tools list`, run in the trial image when the worker starts (17 enabled built-in toolsets). `HERMES_TOOLSETS` in `packages/shared/src/runtime.ts` is the fallback, and `DEFAULT_TOOLSETS` is `file, terminal`.                                                                                                                                               | The list is the real one at the pinned revision.                                                                                                                                                                                                       | Plan 6. UI_FLOWS 19 #13: the form reads toolsets from `GET /configurations/form-options` (section 2.3). |
| D7  | MCP "Test start" for a stdio server runs a throwaway trial container through docker-guard with only that server configured (`hermes mcp test <name>`). A small sample stdio server, `invoice-db` (Python, file-backed, 4 tools), is baked into the trial image so that a test can pass.                                                                                                | Plan 5.3 left open whether Hermes or a direct MCP `tools/list` would list the tools. Hermes's own command works. Stdio servers get no network (Hermes strips the proxy variables), so an `npx`-style download cannot work, and the sample is baked in. | Plan 5.3, plan 18 (sample MCP server)                                                                   |
| D8  | The web app moves to Tailwind CSS in the frontend phase. Nothing in Phase 1 touches styling.                                                                                                                                                                                                                                                                                           | Kept out of a backend phase.                                                                                                                                                                                                                           | Plan 12.1                                                                                               |

### 2.2 Choices made while building

These are the places where the engineers chose something the plan or brief did not fix, or departed from it. Each one is in the code and tested.

| Area           | Choice                                                                                                                                                                                                                                                                                                                                                                                                           | Why                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loader         | The read and the self-checks happen **inside** the directory's locked transaction, and loads in one worker process run one at a time.                                                                                                                                                                                                                                                                            | A slower load that read older files can never save after a faster one that read newer files. This fixed a high-severity review finding.                                              |
| Loader         | A `task.yaml` that is not UTF-8 or does not parse fails the **whole directory**: outcome `error`, and the pointer stays on the last good version. Schema, params, missing-file and self-check problems keep the task, stored as invalid.                                                                                                                                                                         | Plan 4.4: "A parse failure records the error and leaves the pointer on the last good version."                                                                                       |
| Loader         | The content hash covers only the files the loader reads and stores: `suite.yaml`, `task.yaml`, `prompt.md`, `reference.json`, `fixtures/**`, `verify/**`, the expected folder and rubric files. Any other file, such as a README, is not hashed. Names starting with `.` are skipped at every level.                                                                                                             | Editing a README creates no new version, and the diff view never shows an unexplained change.                                                                                        |
| Loader         | `suite.yaml`'s `name` does not have to match the directory name. A second live directory that declares a taken name gets outcome `error` at the `name:` line. Names can be swapped in one reload.                                                                                                                                                                                                                | The unique index on live names enforces the rule.                                                                                                                                    |
| Loader         | Rules beyond plan 4.2: the expected workspace must be its own folder; a rubric must not sit under `fixtures/`; `fixtures` and `verify` must be folders; `prompt.md` must not be empty; a reference number that overflows (`1e999`) is `reference_invalid`.                                                                                                                                                       | Each one stops a task that would mislead at run time.                                                                                                                                |
| Loader         | Self-checks honour the task's `timeout_s` (default 30, at most 300).                                                                                                                                                                                                                                                                                                                                             | "30 s" in plan 4.4 is the default of `timeout_s`, not a separate cap at load. A review finding that asked for a cap was rejected (section 2.4).                                      |
| Scoring        | `scorer_version` is an integer (`SCORER_VERSIONS`, all 1). `scorerVersionLabel` gives `numeric_tolerance@1`.                                                                                                                                                                                                                                                                                                     | `scores.scorer_version` is an integer column with `CHECK >= 1`.                                                                                                                      |
| Scoring        | `json_match` is the platform's own deterministic matcher, not openevals' `createJsonMatchEvaluator` as plan 9.3 says. It keeps the same averaging: the fraction of keys that match, and item credit over the longer list. It pairs list items exact match first, then by the Hungarian method.                                                                                                                   | openevals compares string lists character by character and pairs items greedily, so a partial score depends on item order. Every call also goes through LangSmith's tracing wrapper. |
| Scoring        | A verifier that exits with a non-zero code is an `error`, even if it printed a valid result line. Its environment is `PATH`, `LANG`, `PYTHONDONTWRITEBYTECODE`, `PYTHONIOENCODING`, and `HOME` and `TMPDIR` set to a scratch folder. It runs in its own process group, which gets SIGKILL at the deadline.                                                                                                       | A crash means the check broke. Plan 4.3 and 9.3 never say the exit code can be ignored.                                                                                              |
| MCP            | The test container uses network `none`, not a slot network. The tool listing in presence uses `none` too.                                                                                                                                                                                                                                                                                                        | Stdio servers have no route out in a run either. A test then takes no slot from experiments and registers nothing with egress.                                                       |
| MCP            | Reserved names: a definition may not name a provider key, `DATABASE_URL`, a worker setting or a platform trial variable, by name or by prefix (`packages/shared/src/env-names.ts`). This applies to env names and to header variables. One name may not be both a stdio env name and an http header variable. The API refuses these when a definition is saved, and the worker refuses them again before a test. | Without this, a stdio definition could pull the worker's credentials into a trial container. This fixed a high-severity review finding. Plan 5.3 now states the rule.                |
| MCP            | A rename is refused once any version of the server has frozen. A frozen definition saved with only a reorder creates no new version.                                                                                                                                                                                                                                                                             | Configurations know a server by its name.                                                                                                                                            |
| MCP            | Test jobs are keyed `<versionId>:<definitionHash>`. If the wait times out, the answer is this job's own record, or `running`, never an earlier test's result. A reconciler at worker start and every 60 s marks tests left `running` by a dead worker as `failed`.                                                                                                                                               | A test after an in-place edit is its own job, and a crashed worker does not leave a test `running` for good.                                                                         |
| Configurations | A `PUT` whose settings equal the latest version's writes no version; a rename alone only renames. `POST /configurations/:id/duplicate` answers 200, since nothing is stored.                                                                                                                                                                                                                                     | Saving the same form twice must not create a version.                                                                                                                                |
| Configurations | Extra 400 rules: two versions of one skill name, two documents with the same filename, and a toolset the runtime does not offer.                                                                                                                                                                                                                                                                                 | They would collide in `home/skills/<name>/` and `workspace/docs/<filename>`.                                                                                                         |
| Configurations | A save locks the MCP rows it names: `mcp_servers FOR SHARE`, then `mcp_server_versions FOR NO KEY UPDATE`, in id order.                                                                                                                                                                                                                                                                                          | An in-place MCP edit cannot slip in between the hash and the freeze. With `FOR SHARE` on both tables, two saves that freeze one version deadlocked.                                  |
| Skills         | `SKILL.md` may sit at the zip root or inside one top-level folder, which is stripped. A document's `typeLabel` (for example "CSV · 48 rows · 8 columns") is computed from the blob and cached in memory, not stored.                                                                                                                                                                                             | Zipping a folder in Finder produces one top-level folder. The `documents` table has no column for the label.                                                                         |
| HTTP           | Every POST, PUT, PATCH and DELETE needs a non-empty `X-Requested-With` header and a JSON or multipart body (`RequestedWithGuard`), and an `Origin`, if sent, must be an allowed one. A Host allowlist runs before routing. The API listens on `127.0.0.1` unless `HOST` says otherwise.                                                                                                                          | The API has no auth. These stop other sites, and DNS rebinding, from driving it (plan 6.1, as updated).                                                                              |
| HTTP           | `DatabaseErrorFilter` turns integrity errors the services did not foresee into 4xx: 23505 and 23001 answer 409, 23503 and 23514 answer 400.                                                                                                                                                                                                                                                                      | A trigger refusal is never a 500.                                                                                                                                                    |
| Queue          | `POST /suites/reload` joins a live job only while it is still queued (`joinActive: false`). A job that is already active is waited out, and a new pass is sent. `load-suites` and `test-mcp-server` have 30 s heartbeats.                                                                                                                                                                                        | A reload must cover the files as they are now. A crashed worker frees the key within about a minute.                                                                                 |
| Worker         | The start-up suite load runs in the background, after the handlers register.                                                                                                                                                                                                                                                                                                                                     | A slow verifier does not hold up worker readiness.                                                                                                                                   |
| Workers        | `workers.slots` (migration `0003`) is the trial slot count, and the System page shows `slotsInUse` of `slotsTotal`. It is nullable, because rows written before it have no true value.                                                                                                                                                                                                                           | UI_FLOWS 5.2 shows "2 of 4".                                                                                                                                                         |
| Presence       | Env names leave out variables whose value is empty. `GET /system/workers` also lists workers lost within the last hour, as offline.                                                                                                                                                                                                                                                                              | An empty value counts as not set. The page can say when a worker was last seen.                                                                                                      |

### 2.3 UI_FLOWS open points this phase closes

| #   | Point                                                                  | Outcome                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | The sandbox self-test lived only in the worker's memory.               | Done. `workers.sandbox` (migration `0002`) holds the last report. `GET /system/sandbox` serves it, and `sandboxProven` is on each `Worker` in `GET /system/summary` and `GET /system/workers`.                                                                                                                                                                                   |
| 3   | The web data layer calls endpoints the plan's API table does not list. | Done for Phase 1: `GET /system/sandbox`, `GET /system/workers`, `GET /configurations/form-options`, `GET /configurations/:id/draft`, `GET /resources/counts`, `POST /resources/mcp-servers/test` and the fixture `preview` route are built, documented in Swagger and listed in plan section 11. `GET /experiments/new-options` and the artifact preview belong to later phases. |
| 8   | Load-time verifiers would run inside the API.                          | Done by D1: they run in the worker.                                                                                                                                                                                                                                                                                                                                              |
| 13  | Where the toolset list comes from.                                     | Done, differently from the suggestion: the form reads toolsets from `GET /configurations/form-options` (the newest live worker's list, else `HERMES_TOOLSETS`). `SystemSummary` stays as the web contract defines it, without toolsets.                                                                                                                                          |
| 14  | `header_names` cannot say which header a variable fills.               | Done: `headers` is a jsonb list of `{header, env}` pairs, with a CHECK on each element (migration `0002`).                                                                                                                                                                                                                                                                       |
| 15  | Egress could not list the names it holds.                              | Done: egress's admin socket answers `GET /env-names` (names with a non-empty value, never values). The worker records both name sets on its row, and the API joins them with MCP definitions.                                                                                                                                                                                    |

Point 16 (egress allowlist) is untouched: it belongs to the gateway work in Phase 2.

### 2.4 Review

A review produced 35 findings. 25 were confirmed and fixed, each with a regression test where a test can show it. Ten were rejected after checking them against the plan, the contracts and the code. Grouped:

| Rejected finding                                                                                                          | Why                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load-time verifiers should be capped at 30 s                                                                              | The 30 s in the plan is the default of `timeout_s`. A cap would mark valid tasks invalid at load.                                                                                                                     |
| Reload messages differ from the fixtures' wording                                                                         | Neither the plan nor the contracts fix the wording (`message: z.string()`). The frontend phase can settle it.                                                                                                         |
| Verifiers run with the worker's privileges                                                                                | True, and by design: plan 14 runs them in the worker, a container is optional, and plan 20 assumes a single trusted user. Verifier code comes only from the operator's own read-only `./suites`. Listed in section 7. |
| No anti-framing headers on `/api/docs`                                                                                    | Not required by the plan. A cheap hardening item for the frontend or packaging phase (section 7).                                                                                                                     |
| In-place edits have no base-version check                                                                                 | The plan and contracts define last-write-wins for unfrozen versions. Frozen versions are never touched.                                                                                                               |
| Postgres 17 e2e and real-container tests run in no CI job                                                                 | CI is in no phase yet. The tests pass when run, as section 6.1 shows.                                                                                                                                                 |
| Test gaps: the MCP job-id guard and hidden suite entries have no test, and the `sendAndWait` e2e uses fixed 300 ms sleeps | The behaviour is correct. Throwaway tests confirmed both code paths, and the join latency measured 19 ms at worst under double load, against the 300 ms sleep. Adding the tests is optional hardening.                |

---

## 3. Design

### 3.1 Module map

Two processes share one codebase (`apps/api`). The API answers HTTP and never runs user code. The worker runs everything that does: suite verifiers, and MCP servers inside throwaway trial containers. They talk only through Postgres: pg-boss jobs in the same database, and the `workers` row.

```mermaid
flowchart LR
  subgraph shared["packages/shared"]
    CT["contracts/*<br/>view models, request schemas"]
    SF["suite-files.ts<br/>SuiteYaml, TaskYaml, scorer params"]
    EN["env-names.ts<br/>reserved env names"]
    RT["runtime.ts<br/>HERMES_TOOLSETS"]
  end

  subgraph api["API process: src/main.ts, AppModule"]
    BND["Host allowlist, RequestedWithGuard,<br/>ZodValidationPipe, DatabaseErrorFilter"]
    SUM["SuitesModule<br/>read API and reload"]
    SKM["SkillsModule"]
    DOM["DocumentsModule"]
    MCM["McpModule"]
    SEM["SecretsModule, CountsModule"]
    CFM["ConfigurationsModule"]
    SYM["SystemModule"]
  end

  subgraph worker["worker process: src/worker.ts, WorkerModule"]
    WS["WorkerService<br/>start order"]
    SL["SuiteLoaderService<br/>load-suites handler"]
    SC["scoring/*<br/>registry, scorers, verifier runner"]
    MT["test-mcp-server handler"]
    WP["WorkerPresenceService<br/>heartbeat every 10 s"]
    SB["SandboxService<br/>self-test, guard client"]
  end

  PG[("Postgres 17<br/>tables and pg-boss queues")]
  BL[("evaldata volume<br/>blobs, skills, tmp")]
  FS[("./suites, read-only")]
  G["docker-guard"]
  EG["egress admin socket"]

  BND --> SUM & SKM & DOM & MCM & SEM & CFM & SYM
  SUM -- "send load-suites, wait" --> PG
  MCM -- "send test-mcp-server, wait" --> PG
  SUM & SKM & DOM -- "read and write files" --> BL
  SKM & DOM & MCM & SEM & CFM & SYM -- "rows" --> PG
  PG -- "jobs" --> SL & MT
  SL --> SC
  SL -- "lstat walk, read" --> FS
  SL -- "blobs" --> BL
  SL -- "versions" --> PG
  MT -- "throwaway container" --> G
  WS --> SB & WP & SL & MT
  SB -- "self-test" --> G
  WP -- "names only" --> EG
  WP -- "workers row" --> PG
  shared -. "types and schemas" .-> api & worker
```

Which code touches which tables:

| Code                                             | Process | Writes                                                                                    | Reads                                                                                                                   |
| ------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `suites/loader` (load-suites job, start-up load) | worker  | `blobs`, `suites`, `tasks`, `task_files`, `suite_sources`, blob files                     | `./suites`, the same tables                                                                                             |
| `suites` read API                                | api     | none                                                                                      | `suites`, `suite_sources`, `tasks`, `task_files`, blob files; `experiments`, `runs`, `evaluations`, `scores` for usage  |
| `SuiteReloadService`                             | api     | a pg-boss job                                                                             | `workers` (is a worker live?)                                                                                           |
| `resources/skills`                               | api     | `skills`, `DATA_DIR/skills/<hash>/`, `DATA_DIR/tmp/skill-uploads/`                        | `configurations`, `configuration_versions` (used by)                                                                    |
| `resources/documents`                            | api     | `blobs`, `documents`, blob files                                                          | `configuration_versions` (attached to)                                                                                  |
| `resources/mcp`                                  | api     | `mcp_servers`, `mcp_server_versions`, a pg-boss job                                       | `configuration_versions`, `workers`                                                                                     |
| `worker/handlers/test-mcp-server`                | worker  | `mcp_server_versions.last_test`                                                           | `mcp_servers`, `mcp_server_versions`, `workers`, trial dirs                                                             |
| `resources/secrets`, `resources/counts`          | api     | none                                                                                      | `mcp_server_versions`, `configuration_versions`, `workers`, `skills`, `documents`, `mcp_servers`                        |
| `configurations`                                 | api     | `configurations`, `configuration_versions` (a trigger then freezes the MCP versions used) | `skills`, `documents`, `mcp_server_versions`, `workers`, `experiments`, `runs`, `evaluations`, `scores`, the price file |
| `system`                                         | api     | none                                                                                      | `workers`, `experiments`, `runs`                                                                                        |
| `worker/presence`                                | worker  | `workers`                                                                                 | its own env, egress `GET /env-names`, the trial image through the guard                                                 |

How the worker starts (`WorkerService.onModuleInit`). Migrations run first, in `DatabaseModule`.

```mermaid
sequenceDiagram
  autonumber
  participant WK as WorkerService
  participant SB as SandboxService
  participant G as docker-guard
  participant WP as WorkerPresenceService
  participant E as egress admin socket
  participant DB as Postgres and pg-boss
  participant L as SuiteLoader

  WK->>DB: queue ping (the worker stays idle without a database)
  WK->>SB: verify(): the 15-check isolation self-test
  SB->>G: probe trial container
  G-->>SB: report: isolated, failed or unavailable
  WK->>WP: start()
  WP->>G: hermes tools list in a throwaway container, and an image inspect,<br/>when the self-test reached the guard
  WP->>E: GET /env-names
  WP->>DB: insert workers row: toolsets, env names, egress env names,<br/>slots, sandbox report
  WK->>DB: register load-suites and test-mcp-server handlers
  WK->>DB: register execute-run only if isolated, and evaluate-run
  WK->>L: start-up load of every suite, in the background
  WK->>DB: stale MCP test reconciler now and every 60 s
  loop every 10 s
    WP->>E: GET /env-names
    WP->>DB: last_heartbeat_at = now(), env names, egress env names
  end
```

### 3.2 Data model changes

Two migrations, both applied at boot by the migrator under its advisory lock. Columns marked `0002` or `0003` are new. Everything else existed in `0000`/`0001`.

```mermaid
erDiagram
  suite_sources |o--o| suites : "current_suite_id"
  suites ||--o{ tasks : "suite_id"
  suites ||--o{ tasks : "introduced_in_suite_id, 0002"
  tasks ||--o{ task_files : "task_id"
  blobs ||--o{ task_files : "sha256"
  blobs ||--o{ documents : "sha256"
  mcp_servers ||--|{ mcp_server_versions : "mcp_server_id"
  configurations ||--|{ configuration_versions : "configuration_id"
  configuration_versions |o--o{ configuration_versions : "duplicated_from_version_id, 0002"
  configuration_versions }o--o{ mcp_server_versions : "mcp_server_version_ids array"
  configuration_versions }o--o{ skills : "skill_ids array"
  configuration_versions }o--o{ documents : "document_ids array"

  suite_sources {
    text path PK "directory under SUITES_DIR"
    text name "unique while live"
    text current_suite_id FK
    text last_outcome "created unchanged reverted error missing"
    jsonb last_error
    jsonb last_changes
  }
  suites {
    text id PK
    text source_path
    integer version_number "0002, unique with source_path"
    text version_label
    text content_hash
    text check_hash
    integer task_count
    integer valid_count
  }
  tasks {
    text id PK
    text suite_id FK
    text key
    integer version_number "0002"
    text introduced_in_suite_id FK "0002"
    text task_yaml "0002, verbatim file"
    jsonb verification
    jsonb self_check
    jsonb load_issues
    boolean valid
    text content_hash
  }
  task_files {
    text task_id FK
    text path
    text kind "fixture verifier rubric expected"
    text sha256 FK
  }
  blobs {
    text sha256 PK
    bigint size
  }
  skills {
    text id PK
    text name
    text version
    text content_hash
  }
  documents {
    text id PK
    text filename
    text sha256 FK
  }
  mcp_servers {
    text id PK
    text name
    integer latest_version
  }
  mcp_server_versions {
    text id PK
    text transport "stdio or http"
    text command
    text_array env_names
    text url
    jsonb headers "0002, header and env pairs"
    text definition_hash
    jsonb last_test
    timestamptz frozen_at
  }
  configurations {
    text id PK
    text name
    integer latest_version
  }
  configuration_versions {
    text id PK
    integer version
    text_array toolsets
    text config_hash
    text duplicated_from_version_id FK "0002"
    timestamptz frozen_at
  }
  workers {
    text id PK
    timestamptz last_heartbeat_at
    text_array toolsets
    text_array env_names
    text_array egress_env_names "0002"
    jsonb sandbox "0002, last self-test"
    integer slots "0003"
  }
```

| Migration                  | Change                                                                    | Constraint                                                                                                                                                                                                                                      | Upgrade of existing rows                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0002_phase1_definitions`  | `suites.version_number`                                                   | NOT NULL, `>= 1`, unique with `source_path` (`suites_source_version_uq`)                                                                                                                                                                        | Numbered per directory by `loaded_at`, with `suites_immutable` switched off and back on inside the migration's transaction                                        |
|                            | `tasks.version_number`, `tasks.introduced_in_suite_id`, `tasks.task_yaml` | number `>= 1`; FK `tasks_introduced_in_suite_fk`                                                                                                                                                                                                | Each distinct content of a task key is numbered by first appearance, and introduced by that suite version. `tasks_immutable` is switched off and on the same way. |
|                            | `mcp_server_versions.headers` replaces `header_names`                     | `mcp_server_versions_headers_ck`: a JSON array whose elements have `header` matching `^[A-Za-z0-9-]{1,64}$` and `env` matching `^[A-Z_][A-Z0-9_]*$`. The shape check now says stdio has `headers = '[]'` and http has no args and no env names. | Refuses to run if any row has a non-empty `header_names`: names without their header cannot be converted. No release wrote MCP rows.                              |
|                            | `configuration_versions.duplicated_from_version_id`                       | FK `configuration_versions_duplicated_from_fk`                                                                                                                                                                                                  | Nullable, so frozen versions are untouched                                                                                                                        |
|                            | `workers.egress_env_names`, `workers.sandbox`                             | `workers_sandbox_ck`: null, or an object whose `state` is `isolated`, `failed` or `unavailable`                                                                                                                                                 | Defaults `'{}'` and null                                                                                                                                          |
| `0003_phase1_worker_slots` | `workers.slots`                                                           | null or 1 to 64                                                                                                                                                                                                                                 | Nullable: old rows have no true value                                                                                                                             |

The triggers from `0001` are unchanged, and the new code works with them. Suites, tasks, task files, blobs, skills and documents never change. A frozen MCP definition can only record test results. Saving a configuration version freezes the MCP definitions it uses. A frozen configuration version never changes. The upgrade was tested on PGlite (`upgrade.spec.ts`) and on Postgres 17 (`upgrade.e2e-spec.ts`), including that the immutability triggers are on again afterwards. The live Compose database was upgraded at boot.

### 3.3 The suite loader pipeline

`SuiteLoader` (`apps/api/src/suites/loader/suite-loader.ts`) loads every non-hidden directory under `SUITES_DIR`, one after another. Each directory is one transaction. A failure is that directory's `error` entry, never a failed pass. Loads in one process run one at a time, so the start-up load and a reload job queue up instead of reading in parallel.

```mermaid
flowchart TD
  START["load-suites job, or worker start"] --> GONE["mark live directories that vanished as missing<br/>(loadAll only), which releases their names"]
  GONE --> EACH["for each directory, sorted"]
  EACH --> LOCK["BEGIN, pg_advisory_xact_lock on hermes-evals:suite:dir"]
  LOCK --> SCAN["scan: lstat walk, never follows a link,<br/>skips dot names, at most 12 deep and 20,000 entries"]
  SCAN -- "link, special file, too many entries" --> ERR
  SCAN --> PARSE["parse suite.yaml and every task.yaml with positions<br/>files read with O_NOFOLLOW, 25 MiB cap"]
  PARSE -- "suite.yaml or a task.yaml does not parse,<br/>is not UTF-8, or is missing" --> ERR["outcome error: excerpt with line and column,<br/>pointer stays on the last good version"]
  PARSE --> VALIDATE["validate each task on the raw value:<br/>one primary, unique keys, known types,<br/>params against SCORER_PARAM_SCHEMAS, files present"]
  VALIDATE --> SELF["self-check, 4 tasks at a time, in scratch copies<br/>written from the hashed bytes"]
  SELF --> VERDICT["valid = no error issue and every runnable check passed"]
  VERDICT --> HASH["content hash over the files read<br/>check hash over LOADER_VERSION, SCORER_VERSIONS<br/>and each task's key, validity and self-check status"]
  HASH --> NAME{"name held by another live directory?"}
  NAME -- yes --> ERR
  NAME -- no --> BLOBS["write each blob: temp file, fsync, rename<br/>insert blobs rows in sha256 order"]
  BLOBS --> SEEN{"same content hash and check hash<br/>as a version of this directory?"}
  SEEN -- "yes, the current one" --> UN["unchanged"]
  SEEN -- "yes, an older one" --> RV["reverted: the pointer moves back"]
  SEEN -- no --> NEW["created: insert suites row v = highest + 1,<br/>tasks and task_files in chunks of 1,000"]
  UN & RV & NEW --> SRC["upsert suite_sources: outcome, changes, pointer. COMMIT"]
  ERR --> SRC2["upsert suite_sources: error and excerpt. COMMIT"]
  SRC & SRC2 --> OUT["SuiteReloadEntry: outcome, version, changes, message"]
```

Self-check modes, from the scorer registry (`scoring/registry.ts`, `scoring/self-check.ts`):

| Scorer type                                                             | Mode at load | What runs                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `numeric_tolerance`, `json_match`, `exact_match`                        | `answer`     | The scorer, with `reference.json` as if it were the answer. It must pass.                                                                                                        |
| `verifier_script`, no expected workspace                                | `script`     | `python3 verify/<script> --answer <reference> --workspace <fixtures copy>`. The printed score must reach `pass_at`.                                                              |
| `verifier_script` or `file_check`, with `self_check.expected_workspace` | `workspace`  | Once against the fixtures overlaid with the expected folder, where it must pass. Then, by default, once against the bare fixtures as a negative control, where it must not pass. |
| `file_check` without an expected workspace                              | none         | Not allowed: the load issue `self_check_unsupported` (an error) makes the task invalid                                                                                           |
| `trajectory_match`, `llm_judge`                                         | `none`       | Schema check only; the result is `skipped`                                                                                                                                       |

### 3.4 Version numbering

A suite version is identified by its directory, its content hash and its check hash. A reload either reuses an existing version or creates the next number. The numbers are never reused.

```mermaid
stateDiagram-v2
  state reload <<choice>>
  [*] --> reload : a directory is loaded
  reload --> created : new content, v = highest + 1
  reload --> rechecked : same files as an earlier version, new check hash, v = highest + 1
  reload --> unchanged : same content and check hash as the current version
  reload --> reverted : same hashes as an older version, the pointer moves back
  reload --> error : a file does not parse, the directory is unsafe, or the name is taken
  reload --> missing : the directory is gone
  created --> reload : next load
  rechecked --> reload : next load
  unchanged --> reload : next load
  reverted --> reload : next load
  error --> reload : next load
  missing --> reload : the directory is back
  note right of error : the pointer stays on the last good version
  note right of missing : the pointer stays, the name is released
```

- **created** is the stored outcome for a new version. Its message lists the changes against the previous current version, for example "1 task changed: total_due · all self-checks passed".
- **rechecked** is a `created` version whose files equal an earlier version's. A newer loader or scorer, or a different self-check result, changed the check hash. The message reads "Same files as v3, re-checked", and history marks it `sameFilesAs`.
- **reverted** reuses the older row. The history shows a `reverted` entry on top, and the version selector marks it.
- **error** keeps the pointer on the last good version. The name stays, unless suite.yaml now declares another name or another live directory took it.
- **missing** keeps the pointer and releases the name. `GET /suites` still lists the directory at its last version, with last load "Missing from disk".

Task versions are numbered per directory and task key. A task whose content hash appeared before in this directory gets that content's first number and the suite version where it first appeared (`introduced_in_suite_id`). New content gets the key's highest number plus one. Editing `total_due` makes it v2 while the other tasks keep their numbers, and reverting brings back v1.

### 3.5 Reload request

```mermaid
sequenceDiagram
  autonumber
  participant U as User or web
  participant A as API: SuiteReloadService
  participant DB as Postgres
  participant Q as pg-boss
  participant WK as worker: load-suites handler
  participant L as SuiteLoader
  participant FS as ./suites
  participant B as blob store

  U->>A: POST /api/suites/reload with path, or an empty body for all
  A->>A: guard, ZodValidationPipe, reloadDirectory: one directory name or 400
  A->>DB: findLiveWorker: heartbeat under 60 s on the database clock
  alt no live worker
    A-->>U: 503 No worker is connected
  end
  A->>Q: sendOrJoin load-suites, key is the directory or *<br/>joins a queued job, waits out an active one
  Q->>WK: job with path or null
  WK->>L: loadOne(path) or loadAll()
  loop each directory
    L->>DB: BEGIN, advisory lock on the directory
    L->>FS: lstat walk and read
    L->>L: parse, validate, self-check in scratch copies
    L->>B: write new blobs: temp file, fsync, rename
    L->>DB: blobs rows, new or reused suite version, suite_sources, COMMIT
  end
  WK-->>Q: complete, output is the SuiteReloadResult
  loop every 250 ms until SUITE_RELOAD_TIMEOUT_S
    A->>Q: findJobs by id
  end
  Q-->>A: completed with output
  A->>A: SuiteReloadResultSchema.parse
  A-->>U: 200 SuiteReloadResult, one entry per directory
  Note over A,Q: After the timeout the API answers 504 and the load goes on in the worker.<br/>A failed or cancelled job answers 500 with its message, never its stack.
```

### 3.6 MCP "Test start"

```mermaid
sequenceDiagram
  autonumber
  participant U as User or web
  participant A as API: McpTestsService
  participant DB as Postgres
  participant Q as pg-boss
  participant WK as worker: test-mcp-server handler
  participant G as docker-guard
  participant T as throwaway trial container

  U->>A: POST /api/resources/mcp-servers/:id/test
  A->>DB: latest version and its definition hash
  A->>DB: queue ping and findLiveWorker, else 503
  A->>Q: sendAndWait test-mcp-server, key versionId:definitionHash
  Q->>WK: job
  WK->>DB: last_test = running with the job id, only if the hash is unchanged
  WK->>WK: refusedEnvNames: reserved or cross-used names fail at once
  alt http transport
    WK->>DB: header variables missing from the egress names
    WK->>WK: failed: needs the egress MCP gateway, Phase 2
  else stdio with a name missing or empty in the worker environment
    WK->>WK: failed with missingSecretNames, no container
  else stdio on a worker without proven isolation
    WK->>WK: failed, no container
  else stdio
    WK->>WK: trial dir with config.yaml holding only this server,<br/>env entries written as references, never values
    WK->>G: create container: network none, 1024 MiB, 1 cpu, 512 pids,<br/>values in the container environment only
    G->>T: start: hermes mcp test name
    T-->>WK: stdout with the tool list, logs/mcp-stderr.log
    WK->>G: remove the container
    WK->>WK: remove the trial dir
    WK->>WK: parse the tools, replace values with from env NAME, cut the tail
  end
  WK->>DB: last_test = passed or failed, only if the hash is unchanged
  WK-->>Q: complete, output is the McpTestView
  Q-->>A: completed
  A-->>U: 200 McpTestView
  Note over A,WK: After MCP_TEST_TIMEOUT_S (120 s) the answer is this job's own record,<br/>or running, and the job goes on. POST /resources/mcp-servers/test does the same<br/>for an unsaved definition and stores nothing.
```

The container runs the same hardened trial spec as a run, through the guard: the pinned image, uid 10000, a read-only root and no capabilities. `config.yaml` is built by the same function a run will use (`hermesMcpEntry`). The test of the sample server lists four tools: `list_invoices`, `get_invoice`, `update_invoice` and `delete_invoice`. The last two never write; they report what they would do.

### 3.7 Configuration versioning

```mermaid
sequenceDiagram
  autonumber
  participant U as User or web
  participant A as API: configurations
  participant DB as Postgres

  U->>A: POST /api/configurations, a ConfigurationInput
  A->>DB: BEGIN, is the name free, resolve the referenced ids
  A->>DB: lock mcp_servers FOR SHARE, then mcp_server_versions FOR NO KEY UPDATE
  A->>A: toolsets against the live worker's list, settings rules,<br/>config_hash over settings and resource hashes, change note
  A->>DB: insert configurations and configuration_versions v1
  DB->>DB: refs trigger checks the ids and freezes the MCP versions used
  A->>DB: COMMIT
  A-->>U: 201, version 1, createdNewVersion true

  U->>A: PUT /api/configurations/:id while v1 is not frozen
  A->>DB: lock configurations row FOR UPDATE, then the latest version FOR UPDATE
  A->>DB: update v1 in place, recompute hash and change note
  A-->>U: 200, version 1, createdNewVersion false

  Note over DB: Phase 2 launch freezes it with UPDATE configuration_versions SET frozen_at = now().<br/>Phase 1 tests set the column directly.

  U->>A: PUT /api/configurations/:id after v1 froze
  A->>DB: the same two locks, so an edit and a launch freeze take turns
  A->>DB: insert v2, latest_version = 2
  A-->>U: 200, version 2, createdNewVersion true

  U->>A: POST /api/configurations/:id/duplicate
  A-->>U: 200 ConfigurationDraft, name-copy, duplicatedFromVersionId set, nothing stored
  U->>A: POST /api/configurations with the draft values
  A-->>U: 201, change note: Duplicated from name v1, then what differs
```

`config_hash` is sha256 over a canonical JSON of the settings: model, provider, base URL, sorted toolsets, memory, limits, each skill's name, version and content hash, each document's filename and sha256, and each MCP server's name and definition hash. It leaves out the configuration name and every id, so two configurations with the same settings have the same hash. `GET /configurations/diff?versions=a,b[,c]` returns one row per field in a fixed order, with a `differs` flag, and lists the differing fields.

### 3.8 Secrets presence

```mermaid
flowchart LR
  ENV[(".env on the host")]
  ENV -- "env_file" --> WENV["worker process environment<br/>stdio env values"]
  ENV -- "env_file" --> EENV["egress process environment<br/>http header values"]
  EENV -- "GET /env-names on the admin socket<br/>names with a non-empty value" --> WP["WorkerPresenceService"]
  WENV -- "presentEnvNames, names only" --> WP
  WP -- "at start and every 10 s" --> WR[("workers row<br/>env_names, egress_env_names")]
  MV[("mcp_server_versions<br/>each latest version, and every<br/>version a configuration pins")] --> SR["secretRows"]
  WR -- "findLiveWorker" --> SR
  SR --> OUT["GET /resources/secrets<br/>one SecretRow per name and source"]
```

| Reference              | Source   | Exposure                                                                                                | Set when                                      |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| stdio `envNames` entry | `worker` | `readable_by_agent`: the value goes into the trial container's environment, where the agent can read it | the live worker's `env_names` holds it        |
| http `headers[].env`   | `egress` | `egress_only`: egress adds the header on the way to the server, and the value never enters a run        | the live worker's `egress_env_names` holds it |

No value ever reaches the API, the database or a response. With no live worker every row is "not set", and `checkedWhen` reads "no worker is connected". A name used both ways would be two rows, but MCP saves refuse that cross-use (section 2.2).

### 3.9 Skill upload, two steps

```mermaid
sequenceDiagram
  autonumber
  participant U as User or web
  participant A as API: SkillsService
  participant TMP as DATA_DIR/tmp/skill-uploads/token
  participant FS as DATA_DIR/skills
  participant DB as Postgres

  U->>A: POST /api/resources/skills/validate, multipart file, 20 MB cap
  A->>TMP: unpack with yauzl into tree/
  Note over A,TMP: Refused: absolute paths, drive letters, dot-dot or empty segments, backslashes,<br/>links and special files, encryption, more than 2,000 entries, over 100 MB unpacked,<br/>entries that expand over 200 times, names that collide by case
  A->>A: SKILL.md at the root or in one top-level folder,<br/>front matter name, version and description
  A->>A: content hash over the sorted path and sha256 list
  A->>DB: rows with this name: the same version, the same hash?
  A->>TMP: manifest.json, only when the upload can be confirmed
  A-->>U: 200 SkillUploadValidation: valid, new_version, conflict or invalid,<br/>with a token when it can be confirmed
  U->>A: POST /api/resources/skills with the token
  A->>TMP: lookup: 404 unknown, 410 expired after SKILL_UPLOAD_TTL_S
  A->>A: fsync the tree
  A->>DB: BEGIN, insert the skills row
  A->>FS: rename tree/ to skills/content_hash/, or reuse an existing tree
  A->>DB: COMMIT, or 409 when the name and version were stored meanwhile
  A-->>U: 201 SkillRow
```

Nothing is stored before the confirm. A tree under `DATA_DIR/skills/<content_hash>/` is never changed while a row names it, which is what a trial's `home/skills/<name>/` will be copied from in Phase 2. Documents take one step: `POST /resources/documents` writes the blob (temp file, fsync, rename) and inserts the `blobs` and `documents` rows in one transaction.

---

## 4. Endpoints

Everything is under `/api`. Swagger serves every route at `http://localhost:3000/api/docs`, and the JSON at `/api/docs-json`. Its JSON Schemas come from the shared zod contracts through `z.toJSONSchema`, so nothing is restated by hand. Request and response names below are the schemas exported by `@hermes-evals/shared`. Every response is parsed with its schema in the tests, and the configuration routes also parse each response before they send it.

Rules for every route:

- **Errors** have the body `{ statusCode, message, issues? }`. A body or query that fails its zod schema answers 400 `Validation failed`, with `issues: [{ path, message }]`.
- **State-changing requests** (POST, PUT, PATCH, DELETE) need a non-empty `X-Requested-With` header, a `Content-Type` of `application/json` or `multipart/form-data`, and, when the browser sends an `Origin`, an allowed one. Otherwise the answer is 403. A POST with no body still sends `-d '{}'` with the JSON content type.
- **Host**: a request whose `Host` is not loopback, `api`, the host of `CORS_ORIGIN` or one listed in `ALLOWED_HOSTS` answers 403 `host not allowed`, before routing.
- **Integrity errors** the services did not foresee are mapped by `DatabaseErrorFilter`: 23505 and 23001 answer 409, 23503 and 23514 answer 400. Messages never include values.

### 4.1 Suites

| Method and path                                     | Purpose                                                                                                                                         | Request                                                                                                                                             | Response                                                                                                                            | Errors                                                                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /suites`                                       | One row per suite directory at its current version, including a directory whose last load was `missing`                                         | none                                                                                                                                                | `SuiteListRow[]`                                                                                                                    | none                                                                                                                                                                                  |
| `POST /suites/reload`                               | Load suites from disk in the worker and wait for the result                                                                                     | `SuiteReloadRequest` `{ path? }`; an empty body means every directory. `path` may be `invoices-v1`, `suites/invoices-v1` or `./suites/invoices-v1`. | 200 `SuiteReloadResult` `{ at, suites: SuiteReloadEntry[] }`                                                                        | 400 not one directory name; 503 no live worker or no queue; 504 after `SUITE_RELOAD_TIMEOUT_S` (the load goes on); 500 for a failed or cancelled job, or an output of the wrong shape |
| `GET /suites/:id`                                   | One suite version, any version, with its tasks and the version selector                                                                         | none                                                                                                                                                | `SuiteDetail`                                                                                                                       | 404                                                                                                                                                                                   |
| `GET /suites/:id/history`                           | Every version of the directory, newest first, with changes and the experiments that used each                                                   | none                                                                                                                                                | `SuiteHistoryEntry[]`                                                                                                               | 404                                                                                                                                                                                   |
| `GET /suites/:id/tasks/:key`                        | Task detail: prompt, fixtures with previews, verification with sentences and YAML, hidden reference, verifier source, self-check, limits, usage | none                                                                                                                                                | `TaskDetail`                                                                                                                        | 404                                                                                                                                                                                   |
| `GET /suites/:id/tasks/:key/history`                | The task key's versions and where each first appeared                                                                                           | none                                                                                                                                                | `TaskVersionEntry[]`                                                                                                                | 404                                                                                                                                                                                   |
| `GET /suites/:id/tasks/:key/diff?against=:suiteId`  | Prompt and task.yaml text diffs, a reference JSON diff, and file changes from `against` to `:id`                                                | query `against`                                                                                                                                     | `TaskDiff`                                                                                                                          | 400 when `against` is missing or names another directory's version; 404                                                                                                               |
| `GET /suites/:id/tasks/:key/fixtures/:path`         | Download a fixture from the blob store. `:path` is the workspace path, URL-encoded as one segment (`docs%2Freadme.md`).                         | none                                                                                                                                                | the file: `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`; html and svg are sent as `application/octet-stream` | 404; 500 when the blob file is missing                                                                                                                                                |
| `GET /suites/:id/tasks/:key/fixtures/:path/preview` | The first 10 rows of a CSV or TSV fixture, and its row count                                                                                    | none                                                                                                                                                | `TablePreview`, or the JSON literal `null` for any other file                                                                       | 404                                                                                                                                                                                   |

### 4.2 Skills and documents

| Method and path                         | Purpose                                                                                               | Request                                | Response                                                           | Errors                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `GET /resources/skills`                 | Every stored skill version, with the configurations whose latest version uses it                      | none                                   | `SkillRow[]`                                                       | none                                                                               |
| `POST /resources/skills/validate`       | Step 1: check a zip and store nothing                                                                 | multipart, field `file`, at most 20 MB | 200 `SkillUploadValidation` (`token` set when it can be confirmed) | 400 no file, or a wrong field; 413 over 20 MB                                      |
| `POST /resources/skills`                | Step 2: store a validated upload                                                                      | `SkillConfirmRequest` `{ token }`      | 201 `SkillRow`                                                     | 404 unknown token; 410 expired; 409 the same name and version was stored meanwhile |
| `GET /resources/skills/:id`             | The skill, its `SKILL.md` split into front matter and body, and its files                             | none                                   | `SkillDetail`                                                      | 404                                                                                |
| `GET /resources/skills/:id/files/:path` | One file. `:path` is one URL-encoded segment. Text up to 1 MB is inline; otherwise `content` is null. | none                                   | `SkillFileContent`                                                 | 404 when the path is not in the skill                                              |
| `GET /resources/skills/:id/zip`         | The stored skill as a zip                                                                             | none                                   | `application/zip`, named `<name>-<version>.zip`                    | 404; 500 when the tree is missing                                                  |
| `GET /resources/documents`              | Every stored document, with the configurations it is attached to                                      | none                                   | `DocumentRow[]`                                                    | none                                                                               |
| `POST /resources/documents`             | Store a document                                                                                      | multipart, field `file`, at most 50 MB | 201 `DocumentRow`                                                  | 400 no file; 413 over 50 MB                                                        |
| `GET /resources/documents/:id/content`  | The document bytes. Inline for PDF, images and plain, Markdown or CSV text; otherwise an attachment.  | none                                   | the file, with `nosniff`                                           | 404; 500 when the blob is missing                                                  |

### 4.3 MCP servers, secrets and counts

| Method and path                        | Purpose                                                                                                                                                      | Request          | Response                                                                        | Errors                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /resources/mcp-servers`           | Every server at its latest version, with usage, tool filters and its last test                                                                               | none             | `McpServerRow[]`                                                                | none                                                                                     |
| `POST /resources/mcp-servers`          | Create a server and its version 1, untested                                                                                                                  | `McpServerInput` | 201 `McpServerRow`                                                              | 400 validation, including reserved env names and cross-used names; 409 the name is taken |
| `PUT /resources/mcp-servers/:id`       | Save an edit: in place while unfrozen, else as version n+1. Unknown keys are stripped, so a whole row can be sent back.                                      | `McpServerInput` | 200 `McpServerRow`                                                              | 400 with an issue on `name` for a rename after a freeze; 404; 409 the name is taken      |
| `POST /resources/mcp-servers/:id/test` | Test the latest version in the worker and record the result on it                                                                                            | none (send `{}`) | 200 `McpTestView` (`passed`, `failed`, or `running` after `MCP_TEST_TIMEOUT_S`) | 404; 503 no live worker or no queue                                                      |
| `POST /resources/mcp-servers/test`     | Test an unsaved definition; stores nothing                                                                                                                   | `McpServerInput` | 200 `McpTestView`                                                               | 400; 503                                                                                 |
| `GET /resources/secrets`               | Every referenced secret name, with whether it is set, its source, its exposure and what references it. `?refresh=` is accepted for the page's "Check again". | none             | `SecretRow[]`                                                                   | none                                                                                     |
| `GET /resources/counts`                | The counts behind the Resources tabs                                                                                                                         | none             | `ResourceCounts` `{ skills, documents, mcpServers, secrets }`                   | none                                                                                     |

### 4.4 Configurations

| Method and path                             | Purpose                                                                                                                                                                                             | Request                                                     | Response                                                                                   | Errors                                                                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /configurations`                       | Every configuration at its latest version, in creation order                                                                                                                                        | none                                                        | `ConfigurationListRow[]`                                                                   | none                                                                                                                                                                                                        |
| `POST /configurations`                      | Create a configuration and its version 1                                                                                                                                                            | `ConfigurationInput`                                        | 201 `ConfigurationSaveResult` `{ configurationId, versionId, version, createdNewVersion }` | 400 with `issues` on the field: an unknown id, two versions of one MCP server, two versions of one skill name, two documents with one filename, a toolset the runtime does not offer; 409 the name is taken |
| `PUT /configurations/:id`                   | Save an edit: a new version when the latest is frozen, else in place; no write when nothing changed                                                                                                 | `ConfigurationInput` (`duplicatedFromVersionId` is ignored) | 200 `ConfigurationSaveResult`                                                              | the same 400s; 404; 409                                                                                                                                                                                     |
| `GET /configurations/:id`                   | Detail at the latest version: versions, usage, where it was duplicated from                                                                                                                         | none                                                        | `ConfigurationDetail`                                                                      | 404                                                                                                                                                                                                         |
| `GET /configurations/:id/versions/:version` | Detail shown at one version                                                                                                                                                                         | `:version` a positive integer                               | `ConfigurationDetail`                                                                      | 400; 404                                                                                                                                                                                                    |
| `GET /configurations/diff?versions=a,b[,c]` | One row per field across 2 or 3 versions, with `differs`                                                                                                                                            | query `versions`                                            | `ConfigDiff` `{ columns, rows, differing }`                                                | 400 for fewer than 2, more than 3, or repeated ids; 404                                                                                                                                                     |
| `GET /configurations/form-options`          | What the form offers: priced models plus models in use, the six providers, toolsets from the live worker (`file` and `terminal` on by default), skills, documents, MCP versions (latest and pinned) | none                                                        | `ConfigurationFormOptions`                                                                 | none                                                                                                                                                                                                        |
| `GET /configurations/:id/draft`             | The edit form for the latest version, saying whether saving creates a new version                                                                                                                   | none                                                        | `ConfigurationDraft` (`mode: 'edit'`)                                                      | 404                                                                                                                                                                                                         |
| `POST /configurations/:id/duplicate`        | A prefilled draft copying the latest version, named `<name>-copy`; nothing is stored                                                                                                                | none (send `{}`)                                            | 200 `ConfigurationDraft` (`mode: 'duplicate'`)                                             | 404                                                                                                                                                                                                         |

### 4.5 System

| Method and path       | Purpose                                                                                                  | Request | Response         | Errors                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ------- | ---------------- | --------------------------------------------------------------------------------------- |
| `GET /system/summary` | Running experiments and their scored and total runs, the workers, and the queued runs                    | none    | `SystemSummary`  | none                                                                                    |
| `GET /system/workers` | Live workers, plus those lost within the last hour (offline). With none, the most recently seen worker.  | none    | `Worker[]`       | none                                                                                    |
| `GET /system/sandbox` | The newest live worker's isolation report: 15 checks, revision, image digest and the command to rerun it | none    | `SandboxStatus`  | 404 when no worker is live or it has no report; 500 when the stored report is malformed |
| `GET /health`         | Existed before; now documented with `HealthResponse`                                                     | none    | `HealthResponse` | none                                                                                    |

A worker is live when `stopped_at` is null and its heartbeat is under `WORKER_TIMEOUT_MS` (60 s) old, by the database clock.

---

## 5. What changed

The working tree is compared with commit `08c6c7c`. That tree also holds the earlier frontend-foundation work (web views, components and the web data layer with its fixtures). This section lists only what Phase 1 added or changed.

### 5.1 Files, by area

**`packages/shared`**

| Added                                                                                       | Purpose                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/contracts/{common,suites,resources,configurations,system,index}.ts`                    | Every Phase 1 view model and request schema, moved from the web types (D3), plus `ApiErrorBody`                               |
| `src/suite-files.ts`                                                                        | `SuiteYamlSchema`, `TaskYamlSchema` (strict at every level), one strict params schema per scorer type, `SCORER_PARAM_SCHEMAS` |
| `src/env-names.ts`                                                                          | The names MCP definitions may not reference: `WORKER_RESERVED_ENV_NAMES`, `WORKER_RESERVED_ENV_PREFIXES`, `isReservedEnvName` |
| `src/runtime.ts`                                                                            | `HERMES_VERSION`, `HERMES_REVISION`, `HERMES_TOOLSETS` (17 names), `DEFAULT_TOOLSETS`                                         |
| `test/{contracts,env-names,suite-files}.spec.ts`, `tsconfig.build.json`, `vitest.config.ts` | Tests moved out of `src`, so the build no longer emits them                                                                   |

Modified: `src/records.ts` (`McpHeaderSchema`, `ENV_NAME_PATTERN`, `type SelfCheckResult`, new load-issue codes `reference_invalid`, `unsafe_file` and `self_check_unsupported`, the `changed` key list in suite changes), `src/index.ts`, `package.json` (build from `tsconfig.build.json`; lint covers `test/`), `tsconfig.json`.

**`apps/api`, new modules**

| Directory                                                                                                          | What it holds                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/suites/loader/`                                                                                               | The loader: `walk.ts` (lstat walk), `yaml-source.ts` (parse with positions and excerpts), `suite-yaml.ts`, `task-yaml.ts`, `task.ts` (every 4.2 rule), `task-files.ts`, `task-self-check.ts`, `read-suite.ts`, `hashing.ts`, `persist.ts` (lock, blobs, versions, numbering), `changes.ts`, `messages.ts`, `limits.ts`, `suite-loader.ts`, `suite-loader.service.ts`, `load-suites.handler.ts` |
| `src/suites/`                                                                                                      | `suites.controller.ts`, `suites.service.ts`, `suite-tasks.service.ts`, `suite-reload.service.ts`, `suites.queries.ts`, `suite-failures.ts`, `http-errors.ts`, and pure view builders in `views/` (sentences, YAML slices, diffs, CSV preview, self-check views, usage, download headers)                                                                                                       |
| `src/scoring/`                                                                                                     | `registry.ts`, `result.ts`, `extraction.ts`, `answer-path.ts`, `answer.ts`, `numeric-tolerance.ts`, `exact-match.ts`, `json-match.ts`, `file-check.ts`, `verifier.ts`, `self-check.ts`                                                                                                                                                                                                         |
| `src/resources/skills/`                                                                                            | Upload (two steps), zip reader, front matter, file listing, zip download, multipart interceptor, HTTP helpers                                                                                                                                                                                                                                                                                  |
| `src/resources/documents/`                                                                                         | Upload, list, content, and the type label (PDF page count, CSV shape, line count)                                                                                                                                                                                                                                                                                                              |
| `src/resources/mcp/`                                                                                               | Create and edit with versioning, the definition hash, the Hermes config entry, reads, test views, and the API side of Test start                                                                                                                                                                                                                                                               |
| `src/resources/secrets/`, `src/resources/counts/`                                                                  | Secret presence and resource counts                                                                                                                                                                                                                                                                                                                                                            |
| `src/configurations/`                                                                                              | Reads, writes, form options, references and their locks, settings (hash, diff, change notes), usage, toolsets, the price file reader                                                                                                                                                                                                                                                           |
| `src/system/`                                                                                                      | Summary, workers and sandbox views                                                                                                                                                                                                                                                                                                                                                             |
| `src/worker/handlers/`                                                                                             | `test-mcp-server.ts`, `mcp-test-container.ts`, `mcp-test-output.ts`, `redact.ts`, `stale-mcp-tests.ts`                                                                                                                                                                                                                                                                                         |
| `src/worker/presence/`                                                                                             | `worker-presence.service.ts`, `presence-report.ts`, `trial-image.ts`                                                                                                                                                                                                                                                                                                                           |
| `src/storage/`                                                                                                     | `BlobStore` (temp file, fsync, rename, directory fsync), `StorageService`, `StorageModule`                                                                                                                                                                                                                                                                                                     |
| `src/queue/`                                                                                                       | `send-and-wait.ts` (`sendAndWait`, `sendOrJoin`, `waitForJob`), `live-worker.ts` (`findLiveWorker`)                                                                                                                                                                                                                                                                                            |
| `src/openapi/`                                                                                                     | Swagger from the shared schemas, and decorators                                                                                                                                                                                                                                                                                                                                                |
| `src/common/`                                                                                                      | `requested-with.guard.ts`, `host-allowlist.ts`, `database-error.filter.ts`, `pg-error.ts`                                                                                                                                                                                                                                                                                                      |
| `src/database/`                                                                                                    | `db.provider.ts` (the `DB` token; answers 503 without `DATABASE_URL`), `types.ts` (`AppDb`, `AppTx`), `schema/worker-sandbox.ts`                                                                                                                                                                                                                                                               |
| `src/sandbox/toolsets.ts`                                                                                          | `listToolsets`: `hermes tools list` in a throwaway container                                                                                                                                                                                                                                                                                                                                   |
| `src/app.setup.ts`                                                                                                 | `configureApi`: Host allowlist, the `/api` prefix, CORS and the docs                                                                                                                                                                                                                                                                                                                           |
| `drizzle/0002_phase1_definitions.sql`, `drizzle/0003_phase1_worker_slots.sql` and their snapshots                  | The migrations (section 3.2)                                                                                                                                                                                                                                                                                                                                                                   |
| `test/phase1.e2e-spec.ts`, `test/fixtures/suites/{complete,mixed,no-suite-yaml}`, `test/support/require-python.ts` | The full-application e2e, loader fixtures, and a global setup that stops the run when python3 is missing                                                                                                                                                                                                                                                                                       |

**`apps/api`, modified**: `app.module.ts` (the nine modules, the guard and the filter), `main.ts` (`configureApi`, listens on `HOST`), `worker/worker.module.ts` and `worker/worker.service.ts` (start order, section 3.1), `config/env.ts`, `database/database.module.ts` (exports `DB`), `database/schema/{suites,resources,configurations,workers,_columns}.ts`, `queue/queues.ts` (the `load-suites` queue, heartbeats, keys), `common/zod-validation.pipe.ts` (400 bodies carry `statusCode`), `health/health.controller.ts` (documented schema), `sandbox/task-run.ts` (uses the shared extractor and scorers), `sandbox/trial-runner.ts` (an output cap, stop reason `output_limit`), `sandbox/streams.ts` (`ByteTail`, `utf8Tail`), `sandbox/egress-client.ts` (`envNames()`), `test/support/{database,seed}.ts`, both vitest configs, `README.md`.

New test files across api, shared and egress: 77 unit and integration specs, 9 Postgres 17 e2e specs, and 5 test helpers that vitest does not collect.

**`apps/egress`**: `src/env-names.ts` (new), and the admin socket's new route `GET /env-names` in `src/admin.ts`, with tests.

**`apps/web`**, contracts only, no styling or components:

- `src/api/types/{suites,resources,configurations}.ts` are now type re-exports from `@hermes-evals/shared`. `types/system.ts` re-exports the moved schemas.
- `src/fixtures/resources.ts` gains the http server `vendor-api` and its egress secret, and `headers: []` on `invoice-db`. `src/fixtures/configurations.ts` re-exports `CONFIG_FIELDS`.
- `src/api/resources.ts` looks a saved server up by id when testing it.
- `src/api/__tests__/contracts.spec.ts` calls every suites, resources, configurations and system function in every fixture scenario and parses each answer with the shared schema.

**`docker/`**: `mcp/invoice-db/{server.py,invoices.csv,invoice-db-mcp}` (new), `trial.Dockerfile`, `nginx.conf`.

**Repository root**: `scripts/phase1-smoke.sh` (new), `docker-compose.yml`, `turbo.json`, `.env.example`, `.gitignore` (`/suites/zz-smoke-*/`), `README.md`, `IMPLEMENTATION_PLAN.md` (the MCP secrets model in 1, 2, 5.3, 5.4, 8.2, 13, 14 and 15; DNS rebinding in 6.1; Tailwind in 12.1; the new columns in 3.1, the loader in the worker in 4.4, the endpoints in 11, the scope moves in 17) and `UI_FLOWS.md` (the reload, MCP test, worker start and configuration form flows, and open points 2, 3, 8, 13, 14 and 15 marked resolved).

### 5.2 Migrations

`0002_phase1_definitions` and `0003_phase1_worker_slots` (section 3.2). Both run at boot in the API and the worker. The live Compose database was upgraded by them, and all four migrations show as applied.

### 5.3 New environment variables

| Variable                 | Default                                                      | Read by | Meaning                                                                                                          |
| ------------------------ | ------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `HOST`                   | `127.0.0.1`                                                  | api     | Interface the API listens on. Compose sets `0.0.0.0` inside the container; the published port stays on loopback. |
| `ALLOWED_HOSTS`          | unset                                                        | api     | More host names the API answers, comma-separated                                                                 |
| `SUITE_RELOAD_TIMEOUT_S` | 180 (1 to 900)                                               | api     | How long `POST /suites/reload` waits for the worker                                                              |
| `MCP_TEST_TIMEOUT_S`     | 120 (1 to 300)                                               | api     | How long a Test start waits                                                                                      |
| `PRICES_FILE`            | `./config/prices.yaml`                                       | api     | Model price table. The file may not exist; then no model has a price.                                            |
| `SKILL_UPLOAD_TTL_S`     | 1800 (60 to 86400)                                           | api     | How long a validated skill upload waits for its confirm                                                          |
| `INVOICE_DB_URL`         | in `.env.example`: `file:///opt/mcp/invoice-db/invoices.csv` | worker  | The sample stdio MCP server's data file. Not a platform setting: it is an MCP secret, by name.                   |

`SUITES_DIR` is now read by the worker only. Every new setting is listed in `WORKER_SETTING_ENV_NAMES`, and a test fails when an `EnvSchema` key is missing there.

### 5.4 Compose and nginx

- **api**: no longer mounts `./suites` or sets `SUITES_DIR`. It sets `HOST: 0.0.0.0`.
- **worker**: mounts `./suites` read-only at `/data/suites`, and gains `env_file: .env` (optional), so stdio MCP values reach it. It records only their names.
- **nginx**: a `default_server` that drops any other host name (444); `server_name localhost 127.0.0.1`; `proxy_pass http://api:3000` with no URI part, so `%2F` in a path parameter reaches the API intact; `client_max_body_size 64m` for the 20 MB and 50 MB uploads.

### 5.5 Trial image

`docker/trial.Dockerfile` copies the sample stdio server into the image, root-owned and read-only to the trial user. That is `/opt/mcp/invoice-db/server.py` and `invoices.csv` (0644), plus the launcher `/usr/local/bin/invoice-db-mcp` (0755). The pinned base digest, `USER 10000:10000`, `WORKDIR` and `ENTRYPOINT` are unchanged. The tag stays `hermes-evals/trial:v0.22.4-4d04303`. The server runs on the MCP Python SDK already in Hermes's venv. Its tools are `list_invoices`, `get_invoice`, `update_invoice` and `delete_invoice`; the last two never write.

### 5.6 Dependencies

Added to `apps/api`: `ajv` (JSON Schema in `file_check`), `csv-parse`, `diff` (task diffs), `yauzl` and `yazl` (skill zips). Dev: `@types/multer`, `@types/yauzl`, `@types/yazl`. `multer` comes through `@nestjs/platform-express`. Nothing else was added or upgraded.

---

## 6. How to test it

### 6.1 Automated

Run these from the repository root after `pnpm install`. The other packages consume `packages/shared` through its built `dist`, so build it first, or use the turbo commands, which build it for you. The api tests need python3, because verifier self-checks run it. The run stops at once without it.

| Suite                            | Command                                                                                                        | What it covers                                                                                                                          | Observed on 24 Oct 2026                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Everything                       | `pnpm turbo run typecheck lint test build --force`                                                             | Typecheck, oxlint, unit and PGlite tests, and build, for all five packages                                                              | 20 of 20 tasks, 0 cached, 2 min 10 s   |
| shared                           | `pnpm --filter @hermes-evals/shared test`                                                                      | The contract schemas, the suite-file and scorer-param schemas (with a parsed copy of `total_due/task.yaml`), and the reserved env names | 3 files, 28 passed                     |
| api: unit and PGlite integration | `pnpm --filter @hermes-evals/api test`                                                                         | See below                                                                                                                               | 81 files, 727 passed, 5 skipped, 119 s |
| api: Postgres 17 e2e             | `TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e` | See below                                                                                                                               | 10 files, 44 passed, 14 s              |
| web                              | `pnpm --filter @hermes-evals/web test`                                                                         | Includes `contracts.spec.ts`: every web data function, in every fixture scenario, parsed with its shared schema                         | 17 files, 306 passed                   |
| egress                           | `pnpm --filter @hermes-evals/egress test`                                                                      | Includes `GET /env-names` (names only, empty values left out)                                                                           | 4 files, 71 passed                     |
| docker-guard                     | `pnpm --filter @hermes-evals/docker-guard test`                                                                | Unchanged in this phase                                                                                                                 | 2 files, 63 passed                     |
| Real containers (gated)          | see below                                                                                                      | `hermes tools list` in the trial image, the image inspect, and the `invoice-db` test passing and failing                                | 3 files, 22 passed, 23 s               |

The 5 skipped api tests are the 4 gated real-container tests, and one test that runs only on Linux (a read through a linked parent directory, in `trial-files.spec.ts`).

**What the api unit and PGlite suite covers.** PGlite runs the real migrations and triggers in-process (`test/support/database.ts`).

- Scoring: answer extraction edge cases (no block, several blocks, invalid JSON, an unclosed block); answer paths; each answer scorer; `file_check` refusals (links, special files, oversize) and checks; the verifier's timeout, exit codes, process-group kill and result line; self-check modes and the negative control.
- Loader: hashing, YAML errors with line, column and excerpt, every task rule on in-memory folders, messages, change sets, the expected-workspace overlay. On real fixture suites copied into a fresh `SUITES_DIR`: every scorer type loads valid; an unchanged reload reuses v1; one edited task gives v2 with only that task bumped; a revert points back at v1; a new `LOADER_VERSION` gives a re-checked version; missing directories; one name in two directories; invalid tasks, links and special files; a `task.yaml` parse error keeps the last good version; the real `invoices-v1` loads valid.
- Suites API: every display string against the web fixtures; two seeded versions of a directory read through the services; the controller through supertest with a stand-in pg-boss.
- Skills and documents: zip safety (traversal, links, encryption, size and ratio caps, case collisions), front matter, both upload steps, token expiry, type labels, and the routes through supertest.
- MCP: the definition hash, edit planning (in place, new version, rename refused), the Hermes config entry, the tool-list parser, redaction, the handler with a fake sandbox, and the controller with a stand-in pg-boss that runs the real handler.
- Configurations: settings rules, the hash, diff, change notes, the price file, usage maths, and every save rule on PGlite, through supertest.
- System and presence, the HTTP boundary (guard, Host allowlist, error filter), the OpenAPI document, and migration `0002` upgrading a database that already holds rows.

**What the Postgres 17 e2e covers.** Each spec creates and drops its own database. Never point `TEST_DATABASE_URL` at the Compose database on `:5432`.

- `test/phase1.e2e-spec.ts`: the real `AppModule` and `WorkerModule` boot in-process on a fresh database with pg-boss and a temporary copy of the `complete` fixture suite. It walks the whole Phase 1 flow and parses every response with its shared schema: worker registration; Host and Origin rules; the 403 guard; reload, list, detail and task; edit, v2, history and diff; revert; skill validate, confirm, file and zip; document upload and download; MCP create, in-place edit and test in the worker; secrets presence; configuration create, edit, freeze, v2, duplicate, diff and form options; an MCP v2 after a freeze; the system routes; and the docs.
- Concurrency that PGlite cannot show: one directory loaded twice at once ends in one version; two directories that share new files load at once without deadlocking; two directories racing for one name end with one owner; two reloads while the job is queued share it, and a reload never joins one already running; `sendAndWait` joins, times out and reports failures; two edits of a frozen configuration or MCP version are serialised (one makes v2, the other then edits v2); create races on one name answer 409; an edit waits on a launch freeze and then saves v2; two saves that freeze one MCP version queue instead of deadlocking; two racing skill confirms leave one winner.
- node-postgres result types, and the `0002` upgrade through the production migrator.

Start the throwaway Postgres 17 once (the README has the same line):

```bash
docker run -d --name hermes-evals-pg-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:55433:5432 postgres:17-alpine
```

**Gated real-container tests.** These need the trial image (`docker compose up --build` builds it), a docker-guard socket and a directory that backs a trial volume. From a development machine, run a host docker-guard against a throwaway volume bound to a directory under `$HOME`, which Colima shares with its VM. This is what was run for this document:

```bash
D=$HOME/.cache/hermes-evals-sandbox-test
mkdir -p "$D/trials"
docker volume create --driver local --opt type=none --opt o=bind --opt device="$D/trials" hermes-evals-sandbox-test-trials

# terminal 1: a host docker-guard (Docker Desktop: DOCKER_SOCK=/var/run/docker.sock)
LISTEN="$D/guard.sock" TRIAL_IMAGE=hermes-evals/trial:v0.22.4-4d04303 \
  TRIAL_VOLUME=hermes-evals-sandbox-test-trials \
  TRIAL_NETWORKS=hermes-evals-trial-0,hermes-evals-trial-1,hermes-evals-trial-2,hermes-evals-trial-3 \
  DOCKER_SOCK="$HOME/.colima/default/docker.sock" node apps/docker-guard/dist/main.js

# terminal 2
cd apps/api
RUN_SANDBOX_TESTS=1 DOCKER_SOCKET="$D/guard.sock" TRIALS_DIR="$D/trials" \
  TRIAL_IMAGE=hermes-evals/trial:v0.22.4-4d04303 TRIAL_VOLUME=hermes-evals-sandbox-test-trials \
  pnpm exec vitest run --no-file-parallelism \
  src/sandbox/toolsets.spec.ts src/worker/presence/trial-image.spec.ts src/worker/handlers/mcp-test-container.spec.ts

# afterwards: stop the guard (Ctrl-C), then
docker volume rm hermes-evals-sandbox-test-trials && rm -rf "$D"
```

The files share `TRIALS_DIR`, and each checks that it leaves the directory as it found it, so run them with `--no-file-parallelism`. Afterwards no `hermes-evals-probe-*` container and no trial directory were left.

### 6.2 On the running stack

```bash
cp .env.example .env          # first time only; it sets INVOICE_DB_URL for the sample MCP server
docker compose up --build -d
docker compose ps             # api healthy; worker, egress, docker-guard, web, postgres up
curl -s http://localhost:3000/api/health
docker compose logs worker | grep -E 'worker registered|worker ready|suites loaded at start'
```

The worker log should show, in order: `isolation check passed` 15 times, `worker registered` (with `sandbox: isolated`, `toolsets: 17`, and counts of env names), `worker ready`, then `suites loaded at start` with `invoices-v1`.

Then run the smoke script. It needs only bash, curl and python3.

```bash
scripts/phase1-smoke.sh                                       # http://localhost:3000/api
BASE_URL=http://localhost:8080/api scripts/phase1-smoke.sh    # through nginx
EXPECT_INVOICE_DB_URL=set scripts/phase1-smoke.sh             # insist that the invoice-db test passes
```

It prints one PASS, FAIL or SKIP line per step (54 steps), and exits 0 only when nothing failed. It writes to the stack it checks: everything it creates is named `smoke-<UTC timestamp>-…`. Phase 1 has no delete endpoints, so these stay.

| Section                  | What the steps show                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health and request guard | `GET /health` reports the database, migrations and queue ok. A POST without `X-Requested-With` answers 403.                                                                                                                                                                                                                                                                                                                                                                               |
| Suites (`invoices-v1`)   | The list, a reload of every directory ("Unchanged since v1"), suite detail, task detail with self-check passed, the fixture preview (8 columns, 10 of 48 rows), the fixture download (its sha256 matches the task view), suite and task history                                                                                                                                                                                                                                           |
| Suite versioning         | A temporary copy `suites/zz-smoke-<stamp>` loads as created v1. Editing `total_due/prompt.md` gives created v2, "1 task changed: total_due · all self-checks passed". The task diff shows the added prompt lines, with task.yaml, the reference and the files unchanged. Task history shows v2 since suite v2. Reverting gives "Reverted to v1", and the selector marks v1 as current and reverted. Deleting the directory gives `missing`, and the list keeps it as "Missing from disk". |
| Skills                   | Validate a zip it builds (one top-level folder), confirm (201), detail, one file, the zip download, then validate again: `conflict`, "Already uploaded."                                                                                                                                                                                                                                                                                                                                  |
| Documents                | Upload a text file ("Text · 2 lines"), download it with `nosniff` and a matching sha256, list                                                                                                                                                                                                                                                                                                                                                                                             |
| MCP servers and secrets  | Create stdio `invoice-db` and http `vendor-api`. The secrets show `INVOICE_DB_URL` as `worker`, `readable_by_agent`, and `VENDOR_API_TOKEN` as `egress`, `egress_only`, with no value anywhere in the body. Test start of `invoice-db`, saved and unsaved: passed with 4 tools, or failed naming `INVOICE_DB_URL`. Test start of `vendor-api`: failed until Phase 2. The list records both last tests.                                                                                    |
| Configurations           | Form options: 17 toolsets, `file` and `terminal` on by default, equal to the live worker's row. Create a baseline; detail; duplicate draft (`<name>-copy`); create `with-mcp` from the draft with the MCP server, skill and document; the diff names `skills, documents, mcp_servers`; the MCP version is now frozen and used by `with-mcp`; the skill shows the same usage; an edit of the unused baseline saves in place                                                                |
| System                   | Summary, workers (online, concurrency 3, slots 0 of 4, sandbox proven) and the sandbox (15 of 15 checks, `hermes-agent v0.22.4 @ 4d04303`), and resource counts                                                                                                                                                                                                                                                                                                                           |

**Making the MCP test pass.** The sample stdio server reads its invoices from `INVOICE_DB_URL`, which must be in the worker's environment:

```bash
grep -q '^INVOICE_DB_URL=' .env || echo 'INVOICE_DB_URL=file:///opt/mcp/invoice-db/invoices.csv' >> .env
docker compose up -d worker
EXPECT_INVOICE_DB_URL=set scripts/phase1-smoke.sh
```

The path is inside the trial image, so the value means nothing on the host. Without the variable, the test fails at once with "INVOICE_DB_URL is not set in the worker environment." and starts no container. That is the expected result, and the smoke script accepts it unless `EXPECT_INVOICE_DB_URL=set`.

The isolation proof can be rerun by hand: `docker compose run --rm --no-deps worker node dist/sandbox-cli.js selftest` (15 of 15) and `... lifecycle` (6 of 6).

### 6.3 By hand

**Swagger.** Open `http://localhost:3000/api/docs`. Every Phase 1 route is listed with its request and response schemas. "Try it out" works on state-changing routes too: the page adds `X-Requested-With`, and an empty JSON body for bodiless POSTs.

The walkthroughs below use curl and python3. Every POST and PUT sends the two headers the guard needs. The JSON shown is an excerpt of the real response: `…` marks values and fields left out, and ids differ on every stack.

```bash
API=http://localhost:3000/api
J=(-H 'X-Requested-With: curl' -H 'Content-Type: application/json')    # bash or zsh array
pick() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
```

#### A. Reload and versions

```bash
curl -s "$API/suites" | python3 -m json.tool
```

```json
[
  {
    "suiteId": "01M5Q3MXBZX7BFE45RSJZ402P1",
    "name": "invoices-v1",
    "versionNumber": 1,
    "versionLabel": "0.1",
    "path": "./suites/invoices-v1",
    "taskCount": 1,
    "validCount": 1,
    "verificationTypes": ["numeric_tolerance"],
    "lastLoad": {
      "outcome": "unchanged",
      "changes": { "added": [], "removed": [], "changed": [], "nowInvalid": [], "nowValid": [] },
      "error": null
    }
  }
]
```

```bash
V1=$(curl -s -X POST "$API/suites/reload" "${J[@]}" -d '{"path":"invoices-v1"}' | pick 'd["suites"][0]["suiteId"]')
printf '\nState the total in euros.\n' >> suites/invoices-v1/total_due/prompt.md
curl -s -X POST "$API/suites/reload" "${J[@]}" -d '{"path":"invoices-v1"}' | python3 -m json.tool
```

```json
{
  "at": "…",
  "suites": [
    {
      "sourcePath": "./suites/invoices-v1",
      "name": "invoices-v1",
      "outcome": "created",
      "suiteId": "<v2 id>",
      "versionNumber": 2,
      "changes": {
        "added": [],
        "removed": [],
        "changed": ["total_due"],
        "nowInvalid": [],
        "nowValid": []
      },
      "message": "1 task changed: total_due · all self-checks passed",
      "error": null
    }
  ]
}
```

```bash
V2=$(curl -s "$API/suites" | pick '[s["suiteId"] for s in d if s["name"] == "invoices-v1"][0]')
curl -s "$API/suites/$V2/tasks/total_due/diff?against=$V1" | python3 -m json.tool
```

```json
{
  "key": "total_due",
  "from": { "suiteId": "<v1 id>", "suiteVersion": 1, "taskVersion": 1 },
  "to": { "suiteId": "<v2 id>", "suiteVersion": 2, "taskVersion": 2 },
  "prompt": [
    "… unchanged lines with kind 'same' …",
    { "kind": "added", "text": "", "oldLine": null, "newLine": 12 },
    { "kind": "added", "text": "State the total in euros.", "oldLine": null, "newLine": 13 }
  ],
  "reference": [],
  "files": [
    {
      "path": "fixtures/invoices.csv",
      "change": "unchanged",
      "before": { "sizeBytes": 3666, "sha256": "605f03df…" },
      "after": { "sizeBytes": 3666, "sha256": "605f03df…" }
    }
  ]
}
```

`GET $API/suites/$V2/tasks/total_due/history` now lists task v2 (`introducedInSuiteVersion: 2`, `changedFiles: ["prompt.md"]`) above v1. Now revert the edit and reload:

```bash
git checkout -- suites/invoices-v1/total_due/prompt.md
curl -s -X POST "$API/suites/reload" "${J[@]}" -d '{"path":"invoices-v1"}' | pick 'd["suites"][0]["outcome"], d["suites"][0]["versionNumber"], d["suites"][0]["message"]'
# reverted 1 Reverted to v1
curl -s "$API/suites/$V1" | pick '[(v["versionNumber"], v["current"], v["reverted"]) for v in d["versions"]]'
# [(1, True, True), (2, False, False)]
```

`GET $API/suites/$V1/history` shows `reverted` v1 (current) on top, then `created` v2, then `created` v1. Version 2 stays in the database for good, because suite versions are immutable. That is intended: an experiment run on it would keep it.

To see an error, break `suite.yaml` (for example, change the `name:` line to `name: [`) and reload. The entry has `outcome: "error"`, a message of the form `Could not reload: suite.yaml:<line>:<column> · <message>`, and `error.excerpt` with the lines around it and a caret under the column. `GET /suites` still serves the last good version. Undo the edit with `git checkout -- suites/invoices-v1/suite.yaml` and reload.

#### B. Skill upload

```bash
mkdir -p invoice-method/examples
cat > invoice-method/SKILL.md <<'MD'
---
name: invoice-method
version: 1.0.0
description: Reconcile invoices before totalling them.
---

# Invoice method

1. Drop duplicate invoice numbers.
2. Sum the amounts of invoices whose status is not `paid`.
MD
printf "def total_due(rows):\n    return sum(r['amount'] for r in rows if r['status'] != 'paid')\n" > invoice-method/examples/reconcile.py
zip -qr invoice-method.zip invoice-method

curl -s -X POST "$API/resources/skills/validate" -H 'X-Requested-With: curl' \
  -F 'file=@invoice-method.zip;type=application/zip' | python3 -m json.tool
```

```json
{
  "fileName": "invoice-method.zip",
  "outcome": "valid",
  "name": "invoice-method",
  "version": "1.0.0",
  "description": "Reconcile invoices before totalling them.",
  "contentHash": "d46ccae0…",
  "existing": null,
  "token": "1ea1fd85…",
  "checks": [
    { "label": "SKILL.md", "value": "found in invoice-method/", "ok": true },
    { "label": "files", "value": "2 files · 300 B unpacked", "ok": true }
  ],
  "problems": [],
  "fileTree": [
    { "path": "SKILL.md", "sizeBytes": 212 },
    { "path": "examples/reconcile.py", "sizeBytes": 88 }
  ]
}
```

Nothing is stored yet. Confirm with the token, within `SKILL_UPLOAD_TTL_S` (30 min):

```bash
curl -s -X POST "$API/resources/skills" "${J[@]}" -d '{"token":"<token>"}' | python3 -m json.tool
# 201: { "id": "…", "name": "invoice-method", "version": "1.0.0", "contentHash": "d46ccae0…", "fileCount": 2, "unpackedBytes": 300, "usedBy": [], … }
SKILL=$(curl -s "$API/resources/skills" | pick '[s["id"] for s in d if s["name"] == "invoice-method"][0]')
curl -s "$API/resources/skills/$SKILL/files/examples%2Freconcile.py" | pick 'd["kind"], d["content"]'
curl -s -o invoice-method-copy.zip "$API/resources/skills/$SKILL/zip"
```

Validating the same zip again gives `outcome: "conflict"`, `token: null` and the problem "Already uploaded.". Bumping `version` in `SKILL.md` gives `new_version`. A second confirm of a used token answers 404, and an expired one answers 410.

#### C. MCP server: define and test

```bash
curl -s -X POST "$API/resources/mcp-servers" "${J[@]}" -d '{
  "name": "invoice-db", "transport": "stdio", "command": "invoice-db-mcp", "args": [],
  "envNames": ["INVOICE_DB_URL"], "url": null, "headers": [], "include": [], "exclude": [], "timeoutS": 30
}' | python3 -m json.tool
# 201: { "name": "invoice-db", "version": 1, "frozen": false, "usedBy": [], "lastTest": { "status": "untested" }, "id": "…", "versionId": "…", … }
MCP=$(curl -s "$API/resources/mcp-servers" | pick '[r["id"] for r in d if r["name"] == "invoice-db"][0]')
curl -s -X POST "$API/resources/mcp-servers/$MCP/test" "${J[@]}" -d '{}' | python3 -m json.tool
```

With `INVOICE_DB_URL` in the worker's environment (section 6.2), the test takes a few seconds:

```json
{
  "status": "passed",
  "requestedAt": "…",
  "finishedAt": "…",
  "startedMs": 1303,
  "tools": [
    {
      "name": "list_invoices",
      "description": "List invoices, optionally only those with a status (ope...",
      "included": true
    },
    {
      "name": "get_invoice",
      "description": "Get one invoice by its number, e.g. INV-1002.",
      "included": true
    },
    {
      "name": "update_invoice",
      "description": "Change one field of an invoice. Sample server: reports ...",
      "included": true
    },
    {
      "name": "delete_invoice",
      "description": "Delete an invoice. Sample server: reports the deletion ...",
      "included": true
    }
  ]
}
```

Without it, the test fails at once: `{ "status": "failed", "error": "INVOICE_DB_URL is not set in the worker environment.", "missingSecretNames": ["INVOICE_DB_URL"], "exitCode": null, … }`. Set `"exclude": ["delete_*"]` with a PUT, and test again: `delete_invoice` then shows `"included": false`.

An http server, and the secrets page:

```bash
curl -s -X POST "$API/resources/mcp-servers" "${J[@]}" -d '{
  "name": "vendor-api", "transport": "http", "command": null, "args": [], "envNames": [],
  "url": "https://vendor-api.example.com/mcp", "headers": [{"header": "Authorization", "env": "VENDOR_API_TOKEN"}],
  "include": [], "exclude": [], "timeoutS": 30
}' > /dev/null
curl -s "$API/resources/secrets" | pick '[(r["name"], r["source"], r["exposure"], r["set"]) for r in d]'
# [('INVOICE_DB_URL', 'worker', 'readable_by_agent', True), ('VENDOR_API_TOKEN', 'egress', 'egress_only', False)]
# (True once INVOICE_DB_URL is in the worker's environment)
```

Testing `vendor-api` answers `failed` with "Testing http servers needs the egress MCP gateway, which is built in Phase 2." and `missingSecretNames: ["VENDOR_API_TOKEN"]`, because egress does not have that variable. A definition that names a platform variable is refused before anything runs:

```bash
curl -s -X POST "$API/resources/mcp-servers/test" "${J[@]}" -d '{"name":"leaky","transport":"stdio","command":"invoice-db-mcp","args":[],"envNames":["DATABASE_URL"],"url":null,"headers":[],"include":[],"exclude":[],"timeoutS":30}'
# {"statusCode":400,"message":"Validation failed","issues":[{"path":"envNames","message":"DATABASE_URL is a platform variable or credential; it never enters a trial"}]}
```

#### D. Configurations: create, duplicate, diff

```bash
curl -s -X POST "$API/configurations" "${J[@]}" -d '{
  "name": "baseline", "model": "openai/gpt-6.1-sol", "provider": "nous", "baseUrl": null,
  "toolsets": ["file", "terminal"], "memoryEnabled": false, "skillIds": [], "documentIds": [],
  "mcpServerVersionIds": [], "maxTurns": 20, "timeBudgetS": 300, "duplicatedFromVersionId": null
}' | python3 -m json.tool
# 201: { "configurationId": "…", "versionId": "…", "version": 1, "createdNewVersion": true }
BASE=$(curl -s "$API/configurations" | pick '[c["id"] for c in d if c["name"] == "baseline"][0]')
curl -s -X POST "$API/configurations/$BASE/duplicate" "${J[@]}" -d '{}' > draft.json
pick 'd["mode"], d["values"]["name"], d["values"]["duplicatedFromVersionId"]' < draft.json
# duplicate baseline-copy <baseline v1 id>
```

Nothing is stored by the duplicate. Save the draft as `with-skill`, adding the skill from walkthrough B and the MCP version from C:

```bash
MCPV=$(curl -s "$API/resources/mcp-servers" | pick '[r["versionId"] for r in d if r["name"] == "invoice-db"][0]')
BODY=$(SKILL=$SKILL MCPV=$MCPV python3 -c "import json,os; d=json.load(open('draft.json'))['values']; d.update(name='with-skill', skillIds=[os.environ['SKILL']], mcpServerVersionIds=[os.environ['MCPV']]); print(json.dumps(d))")
curl -s -X POST "$API/configurations" "${J[@]}" -d "$BODY" | python3 -m json.tool
WITH=$(curl -s "$API/configurations" | pick '[c["id"] for c in d if c["name"] == "with-skill"][0]')
curl -s "$API/configurations/$WITH" | pick 'd["latest"]["change"]'
# Duplicated from baseline v1; added skill invoice-method@1.0.0; added MCP server invoice-db
A=$(curl -s "$API/configurations/$BASE" | pick 'd["latest"]["versionId"]')
B=$(curl -s "$API/configurations/$WITH" | pick 'd["latest"]["versionId"]')
curl -s "$API/configurations/diff?versions=$A,$B" | pick 'd["differing"], [(r["field"], r["values"]) for r in d["rows"] if r["differs"]]'
# ['skills', 'mcp_servers'] [('skills', ['—', 'invoice-method@1.0.0']), ('mcp_servers', ['—', 'invoice-db (stdio)'])]
```

The save also froze the MCP version it uses: `GET /resources/mcp-servers` shows `invoice-db` with `"frozen": true` and `usedBy: [with-skill]`. A PUT to `invoice-db` with any change now creates version 2, untested, while `with-skill` keeps version 1.

Editing `baseline` (`GET /configurations/$BASE/draft`, change `maxTurns`, PUT the values) saves in place: `version 1, createdNewVersion false`. A configuration version is frozen only by an experiment launch, which is Phase 2. To see the "edit after freeze" path on a development stack, freeze it by hand the way a launch will, then edit again:

```bash
docker compose exec -T postgres psql -U hermes -d hermes_evals -c "update configuration_versions set frozen_at = now() where id = '$A'"
curl -s "$API/configurations/$BASE/draft" | pick 'd["createsNewVersion"], d["nextVersion"]'      # True 2
DRAFT=$(curl -s "$API/configurations/$BASE/draft" | python3 -c "import json,sys; d=json.load(sys.stdin)['values']; d['maxTurns']=30; print(json.dumps(d))")
curl -s -X PUT "$API/configurations/$BASE" "${J[@]}" -d "$DRAFT"
# {"configurationId":"…","versionId":"…","version":2,"createdNewVersion":true}
```

`GET /configurations/$BASE` then lists versions 2 and 1, and `GET /configurations/$BASE/versions/1` still shows the frozen settings.

---

## 7. Known limitations and what Phase 2 picks up

### 7.1 What later phases pick up

| Item                                                                                          | Phase    | Where Phase 1 left it                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The egress MCP gateway (`egress:8080/mcp/<name>`), so an http Test start can pass             | 2        | The http branch of the test handler fails with `HTTP_TEST_UNAVAILABLE`. `egressMcpUrl(name)` in `resources/mcp/hermes-config.ts` is a placeholder until the route exists.                                                                                                                                                        |
| Claim, admission, leases, heartbeat fencing, recovery, and the `execute-run` handler          | 2        | `execute-run` registers only on an isolated worker, and its handler only logs. `workers.in_flight` is never written yet, so `slotsInUse` is always 0.                                                                                                                                                                            |
| Trial materialisation                                                                         | 2        | Call `refusedEnvNames(db, definition)` (in `worker/handlers/test-mcp-server.ts`) before putting any MCP env into a trial. Copy skills from `DATA_DIR/skills/<content_hash>/` and documents from their blobs. `hermesMcpEntry` already builds the `config.yaml` entry a run needs.                                                |
| Experiment launch, which freezes configuration versions                                       | 2        | Follow the locking contract in `configurations/`: freeze with `UPDATE configuration_versions SET frozen_at = now() …` in the launch transaction, and lock no `configurations` row after that, or the launch can deadlock with `PUT /configurations/:id`. Today a configuration version freezes only when a test sets the column. |
| `nous-login`, the providers module, SSE                                                       | 2        | Not started                                                                                                                                                                                                                                                                                                                      |
| `trajectory_match` and `llm_judge` runtimes, a common scorer context, the evaluation pipeline | 3        | Both types are schema-checked at load and `skipped` in self-checks                                                                                                                                                                                                                                                               |
| Tailwind CSS and the pages for everything in this document                                    | Frontend | D8. The web data layer already speaks these contracts (`contracts.spec.ts`).                                                                                                                                                                                                                                                     |

### 7.2 Known limitations

- **No delete endpoints.** Skills, documents, MCP servers and configurations can only be added. Each smoke run leaves its `smoke-…` records and one suite row marked "Missing from disk". Skill trees and blobs are content-addressed and never collected.
- **No price table ships.** There is no `config/prices.yaml`, so `GET /configurations/form-options` lists only models that configurations already use, all with `price: null`.
- **`GET /suites` keeps deleted directories**, at their last version, with last load `missing` (UI_FLOWS 8.1). A missing directory releases its name, so if a new directory then takes the name, two rows show the same name. The frontend phase should label this.
- **Verifiers run with the worker's privileges.** They run as the worker's uid with a minimal environment, but a script could still read `/proc/1/environ`, reach the backend network, and outlive the process-group kill through `setsid`. This follows plan 14 and the single trusted user assumption of plan 20: verifier code comes only from the operator's read-only `./suites`. The comment in `scoring/verifier.ts` overstates the containment. Running verifiers in a `network: none` container through the guard stays an optional later hardening.
- **stdio MCP values are readable by the agent**, by design (plan 5.3). Redaction of test output replaces whole values, their JSON-escaped forms and values cut short by "...". It does not catch a value the server prints in another form, such as only the path inside a `file://` URL. The reserved-name rules keep platform credentials out of the container instead of relying on redaction.
- **Test start timing.** The API waits `MCP_TEST_TIMEOUT_S` (120 s) and the container's own limit is 110 s. A slow container create can make the API answer `running` just before the result is recorded. The next list shows it.
- **Local development without Compose.** `ConfigModule` copies only `EnvSchema` keys from `.env` into `process.env`. Under `pnpm dev:worker`, an MCP value such as `INVOICE_DB_URL` must be exported in the shell. Compose's `env_file` is not affected.
- **The api service still has `env_file: .env`**, so it receives provider keys and MCP values it never uses. Plan 15 says only egress and the worker read them. Splitting `.env` is left to packaging.
- **Another host name** for the Compose web app needs it in both `ALLOWED_HOSTS` and `server_name` in `docker/nginx.conf`.
- **No anti-framing headers** (`X-Frame-Options`, CSP `frame-ancestors`) on the API docs or the web app. This is a cheap item for before the provider routes and the UI ship.
- **Concurrent in-place edits are last-write-wins** for an unfrozen configuration or MCP version, as the plan defines. Frozen versions are never touched.
- **No CI yet.** The Postgres 17 e2e and the gated real-container tests run by hand (section 6.1).
- **Small wording questions for the frontend phase.** Reload messages, `checkedWhen` ("at worker start" or "on heartbeat"; the contract's comment also names "on request"), and `SecretReference`, which has no version: a name used only by a pinned older version shows the server without its version.
- **`version_label`**: YAML reads an unquoted `0.10` as the number `0.1`, so quote labels in `suite.yaml`, as `invoices-v1` does.

### 7.3 Open questions for the reviewer

1. Should `GET /suites` hide directories whose last load was `missing`, or keep listing them as it does now?
2. Should a default `config/prices.yaml` ship before the frontend phase, and with which `checked_at` date?
3. Raise `MCP_TEST_TIMEOUT_S` to 150 s, or lower the container's 110 s limit?
4. When a toolset disappears from a future trial image, saving an old configuration that uses it answers 400 until it is unticked. Keep that, or accept toolsets already stored on the version being edited?
5. Should `suite.yaml`'s `name` have to equal its directory name? The loader does not require it today.
