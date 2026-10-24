# @hermes-evals/api

The NestJS API (`src/main.ts`) and worker (`src/worker.ts`) of Hermes Evals, in one package. They share the Drizzle schema, the pg-boss queues and the blob store under `DATA_DIR`, and run as separate processes.

- **API**: definitions over HTTP under `/api`, docs at `/api/docs`. It never runs user code and never reads `SUITES_DIR`: a reload or an MCP "Test start" is a job the worker answers.
- **Worker**: proves trial isolation at start, registers its `workers` row and heartbeats it, loads suites (verifier scripts are user code) and tests MCP servers in throwaway trial containers.

Migrations in `drizzle/` run at boot in both processes, under an advisory lock.

| Script                         | What it does                                                       |
| ------------------------------ | ------------------------------------------------------------------ |
| `pnpm dev` / `pnpm dev:worker` | API / worker in watch mode                                         |
| `pnpm build`                   | `dist/main.js` and `dist/worker.js`                                |
| `pnpm test`                    | unit tests, and integration tests on PGlite                        |
| `pnpm test:e2e`                | Postgres 17 specs; needs `TEST_DATABASE_URL` (see the root README) |
| `pnpm typecheck`, `pnpm lint`  | tsc, and oxlint with type information                              |
| `pnpm db:generate`             | a new migration from `src/database/schema`                         |
