/**
 * Shape of `workers.sandbox`: the isolation self-test (plan 8.7) the worker
 * ran at start, as the System page shows it. Kept beside the table rather
 * than in @hermes-evals/shared because only the worker writes it and only the
 * API reads it; the API maps it to the shared SandboxStatus view model.
 *
 * Same rules as the JSON shapes in shared/records.ts: JSON round-trip
 * stable (ISO strings, no Date), and additive evolution only.
 */
import { z } from 'zod';

/**
 * isolated: every check passed, so the worker takes execute-run jobs.
 * failed: the self-test ran and at least one check failed.
 * unavailable: the self-test could not run (docker-guard or egress unreachable).
 */
export const WORKER_SANDBOX_STATES = ['isolated', 'failed', 'unavailable'] as const;
export type WorkerSandboxState = (typeof WORKER_SANDBOX_STATES)[number];

export const WorkerSandboxCheckSchema = z.object({
  /** Stable id, e.g. `no-default-route`. */
  id: z.string().min(1),
  /** Plain-English claim, e.g. "has no default route". */
  name: z.string(),
  passed: z.boolean(),
  /** Evidence line, or the failure. Never holds a secret value. */
  detail: z.string(),
});
export type WorkerSandboxCheck = z.infer<typeof WorkerSandboxCheckSchema>;

export const WorkerSandboxSchema = z.object({
  state: z.enum(WORKER_SANDBOX_STATES),
  /** In the self-test's fixed order. Empty when the state is unavailable. */
  checks: z.array(WorkerSandboxCheckSchema),
  checked_at: z.iso.datetime({ offset: true }),
  /** Trial image the probe ran in, as configured (TRIAL_IMAGE). */
  image: z.string(),
  /** Hermes revision of that image, e.g. its full git sha. */
  revision: z.string(),
  /** Image digest when the engine reported one. */
  image_digest: z.string().optional(),
  /** What ran it, e.g. `worker start`. */
  trigger: z.string().optional(),
  /** Why the self-test could not run, when the state is unavailable. */
  error: z.string().optional(),
});
export type WorkerSandbox = z.infer<typeof WorkerSandboxSchema>;
