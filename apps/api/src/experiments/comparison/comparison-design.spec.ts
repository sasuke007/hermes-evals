/**
 * GET /experiments/:id/comparison's answer on the design's own experiments
 * (plan 10.3 and 10.4), seeded into PGlite from the web fixtures
 * (./design-world.support-spec.ts) and completed by reconcile: Skill vs no
 * skill gives the VerdictCard's numbers and the grid the web draws, under
 * every score key; the MCP smoke test (Flow B) stays inconclusive; Skill +
 * MCP compares the candidate asked for, not only the first; the filters
 * keep the counts; an unknown experiment, candidate or key is refused.
 */
import {
  ComparisonViewSchema,
  type ComparisonQuery,
  type ComparisonView,
} from '@hermes-evals/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { eq } from 'drizzle-orm';
import { experiments } from '../../database/schema/index.js';
import { reconcileExperiment } from '../reconcile.js';
import { ComparisonService } from './comparison.service.js';
import { Design, type DesignWorld } from './design-world.support-spec.js';
import { ComparisonInputError, loadComparisonInputs } from './inputs.js';

let t: TestDatabase;
let design: Design;
let svn: DesignWorld;
let smoke: DesignWorld;
let skillMcp: DesignWorld;
let service: ComparisonService;

beforeAll(async () => {
  t = await createTestDatabase();
  design = await Design.load();
  svn = await design.insert(t.db, design.seed('skillVsNoSkill'));
  smoke = await design.insert(t.db, design.seed('mcpSmoke'));
  // Still running: two candidates, 40 of 180 runs scored.
  skillMcp = await design.insert(t.db, design.seed('skillMcp'));
  for (const world of [svn, smoke, skillMcp]) {
    await t.db.transaction((tx) => reconcileExperiment(tx, world.experimentId));
  }
  service = new ComparisonService(t.db);
});

afterAll(async () => {
  await t?.close();
});

const fixtureView = (world: DesignWorld, query: ComparisonQuery): ComparisonView =>
  ComparisonViewSchema.parse(design.comparisonView(world.seed, query));

/** The grid as the web draws it: each row's rates, Δ and change, and each cell's statuses. */
const grid = (view: ComparisonView) =>
  view.rows.map((r) => ({
    task: r.taskKey,
    rates: [r.passBaseline, r.passCandidate, r.delta, r.change],
    cells: [...r.baseline, ...r.candidate].map((c) => [c.repetition, c.runStatus, c.scoreStatus]),
  }));

/** Each scored cell's tooltip, by row and side (an execution error's line is the API's own). */
const tooltips = (view: ComparisonView) =>
  view.rows.map((r) => ({
    task: r.taskKey,
    ...Object.fromEntries(
      (['baseline', 'candidate'] as const).map((side) => [
        side,
        r[side].filter((c) => c.runStatus === 'scored').map((c) => [c.repetition, c.comment]),
      ]),
    ),
  }));

describe('Skill vs no skill, 12 tasks × 5 repetitions × 2 configurations', () => {
  it('answers the design: 0.633, 0.850, +0.217, [+0.117, +0.333], better, 8 · 0 · 4', async () => {
    const view = await service.comparison(svn.experimentId, {});
    expect(ComparisonViewSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      experimentId: svn.experimentId,
      experimentStatus: 'completed',
      provisional: false,
      repetitions: 5,
      scoreKey: 'primary',
      filter: 'all',
      passRates: { baseline: 0.633, candidate: 0.85 },
      passCounts: { baseline: { passed: 38, counted: 60 }, candidate: { passed: 51, counted: 60 } },
      statistics: {
        observedDelta: 0.217,
        lo: 0.117,
        hi: 0.333,
        resamples: 10_000,
        confidence: 0.95,
        verdict: 'better',
        provisional: false,
      },
      statisticsUnavailable: null,
      filterCounts: { all: 12, improved: 8, regressed: 0, unchanged: 4 },
      progress: { scored: 119, total: 120 },
    });
    expect(view.baseline.versionId).toBe(svn.versionIds.get('baseline'));
    expect(view.candidate.versionId).toBe(svn.versionIds.get('with-skill'));
    expect(view.candidates).toEqual([{ configuration: view.candidate, verdict: 'better' }]);
  });

  it('draws the grid, the filters, the key options and the secondary metrics the web draws', async () => {
    const view = await service.comparison(svn.experimentId, {});
    const fixture = fixtureView(svn, { candidate: 'with-skill' });
    expect(grid(view)).toEqual(grid(fixture));
    expect(view.filterCounts).toEqual(fixture.filterCounts);
    expect(view.scoreKeyOptions).toEqual(fixture.scoreKeyOptions);
    // The fixtures price to the cent; the API keeps attempts.cost_usd's precision.
    const secondary = (v: ComparisonView) =>
      v.secondary.map(({ configuration: _c, costUsd: _cost, ...row }) => row);
    expect(secondary(view)).toEqual(secondary(fixture));
    expect(view.secondary.map((r) => r.costUsd)).toEqual([0.7077, 0.9855]);
    expect(view.secondaryDifference).toEqual({ ...fixture.secondaryDifference, costUsd: 0.2778 });
    // The sensitivity figure leaves out the timeout and the two ungradable answers;
    // its Δ is the mean over tasks of the kept runs' differences, as the observed one.
    expect(view.sensitivity).toMatchObject({
      excludedBaseline: fixture.sensitivity!.excludedBaseline,
      excludedCandidate: fixture.sensitivity!.excludedCandidate,
      baseline: fixture.sensitivity!.baseline,
      candidate: fixture.sensitivity!.candidate,
      delta: fixture.sensitivity!.delta,
      verdict: 'better',
      verdictChanges: false,
    });
    expect(view.sensitivity!.delta).toBe(0.204);
  });

  it('carries each cell: run, repetition, attempt, duration and the tooltip comment', async () => {
    const view = await service.comparison(svn.experimentId, {});
    const fixture = fixtureView(svn, { candidate: 'with-skill' });
    const disputed = view.rows.find((r) => r.taskKey === 'disputed')!;
    const fixtureDisputed = fixture.rows.find((r) => r.taskKey === 'disputed')!;
    expect(disputed.baseline.map((c) => c.runId)).toEqual(
      [1, 2, 3, 4, 5].map((rep) => svn.run('disputed', 'baseline', rep)),
    );
    expect(disputed.baseline.map((c) => [c.attempt, c.durationS])).toEqual(
      fixtureDisputed.baseline.map((c) => [c.attempt, c.durationS]),
    );
    const timedOut = disputed.baseline.find((c) => c.runStatus === 'execution_error')!;
    expect(timedOut).toMatchObject({
      scoreStatus: null,
      comment: 'execution_error · timeout: timeout in disputed',
    });
    const failed = disputed.baseline.find((c) => c.scoreStatus === 'failed')!;
    expect(failed.comment).toBe(
      fixtureDisputed.baseline.find((c) => c.scoreStatus === 'failed')!.comment,
    );
  });

  it.each(['answer', 'any_failed'])('grades every run by key %s as the web does', async (key) => {
    const view = await service.comparison(svn.experimentId, { key });
    const fixture = fixtureView(svn, { candidate: 'with-skill', key });
    expect(view.scoreKey).toBe(key);
    expect(grid(view)).toEqual(grid(fixture));
    expect(view.filterCounts).toEqual(fixture.filterCounts);
    // Pooled over the cells by the selected key, as the fixtures pool them.
    const passed = (side: 'baseline' | 'candidate') =>
      view.rows.flatMap((r) => r[side]).filter((c) => c.scoreStatus === 'passed').length;
    expect(view.passCounts).toEqual({
      baseline: { passed: passed('baseline'), counted: 60 },
      candidate: { passed: passed('candidate'), counted: 60 },
    });
    expect(view.passCounts).toEqual(fixture.passCounts);
    expect(view.passRates).toEqual(fixture.passRates);
    expect(view.statistics!.observedDelta).toBe(fixture.statistics!.observedDelta);
    expect(view.sensitivity).toMatchObject({
      excludedBaseline: fixture.sensitivity!.excludedBaseline,
      excludedCandidate: fixture.sensitivity!.excludedCandidate,
      delta: fixture.sensitivity!.delta,
    });
    expect(view.secondary.map((r) => r.ungradable)).toEqual(
      fixture.secondary.map((r) => r.ungradable),
    );
    // Every tooltip is the primary score's comment, whatever key grades the cell.
    expect(tooltips(view)).toEqual(tooltips(fixture));
    // The candidate select's chips are the primary key's verdicts whatever key is shown.
    expect(view.candidates.map((c) => c.verdict)).toEqual(['better']);
  });

  it('under any_failed, colours a cell by the key that decided it and keeps the primary comment', async () => {
    const view = await service.comparison(svn.experimentId, { key: 'any_failed' });
    expect(view.passCounts).toEqual({
      baseline: { passed: 32, counted: 60 },
      candidate: { passed: 45, counted: 60 },
    });
    // credit_notes · with-skill · rep 4: the primary key passed, its `method` key errored.
    const cell = view.rows
      .find((r) => r.taskKey === 'credit_notes')!
      .candidate.find((c) => c.repetition === 4)!;
    expect(cell).toMatchObject({
      runId: svn.run('credit_notes', 'with-skill', 4),
      scoreStatus: 'error',
      comment: 'answer matched the reference',
    });
  });

  it('filters the rows and keeps the counts of all of them', async () => {
    const all = await service.comparison(svn.experimentId, {});
    for (const filter of ['improved', 'regressed', 'unchanged'] as const) {
      const view = await service.comparison(svn.experimentId, { filter });
      expect(view.filter).toBe(filter);
      expect(view.filterCounts).toEqual(all.filterCounts);
      expect(view.rows.map((r) => r.taskKey)).toEqual(
        all.rows.filter((r) => r.change === filter).map((r) => r.taskKey),
      );
      expect(view.statistics).toEqual(all.statistics);
    }
    // Sorted by Δ descending, then the baseline pass rate, then the task.
    expect(all.rows.map((r) => r.taskKey).slice(0, 4)).toEqual([
      'dup_invoices',
      'credit_notes',
      'late_fees',
      'overdue_list',
    ]);
  });
});

describe('Flow B: the MCP smoke test, 3 repetitions', () => {
  it('stays inconclusive, its interval straddling 0', async () => {
    const view = await service.comparison(smoke.experimentId, {});
    expect(view.statistics).toMatchObject({ verdict: 'inconclusive', provisional: false });
    expect(view.statistics!.lo).toBeLessThan(0);
    expect(view.statistics!.hi).toBeGreaterThan(0);
    expect(view.statistics!.observedDelta).toBe(0.056);
    expect(view.filterCounts).toEqual({ all: 12, improved: 2, regressed: 2, unchanged: 8 });
    expect(view.candidates.map((c) => c.verdict)).toEqual(['inconclusive']);
    expect(grid(view)).toEqual(grid(fixtureView(smoke, { candidate: 'with-mcp' })));
  });
});

describe('Skill + MCP: two candidates', () => {
  const versionOf = (name: string) => skillMcp.versionIds.get(name)!;

  it('compares the candidate asked for, and offers both in experiment order', async () => {
    const view = await service.comparison(skillMcp.experimentId, {
      candidate: versionOf('with-mcp'),
    });
    const fixture = fixtureView(skillMcp, { candidate: 'with-mcp' });
    expect(view.baseline.versionId).toBe(versionOf('baseline'));
    expect(view.candidate.versionId).toBe(versionOf('with-mcp'));
    expect(grid(view)).toEqual(grid(fixture));
    expect(tooltips(view)).toEqual(tooltips(fixture));
    expect(view.filterCounts).toEqual(fixture.filterCounts);
    expect(view.passCounts).toEqual(fixture.passCounts);
    expect(view.passRates).toEqual(fixture.passRates);
    expect(view.statisticsUnavailable).toEqual(fixture.statisticsUnavailable);
    expect(view.progress).toEqual(fixture.progress);
    expect(view.candidates.map((c) => c.configuration.versionId)).toEqual(
      fixture.candidates.map((c) => versionOf(c.configuration.name)),
    );
    expect(view.candidates.map((c) => c.configuration.versionId)).toEqual([
      versionOf('with-skill'),
      versionOf('with-mcp'),
    ]);
    // Every chip reads provisional while the experiment runs (the design's
    // board shows with-skill's earlier verdict, which the API has no entry for).
    expect(view.candidates.map((c) => c.verdict)).toEqual(['provisional', 'provisional']);
  });

  it('answers each candidate apart, from memory once asked', async () => {
    const second = await service.comparison(skillMcp.experimentId, {
      candidate: versionOf('with-mcp'),
    });
    const first = await service.comparison(skillMcp.experimentId, {});
    expect(first.candidate.versionId).toBe(versionOf('with-skill'));
    expect(grid(first)).toEqual(grid(fixtureView(skillMcp, { candidate: 'with-skill' })));
    expect(grid(first)).not.toEqual(grid(second));
    expect(
      await service.comparison(skillMcp.experimentId, { candidate: versionOf('with-skill') }),
    ).toBe(first);
    expect(
      await service.comparison(skillMcp.experimentId, { candidate: versionOf('with-mcp') }),
    ).toBe(second);
  });
});

describe('what the comparison refuses', () => {
  it('answers 404 for an unknown experiment', async () => {
    await expect(service.comparison('01NOPE', {})).rejects.toMatchObject({
      status: 404,
      response: { statusCode: 404, message: 'Experiment 01NOPE does not exist.' },
    });
  });

  it('answers 400 for a candidate the experiment does not test, the baseline included', async () => {
    for (const candidate of ['01NOPE', svn.versionIds.get('baseline')!]) {
      await expect(service.comparison(svn.experimentId, { candidate })).rejects.toMatchObject({
        status: 400,
        response: {
          statusCode: 400,
          message: `Configuration version ${candidate} is not a candidate of experiment ${svn.experimentId}.`,
        },
      });
    }
  });

  it('answers 400 for a key some selected task does not declare', async () => {
    const view = await service.comparison(svn.experimentId, {});
    const offered = new Set(view.scoreKeyOptions.map((o) => o.value));
    await expect(service.comparison(svn.experimentId, { key: 'rationale' })).rejects.toMatchObject({
      status: 400,
      response: {
        statusCode: 400,
        message: expect.stringMatching(
          /^Score key rationale is not declared by every selected task \(missing from .+\)\.$/,
        ),
      },
    });
    expect(offered.has('rationale')).toBe(false);
    await expect(service.comparison(svn.experimentId, { key: 'nope' })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('loadComparisonInputs', () => {
  it('reads one candidate and key in the caller’s transaction, at the row’s results revision', async () => {
    const [row] = await t.db
      .select({ revision: experiments.resultsRevision })
      .from(experiments)
      .where(eq(experiments.id, svn.experimentId));
    const inputs = await t.db.transaction((tx) =>
      loadComparisonInputs(tx, svn.experimentId, undefined, { kind: 'named', key: 'answer' }),
    );
    expect(inputs).toMatchObject({
      experimentId: svn.experimentId,
      status: 'completed',
      repetitions: 5,
      resultsRevision: row!.revision,
      baselineVersionId: svn.versionIds.get('baseline'),
      candidateVersionId: svn.versionIds.get('with-skill'),
      candidateVersionIds: [svn.versionIds.get('with-skill')],
      commonKeys: ['answer'],
      scoreKey: 'answer',
    });
    expect(inputs!.tasks.map((task) => task.taskKey)).toEqual(design.taskKeys);
    expect(inputs!.stats).toMatchObject({
      repetitions: 5,
      provisional: false,
      progress: { scored: 119, total: 120 },
    });
    // Every run is in the grid; only scored and execution_error runs are counted.
    expect(inputs!.tasks.flatMap((task) => [...task.baseline, ...task.candidate])).toHaveLength(
      120,
    );
    expect(
      inputs!.stats.tasks.flatMap((task) => [...task.baseline, ...task.candidate]),
    ).toHaveLength(120);

    await expect(
      t.db.transaction((tx) => loadComparisonInputs(tx, '01NOPE', undefined, { kind: 'primary' })),
    ).resolves.toBeNull();
    await expect(
      t.db.transaction((tx) =>
        loadComparisonInputs(tx, svn.experimentId, undefined, { kind: 'named', key: 'nope' }),
      ),
    ).rejects.toBeInstanceOf(ComparisonInputError);
  });
});
