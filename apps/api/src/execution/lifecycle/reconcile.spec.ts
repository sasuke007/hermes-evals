/**
 * reconcileExperiment (experiments/reconcile.ts, plan 7.4) on PGlite: when an
 * experiment counts as settled, the conditional update that completes it
 * once, a paused or cancelled experiment draining, and the failed one left
 * alone.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { evaluations, experiments, runs } from '../../database/schema/index.js';
import { reconcileExperiment } from '../../experiments/reconcile.js';
import { finishAttempt } from './finish.js';
import {
  claimAttempt,
  experimentRow,
  outcomes,
  RecordingQueue,
  seedLifecycle,
  seedWorker,
} from './testing.support-spec.js';

describe('reconcileExperiment', () => {
  let t: TestDatabase;
  let workerId: string;

  beforeEach(async () => {
    t = await createTestDatabase();
    workerId = await seedWorker(t.db);
  });
  afterEach(() => t.close());

  const reconcile = (experimentId: string) =>
    t.db.transaction((tx) => reconcileExperiment(tx, experimentId));
  // Cancelled is the one final status a run without an attempt can take (runs_attempt_present_ck).
  const settle = (experimentId: string) =>
    t.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: sql`now()` })
      .where(eq(runs.experimentId, experimentId));

  it('waits while any run is queued, running, executed or scoring', async () => {
    const seed = await seedLifecycle(t.db);
    expect(await reconcile(seed.experimentId)).toBe('unchanged');
    const claimed = await claimAttempt(t.db, seed.runIds[0]!, workerId);
    await t.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: sql`now()` })
      .where(eq(runs.id, seed.runIds[1]!));
    expect(await reconcile(seed.experimentId)).toBe('unchanged');
    await finishAttempt(t.db, {
      claimed,
      nextSeq: 1,
      outcome: outcomes.executed(),
      queue: new RecordingQueue(),
      settings: { maxConsecutiveExecutionErrors: 14, autoRetryDelayS: 30 },
    });
    // Executed, with its evaluation queued: still in flight.
    expect(await reconcile(seed.experimentId)).toBe('unchanged');
    expect((await experimentRow(t.db, seed.experimentId)).status).toBe('running');
  });

  it('waits for an evaluation that is still queued or running, whatever the run says', async () => {
    const seed = await seedLifecycle(t.db);
    const claimed = await claimAttempt(t.db, seed.runIds[0]!, workerId);
    await finishAttempt(t.db, {
      claimed,
      nextSeq: 1,
      outcome: outcomes.executed(),
      queue: new RecordingQueue(),
      settings: { maxConsecutiveExecutionErrors: 14, autoRetryDelayS: 30 },
    });
    await t.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: sql`now()` })
      .where(eq(runs.experimentId, seed.experimentId));
    const [evaluation] = await t.db.select().from(evaluations);
    expect(evaluation!.status).toBe('queued');
    expect(await reconcile(seed.experimentId)).toBe('unchanged');
  });

  it('completes a settled experiment once, with verdict_revision = results_revision', async () => {
    const seed = await seedLifecycle(t.db);
    await settle(seed.experimentId);
    expect(await reconcile(seed.experimentId)).toBe('completed');
    const done = await experimentRow(t.db, seed.experimentId);
    expect(done.status).toBe('completed');
    expect(done.finishedAt).not.toBeNull();
    expect(done.verdictRevision).toBe(done.resultsRevision);
    // Phase 4 appends one verdict entry per candidate in the same update.
    expect(done.verdictHistory).toEqual([
      expect.objectContaining({
        cause: 'initial',
        key: 'primary',
        results_revision: done.resultsRevision,
      }),
    ]);
    expect(await reconcile(seed.experimentId)).toBe('unchanged');
    expect((await experimentRow(t.db, seed.experimentId)).finishedAt).toEqual(done.finishedAt);
  });

  it('moves verdict_revision forward on a completed experiment whose results moved, without reopening it', async () => {
    const seed = await seedLifecycle(t.db);
    const claimed = await claimAttempt(t.db, seed.runIds[0]!, workerId);
    await finishAttempt(t.db, {
      claimed,
      nextSeq: 1,
      outcome: outcomes.error('setup'),
      queue: new RecordingQueue(),
      settings: { maxConsecutiveExecutionErrors: 14, autoRetryDelayS: 30 },
    });
    await t.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: sql`now()` })
      .where(eq(runs.id, seed.runIds[1]!));
    expect(await reconcile(seed.experimentId)).toBe('completed');
    const before = await experimentRow(t.db, seed.experimentId);
    // A run status change bumps results_revision (the runs trigger), as a re-score would.
    await t.db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, seed.runIds[0]!));
    const bumped = await experimentRow(t.db, seed.experimentId);
    expect(bumped.resultsRevision).toBeGreaterThan(before.resultsRevision);
    expect(await reconcile(seed.experimentId)).toBe('unchanged');
    const after = await experimentRow(t.db, seed.experimentId);
    expect(after).toMatchObject({ status: 'completed', verdictRevision: bumped.resultsRevision });
    expect(after.finishedAt).toEqual(before.finishedAt);
  });

  it('completes a paused experiment that drained, clearing its pause', async () => {
    const seed = await seedLifecycle(t.db);
    await settle(seed.experimentId);
    await t.db
      .update(experiments)
      .set({ status: 'paused', pauseReason: 'spend_ceiling', pausedAt: sql`now()` })
      .where(eq(experiments.id, seed.experimentId));
    expect(await reconcile(seed.experimentId)).toBe('completed');
    expect(await experimentRow(t.db, seed.experimentId)).toMatchObject({
      status: 'completed',
      pauseReason: null,
      pausedAt: null,
    });
  });

  it('completes a cancelled experiment once drained, keeping cancelled_at', async () => {
    const seed = await seedLifecycle(t.db);
    await t.db
      .update(experiments)
      .set({ cancelledAt: sql`now()` })
      .where(eq(experiments.id, seed.experimentId));
    await settle(seed.experimentId);
    expect(await reconcile(seed.experimentId)).toBe('completed');
    const done = await experimentRow(t.db, seed.experimentId);
    expect(done.status).toBe('completed');
    expect(done.cancelledAt).not.toBeNull();
  });

  it('leaves a failed experiment to retry-failed', async () => {
    const seed = await seedLifecycle(t.db);
    await settle(seed.experimentId);
    await t.db
      .update(experiments)
      .set({
        status: 'failed',
        finishedAt: sql`now()`,
        failure: {
          at: new Date().toISOString(),
          threshold: 14,
          category: 'provider',
          exit_code: 1,
          message: 'provider down',
          stderr_first_line: null,
          attempt_id: 'a',
          run_id: seed.runIds[0]!,
        },
      })
      .where(eq(experiments.id, seed.experimentId));
    expect(await reconcile(seed.experimentId)).toBe('unchanged');
    expect((await experimentRow(t.db, seed.experimentId)).status).toBe('failed');
    expect(await reconcile('missing')).toBe('unchanged');
  });
});
