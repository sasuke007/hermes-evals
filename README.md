# Hermes Evals

An evaluation platform for [Hermes Agent](https://github.com/NousResearch/hermes-agent). You write tasks and say how each is scored, define the agent configurations you want to compare (model, skills, memory, toolsets, MCP servers, documents), and run every task under every configuration several times, each run in a locked-down container of its own. You get a verdict, `better`, `worse` or `inconclusive`, with a 95% confidence interval, and the evidence behind every run: the agent's timeline of model and tool calls, its answer, each check's score and the files it wrote.

It runs on your machine with Docker Compose: a NestJS API and worker, a Vue 3 web app, PostgreSQL with pg-boss for durable jobs, and three small services that keep trials isolated. TypeScript throughout, in a pnpm and Turborepo monorepo. Five sample suites and a scripted mock model come with it, so everything can be tried without a model account and without spending money.

## Requirements

- **macOS** with [Colima](https://github.com/abiosoft/colima) or Docker Desktop. Both were installed from a clean clone and checked on 27 Oct 2026 (Apple silicon, 16 GB: Colima 0.10.3 with Docker Engine 29.5, and Docker Desktop 4.96 with Engine 29.9; Compose 5.6). Linux with native Docker is untested: see [Linux](#linux).
- **Docker Engine 28 or newer** (the trial networks use its isolated gateway mode), **Compose 2.24 or newer** and buildx. On Colima: `brew install colima docker docker-compose docker-buildx`.
- **Memory**: give the Docker VM 6 GB (`colima start --cpu 4 --memory 6 --disk 60`, or Docker Desktop's Settings › Resources). Three trials run at once, each capped at 1.5 GB. Measured with the mock model: the running stack used about 2.3 GB of the VM while three trials ran (2.4 GB on Docker Desktop), and the first build up to 2.3 GB on Colima's 4 CPUs (4.3 GB on Docker Desktop's 10, which builds more at once).
- **Disk**: the first build leaves about 10 GB in the Docker VM on Colima and 15 GB on Docker Desktop: the images (the Hermes trial image alone is 4.5 GB) and about 4 GB of build cache that `docker builder prune` gives back. Each run adds little: its home is deleted when it ends and its workspace after `TRIAL_RETENTION_DAYS` (7). A 60 GB VM disk was tested; Colima's default is 100 GB.
- **Network** for the first build: Docker Hub (the pinned Hermes image is a 1.1 GB download), the npm registry and Debian's package mirrors. The first `up --build` took 11 minutes on Colima over a 3 MB/s connection and 2 minutes on Docker Desktop over a faster one, most of it downloading; the worker was online, its sandbox proven, within 35 s of that. A rebuild after a code change takes about a minute.
- **Free ports on 127.0.0.1**: 8080 (web app), 3000 (API) and 5432 (Postgres). All three are bound to loopback only.
- **On Colima, keep the clone under your home directory.** Colima shares only your home with its VM unless told otherwise, and Compose bind-mounts `./suites`, `./config` and the mock's scripts from the clone. Docker Desktop shares `/Users`, `/private` and `/tmp` by default.

## Quick start with the mock model

```bash
git clone https://github.com/sasuke007/hermes-evals.git && cd hermes-evals
cp .env.example .env
cat >> .env <<'ENV'
MOCK_SCRIPTS_FILE=./scripts
JUDGE_PROVIDER=custom
JUDGE_MODEL=mock/scripted
JUDGE_BASE_URL=http://mock-model:8090/v1
ENV
docker compose --profile test up -d --build
```

The `test` profile adds `mock-model`, a scripted OpenAI-compatible model; without it (`docker compose up -d --build`) the stack is the same minus the mock, and runs need a real model (below). `MOCK_SCRIPTS_FILE` names the file, or the directory of `*.json` files, it plays from; `./scripts` holds the scripts of every sample suite and smoke test, each matching phrases only its own runs hold. The `JUDGE_*` lines make the mock the LLM judge too, which `invoices-v1` and `knowledge-v1` each need for one check. Compose reads all of these from your shell first, then `.env`.

| What     | Where                                                     |
| -------- | --------------------------------------------------------- |
| Web app  | http://localhost:8080                                     |
| API      | http://localhost:3000/api (OpenAPI docs at `/api/docs`)   |
| Postgres | localhost:5432, user and password `hermes`, loopback only |

Open http://localhost:8080 and go to **System**. A healthy stack shows Sandbox "Isolation proven · 16 of 16 checks", Hermes `hermes-agent v0.22.4 @ 4d04303`, and one worker online with its sandbox proven. Model access lists Nous Portal as not connected until you log in (below); the mock needs nothing there.

Then try an experiment on the mock, which costs nothing:

1. **Configurations › New configuration**: name `baseline`, model `mock/scripted`, provider `custom`, base URL `http://mock-model:8090/v1`, toolsets `file` and `terminal`, memory off, max turns 10, time budget 180 s. Save.
2. **Resources › Skills › Upload skill**: a zip of `samples/skills/invoice-method` with its files at the zip's root (`cd samples/skills/invoice-method && zip -r ../../../invoice-method.zip .`).
3. Duplicate `baseline` as `with-skill` and add the skill.
4. **Experiments › New experiment**: suite `invoices-v1`, both configurations with `baseline` as the baseline, 2 repetitions. Launch 48 runs.

With the mock it takes about two minutes and reads `better`, Δ +0.667: without the skill the mock falls into eight of the twelve tasks' traps, with it into none (pass rates 8/24 → 24/24). Click any cell of the comparison to open that run in the inspector.

## The five suites and the samples

A suite is a directory under `suites/`; the worker loads every one at start and on Suites › Reload all from disk. Each of the five measures one thing a configuration can vary, and its `suite.yaml` names the experiment that measures it: configurations that differ only there. Every task has a trap, and every task can be answered in every arm; the dimension decides how well.

| Suite          | Tasks | Recommended experiment (baseline first)                               | What the arms need                                                                                                                                                                                                              |
| -------------- | ----- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoices-v1`  | 12    | `baseline` · `with-skill`                                             | the skill `invoice-method`, preloaded                                                                                                                                                                                           |
| `mcp-v1`       | 8     | `docs-export` · `with-mcp`                                            | the documents `samples/documents/mcp-v1/invoices.csv` and `vendors.json` (under exactly those names) in `docs-export`; the MCP servers `invoice-db` and `vendor-directory` (named so, with the definitions below) in `with-mcp` |
| `memory-v1`    | 8     | memory off · memory on                                                | nothing: every task seeds the same memory files in both arms                                                                                                                                                                    |
| `knowledge-v1` | 8     | none · documents · skills preloaded · skills on demand                | the six documents of `samples/documents/knowledge-v1/`, or the skills `bx7-format`, `house-style` and the decoy `bx6-format`                                                                                                    |
| `tools-v1`     | 6     | `file` · `file` + `terminal` · `file` + `terminal` + `code_execution` | nothing                                                                                                                                                                                                                         |

Apart from what the table names, the arms are alike: toolsets `file` and `terminal` (`tools-v1` varies only them), memory off (`memory-v1` varies only it), no skills, documents or MCP servers, and max turns 10 (30 for `mcp-v1`, where one task makes 18 model calls). With the mock model every recommended experiment reads `better`: `invoices-v1` Δ +0.667, `mcp-v1` Δ +1.000, `memory-v1` Δ +0.625, `knowledge-v1` Δ +0.875 for each knowledge arm, `tools-v1` Δ +0.833 for each tool arm.

The samples the arms use live under `samples/`: the skills in `samples/skills/` (upload each as a zip with its files at the zip's root, as in the quick start) and the documents in `samples/documents/` (upload each in Resources › Documents under its own file name: the prompts name the files, and the workspace's `docs/` keeps the names).

```bash
for s in invoice-method bx7-format house-style bx6-format; do (cd samples/skills/$s && zip -r ../../../$s.zip .); done
```

Every suite, references included, is written by a generator in `scripts/fixtures/` run with plain Node 22.18+ (fixed seed, the same bytes every time), which also writes the suite's mock scripts; `--check` exits 1 naming each file that differs. Edit a generator, never the generated files:

```bash
node scripts/fixtures/invoices-v1.ts               # also mcp-v1.ts, memory-v1.ts, knowledge-v1.ts, tools-v1.ts, sample-mcp.ts
node scripts/fixtures/mcp-v1.ts --check
```

### The sample MCP servers and the `samples` profile

Two sample MCP servers serve generated data that agrees (every vendor in the ledger is in the directory). `mcp-v1` needs both, under these names, so that its tool names come out as `mcp__invoice_db__*` and `mcp__vendor_directory__*`:

- `invoice-db`, stdio, baked into the trial image: a ledger of 120 invoices, `list_invoices(status?, vendor_name?, cursor?)` 20 rows a page, `get_invoice`, and `update_invoice` and `delete_invoice`, which never write. Define it in Resources › MCP servers (Define MCP server) with command `invoice-db-mcp` and the variable `INVOICE_DB_URL`, which `.env.example` already sets (`file:///opt/mcp/invoice-db/invoices.csv`).
- `vendor-directory`, http and read-only, in the Compose profile `samples`: `list_vendors(status?, cursor?)` and `get_vendor(name)` on a network only egress shares, so a trial reaches it only through egress's MCP gateway. It answers 401 without `Authorization: Bearer <token>`. Set `VENDOR_DIRECTORY_TOKEN` in `.env` to any random string (`openssl rand -hex 16`), then `docker compose --profile test --profile samples up -d`. Compose gives egress the raw token and blanks it for the api and the worker. Define it with URL `http://vendor-directory:8000/mcp` and the header `Authorization` with the prefix `Bearer ` from `VENDOR_DIRECTORY_TOKEN`.

## Real models

Every model call a trial makes goes through egress, which holds the credentials; nothing secret enters a trial. Prices for cost and the spend guard come from `config/prices.yaml` (an experiment freezes it at launch; a model it does not list shows its cost as unknown, never zero).

- **Nous Portal, one-time login**: System › Model access › Connect, then approve in the browser. `nous-login` writes the login into the `nous-home` volume and `nous-proxy` serves model calls from it; the token never leaves that volume, and the login survives restarts. Without a browser: `docker compose run --rm --entrypoint /opt/hermes/.venv/bin/hermes nous-proxy auth add nous --type oauth --no-browser`.
- **Nous Portal, reusing this machine's Hermes login** (development): run `hermes proxy start --provider nous` on the host and set `NOUS_HOST_PROXY=host.docker.internal:8645` in `.env`. Nothing is copied; egress forwards Nous calls to the host proxy, Model access shows Nous as `host`, and Connect is refused. Any container in the Docker VM can reach that proxy, so do this only on a machine you trust.
- **API keys**: `OPENROUTER_API_KEY`, `NOUS_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in `.env`, then `docker compose up -d egress worker`. Only egress reads them; Compose blanks them for every other service.
- **Any OpenAI-compatible endpoint**: a configuration with provider `custom` and its base URL (that is how the mock is used); egress sends `CUSTOM_API_KEY` from `.env` when it is set.
- **The LLM judge** (`llm_judge` checks) uses a check's own `model:`, else `JUDGE_MODEL`, on `JUDGE_PROVIDER` (`nous` when unset). Launch answers 409 for a task whose judge has no model, or while the judge's provider is not ready.

The model gateway serves one attempt at most `MODEL_TOKEN_CAP_PER_ATTEMPT` tokens (2,000,000 by default) and then refuses, so a runaway agent stops at once. `.env.example` lists every setting with its default.

## How it works

The services: `postgres`; `api` (HTTP and live updates); `worker` (loads and saves suites, runs every trial in its own container, scores runs, recovers lost ones); `web` (nginx serving the app and proxying `/api`); `docker-guard`, the only holder of the Docker socket, which lets the worker start nothing but trial and verifier containers; `egress`, the trials' only way out (forward proxy, model gateway, MCP gateway); `nous-proxy` and `nous-login` (Nous Portal); and `trial-image`, which builds the pinned Hermes image and exits.

- **Isolation.** Every trial runs Hermes v0.22.4 in its own container from a read-only image, as an unprivileged user, seeing only that attempt's home and workspace, on an internal network whose only reachable host is egress. Egress refuses every private, loopback, host and Docker address. A suite's verifier scripts run the same way, each in a container with no network at all. The worker proves this with an isolation self-test on every start and refuses to run experiments if a check fails; System › Sandbox shows each check. To run the checks by hand: `docker compose run --rm --no-deps worker node dist/sandbox-cli.js selftest`.
- **Scoring.** A task's checks can be any of eight types: `numeric_tolerance`, `json_match`, `exact_match`, `text_match`, `file_check`, `verifier_script` (Python), `trajectory_match` (the agent's tool calls) and `llm_judge`. The worker scores each run from its stored evidence, never by running Hermes again, and Re-score grades runs again as a new generation.
- **Comparison.** Per-task pass rates, the mean per-task difference with a 95% interval from a paired bootstrap over tasks (10,000 resamples, seeded from the experiment id), the verdict, a sensitivity figure without runs that broke, and secondary metrics. With one repetition or fewer than 3 tasks there is no interval, and the page says why.
- **Authoring.** Suites can be written by hand under `suites/` or in the web app (Suites › New suite: empty, a copy, or a `.zip`; tasks imported from CSV or JSONL). The files stay the source of truth: an edit goes into a draft, and saving writes the suite's folder through the worker and loads it like a reload. `verify/` scripts are code, so the web app never writes them; they arrive only in a `.zip` you mark as trusted.
- **No login.** The API has no authentication and listens on loopback. Every POST, PUT, PATCH and DELETE must carry an `X-Requested-With` header and a JSON or multipart body, which another site open in your browser cannot send.
- One worker per Docker daemon is the supported setup. Stopping the worker hands its running trials back to the queue.

Design and decisions in detail: `IMPLEMENTATION_PLAN.md`; what each phase built and how it was checked: [`docs/phases/`](docs/phases); the UI flows: `UI_FLOWS.md`.

## Checking a stack end to end

The smoke scripts drive a running stack over HTTP, with real Hermes in real trial containers against the mock model, and print one PASS/FAIL line per step. They write to the stack they check (names start with `smoke-<timestamp>`, suite folders `suites/zz-smoke-…` are removed again), so use a development stack. One start serves them all:

```bash
export VENDOR_DIRECTORY_TOKEN="$(openssl rand -hex 16)" INVOICE_DB_URL=file:///opt/mcp/invoice-db/invoices.csv
MOCK_SCRIPTS_FILE=./scripts \
JUDGE_PROVIDER=custom JUDGE_MODEL=mock/scripted JUDGE_BASE_URL=http://mock-model:8090/v1 \
  docker compose --profile test --profile samples up -d --build
```

| Script                     | Checks                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/phase1-smoke.sh`  | suites and their versions, skills, documents, MCP servers and Test start, secrets, configurations, the system endpoints        |
| `scripts/phase2-smoke.sh`  | a 3 × 2 × 2 experiment in containers followed live, every read API, pause, resume and cancel                                   |
| `scripts/phase3-smoke.sh`  | all eight check types right and wrong, the judge through egress, re-score (recreates the api once; `SMOKE_RESTART=0` skips it) |
| `scripts/phase4-smoke.sh`  | the comparison: one experiment `better`, one `inconclusive`, one not computable; the verdict history                           |
| `scripts/phase6-smoke.sh`  | `invoices-v1` with and without its skill, home seeds, memory files, skill loading, both sample MCP servers                     |
| `scripts/phase6b-smoke.sh` | every sample suite's recommended experiment (212 runs) and its predicted verdict                                               |
| `scripts/phase5b-smoke.sh` | suite authoring through the API: a suite from nothing to an experiment, conflicts, imports, round trips, verifier containers   |

`SMOKE_RESTART=1 scripts/phase6-smoke.sh` also recreates egress without `VENDOR_DIRECTORY_TOKEN` and then with it; run it from the shell that exported the token. `BASE_URL=http://localhost:8080/api` runs any of them through nginx. To walk the design's flows in the browser instead: `scripts/flows-setup.sh` and the checklist in [`docs/flows.md`](docs/flows.md).

## Development

Node 22.12+ (22.18+ for the generators), pnpm 11 (`corepack enable`), and python3 for the API tests (verifier self-checks run it).

```bash
pnpm install
docker compose up -d postgres                  # or your own Postgres; .env's DATABASE_URL points at it
pnpm dev                                       # shared, api (:3000) and web (:5173) in watch mode, via Turbo
pnpm --filter @hermes-evals/api dev:worker     # the worker, in a second terminal
```

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` run across every package through Turbo (`pnpm turbo run typecheck lint test build`). `pnpm test` runs the unit tests and the integration tests on PGlite (the real migrations and triggers, in process), every generator's `--check`, and the five suites through the real loader.
- `packages/shared` holds the zod contracts both apps use, consumed through its built `dist`: after editing it, `pnpm --filter @hermes-evals/shared build` (the Turbo tasks do this for you).
- The web dev server proxies `/api` to :3000. `VITE_API_MODE=fixtures pnpm --filter @hermes-evals/web dev` serves the sample data in `apps/web/src/fixtures` instead of the API, and `?scenario=<name>` on any URL shows a designed state (`apps/web/src/fixtures/scenarios.ts`). How pages are built: `apps/web/CONTRIBUTING.md`.
- **Postgres 17 end-to-end tests** boot the whole API and worker on a fresh database per spec, against a throwaway server, never the Compose database (the run refuses port 5432 and stops without `TEST_DATABASE_URL`):

  ```bash
  docker run -d --name hermes-evals-pg-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:55433:5432 postgres:17-alpine
  TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
  ```

  They run two files at a time on the server's default 100 connections (four with `-c max_connections=200`).

- **Gated tests** that start real containers run only with `RUN_SANDBOX_TESTS=1`: the trial image, verifier and MCP containers through a docker-guard socket (`DOCKER_SOCKET`, `TRIALS_DIR`, `TRIAL_IMAGE`, `TRIAL_VOLUME`; `docs/phases/phase-1.md` section 6.1 shows a host guard), and, with the Docker CLI alone, Hermes's MCP renderer and the Nous login against a fake portal on an internal network. The worker started with `pnpm dev:worker` and no guard cannot run verifier scripts, so a suite with one records a load error.

## Linux

Linux with native Docker is untested. Compose and the images are the same, but the worker writes `./suites` (when it saves a suite edited in the web app) as uid 10000, which on Linux, unlike macOS, is a real uid on your files. The expected setup is an ACL that lets uid 10000 write there while you keep owning new files:

```bash
sudo setfacl -R -m u:10000:rwX,d:u:10000:rwX,d:u:$(id -u):rwX suites
```

## Troubleshooting

- **`error getting credentials … docker-credential-desktop: executable file not found`** on Colima: Docker Desktop was installed once and left `"credsStore": "desktop"` in `~/.docker/config.json`. Put its helpers on your `PATH` (`export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"`) or remove that line.
- **The suites list is empty, or `mock-model` will not start ("bind source path does not exist")**: the Docker VM cannot see your clone. On Colima keep it under your home directory, or start Colima with `--mount <dir>:w`.
- **A port is taken**: another service holds 8080, 3000 or 5432 on 127.0.0.1. Stop it, or change the left-hand side of that service's `ports:` in `docker-compose.yml`.
- **System › Sandbox reads not proven**: the worker refuses experiments until its isolation self-test passes. The failing check's detail says why; `docker compose logs worker` has the rest.

## Upgrading a stack from before Phase 7

Compose used to give egress `Bearer <token>` and now gives it the raw token, so a `vendor-directory` definition saved without a prefix sends the bare token and vendor-directory answers 401 (its Test fails, and so does every `mcp-v1` task at its first vendor call). In Resources › MCP servers, edit `vendor-directory` and give its pair the header `Authorization`, prefix `Bearer `, from `VENDOR_DIRECTORY_TOKEN`. A definition a configuration has used becomes its next version, and configurations keep the version they were saved with: edit each configuration that uses it (`with-mcp` for `mcp-v1`), add the new version from its MCP servers row (it replaces the old one) and save. An http server of your own whose variable holds `Bearer <key>` keeps working unchanged.

Rebuild the images before anything reloads the suites (`docker compose … up -d --build`). A worker still running an older image loads the seven `task.yaml` files that gained `answers_from_fixtures` as invalid tasks in a new version; the first load after the rebuild makes the next version, valid again.

## Layout

```
apps/api          NestJS: HTTP API, SSE, pg-boss producer (src/main.ts), worker (src/worker.ts), sandbox client (src/sandbox)
apps/docker-guard The only holder of the Docker socket: a filtered Docker API for trial and verifier containers
apps/egress       The trials' only way out: forward proxy, model gateway, MCP gateway; and the scripted mock model
apps/web          Vue 3, Vite, Pinia, vue-router, Tailwind CSS v4
packages/shared   Domain types and the zod contracts both apps use
suites/           Task suites, loaded by the worker; edited on disk or in the web app
samples/          The skills (samples/skills) and documents (samples/documents) the suites' recommended arms use
scripts/          Smoke scripts and mock-model scripts; scripts/fixtures: the suite generators
config/           prices.yaml: model prices an experiment freezes at launch
docker/           Dockerfiles, nginx config, nous-login.py, mcp/: the sample MCP servers
docs/             phases/: what each phase built and how it was checked; flows.md: the walk of the flows in the browser
```
