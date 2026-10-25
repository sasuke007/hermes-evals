/**
 * What the connected workers allow a launch to do (plan 7.1 step 3, E7,
 * UI_FLOWS 19 #11). Only a worker whose isolation self-test passed takes
 * execute-run jobs, so only those count: one must exist, they must run one
 * Hermes revision (an experiment freezes it), and their trial slots bound
 * the experiment's concurrency.
 */
import { and, desc, gte, isNull, sql } from 'drizzle-orm';
import { MAX_CONCURRENCY, WORKER_TIMEOUT_MS } from '@hermes-evals/shared';
import { workers } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import type { WorkerRow } from '../../queue/live-worker.js';

export interface LiveWorkers {
  /** Every connected worker, newest start first. */
  live: WorkerRow[];
  /** The connected workers whose sandbox is proven, newest start first. */
  proven: WorkerRow[];
  /**
   * Runs the proven workers can execute at once: each runs at most its
   * concurrency, and each trial needs one of its slot networks. At most
   * MAX_CONCURRENCY, the experiments CHECK. 0 without a proven worker.
   */
  capacity: number;
}

/** Workers that have not stopped and heartbeated within WORKER_TIMEOUT_MS, on the database clock. */
export async function liveWorkers(db: AppDb): Promise<LiveWorkers> {
  const live = await db
    .select()
    .from(workers)
    .where(
      and(
        isNull(workers.stoppedAt),
        gte(
          workers.lastHeartbeatAt,
          sql`now() - (${WORKER_TIMEOUT_MS})::float8 * interval '1 millisecond'`,
        ),
      ),
    )
    .orderBy(desc(workers.startedAt), desc(workers.id));
  const proven = live.filter((w) => w.sandbox?.state === 'isolated');
  const slots = proven.reduce(
    (sum, w) => sum + Math.min(w.concurrency, w.slots ?? w.concurrency),
    0,
  );
  return { live, proven, capacity: Math.min(MAX_CONCURRENCY, slots) };
}

/** The Hermes build a launch freezes, or why nothing can launch now. */
export type LaunchHermes =
  { ok: true; version: string; revision: string } | { ok: false; reason: string };

/** The 409 reasons of E7 that concern workers, worded for the launch panel. */
export function launchHermes(workersNow: LiveWorkers): LaunchHermes {
  if (workersNow.live.length === 0) {
    return {
      ok: false,
      reason:
        'No worker is connected, so runs cannot start. Start one with: docker compose up -d worker',
    };
  }
  const [newest] = workersNow.proven;
  if (!newest) {
    return {
      ok: false,
      reason:
        'No connected worker has proven sandbox isolation, so runs cannot start until the sandbox self-test passes (System › Sandbox).',
    };
  }
  const counts = new Map<string, number>();
  for (const w of workersNow.proven)
    counts.set(w.hermesRevision, (counts.get(w.hermesRevision) ?? 0) + 1);
  if (counts.size > 1) {
    const listed = [...counts.entries()]
      .map(([revision, n]) => `${revision.slice(0, 7)} on ${n} worker${n === 1 ? '' : 's'}`)
      .join(', ');
    return {
      ok: false,
      reason: `The connected workers run different Hermes revisions (${listed}). Restart them on one trial image before launching.`,
    };
  }
  return { ok: true, version: newest.hermesVersion, revision: newest.hermesRevision };
}

/**
 * Why runs of an experiment frozen on `revision` cannot start now, or null:
 * no connected worker with proven isolation runs that revision, so every
 * job would only be put back (claim.ts). Resume, Retry failed runs and Retry
 * answer 409 with it, worded like the launch reasons.
 */
export function frozenRevisionRefusal(workersNow: LiveWorkers, revision: string): string | null {
  if (workersNow.proven.some((w) => w.hermesRevision === revision)) return null;
  const running = [...new Set(workersNow.proven.map((w) => w.hermesRevision.slice(0, 7)))];
  const now =
    running.length === 0
      ? 'no connected worker has proven sandbox isolation'
      : `the connected workers run ${running.join(', ')}`;
  return (
    `This experiment was launched on Hermes ${revision.slice(0, 7)}; no connected worker runs ` +
    `that revision (${now}). Start a worker on that trial image, or duplicate the experiment.`
  );
}
