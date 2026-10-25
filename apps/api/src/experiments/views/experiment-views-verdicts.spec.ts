/**
 * The verdicts wherever an experiment is summed up, once reconcile has
 * recorded them (plan 10.3, UI_FLOWS 14): the Overview's VerdictCards with
 * their "Updated … · previously …" history, the list's verdict chips, the
 * live `experiment` event, and the configuration usage list, all from the
 * last history entry per candidate. Also the live stream's run fields for a
 * re-score (T4 #3): a queued re-score and a dead-lettered one move the
 * stream's version, though no results revision moves. On PGlite with the
 * real triggers.
 */
import { eq } from 'drizzle-orm';
import {
  ExperimentDetailSchema,
  ExperimentEventSchema,
  ExperimentListRowSchema,
  type ScoreStatus,
} from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { rescoreRun } from '../../../test/support/seed.js';
import { configurationUsage } from '../../configurations/usage.js';
import { evaluations, experiments } from '../../database/schema/index.js';
import { reconcileExperiment } from '../reconcile.js';
import { diffEvents, initialEvents } from '../sse/experiment-diff.js';
import { DbLiveSource } from '../sse/live-source.js';
import { ExperimentViewsService } from './experiment-views.service.js';
import { at, complete, launch, scored, seedWorld, type World } from './seed.support-spec.js';

let t: TestDatabase;
let w: World;
let views: ExperimentViewsService;

beforeEach(async () => {
  t = await createTestDatabase();
  w = await seedWorld(t.db);
  views = new ExperimentViewsService(t.db);
});

afterEach(async () => {
  await t.close();
});

/** a: baseline 1 of 2, candidate 2 of 2; b: baseline 0 of 2, candidate 1 of 2 (Δ +0.5 on both). */
const MATRIX: Record<string, ScoreStatus> = {
  'a/base/1': 'passed',
  'a/base/2': 'failed',
  'a/cand/1': 'passed',
  'a/cand/2': 'passed',
  'b/base/1': 'failed',
  'b/base/2': 'failed',
  'b/cand/1': 'passed',
  'b/cand/2': 'failed',
};

async function settled() {
  const launched = await launch(t.db, w);
  for (const [key, status] of Object.entries(MATRIX)) {
    await scored(t.db, w, launched.run(key), { startedAt: at(0), durationS: 10, status });
  }
  return launched;
}

const reconcile = (id: string) => t.db.transaction((tx) => reconcileExperiment(tx, id));

const usageOf = async (versionId: string) => configurationUsage(t.db, new Map([[versionId, 1]]));

describe('a completed experiment', () => {
  it('shows its last entry everywhere, and the entries before it as the history', async () => {
    const { experiment, run } = await settled();
    await reconcile(experiment.id);
    // A re-score moves task b's candidate from 1 of 2 to 2 of 2: Δ +0.75, still better.
    await rescoreRun(t.db, run('b/cand/2'), 'passed');
    await reconcile(experiment.id);
    const [row] = await t.db.select().from(experiments).where(eq(experiments.id, experiment.id));
    const [initial, rescore] = row!.verdictHistory;
    expect([initial!.cause, rescore!.cause]).toEqual(['initial', 'rescore']);

    const d = ExperimentDetailSchema.parse(await views.detail(experiment.id));
    expect(d.verdicts).toEqual([
      {
        baseline: expect.objectContaining({ versionId: w.baselineVersionId }),
        candidate: expect.objectContaining({ versionId: w.candidateVersionId, name: 'with-mcp' }),
        verdict: 'better',
        scoreKey: 'primary',
        delta: 0.75,
        lo: 0.5,
        hi: 1,
        passRates: { baseline: 0.25, candidate: 1 },
        passCounts: { baseline: { passed: 1, counted: 4 }, candidate: { passed: 4, counted: 4 } },
        taskCounts: { improved: 2, regressed: 0, unchanged: 0 },
        method: { name: 'paired_bootstrap', resamples: 10_000, confidence: 0.95 },
        reason: null,
        history: [
          {
            at: initial!.at,
            cause: 'initial',
            note: null,
            delta: 0.5,
            lo: 0.5,
            hi: 0.5,
            verdict: 'better',
          },
          {
            at: rescore!.at,
            cause: 'rescore',
            note: '1 run re-scored',
            delta: 0.75,
            lo: 0.5,
            hi: 1,
            verdict: 'better',
          },
        ],
      },
    ]);

    const listed = ExperimentListRowSchema.array().parse(await views.list());
    expect(listed.find((r) => r.id === experiment.id)!.verdicts).toEqual([
      {
        candidate: 'with-mcp',
        candidateVersionId: w.candidateVersionId,
        verdict: 'better',
        delta: 0.75,
        lo: 0.5,
        hi: 1,
      },
    ]);

    const live = await new DbLiveSource(t.db).state(experiment.id);
    expect(live.verdicts).toEqual(listed.find((r) => r.id === experiment.id)!.verdicts);
    expect(live.verdictUpdatedAt).toBe(rescore!.at);
    const [event] = initialEvents(live, at(200).toISOString());
    expect(ExperimentEventSchema.parse(event)).toMatchObject({
      type: 'experiment',
      status: 'completed',
      verdicts: live.verdicts,
      verdictUpdatedAt: rescore!.at,
    });

    expect((await usageOf(w.candidateVersionId))[0]).toMatchObject({
      role: 'candidate',
      verdict: 'better',
    });
    expect((await usageOf(w.baselineVersionId))[0]).toMatchObject({
      role: 'baseline',
      verdict: null,
    });
  });

  it('sends the experiment event when a re-score appends an entry, even with the same numbers', async () => {
    const { experiment, run } = await settled();
    await reconcile(experiment.id);
    const source = new DbLiveSource(t.db);
    const v0 = await source.version(experiment.id);
    const before = await source.state(experiment.id);
    // b/cand/2 failed, and is re-scored failed: the numbers stay, an entry is appended.
    await rescoreRun(t.db, run('b/cand/2'), 'failed');
    await reconcile(experiment.id);
    expect(await source.version(experiment.id)).not.toBe(v0);
    const after = await source.state(experiment.id);
    expect(after.verdicts).toEqual(before.verdicts);
    expect(after.verdictUpdatedAt).not.toBe(before.verdictUpdatedAt);
    const events = diffEvents(before, after, at(300).toISOString()).map((e) =>
      ExperimentEventSchema.parse(e),
    );
    expect(events.map((e) => e.type)).toEqual(['run', 'experiment']);
    expect(events[0]).toMatchObject({
      runId: run('b/cand/2'),
      generation: 2,
      rescorePending: false,
    });
  });

  it('completed before verdicts were recorded: its figures as they stand, as final', async () => {
    const { experiment } = await settled();
    await complete(t.db, experiment.id, at(100));
    const d = ExperimentDetailSchema.parse(await views.detail(experiment.id));
    expect(d.verdicts.map((v) => [v.verdict, v.delta, v.lo, v.hi, v.history])).toEqual([
      ['better', 0.5, 0.5, 0.5, []],
    ]);
    const listed = ExperimentListRowSchema.array().parse(await views.list());
    expect(listed[0]!.verdicts.map((v) => v.verdict)).toEqual(['better']);
    expect((await new DbLiveSource(t.db).state(experiment.id)).verdicts).toEqual(
      listed[0]!.verdicts,
    );
    expect((await usageOf(w.candidateVersionId))[0]!.verdict).toBe('better');
  });
});

describe('an experiment that has not completed', () => {
  it('lists no verdict, and shows the provisional figures on the Overview', async () => {
    const { experiment } = await settled();
    const d = ExperimentDetailSchema.parse(await views.detail(experiment.id));
    expect(d.verdicts.map((v) => [v.verdict, v.delta, v.lo, v.hi, v.reason])).toEqual([
      ['provisional', 0.5, 0.5, 0.5, null],
    ]);
    const listed = ExperimentListRowSchema.array().parse(await views.list());
    expect(listed[0]!.verdicts).toEqual([]);
    expect((await usageOf(w.candidateVersionId))[0]!.verdict).toBe('provisional');
  });

  it('is not computable at once with one repetition', async () => {
    const { experiment, run } = await launch(t.db, w, { repetitions: 1 });
    await scored(t.db, w, run('a/base/1'), { startedAt: at(0), durationS: 5, status: 'passed' });
    const d = ExperimentDetailSchema.parse(await views.detail(experiment.id));
    expect(d.verdicts.map((v) => [v.verdict, v.reason, v.delta])).toEqual([
      ['not_computable', 'single_repetition', null],
    ]);
  });
});

describe('the live run fields of a re-score', () => {
  it('turn rescorePending on when one is queued and off when it dies, with the version moving each time', async () => {
    const { experiment, run } = await settled();
    const source = new DbLiveSource(t.db);
    const id = run('a/base/2');
    const v0 = await source.version(experiment.id);
    const s0 = await source.state(experiment.id);
    expect(s0.runs.get(id)).toMatchObject({ generation: 1, rescorePending: false });

    const [current] = await t.db.select().from(evaluations).where(eq(evaluations.runId, id));
    const [queued] = await t.db
      .insert(evaluations)
      .values({ runId: id, attemptId: current!.attemptId, cause: 'rescore', generation: 2 })
      .returning({ id: evaluations.id });
    const v1 = await source.version(experiment.id);
    expect(v1).not.toBe(v0);
    const s1 = await source.state(experiment.id);
    expect(s1.runs.get(id)).toMatchObject({ generation: 1, rescorePending: true });
    expect(diffEvents(s0, s1, at(10).toISOString())).toEqual([
      expect.objectContaining({ type: 'run', runId: id, generation: 1, rescorePending: true }),
    ]);

    // evaluate-run-dead marks a dead re-score failed; the previous result stays current.
    await t.db
      .update(evaluations)
      .set({
        status: 'failed',
        startedAt: new Date(),
        finishedAt: new Date(),
        error: 'judge unreachable',
      })
      .where(eq(evaluations.id, queued!.id));
    expect(await source.version(experiment.id)).not.toBe(v1);
    const s2 = await source.state(experiment.id);
    expect(s2.runs.get(id)).toMatchObject({ generation: 1, rescorePending: false });
  });
});
