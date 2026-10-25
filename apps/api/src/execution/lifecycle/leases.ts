/**
 * The leases this worker holds (plan 8.1), and the two loops that watch them:
 *
 * - the heartbeat, every 10 s, renews every held lease in one statement. An
 *   attempt missing from the result has lost its lease (recovery revoked it,
 *   or it finished elsewhere): its runner is aborted with LeaseLostError and
 *   writes nothing more. The statement filters `lease_revoked_at IS NULL`:
 *   attempts_guard refuses any change to a revoked attempt other than ending
 *   it, so one revoked row would fail the whole renewal;
 * - the cancel watcher, every 1 to 2 s, asks in one query which held
 *   attempts' runs have cancel_requested_at, and aborts each with
 *   CancelRequestedError; the runner stops the container and returns
 *   `cancelled`.
 *
 * A failed tick is logged and retried on the next one; it never aborts
 * anything, because a database that cannot answer says nothing about a
 * lease. Recovery revokes a lease that really expired.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { attempts, runs } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { LeaseLostError, WorkerShutdownError } from '../contracts.js';
import { CancelRequestedError, type LifecycleLogger, type LifecycleSettings } from './types.js';

interface Held {
  leaseToken: string;
  controller: AbortController;
}

export class LeaseKeeper {
  private readonly held = new Map<string, Held>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cancelTimer: NodeJS.Timeout | null = null;
  private renewing: Promise<string[]> | null = null;
  private polling: Promise<string[]> | null = null;
  private shuttingDown = false;

  constructor(
    private readonly db: AppDb,
    private readonly workerId: string,
    private readonly settings: Pick<
      LifecycleSettings,
      'leaseSeconds' | 'heartbeatIntervalMs' | 'cancelPollIntervalMs'
    >,
    private readonly logger: LifecycleLogger,
  ) {}

  /** Starts both loops. They query nothing while no lease is held. */
  start(): void {
    this.heartbeatTimer = setInterval(() => void this.renew(), this.settings.heartbeatIntervalMs);
    this.cancelTimer = setInterval(
      () => void this.pollCancels(),
      this.settings.cancelPollIntervalMs,
    );
    // A worker that is shutting down must not be kept alive by its timers.
    this.heartbeatTimer.unref();
    this.cancelTimer.unref();
  }

  /** Stops both loops and waits for a tick in progress. */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cancelTimer) clearInterval(this.cancelTimer);
    this.heartbeatTimer = this.cancelTimer = null;
    await Promise.allSettled([this.renewing, this.polling]);
  }

  /**
   * Starts holding a lease and returns the signal its runner watches. Once
   * the worker is shutting down the signal is born aborted.
   */
  hold(attemptId: string, leaseToken: string): AbortSignal {
    const controller = new AbortController();
    this.held.set(attemptId, { leaseToken, controller });
    if (this.shuttingDown) controller.abort(new WorkerShutdownError());
    return controller.signal;
  }

  /** Stops holding a lease: its attempt finished, or its owner gave it up. */
  release(attemptId: string): void {
    this.held.delete(attemptId);
  }

  /**
   * Recovery revoked this attempt's lease: if this process still runs it,
   * abort it with LeaseLostError now rather than at the next renewal, so it
   * writes nothing more while recovery stops its container.
   */
  revoked(attemptId: string): boolean {
    const entry = this.held.get(attemptId);
    if (!entry || entry.controller.signal.aborted) return false;
    entry.controller.abort(new LeaseLostError(attemptId));
    return true;
  }

  /** Attempts held now. */
  get count(): number {
    return this.held.size;
  }

  /** Aborts every held attempt with WorkerShutdownError, and every one held from now on. */
  shutdown(): void {
    this.shuttingDown = true;
    for (const { controller } of this.held.values()) controller.abort(new WorkerShutdownError());
  }

  /** One renewal; resolves the attempts found lost (and aborted). Never rejects. */
  renew(): Promise<string[]> {
    if (this.renewing) return this.renewing;
    const renewing = this.renewOnce()
      .catch((err: unknown) => {
        this.logger.warn(
          { err, workerId: this.workerId },
          'lease renewal failed; retrying on the next heartbeat',
        );
        return [];
      })
      .finally(() => {
        if (this.renewing === renewing) this.renewing = null;
      });
    this.renewing = renewing;
    return renewing;
  }

  /** One cancel check; resolves the attempts aborted for a cancel. Never rejects. */
  pollCancels(): Promise<string[]> {
    if (this.polling) return this.polling;
    const polling = this.pollOnce()
      .catch((err: unknown) => {
        this.logger.warn({ err, workerId: this.workerId }, 'cancel check failed; retrying shortly');
        return [];
      })
      .finally(() => {
        if (this.polling === polling) this.polling = null;
      });
    this.polling = polling;
    return polling;
  }

  private async renewOnce(): Promise<string[]> {
    const snapshot = [...this.held];
    if (snapshot.length === 0) return [];
    const pairs = snapshot.map(([id, { leaseToken }]) => sql`(${id}, ${leaseToken}::uuid)`);
    const renewed = await this.db
      .update(attempts)
      .set({
        leaseExpiresAt: sql`now() + make_interval(secs => ${this.settings.leaseSeconds})`,
      })
      .where(
        and(
          sql`(${attempts.id}, ${attempts.leaseToken}) in (${sql.join(pairs, sql`, `)})`,
          eq(attempts.workerId, this.workerId),
          eq(attempts.status, 'running'),
          isNull(attempts.leaseRevokedAt),
        ),
      )
      .returning({ id: attempts.id });
    const alive = new Set(renewed.map((row) => row.id));
    const lost: string[] = [];
    for (const [attemptId, entry] of snapshot) {
      // Released while the statement ran: it finished here, nothing to abort.
      if (alive.has(attemptId) || this.held.get(attemptId) !== entry) continue;
      lost.push(attemptId);
      entry.controller.abort(new LeaseLostError(attemptId));
      this.logger.warn({ attemptId, workerId: this.workerId }, 'lease lost; stopping the attempt');
    }
    return lost;
  }

  private async pollOnce(): Promise<string[]> {
    const ids = [...this.held]
      .filter(([, entry]) => !entry.controller.signal.aborted)
      .map(([id]) => id);
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: attempts.id })
      .from(attempts)
      .innerJoin(runs, eq(runs.id, attempts.runId))
      .where(
        and(
          inArray(attempts.id, ids),
          eq(attempts.workerId, this.workerId),
          eq(attempts.status, 'running'),
          isNull(attempts.leaseRevokedAt),
          isNotNull(runs.cancelRequestedAt),
        ),
      );
    const cancelled: string[] = [];
    for (const { id } of rows) {
      const entry = this.held.get(id);
      if (!entry || entry.controller.signal.aborted) continue;
      entry.controller.abort(new CancelRequestedError(id));
      cancelled.push(id);
      this.logger.info({ attemptId: id }, 'cancel requested; stopping the attempt');
    }
    return cancelled;
  }
}
