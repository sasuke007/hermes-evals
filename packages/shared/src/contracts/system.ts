/**
 * Sandbox and worker contracts (plan sections 8.7 and 11): the isolation
 * self-test a worker reports, worker presence and the running summary.
 * Model access (providers and the Nous login) stays in the web until Phase 2.
 */
import { z } from 'zod';
import { countView, isoTimeView } from './common.js';

// ── Sandbox ──────────────────────────────────────────────────────────────

export const SandboxCheckSchema = z.object({
  /** Stable id, e.g. "no-default-route". */
  id: z.string(),
  /** Plain-English claim: "has no default route". */
  name: z.string(),
  passed: z.boolean(),
  /** Evidence line: "ip route → no default route", or the failure. */
  detail: z.string(),
});
export type SandboxCheck = z.infer<typeof SandboxCheckSchema>;

export const SandboxStatusSchema = z.object({
  proven: z.boolean(),
  /** The 15 isolation checks in their fixed order. */
  checks: z.array(SandboxCheckSchema),
  /** ISO 8601 time of the self-test. */
  checkedAt: isoTimeView,
  /** What ran it: "worker start". */
  trigger: z.string(),
  /** Hermes revision: "hermes-agent v0.22.4 @ 4d04303". */
  revision: z.string(),
  /** Image tag: "nousresearch/hermes-agent:v0.22.4". */
  image: z.string(),
  /** Image digest (may be shortened for display): "sha256:7a6920…". */
  digest: z.string(),
  /** Command that re-runs the self-test. */
  selftestCommand: z.string(),
});
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

// ── Workers and the running summary ──────────────────────────────────────

export const WorkerSchema = z.object({
  id: z.string(),
  status: z.enum(['online', 'offline']),
  /** ISO 8601. A worker heartbeats every 10 s; none for WORKER_TIMEOUT_MS means it is gone. */
  lastHeartbeatAt: isoTimeView,
  concurrency: countView,
  slotsInUse: countView.nullable(),
  slotsTotal: countView.nullable(),
  sandboxProven: z.boolean(),
});
export type Worker = z.infer<typeof WorkerSchema>;

export const RunningExperimentSchema = z.object({
  id: z.string(),
  name: z.string(),
  scored: countView,
  total: countView,
});
export type RunningExperiment = z.infer<typeof RunningExperimentSchema>;

export const RunningSummarySchema = z.object({
  count: countView,
  scored: countView,
  total: countView,
  experiments: z.array(RunningExperimentSchema),
});
export type RunningSummary = z.infer<typeof RunningSummarySchema>;

/** GET /system/summary (plan section 11), trimmed to what the shell and System use. */
export const SystemSummarySchema = z.object({
  running: RunningSummarySchema,
  workers: z.array(WorkerSchema),
  /** Queued runs waiting for a worker (shown when no worker is connected). */
  queuedRuns: countView,
});
export type SystemSummary = z.infer<typeof SystemSummarySchema>;

/** A worker counts as present when online with a heartbeat in the last 60 s. */
export const WORKER_TIMEOUT_MS = 60_000;
