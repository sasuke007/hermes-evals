# Hermes Evals

An evaluation platform for [Hermes Agent](https://github.com/NousResearch/hermes-agent). Define tasks and how they are scored, define agent configurations to compare (model, skills, memory, tools, MCP servers), run every task under every configuration several times, and get a verdict with a confidence interval plus the evidence behind every run.

Stack: NestJS API and worker, Vue 3 web app, PostgreSQL, pg-boss for durable jobs. TypeScript throughout, managed as a Turborepo with pnpm workspaces.

## Run everything with one command

```bash
cp .env.example .env
docker compose up --build
```

| Service  | URL                                                       |
| -------- | --------------------------------------------------------- |
| Web app  | http://localhost:8080                                     |
| API      | http://localhost:3000/api (docs at `/api/docs`)           |
| Postgres | localhost:5432, user and password `hermes`, loopback only |

Requirements: Docker Engine 28 or newer with Compose and buildx (Docker Desktop, or Colima on macOS: `brew install colima docker docker-compose docker-buildx`). Give the Docker VM at least 6 GB of memory (`colima start --memory 8`); each trial is capped at 1.5 GB and three run at once.

The services: `postgres`; `api` (HTTP and live updates); `worker` (loads suites, runs every trial in its own container, scores runs, recovers lost ones); `web`; `docker-guard` (the only holder of the Docker socket); `egress` (the trials' only way out: forward proxy, model gateway and MCP gateway); `nous-proxy` and `nous-login` (the Nous Portal login, see below); and `trial-image`, which builds the trial image and exits. `mock-model`, a scripted OpenAI-compatible model, starts only with `--profile test`.

Model access:

- **Nous Portal** (OAuth): in the web app, System > Model access > Connect, and approve in the browser. `nous-login` writes the login into the `nous-home` volume and `nous-proxy` serves model calls from it; no token leaves that volume. Both services start by default and report `not_connected` until then.
- **Nous Portal, reusing this machine's Hermes login** (development): run `hermes proxy start --provider nous` on the host and set `NOUS_HOST_PROXY=host.docker.internal:8645` in `.env`. Nothing is copied: the host proxy keeps the login, and egress forwards to it from its own loopback. Model access then shows Nous as `host` (or `host_unreachable` when the host proxy does not answer), and Connect is refused. Any container in the Docker VM can reach that host proxy, so use this only on a machine you trust.
- **API keys** (OpenRouter, the Nous API, OpenAI, Anthropic): set `OPENROUTER_API_KEY`, `NOUS_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in `.env`, then `docker compose up -d egress worker`.
- **A custom OpenAI-compatible endpoint**: a configuration with provider `custom` and its base URL; egress sends `CUSTOM_API_KEY` from `.env` when it is set. A configuration on `custom` with base URL `http://mock-model:8090/v1` runs against the mock model (`docker compose --profile test up -d mock-model`) at no cost, which is how the platform is checked without a real model; `MOCK_SCRIPTS` in `.env` gives chosen prompts their own scripted answers.

Model prices for cost and the spend guard come from `config/prices.yaml`; an experiment freezes it when it launches. A model it does not list is unpriced: its cost shows as unknown, never as zero. The model gateway serves one attempt at most `MODEL_TOKEN_CAP_PER_ATTEMPT` tokens (2,000,000 by default), then answers 429. Every call counts toward it: streamed calls are sent with `stream_options.include_usage` on, and a call that answers without reporting usage is charged an estimate from its size, so an agent calling the gateway itself cannot slip past the cap or the spend guard.

Scoring and re-score:

- The worker scores each executed run from its stored evidence, never by running Hermes again. A task's checks can be any of eight types: `numeric_tolerance`, `json_match`, `exact_match`, `text_match` (phrases and a regular expression looked for in the answer), `file_check`, `verifier_script`, `trajectory_match` (the agent's tool calls) and `llm_judge` (a rubric graded by a model).
- The LLM judge's model is a check's own `model:`, else `JUDGE_MODEL`, on `JUDGE_PROVIDER` (`nous` when unset); `JUDGE_BASE_URL` only for `custom`. All three are unset by default, so an `llm_judge` check without `model:` is graded `error` until they are set (`.env`, then `docker compose up -d api worker`). The judge's calls go through egress's admin socket like a trial's model calls: the worker holds no provider key, and each call is metered and priced into its score's evidence as grading cost, outside the spend guard. Launch and Re-score answer 409 while the judge's provider is not ready. To grade with the mock model: `JUDGE_PROVIDER=custom JUDGE_MODEL=mock/scripted JUDGE_BASE_URL=http://mock-model:8090/v1`.
- Re-score (`POST /api/runs/:id/rescore`, or several runs at once with `POST /api/experiments/:id/runs/rescore`) grades a scored run again with the scorers as they are now, as a new evaluation generation. The run keeps its previous result until the new one publishes, and a second request while one is pending joins it.

MCP server secrets also go in `.env`, by the env name the server definition lists: a stdio server's values are read by the worker, an http server's header values by egress, which adds them in its MCP gateway (`http://egress:8080/mcp/<name>`). The database and the UI only ever see the names. The sample stdio server needs `INVOICE_DB_URL` (see `.env.example`).

One worker per Docker daemon is the supported setup. A second worker on the same daemon needs its own, disjoint `TRIAL_SLOTS` (and docker-guard's `TRIAL_NETWORKS` must list them all). Stopping the worker hands its running trials back: their containers are stopped and their runs requeued, to finish on the next start.

The API has no login, so every POST, PUT and DELETE must carry an `X-Requested-With` header and a JSON or multipart body; another site open in the browser cannot send those. The web app and the "Try it out" button at `/api/docs` add them.

Check a running stack end to end (suites and their versioning, skills, documents, MCP servers and "Test start", secrets, configurations, system), one PASS/FAIL line per step:

```bash
scripts/phase1-smoke.sh                            # curl and python3; BASE_URL defaults to http://localhost:3000/api
EXPECT_INVOICE_DB_URL=set scripts/phase1-smoke.sh  # the worker has INVOICE_DB_URL: the invoice-db test must pass
```

It writes to the stack it checks, so use a development stack: skills, documents, MCP servers and configurations named `smoke-<timestamp>-…`, and a temporary suite directory `suites/zz-smoke-<timestamp>` that it deletes again, which the suite list then keeps showing as "Missing from disk".

Run real experiments end to end, in trial containers, with real Hermes against the scripted mock model (a temporary suite of three small tasks and a slow one, a skill, two configurations, a 3 x 2 x 2 launch followed live, the results and every read API, then pause and resume, and cancel; about 3 minutes, nothing costs money). The mock needs the scripts in `scripts/phase2-mock-scripts.json`, which Compose takes from the shell:

```bash
MOCK_SCRIPTS="$(python3 -c 'import json; print(json.dumps(json.load(open("scripts/phase2-mock-scripts.json"))))')" \
  docker compose --profile test up -d
scripts/phase2-smoke.sh                            # curl and python3; BASE_URL defaults to http://localhost:3000/api
```

Its experiments, configurations and skill are named `smoke-<timestamp>-…`, and its suite directory `suites/zz-smoke-exec-<timestamp>` is deleted again at the end. Only `mock-model` reads `MOCK_SCRIPTS`; stop it afterwards with `docker compose --profile test rm -sf mock-model`.

Check scoring live (Phase 3, about 2 minutes, nothing costs money): a temporary suite whose three tasks use all eight check types, two configurations that answer every check right and wrong (json_match 4 of 5 keys, text_match 1 of 3, no `read_file` for trajectory_match, the judge's low score), a reply without the JSON block (`ungradable` answer checks, `error` verifier and judge), the evidence behind each score, the judge's calls going through egress's admin socket to the mock model, no judge registration left and no credential in a score, event or launch record, then re-score: one run (generation 2 supersedes 1), a double request that collapses into one, a bulk re-score with a refusal, and the 409 while the judge's provider is not ready (the script recreates the api for that step with the judge on a provider without a key, then puts it back; `SMOKE_RESTART=0` skips it). The judge must point at the mock, and the mock needs both script files (the Phase 3 ones first):

```bash
MOCK_SCRIPTS="$(python3 -c 'import json; print(json.dumps(json.load(open("scripts/phase3-mock-scripts.json")) + json.load(open("scripts/phase2-mock-scripts.json"))))')" \
JUDGE_PROVIDER=custom JUDGE_MODEL=mock/scripted JUDGE_BASE_URL=http://mock-model:8090/v1 \
  docker compose --profile test up -d
scripts/phase3-smoke.sh                            # curl and python3; BASE_URL defaults to http://localhost:3000/api
```

Its configurations, skill and experiments are named `smoke-<timestamp>-…`, and its suite directory `suites/zz-smoke-score-<timestamp>` is deleted again at the end. Afterwards return to the normal configuration with `docker compose up -d` (from a shell without those variables) and `docker compose --profile test rm -sf mock-model`.

## How a trial is isolated

Every trial runs Hermes in its own container, started from the pinned `nousresearch/hermes-agent:v0.22.4` image. The container sees only that attempt's home and workspace, runs as an unprivileged user on a read-only image, and sits on an internal network whose only reachable host is `egress`. Egress refuses every private, loopback, host and Docker address, and forwards model calls with the real credential, which never enters the trial. Only `docker-guard` holds the Docker socket, and it lets the worker start nothing but such containers.

The worker proves this on every start and refuses to run experiments if any check fails. Run the same checks by hand:

```bash
docker compose run --rm --no-deps worker node dist/sandbox-cli.js selftest    # isolation
docker compose run --rm --no-deps worker node dist/sandbox-cli.js lifecycle   # deadline, cancel, orphans, hostile output, disk caps, locked trees
docker compose --profile test up -d mock-model
docker compose run --rm --no-deps worker node dist/sandbox-cli.js smoke       # real Hermes, scripted model
```

Run one suite task with a real model and check its answer (the model defaults to `openai/gpt-6.1-sol` on Nous; set `TASK_MODEL` and `TASK_PROVIDER` to change it):

```bash
docker compose exec worker node dist/sandbox-cli.js task /data/suites/invoices-v1/total_due
```

## Local development

Requires Node 22+ and pnpm 11 (`corepack enable`), and python3 for the API tests (verifier self-checks run it, as the worker image does; the test run stops at once without it). Postgres can come from `docker compose up postgres`.

```bash
pnpm install
pnpm dev            # shared (tsc --watch), api (nest --watch), web (vite) via Turbo
pnpm --filter @hermes-evals/api dev:worker   # the worker, in a second terminal: loads suites, tests MCP servers, runs and scores trials
```

- Web dev server: http://localhost:5173 (proxies `/api` to the API on :3000). The API listens on 127.0.0.1 (`HOST`) and answers only the host names it is reached by: loopback, `api`, the host of `CORS_ORIGIN` and any in `ALLOWED_HOSTS` (comma-separated). To open the Compose web app by another name, add it to `ALLOWED_HOSTS` and to `server_name` in docker/nginx.conf.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` run across all packages in dependency order. `pnpm test` runs the unit tests and the integration tests on PGlite (real migrations and triggers, in process).
- Postgres 17 end-to-end tests, including the whole API and worker on a fresh database (`test/phase2.e2e-spec.ts` launches an experiment over HTTP and runs it to scored, with an in-process fake container engine that plays canned Hermes output; `test/phase3.e2e-spec.ts` scores all eight check types right and wrong, with the LLM judge behind a fake egress judge path, and re-scores): `TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e` against a throwaway server (`docker run -d --name hermes-evals-pg-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:55433:5432 postgres:17-alpine`). Each spec creates and drops its own database; never point it at the Compose database. The suite stops at once without `TEST_DATABASE_URL` (every file would otherwise skip and read as green) or with port 5432, and runs four files at a time, which peaks at about 70 of the server's 100 connections.
- Tests that start real trial containers run only with `RUN_SANDBOX_TESTS=1` and a docker-guard socket (`DOCKER_SOCKET`, `TRIALS_DIR`, `TRIAL_IMAGE`, `TRIAL_VOLUME`); Turbo passes these through and keys its cache on them.

## Layout

```
apps/api          NestJS: HTTP API, SSE, pg-boss producer (src/main.ts), worker (src/worker.ts), sandbox client (src/sandbox)
apps/docker-guard The only holder of the Docker socket: a filtered Docker API for trial containers
apps/egress       The trials' only way out: forward proxy, model gateway, MCP gateway, scripted mock model
apps/web          Vue 3 + Vite + Pinia + vue-router
packages/shared   Domain types, zod schemas, API contracts used by both apps
suites/           Task suites, loaded by the worker at start and on POST /api/suites/reload (read-only in the UI)
config/           prices.yaml: model prices an experiment freezes at launch
docker/           Dockerfiles: api, worker, web, trial (pinned Hermes image, nous-login.py), node services; nginx config
```

## Documents

- `UI_DESIGN_BRIEF.md`: the brief the UI design was produced from
- `DESIGN_AUDIT.md`: audit of the design against the brief and the system design
