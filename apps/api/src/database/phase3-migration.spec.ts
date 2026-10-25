/**
 * Migration 0006 (Phase 3 scoring): `text_match` joins the scores type
 * CHECK. Re-score needed no trigger change, so this also walks a re-score
 * through the 0001 triggers as the evaluation module does it (plan 9.4):
 * queue the next generation, claim and renew it, publish and supersede, and
 * the dead letter that marks a later re-score failed. Checked on a fresh
 * database, and on one migrated by the Phase 2 build that already holds a
 * scored run.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { SCORER_TYPES, type ScorerType } from '@hermes-evals/shared';
import {
  createTestDatabase,
  createTestDatabaseUpTo,
  rejection,
  SQLSTATE,
  type TestDatabase,
  type TestDb,
} from '../../test/support/database.js';
import {
  finishAttempt,
  runningClaim,
  seedExperiment,
  startAttempt,
} from '../../test/support/seed.js';
import { evaluations, experiments, runs, scores } from './schema/index.js';

let t: TestDatabase | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** The seeded task declares one key, `answer`; any type may grade it. */
const answerScore = (evaluationId: string, type: ScorerType = 'json_match') => ({
  evaluationId,
  key: 'answer',
  type,
  status: 'passed' as const,
  isPrimary: true,
  score: 1,
  comment: 'matches',
  scorerVersion: 1,
});

const revision = async (db: TestDb, experimentId: string): Promise<number> => {
  const [row] = await db
    .select({ r: experiments.resultsRevision })
    .from(experiments)
    .where(eq(experiments.id, experimentId));
  return row!.r;
};

/** The run's current (completed, not superseded) evaluation. */
const current = async (db: TestDb, runId: string) => {
  const rows = await db
    .select({ id: evaluations.id, generation: evaluations.generation })
    .from(evaluations)
    .where(
      and(
        eq(evaluations.runId, runId),
        eq(evaluations.status, 'completed'),
        isNull(evaluations.supersededAt),
      ),
    );
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

/** A run executed and scored by its first evaluation, as Phase 2 leaves it. */
async function scoredRun(db: TestDb) {
  const seed = await seedExperiment(db);
  const runId = seed.runs[0]!.id;
  const attemptId = await startAttempt(db, runId, seed.worker.id);
  await finishAttempt(db, runId, attemptId);
  const [first] = await db
    .insert(evaluations)
    .values({ runId, attemptId, cause: 'initial', generation: 1, ...runningClaim() })
    .returning();
  await db.insert(scores).values(answerScore(first!.id));
  await db.transaction(async (tx) => {
    await tx
      .update(evaluations)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(evaluations.id, first!.id));
    await tx
      .update(runs)
      .set({ status: 'scored', finishedAt: new Date() })
      .where(eq(runs.id, runId));
  });
  return { experimentId: seed.experiment.id, runId, attemptId, firstId: first!.id };
}

describe('migration 0006 rules', () => {
  it('stores a text_match score, and still refuses an unknown type', async () => {
    t = await createTestDatabase();
    const { runId, attemptId } = await scoredRun(t.db);
    const [rescore] = await t.db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'rescore', generation: 2, ...runningClaim() })
      .returning();
    await t.db.insert(scores).values(answerScore(rescore!.id, 'text_match'));
    const unknown = await rejection(
      t.pg.query(
        `insert into scores (id, evaluation_id, key, type, status, comment, scorer_version)
         values ('S1', '${rescore!.id}', 'extra', 'regex_match', 'error', 'x', 1)`,
      ),
    );
    expect(unknown.code).toBe(SQLSTATE.checkViolation);
  });

  it('lists the eight scorer types in the CHECK, in SCORER_TYPES order', async () => {
    t = await createTestDatabase();
    const { rows } = await t.pg.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'scores_type_ck'`,
    );
    const listed = [...rows[0]!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(listed).toEqual([...SCORER_TYPES]);
    expect(listed).toHaveLength(8);
  });
});

describe('a re-score through the integrity triggers', () => {
  it('queues one generation at a time, claims and renews it, then publishes and supersedes', async () => {
    t = await createTestDatabase();
    const db = t.db;
    const { experimentId, runId, attemptId, firstId } = await scoredRun(db);
    const before = await revision(db, experimentId);

    // Queue generation 2: the run stays scored and the revision does not move.
    const [second] = await db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'rescore', generation: 2 })
      .returning();
    expect(second!.status).toBe('queued');
    expect(await revision(db, experimentId)).toBe(before);
    // A double click: a second queued evaluation of the run is refused.
    const double = await rejection(
      db.insert(evaluations).values({ runId, attemptId, cause: 'rescore', generation: 3 }),
    );
    expect(double.code).toBe(SQLSTATE.uniqueViolation);

    // Claim, then renew between keys while the token still matches.
    const token = crypto.randomUUID();
    await db
      .update(evaluations)
      .set({
        status: 'running',
        startedAt: new Date(),
        claimToken: token,
        claimExpiresAt: new Date(Date.now() + 600_000),
      })
      .where(eq(evaluations.id, second!.id));
    const renewed = await db
      .update(evaluations)
      .set({ claimExpiresAt: new Date(Date.now() + 1_200_000) })
      .where(
        and(
          eq(evaluations.id, second!.id),
          eq(evaluations.claimToken, token),
          eq(evaluations.status, 'running'),
        ),
      )
      .returning({ id: evaluations.id });
    expect(renewed).toHaveLength(1);
    expect(await revision(db, experimentId)).toBe(before);
    // The previous result is still the run's result while the re-score runs.
    expect((await current(db, runId)).id).toBe(firstId);

    // Publish: scores, supersede the previous result, complete, all in one transaction.
    await db.insert(scores).values(answerScore(second!.id, 'text_match'));
    await db.transaction(async (tx) => {
      await tx
        .update(evaluations)
        .set({ supersededAt: new Date() })
        .where(eq(evaluations.id, firstId));
      await tx
        .update(evaluations)
        .set({ status: 'completed', finishedAt: new Date() })
        .where(eq(evaluations.id, second!.id));
    });
    expect(await current(db, runId)).toEqual({ id: second!.id, generation: 2 });
    expect(await revision(db, experimentId)).toBeGreaterThan(before);
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run!.status).toBe('scored');
    // The superseded result stays readable, scores and all.
    const old = await db.select().from(scores).where(eq(scores.evaluationId, firstId));
    expect(old.map((s) => s.type)).toEqual(['json_match']);
    // ... and is superseded once: it cannot change again.
    const again = await rejection(
      db
        .update(evaluations)
        .set({ supersededAt: new Date(Date.now() + 1000) })
        .where(eq(evaluations.id, firstId)),
    );
    expect(again.code).toBe(SQLSTATE.restrictViolation);
  });

  it('lets the dead letter fail a re-score, queued or running, and keeps the previous result', async () => {
    t = await createTestDatabase();
    const db = t.db;
    const { experimentId, runId, attemptId, firstId } = await scoredRun(db);
    const before = await revision(db, experimentId);
    const fail = (id: string) =>
      db
        .update(evaluations)
        .set({
          status: 'failed',
          error: 'grading failed after 3 tries: judge unreachable',
          startedAt: new Date(),
          finishedAt: new Date(),
        })
        .where(eq(evaluations.id, id));

    // Never claimed: its job died before any delivery took it.
    const [queued] = await db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'rescore', generation: 2 })
      .returning();
    await fail(queued!.id);
    // Claimed and partly scored: the scores stay, never published.
    const [running] = await db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'rescore', generation: 3, ...runningClaim() })
      .returning();
    await db.insert(scores).values(answerScore(running!.id, 'llm_judge'));
    await fail(running!.id);

    expect((await current(db, runId)).id).toBe(firstId);
    expect(await revision(db, experimentId)).toBe(before);
    // A failed evaluation is final, and a later re-score can still publish.
    const revive = await rejection(
      db.update(evaluations).set({ error: 'retried' }).where(eq(evaluations.id, running!.id)),
    );
    expect(revive.code).toBe(SQLSTATE.restrictViolation);
    const [fourth] = await db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'rescore', generation: 4, ...runningClaim() })
      .returning();
    await db.insert(scores).values(answerScore(fourth!.id));
    await db.transaction(async (tx) => {
      await tx
        .update(evaluations)
        .set({ supersededAt: new Date() })
        .where(eq(evaluations.id, firstId));
      await tx
        .update(evaluations)
        .set({ status: 'completed', finishedAt: new Date() })
        .where(eq(evaluations.id, fourth!.id));
    });
    expect(await current(db, runId)).toEqual({ id: fourth!.id, generation: 4 });
  });
});

describe('migration 0006 on a Phase 2 database', () => {
  it(
    'keeps every score and evaluation, and accepts text_match afterwards',
    { timeout: 30_000 },
    async () => {
      const partial = await createTestDatabaseUpTo('0005_phase2_review');
      t = partial;
      const { runId, attemptId, firstId } = await scoredRun(partial.db);
      // The Phase 2 placeholder for a type without a runtime, as score.ts published it.
      const [second] = await partial.db
        .insert(evaluations)
        .values({ runId, attemptId, cause: 'rescore', generation: 2, ...runningClaim() })
        .returning();
      await partial.db.insert(scores).values({
        ...answerScore(second!.id, 'trajectory_match'),
        status: 'error',
        score: null,
        comment: 'trajectory_match is scored from Phase 3',
        evidence: { error: { message: 'trajectory_match is scored from Phase 3', detail: null } },
      });
      const early = await rejection(
        partial.db.insert(scores).values({ ...answerScore(second!.id, 'text_match'), key: 'text' }),
      );
      expect(early.code).toBe(SQLSTATE.checkViolation);

      await partial.migrateRest();

      const kept = await partial.db
        .select({ evaluationId: scores.evaluationId, type: scores.type, status: scores.status })
        .from(scores);
      expect(kept.toSorted((a, b) => a.type.localeCompare(b.type))).toEqual([
        { evaluationId: firstId, type: 'json_match', status: 'passed' },
        { evaluationId: second!.id, type: 'trajectory_match', status: 'error' },
      ]);
      // Generation 2 is still running, so a third is refused until it finishes.
      const third = await rejection(
        partial.db
          .insert(evaluations)
          .values({ runId, attemptId, cause: 'rescore', generation: 3 }),
      );
      expect(third.code).toBe(SQLSTATE.uniqueViolation);
      await partial.db
        .update(evaluations)
        .set({ status: 'failed', error: 'superseded by the upgrade test', finishedAt: new Date() })
        .where(eq(evaluations.id, second!.id));
      const [fresh] = await partial.db
        .insert(evaluations)
        .values({ runId, attemptId, cause: 'rescore', generation: 3, ...runningClaim() })
        .returning();
      await partial.db.insert(scores).values(answerScore(fresh!.id, 'text_match'));
      const disabled = await partial.pg.query(
        `select tgname from pg_trigger where not tgisinternal and tgenabled = 'D'`,
      );
      expect(disabled.rows).toEqual([]);
    },
  );
});
