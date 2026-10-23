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

Model access, once:

- **Nous Portal** (OAuth): `docker compose --profile nous run --rm nous-proxy auth add nous --type oauth --no-browser`, approve in the browser, then `docker compose --profile nous up -d nous-proxy`.
- **Nous Portal, reusing this machine's Hermes login** (development): run `hermes proxy start --provider nous` on the host and set `NOUS_HOST_PROXY=host.docker.internal:8645` in `.env`. Nothing is copied: the host proxy keeps the login, and egress forwards to it from its own loopback. Any container in the Docker VM can reach that host proxy, so use this only on a machine you trust.
- **OpenRouter** (API key): set `OPENROUTER_API_KEY` in `.env`.

## How a trial is isolated

Every trial runs Hermes in its own container, started from the pinned `nousresearch/hermes-agent:v0.22.4` image. The container sees only that attempt's home and workspace, runs as an unprivileged user on a read-only image, and sits on an internal network whose only reachable host is `egress`. Egress refuses every private, loopback, host and Docker address, and forwards model calls with the real credential, which never enters the trial. Only `docker-guard` holds the Docker socket, and it lets the worker start nothing but such containers.

The worker proves this on every start and refuses to run experiments if any check fails. Run the same checks by hand:

```bash
docker compose run --rm --no-deps worker node dist/sandbox-cli.js selftest    # isolation
docker compose run --rm --no-deps worker node dist/sandbox-cli.js lifecycle   # deadline, cancel, orphans, hostile output, disk caps
docker compose --profile test up -d mock-model
docker compose run --rm --no-deps worker node dist/sandbox-cli.js smoke       # real Hermes, scripted model
```

Run one suite task with a real model and check its answer (the model defaults to `openai/gpt-6.1-sol` on Nous; set `TASK_MODEL` and `TASK_PROVIDER` to change it):

```bash
docker compose exec worker node dist/sandbox-cli.js task /data/suites/invoices-v1/total_due
```

## Local development

Requires Node 22+ and pnpm 11 (`corepack enable`). Postgres can come from `docker compose up postgres`.

```bash
pnpm install
pnpm dev            # shared (tsc --watch), api (nest --watch), web (vite) via Turbo
pnpm --filter @hermes-evals/api dev:worker   # the worker, in a second terminal
```

- Web dev server: http://localhost:5173 (proxies `/api` to the API on :3000)
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` run across all packages in dependency order.

## Layout

```
apps/api          NestJS: HTTP API, SSE, pg-boss producer (src/main.ts), worker (src/worker.ts), sandbox client (src/sandbox)
apps/docker-guard The only holder of the Docker socket: a filtered Docker API for trial containers
apps/egress       The trials' only way out: forward proxy, model gateway, scripted mock model
apps/web          Vue 3 + Vite + Pinia + vue-router
packages/shared   Domain types, zod schemas, API contracts used by both apps
suites/           Task suites loaded by the API (read-only in the UI)
docker/           Dockerfiles: api, worker, web, trial (pinned Hermes image), node services; nginx config
```

## Documents

- `UI_DESIGN_BRIEF.md`: the brief the UI design was produced from
- `DESIGN_AUDIT.md`: audit of the design against the brief and the system design
