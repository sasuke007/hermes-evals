/**
 * Shape of `workers.host_proxy`: whether the development host login
 * (NOUS_HOST_PROXY, UI_FLOWS 19 #7) answers. Egress forwards Nous model calls
 * to `hermes proxy start` on the host when that variable is set, and reports
 * the forward and whether its target answers in its admin `/health`. Only the
 * worker can reach that socket, so it records the answer here on every
 * heartbeat; GET /providers reads it to report Nous as `host` or
 * `host_unreachable`. Null when egress has no host forward, or before the
 * worker has asked.
 *
 * Kept beside the table for the same reason as worker-sandbox.ts: only the
 * worker writes it and only the API reads it. JSON round-trip stable (ISO
 * strings), additive evolution only.
 */
import { z } from 'zod';

export const WorkerHostProxySchema = z.object({
  /** The forward's target as NOUS_HOST_PROXY names it, e.g. `host.lima.internal:8645`. Not a secret. */
  target: z.string().min(1),
  /** Whether a connection to the target succeeded when egress last checked. */
  reachable: z.boolean(),
  /** When the worker recorded this answer. */
  checked_at: z.iso.datetime({ offset: true }),
});
export type WorkerHostProxy = z.infer<typeof WorkerHostProxySchema>;
