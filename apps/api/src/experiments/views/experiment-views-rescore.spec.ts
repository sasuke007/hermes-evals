/**
 * A re-scored run counts once, with its current result, wherever an
 * experiment is summed up (plan 9.4): runFactsOf, GET /experiments/:id and
 * the live SSE state all read only the generation that is completed and not
 * superseded. Over PGlite with the real triggers; the superseded generations
 * keep their rows, as they do in production, so a missing filter would count
 * a re-scored run once per generation.
 */
import { ExperimentDetailSchema } from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { rescoreRun } from '../../../test/support/seed.js';
import { DbLiveSource } from '../sse/live-source.js';
import { ExperimentViewsService } from './experiment-views.service.js';
import { runFactsOf } from './queries.js';
import { at, launch, scored, seedWorld } from './seed.support-spec.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
});

afterEach(async () => {
  await t.close();
});

describe('a re-scored run', () => {
  it('counts once, with its current generation, in the facts, the detail and the live state', async () => {
    const w = await seedWorld(t.db);
    const { experiment, run } = await launch(t.db, w, { repetitions: 1 });
    const first = {
      'a/base/1': 'passed',
      'b/base/1': 'failed',
      'a/cand/1': 'passed',
      'b/cand/1': 'passed',
    } as const;
    for (const [key, status] of Object.entries(first)) {
      await scored(t.db, w, run(key), { startedAt: at(1), durationS: 5, status });
    }
    // Re-scores: baseline's results swap; a/cand/1 is re-scored twice and ends where it began.
    await rescoreRun(t.db, run('a/base/1'), 'failed');
    await rescoreRun(t.db, run('b/base/1'), 'passed');
    await rescoreRun(t.db, run('a/cand/1'), 'failed');
    await rescoreRun(t.db, run('a/cand/1'), 'passed');
    const current = new Map([
      [run('a/base/1'), 'failed'],
      [run('b/base/1'), 'passed'],
      [run('a/cand/1'), 'passed'],
      [run('b/cand/1'), 'passed'],
    ]);

    const facts = await runFactsOf(t.db, experiment.id);
    expect(facts).toHaveLength(4);
    expect(new Map(facts.map((f) => [f.id, f.primary?.status]))).toEqual(current);

    const d = ExperimentDetailSchema.parse(
      await new ExperimentViewsService(t.db).detail(experiment.id, at(100)),
    );
    expect(d.totalRuns).toBe(4);
    expect(d.counts.scored).toBe(4);
    expect(d.perConfiguration.map((c) => [c.total, c.counts.scored, c.passed])).toEqual([
      [2, 2, 1],
      [2, 2, 2],
    ]);
    expect(d.aggregates.map((a) => [a.runs, a.passRate])).toEqual([
      [2, 0.5],
      [2, 1],
    ]);
    expect(d.feed).toHaveLength(4);

    const live = await new DbLiveSource(t.db).state(experiment.id);
    expect(live.counts.scored).toBe(4);
    expect(live.runs.size).toBe(4);
    expect(new Map([...live.runs].map(([id, r]) => [id, r.primaryScore?.status]))).toEqual(current);
  });
});
