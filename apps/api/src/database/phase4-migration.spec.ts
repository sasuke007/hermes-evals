/**
 * Migration 0007 (Phase 4 analysis): `limit` joins the execution-error
 * category CHECK. Verdict entries needed no DDL, so this also appends them
 * the way reconcile does (plan 7.4 step 4): in the conditional update that
 * moves verdict_revision, once per results revision, through the 0001
 * experiments guard. Checked on a fresh database, and on one migrated by the
 * Phase 3 build that already holds an execution error and a completed
 * experiment.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXECUTION_ERROR_CATEGORIES,
  VerdictEntrySchema,
  type ExecutionErrorCategory,
  type VerdictEntry,
} from '@hermes-evals/shared';
import {
  createTestDatabase,
  createTestDatabaseUpTo,
  rejection,
  SQLSTATE,
  type TestDatabase,
  type TestDb,
} from '../../test/support/database.js';
import { seedExperiment, startAttempt } from '../../test/support/seed.js';
import { attempts, experiments, runs } from './schema/index.js';

let t: TestDatabase | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** Ends a running attempt in execution_error and its run with it, as finish.ts does. */
const failAttempt = (
  db: TestDb,
  runId: string,
  attemptId: string,
  category: ExecutionErrorCategory,
) =>
  db.transaction(async (tx) => {
    await tx
      .update(attempts)
      .set({
        status: 'execution_error',
        errorCategory: category,
        errorMessage: 'stopped at the token cap of 2000000 for this attempt',
        exitCode: 1,
        finishedAt: new Date(),
      })
      .where(eq(attempts.id, attemptId));
    await tx
      .update(runs)
      .set({ status: 'execution_error', finishedAt: new Date() })
      .where(eq(runs.id, runId));
  });

/** A verdict entry as Phase 4 writes it, for one candidate. */
const entry = (
  candidateVersionId: string,
  cause: VerdictEntry['cause'],
  resultsRevision: number,
): VerdictEntry => ({
  at: '2026-10-25T10:51:20.000Z',
  cause,
  candidate_version_id: candidateVersionId,
  key: 'primary',
  delta: 0.25,
  lo: 0.0,
  hi: 0.5,
  verdict: 'inconclusive',
  reason: null,
  note: cause === 'initial' ? null : '1 run re-scored',
  results_revision: resultsRevision,
  pass_rates: { baseline: 0.5, candidate: 0.75 },
  pass_counts: { baseline: { passed: 1, counted: 2 }, candidate: { passed: 1, counted: 2 } },
  task_counts: { improved: 1, regressed: 0, unchanged: 0 },
  resamples: 10_000,
  confidence: 0.95,
});

const revisions = async (db: TestDb, experimentId: string) => {
  const [row] = await db
    .select({
      results: experiments.resultsRevision,
      verdict: experiments.verdictRevision,
      history: experiments.verdictHistory,
      status: experiments.status,
    })
    .from(experiments)
    .where(eq(experiments.id, experimentId));
  return row!;
};

/**
 * Reconcile's step 4 with its entries: append and move the verdict revision
 * in one statement, only while the verdict revision trails the results
 * revision. Resolves how many rows it changed (0 or 1).
 */
async function appendVerdicts(
  db: TestDb,
  experimentId: string,
  entries: VerdictEntry[],
): Promise<number> {
  const changed = await db
    .update(experiments)
    .set({
      status: 'completed',
      finishedAt: sql`coalesce(${experiments.finishedAt}, now())`,
      verdictHistory: sql`${experiments.verdictHistory} || ${JSON.stringify(entries)}::jsonb`,
      verdictRevision: sql`${experiments.resultsRevision}`,
    })
    .where(
      and(
        eq(experiments.id, experimentId),
        sql`${experiments.verdictRevision} is distinct from ${experiments.resultsRevision}`,
      ),
    )
    .returning({ id: experiments.id });
  return changed.length;
}

describe('migration 0007 rules', () => {
  it('ends an attempt as execution_error · limit, and still refuses an unknown category', async () => {
    t = await createTestDatabase();
    const seed = await seedExperiment(t.db);
    const [first, second] = seed.runs;
    const capped = await startAttempt(t.db, first!.id, seed.worker.id);
    await failAttempt(t.db, first!.id, capped, 'limit');
    const [stored] = await t.db.select().from(attempts).where(eq(attempts.id, capped));
    expect(stored).toMatchObject({ status: 'execution_error', errorCategory: 'limit' });

    const other = await startAttempt(t.db, second!.id, seed.worker.id);
    const unknown = await rejection(
      t.pg.query(
        `update attempts set status = 'execution_error', error_category = 'token_cap', finished_at = now() where id = '${other}'`,
      ),
    );
    expect(unknown.code).toBe(SQLSTATE.checkViolation);
  });

  it('lists the categories in the CHECK, in EXECUTION_ERROR_CATEGORIES order', async () => {
    t = await createTestDatabase();
    const { rows } = await t.pg.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'attempts_error_category_ck'`,
    );
    const listed = [...rows[0]!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(listed).toEqual([...EXECUTION_ERROR_CATEGORIES]);
    expect(listed.slice(-2)).toEqual(['limit', 'other']);
  });
});

describe('verdict entries through the experiments guard', () => {
  it('appends once per results revision, in the statement that moves the verdict revision', async () => {
    t = await createTestDatabase();
    const db = t.db;
    const seed = await seedExperiment(db);
    const id = seed.experiment.id;
    const candidate = seed.candidateVersionId;

    // The first completion: two finishers, one append.
    const before = await revisions(db, id);
    expect(before.verdict).toBeNull();
    const initial = entry(candidate, 'initial', before.results);
    expect(await appendVerdicts(db, id, [initial])).toBe(1);
    expect(await appendVerdicts(db, id, [initial])).toBe(0);
    const completed = await revisions(db, id);
    expect(completed).toMatchObject({ status: 'completed', verdict: before.results });
    expect(completed.history).toEqual([initial]);

    // A run status change moves the results revision (the 0001 trigger), so
    // the next settle appends again, with cause rescore, and only once.
    await db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(eq(runs.id, seed.runs[0]!.id));
    const moved = await revisions(db, id);
    expect(moved.results).toBeGreaterThan(completed.results);
    const rescore = entry(candidate, 'rescore', moved.results);
    expect(await appendVerdicts(db, id, [rescore])).toBe(1);
    expect(await appendVerdicts(db, id, [rescore])).toBe(0);
    const after = await revisions(db, id);
    expect(after.verdict).toBe(moved.results);
    expect(after.history).toEqual([initial, rescore]);
    expect(after.history.map((e) => VerdictEntrySchema.parse(e))).toEqual([initial, rescore]);

    // The history stays append-only whatever the entries hold.
    const rewrite = await rejection(
      db
        .update(experiments)
        .set({ verdictHistory: [rescore, initial] })
        .where(eq(experiments.id, id)),
    );
    expect(rewrite.code).toBe(SQLSTATE.restrictViolation);
    const backwards = await rejection(
      db
        .update(experiments)
        .set({ verdictRevision: completed.results })
        .where(eq(experiments.id, id)),
    );
    expect(backwards.code).toBe(SQLSTATE.restrictViolation);
  });
});

describe('migration 0007 on a Phase 3 database', () => {
  it(
    'keeps every attempt and verdict, and accepts limit afterwards',
    { timeout: 30_000 },
    async () => {
      const partial = await createTestDatabaseUpTo('0006_phase3_scoring');
      t = partial;
      const db = partial.db;
      const seed = await seedExperiment(db);
      const [first, second, third] = seed.runs;
      const disk = await startAttempt(db, first!.id, seed.worker.id);
      await failAttempt(db, first!.id, disk, 'other');
      const early = await startAttempt(db, second!.id, seed.worker.id);
      const refused = await rejection(failAttempt(db, second!.id, early, 'limit'));
      expect(refused.code).toBe(SQLSTATE.checkViolation);
      // Phase 3 completed experiments with no verdict entry.
      await db
        .update(experiments)
        .set({
          status: 'completed',
          finishedAt: new Date(),
          verdictRevision: sql`${experiments.resultsRevision}`,
        })
        .where(eq(experiments.id, seed.experiment.id));
      const completed = await revisions(db, seed.experiment.id);

      await partial.migrateRest();

      const kept = await db
        .select({ id: attempts.id, status: attempts.status, category: attempts.errorCategory })
        .from(attempts);
      expect(kept.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
        [
          { id: disk, status: 'execution_error', category: 'other' },
          { id: early, status: 'running', category: null },
        ].toSorted((a, b) => a.id.localeCompare(b.id)),
      );
      expect(await revisions(db, seed.experiment.id)).toEqual(completed);
      await failAttempt(db, second!.id, early, 'limit');
      const capped = await startAttempt(db, third!.id, seed.worker.id);
      await failAttempt(db, third!.id, capped, 'limit');
      // The first Phase 4 settle after a status change appends the first entry.
      const moved = await revisions(db, seed.experiment.id);
      expect(moved.results).toBeGreaterThan(completed.results);
      const first4 = entry(seed.candidateVersionId, 'retry', moved.results);
      expect(await appendVerdicts(db, seed.experiment.id, [first4])).toBe(1);
      const disabled = await partial.pg.query(
        `select tgname from pg_trigger where not tgisinternal and tgenabled = 'D'`,
      );
      expect(disabled.rows).toEqual([]);
    },
  );
});
