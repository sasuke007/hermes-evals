import { z } from 'zod';
import { HTTP_URL_PATTERN, PROVIDERS } from '@hermes-evals/shared';
import { LOAD_SUITES_EXPIRE_SECONDS } from '../queue/queues.js';

/** An optional setting; an empty value (`JUDGE_MODEL=` in .env) means unset. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

/**
 * Environment contract for the API and the worker. Parsed once at boot; a bad
 * value fails fast with a readable message instead of a crash deep in a request.
 */
export const EnvSchema = z
  .object({
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
    /**
     * How many trials one worker process executes at once, at most one per
     * TRIAL_SLOTS entry (a higher value is capped, with a warning at start).
     */
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
    /**
     * Internal slot networks, one per concurrent trial, comma-separated. The
     * worker hands them out in-process and, before each create, confirms no
     * live trial container is on the slot. One worker per Docker daemon is the
     * supported setup; several workers sharing one daemon must each get a
     * disjoint list, or two of them could put trials on the same network.
     */
    TRIAL_SLOTS: z
      .string()
      .default(
        'hermes-evals-trial-0,hermes-evals-trial-1,hermes-evals-trial-2,hermes-evals-trial-3',
      ),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    /**
     * More host names the API answers, comma-separated, beside loopback, `api`
     * and CORS_ORIGIN's host (common/host-allowlist.ts): for a machine name or
     * address the web app is opened by. Any other Host is refused.
     */
    ALLOWED_HOSTS: z.string().optional(),
    /**
     * How long POST /suites/reload waits for the worker's load-suites job. At
     * most the job's own expiry (LOAD_SUITES_EXPIRE_SECONDS, 4200 s); the
     * load goes on after a timeout.
     */
    SUITE_RELOAD_TIMEOUT_S: z.coerce
      .number()
      .int()
      .min(1)
      .max(LOAD_SUITES_EXPIRE_SECONDS)
      .default(180),
    /** How long an MCP "Test start" waits for its test-mcp-server job; at most its expiry (300 s). */
    MCP_TEST_TIMEOUT_S: z.coerce.number().int().min(1).max(300).default(120),
    /** Model price table (plan 7.2). The file may not exist; then no model has a price. */
    PRICES_FILE: z.string().default('./config/prices.yaml'),
    /** How long a validated skill upload waits for its confirm before it is discarded. */
    SKILL_UPLOAD_TTL_S: z.coerce.number().int().min(60).max(86_400).default(1800),
    /**
     * Circuit breaker (plan 7.3): execution errors in a row, across an
     * experiment's runs, at which the experiment becomes `failed`. Any
     * successful execution resets the count.
     */
    MAX_CONSECUTIVE_EXECUTION_ERRORS: z.coerce.number().int().min(1).max(1000).default(14),
    /**
     * Days a finished attempt's workspace stays in the trials volume after its
     * files were collected into the blob store (plan 8.5). The home is deleted
     * at once. 0 deletes the workspace right after collection.
     */
    TRIAL_RETENTION_DAYS: z.coerce.number().int().min(0).max(365).default(7),
    /**
     * How often each worker runs the recovery pass (plan 8.6): revoke expired
     * leases, confirm their containers are gone, finalise and requeue, sweep,
     * re-send lost jobs. One pass at a time across workers.
     */
    RECOVERY_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(15_000),
    /**
     * Lifetime of an attempt's lease (plan 8.1). The owning worker renews every
     * lease it holds on each 10 s heartbeat, so this must outlast a few missed
     * heartbeats; recovery revokes a lease once it expires.
     */
    LEASE_SECONDS: z.coerce.number().int().min(30).max(600).default(60),
    /**
     * The nous-login service (plan 6.1), reached over the internal
     * provider-admin network: by the API for GET /providers and the login
     * routes, and by the worker for the provider guard's status check.
     */
    NOUS_LOGIN_URL: z.string().url().default('http://nous-login:8650'),
    /**
     * The LLM judge's platform default (plan 9.3): the provider and model of
     * every llm_judge key whose check names no `model:`. A check's `model:`
     * runs on JUDGE_PROVIDER, or on `nous` when that is unset
     * (scoring/judge/contracts.ts resolveJudgeModel). With no model from
     * either, each llm_judge key is published as `error`. The judge's calls
     * go through egress's admin socket, so provider keys stay in egress and
     * the Nous login in nous-proxy; the worker holds none. The API reads both
     * too, to refuse a launch or re-score while the judge's provider is not
     * ready (plan 6.1).
     */
    JUDGE_PROVIDER: optional(z.enum(PROVIDERS)),
    JUDGE_MODEL: optional(z.string().min(1).max(200)),
    /**
     * A `custom` judge's own base URL, such as the scripted mock model
     * (http://mock-model:8090/v1); egress forwards the judge's calls there.
     * Set exactly when JUDGE_PROVIDER is `custom`, the rule egress applies to
     * a custom attempt's upstream.
     */
    JUDGE_BASE_URL: optional(z.string().regex(HTTP_URL_PATTERN, 'must be an http(s) URL')),
    /**
     * Total tokens the model gateway serves one attempt before answering 429
     * (Phase 2 question 2), sent as the egress registration's maxTokens. A
     * runaway agent would otherwise call the model until its deadline.
     * Empty means the default, as egress reads the same variable.
     */
    MODEL_TOKEN_CAP_PER_ATTEMPT: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.coerce.number().int().min(1000).max(1_000_000_000).default(2_000_000),
    ),
  })
  .superRefine((env, ctx) => {
    if ((env.JUDGE_PROVIDER === 'custom') !== (env.JUDGE_BASE_URL !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JUDGE_BASE_URL'],
        message:
          env.JUDGE_PROVIDER === 'custom'
            ? 'is required when JUDGE_PROVIDER is custom'
            : 'is only used when JUDGE_PROVIDER is custom',
      });
    }
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
