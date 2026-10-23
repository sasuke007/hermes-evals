import { z } from 'zod';

/**
 * Environment contract for the API and the worker. Parsed once at boot; a bad
 * value fails fast with a readable message instead of a crash deep in a request.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
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
