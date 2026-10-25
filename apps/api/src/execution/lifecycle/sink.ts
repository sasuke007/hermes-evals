/**
 * The AttemptSink the runner writes through (execution/contracts.ts). Every
 * method is fenced on the attempt's lease and throws LeaseLostError once the
 * lease is gone; the runner then stops the container and rethrows.
 *
 * Sequence numbers are gap-free per attempt (plan 8.3): the sink holds the
 * counter, and advances it only after a batch commits, so a batch that fails
 * is retried with the same numbers (EventBatcher). A retry of a batch whose
 * commit reply was lost meets its own rows: run_events_pk refuses them, and
 * the sink then confirms every seq of the batch is stored and counts it
 * written. Only this sink writes the attempt's events while its lease holds,
 * so rows at those seqs are that batch. One sink per attempt, used by one
 * runner, so batches never interleave. The finish transaction numbers its
 * final events after the last one written here (nextSeq).
 */
import { and, between, count, eq, isNull, sql } from 'drizzle-orm';
import type { LaunchRecord } from '@hermes-evals/shared';
import { pgError, SQLSTATE } from '../../common/pg-error.js';
import { attempts, runEvents, runs } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { LeaseLostError, type AttemptEventInput, type AttemptSink } from '../contracts.js';
import { fencedWrite, insertFencedEvents, leaseHeld, type AttemptLease } from './fence.js';

/** The primary key of run_events, (attempt_id, seq). */
const RUN_EVENTS_PK = 'run_events_pk';

export class FencedAttemptSink implements AttemptSink {
  private written = 0;
  private launchRecorded = false;
  private containerRecorded = false;

  constructor(
    private readonly db: AppDb,
    private readonly lease: AttemptLease,
  ) {}

  /** The seq the next event gets. */
  get nextSeq(): number {
    return this.written + 1;
  }

  async recordLaunch(record: LaunchRecord): Promise<void> {
    if (this.launchRecorded) throw new Error('the launch record is written once per attempt');
    const updated = await fencedWrite(this.lease, () =>
      this.db
        .update(attempts)
        .set({ launchRecord: record })
        .where(and(leaseHeld(this.lease), isNull(attempts.launchRecord)))
        .returning({ id: attempts.id }),
    );
    if (updated.length === 0) throw new LeaseLostError(this.lease.attemptId);
    this.launchRecorded = true;
  }

  async recordContainer(containerId: string, hostId: string): Promise<void> {
    if (this.containerRecorded) throw new Error('the container is recorded once per attempt');
    // The claim already wrote this worker's daemon id, which recovery needs
    // even before a container exists; it is kept if set (written once).
    const updated = await fencedWrite(this.lease, () =>
      this.db
        .update(attempts)
        .set({
          sandboxId: containerId,
          sandboxHostId: sql`coalesce(${attempts.sandboxHostId}, ${hostId})`,
        })
        .where(and(leaseHeld(this.lease), isNull(attempts.sandboxId)))
        .returning({ id: attempts.id }),
    );
    if (updated.length === 0) throw new LeaseLostError(this.lease.attemptId);
    this.containerRecorded = true;
  }

  async appendEvents(events: readonly AttemptEventInput[]): Promise<void> {
    try {
      await insertFencedEvents(this.db, this.lease, this.nextSeq, events);
    } catch (err) {
      const pg = pgError(err);
      if (pg?.code !== SQLSTATE.uniqueViolation || pg.constraint !== RUN_EVENTS_PK) throw err;
      if (!(await this.stored(this.nextSeq, events.length))) throw err;
    }
    this.written += events.length;
  }

  /** Whether every seq in [first, first + n) of this attempt is stored: an earlier try committed. */
  private async stored(first: number, n: number): Promise<boolean> {
    const [row] = await this.db
      .select({ n: count() })
      .from(runEvents)
      .where(
        and(
          eq(runEvents.attemptId, this.lease.attemptId),
          between(runEvents.seq, first, first + n - 1),
        ),
      );
    return Number(row?.n ?? 0) === n;
  }

  async cancelRequested(): Promise<boolean> {
    const [row] = await this.db
      .select({ cancelRequestedAt: runs.cancelRequestedAt })
      .from(attempts)
      .innerJoin(runs, eq(runs.id, attempts.runId))
      .where(leaseHeld(this.lease));
    if (!row) throw new LeaseLostError(this.lease.attemptId);
    return row.cancelRequestedAt !== null;
  }
}
