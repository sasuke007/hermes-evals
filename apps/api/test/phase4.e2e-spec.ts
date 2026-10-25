/**
 * Phase 4 end to end: the comparison and the verdict history, on the real
 * AppModule and WorkerModule over a fresh Postgres 17 database, with real
 * pg-boss, the real lifecycle, runner, evaluation and reconcile. As in
 * Phases 2 and 3 only the sandbox is replaced (test/support/fake-engine.ts)
 * and the fake egress serves the judge's path, so no model is ever called.
 * Every HTTP answer is parsed with its shared schema.
 *
 * The suite (test/fixtures/phase4-suite) has four tasks, three repetitions
 * each; `good` passes every task and `weak` fails three of them, two of its
 * runs dying before init (test/support/phase4-trials.ts). The main
 * experiment then reads `better`; a re-score that fails one judged run, a
 * retry of an execution error and the cancel of another retry each move its
 * results revision, and each must give a fresh comparison and one more
 * verdict entry. A second experiment where both pass equally reads
 * `inconclusive`, and a third with one repetition `not_computable`.
 *
 * The interval bounds asserted here hold for any experiment id (the seed):
 * each sits inside a block of equal resampled means that is far wider than
 * the sampling noise of 10,000 resamples around the 2.5th and 97.5th
 * percentiles (worked out in the comments of each test).
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApiErrorBodySchema,
  ComparisonViewSchema,
  ConfigurationDetailSchema,
  ExperimentDetailSchema,
  ExperimentEventSchema,
  ExperimentListRowSchema,
  NewExperimentOptionsSchema,
  RescoreRunResultSchema,
  RunActionResultSchema,
  VerdictEntrySchema,
  type ComparisonView,
  type ExperimentEvent,
  type RepetitionCell,
  type VerdictEntry,
} from '@hermes-evals/shared';
import * as schema from '../src/database/schema/index.js';
import {
  isStream,
  openSse,
  type SseStream,
} from '../src/experiments/sse/sse-client.support-spec.js';
import { Phase2World, waitFor, type ConfigRef } from './support/phase2-app.js';
import {
  ATTEMPT_COST_USD,
  JUDGE_MODEL,
  PHASE4_PRICES,
  PHASE4_SUITE,
  Phase4Judge,
  Phase4Trials,
  VERDICTS,
  type Phase4Task,
} from './support/phase4-trials.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const { configurationVersions, experiments, runs, tasks } = schema;

const PANEL_RULE = 'once every task has at least 2 scored repetitions per configuration.';
const ZERO_EXCLUDED = { executionErrors: 0, ungradable: 0, error: 0 };
/** Money as the comparison shows it: six decimals. */
const usd = (x: number): number => Math.round(x * 1e6) / 1e6;

type Arm = 'weak' | 'good';

describe.skipIf(!SERVER_URL)('Phase 4 on Postgres 17: the comparison and the verdicts', () => {
  const trials = new Phase4Trials();
  const judge = new Phase4Judge();
  const world = new Phase2World(SERVER_URL!, 'phase4_e2e', {
    suite: PHASE4_SUITE,
    prices: PHASE4_PRICES,
    script: trials.script,
    judge: judge.model,
  });
  const configs = {} as Record<Arm | 'twin', ConfigRef>;
  let main = '';
  let stream: SseStream | null = null;
  /** Run id by `task/arm/repetition` in the main experiment. */
  const runIds = new Map<string, string>();
  const runOf = (task: Phase4Task, arm: Arm, repetition: number) =>
    runIds.get(`${task}/${arm}/${repetition}`)!;

  beforeAll(async () => {
    await world.start();
    await world.startWorker();
  }, 120_000);

  afterAll(async () => {
    stream?.close();
    judge.release();
    trials.releaseAll();
    await world.stop();
  }, 120_000);

  const comparison = (id: string, query: Record<string, string> = {}): Promise<ComparisonView> => {
    const qs = new URLSearchParams(query).toString();
    return world.read(`/experiments/${id}/comparison${qs ? `?${qs}` : ''}`, ComparisonViewSchema);
  };

  const refusedGet = async (path: string, status: number) => {
    const res = await request(world.api.getHttpServer()).get(`/api${path}`);
    expect(res.status, `GET ${path}: ${JSON.stringify(res.body)}`).toBe(status);
    return ApiErrorBodySchema.parse(res.body);
  };

  const experimentRow = async (id: string) =>
    (await world.db.select().from(experiments).where(eq(experiments.id, id)))[0]!;

  /** The stored verdict history, every entry parsed. */
  const history = async (id: string): Promise<VerdictEntry[]> =>
    (await experimentRow(id)).verdictHistory.map((e) => VerdictEntrySchema.parse(e));

  const entries = (id: string, n: number) =>
    waitFor(`${n} verdict entries`, async () => {
      const found = await history(id);
      return found.length >= n ? found : undefined;
    });

  const cellOf = (view: ComparisonView, runId: string): RepetitionCell => {
    const cell = view.rows
      .flatMap((r) => [...r.baseline, ...r.candidate])
      .find((c) => c.runId === runId);
    if (!cell) throw new Error(`run ${runId} is not in the comparison`);
    return cell;
  };

  /** Each row as [task, baseline rate, candidate rate, Δ, change], in the view's order. */
  const grid = (view: ComparisonView) =>
    view.rows.map((r) => [r.taskKey, r.passBaseline, r.passCandidate, r.delta, r.change]);

  /** The main experiment's run of `task` under `arm` whose status is `status`. */
  const runIn = async (task: Phase4Task, arm: Arm, status: string) => {
    const [found] = (await world.runsOf(main)).filter(
      (r) => r.status === status && [1, 2, 3].some((rep) => runOf(task, arm, rep) === r.id),
    );
    if (!found) throw new Error(`no ${status} run of ${task}/${arm}`);
    return found;
  };

  /** The SSE events so far, once `done` holds for one of them. */
  const eventsUntil = async (done: (e: ExperimentEvent) => boolean): Promise<ExperimentEvent[]> => {
    const parse = (m: { data: string }) => ExperimentEventSchema.parse(JSON.parse(m.data));
    const messages = await stream!.until((m) => m.some((x) => done(parse(x))), 60_000);
    return messages.map(parse);
  };

  it('loads the suite: every task declares answer and cites, sum_amounts grades by its judge', async () => {
    const options = await world.read('/experiments/new-options', NewExperimentOptionsSchema);
    const suite = options.suites.find((s) => s.name === PHASE4_SUITE.name)!;
    expect(suite.tasks.map((t) => [t.key, t.valid])).toEqual(
      PHASE4_SUITE.tasks.map((key) => [key, true]),
    );
    const stored = await world.db.select().from(tasks).where(eq(tasks.suiteId, suite.suiteId));
    const keys = Object.fromEntries(
      stored.map((t) => [t.key, t.verification.map((v) => `${v.key}${v.primary ? '*' : ''}`)]),
    );
    expect(keys).toEqual({
      sum_amounts: ['answer', 'cites', 'quality*'],
      count_rows: ['answer*', 'cites'],
      max_amount: ['answer*', 'cites'],
      min_amount: ['answer*', 'cites'],
    });
    configs.weak = await world.configuration('weak', 'mock/weak');
    configs.good = await world.configuration('good', 'mock/good');
    configs.twin = await world.configuration('twin', 'mock/good');
  });

  it('answers while running: provisional, then afresh as two runs fail to start', async () => {
    // sum_amounts' judge runs on Nous (the default judge provider), which launch checks.
    world.nous.approve();
    trials.hold('answer');
    trials.hold('die');
    main = await world.launch('Weak against good', configs.weak, [configs.good], {
      repetitions: 3,
    });
    const first = await comparison(main);
    expect(first).toMatchObject({
      experimentId: main,
      experimentStatus: 'running',
      provisional: true,
      repetitions: 3,
      baseline: { name: 'weak', role: 'baseline', model: 'mock/weak' },
      candidate: { name: 'good', role: 'candidate', model: 'mock/good' },
      candidates: [{ configuration: { name: 'good' }, verdict: 'provisional' }],
      scoreKey: 'primary',
      filter: 'all',
      progress: { scored: 0, total: 24 },
      statistics: null,
      statisticsUnavailable: {
        reason: 'nothing_scored',
        message: `0 of 24 runs scored. Rows fill in as runs are scored; the statistics panel appears ${PANEL_RULE}`,
      },
      sensitivity: null,
    });
    expect(first.rows.map((r) => r.taskKey).sort()).toEqual([...PHASE4_SUITE.tasks].sort());
    for (const row of first.rows) {
      expect(row.baseline.map((c) => c.repetition)).toEqual([1, 2, 3]);
      for (const cell of [...row.baseline, ...row.candidate]) {
        expect(['queued', 'running']).toContain(cell.runStatus);
        expect(cell).toMatchObject({ scoreStatus: null, attempt: 1, durationS: null });
      }
    }
    const [listed] = (await world.read('/experiments', z.array(ExperimentListRowSchema))).filter(
      (r) => r.id === main,
    );
    expect(listed).toMatchObject({ status: 'running', verdicts: [] });

    // The answering trials go on; the two that die wait until both are claimed.
    trials.release('answer');
    await waitFor('both dying runs to start', async () =>
      trials.dying.length === 2 ? true : undefined,
    );
    const before = await comparison(main);
    for (const runId of trials.dying) expect(cellOf(before, runId).runStatus).toBe('running');
    trials.release('die');
    await waitFor('both runs to end in execution_error', async () => {
      const rows = (await world.runsOf(main)).filter((r) => trials.dying.includes(r.id));
      return rows.every((r) => r.status === 'execution_error') ? true : undefined;
    });
    const after = await comparison(main);
    for (const runId of trials.dying) {
      expect(cellOf(after, runId)).toMatchObject({
        runStatus: 'execution_error',
        scoreStatus: null,
        attempt: 1,
        comment: expect.stringMatching(/^execution_error · setup: /),
      });
    }
  });

  it('completes better on the primary keys, with the rates, cells, filters and secondary metrics', async () => {
    const done = await world.completed(main);
    expect(done.counts).toMatchObject({ scored: 22, execution_error: 2 });
    const rows = await world.db
      .select({
        id: runs.id,
        task: tasks.key,
        versionId: configurationVersions.id,
        rep: runs.repetition,
      })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .innerJoin(configurationVersions, eq(configurationVersions.id, runs.configurationVersionId))
      .where(eq(runs.experimentId, main))
      .orderBy(asc(runs.id));
    for (const r of rows) {
      const arm = r.versionId === configs.weak.versionId ? 'weak' : 'good';
      runIds.set(`${r.task}/${arm}/${r.rep}`, r.id);
    }
    expect(runIds.size).toBe(24);

    // Per task (candidate − baseline): 0 on sum_amounts, 1 on the other three; mean 0.75.
    // Resampling 4 tasks: a mean ≤ 0 needs all 4 draws on sum_amounts (p 0.004), ≤ 0.25 at
    // least 3 of them (p 0.051), so the 2.5th percentile is 0.25; a mean of 1 has p 0.32.
    const view = await comparison(main);
    expect(view).toMatchObject({
      experimentStatus: 'completed',
      provisional: false,
      candidates: [{ configuration: { name: 'good' }, verdict: 'better' }],
      progress: { scored: 22, total: 24 },
      passRates: { baseline: 0.25, candidate: 1 },
      passCounts: { baseline: { passed: 3, counted: 12 }, candidate: { passed: 12, counted: 12 } },
      statistics: {
        observedDelta: 0.75,
        lo: 0.25,
        hi: 1,
        resamples: 10_000,
        confidence: 0.95,
        verdict: 'better',
        provisional: false,
      },
      statisticsUnavailable: null,
      filterCounts: { all: 4, improved: 3, regressed: 0, unchanged: 1 },
    });
    expect(grid(view)).toEqual([
      ['count_rows', 0, 1, 1, 'improved'],
      ['max_amount', 0, 1, 1, 'improved'],
      ['min_amount', 0, 1, 1, 'improved'],
      ['sum_amounts', 1, 1, 0, 'unchanged'],
    ]);
    expect(view.scoreKeyOptions).toEqual([
      { value: 'primary', label: 'Primary key per task' },
      { value: 'answer', label: 'answer (all 4 tasks)' },
      { value: 'cites', label: 'cites (all 4 tasks)' },
      { value: 'any_failed', label: 'Any key failed' },
    ]);
    // Cells: the primary key's status and comment, the judge's on sum_amounts.
    for (const rep of [1, 2, 3]) {
      for (const arm of ['weak', 'good'] as const) {
        expect(cellOf(view, runOf('sum_amounts', arm, rep))).toMatchObject({
          repetition: rep,
          runStatus: 'scored',
          scoreStatus: 'passed',
          attempt: 1,
          durationS: expect.any(Number),
          comment: expect.stringContaining(VERDICTS.pass.comment),
        });
        expect(cellOf(view, runOf('max_amount', arm, rep)).scoreStatus).toBe(
          arm === 'good' ? 'passed' : 'failed',
        );
      }
    }
    // Both runs that died are execution errors, counted as not passed, and the
    // sensitivity figure leaves them out: the per-task rates, so the interval, stay.
    expect(view.sensitivity).toEqual({
      excludedBaseline: { ...ZERO_EXCLUDED, executionErrors: 2 },
      excludedCandidate: ZERO_EXCLUDED,
      baseline: { passed: 3, counted: 10, rate: 0.3 },
      candidate: { passed: 12, counted: 12, rate: 1 },
      delta: 0.75,
      lo: 0.25,
      hi: 1,
      verdict: 'better',
      verdictChanges: false,
    });
    // Every attempt is metered at 3,300 + 63 tokens and priced, the two that died
    // before init too: $0.0033 an attempt of weak, $0.0066 of good.
    expect(view.secondary).toEqual([
      {
        configuration: expect.objectContaining({ name: 'weak' }),
        medianDurationS: expect.any(Number),
        meanTokens: 3363,
        costUsd: usd(12 * ATTEMPT_COST_USD['mock/weak']),
        executionErrors: 2,
        executionErrorCategories: ['setup'],
        ungradable: 0,
      },
      {
        configuration: expect.objectContaining({ name: 'good' }),
        medianDurationS: expect.any(Number),
        meanTokens: 3363,
        costUsd: usd(12 * ATTEMPT_COST_USD['mock/good']),
        executionErrors: 0,
        executionErrorCategories: [],
        ungradable: 0,
      },
    ]);
    expect(view.secondaryDifference).toMatchObject({
      meanTokensPct: 0,
      costUsd: usd(12 * (ATTEMPT_COST_USD['mock/good'] - ATTEMPT_COST_USD['mock/weak'])),
      executionErrors: -2,
      ungradable: 0,
    });

    const only = async (filter: string) =>
      (await comparison(main, { filter })).rows.map((r) => r.taskKey);
    expect(await only('improved')).toEqual(['count_rows', 'max_amount', 'min_amount']);
    expect(await only('unchanged')).toEqual(['sum_amounts']);
    expect(await only('regressed')).toEqual([]);

    // One verdict entry for the one candidate, appended with the completion.
    const row = await experimentRow(main);
    expect(row.verdictRevision).toBe(row.resultsRevision);
    expect(await history(main)).toEqual([
      {
        at: row.finishedAt!.toISOString(),
        cause: 'initial',
        candidate_version_id: configs.good.versionId,
        key: 'primary',
        delta: 0.75,
        lo: 0.25,
        hi: 1,
        verdict: 'better',
        reason: null,
        note: null,
        results_revision: row.resultsRevision,
        pass_rates: { baseline: 0.25, candidate: 1 },
        pass_counts: {
          baseline: { passed: 3, counted: 12 },
          candidate: { passed: 12, counted: 12 },
        },
        task_counts: { improved: 3, regressed: 0, unchanged: 1 },
        resamples: 10_000,
        confidence: 0.95,
      },
    ]);
  });

  it('grades by a named key and by any key failed, and refuses what it cannot compare', async () => {
    // cites: weak cites on count_rows (2 of 3: one run died) and max_amount only.
    // Per task 1, 1/3, 0, 1 (mean 0.583); the 2.5th percentile falls among the
    // resamples of two max_amount and two count_rows draws (cumulative 0.020 to 0.043).
    const cites = await comparison(main, { key: 'cites' });
    expect(cites).toMatchObject({
      scoreKey: 'cites',
      passCounts: { baseline: { passed: 5, counted: 12 }, candidate: { passed: 12, counted: 12 } },
      passRates: { baseline: 0.417, candidate: 1 },
      statistics: { observedDelta: 0.583, lo: 0.167, hi: 1, verdict: 'better' },
      filterCounts: { all: 4, improved: 3, regressed: 0, unchanged: 1 },
    });
    expect(grid(cites)).toEqual([
      ['min_amount', 0, 1, 1, 'improved'],
      ['sum_amounts', 0, 1, 1, 'improved'],
      ['count_rows', 0.67, 1, 0.33, 'improved'],
      ['max_amount', 1, 1, 0, 'unchanged'],
    ]);
    expect(cellOf(cites, runOf('sum_amounts', 'weak', 1))).toMatchObject({ scoreStatus: 'failed' });

    // any_failed: weak misses a key on every task, good none.
    const anyFailed = await comparison(main, { key: 'any_failed' });
    expect(anyFailed).toMatchObject({
      scoreKey: 'any_failed',
      passCounts: { baseline: { passed: 0, counted: 12 }, candidate: { passed: 12, counted: 12 } },
      statistics: { observedDelta: 1, lo: 1, hi: 1, verdict: 'better' },
      filterCounts: { all: 4, improved: 4, regressed: 0, unchanged: 0 },
    });

    const missing = await refusedGet(`/experiments/${main}/comparison?key=quality`, 400);
    expect(missing.message).toBe(
      'Score key quality is not declared by every selected task (missing from count_rows, max_amount, min_amount).',
    );
    const stranger = await refusedGet(
      `/experiments/${main}/comparison?candidate=${configs.weak.versionId}`,
      400,
    );
    expect(stranger.message).toBe(
      `Configuration version ${configs.weak.versionId} is not a candidate of experiment ${main}.`,
    );
    const filter = await refusedGet(`/experiments/${main}/comparison?filter=better`, 400);
    expect(filter.issues).toBeDefined();
    const unknown = await refusedGet('/experiments/01K8ZZZZZZZZZZZZZZZZZZZZZZ/comparison', 404);
    expect(unknown.message).toBe('Experiment 01K8ZZZZZZZZZZZZZZZZZZZZZZ does not exist.');
  });

  it('re-scores a judged run: a fresh comparison, a rescore entry and the live events', async () => {
    const opened = await openSse(world.api.getHttpServer(), `/api/experiments/${main}/events`);
    if (!isStream(opened)) throw new Error(`no stream: ${opened.status} ${opened.body}`);
    stream = opened;
    const [initial] = await history(main);
    const connected = await eventsUntil((e) => e.type === 'experiment');
    expect(connected.find((e) => e.type === 'experiment')).toMatchObject({
      status: 'completed',
      verdicts: [{ candidate: 'good', verdict: 'better', delta: 0.75, lo: 0.25, hi: 1 }],
      verdictUpdatedAt: initial!.at,
    });

    const target = runOf('sum_amounts', 'good', 1);
    judge.hold();
    judge.failNext();
    const rescored = await world.send(
      'post',
      `/runs/${target}/rescore`,
      {},
      200,
      RescoreRunResultSchema,
    );
    expect(rescored.evaluation).toMatchObject({ generation: 2, cause: 'rescore' });
    await eventsUntil((e) => e.type === 'run' && e.runId === target && e.rescorePending);
    // Pending, the comparison still grades the run by generation 1.
    expect(cellOf(await comparison(main), target).scoreStatus).toBe('passed');
    judge.release();
    const [, second] = await entries(main, 2);

    // good's sum_amounts falls to 2 of 3: per task −1/3, 1, 1, 1 (mean 0.667). Three or
    // four sum_amounts draws give a mean ≤ 0 (p 0.051, four alone 0.004): the 2.5th
    // percentile is 0, so the interval no longer clears 0.
    const after = await comparison(main);
    expect(after).toMatchObject({
      candidates: [{ configuration: { name: 'good' }, verdict: 'inconclusive' }],
      passCounts: { baseline: { passed: 3, counted: 12 }, candidate: { passed: 11, counted: 12 } },
      passRates: { baseline: 0.25, candidate: 0.917 },
      statistics: { observedDelta: 0.667, lo: 0, hi: 1, verdict: 'inconclusive' },
      filterCounts: { all: 4, improved: 3, regressed: 1, unchanged: 0 },
    });
    expect(grid(after).at(-1)).toEqual(['sum_amounts', 1, 0.67, -0.33, 'regressed']);
    expect(cellOf(after, target)).toMatchObject({
      scoreStatus: 'failed',
      comment: expect.stringContaining(VERDICTS.fail.comment),
    });
    expect(second).toMatchObject({
      cause: 'rescore',
      note: '1 run re-scored',
      verdict: 'inconclusive',
      lo: 0,
      hi: 1,
      task_counts: { improved: 3, regressed: 1, unchanged: 0 },
      results_revision: (await experimentRow(main)).resultsRevision,
    });
    expect(second!.delta).toBeCloseTo(2 / 3, 9);
    expect(second!.results_revision).toBeGreaterThan(initial!.results_revision!);
    // Another key's cached answer moves with the revision too.
    expect((await comparison(main, { key: 'any_failed' })).passCounts.candidate).toEqual({
      passed: 11,
      counted: 12,
    });

    const events = await eventsUntil(
      (e) => e.type === 'experiment' && e.verdictUpdatedAt === second!.at,
    );
    expect(events.findLast((e) => e.type === 'experiment')).toMatchObject({
      status: 'completed',
      verdicts: [{ candidate: 'good', verdict: 'inconclusive', delta: 0.667, lo: 0, hi: 1 }],
    });
    const runEvents = events.filter((e) => e.type === 'run' && e.runId === target);
    expect(runEvents.map((e) => e.type === 'run' && [e.generation, e.rescorePending])).toEqual(
      expect.arrayContaining([
        [1, true],
        [2, false],
      ]),
    );
    const detail = await world.detail(main);
    expect(detail.verdicts).toMatchObject([
      {
        candidate: { name: 'good' },
        verdict: 'inconclusive',
        history: [
          { cause: 'initial', verdict: 'better', note: null, delta: 0.75 },
          { cause: 'rescore', verdict: 'inconclusive', note: '1 run re-scored', delta: 0.667 },
        ],
      },
    ]);
  });

  it('retries an execution error: the experiment reopens, settles and appends a retry entry', async () => {
    const errored = await runIn('count_rows', 'weak', 'execution_error');
    // Cached at this revision under cites: still better (the died run counts as not passed).
    const citesBefore = await comparison(main, { key: 'cites' });
    expect(citesBefore.statistics).toMatchObject({ observedDelta: 0.583, verdict: 'better' });
    // The retry waits at the gate until the stream has shown the experiment running again.
    trials.hold('answer');
    const retried = await world.send(
      'post',
      `/runs/${errored.id}/retry`,
      {},
      200,
      RunActionResultSchema,
    );
    expect(retried).toEqual({ runId: errored.id, status: 'queued', attempt: 2 });
    const reopened = await eventsUntil((e) => e.type === 'experiment' && e.status === 'running');
    // Held at the gate, the experiment cannot complete: its newest event is the reopening.
    expect(reopened.findLast((e) => e.type === 'experiment')).toMatchObject({
      status: 'running',
      verdicts: [],
    });
    trials.release('answer');
    const [, , third] = await entries(main, 3);
    await world.completed(main);

    const after = await comparison(main);
    expect(cellOf(after, errored.id)).toMatchObject({
      runStatus: 'scored',
      scoreStatus: 'failed',
      attempt: 2,
    });
    expect(after).toMatchObject({
      progress: { scored: 23, total: 24 },
      passCounts: { baseline: { passed: 3, counted: 12 }, candidate: { passed: 11, counted: 12 } },
      statistics: { observedDelta: 0.667, lo: 0, hi: 1, verdict: 'inconclusive' },
      sensitivity: { excludedBaseline: { ...ZERO_EXCLUDED, executionErrors: 1 } },
    });
    // Under cites weak now cites on all of count_rows: per task 1, 0, 0, 1 (mean 0.5);
    // all four draws on the two unchanged tasks has p 0.0625, so the interval holds 0.
    const cites = await comparison(main, { key: 'cites' });
    expect(cites).toMatchObject({
      passCounts: { baseline: { passed: 6, counted: 12 } },
      statistics: { observedDelta: 0.5, lo: 0, hi: 1, verdict: 'inconclusive' },
    });
    expect(third).toMatchObject({ cause: 'retry', note: '1 retry', verdict: 'inconclusive' });

    const events = await eventsUntil(
      (e) => e.type === 'experiment' && e.verdictUpdatedAt === third!.at,
    );
    expect(events.findLast((e) => e.type === 'experiment')).toMatchObject({
      status: 'completed',
      verdicts: [{ candidate: 'good', verdict: 'inconclusive', delta: 0.667 }],
    });
  });

  it('cancels a retried run before it answers: it stops counting, and the entry follows', async () => {
    const errored = await runIn('min_amount', 'weak', 'execution_error');
    trials.hold('answer');
    await world.send('post', `/runs/${errored.id}/retry`, {}, 200, RunActionResultSchema);
    await waitFor('the retry to start', async () =>
      world.engine.live().some((c) => c.info.labels['hermes-evals.run'] === errored.id)
        ? true
        : undefined,
    );
    const live = await comparison(main);
    expect(live).toMatchObject({
      experimentStatus: 'running',
      provisional: true,
      candidates: [{ verdict: 'provisional' }],
      statistics: { verdict: 'provisional', provisional: true },
    });
    expect(cellOf(live, errored.id)).toMatchObject({ runStatus: 'running', attempt: 2 });

    const cancel = await world.send(
      'post',
      `/runs/${errored.id}/cancel`,
      {},
      200,
      RunActionResultSchema,
    );
    expect(cancel).toMatchObject({ runId: errored.id, status: 'running' });
    const [, , , fourth] = await entries(main, 4);
    trials.release('answer');
    await world.completed(main);

    // min_amount's weak side counts 2 runs now, enough for the gate; its rate stays 0.
    const after = await comparison(main);
    expect(cellOf(after, errored.id)).toMatchObject({ runStatus: 'cancelled', scoreStatus: null });
    expect(after).toMatchObject({
      experimentStatus: 'completed',
      passCounts: { baseline: { passed: 3, counted: 11 }, candidate: { passed: 11, counted: 12 } },
      passRates: { baseline: 0.273, candidate: 0.917 },
      statistics: { observedDelta: 0.667, lo: 0, hi: 1, verdict: 'inconclusive' },
      sensitivity: null,
    });
    // The cancelled run's two attempts are not counted, but they were paid for: the
    // cost prices every attempt of the arm, as the Overview does (Phase 4 question 2),
    // count_rows' retried run's two included.
    expect(after.secondary[0]).toMatchObject({
      executionErrors: 0,
      executionErrorCategories: [],
      costUsd: usd(14 * ATTEMPT_COST_USD['mock/weak']),
    });
    const overview = await world.read(`/experiments/${main}`, ExperimentDetailSchema);
    expect(after.secondary.map((r) => r.costUsd)).toEqual(
      overview.aggregates.map((a) => a.costUsd),
    );
    expect(fourth).toMatchObject({ cause: 'retry', note: '1 retry', verdict: 'inconclusive' });

    // Every entry parses, once per results revision, oldest first.
    const all = await history(main);
    expect(all.map((e) => e.cause)).toEqual(['initial', 'rescore', 'retry', 'retry']);
    const revisions = all.map((e) => e.results_revision!);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(new Set(revisions).size).toBe(4);
    const row = await experimentRow(main);
    expect(row.verdictRevision).toBe(row.resultsRevision);
    expect(revisions.at(-1)).toBe(row.resultsRevision);

    const detail = await world.detail(main);
    expect(detail.verdicts).toMatchObject([
      {
        verdict: 'inconclusive',
        scoreKey: 'primary',
        delta: 0.667,
        lo: 0,
        hi: 1,
        passRates: { baseline: 0.273, candidate: 0.917 },
        passCounts: {
          baseline: { passed: 3, counted: 11 },
          candidate: { passed: 11, counted: 12 },
        },
        taskCounts: { improved: 3, regressed: 1, unchanged: 0 },
        method: { name: 'paired_bootstrap', resamples: 10_000, confidence: 0.95 },
        reason: null,
      },
    ]);
    expect(detail.verdicts[0]!.history.map((h) => [h.cause, h.verdict, h.note])).toEqual([
      ['initial', 'better', null],
      ['rescore', 'inconclusive', '1 run re-scored'],
      ['retry', 'inconclusive', '1 retry'],
      ['retry', 'inconclusive', '1 retry'],
    ]);
    stream?.close();
    stream = null;
  });

  it('stays inconclusive when both configurations pass equally', async () => {
    const id = await world.launch('Good against twin', configs.good, [configs.twin], {
      repetitions: 2,
    });
    await world.completed(id);
    const view = await comparison(id);
    expect(view).toMatchObject({
      passRates: { baseline: 1, candidate: 1 },
      statistics: { observedDelta: 0, lo: 0, hi: 0, verdict: 'inconclusive' },
      filterCounts: { all: 4, improved: 0, regressed: 0, unchanged: 4 },
      sensitivity: null,
    });
    expect(await history(id)).toMatchObject([
      {
        cause: 'initial',
        candidate_version_id: configs.twin.versionId,
        verdict: 'inconclusive',
        delta: 0,
      },
    ]);
  });

  it('gives no interval with one repetition, and the entry says why', async () => {
    const id = await world.launch('One repetition', configs.weak, [configs.good]);
    await world.completed(id);
    const view = await comparison(id);
    expect(view).toMatchObject({
      repetitions: 1,
      candidates: [{ verdict: 'not_computable' }],
      passRates: { baseline: 0.25, candidate: 1 },
      statistics: null,
      statisticsUnavailable: {
        reason: 'single_repetition',
        message:
          'No interval with 1 repetition. Pass rates: weak 0.25, good 1.00 on 4 tasks. Run at least 2 repetitions for a verdict.',
      },
      filterCounts: { all: 4, improved: 0, regressed: 0, unchanged: 0 },
      sensitivity: null,
    });
    // No Δ column: rows keep the experiment's task order.
    expect(grid(view)).toEqual([
      ['sum_amounts', 1, 1, null, null],
      ['count_rows', 0, 1, null, null],
      ['max_amount', 0, 1, null, null],
      ['min_amount', 0, 1, null, null],
    ]);
    expect(await history(id)).toMatchObject([
      {
        cause: 'initial',
        verdict: 'not_computable',
        reason: 'single_repetition',
        delta: null,
        lo: null,
        hi: null,
      },
    ]);
  });

  it('shows each verdict in the list and on the configuration page', async () => {
    const list = await world.read('/experiments', z.array(ExperimentListRowSchema));
    const chips = Object.fromEntries(list.map((r) => [r.name, r.verdicts]));
    expect(chips).toEqual({
      'Weak against good': [
        {
          candidate: 'good',
          candidateVersionId: configs.good.versionId,
          verdict: 'inconclusive',
          delta: 0.667,
          lo: 0,
          hi: 1,
          reason: null,
        },
      ],
      'Good against twin': [
        {
          candidate: 'twin',
          candidateVersionId: configs.twin.versionId,
          verdict: 'inconclusive',
          delta: 0,
          lo: 0,
          hi: 0,
          reason: null,
        },
      ],
      'One repetition': [
        {
          candidate: 'good',
          candidateVersionId: configs.good.versionId,
          verdict: 'not_computable',
          delta: null,
          lo: null,
          hi: null,
          reason: 'single_repetition',
        },
      ],
    });
    const good = await world.read(
      `/configurations/${configs.good.configurationId}`,
      ConfigurationDetailSchema,
    );
    const usage = Object.fromEntries(
      good.usedIn.map((u) => [u.experimentName, [u.role, u.verdict, u.verdictReason]]),
    );
    expect(usage).toEqual({
      'Weak against good': ['candidate', 'inconclusive', null],
      'Good against twin': ['baseline', null, null],
      'One repetition': ['candidate', 'not_computable', 'single_repetition'],
    });
    // The judge graded sum_amounts once per run and once for the re-score, all through egress.
    expect(judge.calls).toBe(6 + 1 + 4 + 2);
    expect(world.egress.judges.size).toBe(0);
    expect(world.egress.judgeHistory.every((r) => r.registration.model === JUDGE_MODEL)).toBe(true);
  });
});
