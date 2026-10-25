/**
 * Two Phase 4 follow-ups (docs/phases/phase-4.md 7.4), on PGlite with the
 * real triggers, in a world of three tasks, the fewest a verdict needs:
 * - #5: a failed experiment's comparison is provisional, as its Overview
 *   is, since Retry failed runs can resume it; its chips and its sentences
 *   are the running experiment's;
 * - #2: the comparison's secondary cost prices every attempt of the arm,
 *   as the Overview's aggregates do (a cancelled run's attempt and a run
 *   not counted yet included), while duration and tokens stay over the
 *   counted runs.
 */
import { eq } from 'drizzle-orm';
import {
  ComparisonViewSchema,
  ExperimentDetailSchema,
  type ScoreStatus,
} from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { attempts, runs } from '../../database/schema/index.js';
import { reconcileExperiment } from '../reconcile.js';
import { ExperimentViewsService } from '../views/experiment-views.service.js';
import {
  at,
  errored,
  fail,
  launch,
  scored,
  seedWorld,
  start,
  tokens,
  type World,
} from '../views/seed.support-spec.js';
import { ComparisonService } from './comparison.service.js';

let t: TestDatabase;
let w: World;

beforeEach(async () => {
  t = await createTestDatabase();
  w = await seedWorld(t.db, { tasks: 3 });
});

afterEach(async () => {
  await t.close();
});

/** Every task: baseline 1 of 2, candidate 2 of 2 (Δ +0.5 each). */
const STATUS: Record<string, ScoreStatus> = {
  base: 'failed',
  cand: 'passed',
};
const statusOf = (key: string): ScoreStatus =>
  key.endsWith('/1') ? 'passed' : STATUS[key.split('/')[1]!]!;

const KEYS = ['a', 'b', 'c'].flatMap((task) =>
  ['base', 'cand'].flatMap((config) => [1, 2].map((rep) => `${task}/${config}/${rep}`)),
);

/** The circuit breaker's stop, as the worker records it, on the given run's attempt. */
async function breakerStop(experimentId: string, runId: string, attemptId: string) {
  await fail(t.db, experimentId, {
    at: at(50).toISOString(),
    threshold: 3,
    category: 'setup',
    exit_code: 1,
    message: 'invoice-db failed to start',
    stderr_first_line: null,
    attempt_id: attemptId,
    run_id: runId,
  });
}

describe('a failed experiment (#5)', () => {
  it('compares provisionally, as its Overview says, with the running sentences', async () => {
    const { experiment, run } = await launch(t.db, w);
    for (const key of KEYS.filter((k) => k !== 'c/cand/2')) {
      await scored(t.db, w, run(key), { startedAt: at(0), durationS: 5, status: statusOf(key) });
    }
    const tripping = await errored(t.db, w, run('c/cand/2'), {
      startedAt: at(10),
      durationS: 2,
      category: 'setup',
    });
    await breakerStop(experiment.id, run('c/cand/2'), tripping);
    // Reconcile leaves a failed experiment alone: no entry is appended.
    expect(await t.db.transaction((tx) => reconcileExperiment(tx, experiment.id))).toBe(
      'unchanged',
    );

    const view = ComparisonViewSchema.parse(
      await new ComparisonService(t.db).comparison(experiment.id, {}),
    );
    expect(view).toMatchObject({ experimentStatus: 'failed', provisional: true });
    expect(view.statistics).toMatchObject({ verdict: 'provisional', provisional: true });
    expect(view.candidates.map((c) => c.verdict)).toEqual(['provisional']);
    const d = ExperimentDetailSchema.parse(
      await new ExperimentViewsService(t.db).detail(experiment.id),
    );
    expect(d.verdicts.map((v) => v.verdict)).toEqual(['provisional']);
  });

  it('says what will fill in when a task still lacks counted runs', async () => {
    const { experiment, run } = await launch(t.db, w);
    // Task c's candidate runs never ran: the breaker stopped the experiment first.
    for (const key of KEYS.filter((k) => !k.startsWith('c/cand/') && k !== 'b/cand/2')) {
      await scored(t.db, w, run(key), { startedAt: at(0), durationS: 5, status: statusOf(key) });
    }
    const tripping = await errored(t.db, w, run('b/cand/2'), {
      startedAt: at(10),
      durationS: 2,
      category: 'setup',
    });
    await breakerStop(experiment.id, run('b/cand/2'), tripping);
    const view = await new ComparisonService(t.db).comparison(experiment.id, {});
    expect(view.statisticsUnavailable).toEqual({
      reason: 'not_enough_runs',
      message:
        'The statistics panel appears once every task has at least 2 scored repetitions per configuration.',
    });
    expect(view.candidates.map((c) => c.verdict)).toEqual(['provisional']);
    const d = await new ExperimentViewsService(t.db).detail(experiment.id);
    expect(d.verdicts.map((v) => [v.verdict, v.reason])).toEqual([['provisional', null]]);
  });
});

describe('the secondary cost (#2)', () => {
  it("prices every attempt of the arm, as the Overview's aggregates do", async () => {
    const { experiment, run } = await launch(t.db, w);
    for (const key of KEYS.filter((k) => k !== 'b/cand/2' && k !== 'c/cand/2')) {
      await scored(t.db, w, run(key), {
        startedAt: at(0),
        durationS: key.includes('/base/') ? 10 : 20,
        status: statusOf(key),
        tokens: tokens(1000),
        costUsd: 0.01,
      });
    }
    // Cancelled while it ran: it does not count, but its attempt was paid for.
    const cancelledAttempt = await start(t.db, w, run('b/cand/2'), at(30));
    await t.db.transaction(async (tx) => {
      await tx
        .update(attempts)
        .set({
          status: 'cancelled',
          finishedAt: at(400),
          durationMs: 370_000,
          tokens: tokens(90_000),
          costUsd: 0.5,
        })
        .where(eq(attempts.id, cancelledAttempt));
      await tx
        .update(runs)
        .set({ status: 'cancelled', finishedAt: at(400) })
        .where(eq(runs.id, run('b/cand/2')));
    });
    // Executed and waiting for its score: not counted yet, paid for already.
    const executedAttempt = await start(t.db, w, run('c/cand/2'), at(30));
    await t.db.transaction(async (tx) => {
      await tx
        .update(attempts)
        .set({
          status: 'executed',
          finishedAt: at(90),
          exitCode: 0,
          finalText: '```json\n{"total": 1}\n```',
          durationMs: 60_000,
          tokens: tokens(50_000),
          costUsd: 0.25,
        })
        .where(eq(attempts.id, executedAttempt));
      await tx
        .update(runs)
        .set({ status: 'executed' })
        .where(eq(runs.id, run('c/cand/2')));
    });

    const view = ComparisonViewSchema.parse(
      await new ComparisonService(t.db).comparison(experiment.id, {}),
    );
    const d = ExperimentDetailSchema.parse(
      await new ExperimentViewsService(t.db).detail(experiment.id),
    );
    const costs = (
      rows: readonly { configuration: { versionId: string }; costUsd: number | null }[],
    ) => rows.map((r) => [r.configuration.versionId, r.costUsd]);
    expect(costs(view.secondary)).toEqual(costs(d.aggregates));
    expect(costs(view.secondary)).toEqual([
      [w.baselineVersionId, 0.06],
      [w.candidateVersionId, 0.79],
    ]);
    expect(view.secondaryDifference!.costUsd).toBe(0.73);
    // Duration and tokens describe the counted runs only: the candidate's four scored runs.
    expect(view.secondary.map((r) => [r.medianDurationS, r.meanTokens])).toEqual([
      [10, 1000],
      [20, 1000],
    ]);
  });
});
