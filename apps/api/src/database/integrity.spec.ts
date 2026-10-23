/**
 * The rules behind the review concerns: stored files are registered blobs,
 * version pointers resolve, only an attempt's current owner can write to it,
 * score sets are published whole and newest-wins, and every relevant change
 * moves the experiment's results revision.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  rejection,
  SQLSTATE,
  type TestDatabase,
} from '../../test/support/database.js';
import {
  blob,
  finishAttempt,
  runningClaim,
  seedExperiment,
  sha,
  startAttempt,
} from '../../test/support/seed.js';
import {
  attempts,
  blobs,
  configurations,
  evaluations,
  experiments,
  runEvents,
  runs,
  scores,
  taskFiles,
} from './schema/index.js';

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
});

afterEach(async () => {
  await t.close();
});

const revision = async (experimentId: string): Promise<number> => {
  const [row] = await t.db
    .select({ r: experiments.resultsRevision })
    .from(experiments)
    .where(eq(experiments.id, experimentId));
  return row!.r;
};

const answerScore = (evaluationId: string) => ({
  evaluationId,
  key: 'answer',
  type: 'json_match' as const,
  status: 'passed' as const,
  isPrimary: true,
  score: 1,
  comment: 'matches',
  scorerVersion: 1,
});

describe('blob registry', () => {
  it('refuses a file reference to a blob that was never stored, and keeps blobs unchanged', async () => {
    const seed = await seedExperiment(t.db);
    const unstored = await rejection(
      t.db.insert(taskFiles).values({
        taskId: seed.task.id,
        path: 'verify/check.py',
        kind: 'verifier',
        sha256: sha('never written'),
        size: 1,
      }),
    );
    expect(unstored.code).toBe(SQLSTATE.foreignKeyViolation);
    const hash = await blob(t.db, 'invoices.csv');
    const edit = await rejection(t.db.update(blobs).set({ size: 1 }).where(eq(blobs.sha256, hash)));
    expect(edit.code).toBe(SQLSTATE.restrictViolation);
    const referenced = await rejection(t.db.delete(blobs).where(eq(blobs.sha256, hash)));
    expect(referenced.code).toBe(SQLSTATE.foreignKeyViolation);
  });
});

describe('version pointers', () => {
  it('require latest_version to name an existing version when the transaction commits', async () => {
    const alone = await rejection(t.db.insert(configurations).values({ name: 'orphan' }));
    expect(alone.code).toBe(SQLSTATE.foreignKeyViolation);
  });
});

describe('attempt leases', () => {
  it('let only the current owner write, and let recovery only end a revoked attempt', async () => {
    const seed = await seedExperiment(t.db);
    const runId = seed.runs[0]!.id;
    const attemptId = await startAttempt(t.db, runId, seed.worker.id);
    const [owned] = await t.db.select().from(attempts).where(eq(attempts.id, attemptId));

    const fencedWrite = (token: string) =>
      t.db
        .update(attempts)
        .set({ sandboxId: 'container-1', sandboxHostId: 'daemon-1' })
        .where(
          and(
            eq(attempts.id, attemptId),
            eq(attempts.leaseToken, token),
            eq(attempts.status, 'running'),
            isNull(attempts.leaseRevokedAt),
          ),
        )
        .returning({ id: attempts.id });

    expect(await fencedWrite('00000000-0000-4000-8000-000000000000')).toHaveLength(0);
    expect(await fencedWrite(owned!.leaseToken)).toHaveLength(1);
    const moveSandbox = await rejection(
      t.db.update(attempts).set({ sandboxId: 'container-2' }).where(eq(attempts.id, attemptId)),
    );
    expect(moveSandbox.code).toBe(SQLSTATE.restrictViolation);

    // Recovery revokes the lease: the old owner's fenced writes now land nowhere.
    await t.db
      .update(attempts)
      .set({ leaseRevokedAt: new Date() })
      .where(eq(attempts.id, attemptId));
    expect(await fencedWrite(owned!.leaseToken)).toHaveLength(0);

    const lateEvent = await rejection(
      t.db.insert(runEvents).values({
        attemptId,
        seq: 1,
        ts: 1,
        type: 'text',
        payload: { type: 'text', text: 'still running' },
      }),
    );
    expect(lateEvent.code).toBe(SQLSTATE.restrictViolation);
    const lateResult = await rejection(
      t.db
        .update(attempts)
        .set({ status: 'executed', finishedAt: new Date(), finalText: 'done' })
        .where(eq(attempts.id, attemptId)),
    );
    expect(lateResult.code).toBe(SQLSTATE.restrictViolation);

    await t.db
      .update(attempts)
      .set({
        status: 'execution_error',
        errorCategory: 'worker_lost',
        errorMessage: 'worker lost',
        exitCode: 137,
        finishedAt: new Date(),
      })
      .where(eq(attempts.id, attemptId));
  });
});

describe('score publication', () => {
  async function executedRun() {
    const seed = await seedExperiment(t.db);
    const runId = seed.runs[0]!.id;
    const attemptId = await startAttempt(t.db, runId, seed.worker.id);
    await finishAttempt(t.db, runId, attemptId);
    return { seed, runId, attemptId };
  }

  const complete = (id: string) =>
    t.db
      .update(evaluations)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(evaluations.id, id));

  it('publishes only a complete score set', async () => {
    const { runId, attemptId } = await executedRun();
    const [evaluation] = await t.db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'initial', generation: 1, ...runningClaim() })
      .returning();
    const empty = await rejection(complete(evaluation!.id));
    expect(empty.message).toMatch(/the task declares/);
    await t.db.insert(scores).values(answerScore(evaluation!.id));
    await complete(evaluation!.id);
  });

  it('never lets a run’s first evaluation fail, or an older generation win', async () => {
    const { runId, attemptId } = await executedRun();
    const [first] = await t.db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'initial', generation: 1, ...runningClaim() })
      .returning();
    const failFirst = await rejection(
      t.db
        .update(evaluations)
        .set({ status: 'failed', error: 'judge unreachable', finishedAt: new Date() })
        .where(eq(evaluations.id, first!.id)),
    );
    expect(failFirst.message).toMatch(/publish error scores instead/);

    await t.db.insert(scores).values(answerScore(first!.id));
    await complete(first!.id);
    const supersedeAlone = await rejection(
      t.db
        .update(evaluations)
        .set({ supersededAt: new Date() })
        .where(eq(evaluations.id, first!.id)),
    );
    expect(supersedeAlone.message).toMatch(/newer generation/);

    // Generation 5 publishes and supersedes 1; a late generation 4 can then never complete.
    const [fifth] = await t.db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'rescore', generation: 5, ...runningClaim() })
      .returning();
    await t.db.insert(scores).values(answerScore(fifth!.id));
    await t.db.transaction(async (tx) => {
      await tx
        .update(evaluations)
        .set({ supersededAt: new Date() })
        .where(eq(evaluations.id, first!.id));
      await tx
        .update(evaluations)
        .set({ status: 'completed', finishedAt: new Date() })
        .where(eq(evaluations.id, fifth!.id));
    });
    const [fourth] = await t.db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'rescore', generation: 4, ...runningClaim() })
      .returning();
    await t.db.insert(scores).values(answerScore(fourth!.id));
    const stale = await rejection(complete(fourth!.id));
    expect(stale.message).toMatch(/older than one already published/);
  });
});

describe('results revision', () => {
  it('moves on every run status change and score publication, never on unrelated writes', async () => {
    const seed = await seedExperiment(t.db);
    const experimentId = seed.experiment.id;
    expect(await revision(experimentId)).toBe(0); // inserts do not bump

    const runId = seed.runs[0]!.id;
    const attemptId = await startAttempt(t.db, runId, seed.worker.id); // queued -> running
    expect(await revision(experimentId)).toBe(1);

    await t.db
      .update(runs)
      .set({ cancelRequestedAt: new Date() })
      .where(eq(runs.id, seed.runs[1]!.id));
    expect(await revision(experimentId)).toBe(1); // not a status change

    // One statement cancelling three runs bumps once.
    await t.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(runs.experimentId, experimentId), eq(runs.status, 'queued')));
    expect(await revision(experimentId)).toBe(2);

    await finishAttempt(t.db, runId, attemptId); // running -> executed
    expect(await revision(experimentId)).toBe(3);

    const [evaluation] = await t.db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'initial', generation: 1, ...runningClaim() })
      .returning();
    await t.db.insert(scores).values(answerScore(evaluation!.id));
    await t.db
      .update(evaluations)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(evaluations.id, evaluation!.id));
    expect(await revision(experimentId)).toBe(4); // a score set was published

    const backwards = await rejection(
      t.db.update(experiments).set({ resultsRevision: 0 }).where(eq(experiments.id, experimentId)),
    );
    expect(backwards.code).toBe(SQLSTATE.restrictViolation);
  });

  it('lets a verdict be appended once per results revision', async () => {
    const seed = await seedExperiment(t.db);
    const experimentId = seed.experiment.id;
    await t.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(eq(runs.experimentId, experimentId));

    const appendVerdict = () =>
      t.db
        .update(experiments)
        .set({
          status: 'completed',
          finishedAt: new Date(),
          verdictHistory: sql`${experiments.verdictHistory} || '[{"cause":"initial"}]'::jsonb`,
          verdictRevision: sql`${experiments.resultsRevision}`,
        })
        .where(
          and(
            eq(experiments.id, experimentId),
            sql`${experiments.verdictRevision} is distinct from ${experiments.resultsRevision}`,
          ),
        )
        .returning({ id: experiments.id });

    expect(await appendVerdict()).toHaveLength(1);
    expect(await appendVerdict()).toHaveLength(0); // a second finisher appends nothing
    const [experiment] = await t.db.select().from(experiments);
    expect(experiment!.verdictHistory).toHaveLength(1);
    expect(experiment!.verdictRevision).toBe(experiment!.resultsRevision);
  });
});
