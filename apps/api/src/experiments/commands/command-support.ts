/**
 * What every experiment and run command shares: the experiment row lock
 * that starts each transaction, the queue, and the error answers.
 *
 * Lock order (plan 3.3): the experiment row first, then runs, attempts and
 * evaluations. The results-revision triggers update the experiment row
 * whenever a run changes status, so a transaction that took a run first and
 * the experiment last would deadlock with one that did the opposite.
 * FOR NO KEY UPDATE is the mode reconcile and the worker take too; it still
 * lets runs be inserted (their foreign key takes FOR KEY SHARE).
 */
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { experiments } from '../../database/schema/index.js';
import type { AppTx } from '../../database/types.js';
import type { QueueService } from '../../queue/queue.service.js';

export type ExperimentRow = typeof experiments.$inferSelect;

export const notFound = (what: string): NotFoundException =>
  new NotFoundException({ statusCode: 404, message: `${what} not found` });

export const conflict = (message: string): ConflictException =>
  new ConflictException({ statusCode: 409, message });

/** What a command answers when the job queue cannot take jobs; nothing was changed. */
export const QUEUE_UNAVAILABLE =
  'the job queue is unavailable, so no run can be enqueued; try again shortly';

/** pg-boss, or a 503 when it did not start (the database was unreachable at boot). */
export function bossOf(queue: QueueService): PgBoss {
  try {
    return queue.instance;
  } catch {
    throw new ServiceUnavailableException({ statusCode: 503, message: QUEUE_UNAVAILABLE });
  }
}

/** Locks the experiment row, the first lock of every command transaction; 404 when missing. */
export async function lockExperiment(tx: AppTx, id: string): Promise<ExperimentRow> {
  const [row] = await tx
    .select()
    .from(experiments)
    .where(eq(experiments.id, id))
    .for('no key update');
  if (!row) throw notFound(`experiment ${id}`);
  return row;
}

/** The status an action answers with, read after the transaction's own changes. */
export async function experimentStatus(tx: AppTx, id: string): Promise<ExperimentRow['status']> {
  const [row] = await tx
    .select({ status: experiments.status })
    .from(experiments)
    .where(eq(experiments.id, id));
  if (!row) throw notFound(`experiment ${id}`);
  return row.status;
}

/** "$2.00": dollars as the spend panel shows them. */
export const usd = (value: number): string => `$${value.toFixed(2)}`;
