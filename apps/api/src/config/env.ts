import { z } from 'zod';

/**
 * Environment contract for the API and the worker. Parsed once at boot; a bad
 * value fails fast with a readable message instead of a crash deep in a request.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * Interface the API listens on. Loopback by default, so `pnpm dev` is not
   * reachable from the network; Compose sets 0.0.0.0 for nginx and the
   * published port.
   */
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** Postgres connection string. Optional so the API can boot and report "unavailable". */
  DATABASE_URL: z.string().url().optional(),
  /** Directory holding suites (each a folder with task folders). */
  SUITES_DIR: z.string().default('./suites'),
  /** Directory for trial homes, workspaces and collected artifacts. */
  DATA_DIR: z.string().default('./data'),
  /** Path to the Hermes CLI binary used by the worker. */
  HERMES_BIN: z.string().default('hermes'),
  /** How many trials one worker process executes at once. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
  /** docker-guard's unix socket: the only way the worker reaches Docker. */
  DOCKER_SOCKET: z.string().default('/run/guard/docker.sock'),
  /** egress admin unix socket, used to register and remove attempts. */
  EGRESS_ADMIN_SOCKET: z.string().default('/run/egress/admin.sock'),
  /** Image every trial runs, built from the pinned Hermes image. */
  TRIAL_IMAGE: z.string().default('hermes-evals/trial:v0.22.4-4d04303'),
  /** Named volume holding trial homes and workspaces, mounted by the worker at TRIALS_DIR. */
  TRIAL_VOLUME: z.string().default('hermes-evals-trials'),
  TRIALS_DIR: z.string().default('/trials'),
  /** Internal networks, one per concurrent trial. */
  TRIAL_SLOTS: z
    .string()
    .default('hermes-evals-trial-0,hermes-evals-trial-1,hermes-evals-trial-2,hermes-evals-trial-3'),
  /** Provider credential forwarded into each trial home's .env. Never logged. */
  NOUS_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /**
   * More host names the API answers, comma-separated, beside loopback, `api`
   * and CORS_ORIGIN's host (common/host-allowlist.ts): for a machine name or
   * address the web app is opened by. Any other Host is refused.
   */
  ALLOWED_HOSTS: z.string().optional(),
  /**
   * How long POST /suites/reload waits for the worker's load-suites job. At
   * most the job's own expiry (900 s); the load goes on after a timeout.
   */
  SUITE_RELOAD_TIMEOUT_S: z.coerce.number().int().min(1).max(900).default(180),
  /** How long an MCP "Test start" waits for its test-mcp-server job; at most its expiry (300 s). */
  MCP_TEST_TIMEOUT_S: z.coerce.number().int().min(1).max(300).default(120),
  /** Model price table (plan 7.2). The file may not exist; then no model has a price. */
  PRICES_FILE: z.string().default('./config/prices.yaml'),
  /** How long a validated skill upload waits for its confirm before it is discarded. */
  SKILL_UPLOAD_TTL_S: z.coerce.number().int().min(60).max(86_400).default(1800),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}
