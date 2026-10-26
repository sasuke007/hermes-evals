import { beforeEach, describe, expect, it } from 'vitest';
import { EXPERIMENT_IDS } from '@/fixtures/experiments';
import {
  cancelRun,
  getArtifactPreview,
  getRun,
  listRunEvents,
  listRuns,
  rescoreRun,
  rescoreRuns,
  retryRun,
  retryRuns,
} from '@/api/runs';
import { SAMPLE_RUN_ID } from '@/fixtures/experiments';
import { runIdOf } from '@/fixtures/inspector';
import { setScenario, settledWithin } from './scenario';

const SVN = EXPERIMENT_IDS.skillVsNoSkill;
const MVB = EXPERIMENT_IDS.mcpVsBaseline;
const id = (exp: string, task: string, config: string, rep: number) =>
  runIdOf(() => false, exp, task, config, rep)!;

/** The last item of a list (the vitest tsconfig has no ES2022 Array#at). */
function last<T>(list: readonly T[]): T | undefined {
  return list[list.length - 1];
}

beforeEach(() => setScenario(null));

describe('listRuns', () => {
  it('lists all 120 runs with the count line of the Runs board', async () => {
    const result = await listRuns(SVN);
    expect(result.rows).toHaveLength(120);
    expect(result.summary).toEqual({
      total: 120,
      passed: 89,
      failed: 28,
      error: 0,
      ungradable: 2,
      executionErrors: 1,
    });
    expect(new Set(result.rows.map((r) => r.id)).size).toBe(120);
    expect(result.rows[0]).toMatchObject({ taskKey: 'total_due', repetition: 1 });
  });

  it('filters by execution error, ungradable, configuration and score status', async () => {
    const exec = await listRuns(SVN, { hasExecutionError: true });
    expect(
      exec.rows.map((r) => [r.taskKey, r.configuration.name, r.repetition, r.attempts]),
    ).toEqual([['disputed', 'baseline', 4, 2]]);
    expect(exec.rows[0]!.executionErrorCategory).toBe('timeout');
    const ung = await listRuns(SVN, { ungradable: true });
    expect(ung.rows.map((r) => `${r.taskKey} ${r.repetition}`)).toEqual([
      'credit_notes 2',
      'late_fees 5',
    ]);
    expect((await listRuns(SVN, { configuration: 'with-skill' })).matched).toBe(60);
    expect((await listRuns(SVN, { scoreStatus: 'passed' })).matched).toBe(89);
    expect(exec.summary.total).toBe(120);
  });

  it('sorts by any column', async () => {
    const byDuration = await listRuns(SVN, { sort: 'duration', dir: 'desc' });
    expect(byDuration.rows[0]!.durationS).toBe(300);
    const byTokensAsc = await listRuns(SVN, { sort: 'tokens', dir: 'asc' });
    const tokens = byTokensAsc.rows.map((r) => r.tokens?.total ?? 0);
    expect([...tokens].sort((a, b) => a - b)).toEqual(tokens);
  });

  it('marks the judge keys a re-score needs', async () => {
    const credit = (await listRuns(SVN, { task: 'credit_notes' })).rows[0]!;
    expect(credit.needs).toEqual({
      provider: 'nous',
      judgeKeys: ['method'],
      judgeProvider: 'nous',
      judgeKeysWithoutModel: [],
      noJudgeModelReason: null,
    });
  });

  it('honours loading and error', async () => {
    setScenario('loading');
    expect(await settledWithin(listRuns(SVN))).toBe('pending');
    setScenario('error');
    await expect(listRuns(SVN)).rejects.toThrow(`GET /api/experiments/${SVN}/runs → 502`);
  });
});

describe('getRun: the inspector board run', () => {
  it('has the header, outcome and final response of the board', async () => {
    const run = await getRun(SAMPLE_RUN_ID);
    expect(run).toMatchObject({
      task: { key: 'dup_invoices', version: 1 },
      configuration: { name: 'baseline', role: 'baseline' },
      repetition: 3,
      status: 'scored',
      shownAttempt: 1,
      primary: { key: 'answer', status: 'failed' },
      durationS: 52,
      tokens: { input: 11400, output: 1900, total: 13300 },
      costUsd: 0.011,
      finishedAt: '2026-10-22T10:21:07',
    });
    expect(run.scores.map((s) => [s.key, s.status, s.score, s.comment])).toEqual([
      [
        'answer',
        'failed',
        0,
        'expected 2 duplicate pairs, got 0; agent compared invoice numbers only',
      ],
      [
        'reads_fixture',
        'failed',
        0,
        'no read_file call on invoices.csv; the file was only read through terminal (head, python3)',
      ],
    ]);
    expect(run.scores[0]!.expected).toEqual({
      summary: '2 pairs',
      detail: '[INV-1042, INV-1107]\n[INV-0988, INV-1131]',
    });
    const final = run.finalResponse!;
    expect(final.text.slice(final.extracted!.start, final.extracted!.end)).toBe(
      '{"duplicates": []}',
    );
    expect(final.text.slice(final.fence!.start, final.fence!.end)).toBe(
      '```json\n{"duplicates": []}\n```',
    );
    expect(run.counterpart).toMatchObject({ configuration: 'with-skill', unavailableReason: null });
  });

  it('has a timeline whose model calls add up to the header tokens', async () => {
    const { timeline } = await getRun(SAMPLE_RUN_ID);
    expect(timeline.events).toHaveLength(9);
    const calls = timeline.events.filter((e) => e.kind === 'network');
    expect(calls).toHaveLength(3);
    expect(calls.reduce((a, e) => a + (e.network?.tokensIn ?? 0), 0)).toBe(11400);
    expect(calls.reduce((a, e) => a + (e.network?.tokensOut ?? 0), 0)).toBe(1900);
    const refused = timeline.events.filter((e) => e.kind === 'refused');
    expect(refused.map((e) => [e.origin, e.summary])).toEqual([
      ['hermes-background', 'inference-api.nousresearch.com:443'],
    ]);
    expect(timeline.events.filter((e) => e.error).map((e) => e.seq)).toEqual([4]);
  });

  it('has the launch record of the board', async () => {
    const { launchRecord, artifacts } = await getRun(SAMPLE_RUN_ID);
    expect(launchRecord?.container).toMatchObject({
      image: 'nousresearch/hermes-agent:v0.22.4',
      hermes: 'hermes-agent v0.22.4 @ 4d04303',
      network: 'hermes-evals-trial-1',
      user: '10000',
      diskCap: { files: 50000 },
      worker: { name: 'worker-1', startedAt: '2026-10-22T10:20:15', exitCode: 0 },
      skills: [],
    });
    expect(launchRecord?.command).toContain('--api-key ‹run token, revoked›');
    expect(launchRecord?.command).not.toContain('-s invoice-method');
    expect(launchRecord?.configPath).toBe('/opt/data/config.yaml');
    expect(artifacts.agentWroteNothing).toBe(true);
    expect(artifacts.items.map((a) => [a.path, a.origin])).toEqual([
      ['workspace/invoices.csv', 'fixture_unchanged'],
    ]);
    const preview = await getArtifactPreview(SAMPLE_RUN_ID, artifacts.items[0]!.id);
    expect(preview?.rows[0]?.[0]).toBe('INV-0981');
  });

  it('adds -s invoice-method for the with-skill counterpart', async () => {
    const twin = await getRun((await getRun(SAMPLE_RUN_ID)).counterpart!.runId!);
    expect(twin.launchRecord?.command).toContain('-t file,terminal -s invoice-method');
    expect(twin.launchRecord?.container.skills.map((s) => s.name)).toEqual(['invoice-method']);
  });
});

describe('getRun: the states board', () => {
  it('execution_error: banner, attempts and stderr tail', async () => {
    const run = await getRun(id(SVN, 'disputed', 'baseline', 4));
    expect(run.status).toBe('execution_error');
    expect([run.attemptCount, run.durationS, run.durationIsBudget]).toEqual([2, 300, true]);
    expect(run.tokens).toMatchObject({ input: 21960, output: 3410 });
    expect(run.executionError).toMatchObject({
      category: 'timeout',
      reason: 'No final response within the 300 s time budget.',
      exitCode: 124,
      stderrTail: { totalLines: 1204 },
    });
    expect(last(run.executionError!.stderrTail.lines)).toBe(
      '[10:51:20] hermes: exit 124 (timeout)',
    );
    expect(run.attempts.map((a) => [a.number, a.status, a.category, a.startedAt])).toEqual([
      [1, 'execution_error', 'timeout', '2026-10-22T10:37:10'],
      [2, 'execution_error', 'timeout', '2026-10-22T10:46:20'],
    ]);
    expect(run.scores).toEqual([]);
    expect(run.finalResponse).toBeNull();
  });

  it('ungradable: the reason above the score rows', async () => {
    const run = await getRun(id(SVN, 'credit_notes', 'baseline', 2));
    expect(run.outcomeNotice).toMatchObject({
      kind: 'ungradable',
      title: 'no fenced JSON block found in final response',
    });
    expect(run.scores.map((s) => [s.key, s.status, s.score])).toEqual([
      ['answer', 'ungradable', null],
      ['method', 'passed', 0.8],
    ]);
    expect(run.finalResponse).toMatchObject({ extraction: 'missing', extracted: null });
  });

  it('score error: the failed judge request', async () => {
    const run = await getRun(id(SVN, 'credit_notes', 'with-skill', 4));
    expect(run.outcomeNotice).toMatchObject({
      kind: 'error',
      key: 'method',
      request:
        'POST https://inference-api.nousresearch.com/v1/chat/completions → 503 after 3 attempts',
    });
    expect(run.scores.map((s) => [s.key, s.status, s.comment])).toEqual([
      ['answer', 'passed', 'all 14 net balances match the reference'],
      ['method', 'error', 'llm_judge could not reach the provider'],
    ]);
    expect(run.tokens).toMatchObject({ input: 18300, output: 2450 });
  });

  it('running: a live timeline with the last call open', async () => {
    const run = await getRun(id(MVB, 'currency_mix', 'with-mcp', 5));
    expect(run).toMatchObject({
      status: 'running',
      live: { elapsedS: 38, turn: 6 },
      tokens: { input: 9840, output: 1120 },
      timeline: { live: true, totalEvents: 14 },
    });
    const open = last(run.timeline.events)!;
    expect([open.server, open.title, open.summary, open.running]).toEqual([
      'invoice-db',
      'get_invoice',
      '{"id": "INV-1094"}',
      true,
    ]);
  });

  it("refused by sandbox: a red sub-row on the agent's own tool call", async () => {
    const run = await getRun(id(SVN, 'currency_mix', 'with-skill', 2));
    const curl = run.timeline.events.find((e) => e.refusal && e.origin === 'agent')!;
    expect(curl.summary).toBe('curl -s https://example.com/fx/eur-usd.json');
    expect(curl.refusal).toEqual({
      host: 'example.com',
      port: 443,
      reason: 'not on the allowlist',
    });
    expect(curl.error).toBe(true);
  });

  it('A/B jump is disabled while the counterpart is not scored', async () => {
    const run = await getRun(id(MVB, 'disputed', 'baseline', 3));
    expect(run.counterpart).toMatchObject({
      configuration: 'with-mcp',
      status: 'scoring',
      unavailableReason: 'Counterpart run is not scored yet (scoring)',
    });
  });

  it('cancelled: marker, partial artifacts, no outcome', async () => {
    setScenario('cancelled');
    const run = await getRun(id(MVB, 'summary_file', 'with-mcp', 5));
    expect(run.status).toBe('cancelled');
    expect(run.cancelled).toEqual({ at: '2026-10-23T15:31:04', by: 'experiment', ranForS: 31 });
    expect(run.tokens).toMatchObject({ input: 7210, output: 880 });
    expect(last(run.timeline.events)?.summary).toBe(
      'Cancelled at 00:31 · experiment cancelled by user',
    );
    expect(run.artifacts.note).toBe('partial · written before the cancel');
    expect(run.artifacts.items[0]).toMatchObject({
      path: 'workspace/summary.csv',
      origin: 'agent',
      sizeBytes: 118,
    });
    expect(run.scores).toEqual([]);
  });

  it('scored after a retry: attempt 2 of 2', async () => {
    setScenario('multi-attempt');
    const run = await getRun(id(SVN, 'disputed', 'baseline', 4));
    expect([run.status, run.attemptCount, run.shownAttempt, run.durationS]).toEqual([
      'scored',
      2,
      2,
      71,
    ]);
    expect(run.attempts.map((a) => a.status)).toEqual(['execution_error', 'scored']);
    expect(run.scores.map((s) => [s.key, s.status, s.score])).toEqual([
      ['answer', 'failed', 0],
      ['rationale', 'passed', 0.75],
    ]);
  });

  it('disk limit, silent timeout and lapsed provider', async () => {
    setScenario('disk-limit');
    let run = await getRun(id(SVN, 'summary_file', 'with-skill', 2));
    expect(run.executionError).toMatchObject({
      category: 'other',
      reason: 'Stopped: the run wrote more than 2 GB to its workspace (disk limit)',
      meta: 'after 41 s · workspace 2.0 GB, 1,318 files',
    });
    setScenario('timeout-silent');
    run = await getRun(id(SVN, 'disputed', 'baseline', 4));
    expect(run.executionError).toMatchObject({ category: 'timeout', meta: 'stopped at 310 s' });
    expect(run.attemptCount).toBe(1);
    setScenario('provider-lapsed');
    run = await getRun(id(SVN, 'late_fees', 'with-skill', 3));
    expect(run.executionError).toMatchObject({
      category: 'provider',
      meta: 'attempt 1 stopped at 22 s · no attempt counted against the run',
    });
    expect(run.attempts.every((a) => !a.countsAgainstRun)).toBe(true);
  });

  it('rejects an unknown run with a 404', async () => {
    await expect(getRun('run_nope')).rejects.toThrow('GET /api/runs/run_nope → 404');
  });

  it('pages events after a sequence number', async () => {
    const page = await listRunEvents(SAMPLE_RUN_ID, 6);
    expect(page.events.map((e) => e.seq)).toEqual([7, 8, 9]);
    expect(page.lastSeq).toBe(9);
  });
});

describe('run actions', () => {
  it('re-scores, retries and cancels single runs', async () => {
    await expect(rescoreRun(SAMPLE_RUN_ID)).resolves.toMatchObject({ status: 'scored' });
    await expect(retryRun(id(SVN, 'disputed', 'baseline', 4))).resolves.toMatchObject({
      status: 'queued',
      attempt: 3,
    });
    await expect(retryRun(SAMPLE_RUN_ID)).rejects.toThrow('run is scored, not execution_error');
    await expect(cancelRun(id(MVB, 'currency_mix', 'with-mcp', 5))).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('refuses model-needing actions while Nous Portal is not connected', async () => {
    setScenario('nous-not-connected');
    await expect(rescoreRun(id(SVN, 'credit_notes', 'with-skill', 4))).rejects.toThrow(
      'Re-score needs Nous Portal for the method judge: Nous Portal is not connected.',
    );
    await expect(rescoreRun(SAMPLE_RUN_ID)).resolves.toMatchObject({ status: 'scored' });
    await expect(retryRun(id(SVN, 'disputed', 'baseline', 4))).rejects.toThrow(
      'Retry needs Nous Portal.',
    );
  });

  it('bulk actions enqueue what they can and name what they cannot', async () => {
    const exec = id(SVN, 'disputed', 'baseline', 4);
    const retry = await retryRuns(SVN, [exec, SAMPLE_RUN_ID]);
    expect(retry.enqueued).toEqual([exec]);
    expect(retry.refused).toEqual([
      { runId: SAMPLE_RUN_ID, reason: 'run is scored, not execution_error' },
    ]);
    const rescore = await rescoreRuns(SVN, [SAMPLE_RUN_ID]);
    expect(rescore).toMatchObject({ action: 'rescore', enqueued: [SAMPLE_RUN_ID], refused: [] });
    expect(rescore.evaluations).toEqual([
      expect.objectContaining({ runId: SAMPLE_RUN_ID, generation: 2, joinedPending: false }),
    ]);
    setScenario('bulk-refused');
    const refused = await rescoreRuns(SVN, [SAMPLE_RUN_ID]);
    expect(refused.enqueued).toEqual([]);
    expect(refused.refused[0]!.reason).toContain('could not be enqueued');
  });
});
