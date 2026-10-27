# Hermes Evals

An evaluation platform for [Hermes Agent](https://github.com/NousResearch/hermes-agent). You write tasks and say how each is scored, define the agent configurations you want to compare (model, skills, memory, toolsets, MCP servers, documents), and run every task under every configuration several times, each run in a locked-down container of its own. You get a verdict, `better`, `worse` or `inconclusive`, with a 95% confidence interval, and the evidence behind every run: the agent's timeline of model and tool calls, its answer, each check's score and the files it wrote.

It runs on your machine with Docker Compose: a NestJS API and worker, a Vue 3 web app, PostgreSQL with pg-boss for durable jobs, and three small services that keep trials isolated. TypeScript throughout, in a pnpm and Turborepo monorepo. Five sample suites, the skills, documents, MCP servers and configurations they use, and a scripted mock model come with it. One command starts it all, so everything can be tried without a model account and without spending money.

## Documents and the real experiment

- [docs/design.md](docs/design.md): architecture, the life of a run, scoring, statistics, key decisions and assumptions.
- [docs/limits.md](docs/limits.md): what the results can and cannot tell you, and the known limits.
- [docs/costs.md](docs/costs.md): what runs cost, measured on the real model, and what the machine needs.
- [docs/results.md](docs/results.md): the real experiment. Does the `invoice-method` skill help GPT-6.1 Sol on `invoices-v1`? 12 tasks × 2 configurations × 5 repetitions: both passed 60 of 60, a difference of +0.000 [0.000, 0.000], **inconclusive**: no measurable gain, at 12% more cost with the skill. The same document reports the four capability suites on the real model, where tools, knowledge and memory did change results.
- [docs/video-script.md](docs/video-script.md): the shot list for the demo video.
- [AGENTS.md](AGENTS.md): how a coding agent should work in this repository.
- [docs/phases/](docs/phases/): one document per build phase, with its decisions, tests and open questions.

## Requirements

- **macOS** with [Colima](https://github.com/abiosoft/colima) or Docker Desktop. Both were installed from a clean clone and checked on 27 Oct 2026 (Apple silicon, 16 GB: Colima 0.10.3 with Docker Engine 29.5, and Docker Desktop 4.96 with Engine 29.9; Compose 5.6). Linux with native Docker is untested: see [Linux](#linux).
- **Docker Engine 28 or newer** (the trial networks use its isolated gateway mode), **Compose 2.24 or newer** and buildx. On Colima: `brew install colima docker docker-compose docker-buildx`.
- **Memory**: give the Docker VM 6 GB (`colima start --cpu 4 --memory 6 --disk 60`, or Docker Desktop's Settings › Resources). Three trials run at once, each capped at 1.5 GB. Measured with the mock model: the running stack used about 2.3 GB of the VM while three trials ran (2.4 GB on Docker Desktop), and the first build up to 2.3 GB on Colima's 4 CPUs (4.3 GB on Docker Desktop's 10, which builds more at once).
- **Disk**: the first build leaves about 10 GB in the Docker VM on Colima and 15 GB on Docker Desktop: the images (the Hermes trial image alone is 4.5 GB) and about 4 GB of build cache that `docker builder prune` gives back. Each run adds little: its home is deleted when it ends and its workspace after `TRIAL_RETENTION_DAYS` (7). A 60 GB VM disk was tested; Colima's default is 100 GB.
- **Network** for the first build: Docker Hub (the pinned Hermes image is a 1.1 GB download), the npm registry and Debian's package mirrors. The first `up --build` took 11 minutes on Colima over a 3 MB/s connection and 2 minutes on Docker Desktop over a faster one, most of it downloading; the worker was online, its sandbox proven, within 35 s of that. A rebuild after a code change takes about a minute.
- **Free ports on 127.0.0.1**: 8080 (web app), 3000 (API) and 5432 (Postgres). All three are bound to loopback only.
- **On Colima, keep the clone under your home directory.** Colima shares only your home with its VM unless told otherwise, and Compose bind-mounts `./suites`, `./config`, `./samples` and the mock's scripts from the clone. Docker Desktop shares `/Users`, `/private` and `/tmp` by default.

## Quick start with the mock model

```bash
git clone https://github.com/sasuke007/hermes-evals.git && cd hermes-evals
docker compose up -d --build
```

No `.env` and no profile are needed. The first start builds the images (see Requirements for the time it takes) and starts every service: the platform, `mock-model`, a scripted OpenAI-compatible model that plays the scripts in `./scripts` and costs nothing, and the two sample MCP servers. The mock is also the LLM judge, which `invoices-v1` and `knowledge-v1` each need for one check. The worker loads the five suites, and the api adds the samples the database lacks:

- the four skills of `samples/skills` and the eight documents of `samples/documents`;
- the MCP servers `invoice-db` and `vendor-directory` ([below](#the-sample-mcp-servers));
- each suite's recommended configurations, declared in `samples/configurations.yaml`, twice: `<suite>-<arm>-mock` on the mock model, free, and `<suite>-<arm>` on Nous Portal with `openai/gpt-6.1-sol`, which needs the Nous login and costs money ([Real models](#real-models)). 26 configurations in all.

The seed runs at every api start and skips what exists (configurations and MCP servers by name, skills and documents by name and content), so it never changes what you edited. `SEED_SAMPLES=false` in `.env` turns it off.

| What     | Where                                                     |
| -------- | --------------------------------------------------------- |
| Web app  | http://localhost:8080                                     |
| API      | http://localhost:3000/api (OpenAPI docs at `/api/docs`)   |
| Postgres | localhost:5432, user and password `hermes`, loopback only |

Open http://localhost:8080 and go to **System**. A healthy stack shows Sandbox "Isolation proven · 16 of 16 checks", Hermes `hermes-agent v0.22.4 @ 4d04303`, and one worker online with its sandbox proven. Judge and samples shows the judge (the mock model) and what the seed created and skipped: 40 samples created on a first start. Model access lists Nous Portal as not connected until you log in (below); the mock needs nothing there.

Then go to **Experiments** and press **Run a sample experiment** (New experiment has it under its title too). It launches `invoices-v1` with `invoices-v1-baseline-mock` as the baseline against `invoices-v1-with-skill-mock`, every task, 2 repetitions: 48 runs on the mock, which cost nothing.

It takes about two minutes and reads `better`, Δ +0.667: without the skill the mock falls into eight of the twelve tasks' traps, with it into none (pass rates 8/24 → 24/24). Click any cell of the comparison to open that run in the inspector. To launch the same by hand: **Experiments › New experiment**, suite `invoices-v1`, the configurations `invoices-v1-baseline-mock` (the baseline) and `invoices-v1-with-skill-mock`, 2 repetitions.

`.env` is optional. Copy `.env.example` to `.env` only for what the defaults cannot know: a real provider's API key, `NOUS_HOST_PROXY` to reuse this machine's Nous login (or Connect Nous Portal on System instead), and a real LLM judge ([Real models](#real-models)). Compose reads each setting from your shell first, then `.env`.

## The five suites and the samples

A suite is a directory under `suites/`; the worker loads every one at start and on Suites › Reload all from disk. Each of the five measures one thing a configuration can vary, and its `suite.yaml` names the experiment that measures it: configurations that differ only there. Every task has a trap, and every task can be answered in every arm; the dimension decides how well.

| Suite          | Tasks | Recommended experiment (baseline first)                 | What the arms need                                                                                                                                                                                                              |
| -------------- | ----- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoices-v1`  | 12    | `baseline` · `with-skill`                               | the skill `invoice-method`, preloaded                                                                                                                                                                                           |
| `mcp-v1`       | 8     | `docs-export` · `with-mcp`                              | the documents `samples/documents/mcp-v1/invoices.csv` and `vendors.json` (under exactly those names) in `docs-export`; the MCP servers `invoice-db` and `vendor-directory` (named so, with the definitions below) in `with-mcp` |
| `memory-v1`    | 8     | `memory-off` · `memory-on`                              | nothing: every task seeds the same memory files, which go into the home only with memory on                                                                                                                                     |
| `knowledge-v1` | 8     | `none` · `docs` · `skills-preload` · `skills-on-demand` | the six documents of `samples/documents/knowledge-v1/`, or the skills `bx7-format`, `house-style` and the decoy `bx6-format`                                                                                                    |
| `tools-v1`     | 6     | `file` · `file-terminal` · `file-terminal-code`         | nothing: the arms are the toolsets `file`, `file` + `terminal` and `file` + `terminal` + `code_execution`                                                                                                                       |

The seed makes each arm twice, `<suite>-<arm>-mock` on the mock model and `<suite>-<arm>` on a real one (for example `memory-v1-memory-on-mock` and `memory-v1-memory-on`). Apart from what the table names, the arms are alike: toolsets `file` and `terminal` (`tools-v1` varies only them), memory off (`memory-v1` varies only it), no skills, documents or MCP servers. The `-mock` arms have max turns 10 and a 180 s budget (30 turns and 600 s for `mcp-v1`, where one task makes 18 model calls), the real arms 30 turns and 600 s. With the mock model every recommended experiment reads `better`: `invoices-v1` Δ +0.667, `mcp-v1` Δ +1.000, `memory-v1` Δ +0.625, `knowledge-v1` Δ +0.875 for each knowledge arm, `tools-v1` Δ +0.833 for each tool arm.

The samples the arms use live under `samples/`: the skills in `samples/skills/`, the documents in `samples/documents/` (each stored under its own file name: the prompts name the files, and the workspace's `docs/` keeps the names), and the arms in `samples/configurations.yaml`. The api seeds them at start. To upload a skill by hand, zip its folder with its files at the zip's root:

```bash
for s in invoice-method bx7-format house-style bx6-format; do (cd samples/skills/$s && zip -r ../../../$s.zip .); done
```

Every suite, references included, is written by a generator in `scripts/fixtures/` run with plain Node 22.18+ (fixed seed, the same bytes every time), which also writes the suite's mock scripts; `--check` exits 1 naming each file that differs. Edit a generator, never the generated files:

```bash
node scripts/fixtures/invoices-v1.ts               # also mcp-v1.ts, memory-v1.ts, knowledge-v1.ts, tools-v1.ts, sample-mcp.ts
node scripts/fixtures/mcp-v1.ts --check
```

### The sample MCP servers

Two sample MCP servers serve generated data that agrees (every vendor in the ledger is in the directory). `mcp-v1` needs both, under these names, so that its tool names come out as `mcp__invoice_db__*` and `mcp__vendor_directory__*`. Both run on every start, and the api defines both at its first start (Resources › MCP servers):

- `invoice-db`, stdio, baked into the trial image: a ledger of 120 invoices, `list_invoices(status?, vendor_name?, cursor?)` 20 rows a page, `get_invoice`, and `update_invoice` and `delete_invoice`, which never write. Defined with command `invoice-db-mcp` and the variable `INVOICE_DB_URL`, which Compose gives the worker as `file:///opt/mcp/invoice-db/invoices.csv` unless your shell or `.env` sets it.
- `vendor-directory`, http and read-only: `list_vendors(status?, cursor?)` and `get_vendor(name)` on a network only egress shares, so a trial reaches it only through egress's MCP gateway. It answers 401 without `Authorization: Bearer <token>`. Unless `VENDOR_DIRECTORY_TOKEN` is set, Compose gives vendor-directory and egress the same fixed sample token, `hermes-evals-sample-token`: enough for a sample server on an internal network, but set your own for anything real: `VENDOR_DIRECTORY_TOKEN` in `.env`, any random string such as the output of `openssl rand -hex 16`, then `docker compose up -d egress vendor-directory`. Compose gives egress the raw token and blanks it for the api and the worker. Defined with URL `http://vendor-directory:8000/mcp` and the header `Authorization` with the prefix `Bearer ` from `VENDOR_DIRECTORY_TOKEN`.

## Real models

Every model call a trial makes goes through egress, which holds the credentials; nothing secret enters a trial. Prices for cost and the spend guard come from `config/prices.yaml` (an experiment freezes it at launch; a model it does not list shows its cost as unknown, never zero). The seeded configurations without `-mock` (`invoices-v1-baseline`, `memory-v1-memory-on`, …) run `openai/gpt-6.1-sol` on Nous Portal: they need the login below, and every run costs money.

- **Nous Portal, one-time login**: System › Model access › Connect, then approve in the browser. `nous-login` writes the login into the `nous-home` volume and `nous-proxy` serves model calls from it; the token never leaves that volume, and the login survives restarts. Until there is a login, `nous-proxy` only checks for one every 5 s, without starting Hermes. Without a browser: `docker compose run --rm --entrypoint /opt/hermes/.venv/bin/hermes nous-proxy auth add nous --type oauth --no-browser`.
- **Nous Portal, reusing this machine's Hermes login** (development): run `hermes proxy start --provider nous` on the host and set `NOUS_HOST_PROXY=host.docker.internal:8645` in `.env`. Nothing is copied; egress forwards Nous calls to the host proxy, Model access shows Nous as `host`, and Connect is refused. Any container in the Docker VM can reach that proxy, so do this only on a machine you trust.
- **API keys**: `OPENROUTER_API_KEY`, `NOUS_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in `.env` (`cp .env.example .env` first), then `docker compose up -d egress worker`. Only egress reads them; Compose blanks them for every other service.
- **Any OpenAI-compatible endpoint**: a configuration with provider `custom` and its base URL (that is how the mock is used); egress sends `CUSTOM_API_KEY` from `.env` when it is set.
- **The LLM judge** (`llm_judge` checks) uses a check's own `model:`, else `JUDGE_MODEL`, on `JUDGE_PROVIDER`. Compose makes the mock model the judge unless your shell or `.env` sets one: free, and right for the `-mock` configurations, but its scores mean nothing on a real model's answers. New experiment warns when an experiment would have the mock judge a real model, and so does the launch's answer; neither blocks it. For a real judge set both `JUDGE_PROVIDER` and `JUDGE_MODEL` in `.env` (for example `nous` and `openai/gpt-6.1-sol`), then `docker compose up -d api worker`: `JUDGE_MODEL` alone keeps the mock, `JUDGE_PROVIDER` alone leaves the judge no model (the default `mock/scripted` is ignored beside any provider but `custom`), and `JUDGE_BASE_URL` is used only with `JUDGE_PROVIDER=custom`, where System and New experiment warn if `JUDGE_MODEL` is still `mock/scripted`. System › Judge and samples shows which judge is in use. Launch answers 409 for a task whose judge has no model, or while the judge's provider is not ready.

The model gateway serves one attempt at most `MODEL_TOKEN_CAP_PER_ATTEMPT` tokens (2,000,000 by default) and then refuses, so a runaway agent stops at once. `.env.example` lists every setting with its default.

## How it works

The services: `postgres`; `api` (HTTP and live updates); `worker` (loads and saves suites, runs every trial in its own container, scores runs, recovers lost ones); `web` (nginx serving the app and proxying `/api`); `docker-guard`, the only holder of the Docker socket, which lets the worker start nothing but trial and verifier containers; `egress`, the trials' only way out (forward proxy, model gateway, MCP gateway); `nous-proxy` and `nous-login` (Nous Portal); `mock-model`, the scripted model, which is also the default LLM judge; `vendor-directory`, the sample http MCP server; and `trial-image`, which builds the pinned Hermes image and exits.

- **Isolation.** Every trial runs Hermes v0.22.4 in its own container from a read-only image, as an unprivileged user, seeing only that attempt's home and workspace, on an internal network whose only reachable host is egress. Egress refuses every private, loopback, host and Docker address. A suite's verifier scripts run the same way, each in a container with no network at all. The worker proves this with an isolation self-test on every start and refuses to run experiments if a check fails; System › Sandbox shows each check. To run the checks by hand: `docker compose run --rm --no-deps worker node dist/sandbox-cli.js selftest`.
- **Scoring.** A task's checks can be any of eight types: `numeric_tolerance`, `json_match`, `exact_match`, `text_match`, `file_check`, `verifier_script` (Python), `trajectory_match` (the agent's tool calls) and `llm_judge`. The worker scores each run from its stored evidence, never by running Hermes again, and Re-score grades runs again as a new generation.
- **Comparison.** Per-task pass rates, the mean per-task difference with a 95% interval from a paired bootstrap over tasks (10,000 resamples, seeded from the experiment id), the verdict, a sensitivity figure without runs that broke, and secondary metrics. With one repetition or fewer than 3 tasks there is no interval, and the page says why.
- **Authoring.** Suites can be written by hand under `suites/` or in the web app (Suites › New suite: empty, a copy, or a `.zip`; tasks imported from CSV or JSONL). The files stay the source of truth: an edit goes into a draft, and saving writes the suite's folder through the worker and loads it like a reload. `verify/` scripts are code, so the web app never writes them; they arrive only in a `.zip` you mark as trusted.
- **No login.** The API has no authentication and listens on loopback. Every POST, PUT, PATCH and DELETE must carry an `X-Requested-With` header and a JSON or multipart body, which another site open in your browser cannot send.
- One worker per Docker daemon is the supported setup. Stopping the worker hands its running trials back to the queue.

Design and decisions in detail: `IMPLEMENTATION_PLAN.md`; what each phase built and how it was checked: [`docs/phases/`](docs/phases); the UI flows: `UI_FLOWS.md`.

## Checking a stack end to end

The smoke scripts drive a running stack over HTTP, with real Hermes in real trial containers against the mock model, and print one PASS/FAIL line per step. They write to the stack they check (names start with `smoke-<timestamp>`, suite folders `suites/zz-smoke-…` are removed again), so use a development stack. The quick start's `docker compose up -d --build` serves them all, as long as neither your shell nor `.env` changes the defaults they rely on: the mock judge (`JUDGE_*`), the mock's scripts (`MOCK_SCRIPTS_FILE=./scripts`), `INVOICE_DB_URL` and a `VENDOR_DIRECTORY_TOKEN` that is not empty.

| Script                     | Checks                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/phase1-smoke.sh`  | suites and their versions, skills, documents, MCP servers and Test start, secrets, configurations, the system endpoints        |
| `scripts/phase2-smoke.sh`  | a 3 × 2 × 2 experiment in containers followed live, every read API, pause, resume and cancel                                   |
| `scripts/phase3-smoke.sh`  | all eight check types right and wrong, the judge through egress, re-score (recreates the api once; `SMOKE_RESTART=0` skips it) |
| `scripts/phase4-smoke.sh`  | the comparison: one experiment `better`, one `inconclusive`, one not computable; the verdict history                           |
| `scripts/phase6-smoke.sh`  | `invoices-v1` with and without its skill, home seeds, memory files, skill loading, both sample MCP servers                     |
| `scripts/phase6b-smoke.sh` | every sample suite's recommended experiment (212 runs) and its predicted verdict                                               |
| `scripts/phase5b-smoke.sh` | suite authoring through the API: a suite from nothing to an experiment, conflicts, imports, round trips, verifier containers   |

`SMOKE_RESTART=1 scripts/phase6-smoke.sh` also recreates egress without `VENDOR_DIRECTORY_TOKEN` and then with it; run it from a shell that gives Compose the same token as the start did (none, for the sample token or one in `.env`). `BASE_URL=http://localhost:8080/api` runs any of them through nginx. To walk the design's flows in the browser instead: `scripts/flows-setup.sh` and the checklist in [`docs/flows.md`](docs/flows.md).

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
- The api's samples seed reads `SAMPLES_DIR`, `./samples` from where the api runs: under `pnpm dev` that is `apps/api`, so set `SAMPLES_DIR=../../samples` in `.env`, or `SEED_SAMPLES=false`. Otherwise System shows the seed failed, with "no samples folder".
- The web dev server proxies `/api` to :3000. `VITE_API_MODE=fixtures pnpm --filter @hermes-evals/web dev` serves the sample data in `apps/web/src/fixtures` instead of the API, and `?scenario=<name>` on any URL shows a designed state (`apps/web/src/fixtures/scenarios.ts`). How pages are built: `apps/web/CONTRIBUTING.md`.
- **Postgres 17 end-to-end tests** boot the whole API and worker on a fresh database per spec, against a throwaway server, never the Compose database (the run refuses port 5432 and stops without `TEST_DATABASE_URL`):

  ```bash
  docker run -d --name hermes-evals-pg-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:55433:5432 postgres:17-alpine -c max_connections=200
  TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
  ```

  The run sizes its parallelism from the server's `max_connections`: with 200 it runs four files at a time (about 90 s), on the default 100 two (about 3 minutes).

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
- **System › Judge and samples reads the seed failed**, or **Run a sample experiment** is disabled: the reason is on the page. "no samples folder at /samples" means the Docker VM cannot see your clone (as above); "the database was not reachable at start" goes away with `docker compose restart api`, which seeds again. A single sample that failed is listed with its reason, and `docker compose logs api` has the rest.

## Upgrading a stack from Phase 7

Pull, then `docker compose up -d --build`. `mock-model` and `vendor-directory` now run on every start: `--profile test` and `--profile samples` are still accepted and change nothing. The four lines Phase 7's quick start appended to `.env` (`MOCK_SCRIPTS_FILE` and `JUDGE_*`) are now the defaults and can go. An `.env` copied from Phase 7's `.env.example` holds `VENDOR_DIRECTORY_TOKEN=` with no value, which now means no token: vendor-directory stops at start and `mcp-v1`'s `with-mcp` arm cannot launch. Give it a value, or delete the line for the sample token. At its next start the api seeds the samples, skipping what exists by name, so `invoice-db` and `vendor-directory` as you defined them are kept.

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
samples/          The skills (samples/skills), documents (samples/documents) and recommended arms (configurations.yaml) the api seeds
scripts/          Smoke scripts and mock-model scripts; scripts/fixtures: the suite generators
config/           prices.yaml: model prices an experiment freezes at launch
docker/           Dockerfiles, nginx config, nous-login.py, mcp/: the sample MCP servers
docs/             phases/: what each phase built and how it was checked; flows.md: the walk of the flows in the browser
```
