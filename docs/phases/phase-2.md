# Phase 2: execution, model access and live views

Status: built and checked on 25 Oct 2026, waiting for review. Nothing is committed yet.

This document is for the review before Phase 2 is approved. It covers what Phase 2 changed, why, how it is designed, every endpoint it adds, and how to test it. Section numbers such as "plan 8.4" point at `IMPLEMENTATION_PLAN.md`. "UI_FLOWS 19 #9" means open point 9 in section 19 of `UI_FLOWS.md`. "E7" is one of the decisions taken for this phase (section 2.1).

Contents:

1. [What Phase 2 delivers](#1-what-phase-2-delivers)
2. [Decisions](#2-decisions)
3. [Design](#3-design)
4. [Endpoints](#4-endpoints)
5. [What changed](#5-what-changed)
6. [How to test it](#6-how-to-test-it)
7. [Known limitations and what later phases pick up](#7-known-limitations-and-what-later-phases-pick-up)

---

## 1. What Phase 2 delivers

Phase 2 runs experiments. `POST /experiments` checks that a proven worker, one Hermes revision and every provider are ready, then freezes the configuration versions and inserts the experiment, its runs and one `execute-run` job per run in one transaction. The worker claims each run under the experiment's concurrency, spend and provider guards. It builds a fresh trial directory, registers the attempt with egress and starts one hardened container through docker-guard. It streams Hermes's stream-json into `run_events`, classifies how the attempt ended, collects the workspace, and finishes the attempt in one transaction. An executed run is then scored by `evaluate-run` with the scorers Phase 1 built, and the experiment completes when nothing is left in flight.

Around that loop:

- **Controls and guards**: pause, resume, cancel, retry a run (alone or in bulk), retry failed runs and duplicate. The spend guard, the provider guard and the circuit breaker act on their own.
- **Ownership**: leases with a 10 s heartbeat, a cancel watcher, and recovery every 15 s that confirms a lost trial's container is gone before its run is requeued.
- **Model access**: the `nous-login` service, `nous-proxy` started by default, `GET /providers` and the four Nous login routes, and the development host login.
- **The egress MCP gateway**, so an http MCP server works in a run and in "Test start".
- **Live updates** over SSE, and the read APIs behind the experiment list, the Overview, the Runs tab and the run inspector.

Nothing in the web app changed except its contracts. Statistics, verdicts and the comparison view are Phase 4, and the `trajectory_match` and `llm_judge` runtimes and re-score are Phase 3.

Exit criteria (plan 17, as refined for this phase):

| Criterion                                                                                                                                                                    | Status | Evidence                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An experiment of 3 tasks × 2 configurations × 2 repetitions, launched through the API, runs in real trial containers, every run reaches scored, and the experiment completes | Met    | On the Compose stack, with real Hermes v0.22.4 in real trial containers and the scripted mock model. For this document: `scripts/phase2-smoke.sh` passed 56 of 56 steps, and its 3 × 2 × 2 experiment completed in 35 s with 12 of 12 scored (section 6.2); the walkthrough in section 6.3 ran another in 32 s. The live check before it passed the smoke script twice. |
| A full-application e2e on Postgres 17 with a fake container engine is green                                                                                                  | Met    | `apps/api/test/phase2.e2e-spec.ts`: 20 of 20 passed, run for this document on real Postgres 17 and pg-boss with the real `AppModule` and `WorkerModule` (section 6.1).                                                                                                                                                                                                  |
| Unit, PGlite and the other e2e tests are green                                                                                                                               | Met    | Run for this document: api 129 files, 1,182 passed, 15 skipped. Postgres 17 e2e: 16 files, 92 passed, run twice. shared, web, egress and docker-guard are all green.                                                                                                                                                                                                    |
| Typecheck, lint and build green                                                                                                                                              | Met    | `pnpm turbo run typecheck lint test build --force`: 20 of 20 tasks, none cached.                                                                                                                                                                                                                                                                                        |
| Real-container tests (gated) green                                                                                                                                           | Met    | `RUN_SANDBOX_TESTS=1` through a host docker-guard: 4 files, 38 passed, including nous-login in the real trial image against a fake portal.                                                                                                                                                                                                                              |

---

## 2. Decisions

### 2.1 Decisions taken for this phase

These were fixed before the build and not revisited.

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Why                                                                                                                    | Settles                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| E1  | **Scope.** Phase 2 carries a run all the way to `scored` with the Phase 1 scorers: claim, trial, events, artifacts, executed, evaluation, `evaluate-run` (claim, score over stored evidence, publish), reconcile, completed, and the `evaluate-run` dead-letter handler. `trajectory_match` and `llm_judge` keys publish status `error` with the comment "`<type>` is scored from Phase 3". No re-score routes. Reconcile completes an experiment and moves `verdict_revision`, but appends no verdict entries: `verdicts` is `[]` until Phase 4. Estimates and `GET /experiments/new-options` are in, because launch needs them.               | The exit criterion needs runs to reach `scored`, and a run must never stop at `executed` for want of a scorer.         | Plan 17 (moves claim, publish and the dead letter from Phase 3, and estimates from Phase 4) |
| E2  | **Providers.** Each platform provider maps to a Hermes `--provider` id and an egress upstream (`apps/api/src/execution/providers-map.ts`). The trial always gets `--base-url http://egress:8080/v1 --api-key <attempt token>`. `custom` is Hermes `custom`, forwarded by egress to the configuration's own base URL, with `CUSTOM_API_KEY` from egress's environment when set. Every test and check uses `custom` against `http://mock-model:8090/v1`, or an in-process fake.                                                                                                                                                                   | The trial never holds a provider credential (invariant 7). The mapping was checked in the Hermes source (section 2.2). | Plan 6 (the six providers), plan 8.2 (launch contract)                                      |
| E3  | **Model access.** A new `nous-login` service (the trial image plus `docker/nous-login.py`) shares the `nous-home` volume with `nous-proxy`, which now starts by default. A new internal network, `provider-admin`, connects the api and the worker to it. nous-login checks the Hermes functions it calls at startup and reports `unavailable` when they changed. In host mode, egress's admin `/health` reports the host forward and whether it answers, the worker records it on its `workers` row (`host_proxy`), and `GET /providers` reports `host` or `host_unreachable`. The real login (spike I14) needs a person and is not automated. | Nous Portal has only an OAuth device login with rotating tokens; the UI must connect it without a terminal.            | Plan 6.1; UI_FLOWS 19 #7 and #12                                                            |
| E4  | **The egress MCP gateway.** `http://egress:8080/mcp/<name>` forwards to the definition's exact URL, follows no redirects, streams both ways, adds each `{header, env}` header from egress's own environment, and logs every call in the attempt's connection log. The trial authenticates with its attempt token, which never sits in a file in the home. MCP "Test start" for http servers now goes through it.                                                                                                                                                                                                                                | http header values must never enter a run (plan 5.3).                                                                  | Plan 5.3; spike I15                                                                         |
| E5  | **Egress allowlist.** In allowlist mode CONNECT refuses every host and `allowHosts` stays empty. Public mode is used only when the configuration enables the `web` or `browser` toolset.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | http MCP goes through the gateway and stdio servers have no network, so nothing needs a CONNECT allowlist.             | UI_FLOWS 19 #16; plan 14                                                                    |
| E6  | **Live updates.** SSE for `GET /system/events` (the summary every 5 s) and `GET /experiments/:id/events` (one poller per experiment, reading Postgres every 1 s). The inspector polls `GET /runs/:id/events?after=` and the experiment list polls `GET /experiments`.                                                                                                                                                                                                                                                                                                                                                                           | One transport per need; polling where a page holds few rows.                                                           | UI_FLOWS 19 #9; plan 11                                                                     |
| E7  | **Launch rules.** Launch is allowed with the estimate over the spend ceiling: the spend guard pauses at the ceiling. `POST /experiments` answers 409 with a readable reason when no live worker has proven isolation, a provider is not ready, the live workers' Hermes revisions disagree, or a configuration's hash changed or a newer version exists.                                                                                                                                                                                                                                                                                        | The user learns why at once, before anything is frozen.                                                                | UI_FLOWS 19 #10 and #11; plan 7.1                                                           |
| E8  | **Migration `0004`.** `PAUSE_REASONS` gains `provider_disconnected`. `PLATFORM_EVENT_SUBTYPES` gains `network`, with a defined payload: kind `connect`, `http`, `model` or `mcp`, plus host, port, decision, reason, status, ms and background. `workers` gains `host_proxy`.                                                                                                                                                                                                                                                                                                                                                                   | The provider guard, the connection log and the host login each need a place to be recorded.                            | UI_FLOWS 19 #5, #6 and #7                                                                   |
| E9  | **One worker per Docker daemon.** Slot networks are allocated in-process from `TRIAL_SLOTS`. Before a create, the worker confirms that no live trial container is on the slot. Several workers on one daemon need disjoint `TRIAL_SLOTS`, which the README and Compose file say.                                                                                                                                                                                                                                                                                                                                                                | Two trials must never share a slot network.                                                                            | Plan 8.1, plan 15                                                                           |
| E10 | **Two levels of test.** The CI-runnable full e2e uses an in-process fake `EngineClient` that emits canned stream-json, with real Postgres 17, real pg-boss and the real worker handlers. Real containers (real Hermes, real egress, the mock model) are proven in the live stage on the Compose stack.                                                                                                                                                                                                                                                                                                                                          | CI must never need a model or a Docker daemon.                                                                         | Plan 16 ("worker e2e"), plan 17 exit                                                        |
| E11 | **Money and accounts.** Never call a real model provider, never read or touch the user's Hermes login or the `nous-home` volume, never start a real device login. Real-model runs happen only after this phase, with the user's approval.                                                                                                                                                                                                                                                                                                                                                                                                       | The repository is public and the user pays for model calls.                                                            | Plan 19 (the official experiment)                                                           |
| E12 | **Pricing.** `cost_usd` is the tokens times the experiment's frozen price table. An unpriced model gives null, and those attempts are counted, never treated as zero. `config/prices.yaml` ships with `mock/scripted` at 0 and only real prices verified from a public page, with `checked_at`.                                                                                                                                                                                                                                                                                                                                                 | Spend and cost must be honest about what is not known.                                                                 | Plan 7.2 and 7.3, invariant 4; Phase 1 open question 2                                      |

### 2.2 Choices made while building

These are the places where the engineers chose something the plan or the brief did not fix, or departed from it. Each one is in the code and tested.

| Area          | Choice                                                                                                                                                                                                                                                                                                                                                                        | Why                                                                                                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers     | `openai` and `anthropic` run as Hermes `--provider custom` against the provider's own OpenAI-compatible endpoint. `nous-api` runs as Hermes `nous` with an API key. `nous`, `openrouter` and `custom` map to themselves.                                                                                                                                                      | Hermes has no `openai` id, and its `openai-api` and `anthropic` ids use the Responses and Messages APIs, which the model gateway does not forward. Read in the Hermes source at `4d04303` and checked with `resolve_runtime_provider` in the trial image. |
| MCP auth      | Each http MCP entry in `config.yaml` gets `headers: {Authorization: "Bearer ${HERMES_EVALS_ATTEMPT_TOKEN}"}`, and the container environment carries `HERMES_EVALS_ATTEMPT_TOKEN`. The gateway checks it against the registration's token and strips it before forwarding.                                                                                                     | Hermes fills `${NAME}` in every string of an `mcp_servers` entry, headers included, and fails closed when one is unset (`tools/mcp_tool_config.py:554`, `:585`). The token then lives only in the environment, never in a file.                           |
| MCP gateway   | It forwards an allowlist of request headers (Accept, Content-Type, Content-Length, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID) and HEAD as well as GET, POST and DELETE. A query string answers 400 and a subpath 404.                                                                                                                                               | Hermes's preflight probe sends HEAD first. Refusing queries and subpaths is how "the exact URL" is enforced.                                                                                                                                              |
| Egress        | A registration is refused when an MCP route names a provider credential as a header variable, when egress lacks a header variable, or when the token has a character outside `[A-Za-z0-9._~+/=-]` (it travels as a bearer token and as the proxy password). `MODEL_UPSTREAMS` may not define `custom`.                                                                        | Defence in depth: a credential can never be sent to an MCP server, and a missing variable fails the attempt as `setup` naming it.                                                                                                                         |
| Egress        | The model gateway allows 8 calls in flight per attempt, refuses a body declared over 10 MiB before reading it, holds at most 512 sockets and gives a request 60 s to arrive. Compose gives egress `mem_limit: 1g`.                                                                                                                                                            | The agent holds its token and can call the gateway as often as it likes. A review finding.                                                                                                                                                                |
| Egress        | A registration expires 60 s after the SIGKILL deadline, and egress drops it 10 minutes after that. Recovery removes a lost attempt from egress once its container is confirmed gone.                                                                                                                                                                                          | Found in the live check: attempts lost with a worker stayed registered until egress restarted.                                                                                                                                                            |
| nous-login    | Each device login runs in a child process (`--login-child`) that Cancel or a second Connect kills. A login that was approved and is being saved is waited for, never killed.                                                                                                                                                                                                  | Hermes's poll loop has no cancel hook, and a half-saved login would leave the auth store and the shared store disagreeing.                                                                                                                                |
| nous-login    | The volume's state (`not_connected`, `connected`, `relogin_required`, `unavailable`) and the device login's state are kept apart. Readiness uses only the volume's state.                                                                                                                                                                                                     | A pending Reconnect must not pause runs on a login that still works.                                                                                                                                                                                      |
| nous-proxy    | It runs in a shell loop that restarts `hermes proxy start` every 5 s.                                                                                                                                                                                                                                                                                                         | Without a login `hermes proxy start` exits 2. The loop picks up a login made through nous-login without a restart.                                                                                                                                        |
| Providers API | `GET /providers/nous/login` answers 200 `not_connected` when nous-login is unavailable; POST, DELETE and logout answer 503. `custom` is always `configured`, because its key is optional. The rows are nous, openrouter, nous-api, openai, anthropic, then custom when a configuration uses it.                                                                               | The UI polls the login every 2 s and must not see errors.                                                                                                                                                                                                 |
| Attempt token | 64 lowercase hex characters (256 bits).                                                                                                                                                                                                                                                                                                                                       | Found in the live check: a base64url token starting with `-` made Hermes's argparse read `--api-key -…` as a missing value, so about 1 run in 64 failed as `setup`.                                                                                       |
| Runner        | The launch record carries the slot `network` and a `container` block (name, image, user, limits, mounts, disk cap, stop grace, deadline, env names) beside the shared record.                                                                                                                                                                                                 | The inspector shows exactly what ran.                                                                                                                                                                                                                     |
| Runner        | When a configured MCP server fails to start, Hermes parks it and still prints a normal `result`. The runner reads `HERMES_HOME/logs/errors.log` before deleting the home and ends such an attempt as `setup`.                                                                                                                                                                 | Found in the live check: those runs were scored, and the circuit breaker never tripped. Plan 8.4 now says so.                                                                                                                                             |
| Runner        | Collection stores at most 512 MiB per attempt, counted by apparent size before reading. Files past it are recorded with `skipped_reason = over_budget` (migration `0005`).                                                                                                                                                                                                    | A sparse file could turn the 2 GiB disk cap into about 122 GiB of blob writes. A review finding.                                                                                                                                                          |
| Runner        | stdout is capped at 20,000 lines, and more than 25,000 queued events stop the trial as `output_limit`. A backlog drains 500 events per statement.                                                                                                                                                                                                                             | A trial could otherwise write millions of events and stall the worker and Postgres. A review finding.                                                                                                                                                     |
| Runner        | Before collecting or deleting, the worker gives itself back owner permissions on the trial tree, and the disk watchdog counts an unreadable or too deeply nested directory as over the cap.                                                                                                                                                                                   | A trial could make its directories unlistable and undeletable. A review finding.                                                                                                                                                                          |
| Lifecycle     | Provider readiness is asked for, and a trial slot taken, **before** the claim transaction. Either one missing puts the job back with `deferJob` and spends no attempt. A readiness check that cannot get an answer defers the job instead of pausing the experiment.                                                                                                          | No network call happens under the experiment lock, and a nous-login or egress restart does not leave an experiment paused.                                                                                                                                |
| Lifecycle     | The claim defers a job whose experiment froze another Hermes revision than this worker runs. Presence marks the sandbox `failed` when the trial image's revision label differs from the build, and that worker takes no runs.                                                                                                                                                 | Invariant 4: an experiment runs on the revision it froze. A review finding.                                                                                                                                                                               |
| Lifecycle     | The finish transaction locks experiment, run and attempt, then inserts the final events and artifacts, **then** makes the fenced update that finishes the attempt.                                                                                                                                                                                                            | The `0001`/`0004` triggers refuse events and artifacts once the attempt has finished.                                                                                                                                                                     |
| Lifecycle     | Cost prices Hermes's `result` tokens, or egress's own count when there is no result or the result claims less (`billableTokens`). An attempt of a priced model whose trial ran but whose usage nobody measured counts at the mean priced attempt cost in the spend guard and in `unpricedAttempts`.                                                                           | A deadline, kill or cancel would otherwise cost $0, and the ceiling could not stop it. A review finding; plan 7.3 now says so.                                                                                                                            |
| Lifecycle     | The automatic retry covers a `provider` or `timeout` error of attempt 1 only, 30 s later. The circuit breaker counts every execution error the runner reports, retried or not, but not recovery's `worker_lost`.                                                                                                                                                              | Plan 8.4's "attempt 2". A worker crash is not the experiment's fault.                                                                                                                                                                                     |
| Lifecycle     | `runs.next_trigger` (migration `0005`) records the trigger of the run's next attempt where it is queued, and a re-sent job reads it.                                                                                                                                                                                                                                          | Re-sent jobs used to guess the trigger from the last attempt. A review finding.                                                                                                                                                                           |
| Lifecycle     | The finish is retried for the lease's lifetime less one heartbeat. A Postgres data or integrity error records a reduced outcome once (`execution_error · other`, tokens and cost kept).                                                                                                                                                                                       | The outcome exists only in memory; a database restart of a few seconds must not throw it away. A review finding.                                                                                                                                          |
| Lifecycle     | There is no deadline column, so recovery's "past deadline plus 120 s" is `started_at` + the run budget + 720 s.                                                                                                                                                                                                                                                               | 720 s covers the build and collection allowance in `EXECUTE_RUN_EXPIRE_SECONDS` plus the plan's 120 s.                                                                                                                                                    |
| Shutdown      | The worker stops taking jobs, aborts running attempts (each runner stops and removes its container), marks itself stopped, then runs one last recovery pass (at most 20 s) that ends those attempts as `worker_lost` and requeues their runs, once `clearRun` confirms no container is left. Compose gives the worker `stop_grace_period: 90s` and `restart: unless-stopped`. | A worker stopped and never restarted would otherwise leave runs `running` for good.                                                                                                                                                                       |
| Commands      | Resume and Retry failed runs check provider readiness whatever the pause reason, and answer 409 when no connected worker runs the experiment's frozen Hermes revision.                                                                                                                                                                                                        | Plan 6.1's nudge table gates both on the providers.                                                                                                                                                                                                       |
| Commands      | Cancelling a paused or failed experiment sets it back to `running` with `cancelled_at`, then reconcile completes it. A run of a cancelled experiment cannot be retried, and a run of a failed one only through Retry failed runs.                                                                                                                                             | `experiments_cancelled_ck` allows `cancelled_at` only on running or completed experiments. Plan 3.3's "user retry from failed" is replaced by Retry failed runs, which also clears the breaker.                                                           |
| Commands      | Concurrency is capped at what the proven workers' slots allow (at most 16) instead of being refused. Duplicate proposes each configuration at its latest version.                                                                                                                                                                                                             | Launch refuses a version that has a newer one.                                                                                                                                                                                                            |
| Budget        | `time_budget_override_s` **replaces** each configuration's `time_budget_s`; it does not cap it (`execution/budget.ts`). Execution, recovery's deadline, the inspector, the Overview's timing and every estimate use this one rule. `GET /experiments/estimate` takes it as `budget`.                                                                                          | Every arm gets the same budget. Two review findings disagreed; the plan and the frozen estimate already said "replace". Plan 7.1 now says so.                                                                                                             |
| Contracts     | Every Phase 2 contract is a zod schema in `packages/shared`, in seven files, and the web types re-export them. The request schemas transform to the web's in-app shapes (`RunFilters`, `EstimateQuery`). Response schemas carry the database's own rules as refinements (paused if and only if a pause reason is set, and so on).                                             | One definition on both ends, as Phase 1 did. `wire.spec.ts` checks that what the web sends parses back.                                                                                                                                                   |
| Views         | The experiment SSE poller reads a cheap version (`results_revision` plus status, pause reason and failure) every second, and the full state only when it moved. Both streams are written by hand on the raw response, with a 15 s keepalive comment and a cap of 64 subscribers each.                                                                                         | Runs have no updated-at column, and the `0001` triggers bump `results_revision` on every status change and every published score set. Writing by hand lets 404 and 503 answer as JSON before the stream opens.                                            |
| Views         | The timeline places each egress network row at its start time (`at` minus `ms`), and a refused connection on the tool call running at the time. An events page holds at most 2,000 events, and a tool row whose result arrived since the last poll is sent again with the same seq.                                                                                           | Egress's log is stored when the attempt ends. The client replaces rows by seq.                                                                                                                                                                            |
| Evaluation    | Each `verifier_script` key gets its own fresh copy of the workspace rebuilt from the artifact blobs; all `file_check` keys share one. A dead-lettered first evaluation publishes one `error` score per key and stores the reason in `evaluations.error`.                                                                                                                      | A verifier may write; `file_check` only reads. The run still reaches `scored`.                                                                                                                                                                            |
| Tests         | The full-application e2e is one file with its harness in `test/support`, and the e2e config runs 4 files at a time. It refuses to start without `TEST_DATABASE_URL` or when pointed at port 5432.                                                                                                                                                                             | Each world holds about 40 connections; uncapped, the suite hit "too many clients" on a 100-connection server.                                                                                                                                             |

### 2.3 UI_FLOWS open points this phase closes

| #   | Point                                                                                    | Outcome                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | `GET /experiments/new-options` and the artifact preview route were missing from the API. | Done: both are built and in Swagger (section 4).                                                                                                                                                  |
| 5   | `PAUSE_REASONS` had no `provider_disconnected`.                                          | Done in migration `0004` and `packages/shared/src/status.ts`.                                                                                                                                     |
| 6   | The connection log had no platform event subtype.                                        | Done: subtype `network` with `NetworkEventPayloadSchema` (kind, decision, background, and host, port, reason, status, ms, model, server, method, tokens where known).                             |
| 7   | The API could not see the host login's state.                                            | Done as suggested: egress's admin `/health` reports `hostProxy`, the worker records `workers.host_proxy` on start and every heartbeat, and `GET /providers` reports `host` or `host_unreachable`. |
| 9   | Live rows and the live timeline had no transport.                                        | Done on the API side (E6). The polling itself is the frontend's.                                                                                                                                  |
| 10  | Launch over the spend ceiling.                                                           | Confirmed: allowed, and the spend guard pauses at the ceiling.                                                                                                                                    |
| 11  | Launch with no proven sandbox.                                                           | Done: 409 "No connected worker has proven sandbox isolation…", checked before the transaction.                                                                                                    |
| 12  | `nous-login` `unavailable` had no state.                                                 | Done on the API side: `NOUS_STATUSES` gains `unavailable`. The web status chip and text are the frontend's (section 7.1).                                                                         |
| 16  | Egress `allowHosts` was documented as MCP hosts.                                         | Done (E5): allowlist mode refuses every CONNECT and plain-http request before any DNS lookup, with tests.                                                                                         |

Point 4 (the banner on Resources) is a frontend item. `UI_FLOWS.md` now marks these points resolved, and plan section 17 marks Phase 2 as built.

### 2.4 Review

A review produced 42 findings. 29 were confirmed. 28 were fixed, each with a regression test where a test can show it, and one was skipped because it contradicted another (the budget override, section 2.2). 13 were rejected after checking them against the plan, the decisions, the contracts and the code. The live check then found four more defects, which were fixed with tests: the attempt token's leading `-`, MCP start failures that still scored, the session banner in the breaker's first line, and lost attempts left in egress.

| Rejected finding                                                             | Why                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The slot is checked when acquired, not just before the container is created. | E9's check runs before the create, and within one worker nothing else adds a container to an acquired slot: http MCP tests borrow from the same pool. Overlapping `TRIAL_SLOTS` between workers is the unsupported setup E9 names. The sandbox CLI's `freeSlot` is a development helper.                                                       |
| The model gateway follows upstream redirects.                                | A 307 or 308 cannot replay the POST: undici fails on the detached body and the trial gets 502, checked with Node 22 and 25. A 301 to 303 becomes a body-less GET, whose targets in this stack only read, and Authorization is stripped cross-origin. Only a configured upstream can redirect. `redirect: 'manual'` remains optional hardening. |
| nous-login is on `edge` as well as `provider-admin`.                         | Plan 14 and 15 place it there to reach the portal. Trials cannot reach it, and egress's proxy, model gateway and MCP gateway cannot be steered to it by the agent.                                                                                                                                                                             |
| A cluster-wide recovery lock can make a shutdown skip its last pass.         | Only with workers on different daemons, which the shipped stack does not support, and plan 8.6 accepts the resulting state ("left revoked until a worker on that daemon confirms it"). The lock is what plan 8.6 specifies.                                                                                                                    |
| The image's Hermes revision is never compared with the build.                | The revision is fixed by the repository (pinned digest, label and constant together). The launch 409 for disagreeing workers does fire. A separate finding about the claim was confirmed and fixed (section 2.2).                                                                                                                              |
| The circuit breaker counts errors that are retried automatically.            | Plan 7.3 counts "each execution error (reset on success)", and UI_FLOWS 3 agrees. Waiting retries stay queued and Retry failed runs re-sends them.                                                                                                                                                                                             |
| `AttemptView.countsAgainstRun` is always true.                               | Every attempt counts against the 5-attempt cap in plan 7.3 and 8.4 and in the database's CHECKs. Only the provider guard spends no attempt, and it creates no attempt row.                                                                                                                                                                     |
| An unreachable egress at registration burns attempts as `setup`.             | Plan 8.4 puts a failed start in `setup`, retried by the user, and the breaker needs at least 8 s of unbroken outage at the pinned polling rate. Deferring instead would be an improvement, not a fix.                                                                                                                                          |
| An attempt on a Docker daemon that never returns is never finalised.         | Plan 8.6 and UI_FLOWS 12.4 require exactly that: a missing heartbeat never proves a trial stopped. A force-finalise command would be a new feature (section 7.2).                                                                                                                                                                              |
| Recovery never removes a lost attempt's egress registration.                 | Rejected in review because the token expires at the SIGKILL deadline plus 60 s and nobody holds it. The live check then showed registrations piling up in egress, so it was fixed anyway (section 2.2).                                                                                                                                        |
| The isolation self-test runs only at boot.                                   | Plan 8.7 and UI_FLOWS 5.1 make it a start-up gate, and restarting the worker is the documented fix.                                                                                                                                                                                                                                            |
| The spend guard is not tested with a second experiment's spend.              | Both spend queries filter on the experiment; the failure appears only after a hand mutation. A stronger test is optional.                                                                                                                                                                                                                      |
| The real-container half of the exit criterion has no repeatable test.        | E10 assigns it to the live stage. The live stage then added `scripts/phase2-smoke.sh` (section 6.2).                                                                                                                                                                                                                                           |

Two fixes were narrowed. FakeEgress does not validate registrations against egress's real schema, which needs a new workspace dependency (section 7.2); instead the shared MCP schema refuses on save what egress would refuse, and the worker checks again before registering. And recovery does not meter a `worker_lost` attempt from egress's usage: a graceful hand-back has already removed the registration, so such an attempt counts at the mean priced cost.

---

## 3. Design

### 3.1 Module map

The API still never talks to Docker and never runs user code. It validates, writes rows and jobs together, and serves reads and SSE. The worker claims jobs, drives each trial through docker-guard and egress, scores runs and recovers lost ones. They meet only in Postgres: pg-boss jobs in the same database, the run tables, and the `workers` row.

```mermaid
flowchart LR
  subgraph shared["packages/shared"]
    CT["contracts/*<br/>experiments, new-experiment, runs,<br/>run-detail, providers, events, comparison"]
    VO["status, vocab, records<br/>pause reasons, network payload"]
  end

  subgraph api["API process: AppModule"]
    PRV["ProvidersModule<br/>with the global NousLoginModule"]
    ECM["ExperimentCommandsModule<br/>options, estimate, launch, controls"]
    RCM["RunCommandsModule<br/>retry, cancel"]
    EVM["ExperimentViewsModule<br/>list, detail, events poller"]
    RVM["RunViewsModule<br/>runs tab, inspector, artifacts"]
    SEM["SystemEventsModule<br/>summary stream"]
  end

  subgraph worker["worker process: WorkerModule"]
    WS["WorkerService<br/>start and stop order"]
    LC["execution lifecycle<br/>LeaseKeeper, execute-run,<br/>recovery loop, SlotPool"]
    RN["TrialAttemptRunner"]
    EV["evaluate-run and<br/>evaluate-run-dead"]
    WP["WorkerPresenceService<br/>heartbeat, host_proxy"]
    MT["test-mcp-server<br/>stdio and http"]
  end

  subgraph egress["egress"]
    FP["forward proxy :3128"]
    MG["model gateway :8080/v1"]
    MC["MCP gateway :8080/mcp/name"]
    AD["admin socket<br/>attempts, env-names, health"]
  end

  PG[("Postgres 17<br/>tables and pg-boss")]
  BL[("evaldata<br/>blobs, skills")]
  TV[("trials volume<br/>home, workspace, stderr.log")]
  NH[("nous-home volume")]
  G["docker-guard"]
  T["trial container"]
  NL["nous-login :8650"]
  NP["nous-proxy :8645"]
  MM["mock-model :8090<br/>profile test"]
  MS["http MCP server"]

  PRV -- "status and login, provider-admin" --> NL
  ECM -- "provider readiness" --> NL
  ECM -- "rows and jobs in one transaction" --> PG
  RCM -- "rows and jobs" --> PG
  EVM -- "reads every 1 s per watched experiment" --> PG
  RVM -- "reads" --> PG
  SEM -- "summary every 5 s" --> PG
  RVM -- "artifact bytes" --> BL
  PG -- "execute-run" --> LC
  PG -- "evaluate-run" --> EV
  WS --> LC & EV & WP & MT
  LC -- "claim, finish, recovery" --> PG
  LC -- "provider readiness" --> NL
  LC --> RN
  RN -- "register and remove the attempt" --> AD
  RN -- "create, start, logs, remove" --> G
  RN -- "materialise, collect" --> TV
  RN -- "inputs and new blobs" --> BL
  G --> T
  T -- "model calls, attempt token" --> MG
  T -- "http MCP, attempt token" --> MC
  T -- "CONNECT, public mode only" --> FP
  MG -- "nous" --> NP
  MG -- "custom base URL" --> MM
  MC -- "exact URL, headers added" --> MS
  NL --- NH
  NP --- NH
  EV -- "evidence" --> BL
  EV -- "scores, publish" --> PG
  WP -- "health and env-names" --> AD
  WP -- "workers row" --> PG
  shared -. "types and schemas" .-> api & worker
```

Which code touches which tables. Phase 1 modules are unchanged unless named.

| Code                                           | Process | Writes                                                                                                                                                                                                                   | Reads                                                                                                                                              |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers/`                                   | api     | none (relays to nous-login)                                                                                                                                                                                              | `workers`, `configurations`, `configuration_versions`, `experiments`; nous-login `/status` and `/login`                                            |
| `experiments/commands/` launch                 | api     | `configuration_versions.frozen_at`, `experiments`, `runs`, `execute-run` jobs                                                                                                                                            | `suites`, `tasks`, `configurations`, `configuration_versions`, `workers`, `attempts` (estimate history), the price file                            |
| `experiments/commands/` controls and duplicate | api     | `experiments`, `runs`, `execute-run` jobs                                                                                                                                                                                | `attempts` (spend), `workers`, `configuration_versions`, `suite_sources`, `tasks`                                                                  |
| `experiments/estimates/`                       | api     | none                                                                                                                                                                                                                     | `attempts`, `runs`, `experiments`, `configuration_versions`, the price file                                                                        |
| `runs/commands/`                               | api     | `runs`, `experiments`, `execute-run` jobs                                                                                                                                                                                | `configuration_versions`                                                                                                                           |
| `experiments/views/`, `experiments/sse/`       | api     | none                                                                                                                                                                                                                     | `experiments`, `runs`, `attempts`, `evaluations`, `scores`, `run_events` (last event time), `configuration_versions`, `suites`, `tasks`, `workers` |
| `runs/views/`                                  | api     | none                                                                                                                                                                                                                     | `runs`, `attempts`, `run_events`, `artifacts`, `evaluations`, `scores`, `tasks`, `configuration_versions`, `workers`, blob files                   |
| `system/events/`                               | api     | none                                                                                                                                                                                                                     | `workers`, `experiments`, `runs` (through `SystemService`)                                                                                         |
| `execution/lifecycle/` claim                   | worker  | `attempts`, `runs`, `workers.in_flight`, `experiments` (guard pauses), deferred jobs                                                                                                                                     | `experiments`, `runs`, `configuration_versions`, `attempts` (spend)                                                                                |
| `execution/lifecycle/` sink and finish         | worker  | `attempts` (launch record, container, outcome, cost), `run_events`, `blobs`, `artifacts`, `runs`, `evaluations`, `experiments` (breaker, failure, reconcile), `workers.in_flight`, `execute-run` and `evaluate-run` jobs | the same rows, under locks                                                                                                                         |
| `execution/lifecycle/` recovery                | worker  | `attempts` (revoke, end), `run_events` (`worker_lost`, `cancelled`), `runs`, `experiments`, `workers.in_flight`, jobs; trial directories                                                                                 | `attempts`, `workers`, `runs`, `evaluations`, `experiments`                                                                                        |
| `execution/attempt/` runner                    | worker  | the database only through the sink; trial directories; blob files                                                                                                                                                        | blob files, `DATA_DIR/skills`, the worker's environment (stdio MCP values), egress env-names                                                       |
| `evaluation/`                                  | worker  | `evaluations`, `scores`, `runs`, `experiments` (reconcile)                                                                                                                                                               | `attempts`, `artifacts`, `tasks`, `task_files`, blob files                                                                                         |
| `worker/presence`                              | worker  | `workers` (now with `host_proxy`)                                                                                                                                                                                        | egress `/health` and `/env-names`, the trial image                                                                                                 |

How the worker starts and stops (`WorkerService`). Migrations run first, in `DatabaseModule`.

```mermaid
sequenceDiagram
  autonumber
  participant WK as WorkerService
  participant SB as SandboxService
  participant WP as WorkerPresenceService
  participant E as egress admin socket
  participant DB as Postgres and pg-boss
  participant LC as execution lifecycle

  WK->>DB: queue ping
  WK->>SB: verify(): the 15-check isolation self-test
  WK->>WP: start()
  WP->>E: GET /env-names and GET /health (hostProxy)
  WP->>DB: insert workers row: sandbox report, slots, host_proxy,<br/>sandbox failed when the image label is another Hermes revision
  WK->>LC: startExecutionLifecycle once the workers row exists
  LC->>LC: LeaseKeeper: heartbeat every 10 s, cancel watcher every 1.5 s
  LC->>DB: one recovery pass, before any new trial
  LC->>DB: register execute-run only when isolated, the image matches<br/>and the Docker daemon id is known
  LC->>LC: recovery timer every RECOVERY_INTERVAL_MS
  WK->>DB: register evaluate-run-dead, then evaluate-run, whatever the sandbox state
  WK->>DB: register load-suites and test-mcp-server<br/>(http tests borrow slots from the lifecycle's pool)
  WK->>WK: start-up suite load in the background, stale MCP test reconciler
  loop every 10 s
    WP->>E: GET /env-names and GET /health
    WP->>DB: heartbeat, env names, host_proxy
  end
  Note over WK,LC: On stop: the lifecycle takes no new job and aborts running attempts.<br/>Each runner stops and removes its container and hands back.<br/>Presence marks the row stopped, then one last recovery pass (at most 20 s)<br/>ends those attempts as worker_lost and requeues their runs.
```

### 3.2 Data model changes

Two migrations, both applied at boot by the migrator under its advisory lock. Columns marked `0004` or `0005` are new or changed; everything else existed and Phase 2 is the first code to write it.

```mermaid
erDiagram
  experiments ||--|{ runs : "experiment_id"
  runs ||--o{ attempts : "run_id"
  runs |o--o| attempts : "current_attempt_id"
  attempts ||--o{ run_events : "attempt_id, seq"
  attempts ||--o{ artifacts : "attempt_id"
  blobs |o--o{ artifacts : "sha256"
  attempts ||--o{ evaluations : "attempt_id"
  evaluations ||--o{ scores : "evaluation_id"
  workers ||--o{ attempts : "worker_id"

  experiments {
    text status "running paused completed failed"
    text pause_reason "0004 adds provider_disconnected"
    timestamptz paused_at
    timestamptz cancelled_at
    integer concurrency "capped by the workers' slots"
    numeric spend_ceiling_usd
    integer time_budget_override_s "replaces each budget"
    text hermes_revision "frozen at launch"
    jsonb price_table "frozen at launch"
    jsonb estimate "frozen at launch"
    integer consecutive_execution_errors "circuit breaker"
    jsonb failure
    bigint results_revision "bumped by triggers"
    bigint verdict_revision "set by reconcile"
  }
  runs {
    text status
    integer attempt_count
    text current_attempt_id FK
    timestamptz cancel_requested_at
    text next_trigger "0005"
  }
  attempts {
    integer number
    text trigger
    text status "running executed execution_error cancelled"
    text error_category
    text final_text
    jsonb tokens
    numeric cost_usd "null when unpriced"
    jsonb launch_record "before the container exists"
    uuid lease_token
    timestamptz lease_expires_at
    timestamptz lease_revoked_at
    text sandbox_id
    text sandbox_host_id "Docker daemon id"
    text stderr_tail "last 40 lines, redacted"
  }
  run_events {
    integer seq "gap-free per attempt"
    text type
    jsonb payload "platform subtype network is new"
  }
  artifacts {
    text path
    text origin
    text sha256 FK
    text skipped_reason "0005 adds over_budget"
  }
  evaluations {
    integer generation
    text status
    uuid claim_token
    timestamptz claim_expires_at
    jsonb answer
    text error
  }
  scores {
    text key
    text status
    boolean is_primary
    integer scorer_version
  }
  workers {
    integer in_flight
    jsonb host_proxy "0004"
    jsonb sandbox
  }
```

| Migration               | Change                                                                                             | Constraint                                                                                                                                                                           | Upgrade of existing rows                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `0004_phase2_execution` | `experiments_pause_reason_ck` gains `provider_disconnected`                                        | `pause_reason in ('user', 'spend_ceiling', 'provider_disconnected')`                                                                                                                 | A CHECK change; existing rows hold only the older values                                                                      |
|                         | `workers.host_proxy`                                                                               | `workers_host_proxy_ck`: null, or an object with string `target`, boolean `reachable` and string `checked_at`                                                                        | Nullable, no default: nothing is rewritten                                                                                    |
|                         | The `run_events_require_open_attempt` trigger now calls `hermes_run_events_require_open_attempt()` | A finished attempt still takes no event. A revoked, unfinished attempt now accepts only `platform` events with subtype `worker_lost` or `cancelled`. Artifacts keep the `0001` rule. | `0001` refused every event on a revoked attempt, so recovery could never write the `worker_lost` subtype that already existed |
| `0005_phase2_review`    | `runs.next_trigger`                                                                                | `runs_next_trigger_ck`: null or one of `ATTEMPT_TRIGGERS`                                                                                                                            | Nullable, no default; runs queued before it fall back to `queuedRunTrigger`                                                   |
|                         | `artifacts_skipped_reason_ck` gains `over_budget`                                                  | `skipped_reason in ('too_large', 'over_budget')`                                                                                                                                     | A CHECK change                                                                                                                |

The `network` subtype needs no DDL: subtypes live in the payload and no CHECK reads them. Its payload is `NetworkEventPayloadSchema` in `packages/shared/src/records.ts`. `0005` was added rather than editing `0004`, because a database that already applied `0004` would stop on the changed hash. The upgrade is tested on PGlite (`phase2-migration.spec.ts`), and the live Compose database applied both at boot (migrations 6 of 6).

Every other rule is still the database's own (plan 3.2), and the new code works with it: an event or artifact only while the attempt runs under an unrevoked lease, a finished attempt never changes, a first evaluation can never fail, a publish needs the run's current attempt and exactly the task's keys, and `results_revision` moves on every run status change and every published score set.

### 3.3 Launch

```mermaid
sequenceDiagram
  autonumber
  participant U as User or web
  participant A as API: LaunchService
  participant NL as nous-login
  participant DB as Postgres
  participant Q as pg-boss, same database

  U->>A: POST /api/experiments, LaunchExperimentInput
  A->>A: ZodValidationPipe: names, at least one candidate,<br/>repetitions 1 to 20, concurrency 1 to 16, expectedConfigHashes keys
  A->>DB: resolve the suite version, its valid tasks, the configuration versions
  alt something does not resolve or a task is invalid
    A-->>U: 400 Validation failed, one issue per problem
  end
  A->>DB: liveWorkers: heartbeat under 60 s, proven isolation, slots
  alt no worker, none proven, or Hermes revisions differ
    A-->>U: 409 with the reason
  end
  A->>NL: readiness of each provider (key providers from egress env names)
  alt a provider is not ready
    A-->>U: 409, for example Nous Portal is not connected
  end
  A->>A: snapshot config/prices.yaml, estimate the matrix,<br/>cap concurrency at the proven workers' slots
  A->>DB: BEGIN
  A->>DB: UPDATE configuration_versions SET frozen_at = now() WHERE frozen_at IS NULL
  A->>DB: SELECT config_hash FOR SHARE, latest versions
  alt a hash differs from the form's, or a newer version exists
    A->>DB: ROLLBACK
    A-->>U: 409 configuration NAME changed since you opened this form (now vN)
  end
  A->>DB: INSERT experiment with the frozen Hermes build, price table and estimate
  A->>DB: INSERT tasks x versions x repetitions runs, queued, next_trigger initial
  A->>Q: one execute-run job per run, key runId:1, trigger initial, via fromDrizzle(tx)
  A->>DB: COMMIT, rows and jobs together or nothing
  A-->>U: 201 with the experiment id
```

An estimate over the spend ceiling does not block the launch (E7). A price file that exists but cannot be used answers 500 and launches nothing. The Postgres 17 e2e checks that an observer never sees runs without their jobs across a 200-run launch, and that a failure injected into the job insert leaves nothing behind.

### 3.4 One attempt, end to end

```mermaid
sequenceDiagram
  autonumber
  participant Q as pg-boss
  participant WK as worker: execute-run
  participant DB as Postgres
  participant R as TrialAttemptRunner
  participant V as trials volume
  participant E as egress
  participant G as docker-guard
  participant T as trial: Hermes
  participant EV as worker: evaluate-run

  Q->>WK: execute-run with runId, attempt n, trigger, key runId:n
  WK->>DB: unlocked read: stale job? experiment frozen on this worker's revision?
  WK->>WK: provider readiness (outside any lock), take a free slot network
  alt readiness unknown, no free slot, or worker stopping
    WK->>Q: deferJob 5 to 15 s, no attempt spent
  end
  WK->>DB: claim: lock experiment, lock run, revision, admission,<br/>spend guard, provider guard
  WK->>DB: INSERT attempt n, lease 60 s, sandbox_host_id, run running,<br/>next_trigger cleared, workers.in_flight + 1, COMMIT
  WK->>DB: build the AttemptPlan from the rows, refusedEnvNames check
  WK->>R: run(plan, fenced sink, abort signal)
  R->>E: GET /env-names: every http MCP header variable must be there
  R->>V: fresh home and workspace: fixtures (hash re-checked), docs, skills,<br/>.no-bundled-skills, task.txt, config.yaml with references only
  R->>DB: sink.recordLaunch: the launch record, fenced on the lease
  R->>E: register: token, allowlist or public mode, model route,<br/>MCP routes, expiry at SIGKILL deadline + 60 s
  R->>G: create the container (checked field by field), then start
  R->>DB: sink.recordContainer, platform event started
  Note over R,T: Armed before any output is read: the deadline (budget + 60 s, then SIGTERM,<br/>SIGKILL 10 s later), the cancel signal, the disk watchdog (2 GiB, 50,000 files),<br/>64 MiB and 20,000 lines of output
  loop the agent works
    T->>E: model calls on :8080/v1, http MCP on :8080/mcp/name, attempt token
    T-->>R: stream-json lines on stdout, stderr to stderr.log
    R->>DB: run_events in batches of 50 or every 500 ms, gap-free seq, redacted
  end
  T-->>R: result event, exit
  R->>G: remove the container
  R->>E: remove the attempt: the token dies, usage and connection log come back
  R->>V: read logs/errors.log for MCP servers that failed to start
  R->>R: classify (plan 8.4)
  R->>V: restore owner access, walk the workspace with lstat, hash,<br/>store new blobs (512 MiB budget), delete the home
  R-->>WK: AttemptOutcome: status, category, tokens, final events, artifacts
  WK->>DB: finish: lock experiment, run, attempt under its lease
  WK->>DB: final events (network, killed, cancelled, collected), blobs, artifacts
  WK->>DB: fenced update: attempt status, tokens, cost from the frozen prices
  alt executed
    WK->>DB: run executed, evaluation generation 1, breaker reset
    WK->>Q: evaluate-run with evaluationId, in the same transaction
  else execution_error
    WK->>DB: breaker + 1, failed at the threshold
    WK->>Q: provider or timeout on attempt 1: attempt 2, 30 s later
  else cancelled
    WK->>DB: run cancelled
  end
  WK->>DB: workers.in_flight - 1, reconcile, COMMIT
  Q->>EV: evaluate-run
  EV->>DB: claim: lock experiment then run, new claim token for 10 min, run scoring
  EV->>EV: score every key over stored evidence, write nothing
  EV->>DB: publish: re-read the evaluation by claim token, insert every score,<br/>supersede, complete, run scored, reconcile, COMMIT
```

How the attempt's outcome is decided (`execution/attempt/classify.ts`). The first row that matches wins:

| Observation                                                                                               | Attempt status    | Category                                                              |
| --------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| A cancel was requested (the user's, or the experiment's)                                                  | `cancelled`       |                                                                       |
| No container ran: a secret, a directory, egress or the container start failed                             | `execution_error` | `setup`, naming the cause (`other` when the engine failed mid-run)    |
| The disk watchdog passed 2 GiB or 50,000 files                                                            | `execution_error` | `other`, naming the cap                                               |
| Output passed 64 MiB, 20,000 lines or 25,000 queued events                                                | `execution_error` | `other`                                                               |
| The container was OOM-killed                                                                              | `execution_error` | `other`                                                               |
| A configured MCP server failed to start (`logs/errors.log`)                                               | `execution_error` | `setup`, naming the server, even when a `result` was printed          |
| `result` with exit 3 ("Input required"), or an error saying Hermes could not start the run                | `execution_error` | `setup`                                                               |
| `result` with an error about auth, 401 or 403                                                             | `execution_error` | `provider`                                                            |
| `result` with an error about 429, 5xx, rate limits or connection                                          | `execution_error` | `provider`                                                            |
| `result` with text (exit 0, or exit 1 with the partial text of a max-turns stop), or exit 0 with no error | `executed`        | (`timeout` instead when the deadline stopped it with a non-zero exit) |
| The deadline stopped the container with no usable `result`                                                | `execution_error` | `timeout`; a platform `result` is synthesised                         |
| No `result`, and exit 3 or Hermes never printed its init event                                            | `execution_error` | `setup`                                                               |
| Anything else                                                                                             | `execution_error` | `other`                                                               |

`worker_lost` is never decided here: recovery ends a lost attempt (section 3.6).

### 3.5 The run, attempt and experiment as built

```mermaid
stateDiagram-v2
  direction LR
  [*] --> queued : launch
  queued --> running : claim, attempt n
  running --> executed : outcome executed
  executed --> scoring : evaluate-run claims
  scoring --> scored : score set published
  running --> execution_error : outcome execution_error
  running --> queued : auto retry, provider or timeout of attempt 1
  running --> queued : recovery, worker_lost, fewer than 3 attempts
  execution_error --> queued : Retry, Retry failed runs, up to 5 attempts
  queued --> cancelled : Cancel
  running --> cancelled : Cancel, container stopped
```

```mermaid
stateDiagram-v2
  direction LR
  [*] --> running : claim, lease 60 s
  running --> running : heartbeat renews every 10 s
  running --> executed : finish
  running --> execution_error : finish
  running --> cancelled : finish after the cancel watcher stopped it
  running --> revoked : lease expired, worker stopped or silent 120 s,<br/>or past budget + 720 s
  revoked --> execution_error : recovery confirmed the container gone, worker_lost
  revoked --> cancelled : recovery, when a cancel was requested
  note right of revoked : revoked is running with lease_revoked_at set.<br/>It accepts only the worker_lost or cancelled event.
```

```mermaid
stateDiagram-v2
  direction LR
  [*] --> running : launch
  running --> paused : Pause (user), spend guard (spend_ceiling),<br/>provider guard (provider_disconnected)
  paused --> running : Resume
  running --> failed : circuit breaker, 14 execution errors in a row
  failed --> running : Retry failed runs
  running --> completed : reconcile, nothing left in flight
  paused --> completed : reconcile, after the last in-flight run
  completed --> running : a run is retried
  paused --> running : Cancel, cancelled_at set, then drains
  failed --> running : Cancel, failure cleared, then drains
```

An experiment's status says nothing about cancel on its own: Cancel sets `cancelled_at` and leaves it `running` until reconcile completes it. Reconcile completes a settled experiment once, conditional on `verdict_revision IS DISTINCT FROM results_revision`, clears the pause of a paused one that drained, and leaves a failed one alone.

### 3.6 Leases, heartbeat, the cancel watcher and recovery

Every write the worker makes to a running attempt is fenced: `WHERE id = $a AND lease_token = $t AND status = 'running' AND lease_revoked_at IS NULL`. Zero rows means the lease is lost. The runner then stops its container, writes nothing more, and the job completes; recovery owns the attempt from there.

```mermaid
sequenceDiagram
  autonumber
  participant LK as LeaseKeeper, in each worker
  participant R as runner of attempt A
  participant DB as Postgres
  participant RC as recovery pass, any worker
  participant G as docker-guard on this daemon
  participant E as egress admin socket
  participant Q as pg-boss

  loop heartbeat every 10 s
    LK->>DB: UPDATE attempts SET lease_expires_at = now() + 60 s<br/>WHERE (id, lease_token) IN held AND status running AND not revoked
    alt an attempt is missing from the result
      LK->>R: abort with LeaseLostError
      R->>G: stop and remove the container, write nothing more
    end
  end
  loop cancel watcher every 1.5 s
    LK->>DB: which held attempts' runs have cancel_requested_at?
    alt cancel requested
      LK->>R: abort with CancelRequestedError
      R->>G: stop the container (SIGTERM, SIGKILL after 10 s)
      R-->>LK: outcome cancelled, then the normal finish
    end
  end
  loop at boot and every 15 s, one pass at a time (advisory lock 4851002026)
    RC->>DB: 1. revoke: lease expired, worker stopped or silent 120 s,<br/>or started_at + budget + 720 s passed (SKIP LOCKED)
    RC->>G: 2. for each revoked attempt on this daemon: clearRun,<br/>stop, remove, list again until none is left
    RC->>E: 3. remove the attempt: its token dies
    RC->>DB: 3. finalise: platform event worker_lost or cancelled, attempt ended,<br/>run requeued with next_trigger recovery while under 3 attempts, reconcile
    RC->>RC: 3. delete the lost attempt's home
    RC->>G: 4. sweep: trial containers whose attempt is not running,<br/>and probes or MCP tests past their deadline label
    RC->>Q: 5. re-send execute-run for queued runs of running experiments,<br/>evaluate-run for queued or expired evaluations (keys make these no-ops)
    RC->>RC: 6. delete trial directories past TRIAL_RETENTION_DAYS, every 10 minutes at most
    RC->>DB: reconcile running or paused experiments with nothing in flight
  end
```

- An attempt on another Docker daemon stays revoked, and keeps its slot, until a worker on that daemon confirms its container is gone. A missing heartbeat alone never proves a trial stopped (plan 8.6).
- Each step is guarded on its own: an engine that cannot be reached skips steps 2 and 4 and nothing else.
- Recovery's `worker_lost` is not counted by the circuit breaker, and a run lost three times stops being requeued on its own.
- A worker that recovery revokes while it still runs the attempt is told at once (`LeaseKeeper.revoked`), so it writes nothing more while its container is stopped.

### 3.7 Controls and their guards

Every control is one transaction that locks the experiment row first, so a control, another control and a worker finishing a run never interleave. Checks that may call nous-login run before the transaction, so no row lock is held across a network call.

```mermaid
flowchart TD
  PA["POST pause"] --> PA1{"status?"}
  PA1 -- "paused" --> PA2["no-op, keeps its own reason"]
  PA1 -- "running, not cancelled" --> PA3["paused, pause_reason user.<br/>Claims of its jobs complete without starting anything.<br/>In-flight trials finish."]
  PA1 -- "other, or cancelled and draining" --> X409["409 with the reason"]

  RE["POST resume, optional spendCeilingUsd"] --> RE0["before the transaction: a connected worker on the frozen<br/>Hermes revision, every provider ready, else 409"]
  RE0 --> RE1{"status?"}
  RE1 -- "running" --> RE2["no-op"]
  RE1 -- "paused" --> RE3{"spend_ceiling pause?"}
  RE3 -- "yes" --> RE4{"new ceiling above max of old ceiling and spend?"}
  RE4 -- "no" --> X409
  RE4 -- "yes" --> RE5
  RE3 -- "no" --> RE5["running, pause cleared.<br/>execute-run for every queued run, key runId:attempt_count+1.<br/>Reconcile."]
  RE1 -- "other" --> X409

  CN["POST cancel"] --> CN1{"status?"}
  CN1 -- "completed and cancelled" --> CN2["no-op"]
  CN1 -- "completed" --> X409
  CN1 -- "running, paused or failed" --> CN3["running with cancelled_at, pause and failure cleared.<br/>Queued runs cancelled with their jobs.<br/>Running runs get cancel_requested_at: their worker stops the container.<br/>Executed and scoring runs finish scoring. Reconcile."]

  RF["POST retry-failed"] --> RF0["the same pre-checks as Resume"]
  RF0 --> RF1{"status failed?"}
  RF1 -- "no, running" --> RE2
  RF1 -- "no, other" --> X409
  RF1 -- "yes" --> RF2["running, failure and breaker cleared.<br/>execution_error runs under 5 attempts queued, next_trigger retry_failed.<br/>Waiting and requeued runs sent. Reconcile."]

  RR["POST runs/:id/retry, or bulk"] --> RR0["before the transaction: the run's provider ready"]
  RR0 --> RR1{"experiment cancelled or failed,<br/>run not execution_error, or 5 attempts?"}
  RR1 -- "yes" --> X409
  RR1 -- "no" --> RR2["run queued, next_trigger user_retry, execute-run attempt n+1.<br/>A completed experiment goes back to running."]

  RC["POST runs/:id/cancel"] --> RC1{"run status?"}
  RC1 -- "queued" --> RC2["cancelled, job removed, reconcile"]
  RC1 -- "running" --> RC3["cancel_requested_at set, answers running"]
  RC1 -- "cancelled" --> RC4["no-op"]
  RC1 -- "other" --> X409
```

The automatic guards act in the claim (section 3.4):

| Guard             | When                                                                                                    | What happens                                                                                                                                          | How it ends                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Hermes revision   | The experiment froze another revision than this worker runs                                             | The job is put back 5 to 15 s later; nothing is spent                                                                                                 | A worker on that revision takes it. Resume and Retry failed runs answer 409 while none is connected. |
| Admission         | The experiment has `concurrency` runs `running`                                                         | The job is put back 5 to 15 s later                                                                                                                   | A slot frees                                                                                         |
| Spend guard       | The priced spend so far, plus unknown-cost attempts at the mean priced cost, is at or above the ceiling | The experiment pauses with `spend_ceiling`; the job completes                                                                                         | Resume with a higher `spendCeilingUsd`                                                               |
| Provider guard    | The run's provider is not ready (asked before the claim)                                                | The experiment pauses with `provider_disconnected`; no attempt is spent                                                                               | Resume once the provider is ready                                                                    |
| Readiness unknown | nous-login or egress did not answer                                                                     | The job is put back; nothing pauses                                                                                                                   | The next delivery asks again                                                                         |
| Circuit breaker   | `MAX_CONSECUTIVE_EXECUTION_ERRORS` (14) execution errors in a row, any success resetting the count      | A running, uncancelled experiment becomes `failed` with its `failure` (category, message, first stderr line without Hermes's session banner, attempt) | Retry failed runs                                                                                    |

### 3.8 MCP servers in a run: where each value goes

```mermaid
flowchart LR
  ENV[(".env on the host")]
  ENV -- "env_file" --> WENV["worker environment<br/>stdio values, e.g. INVOICE_DB_URL"]
  ENV -- "env_file" --> EENV["egress environment<br/>http header values, e.g. VENDOR_API_TOKEN"]

  subgraph worker["worker: plan and TrialAttemptRunner"]
    CHK["refusedEnvNames, then stdioSecretValues by name,<br/>and egress GET /env-names for every header variable"]
    CFG["config.yaml in the home:<br/>stdio env as NAME references,<br/>http url egress:8080/mcp/name with<br/>Authorization Bearer HERMES_EVALS_ATTEMPT_TOKEN reference"]
    REG["egress registration:<br/>mcp routes name, url, header and env pairs"]
  end

  subgraph trial["trial container"]
    CENV["container environment:<br/>stdio values, HERMES_EVALS_ATTEMPT_TOKEN"]
    H["Hermes fills the references at start"]
    SS["stdio MCP server process<br/>no network: Hermes strips the proxy variables"]
  end

  subgraph egress["egress :8080"]
    GW["MCP gateway: check the bearer token,<br/>strip it, add the route's headers,<br/>forward to the exact URL, no redirect"]
    LOG["attempt connection log:<br/>kind mcp, server, method, status, ms, bytes"]
  end

  WENV --> CHK
  CHK -- "values" --> CENV
  CHK --> CFG
  CHK --> REG
  CFG --> H
  CENV --> H
  H -- "env with the values" --> SS
  H -- "requests with the token as bearer" --> GW
  REG --> GW
  EENV -- "header values, read per request" --> GW
  GW --> MS["the http MCP server"]
  GW --> LOG
  LOG -- "at the attempt's end: network platform events" --> RE[("run_events")]
```

| Value             | Where it lives                                                                                                      | In a file in the home?            | In the launch record, events, logs?                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| stdio env value   | The worker's environment, then the trial container's environment                                                    | No: `config.yaml` holds `${NAME}` | No: the record shows `<from env NAME>`, and every event, the stderr tail and error messages are redacted |
| http header value | Egress's environment only                                                                                           | No                                | No: egress logs the variable's name when it is missing, never the value                                  |
| Attempt token     | The container environment (`HERMES_EVALS_ATTEMPT_TOKEN`, the proxy credentials) and `--api-key` on the command line | No                                | No: argv shows `<attempt-token>`, and the inspector shows ‹run token, revoked›                           |

The gateway's refusals: 401 for an unknown or expired token, 404 for an unknown name or a subpath, 400 for any query string, 405 for other methods, 413 for a body over 4 MiB, 429 for more than 16 calls in flight per attempt (open SSE streams count), 502 for any 3xx or an unreachable server, and 503 naming a header variable egress does not hold. A registration that names a missing variable is refused before the trial starts, so the attempt ends as `setup` naming it. MCP "Test start" for an http server runs `hermes mcp test <name>` through the same gateway, with a short-lived registration and a slot from the lifecycle's pool.

The live check proved both paths in real containers: the stdio `invoice-db` server and an http MCP server reached through the gateway, whose upstream saw the egress-added header on all 13 calls. No secret value was found in the home, the events, the launch records, a database dump or the volumes.

### 3.9 Model access: Nous login and host mode

```mermaid
sequenceDiagram
  autonumber
  participant U as User or web
  participant A as API: ProvidersService
  participant NL as nous-login :8650
  participant C as login child process
  participant NP as Nous Portal
  participant V as nous-home volume
  participant PX as nous-proxy

  U->>A: GET /api/providers
  A->>NL: GET /status, 2 s timeout, never contacts the portal
  NL->>V: get_nous_auth_status_local()
  NL-->>A: volume state, scope, current device login, billing URL
  A-->>U: ProviderInfo rows: nous plus key providers by env name
  U->>A: POST /api/providers/nous/login, X-Requested-With
  alt the newest live worker reports host_proxy
    A-->>U: 409 This stack uses this machine's Hermes login
  end
  A->>NL: POST /login, which kills a pending login child
  NL->>C: start nous-login.py --login-child
  C->>NP: device code request
  NP-->>C: verification URL, user code, expiry
  C-->>NL: on_verification: link and code
  NL-->>A: waiting_for_approval, userCode, verifyUrl, expiresAt
  A-->>U: 200 NousLogin
  par the child polls the portal
    C->>NP: poll the token endpoint
    NP-->>C: tokens once the user approves
    C->>V: save provider state, shared store, credential pool,<br/>each under Hermes's file lock, files 0600
  and the web polls every 2 s
    U->>A: GET /api/providers/nous/login
    A->>NL: GET /login
    NL-->>A: waiting_for_approval, then connected
  end
  Note over PX,V: nous-proxy re-reads the auth store on every request,<br/>so the new login serves model calls without a restart
```

The Nous status `GET /providers` reports, as built (`providers/views.ts`):

```mermaid
stateDiagram-v2
  direction LR
  [*] --> not_connected
  not_connected --> waiting_for_approval : POST login, device code issued
  connected --> waiting_for_approval : POST login again (Reconnect)
  relogin_required --> waiting_for_approval : POST login
  waiting_for_approval --> connected : approved and saved
  waiting_for_approval --> denied : declined in the portal
  waiting_for_approval --> expired : the code ran out
  waiting_for_approval --> needs_subscription : portal says subscription_required
  waiting_for_approval --> failed : portal unreachable or another error
  waiting_for_approval --> not_connected : DELETE login kills the child
  denied --> waiting_for_approval : POST login
  expired --> waiting_for_approval : POST login
  needs_subscription --> waiting_for_approval : POST login
  failed --> waiting_for_approval : POST login
  connected --> not_connected : POST logout
  connected --> relogin_required : Hermes quarantined the login after a failed refresh
```

The status is worked out in this order: in host mode `host` or `host_unreachable`; `unavailable` when nous-login failed its startup check or cannot be reached; `waiting_for_approval` while a device login is pending, even over a working login; `connected` when the volume holds a working login; an ended device login (`expired`, `denied`, `needs_subscription`, `failed`) while the volume holds none; otherwise the volume's own `not_connected` or `relogin_required`. A pending Reconnect therefore never pauses runs on a login that still works.

| Provider                                        | Status `GET /providers` reports                                                                                                                                                         | Ready for runs when                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `nous`                                          | `not_connected`, `waiting_for_approval`, `connected`, `relogin_required`, `expired`, `denied`, `needs_subscription`, `failed`, `unavailable`; in host mode `host` or `host_unreachable` | The volume holds a working login (`connected`), or in host mode the host forward answers (`host`)    |
| `nous-api`, `openrouter`, `openai`, `anthropic` | `configured` or `missing`                                                                                                                                                               | The route's key variable is among the egress env names (the worker's guard asks its own egress live) |
| `custom`                                        | `configured` (listed only when a configuration's latest version uses it)                                                                                                                | Always: its key is optional, and its base URL is on the configuration                                |

**Host mode.** With `NOUS_HOST_PROXY` set, egress forwards Nous model calls to `hermes proxy start` on the host. Its admin `/health` answers `hostProxy {target, reachable, checkedAt}`, from a TCP connect with a 1 s timeout cached for 5 s. The worker writes that to `workers.host_proxy` on start and every heartbeat. `GET /providers` then reports `host` or `host_unreachable` with `hostCommand: hermes proxy start --provider nous`, does not ask nous-login, and Connect answers 409.

**Startup check.** nous-login checks with `inspect.signature` that `_nous_device_code_login`, `_save_active_provider_state`, `_write_shared_nous_state`, `_sync_nous_pool_from_auth_store`, `get_nous_auth_status_local` and `logout_command` exist with the parameters it calls them with. If one is missing or changed, every login route answers 503 `{state: 'unavailable', reason}` and `/status` reports `unavailable`. No token appears in a response or a log: the child's stdout and stderr go to `/dev/null`, and the request log has the method, path and status only.

### 3.10 Live updates

```mermaid
sequenceDiagram
  autonumber
  participant W1 as browser tab 1
  participant W2 as browser tab 2
  participant A as API: ExperimentEventsHub
  participant DB as Postgres
  participant S as API: SystemEventsHub

  W1->>A: GET /api/experiments/ID/events
  A->>DB: does the experiment exist? under 64 streams?
  A-->>W1: 404 or 503 as JSON, or open the stream with a first comment
  A->>DB: full state
  A-->>W1: event experiment, then event counts
  W2->>A: GET /api/experiments/ID/events, joins the same poller
  loop every 1 s while anyone watches ID
    A->>DB: version: results_revision, status, pause_reason, failure
    alt the version moved
      A->>DB: runs, attempts, primary scores, spend
      A->>A: diff against the last state
      A-->>W1: run events, feed events, counts, experiment last
      A-->>W2: the same events
    end
  end
  Note over A,W2: A keepalive comment every 15 s. A client that stops reading<br/>is dropped past 1 MiB unsent. The poller stops with its last subscriber.
  W1->>S: GET /api/system/events
  S-->>W1: event summary at once (at most one period old)
  loop every 5 s while any stream is open
    S->>DB: SystemService.summary()
    S-->>W1: event summary
  end
```

Every event is parsed with its shared schema (`ExperimentEventSchema`, `SystemEventSchema`) before it is written, and one that does not parse is logged and dropped. The wire format is `event: <type>` and `data: <the whole event as JSON>`. The run inspector and the experiment list poll instead (E6): `GET /runs/:id/events?after=` and `GET /experiments`.

### 3.11 What one attempt leaves behind

```mermaid
flowchart TD
  subgraph TV["trials volume: trials/ATTEMPT"]
    HOME["home/<br/>task.txt, config.yaml, skills/, .no-bundled-skills,<br/>Hermes's own state and logs/errors.log"]
    WSP["workspace/<br/>fixtures, docs/, what the agent wrote"]
    ERR["stderr.log<br/>outside the trial's view"]
  end
  subgraph DBR["Postgres"]
    AT["attempts row: launch_record (before the container),<br/>sandbox_id and host, status, category, exit code,<br/>final_text, session_id, tokens, cost_usd,<br/>stderr_tail (40 lines, redacted), redactions"]
    EVT["run_events: seq 1, 2, ... gap-free.<br/>Hermes events (system, text, tool_use, tool_result, result),<br/>platform started, noise and unmapped while it runs,<br/>then network, killed, cancelled, collected at the finish"]
    ART["artifacts: path, origin, size, sha256 or skipped_reason"]
  end
  BS[("blob store: DATA_DIR/blobs/sha256")]

  HOME -- "read errors.log, then deleted when the attempt finishes" --> GONE["deleted"]
  WSP -- "walked after the container is removed" --> ART
  WSP -- "new content" --> BS
  WSP -- "kept TRIAL_RETENTION_DAYS (7)" --> KEPT["deleted by recovery's retention step"]
  ERR -- "last 40 lines" --> AT
  ERR -- "kept with the workspace" --> KEPT
```

- **Launch record**: argv with the token as `<attempt-token>`, the container environment by name only, `config.yaml` with each `${NAME}` shown as `<from env NAME>`, the inputs with their hashes, the Hermes version and revision, the slot network, and the `container` block (name, image, user, read-only root, limits, mounts, disk cap, stop grace, deadline, env names). It is written before the container is created.
- **Final platform events**, in order: one `network` event per egress log entry (`background: true` for Hermes's own credits-seed call on the `nous` route); `killed` (deadline, disk, output or OOM, with signal, exit code and timing); `cancelled`; a synthesised `result` for a timeout with no Hermes result; and `collected` (files, stored bytes, too large, over budget, not collected, deleted inputs, `stderr_lines`, and `token_check` comparing Hermes's tokens with egress's count).
- **Artifact origins**: `fixture_unchanged`, `fixture_modified`, `document_unchanged`, `document_modified` or `agent`. A file over 25 MB is `too_large`, and one past the attempt's 512 MiB budget is `over_budget`; both have no content. Links are listed with their target text only; FIFOs, sockets and devices are never opened.
- **A lost attempt** (worker_lost) has no tokens, cost or duration and no collected workspace: the database lets a revoked attempt change only its status, finish time, category, message, exit code and stderr tail. Recovery deletes its home.

---

## 4. Endpoints

Everything is under `/api`, and the Phase 1 rules hold for every route: errors have the body `{ statusCode, message, issues? }`; a body or query that fails its zod schema answers 400 `Validation failed` with `issues`; a POST, PUT, PATCH or DELETE needs `X-Requested-With` and a JSON or multipart `Content-Type` (send `-d '{}'` for a bodiless POST); and the Host allowlist runs before routing. Swagger at `http://localhost:3000/api/docs` documents every route below by a named component built from the shared zod schema, and the SSE routes as `text/event-stream`. Every response is parsed with its shared schema before it is sent, and the tests parse it again. `document.spec.ts` lists all 64 routes and contains no re-score route.

### 4.1 New experiment and launch

| Method and path                   | Purpose                                                                                                                                                                                                                                                                                                                                                         | Request                                                                                                                                                                                                                                                                                                                                                                                                                              | Response                                                           | Errors                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /experiments/new-options`    | What the New experiment form offers: suites at their current version with every task and why an invalid one is invalid; configurations at their latest version with `configHash` and a per-run estimate for each suite; defaults (repetitions 5, concurrency up to 3); `maxConcurrency` (the proven workers' slots, at most 16); `workerCount`; the price table | none                                                                                                                                                                                                                                                                                                                                                                                                                                 | `NewExperimentOptions`                                             | none                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /experiments/estimate`       | Runs, waves, duration and cost of a matrix. Medians over past executed attempts on the same suite directory and config hash; without history a quarter of the budget and 15,000 tokens (`basis: 'budget'`). `costUsd` is null when any chosen model is unpriced. `pastRuns` is the fewest among the chosen configurations.                                      | query `EstimateQuerySchema`: `suite`, `versions` (comma list), `tasks`, `repetitions` 1 to 20, `concurrency` 1 to 16, optional `budget` 30 to 3600 (the override)                                                                                                                                                                                                                                                                    | `ExperimentEstimateView`                                           | 400 bad query; 404 unknown suite or version                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /experiments`               | Launch (section 3.3)                                                                                                                                                                                                                                                                                                                                            | `LaunchExperimentInput`: `name` (1 to 120), `description` (a string, may be empty, at most 2,000), `suiteId`, `taskKeys` (at least 1, unique), `baselineVersionId`, `candidateVersionIds` (at least 1, unique, not the baseline), `repetitions` 1 to 20, `concurrency` 1 to 16, `spendCeilingUsd` (null or 0.01 to 10,000), `timeBudgetOverrideS` (null or 30 to 3600), `expectedConfigHashes` (exactly the baseline and candidates) | 201 `LaunchExperimentResult` `{ id }`                              | 400 with issues for an unknown suite, task, invalid task or version; 409 "No worker is connected…", "No connected worker has proven sandbox isolation…", "The connected workers run different Hermes revisions…", a provider's readiness reason (several joined with `; `), "configuration NAME changed since you opened this form (now vN)"; 500 when the price table cannot be used; 503 when the queue is down |
| `POST /experiments/:id/duplicate` | A prefilled New experiment form on the suite's current version, with each configuration at its latest version, and the tasks that changed, were removed or became invalid; nothing is stored                                                                                                                                                                    | none (send `{}`)                                                                                                                                                                                                                                                                                                                                                                                                                     | 200 `NewExperimentDraft` `{ sourceExperimentId, values, changes }` | 404                                                                                                                                                                                                                                                                                                                                                                                                               |

### 4.2 Experiments: reads and controls

| Method and path                      | Purpose                                                                                                                                                                                                                                                                                                                                             | Request                                                          | Response                                                                              | Errors                                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /experiments`                   | One row per experiment, newest first: status, pause reason, `statusReason` in words, suite, baseline and candidates, counts by run status, `doneRuns`, `costUsd`; `verdicts` is `[]` until Phase 4                                                                                                                                                  | none                                                             | `ExperimentListRow[]`                                                                 | none                                                                                                                                                                                                         |
| `GET /experiments/:id`               | The Overview: frozen snapshot (suite with `newerVersion`, configurations and their differences, Hermes), counts, spend (`spentUsd`, ceiling, projected, `unpricedAttempts`), progress and provisional pass rate per configuration, the feed of the last 10 finished runs, aggregates, the failure view, worker presence, elapsed and remaining time | none                                                             | `ExperimentDetail`                                                                    | 404 "Experiment ID does not exist."                                                                                                                                                                          |
| `GET /experiments/:id/events`        | SSE (section 3.10): `experiment` then `counts` on connect, then per change `run`, `feed`, `counts` and `experiment` events                                                                                                                                                                                                                          | none                                                             | `text/event-stream` of `ExperimentEvent`                                              | 404 and 503 (past 64 streams) as JSON, before the stream opens                                                                                                                                               |
| `POST /experiments/:id/pause`        | User pause                                                                                                                                                                                                                                                                                                                                          | none (send `{}`)                                                 | 200 `ExperimentActionResult` `{ id, status }`; a paused experiment answers as a no-op | 404; 409 when not running, or cancelled and draining                                                                                                                                                         |
| `POST /experiments/:id/resume`       | Resume and re-send the queued runs                                                                                                                                                                                                                                                                                                                  | optional `ResumeExperimentInput` `{ spendCeilingUsd? }` (strict) | 200 `{ id, status: running or completed }`; a running experiment answers as a no-op   | 404; 409 not paused, no connected worker on the frozen Hermes revision, a provider not ready, "raise the spend ceiling above $X to resume", "the experiment changed while this was being checked; try again" |
| `POST /experiments/:id/cancel`       | Cancel (section 3.7)                                                                                                                                                                                                                                                                                                                                | none (send `{}`)                                                 | 200 `{ id, status: running or completed }`; `running` while in-flight runs drain      | 404; 409 "the experiment is already completed"                                                                                                                                                               |
| `POST /experiments/:id/retry-failed` | Reopen an experiment the circuit breaker failed                                                                                                                                                                                                                                                                                                     | none (send `{}`)                                                 | 200 `{ id, status }`                                                                  | 404; 409 not failed, no worker on the frozen revision, a provider not ready                                                                                                                                  |

### 4.3 Runs

| Method and path                               | Purpose                                                                                                                                                                                                                                                                    | Request                                                                                                                                                                                                      | Response                                                                                | Errors                                                                                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /experiments/:id/runs`                   | The Runs tab: every row (no paging in Phase 2, so `matched` equals the row count), filtered and sorted, with the count line over the whole experiment. Duration, tokens and cost come from the current attempt once it has ended.                                          | query `RunListQuerySchema`: `config` (name or version id, `all`), `task` (`all`), `status`, `score_status`, `exec_error` and `ungradable` (`true`/`1`, `false`/`0`), `sort` (a `RUN_SORT_KEYS` value), `dir` | `RunListResult` `{ rows, matched, summary }`                                            | 400; 404                                                                                                                                                                                            |
| `POST /experiments/:id/runs/retry`            | Bulk retry: each run that can be retried is, the others are listed with their reason                                                                                                                                                                                       | `BulkRunActionInput` `{ runIds }` (1 to 500, unique, strict)                                                                                                                                                 | 200 `BulkRunActionResult` `{ action: 'retry', enqueued, refused: [{ runId, reason }] }` | 400; 404 unknown experiment. A run of another experiment is refused with "run not found in this experiment".                                                                                        |
| `GET /runs/:id`                               | The inspector: header, attempts (the scored one marked), limits, execution error with the stderr tail, outcome and score rows, the timeline, the final response with its extraction range, artifacts with CSV previews, the launch record, the counterpart and model needs | none                                                                                                                                                                                                         | `RunDetail`; `launchRecord` is null before the first attempt                            | 404                                                                                                                                                                                                 |
| `GET /runs/:id/events?after=`                 | Timeline rows built from events after `after`, at most 2,000 events a page. A tool row whose result or refusal arrived since is sent again with the same seq; replace rows by seq. `lastSeq` carries on across pages.                                                      | query `after` (integer, default 0)                                                                                                                                                                           | `RunEventsPage` `{ events, lastSeq, live }`                                             | 400; 404                                                                                                                                                                                            |
| `GET /runs/:id/artifacts/:artifactId/content` | The stored bytes, as an attachment, with `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`; html and svg are sent as `application/octet-stream`                                                                                                         | none                                                                                                                                                                                                         | the file                                                                                | 404 for another run's artifact, an unknown one or one stored without content; 500 when the blob is missing                                                                                          |
| `GET /runs/:id/artifacts/:artifactId/preview` | The first rows of a CSV or TSV artifact                                                                                                                                                                                                                                    | none                                                                                                                                                                                                         | `TablePreview`, or the JSON literal `null`                                              | 404                                                                                                                                                                                                 |
| `POST /runs/:id/retry`                        | Queue an `execution_error` run for its next attempt                                                                                                                                                                                                                        | none (send `{}`)                                                                                                                                                                                             | 200 `RunActionResult` `{ runId, status: 'queued', attempt: n+1 }`                       | 404; 409 "run is X, not execution_error", "run already has 5 attempts", "the experiment was cancelled", "the experiment failed; use Retry failed runs to reopen it", "Retry needs PROVIDER: reason" |
| `POST /runs/:id/cancel`                       | Cancel a queued run, or ask the worker to stop a running one                                                                                                                                                                                                               | none (send `{}`)                                                                                                                                                                                             | 200 `{ runId, status: cancelled or running, attempt: null }`                            | 404; 409 for any other status                                                                                                                                                                       |

The plan's `GET /runs/:id/artifacts` and `GET /runs/:id/counterpart?version=` are not separate routes: both are fields of `RunDetail`. Re-score routes are Phase 3.

### 4.4 Model access and system

| Method and path                | Purpose                                                                                                                                                                                            | Request          | Response                                                                       | Errors                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `GET /providers`               | Every provider: how it authenticates, its status (section 3.9), the env variable, the apply and host commands, the billing URL, which configurations use it and how many experiments it has paused | none             | `ProviderInfo[]`                                                               | none                                                                                                            |
| `POST /providers/nous/login`   | Start a device login, replacing a pending one; answers once the portal has issued a code, or once the login has ended                                                                              | none (send `{}`) | 200 `NousLogin` `{ state, userCode, verifyUrl, expiresAt, error, billingUrl }` | 409 in host mode; 503 when nous-login is unavailable or unreachable; 502 when it answers in an unexpected shape |
| `GET /providers/nous/login`    | The current login; the UI polls it every 2 s                                                                                                                                                       | none             | 200 `NousLogin`; `not_connected` when nous-login is unavailable                | none                                                                                                            |
| `DELETE /providers/nous/login` | Cancel a pending login                                                                                                                                                                             | none             | 200 `NousLogin`                                                                | 503; 502                                                                                                        |
| `POST /providers/nous/logout`  | Disconnect, as `hermes logout --provider nous` does                                                                                                                                                | none (send `{}`) | 200 `NousLogin`                                                                | 503; 502                                                                                                        |
| `GET /system/events`           | SSE: `summary` on connect and every 5 s                                                                                                                                                            | none             | `text/event-stream` of `SystemEvent`                                           | 503 past 64 streams                                                                                             |

**Changed in Phase 2**: `POST /resources/mcp-servers/:id/test` and `POST /resources/mcp-servers/test` now test an http server through the MCP gateway (section 3.8). A missing header variable fails at once with "VENDOR_API_TOKEN is not set in the egress environment." and `missingSecretNames`.

nous-login's own routes, on `provider-admin` only: `GET /health` (`{ok, state: 'ready' | 'unavailable'}`), `GET /status`, `POST /login`, `GET /login`, `DELETE /login`, `POST /logout`. Egress's admin socket gains `GET /health` with `hostProxy`, and its registration (`PUT /attempts/<id>`) gains `upstream: {baseUrl}` for `custom` and `mcp: [{name, url, headers}]`.

---

## 5. What changed

The working tree is compared with commit `187bdff` (Phase 1). This section lists what Phase 2 added or changed. The design work for Phase 5b that sits in the same tree (`IMPLEMENTATION_PLAN.md` 4.6, the `suite_drafts` tables, the draft routes in section 11) is not part of this phase and is not described here.

### 5.1 Files, by area

**`packages/shared`**

| Added                                                      | Purpose                                                                                                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/contracts/experiments.ts`                             | The experiment list row, detail and Overview, the controls' results and `ResumeExperimentInputSchema`, `PauseReasonSchema`, `RunCountsSchema`, `VERDICT_STATES` |
| `src/contracts/new-experiment.ts`                          | New experiment options, the estimate query and view, `LaunchExperimentInputSchema`, the Duplicate draft                                                         |
| `src/contracts/runs.ts`                                    | The Runs tab rows, `RunListQuerySchema`, run actions, `BulkRunActionInputSchema`                                                                                |
| `src/contracts/run-detail.ts`                              | The run inspector, the timeline event, `RunEventsPageSchema`, `RunEventsQuerySchema`                                                                            |
| `src/contracts/providers.ts`                               | `ProviderInfoSchema`, `NousLoginSchema`, `NOUS_STATUSES` (with `unavailable`), moved from the web                                                               |
| `src/contracts/events.ts`                                  | The SSE events: `SystemEventSchema`, `ExperimentEventSchema` (`run`, `counts`, `experiment`, `feed`)                                                            |
| `src/contracts/comparison.ts`                              | The comparison view, for Phase 4                                                                                                                                |
| `test/{events,experiments,providers,records,runs}.spec.ts` | Fixture shapes and the bad variants of every request schema                                                                                                     |

Modified: `src/status.ts` (`PAUSE_REASONS` gains `provider_disconnected`), `src/vocab.ts` (subtype `network`, `NETWORK_EVENT_KINDS`, `NETWORK_DECISIONS`, `ARTIFACT_SKIP_REASONS` gains `over_budget`), `src/records.ts` (`NetworkEventPayloadSchema`, `PlatformEventPayloadSchema`, `LaunchContainerRecordSchema`, and `network` and `container` on `LaunchRecordSchema`, read leniently), `src/env-names.ts` (`HERMES_EVALS_ATTEMPT_TOKEN`, `CUSTOM_API_KEY` and the five new settings are reserved), `src/contracts/resources.ts` (`MCP_ROUTE_LIMITS`, `mcpRouteProblems`: an MCP definition egress would refuse is refused on save), `src/contracts/common.ts` (shared numeric building blocks), `src/contracts/{index,system}.ts`.

**`apps/api`, new code**

| Directory                                                                                          | What it holds                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/execution/`                                                                                   | The seams and rules every part shares: `contracts.ts` (`AttemptPlan`, `AttemptSink`, `AttemptRunner`, `AttemptOutcome`, `LeaseLostError`, `WorkerShutdownError`), `providers-map.ts` (the provider routes, section 2.2), `stream-json.ts` (one stdout line to one stored event, MCP tool names), `pricing.ts` (`loadPriceTable`, `attemptCost`), `budget.ts` (`effectiveBudgetS`), `slots.ts` (`SlotPool`) |
| `src/execution/attempt/`                                                                           | `TrialAttemptRunner`: `secrets.ts`, `materialise.ts`, `trial-config.ts` (config.yaml, shared with the development harness), `launch.ts` (argv, environment, container spec, launch record), `trial-session.ts`, `event-batcher.ts`, `stderr-capture.ts`, `redaction.ts`, `classify.ts`, `mcp-start.ts`, `collect.ts`, `network-events.ts`, `final-events.ts`, `settings.ts`                                |
| `src/execution/lifecycle/`                                                                         | `startExecutionLifecycle` and the execute-run handler: `claim.ts`, `plan.ts`, `sink.ts`, `fence.ts`, `finish.ts`, `first-line.ts`, `leases.ts`, `recovery.ts`, `finalise-lost.ts`, `recovery-disk.ts`, `recovery-lock.ts`, `queue.ts`, `types.ts`, `lifecycle.ts`                                                                                                                                          |
| `src/experiments/`                                                                                 | `reconcile.ts`; `commands/` (launch, new options, controls, duplicate, the provider gate, live workers, jobs); `estimates/`; `views/` (list and detail builders, money, progress, failure, snapshot, timing); `sse/` (the events hub, the live source and its diff, `SseConnection`); `experiments-read.controller.ts`, `experiment-views.module.ts`                                                       |
| `src/runs/`                                                                                        | `commands/` (retry, cancel, bulk retry); `views/` (the Runs tab, the inspector, the timeline and its paging, outcome and error views, the final response, artifacts, the launch record view)                                                                                                                                                                                                               |
| `src/providers/`                                                                                   | `nous-login.client.ts`, `readiness.ts`, `views.ts`, `providers.service.ts`, `providers.controller.ts`, `nous-login.module.ts` (global), `providers.module.ts`                                                                                                                                                                                                                                              |
| `src/evaluation/`                                                                                  | `evaluate-run.handler.ts`, `claim.ts`, `evidence.ts`, `context.ts`, `score.ts`, `publish.ts`, `workspace.ts`, `dead-letter.ts`, `job.ts`                                                                                                                                                                                                                                                                   |
| `src/system/events/`                                                                               | `GET /system/events`: hub, controller, module                                                                                                                                                                                                                                                                                                                                                              |
| `src/database/schema/worker-host-proxy.ts`                                                         | `WorkerHostProxySchema` for `workers.host_proxy`                                                                                                                                                                                                                                                                                                                                                           |
| `drizzle/0004_phase2_execution.sql`, `drizzle/0005_phase2_review.sql` and their snapshots          | The migrations (section 3.2)                                                                                                                                                                                                                                                                                                                                                                               |
| `test/phase2.e2e-spec.ts`, `test/support/{fake-engine,fake-trials,phase2-app,require-database}.ts` | The full-application e2e and its harness: `FakeEngine` (scripted in-process containers whose create bodies pass docker-guard's real policy), `FakeEgress`, the canned stream-json, and a global setup that refuses to run without `TEST_DATABASE_URL` or on port 5432                                                                                                                                      |
| `test/fake-portal/{fake_portal.py,nous-login.docker.spec.ts}`                                      | A fake Nous Portal and the gated test of nous-login in the real trial image                                                                                                                                                                                                                                                                                                                                |

**`apps/api`, modified**: `app.module.ts` (the six new modules; the commands before the views, so `GET /experiments/:id` does not swallow `new-options` and `estimate`), `worker.ts` (an unhandled rejection hands attempts back and exits non-zero, so the restart policy brings a clean process), `worker/worker.module.ts`, `worker/worker.service.ts` (start and stop order, section 3.1), `worker/presence/worker-presence.service.ts` (`host_proxy`, the image revision check, keeping the last egress names when a heartbeat cannot reach egress), `worker/handlers/{test-mcp-server,mcp-test-container}.ts` (the http test through the gateway; `HTTP_TEST_UNAVAILABLE` removed), `resources/mcp/hermes-config.ts` (http entries carry the bearer reference), `sandbox/egress-client.ts` (`healthReport`, `remove` parsed with zod, `newAttemptToken` as 64 hex characters), `sandbox/trial-files.ts` (`restoreOwnerAccess`, `MAX_COLLECTED_BYTES`, the watchdog's unreadable-directory rule), `sandbox/trial-runner.ts` (`forceRemoveTree`, a line cap, `outputStop`), `sandbox/hermes-smoke.ts` (uses the shared config builder), `sandbox/lifecycle-test.ts` (a new check: a trial cannot make its directories undeletable), `config/env.ts`, `database/database.service.ts` (an idle client's error is logged, not fatal), `database/schema/{experiments,workers}.ts`, `openapi/{decorators,schemas,document.spec}.ts` (every Phase 2 schema registered, `ApiEventStream`), `vitest.config.e2e.ts` (4 files at a time), `test/phase1.e2e-spec.ts` (the http MCP test's new answer).

**`apps/egress`**: `src/mcp-gateway.ts` and `src/host-probe.ts` (new); `src/registry.ts` (strict registration with `upstream` and `mcp`, in-flight counters for MCP and model calls, expired registrations dropped after 10 minutes), `src/gateway.ts` (the MCP gateway on the same port, the `custom` upstream, per-call tokens in the log, the memory caps), `src/admin.ts` (`hostProxy` in `/health`), `src/main.ts`, and `src/mock-model.ts` (`MOCK_SCRIPTS`, importable, `script` in `/__requests`). Tests: `test/{mcp-gateway,host-probe,mock-model,registration}.spec.ts` (new), `test/{policy,servers}.spec.ts`.

**`apps/web`**, contracts only: `src/api/types/{experiments,runs,system}.ts` re-export the shared schemas' types; `src/fixtures/experiments.ts` imports `PauseReason`; `src/api/__tests__/contracts.spec.ts` parses every experiments, runs and providers answer in every fixture scenario; the new `wire.spec.ts` checks that what the data layer sends in live mode parses with the shared request schemas.

**`docker/`**: `nous-login.py` (new), `trial.Dockerfile` (copies it to `/opt/nous-login/`, root-owned, 0644).

**Repository root**: `config/prices.yaml` (new), `scripts/phase2-smoke.sh` and `scripts/phase2-mock-scripts.json` (new), `scripts/phase1-smoke.sh` (the http Test start now fails through the gateway), `docker-compose.yml`, `.env.example`, `README.md`, `turbo.json` (a `test:e2e` task), `IMPLEMENTATION_PLAN.md` (7.1 the budget rule, 7.3 the spend guard's tokens, 8.4 MCP start failures, 8.6 recovery removes the attempt from egress).

### 5.2 Migrations

`0004_phase2_execution` and `0005_phase2_review` (section 3.2). Both run at boot in the API and the worker. The live Compose database applied both: 6 of 6 migrations.

### 5.3 New environment variables

| Variable                           | Default                                                    | Read by         | Meaning                                                                        |
| ---------------------------------- | ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------ |
| `MAX_CONSECUTIVE_EXECUTION_ERRORS` | 14 (1 to 1000)                                             | worker          | The circuit breaker's threshold                                                |
| `TRIAL_RETENTION_DAYS`             | 7 (0 to 365)                                               | worker          | Days a finished attempt's workspace and `stderr.log` stay in the trials volume |
| `RECOVERY_INTERVAL_MS`             | 15000 (1000 to 600000)                                     | worker          | Time between recovery passes                                                   |
| `LEASE_SECONDS`                    | 60 (30 to 600)                                             | worker          | An attempt's lease, renewed every 10 s                                         |
| `NOUS_LOGIN_URL`                   | `http://nous-login:8650`                                   | api, worker     | The nous-login service, over `provider-admin`                                  |
| `PRICES_FILE`                      | `./config/prices.yaml`; Compose sets `/config/prices.yaml` | api             | The price table a launch freezes (existed; now mounted)                        |
| `CUSTOM_API_KEY`                   | unset                                                      | egress          | The optional key egress sends to a `custom` configuration's base URL           |
| `MOCK_SCRIPTS`                     | empty                                                      | mock-model      | Per-phrase scripts beside `MOCK_STEPS`, as JSON `[{match, steps}]`             |
| `HERMES_EVALS_ATTEMPT_TOKEN`       | set per trial                                              | trial container | The attempt token, for the MCP gateway's bearer reference; never set by hand   |

`HERMES_PORTAL_BASE_URL` and `NOUS_PORTAL_BASE_URL` exist only to point tests at the fake portal and must never be set for the stack. Every new setting is reserved in `WORKER_SETTING_ENV_NAMES`, so an MCP definition cannot name it.

### 5.4 Compose

- **New service `nous-login`**: the trial image, entrypoint `python /opt/nous-login/nous-login.py`, `HOME` and `HERMES_HOME` at `/opt/data` on `nous-home`, read-only root, tmpfs `/tmp`, all capabilities dropped, no new privileges, networks `edge` and `provider-admin`, a `--health` healthcheck.
- **`nous-proxy`** no longer has `profiles: [nous]`: it starts by default, in a retry loop, and depends on `trial-image`.
- **New internal network `provider-admin`** for api, worker and nous-login.
- **api**: `PRICES_FILE` and `./config` mounted read-only at `/config`; `NOUS_LOGIN_URL`; `restart: unless-stopped`.
- **worker**: `NOUS_LOGIN_URL`; `stop_grace_period: 90s` (was 30 s), enough for the hand-back and the last recovery pass; `restart: unless-stopped`; a comment on disjoint `TRIAL_SLOTS`.
- **egress**: `MODEL_UPSTREAMS` gains `nous-api`, `openai` and `anthropic` (in step with `PROVIDER_ROUTES`, and never `custom`); `mem_limit: 1g`.
- **postgres**: `restart: unless-stopped`.
- **mock-model** (profile `test`, unchanged otherwise): `MOCK_SCRIPTS: ${MOCK_SCRIPTS:-}`.

### 5.5 Trial image

`docker/trial.Dockerfile` copies `docker/nous-login.py` to `/opt/nous-login/nous-login.py`, root-owned, mode 0644 in a 0755 directory, outside `/opt/data` and `/workspace`. The pinned base digest, `USER 10000:10000`, the entrypoint and the tag `hermes-evals/trial:v0.22.4-4d04303` are unchanged. The image must be rebuilt (`docker compose build trial-image`) for nous-login to start.

### 5.6 Dependencies

None added or upgraded. No `package.json` or `pnpm-lock.yaml` changed. nous-login and the fake portal use only the Python standard library inside the existing image.

---

## 6. How to test it

### 6.1 Automated

Run these from the repository root after `pnpm install`. The other packages consume `packages/shared` through its built `dist`, so build it first, or use the turbo commands, which build it for you. The api tests need python3 (verifier self-checks and the evaluation run it).

| Suite                            | Command                                                                                                        | What it covers                                                                                                                                                                     | Observed on 25 Oct 2026                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Everything                       | `pnpm turbo run typecheck lint test build --force`                                                             | Typecheck, oxlint, unit and PGlite tests, and build, for all five packages                                                                                                         | 20 of 20 tasks, 0 cached, 3 min 9 s                    |
| shared                           | `pnpm --filter @hermes-evals/shared test`                                                                      | Every contract against the web fixtures' shapes, the bad variants of every request schema, the network payload, the launch record                                                  | 8 files, 57 passed                                     |
| api: unit and PGlite integration | `pnpm --filter @hermes-evals/api test`                                                                         | See below                                                                                                                                                                          | 129 files (1 skipped), 1,182 passed, 15 skipped, 185 s |
| api: Postgres 17 e2e             | `TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e` | See below                                                                                                                                                                          | 16 files, 92 passed, 75 s; run twice, green both times |
| web                              | `pnpm --filter @hermes-evals/web test`                                                                         | `contracts.spec.ts` parses every experiments, runs and providers answer in every fixture scenario with its shared schema, and `wire.spec.ts` checks what the live data layer sends | 18 files, 314 passed                                   |
| egress                           | `pnpm --filter @hermes-evals/egress test`                                                                      | The MCP gateway, strict registration, the `custom` upstream, the host probe, the memory caps, allowlist mode refusing every CONNECT, the mock model's scripts                      | 8 files, 129 passed                                    |
| docker-guard                     | `pnpm --filter @hermes-evals/docker-guard test`                                                                | Unchanged in this phase                                                                                                                                                            | 2 files, 63 passed                                     |
| Real containers (gated)          | see below                                                                                                      | `hermes tools list`, the image inspect, MCP Test start for stdio and http in the trial image, and nous-login in the real trial image against the fake portal                       | 4 files, 38 passed, 39 s                               |

The 15 skipped api tests are the 14 gated real-container tests (10 of them in `nous-login.docker.spec.ts`) and one that runs only on Linux (`trial-files.spec.ts`).

**What the api unit and PGlite suite adds in Phase 2.** PGlite runs the real migrations and triggers in-process (`test/support/database.ts`).

- Execution seams: `stream-json` against recorded Hermes `4d04303` lines (noise, unmapped, forged `platform` lines, tokens), the provider routes, MCP tool names byte-identical to Hermes's, pricing with cached tokens and unpriced models.
- The runner, with `FakeEngine` and `FakeEgress`: secrets by name and their refusals, materialisation (links refused, hashes re-checked), `config.yaml`, the launch record with no secret value, the egress registration, batching and gap-free numbering, redaction, every row of the classification table, MCP start failures from `errors.log`, the collection budget, event caps, locked trees.
- The lifecycle on PGlite: every claim guard, each finish outcome with the breaker and the automatic retry, leases and the cancel watcher, every recovery step, reconcile, slots.
- Commands: launch (each 400 and 409), options, estimates, controls, run commands.
- Views: the experiment list and detail on seeded experiments in every state (running, paused for each reason, failed by the breaker, completed, cancelled, cancelling) with a hand-checked matrix; both SSE hubs with fake timers and over real HTTP; the Runs tab's filters and sorts; the inspector, the timeline and its paging; artifacts.
- Providers: readiness rules, the rows, the nous-login client, the routes and the `X-Requested-With` rule.
- Evaluation: claim, score, publish and the dead letter, with the real reconcile.
- Migrations `0004` and `0005` upgrading a database that already holds rows, and the OpenAPI document (64 routes, no re-score route).

**What the Postgres 17 e2e covers.** Each spec creates and drops its own database. The config refuses to start without `TEST_DATABASE_URL` or when it points at port 5432 (the Compose database).

| File                                                 | Tests | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/phase2.e2e-spec.ts`                            | 20    | The real `AppModule` and `WorkerModule`, real pg-boss, the real lifecycle, runner and evaluation; only the sandbox is replaced by `FakeEngine` and `FakeEgress`, and every create body still passes docker-guard's policy. The 3 × 2 × 2 experiment launched over HTTP and run to `scored` (the baseline gets one task wrong, the candidate with a skill and a stdio MCP server gets it right); SSE `run` and `counts` events; gap-free events, artifact origins, launch records with no token and no stdio value; the list, detail, Runs tab, inspector, artifact and events page. Then, each in its own experiment: pause and resume, cancel, retry alone and in bulk, the circuit breaker, the spend guard, the provider guard, the launch 409s, a graceful worker stop mid-run, a stop whose last pass could not run (recovered by the next start), a worker whose self-test failed starting no trial, and nothing left behind (containers, egress registrations, trial homes). |
| `src/execution/lifecycle/lifecycle.e2e-spec.ts`      | 14    | One of two workers claims a run delivered to both; concurrency 1 holds across three workers; a lost lease writes nothing more and recovery requeues; a live worker's lease is never revoked; cancel through the watcher; two last runs finishing at once complete the experiment once; the spend guard; the breaker; the provider guard; deferral past concurrency and without a slot; the automatic timeout retry; shutdown hand-back; one recovery pass at a time; the evaluate-run job the finish sends.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/experiments/commands/launch.e2e-spec.ts`        | 5     | An observer never sees runs without their jobs (200 runs); a failed job insert leaves nothing; a launch against an in-place edit, an edit that makes v2, and an edit that arrives during the launch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/experiments/commands/controls.e2e-spec.ts`      | 4     | All 24 orders of pause, resume, cancel and a worker finishing; a burst of resumes and pauses leaves one job per queued run; cancel racing the last finish completes once; a run retry racing cancel leaves no job.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/evaluation/evaluation.e2e-spec.ts`              | 4     | Racing deliveries publish each evaluation once; a job sent again after publishing changes nothing; an expired claim's publish is refused; a first evaluation that keeps failing is dead-lettered with error scores.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/experiments/views/experiment-views.e2e-spec.ts` | 1     | The hand-checked figures through node-postgres, and the stream agrees.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Phase 1 files                                        | 44    | Unchanged except `phase1.e2e-spec.ts`, whose http MCP test now expects the gateway's answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Start the throwaway Postgres 17 once (the README has the same line). Each full-application world holds about 40 connections, so if more such specs are added, start it with `-c max_connections=200`.

```bash
docker run -d --name hermes-evals-pg-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:55433:5432 postgres:17-alpine
```

**Gated real-container tests.** These need the trial image (`docker compose up --build` builds it), a docker-guard socket, a directory that backs a trial volume, and, for nous-login, a Docker CLI that reaches the engine. The setup is the one in `docs/phases/phase-1.md` section 6.1; this is what was run for this document:

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
  src/sandbox/toolsets.spec.ts src/worker/presence/trial-image.spec.ts \
  src/worker/handlers/mcp-test-container.spec.ts test/fake-portal/nous-login.docker.spec.ts

# afterwards: stop the guard (Ctrl-C), then
docker volume rm hermes-evals-sandbox-test-trials && rm -rf "$D"
```

`nous-login.docker.spec.ts` talks to Docker directly, not through the guard, because it needs a network, published ports and `docker cp`. It covers the startup check passing, approve to connected (the auth store, shared store and credential pool written, files 0600, no secret in any response or log), logout, deny, expiry, `subscription_required`, cancel, a second login replacing the first, an unreachable portal, and the startup check with a function changed or missing. It mounts no volume (the home is a tmpfs) and never contacts Nous Portal. Afterwards no container, network, volume or trial directory was left.

### 6.2 On the running stack

The stack needs the images rebuilt for Phase 2 (`docker compose up --build -d`, which also rebuilds the trial image with `nous-login.py` and applies migrations `0004` and `0005`) and the mock model with the smoke scripts:

```bash
MOCK_SCRIPTS="$(python3 -c 'import json; print(json.dumps(json.load(open("scripts/phase2-mock-scripts.json"))))')" \
  docker compose --profile test up -d
docker compose ps        # api and nous-login healthy; worker, egress, docker-guard, nous-proxy, mock-model, web, postgres up
scripts/phase2-smoke.sh  # http://localhost:3000/api; BASE_URL=http://localhost:8080/api goes through nginx
```

Compose reads `MOCK_SCRIPTS` from the shell before `.env`, so no file changes. On a running stack only `mock-model` is created. Every configuration the script makes uses provider `custom` against `http://mock-model:8090/v1` with model `mock/scripted`, which `config/prices.yaml` prices at 0: no real provider is called and nothing costs money. It prints one PASS, FAIL or SKIP line per step (56 steps) and exits 0 only when nothing failed. It passed 56 of 56 for this document, in about 4 minutes. Everything it creates is named `smoke-<UTC timestamp>-…`; its suite directory `suites/zz-smoke-exec-<timestamp>` is removed at the end, which leaves the suite row `missing`. With `SMOKE_DOCKER=auto` (the default) it also reads, through `docker compose`, the raw rows, the containers, egress's registrations and the trial directories.

| Section                  | What the steps show (this run)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack                    | Health ok; isolation 15 of 15, `hermes-agent v0.22.4 @ 4d04303`; a worker online, concurrency 3, slots 0 of 4; `GET /providers` (here `nous host_unreachable`, because this machine's `.env` sets `NOUS_HOST_PROXY`, key providers `missing`, `custom configured`); the mock has the scripts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Suite                    | A temporary directory of four tasks loads as created v1, "All 4 self-checks passed": `total` (numeric_tolerance), `list` (json_match), `report` (file_check), `slow` (the mock sleeps 40 s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Skill and configurations | A skill whose text holds the phrase the mock answers; `baseline` and `with-skill`, both `custom` and `mock/scripted`; `new-options` (max concurrency 3, 1 worker, `mock/scripted 0/0`); the estimate (12 runs, 4 waves, 120 s, $0, basis `budget`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 3 × 2 × 2 experiment     | Launched, completed in 35 s with 12 of 12 scored; the SSE stream followed live (64 events: 2 experiment, 12 counts, 38 run, 12 feed); the baseline fails `total` and `with-skill` passes it, the rest pass; tokens on every run (7,961 to 12,720), cost 0; the detail's aggregates (pass 0.667 against 1); the list row; three Runs tab filters; two inspectors (outcome, a timeline of real Hermes tool calls and model calls, the extraction, the launch record with the token as a placeholder, the counterpart, events paging); `report.csv` collected as an `agent` artifact and downloaded byte for byte; 12 attempts with gap-free events including `network`; launch records with no secret value; no container or egress registration left; homes deleted, workspaces and `stderr.log` kept |
| Pause, then resume       | Two slow runs running; pause; the in-flight runs finish and 2 stay queued, and nothing starts in the next 15 s; resume; the experiment completes with 4 scored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Cancel                   | Two slow runs running; cancel; the trials are stopped and every run is cancelled; the inspector says "cancelled by experiment"; no container or registration left                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Cleanup                  | The suite directory removed and reloaded: `missing`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Afterwards stop the mock model again: `docker compose --profile test rm -sf mock-model`.

The smoke script does not cover the circuit breaker, Retry failed runs, the spend guard or a worker crash. The e2e covers all four. The live check ran each of them by hand on this stack; the walkthrough below repeats the worker crash and a retry.

### 6.3 By hand

The walkthrough uses curl and python3 against the stack of section 6.2, with the mock model running. Every POST sends the two headers the guard needs. The JSON is an excerpt of the real response from the run made for this document: `…` marks values and fields left out, and ids differ on every stack.

```bash
API=http://localhost:3000/api
J=(-H 'X-Requested-With: curl' -H 'Content-Type: application/json')    # bash or zsh array
pick() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
```

#### A. A suite the mock answers, a skill and two configurations

The smoke script's four tasks are reused. Their prompts contain the phrases `scripts/phase2-mock-scripts.json` matches, and the skill holds the phrase that makes the mock answer `total` correctly:

```bash
STAMP=$(date -u +%Y%m%d%H%M%S); NAME=zz-smoke-walk-$STAMP
sed -n '/^python3 - "$SUITE_DIR"/,/^PY$/{//!p;}' scripts/phase2-smoke.sh | python3 - "suites/$NAME" "$NAME"
SUITE=$(curl -s -X POST "$API/suites/reload" "${J[@]}" -d "{\"path\":\"$NAME\"}" | pick 'd["suites"][0]["suiteId"]')
# created v1: "All 4 self-checks passed"

python3 - "walk-$STAMP-due-method" <<'PY'
import sys, zipfile
name = sys.argv[1]
md = (f'---\nname: {name}\nversion: 1.0.0\ndescription: How to total the amounts that are still due.\n---\n\n'
      '# Due method\n\nsmoke-due-method: count only rows whose status is open. Paid rows are never due.\n')
with zipfile.ZipFile('due-method.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr(f'{name}/SKILL.md', md)
PY
TOKEN=$(curl -s -X POST "$API/resources/skills/validate" -H 'X-Requested-With: curl' \
  -F 'file=@due-method.zip;type=application/zip' | pick 'd["token"]')
SKILL=$(curl -s -X POST "$API/resources/skills" "${J[@]}" -d "{\"token\":\"$TOKEN\"}" | pick 'd["id"]')

cfg() { printf '{"name":"%s","model":"mock/scripted","provider":"custom","baseUrl":"http://mock-model:8090/v1","toolsets":["file","terminal"],"memoryEnabled":false,"skillIds":[%s],"documentIds":[],"mcpServerVersionIds":[%s],"maxTurns":10,"timeBudgetS":120,"duplicatedFromVersionId":null}' "$1" "$2" "$3"; }
BASE=$(curl -s -X POST "$API/configurations" "${J[@]}" -d "$(cfg walk-$STAMP-baseline '' '')" | pick 'd["versionId"]')
SKILLED=$(curl -s -X POST "$API/configurations" "${J[@]}" -d "$(cfg walk-$STAMP-with-skill "\"$SKILL\"" '')" | pick 'd["versionId"]')
```

#### B. Options, estimate and launch

```bash
curl -s "$API/experiments/new-options" > options.json
curl -s "$API/experiments/estimate?suite=$SUITE&versions=$BASE,$SKILLED&tasks=3&repetitions=2&concurrency=3" | python3 -m json.tool
```

```json
{
  "runs": 12,
  "waves": 4,
  "perRunSeconds": 30,
  "durationS": 120,
  "costUsd": 0,
  "perConfiguration": [
    { "versionId": "…", "name": "walk-20261025003749-baseline", "runs": 6, "costUsd": 0 },
    { "versionId": "…", "name": "walk-20261025003749-with-skill", "runs": 6, "costUsd": 0 }
  ],
  "basis": "budget",
  "pastRuns": 0
}
```

No past attempt shares these config hashes, so the estimate is a quarter of the 120 s budget per run. `new-options` lists the suite with its four tasks, each configuration with its `configHash`, `defaults: {repetitions: 5, concurrency: 3}`, `maxConcurrency: 3`, `workerCount: 1` and the price table (`mock/scripted`, 0 and 0, checked `2026-10-24`).

A small helper builds the launch body with the hashes the form would show:

```bash
export SUITE
launch() {  # name, task keys, repetitions, concurrency, baseline, candidate
  python3 - "$@" > body.json <<'PY'
import json, os, sys
name, keys, reps, conc, base, cand = sys.argv[1:7]
hashes = {c['versionId']: c['configHash'] for c in json.load(open('options.json'))['configurations']}
print(json.dumps({'name': name, 'description': '', 'suiteId': os.environ['SUITE'], 'taskKeys': keys.split(','),
                  'baselineVersionId': base, 'candidateVersionIds': [cand], 'repetitions': int(reps),
                  'concurrency': int(conc), 'spendCeilingUsd': None, 'timeBudgetOverrideS': None,
                  'expectedConfigHashes': {base: hashes[base], cand: hashes[cand]}}))
PY
  curl -s -X POST "$API/experiments" "${J[@]}" -d @body.json
}
EXP=$(launch walk-$STAMP-main total,list,report 2 3 "$BASE" "$SKILLED" | pick 'd["id"]')
curl -sN "$API/experiments/$EXP/events"    # Ctrl-C once the experiment event says completed
```

```text
: open

event: experiment
data: {"type":"experiment","at":"2026-10-25T00:38:47.042Z","status":"running","pauseReason":null,"failure":null}

event: counts
data: {"type":"counts","at":"2026-10-25T00:38:47.042Z","counts":{"queued":9,"running":3,"executed":0,"scoring":0,"scored":0,"execution_error":0,"cancelled":0},"doneRuns":0,"spend":{"spentUsd":0,"ceilingUsd":null,"projectedTotalUsd":0,"remainingEstimateUsd":0,"unpricedAttempts":0}}

event: run
data: {"type":"run","at":"2026-10-25T00:38:48.058Z","runId":"01M5R7XJ2WMFW28VR235PK582S","status":"executed","attempt":1,"primaryScore":null,"finishedAt":null}

event: feed
data: {"type":"feed","at":"2026-10-25T00:38:50.066Z","entry":{"runId":"01M5R7XJ2WMFW28VR235PK582T","finishedAt":"2026-10-25T00:38:49.531Z","taskKey":"total","configuration":"walk-20261025003749-baseline","repetition":2,"result":"failed","durationS":7.692}}
…
event: experiment
data: {"type":"experiment","at":"2026-10-25T00:39:12.131Z","status":"completed","pauseReason":null,"failure":null}

: keepalive
```

This run sent 47 events in 25 s (26 `run`, 12 `feed`, 7 `counts`, 2 `experiment`). A launch with a stale hash is refused before anything is frozen, and so is one whose provider is not ready:

```text
{"statusCode":409,"message":"configuration walk-20261025003749-baseline changed since you opened this form"}
{"statusCode":409,"message":"OPENROUTER_API_KEY is not set in egress's environment. Add it to .env, then run: docker compose up -d egress worker"}
```

#### C. The experiment, the Runs tab and one run

```bash
curl -s "$API/experiments/$EXP" | python3 -m json.tool
```

```json
{
  "status": "completed",
  "finishedAt": "2026-10-25T00:39:11.571Z",
  "elapsedS": 32,
  "totalRuns": 12,
  "counts": { "queued": 0, "running": 0, "executed": 0, "scoring": 0, "scored": 12, "execution_error": 0, "cancelled": 0 },
  "spend": { "spentUsd": 0, "ceilingUsd": null, "projectedTotalUsd": null, "remainingEstimateUsd": null, "unpricedAttempts": 0 },
  "hermes": { "package": "hermes-agent", "version": "v0.22.4", "revision": "4d04303818b61bf3aa09278af48356315515965b" },
  "differences": [
    {
      "field": "skills",
      "candidate": "walk-20261025003749-with-skill",
      "baselineValue": "—",
      "candidateValue": "walk-20261025003749-due-method@1.0.0",
      "hash": "59cc02de…"
    }
  ],
  "perConfiguration": [
    { "configuration": { "name": "walk-20261025003749-baseline", "role": "baseline", … }, "total": 6, "passed": 4, "provisionalPassRate": 0.667, … },
    { "configuration": { "name": "walk-20261025003749-with-skill", "role": "candidate", … }, "total": 6, "passed": 6, "provisionalPassRate": 1, … }
  ],
  "aggregates": [
    { "configuration": { "name": "walk-20261025003749-baseline", … }, "runs": 6, "passRate": 0.667, "meanScore": 0.667, "medianDurationS": 7.6145, "meanTokens": 9378, "costUsd": 0, "executionErrors": 0, "ungradable": 0, … },
    { "configuration": { "name": "walk-20261025003749-with-skill", … }, "runs": 6, "passRate": 1, "meanScore": 1, "medianDurationS": 7.5365, "meanTokens": 9786, "costUsd": 0, "executionErrors": 0, "ungradable": 0, … }
  ],
  "verdicts": [],
  "failure": null,
  "worker": { "connected": true, "lastHeartbeatAt": "2026-10-25T00:39:58.063Z", "workerLostRuns": 0 },
  …
}
```

`GET $API/experiments` lists it with `doneRuns: 12`, `costUsd: 0` and `verdicts: []`. The Runs tab, filtered to one task:

```bash
curl -s "$API/experiments/$EXP/runs?task=total&sort=configuration" | python3 -m json.tool
```

```json
{
  "rows": [
    {
      "id": "01M5R7XJ2WMFW28VR235PK582S",
      "taskKey": "total",
      "configuration": { "name": "walk-20261025003749-baseline", "role": "baseline", "model": "mock/scripted", "provider": "custom", … },
      "repetition": 1,
      "attempts": 1,
      "status": "scored",
      "primaryScore": { "key": "answer", "status": "failed", "score": 0 },
      "durationS": 7.696,
      "tokens": { "input": 7938, "output": 49, "total": 7987 },
      "costUsd": 0,
      "needs": { "provider": "custom", "judgeKeys": [], "judgeProvider": null },
      …
    },
    "… 3 more rows"
  ],
  "matched": 4,
  "summary": { "total": 12, "passed": 10, "failed": 2, "error": 0, "ungradable": 0, "executionErrors": 0 }
}
```

The inspector for the baseline's failed `total` run:

```bash
RUN=01M5R7XJ2WMFW28VR235PK582S
curl -s "$API/runs/$RUN" | python3 -m json.tool
```

````json
{
  "status": "scored",
  "attemptCount": 1,
  "attempts": [{ "number": 1, "trigger": "initial", "status": "scored", "durationS": 7.696, "exitCode": 0, … }],
  "limits": { "maxTurns": 10, "budgetS": 120 },
  "scores": [
    {
      "key": "answer",
      "type": "numeric_tolerance",
      "sentence": "numeric_tolerance on total, within ±0.01 of the reference",
      "status": "failed",
      "score": 0,
      "expected": { "summary": "149.5", "detail": null },
      "observed": { "summary": "400", "detail": null },
      "comment": "|observed − expected| = 250.500",
      …
    }
  ],
  "finalResponse": {
    "text": "All the amounts add up to 400.00.\n\n```json\n{\"total\": 400.00}\n```",
    "fence": { "start": 35, "end": 64 },
    "extracted": { "start": 43, "end": 60 },
    "extraction": "found",
    "parsed": { "total": 400 },
    "reference": { "total": 149.5 },
    …
  },
  "timeline": {
    "live": false,
    "totalEvents": 9,
    "events": [
      { "seq": 1, "kind": "platform", "title": "started", "summary": "Trial container started on hermes-evals-trial-0", … },
      { "seq": 2, "kind": "platform", "title": "init", "summary": "Hermes started · model mock/scripted", … },
      { "seq": 8, "kind": "network", "title": "Model call", "summary": "mock/scripted · 200 · 3,956 tokens (3,924 in / 32 out)",
        "text": "POST http://egress:8080/v1/chat/completions → 200, forwarded to mock-model:8090.", … },
      { "seq": 3, "kind": "tool", "title": "terminal", "summary": "cat /workspace/amounts.csv", "durationMs": 43,
        "output": "{\"output\": \"id,amount,status\\nA1,100.00,open\\n…\", \"exit_code\": 0, \"error\": null}", … },
      "… the second model call, two text rows, the final response …",
      { "seq": 10, "kind": "platform", "title": "collected", "summary": "1 file collected · 0 written by the agent", … }
    ]
  },
  "artifacts": {
    "items": [
      { "path": "workspace/amounts.csv", "origin": "fixture_unchanged", "sizeBytes": 74, "sha256": "e62d9d99…",
        "preview": { "columns": ["id", "amount", "status"], "totalRows": 4, … } }
    ],
    "agentWroteNothing": true
  },
  "launchRecord": {
    "command": "hermes chat --query-file /opt/data/task.txt --oneshot --format stream-json \\\n  --provider custom -m mock/scripted \\\n  --base-url http://egress:8080/v1 --api-key ‹run token, revoked› \\\n  -t file,terminal --max-turns 10 --yolo --in /workspace",
    "commandNote": "The run token is issued for this run only and revoked when it ends.",
    "configPath": "/opt/data/config.yaml",
    "configYaml": "model:\n  default: mock/scripted\n  provider: custom\n  base_url: http://egress:8080/v1\n  context_length: 131072\n…",
    "container": {
      "image": "hermes-evals/trial:v0.22.4-4d04303",
      "hermes": "hermes-agent v0.22.4 @ 4d04303",
      "network": "hermes-evals-trial-0",
      "user": "10000:10000",
      "imageFilesystem": "read-only",
      "limits": { "memory": "1.5 GB", "cpus": 1, "processes": 1024, "tmp": "512 MB" },
      "diskCap": { "bytes": 2147483648, "files": 50000 },
      …
    }
  },
  "counterpart": { "runId": "01M5R7XJ2WMFW28VR235PK582V", "configuration": "walk-20261025003749-with-skill", "status": "scored", "unavailableReason": null },
  …
}
````

The timeline is ordered by time, so the model call (seq 8, stored when the attempt ended) sits at its start, before the tool call it led to. The inspector's poll returns only what is new:

```bash
curl -s "$API/runs/$RUN/events?after=7" | python3 -m json.tool
```

```json
{
  "events": [
    { "seq": 8, "kind": "network", "title": "Model call",
      "network": { "method": "POST", "url": "http://egress:8080/v1/chat/completions", "status": 200, "model": "mock/scripted",
                   "tokensIn": 3924, "tokensOut": 32, "forwardedTo": "mock-model:8090" }, … },
    { "seq": 9, "kind": "network", "title": "Model call", … },
    { "seq": 10, "kind": "platform", "title": "collected", … }
  ],
  "lastSeq": 10,
  "live": false
}
```

`?after=10` answers `{"events":[],"lastSeq":10,"live":false}`. For the `report` task, `GET /runs/:id/artifacts/:artifactId/content` returns the `report.csv` the agent wrote, byte for byte.

#### D. Pause and resume

```bash
P=$(launch walk-$STAMP-pause slow 2 2 "$BASE" "$SKILLED" | pick 'd["id"]')
# once GET /experiments/$P shows running 2:
curl -s -X POST "$API/experiments/$P/pause" "${J[@]}" -d '{}'
```

```text
{"id":"01M5R81PE9RPFAFZHY51SHDB6Z","status":"paused"}
```

`GET /experiments/$P` then reads `paused`, `pauseReason: "user"`, with `queued 2, running 2`, and the list row's `statusReason` is "Paused by the user". About 50 s later the two in-flight runs have finished (`queued 2, scored 2`) and nothing new has started. A second pause is a no-op that answers the same, and resume answers `{"id":"01M5R81PE9RPFAFZHY51SHDB6Z","status":"running"}` and re-sends the two queued runs.

#### E. Kill the worker and watch recovery

While the resumed experiment's two runs are running:

```bash
docker compose kill worker && docker compose start worker
while sleep 10; do echo "$(date -u +%T) $(curl -s "$API/experiments/$P" | pick 'd["status"], {k: v for k, v in d["counts"].items() if v}, d["worker"]["workerLostRuns"]')"; done
```

```text
00:42:17 running {'running': 2, 'scored': 2} 0
…
00:43:07 running {'running': 2, 'scored': 2} 0
00:43:17 running {'running': 2, 'scored': 2} 2
…
00:44:08 completed {'scored': 4} 2
```

The worker was killed at 00:42:06 and started again a second later. Its trial containers kept running, because docker-guard holds them. The killed worker could not mark its row stopped, so its leases simply ran out about 60 s after its last heartbeat. The new worker's recovery pass at 00:43:10 then revoked both, stopped and removed their containers on this daemon, removed them from egress, ended them as `worker_lost`, and requeued their runs. Two seconds later it claimed attempt 2 of each, with trigger `recovery`. From its log (`docker compose logs worker`):

```text
00:43:10 {"attemptId":"01M5R839FZDBYAN4937RCVXRMV","runId":"01M5R81PEBS34F1TVJW55F9PA6","attemptStatus":"execution_error","runStatus":"queued","requeuedAttempt":2,"msg":"recovered a lost attempt"}
00:43:10 {"revoked":2,"finalised":2,"unconfirmed":0,"swept":0,"resentRuns":0,"resentEvaluations":0,"completed":0,"removedTrialDirs":0,"msg":"recovery pass"}
00:43:12 {"runId":"01M5R81PEBS34F1TVJW55F9PA6","attempt":2,"trigger":"recovery","attemptId":"01M5R85WH0PGTGDS8SFB76AGHX","slot":"hermes-evals-trial-0","msg":"attempt claimed"}
```

`GET /runs/01M5R81PEBS34F1TVJW55F9PA6` shows both attempts:

```json
[
  { "number": 1, "trigger": "initial", "status": "execution_error", "category": "worker_lost", "durationS": null, "exitCode": null, … },
  { "number": 2, "trigger": "recovery", "status": "scored", "category": null, "durationS": 47.499, "exitCode": 0, … }
]
```

Attempt 1's last event is the platform event recovery wrote: "Worker lost: its worker stopped renewing the lease. Recovery confirmed its trial container is gone." `docker compose kill` counts as a manual stop, so Docker does not restart the worker by itself; `docker compose start worker` does. A worker that crashes on its own is restarted by `restart: unless-stopped`. A graceful `docker compose stop worker` hands the trials back at once and ends them in its last recovery pass, instead of waiting for the leases.

#### F. Cancel

```bash
C=$(launch walk-$STAMP-cancel slow 2 2 "$BASE" "$SKILLED" | pick 'd["id"]')
# once two runs are running:
curl -s -X POST "$API/experiments/$C/cancel" "${J[@]}" -d '{}'
```

```text
{"id":"01M5R88MD49TX6PMQBTKR5YH7Y","status":"running"}
```

At once the two queued runs are `cancelled` and the list row reads "Cancelling: in-flight runs are finishing". One second later the cancel watcher had stopped both trials, and the experiment was `completed` with `cancelled 4` and the row "Cancelled: 4 of 4 runs cancelled". A stopped run's inspector says `"cancelled": {"at": "…", "by": "experiment", "ranForS": 6.035}`, its attempt is `cancelled` with exit code 143, and its timeline ends with "Run cancelled · container stopped after 6 s". A pause now answers 409 "the experiment is completed; only a running experiment can be paused".

#### G. Retry an execution error

A configuration whose stdio MCP server names a variable the worker does not have ends every attempt as `setup` before any container exists:

```bash
MCPV=$(curl -s -X POST "$API/resources/mcp-servers" "${J[@]}" -d "{\"name\":\"walk-$STAMP-db\",\"transport\":\"stdio\",\"command\":\"invoice-db-mcp\",\"args\":[],\"envNames\":[\"WALK_DB_URL\"],\"url\":null,\"headers\":[],\"include\":[],\"exclude\":[],\"timeoutS\":30}" | pick 'd["versionId"]')
BROKEN=$(curl -s -X POST "$API/configurations" "${J[@]}" -d "$(cfg walk-$STAMP-broken '' "\"$MCPV\"")" | pick 'd["versionId"]')
curl -s "$API/experiments/new-options" > options.json
R=$(launch walk-$STAMP-retry total 1 2 "$BASE" "$BROKEN" | pick 'd["id"]')
RUN=$(curl -s "$API/experiments/$R/runs?exec_error=1" | pick 'd["rows"][0]["id"]')
curl -s "$API/runs/$RUN" | pick 'json.dumps(d["executionError"], indent=1)'
```

```json
{
  "category": "setup",
  "reason": "WALK_DB_URL is not set in the worker environment; the MCP servers that use them cannot start.",
  "explanation": "The container failed to start, Hermes failed before it began, an MCP server failed to start, or Hermes asked for input (exit 3). Setup errors are not retried automatically: fix the cause, then Retry.",
  "stderrTail": { "lines": [], "totalLines": 0 },
  "exitCode": null,
  …
}
```

The experiment completed with `scored 1, execution_error 1`. Retrying the scored run is refused, and retrying the errored one reopens the experiment:

```text
POST /runs/<scored run>/retry  {"statusCode":409,"message":"run is scored, not execution_error"}
POST /runs/$RUN/retry          {"runId":"01M5R89QPZ2AZZ2CBBEHDF7WBD","status":"queued","attempt":2}
GET  /experiments/$R           running, finishedAt null, {'queued': 1, 'scored': 1}
```

Attempt 2 (trigger `user_retry`) failed the same way and the experiment completed again. The bulk form lists what it refused:

```bash
curl -s -X POST "$API/experiments/$R/runs/retry" "${J[@]}" -d "{\"runIds\":[\"$RUN\",\"<scored run>\",\"01NOTARUN\"]}"
```

```json
{
  "action": "retry",
  "enqueued": ["01M5R89QPZ2AZZ2CBBEHDF7WBD"],
  "refused": [
    { "runId": "01M5R89QPZ2AZZ2CBBEHDF7WBC", "reason": "run is scored, not execution_error" },
    { "runId": "01NOTARUN", "reason": "run not found in this experiment" }
  ]
}
```

#### H. Model access and the system stream

```bash
curl -s "$API/providers" | pick '[(p["id"], p["authMethod"], p["status"], p["envVar"]) for p in d]'
# [('nous', 'oauth-device', 'host_unreachable', None), ('openrouter', 'env-key', 'missing', 'OPENROUTER_API_KEY'),
#  ('nous-api', 'env-key', 'missing', 'NOUS_API_KEY'), ('openai', 'env-key', 'missing', 'OPENAI_API_KEY'),
#  ('anthropic', 'env-key', 'missing', 'ANTHROPIC_API_KEY'), ('custom', 'env-key', 'configured', 'CUSTOM_API_KEY')]
curl -s "$API/providers/nous/login"
# {"state":"not_connected","userCode":null,"verifyUrl":null,"expiresAt":null,"error":null,"billingUrl":null}
curl -sN --max-time 7 "$API/system/events"
```

```text
: open

event: summary
data: {"type":"summary","at":"2026-10-25T00:46:02.853Z","summary":{"running":{"count":0,"scored":0,"total":0,"experiments":[]},"workers":[{"id":"01M5R83ZX3792TFJ9YJ00KKQRN","status":"online","lastHeartbeatAt":"2026-10-25T00:46:00.277Z","concurrency":3,"slotsInUse":0,"slotsTotal":4,"sandboxProven":true},{"id":"01M5R6MKNG15RWCQ3A3QZ0CMWK","status":"offline",…}],"queuedRuns":0}}

event: summary
data: {"type":"summary","at":"2026-10-25T00:46:07.852Z",…}
```

On this machine the nous row reads `host_unreachable`, with `hostCommand: "hermes proxy start --provider nous"`, because `.env` sets `NOUS_HOST_PROXY` and no host proxy is running. In that mode `POST /providers/nous/login` answers 409 "This stack uses this machine's Hermes login (NOUS_HOST_PROXY), so Nous Portal is not connected from here." The second worker in the summary is the one killed in walkthrough E: it could not mark itself stopped, so it shows as offline.

Clean up:

```bash
rm -rf "suites/$NAME" && curl -s -X POST "$API/suites/reload" "${J[@]}" -d "{\"path\":\"$NAME\"}" | pick 'd["suites"][0]["outcome"]'   # missing
rm -f due-method.zip options.json body.json
docker compose --profile test rm -sf mock-model
```

The experiments, configurations, skill and MCP definition stay, because there are no delete endpoints.

### 6.4 Steps only you can do

Nothing in this phase called a real model provider, read your Hermes login, or touched the `nous-home` volume (E11). These two steps need you.

#### I14: connect Nous Portal from the API

This proves the designed path: nous-login runs the device login into `nous-home`, and nous-proxy serves model calls from it. On this machine `.env` sets `NOUS_HOST_PROXY`, so the stack is in host mode and Connect is refused. Choose one:

**Connect through nous-login** (the designed path):

1. Comment out `NOUS_HOST_PROXY` in `.env`, then apply it: `docker compose up -d egress worker`.
2. Once the worker is back (`docker compose logs worker` shows `worker ready`), `curl -s $API/providers | pick '[(p["id"], p["status"]) for p in d][0]'` shows `('nous', 'not_connected')`.
3. Start the login:

   ```bash
   curl -s -X POST "$API/providers/nous/login" "${J[@]}" -d '{}' | python3 -m json.tool
   # {"state": "waiting_for_approval", "userCode": "…", "verifyUrl": "https://…", "expiresAt": "…", …}
   ```

4. Open `verifyUrl` in your browser, sign in to Nous Portal and approve. The code is valid for about 15 minutes.
5. Poll until it is connected:

   ```bash
   until curl -s "$API/providers/nous/login" | pick 'd["state"]' | grep -qvx waiting_for_approval; do sleep 2; done
   curl -s "$API/providers/nous/login" | pick 'd["state"]'                                   # connected
   curl -s "$API/providers" | pick '[(p["id"], p["status"]) for p in d][0]'                  # ('nous', 'connected')
   ```

6. nous-proxy picks the login up on its next 5 s retry, without a restart: `docker compose logs --since 1m nous-proxy` no longer shows `hermes proxy start` exiting with "Not logged into Nous Portal".

`DELETE /providers/nous/login` cancels a pending login, and `POST /providers/nous/logout` disconnects. If the state ends as `expired`, `denied`, `needs_subscription` or `failed`, start again from step 3. If nous-login reports `unavailable`, the Hermes functions it calls have changed: `curl -s $API/providers/nous/login` stays `not_connected`, the POST answers 503 with the reason, and the terminal fallback in `docker-compose.yml` (above nous-proxy) still works.

**Or keep host mode**: leave `NOUS_HOST_PROXY` set and run `hermes proxy start --provider nous` on this machine. Within 10 s `GET /providers` shows `('nous', 'host')`.

#### Optional: a first real-model run

**This calls Nous Portal and costs money. Run it only if you approve it.** It is not needed to approve Phase 2.

A small comparison: 1 task × 2 configurations × 1 repetition, so two trials, on `openai/gpt-6.1-sol` through Nous. Phase 0's spike I4 ran this task on this model 6 times: 20 to 33 s and 3 model calls each.

1. Nous must read `connected` or `host` (above).
2. `config/prices.yaml` lists no real model, so these attempts are unpriced: their cost shows as null, they are counted in `unpricedAttempts`, and **the spend ceiling cannot stop them**, because the spend guard counts priced attempts only. The matrix size is the limit here. To price them, first add `openai/gpt-6.1-sol` with prices checked on Nous's public price page and `checked_at`; the experiment freezes the table at launch.
3. Make two configurations on `invoices-v1`'s `total_due` task, a baseline and one with a skill (the `invoice-method` skill from `docs/phases/phase-1.md` walkthrough B, or any skill you have uploaded):

   ```bash
   real() { printf '{"name":"%s","model":"openai/gpt-6.1-sol","provider":"nous","baseUrl":null,"toolsets":["file","terminal"],"memoryEnabled":false,"skillIds":[%s],"documentIds":[],"mcpServerVersionIds":[],"maxTurns":20,"timeBudgetS":300,"duplicatedFromVersionId":null}' "$1" "$2"; }
   SKILL=$(curl -s "$API/resources/skills" | pick '[s["id"] for s in d if s["name"] == "invoice-method"][0]')
   RB=$(curl -s -X POST "$API/configurations" "${J[@]}" -d "$(real real-baseline '')" | pick 'd["versionId"]')
   RS=$(curl -s -X POST "$API/configurations" "${J[@]}" -d "$(real real-with-skill "\"$SKILL\"")" | pick 'd["versionId"]')
   export SUITE=$(curl -s "$API/suites" | pick '[s["suiteId"] for s in d if s["name"] == "invoices-v1"][0]')
   curl -s "$API/experiments/new-options" > options.json
   EXP=$(launch first-real-run total_due 1 1 "$RB" "$RS" | pick 'd["id"]')
   curl -sN "$API/experiments/$EXP/events"
   ```

4. What to look at: `GET /experiments/$EXP` (both runs `scored`, tokens per configuration, `unpricedAttempts: 2`); each run's `GET /runs/:id` (the timeline's model calls, "forwarded to Nous Portal"; Hermes's own credits-seed call to `inference-api.nousresearch.com`, refused by egress and labelled as Hermes's background request, not the agent's; the `collected` event's `token_check` comparing Hermes's tokens with egress's count; the launch record).

If a launch answers 409 "Nous Portal is not connected", the connection step did not take. A provider failure mid-run ends the attempt as `execution_error · provider` and retries it once 30 s later.

---

## 7. Known limitations and what later phases pick up

### 7.1 What later phases pick up

| Item                                                                                                                                              | Phase | Where Phase 2 left it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trajectory_match` and `llm_judge` runtimes, the new `text_match` scorer, the judge client, re-score (`POST /runs/:id/rescore` and the bulk form) | 3     | Keys of the first two publish `error` with "`<type>` is scored from Phase 3" and `evidence.error`, so a run still reaches `scored`. Claim, publish and the dead letter are built (`evaluation/`), and `queueEvaluation(…, cause: 'rescore')` and `sendEvaluateRun` are ready for re-score. `ScorerContext.events()` loads events lazily for `trajectory_match`.                                                                                                                                                                                                                                                                                    |
| Statistics, verdict entries, `GET /experiments/:id/comparison`                                                                                    | 4     | Reconcile completes an experiment and sets `verdict_revision`, but appends no verdict entry, so `verdicts` is `[]` in the list and the detail. `ComparisonViewSchema` is in `packages/shared/src/contracts/comparison.ts`. `runFactsOf`, `progressOf` and `aggregateOf` (`experiments/views/`) count runs the way plan 10.1 says, so Compare can reuse them.                                                                                                                                                                                                                                                                                       |
| The pages for everything in this document                                                                                                         | 5     | The web data layer already speaks these contracts. To do there: `STATUS_TONES.provider` and `ProviderStatusRow` need `unavailable`; `src/api/experiments.ts` and `runs.ts` should switch from `liveGet` to `apiGet(path, Schema)` (the comment in `source.ts` saying the endpoints have no schema is stale); the inspector should reset `after` to 0 when `GET /runs/:id` reports a new `shownAttempt`; two display choices are open: the Hermes revision (the API sends all 40 characters, the fixture 7) and a user pause's `statusReason` (the API sends "Paused by the user", the fixture null); and UI_FLOWS 19 #4 (the banner on Resources). |
| `docs/limits.md`, `docs/costs.md`                                                                                                                 | 8     | The limits in section 7.2 are the material.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Real prices and the official experiment                                                                                                           | 8     | `config/prices.yaml` lists only `mock/scripted`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 7.2 Known limitations

- **No real model is priced.** Its attempts have `cost_usd` null and are counted in `unpricedAttempts`, and the spend ceiling cannot stop them (section 6.4). The price table is keyed by model id, so a price taken from one provider route would apply to every route of that model.
- **`openai` and `anthropic` go through OpenAI-compatible Chat Completions** (section 2.2). For Anthropic that means no prompt caching and no native thinking blocks. Both arms of a comparison take the same route.
- **Hermes's `tool_search` is on.** By default Hermes 4d04303 puts MCP tools, and some core tools, behind its `tool_search`, `tool_describe` and `tool_call` bridge tools, so a real model must discover them. Executed MCP calls still appear in `tool_use` events under their `mcp__<server>__<tool>` name. A call to an unknown tool name produces no stream-json event, only a model call in egress's log.
- **`config.yaml` has no `_config_version`**, so Hermes logs "config migration skipped" in `errors.log` on every run. Runs are unaffected.
- **A deadline kill while Hermes retries an unreachable provider is classified `timeout`**, as plan 8.4 says, not `provider`. Hermes's retries took 304 s against a 120 s budget in the spike. Both categories are retried once automatically, so only the label and the breaker's message differ.
- **No per-attempt token cap at the gateway.** The agent holds its token and can call the model gateway until the deadline; `settings.maxTokens` exists but is not set.
- **`WORKER_CONCURRENCY` above the slot count** only logs a warning; the extra jobs are deferred 5 to 15 s at a time.
- **Evaluation claims last 10 minutes.** A task with three or more slow `verifier_script` keys (up to 300 s each) can outlive its claim; a second delivery then scores in parallel and only the newest claim publishes. The result is correct, the work is wasted.
- **The workspace a verifier sees is rebuilt from the artifact blobs**, so it has no empty directories and no symlinks the agent left.
- **Artifacts are stored as the agent wrote them**, names and content. If the agent writes a stdio MCP value into a file, the artifact keeps it (plan 5.3 labels those values "Readable by the agent").
- **Skill files are copied with mode 0644**, so an executable bit in an uploaded skill is lost.
- **The MCP gateway** supports streamable HTTP only (not the legacy `sse` transport), no query strings, no redirects and no OAuth MCP servers; https servers need a publicly trusted certificate; 4 MiB per request, 16 calls in flight per attempt (open SSE streams count), 300 s idle; and egress cannot redact a server that echoes its own header values back. Two MCP server names that sanitise alike (`a-b` and `a_b`) collide in Hermes's tool names.
- **The timeline's structured `network` field describes model calls only.** MCP, CONNECT and plain-http rows have `network: null` and are described in `summary` and `text`.
- **No paging on the Runs tab**: `GET /experiments/:id/runs` returns every row (plan 11 says 200 per page). `RunEventsPage` does not carry the attempt number, so a client polling across a retry must reset `after` itself.
- **Small view approximations**: `elapsedS` includes earlier pauses (no pause history is stored); `Cancelled.by` is inferred from timestamps; `AttemptView.countsAgainstRun` is always true (every attempt counts against the cap); `FinalResponseView.referenceNote` is always null.
- **`relogin_required` can lag.** nous-login never refreshes the login, so a revoked login reads `connected` until nous-proxy's next model call fails. `ProviderInfo` has no field for the `unavailable` reason; it shows only in the 409s and the 503. A future Hermes that words `subscription_required` differently would show as `failed`.
- **Recovery is per daemon.** An attempt on a Docker daemon that never comes back is never finalised, by design (plan 8.6); there is no command to abandon it. One worker per daemon is the supported setup (E9).
- **The isolation self-test runs only at worker start.** A worker that failed it, or found no free slot, takes no runs until it is restarted.
- **A killed worker cannot mark its row stopped**, so it shows as offline. Lost attempts end about 70 s after a worker dies (`LEASE_SECONDS` plus one recovery interval), and their `worker_lost` attempts carry no tokens: egress's usage report is discarded when recovery removes the registration, and the spend guard counts such an attempt of a priced model at the mean priced cost.
- **`POST /runs/:id/retry` is not gated on the frozen Hermes revision**, unlike Resume and Retry failed runs; such a run's job is put back until a worker on that revision connects. The comment on `frozenRevisionRefusal` in `live-workers.ts` says Retry is gated; it is not.
- **`GET /experiments/new-options` offers suites whose directory is missing** (such as the `zz-smoke-*` rows), and launching from their stored blobs works.
- **No delete endpoints.** Each smoke run leaves its `smoke-…` experiments, configurations and skill, and a `missing` suite row; workspaces stay for `TRIAL_RETENTION_DAYS`.
- **Tests**: FakeEgress accepts any registration (validating against egress's real schema needs a new workspace dependency); one full-application e2e world holds about 40 Postgres connections.

### 7.3 Open questions for the reviewer

1. Should every trial's `config.yaml` set `tools.tool_search.enabled: off`, so every arm sees its tools directly? The default changes the tool surface in ways other than the configured toolsets.
2. Should the runner set a finite default per-attempt token cap at the gateway?
3. Should `localConcurrency` be capped at the number of `TRIAL_SLOTS` instead of only logging a warning?
4. Should `TimelineEvent.network` grow a `kind` and nullable model and token fields, so the inspector can show MCP, CONNECT and http rows structurally?
5. Should the evaluation claim be renewed between keys, or sized from the sum of the verifier timeouts?
6. A deadline kill while Hermes retries an unreachable provider: keep `timeout`, or use the egress log to call it `provider`?
7. Who checks the real Nous price for `openai/gpt-6.1-sol`, with its `checked_at`, before the official experiment? Should the price table be keyed by provider route rather than by model id?
8. Should `POST /runs/:id/retry` also answer 409 when no connected worker runs the experiment's frozen Hermes revision?
9. Should the New experiment form label the time budget override as a per-run budget that replaces each configuration's own?
10. Is counting an unknown-cost `worker_lost` attempt at the experiment's mean priced cost the right conservative rule, or should it use the launch estimate's per-run cost?
11. Accept Anthropic through its OpenAI-compatible endpoint for v1 and say so in `docs/limits.md`, or add Messages and Responses routes to the model gateway?
12. Should saving a configuration refuse two MCP servers whose names sanitise alike?

### 7.4 How these questions were settled

The phases now run back to back without a review round between them, so each question above was settled as follows on 25 Oct 2026. Any of them can be reversed.

| #   | Decision                                                                                                                                                                                           | Where     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Yes: every trial's `config.yaml` sets `tools.tool_search.enabled: off`, so the configured toolsets are exactly what the agent sees, in every arm.                                                  | Phase 3   |
| 2   | Yes: the model gateway gets a default per-attempt token cap, configurable, and answers 429 past it with a `network` event saying why.                                                              | Phase 3   |
| 3   | Yes: `localConcurrency` is capped at the number of `TRIAL_SLOTS`, with the warning kept.                                                                                                           | Phase 3   |
| 4   | Yes: `TimelineEvent.network` gains `kind`, with the model and token fields nullable, before the inspector is wired in Phase 5.                                                                     | Phase 3   |
| 5   | Renew the evaluation claim between keys, so slow verifier scripts cannot outlive it.                                                                                                               | Phase 3   |
| 6   | Keep `timeout`, as plan section 8.4 says. Both categories are retried once, so only the label differs.                                                                                             | No change |
| 7   | The real price is checked from a public page, with `checked_at`, before the official experiment. The table stays keyed by model id, since the experiment uses one route; `docs/limits.md` says so. | Phase 8   |
| 8   | Yes: `POST /runs/:id/retry` answers 409 like Resume and Retry failed runs, which also makes the comment on `frozenRevisionRefusal` true.                                                           | Phase 3   |
| 9   | Yes: the New experiment form labels the override as a per-run time budget that replaces each configuration's own.                                                                                  | Phase 5   |
| 10  | Keep the mean priced cost of the experiment: it reflects what this experiment's attempts really cost, where the estimate is a guess made before any ran.                                           | No change |
| 11  | Accept the OpenAI-compatible endpoints for v1 and say so in `docs/limits.md`.                                                                                                                      | Phase 8   |
| 12  | Yes: saving a configuration refuses two MCP servers whose names sanitise alike.                                                                                                                    | Phase 3   |

One small item from writing this document also goes to Phase 3: the Swagger `@ApiQuery` list of `GET /experiments/estimate` gains the optional `budget` parameter.
