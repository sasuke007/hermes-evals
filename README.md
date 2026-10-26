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

The services: `postgres`; `api` (HTTP and live updates); `worker` (loads suites and saves the ones edited in the web app, runs every trial in its own container, scores runs, recovers lost ones); `web`; `docker-guard` (the only holder of the Docker socket); `egress` (the trials' only way out: forward proxy, model gateway and MCP gateway); `nous-proxy` and `nous-login` (the Nous Portal login, see below); and `trial-image`, which builds the trial image and exits. `mock-model`, a scripted OpenAI-compatible model, starts only with `--profile test`, and `vendor-directory`, the sample http MCP server, only with `--profile samples`.

Model access:

- **Nous Portal** (OAuth): in the web app, System > Model access > Connect, and approve in the browser. `nous-login` writes the login into the `nous-home` volume and `nous-proxy` serves model calls from it; no token leaves that volume. Both services start by default and report `not_connected` until then.
- **Nous Portal, reusing this machine's Hermes login** (development): run `hermes proxy start --provider nous` on the host and set `NOUS_HOST_PROXY=host.docker.internal:8645` in `.env`. Nothing is copied: the host proxy keeps the login, and egress forwards to it from its own loopback. Model access then shows Nous as `host` (or `host_unreachable` when the host proxy does not answer), and Connect is refused. Any container in the Docker VM can reach that host proxy, so use this only on a machine you trust.
- **API keys** (OpenRouter, the Nous API, OpenAI, Anthropic): set `OPENROUTER_API_KEY`, `NOUS_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in `.env`, then `docker compose up -d egress worker`.
- **A custom OpenAI-compatible endpoint**: a configuration with provider `custom` and its base URL; egress sends `CUSTOM_API_KEY` from `.env` when it is set. A configuration on `custom` with base URL `http://mock-model:8090/v1` runs against the mock model (`docker compose --profile test up -d mock-model`) at no cost, which is how the platform is checked without a real model; `MOCK_SCRIPTS` in `.env` gives chosen prompts their own scripted answers.

Model prices for cost and the spend guard come from `config/prices.yaml`; an experiment freezes it when it launches. A model it does not list is unpriced: its cost shows as unknown, never as zero. The model gateway serves one attempt at most `MODEL_TOKEN_CAP_PER_ATTEMPT` tokens (2,000,000 by default), then answers 402 with `x-should-retry: false`, so Hermes stops at once instead of retrying; a run stopped there is `execution_error · limit`, never retried automatically. Every call counts toward it: streamed calls are sent with `stream_options.include_usage` on, and a call that answers without reporting usage is charged an estimate from its size, so an agent calling the gateway itself cannot slip past the cap or the spend guard.

Scoring and re-score:

- The worker scores each executed run from its stored evidence, never by running Hermes again. A task's checks can be any of eight types: `numeric_tolerance`, `json_match`, `exact_match`, `text_match` (phrases and a regular expression looked for in the answer), `file_check`, `verifier_script`, `trajectory_match` (the agent's tool calls) and `llm_judge` (a rubric graded by a model).
- The LLM judge's model is a check's own `model:`, else `JUDGE_MODEL`, on `JUDGE_PROVIDER` (`nous` when unset); `JUDGE_BASE_URL` only for `custom`. All three are unset by default, so launch and Re-score answer 409 for a selected task whose `llm_judge` check has no `model:` until `JUDGE_MODEL` is set (`.env`, then `docker compose up -d api worker`). The judge's calls go through egress's admin socket like a trial's model calls: the worker holds no provider key, and each call is metered and priced into its score's evidence as grading cost, outside the spend guard. Launch and Re-score answer 409 while the judge's provider is not ready. To grade with the mock model: `JUDGE_PROVIDER=custom JUDGE_MODEL=mock/scripted JUDGE_BASE_URL=http://mock-model:8090/v1`.
- Re-score (`POST /api/runs/:id/rescore`, or several runs at once with `POST /api/experiments/:id/runs/rescore`) grades a scored run again with the scorers as they are now, as a new evaluation generation. The run keeps its previous result until the new one publishes, and a second request while one is pending joins it.

Comparison and verdict:

- `GET /api/experiments/:id/comparison?candidate=&key=&filter=` compares one candidate with the baseline task by task: pass rates per task and pooled, the mean per-task difference with a 95% interval from a paired bootstrap over tasks (10,000 resamples, seeded from the experiment id, so the same results always give the same interval), the verdict (`better` when the interval is above 0, `worse` when below, else `inconclusive`; `provisional` while running), a sensitivity figure without runs that broke, and secondary metrics. `key` is `primary` (each task's own primary key, the default), `any_failed`, or a key every selected task declares. With one repetition, fewer than 3 tasks, or fewer than 2 counted runs of a task under a configuration, there is no interval and the answer says why. The answer is cached by the experiment's results revision, which moves on every run status change and every published re-score, so it is never stale.
- When an experiment completes, and again after a retry or a re-score changes its results, one verdict entry per candidate is appended to its history (cause `initial`, `retry` or `rescore`); the experiment list, its Overview and the live stream show the latest, and the Overview the ones before it.

MCP server secrets also go in `.env`, by the env name the server definition lists: a stdio server's values are read by the worker, an http server's header values by egress, which adds them in its MCP gateway (`http://egress:8080/mcp/<name>`) as the whole header value (so a Bearer API needs `Bearer <key>` in the variable). The database and the UI only ever see the names. Launch answers 409 while a chosen configuration's server names a variable that is not set where it is read, and New experiment shows which before Launch.

The two sample MCP servers serve generated data that agrees (every vendor in the ledger is in the directory):

- `invoice-db` (stdio, baked into the trial image): a ledger of 120 invoices with a free-text `notes` column, `list_invoices(status?, vendor_name?, cursor?)` 20 rows a page, `get_invoice`, and `update_invoice` and `delete_invoice`, which never write. It needs `INVOICE_DB_URL` (see `.env.example`).
- `vendor-directory` (http, read-only, `docker compose --profile samples up -d`): `list_vendors(status?, cursor?)` and `get_vendor(name)` at `http://vendor-directory:8000/mcp`, on a network only egress shares, so a trial reaches it only through egress's MCP gateway. It answers 401 without `Authorization: Bearer <VENDOR_DIRECTORY_TOKEN>`: set `VENDOR_DIRECTORY_TOKEN` in `.env` to any random string (`openssl rand -hex 16`), and Compose gives egress the `Bearer ` value and blanks it for the api and the worker. Its definition: name `vendor-directory`, transport http, URL `http://vendor-directory:8000/mcp`, header `Authorization` from `VENDOR_DIRECTORY_TOKEN`.

Their data is written by `node scripts/fixtures/sample-mcp.ts` (fixed seed; `--check` exits 1 when a file on disk differs), and `docker/mcp/check_samples.py` checks both servers inside the vendor-directory image:

```bash
docker compose --profile samples build vendor-directory
docker run --rm --network none -v "$PWD/docker/mcp:/checks:ro" --entrypoint /opt/hermes/.venv/bin/python \
  hermes-evals/vendor-directory /checks/check_samples.py
```

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

Check the comparison and the verdicts live (Phase 4, nothing costs money): a temporary suite of four tasks, a skill and three configurations; one experiment where the configuration with the skill improves three tasks of four reads `better`, one where a twin of the baseline answers the same on three tasks stays `inconclusive`, and one with a single repetition is not computable; then the comparison's key selector, filters and refusals, the verdict entry each completion appends, the list's chips, and a re-score that appends a second entry. It needs the Phase 4 mock scripts and no judge:

```bash
MOCK_SCRIPTS="$(python3 -c 'import json; print(json.dumps(json.load(open("scripts/phase4-mock-scripts.json"))))')" \
  docker compose --profile test up -d
scripts/phase4-smoke.sh                            # curl and python3; BASE_URL defaults to http://localhost:3000/api
```

Its suite directory is `suites/zz-smoke-stats-<timestamp>`, deleted again at the end.

Check Phase 6 live (the platform additions and `invoices-v1`, about 5 minutes, nothing costs money): the generators reproduce their bytes, `invoices-v1` loads 12 of 12 valid, the `invoice-method` skill uploads, and the mock experiment `baseline` against `with-skill` passes every task with the skill and falls into eight traps without it; then a temporary suite (written by `scripts/fixtures/phase6-smoke.ts`) shows each addition reaching the run: a skill preloaded with `-s` and loaded on demand through the `skills` toolset, a seeded `USER.md` that reaches the prompt only with memory on, the memory file the agent saves collected from its home and scored, the model calls counted, `vendor-directory` answering only through egress, `invoice-db` paging 20 invoices with a cursor, and the launch 409 for an MCP variable that is not set (a stdio one the worker lacks, and `VENDOR_DIRECTORY_TOKEN` with egress recreated without it, then put back). It needs the mock scripts, the mock as the judge, `INVOICE_DB_URL`, and for the vendor checks the `samples` profile with `VENDOR_DIRECTORY_TOKEN` set, all from the shell or `.env`. Give the mock every `scripts/*mock-scripts.json`: each script matches a phrase only its own runs hold, so their order does not matter and every smoke test passes on the same stack (`apps/api/test/phase6b-mock-scripts.spec.ts` and `phase6-smoke.spec.ts` check it):

```bash
export VENDOR_DIRECTORY_TOKEN="$(openssl rand -hex 16)" INVOICE_DB_URL=file:///opt/mcp/invoice-db/invoices.csv
MOCK_SCRIPTS="$(python3 -c 'import glob, json; print(json.dumps([s for f in sorted(glob.glob("scripts/*mock-scripts.json")) for s in json.load(open(f))]))')" \
JUDGE_PROVIDER=custom JUDGE_MODEL=mock/scripted JUDGE_BASE_URL=http://mock-model:8090/v1 \
  docker compose --profile test --profile samples up -d --build
scripts/phase6-smoke.sh                            # curl, python3 and node; BASE_URL defaults to http://localhost:3000/api
SMOKE_RESTART=1 scripts/phase6-smoke.sh            # also recreate egress without VENDOR_DIRECTORY_TOKEN, then with it
```

With `SMOKE_RESTART=1`, run the smoke from the same shell: the step that recreates egress puts its token back from there (or from `.env`), after checking by hash that it is the one egress had; without it that step prints a SKIP line. Its suite directory is `suites/zz-smoke-p6-<timestamp>`, deleted again at the end. The skill `smoke-phase6-lookup` and the MCP servers `vendor-directory` and `invoice-db` keep fixed names (the mock scripts name them), so a second run reuses them.

Check the five sample suites live (Phase 6b, nothing costs money): on the same stack and with the same start, `scripts/phase6b-smoke.sh` checks the generators, reloads the five suites (42 tasks valid), uploads or reuses their skills and documents, creates each suite's recommended configurations and runs its mock experiment at 2 repetitions (212 runs), then checks each experiment's per-task results and verdict against what its mock scripts predict, and the dimension in the runs: the memory seeds in the system prompt only with memory on, the skills preloaded or opened with `skill_view`, the documents read from `docs/`, the MCP calls through both servers, the terminal's and `execute_code`'s results only in the arms that have them, and in the mock's request log the script that answered each run's last request. `SMOKE_SUITES="mcp-v1 tools-v1"` runs only some of the experiments:

```bash
scripts/phase6b-smoke.sh                           # curl, python3 and node; BASE_URL defaults to http://localhost:3000/api
```

Its configurations and experiments are named `smoke-<timestamp>-<suite>-…`; it changes nothing under `suites/`.

Walk Flows A to D in the browser (the design's four flows, with real Hermes and the mock model): `scripts/flows-setup.sh` writes a suite, a skill zip and the mock's scripts, and `docs/flows.md` is the checklist, step by step with what each page should show.

## Suites, generators and the sample skills

A suite is a directory under `suites/` (plan section 4): `suite.yaml`, and per task `task.yaml`, `prompt.md`, `reference.json`, `fixtures/` (copied into the trial's workspace) and, as its checks need, `verify/` scripts, an expected workspace and an LLM judge's rubric. Since Phase 6 a task may also seed the agent's memory with `home/memories/MEMORY.md` and `USER.md` (copied into the trial home in every arm, whatever the configuration's memory setting; the loader warns past Hermes's 2,200 and 1,375 characters or when a file is not a list of entries separated by a line holding only `§`), check what the agent saved with a `file_check` whose `root` is `home` or a verifier script, which always gets `--home <dir>` beside `--answer` and `--workspace`, and give those checks a known-good home in `self_check.expected_home`. Memory on also adds Hermes's `memory` toolset to the run's `-t` list (once, at launch, so the configuration hash is unchanged), so the agent can save to the stores memory puts in its prompt; memory off adds nothing, and Hermes hides the tool whatever `-t` lists. A configuration's skills load `preload` (`-s` per skill, the default) or `on_demand` (installed in the home without `-s`, with the `skills` toolset added so the agent finds them).

The repository ships five suites (plan section 18). Each measures one thing a configuration can vary, and its `suite.yaml` names the experiment that measures it: configurations that differ only there. Every task has a trap, and every task can be answered in every arm; the dimension decides how well.

| Suite          | Tasks | Recommended experiment (baseline first)                               | What the arms need                                                                                                                                                                                                              |
| -------------- | ----- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoices-v1`  | 12    | `baseline` · `with-skill`                                             | the skill `invoice-method`, preloaded                                                                                                                                                                                           |
| `mcp-v1`       | 8     | `docs-export` · `with-mcp`                                            | the documents `samples/documents/mcp-v1/invoices.csv` and `vendors.json` (under exactly those names) in `docs-export`; the MCP servers `invoice-db` and `vendor-directory` (named so, with the definitions below) in `with-mcp` |
| `memory-v1`    | 8     | memory off · memory on                                                | nothing: every task seeds the same memory files in both arms                                                                                                                                                                    |
| `knowledge-v1` | 8     | none · documents · skills preloaded · skills on demand                | the six documents of `samples/documents/knowledge-v1/`, or the skills `bx7-format`, `house-style` and the decoy `bx6-format`                                                                                                    |
| `tools-v1`     | 6     | `file` · `file` + `terminal` · `file` + `terminal` + `code_execution` | nothing                                                                                                                                                                                                                         |

Apart from what the table names, the arms are alike: the `file` and `terminal` toolsets (`tools-v1` varies only them), memory off (`memory-v1` varies only it), and no skills, documents or MCP servers; `mcp-v1` needs 30 turns (one task makes 18 model calls with the servers), the others 10. With the mock model each experiment reads `better`: `invoices-v1` Δ +0.667, `mcp-v1` Δ +1.000, `memory-v1` Δ +0.625, `knowledge-v1` Δ +0.875 for each knowledge arm, `tools-v1` Δ +0.833 for each tool arm (`scripts/phase6b-smoke.sh` checks them).

Upload a skill in Resources > Skills as a zip with its files at the zip's root, and a document in Resources > Documents under its own file name (the workspace's `docs/` keeps the name, and the prompts name the files):

```bash
for s in invoice-method bx7-format house-style bx6-format; do (cd samples/skills/$s && zip -r ../../../$s.zip .); done
```

The two sample MCP servers, as `mcp-v1`'s tool names expect them (`mcp__invoice_db__*`, `mcp__vendor_directory__*`): `invoice-db` is stdio, command `invoice-db-mcp`, variable `INVOICE_DB_URL` (`file:///opt/mcp/invoice-db/invoices.csv` in the worker); `vendor-directory` is http, `http://vendor-directory:8000/mcp` with the header `Authorization` from `VENDOR_DIRECTORY_TOKEN` (Compose profile `samples`, section 3.3 of `docs/phases/phase-6.md`).

Each suite is generated, references included, by a TypeScript file run with plain Node (22.18 or newer, which strips the types; fixed seed, same bytes on every run), which also writes the suite's mock scripts; `--check` exits 1 naming each file that differs from what it would write:

```bash
node scripts/fixtures/invoices-v1.ts               # rewrites invoices-v1's fixtures, references and scripts/phase6-mock-scripts.json
node scripts/fixtures/mcp-v1.ts                    # mcp-v1, samples/documents/mcp-v1, scripts/phase6b-mcp-v1-mock-scripts.json
node scripts/fixtures/memory-v1.ts                 # memory-v1 with its seeds, scripts/phase6b-memory-v1-mock-scripts.json
node scripts/fixtures/knowledge-v1.ts              # knowledge-v1, samples/documents/knowledge-v1, scripts/phase6b-knowledge-v1-mock-scripts.json
node scripts/fixtures/tools-v1.ts                  # tools-v1, scripts/phase6b-tools-v1-mock-scripts.json
node scripts/fixtures/sample-mcp.ts                # the sample MCP servers' data, docker/mcp/
node scripts/fixtures/mcp-v1.ts --check            # the same for each: the repository holds what it generates
```

`mcp-v1` takes its data from the sample servers' (`sample-mcp.ts`), and its documents are the same bytes. `pnpm test` runs every generator's checks, loads the five suites together through the real loader (`apps/api/test/phase6b-suites.spec.ts`), and plays every suite's recommended arms against its mock scripts.

## Authoring suites in the UI

Suites can also be created and edited in the web app (plan section 4.6). The files stay the source of truth: an edit goes into a draft, and saving writes the suite's folder under `suites/` and loads it with the same loader as a reload, so versions, hashes, self-checks and experiment pinning work exactly as for a hand edit, and hand edits keep working.

- **New suite** (Suites › New suite): empty, a copy of a suite version, or a `.zip`. Its name is its folder, `./suites/<name>/`.
- **Drafts.** A suite folder, or a new suite's name, has at most one draft. It saves on every change and lasts until it is saved or discarded; the suite list marks it with a draft chip. The task editor has Form, Files and task.yaml tabs that follow each other (a task.yaml the form cannot show locks the form until it is fixed), and a readiness panel that runs the design's 13 rules on every change without running any of your code: the shared schemas and the loader's own task checks, answer checks scored against the reference, check paths that resolve in the reference, files the prompt mentions, a text fixture that gives the answer away, and file checks without an expected workspace. Problems never block saving: a task with problems is saved as invalid, as on disk. File checks and verifier scripts are self-checked by the worker (Run self-check).
- **Review and save** lists each change and every file it writes, then saves as the next version. The worker builds the folder in `suites/.draft-<id>/` (the loader skips dot names), loads it there, and only then swaps it in with renames, under the folder's lock. Files the draft does not manage (`verify/`, a README) are copied untouched. A folder the loader refuses (a task.yaml that does not parse) is not saved and nothing on disk changes. If the folder moved on after the draft began (a reload made a new version, or files were edited on disk and not reloaded), Save refuses with the tasks both sides changed, and Combine puts the draft on top of the new version, with one choice per task both changed.
- **Import tasks** from CSV or JSONL (5 MB, 500 rows): map each column to the task key, summary, prompt, the whole reference or the value at the answer path, and give the new tasks shared workspace files, checks and limits.
- **Download** any version as `<suite>-v<n>.zip`; on an older version's Task detail, **Restore this version into the draft**.

`verify/` scripts are code, so the web app never writes them: it shows their sources read-only, while a check's settings in task.yaml stay editable. The one way scripts arrive from the browser is a suite `.zip`. Its validation lists every script with its path, size and SHA-256 under "This suite contains code", and Import stays disabled until "I trust these scripts" is ticked. A copy of a suite needs no tick: its scripts are already on disk. Wherever a verifier script comes from, it runs in a container of its own (next section).

For the save, the worker mounts `./suites` read-write; only the save writes there. On macOS (Colima or Docker Desktop) files it writes belong to you. On Linux with native Docker the worker's user, uid 10000, must be able to write `./suites`, for example with `sudo setfacl -R -m u:10000:rwX,d:u:10000:rwX,d:u:$(id -u):rwX suites` (not yet tried on Linux).

## How a trial is isolated

Every trial runs Hermes in its own container, started from the pinned `nousresearch/hermes-agent:v0.22.4` image. The container sees only that attempt's home and workspace, runs as an unprivileged user on a read-only image, and sits on an internal network whose only reachable host is `egress`. Egress refuses every private, loopback, host and Docker address, and forwards model calls with the real credential, which never enters the trial. Only `docker-guard` holds the Docker socket, and it lets the worker start nothing but such containers.

A suite's verifier scripts (`verify/`, user code) run the same way, for scoring and for every self-check: each in a container of its own from the trial image, with no network, its script and inputs mounted read-only, a read-only root and a small `/tmp`, no environment but `PATH`, the trial user with no capabilities, PID and memory limits, and the task's deadline. docker-guard admits only that exact container. Without docker-guard a verifier cannot run: a load records an error for the directory, scoring retries the run's evaluation, and a draft's self-check or save answers 503.

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
pnpm --filter @hermes-evals/api dev:worker   # the worker, in a second terminal: loads and saves suites, tests MCP servers, runs and scores trials
```

- Web dev server: http://localhost:5173 (proxies `/api` to the API on :3000; `VITE_API_PROXY` points it elsewhere). The API listens on 127.0.0.1 (`HOST`) and answers only the host names it is reached by: loopback, `api`, the host of `CORS_ORIGIN` and any in `ALLOWED_HOSTS` (comma-separated). To open the Compose web app by another name, add it to `ALLOWED_HOSTS` and to `server_name` in docker/nginx.conf.
- The web app calls the real API, in `pnpm dev` as in the Compose image (`docker/web.Dockerfile` builds with `VITE_API_MODE=live`). To work on a page without the API, `VITE_API_MODE=fixtures pnpm --filter @hermes-evals/web dev` serves the sample data in `apps/web/src/fixtures` instead, and `?scenario=<name>` on any URL shows a designed state: `loading`, `error`, `empty`, a paused, failed or single-repetition experiment, a refused launch, Nous Portal not connected, an invalid task and the rest listed in `apps/web/src/fixtures/scenarios.ts` (several at once separated by commas; `?scenario=clear` forgets the choice). The component tests run on the same fixtures. How pages are built and styled, with Tailwind CSS v4 over the design tokens: `apps/web/CONTRIBUTING.md`; the data layer: `apps/web/src/api/README.md`.
- The worker runs verifier scripts only in containers through docker-guard (section above). A worker started with `pnpm dev:worker` and no guard loads suites without `verify/` scripts, but a suite with one records a load error until a guard answers on `DOCKER_SOCKET`; `docs/phases/phase-1.md` 6.1 shows how to run one on the host.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` run across all packages in dependency order. `pnpm test` runs the unit tests and the integration tests on PGlite (real migrations and triggers, in process).
- Postgres 17 end-to-end tests, including the whole API and worker on a fresh database (`test/phase2.e2e-spec.ts` launches an experiment over HTTP and runs it to scored, with an in-process fake container engine that plays canned Hermes output; `test/phase3.e2e-spec.ts` scores all eight check types right and wrong, with the LLM judge behind a fake egress judge path, and re-scores; `test/phase4.e2e-spec.ts` follows the comparison and the verdict history through a re-score, a retry and a cancel; `test/phase6.e2e-spec.ts` covers home seeds in both memory settings, the memory file collected and scored, skill loading on demand, the launch 409 for an unset MCP variable, and `invoices-v1` loading 12 of 12 through the worker; `test/phase5b.e2e-spec.ts` and `phase5b-suites.e2e-spec.ts` author a suite through the draft API from nothing to an experiment on its v1, with both save conflicts, a CSV and a zip import, a download and a restore, and save a copy of each committed suite back unchanged): `TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e` against a throwaway server (`docker run -d --name hermes-evals-pg-test -e POSTGRES_PASSWORD=test -p 127.0.0.1:55433:5432 postgres:17-alpine`). Each spec creates and drops its own database; never point it at the Compose database. The suite stops at once without `TEST_DATABASE_URL` (every file would otherwise skip and read as green) or with port 5432, and runs four files at a time, which peaks at about 70 of the server's 100 connections.
- Tests that start real trial containers run only with `RUN_SANDBOX_TESTS=1` and a docker-guard socket (`DOCKER_SOCKET`, `TRIALS_DIR`, `TRIAL_IMAGE`, `TRIAL_VOLUME`); Turbo passes these through and keys its cache on them.

## Layout

```
apps/api          NestJS: HTTP API, SSE, pg-boss producer (src/main.ts), worker (src/worker.ts), sandbox client (src/sandbox)
apps/docker-guard The only holder of the Docker socket: a filtered Docker API for trial containers
apps/egress       The trials' only way out: forward proxy, model gateway, MCP gateway, scripted mock model
apps/web          Vue 3 + Vite + Pinia + vue-router + Tailwind CSS v4 (see apps/web/CONTRIBUTING.md)
packages/shared   Domain types, zod schemas, API contracts used by both apps
suites/           Task suites, loaded by the worker at start and on POST /api/suites/reload; edited on disk or in the web app
samples/          Sample skills (samples/skills) and document sets (samples/documents) the suites' recommended arms use
scripts/          Smoke scripts and mock-model scripts per phase; scripts/fixtures: the fixture generators
config/           prices.yaml: model prices an experiment freezes at launch
docker/           Dockerfiles: api, worker, web, trial (pinned Hermes image, nous-login.py), node services; nginx config; mcp/: the sample MCP servers
```

## Documents

- `UI_DESIGN_BRIEF.md`: the brief the UI design was produced from
- `DESIGN_AUDIT.md`: audit of the design against the brief and the system design
- `docs/phases/phase-<n>.md`: what each phase built, how it was checked, and what it left for later
- `docs/flows.md`: the manual walk of Flows A to D in the browser against the mock model
