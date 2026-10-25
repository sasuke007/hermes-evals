/**
 * Re-score under real concurrency, on Postgres 17 through node-postgres
 * with the real pg-boss on the same database and the real evaluate-run
 * handler: requests for one run that race (lined up behind the experiment
 * row, or simply sent at once) create one evaluation and one job; the new
 * generation publishes once however many deliveries race, supersedes
 * generation 1, and the run stays scored throughout.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BulkRescoreResultSchema, RescoreRunResultSchema } from '@hermes-evals/shared';
import { runs } from '../../database/schema/index.js';
import { launched, type Launched } from '../../experiments/commands/commands-app.support-spec.js';
import {
  createE2eDatabase,
  EXPERIMENT_ROW_LOCK,
  holdExperiment,
  started,
  waitForLockWaits,
  type E2eDatabase,
} from '../../experiments/commands/commands-e2e.support-spec.js';
import { experimentRow, runsOf } from '../../experiments/commands/commands-seed.support-spec.js';
import type { BlobStore } from '../../storage/blob-store.js';
import {
  evaluateRunJobKeys,
  evaluationsOf,
  grade,
  scoreRun,
  scratchStore,
} from './rescore-seed.support-spec.js';

let e: E2eDatabase;
let x: Launched;
let store: BlobStore;
let disposeStore: () => Promise<void>;

beforeEach(async () => {
  e = await createE2eDatabase('rescore');
  x = await launched(e.c);
  ({ store, dispose: disposeStore } = await scratchStore());
});

afterEach(async () => {
  await e?.close();
  await disposeStore?.();
});

const runStatus = async (runId: string) => {
  const [run] = await e.c.t.db.select().from(runs).where(eq(runs.id, runId));
  return run!.status;
};

describe('re-score on Postgres 17', () => {
  it('publishes generation 2, which supersedes generation 1; racing deliveries publish once', async () => {
    const [run] = await runsOf(e.c.t.db, x.id);
    const first = await scoreRun(e.c, store, run!.id, x.workerId);
    const revision = (await experimentRow(e.c.t.db, x.id)).resultsRevision;

    const res = await e.c.post(`/runs/${run!.id}/rescore`).expect(200);
    const { evaluation } = RescoreRunResultSchema.parse(res.body);
    expect(evaluation).toMatchObject({ generation: 2, status: 'queued', cause: 'rescore' });
    expect(await evaluateRunJobKeys(e.c)).toContain(evaluation.evaluationId);
    expect(await runStatus(run!.id)).toBe('scored');

    // Three deliveries of the same job at once: each claims in turn, only
    // the newest claim publishes, and the others change nothing.
    const outcomes = await Promise.all(
      [1, 2, 3].map(() => grade(e.c.t.db, store, evaluation.evaluationId)),
    );
    expect(outcomes.filter((o) => o === 'published')).toHaveLength(1);
    expect(outcomes.every((o) => ['published', 'lost', 'finished'].includes(o))).toBe(true);
    expect(await grade(e.c.t.db, store, evaluation.evaluationId)).toBe('finished');

    const [old, fresh] = await evaluationsOf(e.c.t.db, run!.id);
    expect(old).toMatchObject({ id: first.evaluationId, generation: 1, status: 'completed' });
    expect(old!.supersededAt).toBeInstanceOf(Date);
    expect(fresh).toMatchObject({
      id: evaluation.evaluationId,
      generation: 2,
      status: 'completed',
      supersededAt: null,
    });
    expect(await runStatus(run!.id)).toBe('scored');
    expect((await experimentRow(e.c.t.db, x.id)).resultsRevision).toBeGreaterThan(revision);
  });

  it('two requests lined up behind the experiment row create one evaluation', async () => {
    const [run] = await runsOf(e.c.t.db, x.id);
    await scoreRun(e.c, store, run!.id, x.workerId);

    const held = await holdExperiment(e.pool, x.id);
    const a = started(e.c.post(`/runs/${run!.id}/rescore`));
    const b = started(e.c.post(`/runs/${run!.id}/rescore`));
    await waitForLockWaits(e.pool, 2, EXPERIMENT_ROW_LOCK);
    await held.commit();
    const answers = (await Promise.all([a, b])).map((r) => {
      expect(r.status).toBe(200);
      return RescoreRunResultSchema.parse(r.body);
    });

    expect(new Set(answers.map((r) => r.evaluation.evaluationId)).size).toBe(1);
    expect(answers.filter((r) => r.joinedPending)).toHaveLength(1);
    const all = await evaluationsOf(e.c.t.db, run!.id);
    expect(all.map((v) => [v.generation, v.status])).toEqual([
      [1, 'completed'],
      [2, 'queued'],
    ]);
    const id = answers[0]!.evaluation.evaluationId;
    expect((await evaluateRunJobKeys(e.c)).filter((k) => k === id)).toHaveLength(1);
  });

  it('a burst of single and bulk requests at once still makes one evaluation per run', async () => {
    const [one, two] = await runsOf(e.c.t.db, x.id);
    await scoreRun(e.c, store, one!.id, x.workerId);
    await scoreRun(e.c, store, two!.id, x.workerId);

    const responses = await Promise.all([
      ...[1, 2, 3].map(() => e.c.post(`/runs/${one!.id}/rescore`)),
      e.c.post(`/experiments/${x.id}/runs/rescore`, { runIds: [one!.id, two!.id] }),
      e.c.post(`/experiments/${x.id}/runs/rescore`, { runIds: [two!.id] }),
    ]);
    for (const r of responses) expect(r.status).toBe(200);
    const singles = responses.slice(0, 3).map((r) => RescoreRunResultSchema.parse(r.body));
    const bulks = responses.slice(3).map((r) => BulkRescoreResultSchema.parse(r.body));
    expect(bulks.every((b) => b.refused.length === 0)).toBe(true);

    for (const runId of [one!.id, two!.id]) {
      const queued = (await evaluationsOf(e.c.t.db, runId)).filter((v) => v.status === 'queued');
      expect(queued).toHaveLength(1);
      expect(queued[0]!.generation).toBe(2);
      const answered = [
        ...singles.filter((s) => s.runId === runId).map((s) => s.evaluation.evaluationId),
        ...bulks.flatMap((b) => b.evaluations.filter((v) => v.runId === runId)),
      ].map((v) => (typeof v === 'string' ? v : v.evaluationId));
      expect(new Set(answered)).toEqual(new Set([queued[0]!.id]));
      // Exactly one request created it; every other one joined it.
      const created = [
        ...singles.filter((s) => s.runId === runId && !s.joinedPending),
        ...bulks.flatMap((b) => b.evaluations.filter((v) => v.runId === runId && !v.joinedPending)),
      ];
      expect(created).toHaveLength(1);
    }
  });
});
