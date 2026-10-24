import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import {
  cancelExperiment,
  duplicateExperiment,
  estimateExperiment,
  EXPERIMENT_IDS,
  getComparison,
  getExperiment,
  getNewExperimentOptions,
  launchExperiment,
  listExperiments,
  pauseExperiment,
  resumeExperiment,
  retryFailedRuns,
} from '@/api/experiments';
import { setScenario, settledWithin } from './scenario';

beforeEach(() => setScenario(null));

describe('listExperiments', () => {
  it('returns the six experiments of the list board, newest first', async () => {
    const rows = await listExperiments();
    expect(rows.map((r) => [r.name, r.status, `${r.doneRuns} / ${r.totalRuns}`])).toEqual([
      ['Skill + MCP, invoices-v1', 'running', '40 / 180'],
      ['MCP vs baseline, invoices-v1', 'running', '87 / 120'],
      ['MCP vs baseline, first try', 'failed', '14 / 120'],
      ['MCP smoke test, invoices-v1', 'completed', '72 / 72'],
      ['Skill vs no skill, invoices-v1', 'completed', '120 / 120'],
      ['Skill vs no skill, quick check', 'paused', '9 / 24'],
    ]);
    expect(rows.map((r) => r.costUsd)).toEqual([0.59, 1.21, 0.02, 1.01, 1.69, 0.12]);
    expect(rows[2]!.statusReason).toBe('invoice-db failed to start (setup) in 14 of 14 runs');
    expect(rows[0]!.candidates.map((c) => c.name)).toEqual(['with-skill', 'with-mcp']);
  });

  it('carries final verdicts only once completed', async () => {
    const rows = await listExperiments();
    const verdicts = rows.map((r) => r.verdicts.map((v) => `${v.candidate} ${v.verdict}`));
    expect(verdicts).toEqual([[], [], [], ['with-mcp inconclusive'], ['with-skill better'], []]);
    const svn = rows.find((r) => r.id === EXPERIMENT_IDS.skillVsNoSkill)!;
    expect(svn.verdicts[0]).toMatchObject({ delta: 0.217, lo: 0.117, hi: 0.333 });
  });

  it('is empty in the empty and first-launch scenarios', async () => {
    setScenario('empty');
    expect(await listExperiments()).toEqual([]);
    setScenario('first-launch');
    expect(await listExperiments()).toEqual([]);
  });

  it('stays pending under loading and fails under error', async () => {
    setScenario('loading');
    expect(await settledWithin(listExperiments())).toBe('pending');
    setScenario('error');
    await expect(listExperiments()).rejects.toThrow(
      'GET /api/experiments → 502 · upstream api:8080 connection refused',
    );
  });
});

describe('getExperiment', () => {
  it('gives the completed sample experiment with the brief numbers', async () => {
    const e = await getExperiment(EXPERIMENT_IDS.skillVsNoSkill);
    expect(e.name).toBe('Skill vs no skill, invoices-v1');
    expect(e.totalRuns).toBe(120);
    expect(e.counts).toMatchObject({ scored: 119, execution_error: 1 });
    expect(e.elapsedS).toBe(37 * 60 + 4);
    expect(e.hermes).toEqual({ package: 'hermes-agent', version: 'v0.22.4', revision: '4d04303' });
    expect(e.suite).toMatchObject({ name: 'invoices-v1', versionNumber: 1, taskCount: 12 });
    expect(e.suite.contentHash.startsWith('3f9c2a1')).toBe(true);
    expect(e.differences).toEqual([
      expect.objectContaining({
        field: 'skills',
        baselineValue: '—',
        candidateValue: 'invoice-method@1.0.0',
      }),
    ]);
    const v = e.verdicts[0]!;
    expect(v.verdict).toBe('better');
    expect(v.passRates).toEqual({ baseline: 0.633, candidate: 0.85 });
    expect(v.passCounts.baseline).toEqual({ passed: 38, counted: 60 });
    expect(v.passCounts.candidate).toEqual({ passed: 51, counted: 60 });
    expect(v.taskCounts).toEqual({ improved: 8, regressed: 0, unchanged: 4 });
    expect(v.history).toHaveLength(1);
    const [b, c] = e.aggregates;
    expect(b).toMatchObject({
      passRate: 0.633,
      meanScore: 0.671,
      medianDurationS: 48,
      meanTokens: 14200,
      costUsd: 0.71,
      executionErrors: 1,
      executionErrorCategories: ['timeout'],
      ungradable: 2,
    });
    expect(c).toMatchObject({
      passRate: 0.85,
      meanScore: 0.874,
      medianDurationS: 61,
      meanTokens: 19800,
      costUsd: 0.98,
      executionErrors: 0,
      ungradable: 0,
    });
  });

  it('gives the running experiment of the Overview board', async () => {
    const e = await getExperiment(EXPERIMENT_IDS.mcpVsBaseline);
    expect(e.status).toBe('running');
    expect(e.counts).toEqual({
      queued: 28,
      running: 3,
      executed: 0,
      scoring: 1,
      scored: 87,
      execution_error: 1,
      cancelled: 0,
    });
    expect(e.spend).toMatchObject({ spentUsd: 1.21, ceilingUsd: 2, projectedTotalUsd: 1.66 });
    const [b, m] = e.perConfiguration;
    expect([b!.counts.scored, b!.provisionalPassRate]).toEqual([46, 0.63]);
    expect([m!.counts.scored, m!.counts.execution_error, m!.provisionalPassRate]).toEqual([
      41, 1, 0.683,
    ]);
    expect(e.feed).toHaveLength(10);
    expect(e.feed[0]).toMatchObject({
      taskKey: 'per_vendor',
      configuration: 'with-mcp',
      repetition: 4,
      result: 'passed',
      durationS: 44,
      finishedAt: '2026-10-23T15:23:41',
    });
    expect(e.feed[4]).toMatchObject({ taskKey: 'currency_mix', result: 'execution_error' });
    expect(e.verdicts[0]!.verdict).toBe('provisional');
  });

  it('gives the failed experiment with its circuit-breaker detail', async () => {
    const e = await getExperiment(EXPERIMENT_IDS.mcpFirstTry);
    expect(e.status).toBe('failed');
    expect(e.counts).toMatchObject({ execution_error: 14, queued: 106, scored: 0 });
    expect(e.failure).toMatchObject({
      threshold: 14,
      category: 'setup',
      message: 'invoice-db failed to start',
      stderrFirstLine: 'Error: INVOICE_DB_URL is not set',
    });
  });

  it('rejects an unknown id with a 404', async () => {
    const err = await getExperiment('exp_nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it('shows the paused, no-worker and nothing-scored states', async () => {
    setScenario('paused-ceiling');
    let e = await getExperiment(EXPERIMENT_IDS.mcpVsBaseline);
    expect([e.status, e.pauseReason, e.pausedAt]).toEqual([
      'paused',
      'spend_ceiling',
      '2026-10-23T15:08:00',
    ]);
    expect(e.counts).toMatchObject({ scored: 87, queued: 32, running: 0, scoring: 0 });
    expect(e.spend).toMatchObject({ spentUsd: 2, ceilingUsd: 2, remainingEstimateUsd: 0.45 });

    setScenario('paused-provider');
    e = await getExperiment(EXPERIMENT_IDS.mcpVsBaseline);
    expect([e.status, e.pauseReason]).toEqual(['paused', 'provider_disconnected']);
    expect(e.counts).toMatchObject({ scored: 87, queued: 33, running: 0 });

    setScenario('no-worker');
    e = await getExperiment(EXPERIMENT_IDS.mcpVsBaseline);
    expect(e.worker).toEqual({
      connected: false,
      lastHeartbeatAt: '2026-10-23T15:31:04',
      workerLostRuns: 4,
    });
    expect(e.counts).toMatchObject({ scored: 87, execution_error: 5, queued: 28 });

    setScenario('nothing-scored');
    e = await getExperiment(EXPERIMENT_IDS.mcpVsBaseline);
    expect(e.counts).toMatchObject({ scored: 0, running: 3, queued: 117 });
  });

  it('shows a newer suite version on older experiments', async () => {
    expect((await getExperiment(EXPERIMENT_IDS.skillVsNoSkill)).suite.newerVersion).toBeNull();
    setScenario('newer-version');
    const e = await getExperiment(EXPERIMENT_IDS.skillVsNoSkill);
    expect(e.suite.newerVersion).toMatchObject({ versionNumber: 2, changedTasks: ['total_due'] });
  });

  it('recomputes the smoke-test verdict after the Flow B retry', async () => {
    let e = await getExperiment(EXPERIMENT_IDS.mcpSmoke);
    expect(e.verdicts[0]).toMatchObject({
      verdict: 'inconclusive',
      delta: 0.056,
      passRates: { baseline: 0.639, candidate: 0.694 },
      taskCounts: { improved: 2, regressed: 2, unchanged: 8 },
    });
    setScenario('verdict-updated');
    e = await getExperiment(EXPERIMENT_IDS.mcpSmoke);
    expect(e.verdicts[0]).toMatchObject({
      verdict: 'inconclusive',
      delta: 0.083,
      lo: -0.042,
      hi: 0.208,
      taskCounts: { improved: 2, regressed: 1, unchanged: 9 },
    });
    expect(e.verdicts[0]!.history.map((h) => h.delta)).toEqual([0.056, 0.083]);
  });
});

describe('getComparison', () => {
  it('sorts the grid by Δ descending and gives the statistics panel', async () => {
    const c = await getComparison(EXPERIMENT_IDS.skillVsNoSkill);
    expect(c.rows.map((r) => r.taskKey).slice(0, 4)).toEqual([
      'dup_invoices',
      'credit_notes',
      'late_fees',
      'overdue_list',
    ]);
    const dup = c.rows[0]!;
    expect([dup.passBaseline, dup.passCandidate, dup.delta, dup.change]).toEqual([
      0.2,
      0.8,
      0.6,
      'improved',
    ]);
    expect(dup.baseline.map((cell) => cell.scoreStatus)).toEqual([
      'failed',
      'passed',
      'failed',
      'failed',
      'failed',
    ]);
    expect(dup.baseline[2]).toMatchObject({
      runId: 'run_01JB7X4K2M',
      durationS: 52,
      comment: 'expected 2 duplicate pairs, got 0; agent compared invoice numbers only',
    });
    expect(c.filterCounts).toEqual({ all: 12, improved: 8, regressed: 0, unchanged: 4 });
    expect(c.statistics).toEqual({
      observedDelta: 0.217,
      lo: 0.117,
      hi: 0.333,
      resamples: 10000,
      confidence: 0.95,
      verdict: 'better',
      provisional: false,
    });
    expect(c.secondaryDifference).toEqual({
      medianDurationS: 13,
      meanTokensPct: 39,
      costUsd: 0.27,
      executionErrors: -1,
      ungradable: -2,
    });
    expect(c.sensitivity).toMatchObject({
      baseline: { passed: 38, counted: 57, rate: 0.667 },
      delta: 0.183,
      verdictChanges: false,
    });
    expect(c.scoreKeyOptions.map((o) => o.label)).toEqual([
      'Primary key per task',
      'answer (all 12 tasks)',
      'Any key failed',
    ]);
  });

  it('filters rows and keeps the counts', async () => {
    const c = await getComparison(EXPERIMENT_IDS.mcpSmoke, { filter: 'regressed' });
    expect(c.rows.map((r) => [r.taskKey, r.passBaseline, r.passCandidate])).toEqual([
      ['credit_notes', 0.33, 0],
      ['currency_mix', 1, 0.67],
    ]);
    expect(c.filterCounts).toEqual({ all: 12, improved: 2, regressed: 2, unchanged: 8 });
    const errorCell = c.rows[1]!.candidate[1]!;
    expect([errorCell.runStatus, errorCell.comment]).toEqual([
      'execution_error',
      'execution_error · timeout: no final response within 300 s',
    ]);
  });

  it('is provisional while running and offers each candidate', async () => {
    const running = await getComparison(EXPERIMENT_IDS.mcpVsBaseline);
    expect(running.provisional).toBe(true);
    expect(running.statistics?.verdict).toBe('provisional');
    const multi = await getComparison(EXPERIMENT_IDS.skillMcp);
    expect(multi.candidates.map((o) => [o.configuration.name, o.verdict])).toEqual([
      ['with-skill', 'better'],
      ['with-mcp', 'provisional'],
    ]);
    const second = await getComparison(EXPERIMENT_IDS.skillMcp, {
      candidate: multi.candidates[1]!.configuration.versionId,
    });
    expect(second.candidate.name).toBe('with-mcp');
  });

  it('explains why there are no statistics', async () => {
    setScenario('nothing-scored');
    const none = await getComparison(EXPERIMENT_IDS.mcpVsBaseline);
    expect(none.statistics).toBeNull();
    expect(none.statisticsUnavailable?.reason).toBe('nothing_scored');
    expect(none.progress).toEqual({ scored: 0, total: 120 });

    setScenario('single-rep');
    const one = await getComparison(EXPERIMENT_IDS.quickCheck);
    expect(one.statisticsUnavailable?.reason).toBe('single_repetition');
    expect(one.passRates).toEqual({ baseline: 0.583, candidate: 0.75 });
    expect(one.rows.every((r) => r.delta === null && r.baseline.length === 1)).toBe(true);
  });
});

describe('New experiment', () => {
  it('offers the suite, its tasks and the three configurations', async () => {
    const o = await getNewExperimentOptions();
    expect(o.suites).toHaveLength(1);
    expect(o.suites[0]!.tasks).toHaveLength(12);
    expect(o.suites[0]!.tasks.every((t) => t.valid)).toBe(true);
    expect(o.configurations.map((c) => c.name)).toEqual(['baseline', 'with-skill', 'with-mcp']);
    expect(o.defaults).toEqual({ repetitions: 5, concurrency: 3 });
    expect(o.maxConcurrency).toBe(4);
    expect(o.priceTable[0]).toMatchObject({
      model: 'openai/gpt-6.1-sol',
      inputPer1M: 0.6,
      outputPer1M: 2.4,
    });
  });

  it('disables the invalid task in the invalid-task scenario', async () => {
    setScenario('invalid-task');
    const o = await getNewExperimentOptions();
    const late = o.suites[0]!.tasks.find((t) => t.key === 'late_fees')!;
    expect(late.valid).toBe(false);
    expect(late.invalidReason).toContain('check_late_fees.py printed no result line');
  });

  it('estimates 120 runs, ≈ 36 min and $1.69 for the sample experiment', async () => {
    const o = await getNewExperimentOptions();
    const estimate = await estimateExperiment({
      suiteId: o.suites[0]!.suiteId,
      versionIds: o.configurations.slice(0, 2).map((c) => c.versionId),
      taskCount: 12,
      repetitions: 5,
      concurrency: 3,
    });
    expect(estimate).toMatchObject({
      runs: 120,
      waves: 40,
      perRunSeconds: 55,
      durationS: 2180,
      costUsd: 1.69,
      basis: 'history',
    });
    expect(estimate.perConfiguration.map((p) => p.costUsd)).toEqual([0.71, 0.98]);
  });

  it('launches into the running experiment, or refuses with a 409', async () => {
    const o = await getNewExperimentOptions();
    const input = {
      name: 'Skill vs no skill, invoices-v1',
      description: '',
      suiteId: o.suites[0]!.suiteId,
      taskKeys: o.suites[0]!.tasks.map((t) => t.key),
      baselineVersionId: o.configurations[0]!.versionId,
      candidateVersionIds: [o.configurations[1]!.versionId],
      repetitions: 5,
      concurrency: 3,
      spendCeilingUsd: null,
      timeBudgetOverrideS: null,
      expectedConfigHashes: {},
    };
    await expect(launchExperiment(input)).resolves.toEqual({ id: EXPERIMENT_IDS.mcpVsBaseline });
    setScenario('launch-refused');
    await expect(launchExperiment(input)).rejects.toThrow(
      'POST /api/experiments → 409 · Nous Portal is not connected',
    );
    setScenario('launch-conflict');
    await expect(launchExperiment(input)).rejects.toThrow(
      'configuration with-skill changed since you opened this form (now v2)',
    );
  });

  it('duplicates on the current suite version, leaving out invalid tasks', async () => {
    setScenario('invalid-task');
    const draft = await duplicateExperiment(EXPERIMENT_IDS.skillVsNoSkill);
    expect(draft.values.taskKeys).toHaveLength(11);
    expect(draft.changes).toMatchObject({ suiteVersionFrom: 1, suiteVersionTo: 2 });
    expect(draft.changes.invalidTasks.map((t) => t.key)).toEqual(['late_fees']);
  });
});

describe('experiment controls', () => {
  it('pause, resume, cancel and retry failed runs', async () => {
    await expect(pauseExperiment(EXPERIMENT_IDS.mcpVsBaseline)).resolves.toMatchObject({
      status: 'paused',
    });
    await expect(resumeExperiment(EXPERIMENT_IDS.quickCheck)).resolves.toMatchObject({
      status: 'running',
    });
    await expect(cancelExperiment(EXPERIMENT_IDS.mcpVsBaseline)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(retryFailedRuns(EXPERIMENT_IDS.mcpFirstTry)).resolves.toMatchObject({
      status: 'running',
    });
  });

  it('needs a higher ceiling to resume a spend-ceiling pause', async () => {
    setScenario('paused-ceiling');
    await expect(resumeExperiment(EXPERIMENT_IDS.mcpVsBaseline)).rejects.toThrow(
      'raise the spend ceiling above $2.00 to resume',
    );
    await expect(
      resumeExperiment(EXPERIMENT_IDS.mcpVsBaseline, { spendCeilingUsd: 3 }),
    ).resolves.toMatchObject({ status: 'running' });
  });

  it('needs Nous Portal to resume a provider pause', async () => {
    setScenario('paused-provider,nous-not-connected');
    await expect(resumeExperiment(EXPERIMENT_IDS.mcpVsBaseline)).rejects.toThrow(
      'Nous Portal is not connected',
    );
  });
});
