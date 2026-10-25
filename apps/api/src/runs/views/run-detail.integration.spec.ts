/**
 * GET /runs/:id on PGlite with the real triggers, for a run in every state
 * the inspector draws (run-states-spec.ts). Every detail parses with the
 * shared RunDetail schema. Event pages and artifacts: run-events.integration.spec.ts.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RunDetailSchema, type RunDetail } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { experiments } from '../../database/schema/index.js';
import { RUN_TOKEN_PLACEHOLDER } from './launch-record.js';
import { RunViewsService } from './run-views.service.js';
import { RECORDED_FINAL, seedAllStates, type AllStates } from './run-states-spec.js';
import { LEAKED_TOKEN, TRIAL_IMAGE, viewsConfig, type RunCell } from './run-fixtures-spec.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let seed: AllStates;
let views: RunViewsService;

beforeAll(async () => {
  t = await createTestDatabase();
  seed = await seedAllStates(t.db);
  views = new RunViewsService(t.db, seed.store, viewsConfig());
});

afterAll(async () => {
  await t.close();
  await seed.dispose();
});

const detail = async (cell: RunCell): Promise<RunDetail> =>
  RunDetailSchema.parse(await views.detail(seed.cell(cell)));

describe('a scored run with mixed results', () => {
  let run: RunDetail;
  beforeAll(async () => {
    run = await detail('dup_invoices/baseline/1');
  });

  it('heads the inspector with the task, configuration, attempt and figures', () => {
    expect(run).toMatchObject({
      experimentId: seed.experimentId,
      experimentName: 'Skill vs no skill',
      suite: { suiteId: seed.suiteId, name: 'invoices-v1', versionNumber: 1, versionLabel: '1.0' },
      task: { key: 'dup_invoices', version: 2, summary: 'Find invoices billed twice' },
      configuration: { name: 'baseline', role: 'baseline', provider: 'custom' },
      repetition: 1,
      status: 'scored',
      attemptCount: 1,
      shownAttempt: 1,
      primary: { key: 'answer', status: 'failed' },
      durationS: 6.1,
      durationIsBudget: false,
      tokens: { input: 3300, output: 63, total: 3363 },
      costUsd: 0,
      limits: { maxTurns: 20, budgetS: 120 },
      live: null,
      cancelled: null,
      executionError: null,
    });
    expect(run.attempts).toEqual([
      expect.objectContaining({ number: 1, trigger: 'initial', status: 'scored', exitCode: 0 }),
    ]);
  });

  it('shows each key with its sentence, expected and observed values and evidence', () => {
    expect(run.scores.map((s) => [s.key, s.status, s.primary])).toEqual([
      ['answer', 'failed', true],
      ['reads_fixture', 'error', false],
      ['check', 'passed', false],
    ]);
    const [answer, reads, check] = run.scores;
    expect(answer).toMatchObject({
      type: 'json_match',
      sentence: 'json_match on duplicates, unordered',
      score: 0.5,
      comment: '1 of 2 pairs found',
      expected: {
        summary: '2 items',
        detail: '["INV-1042", "INV-1107"]\n["INV-0988", "INV-1131"]',
      },
      observed: { summary: '1 item', detail: '["INV-1042", "INV-1107"]' },
      error: null,
      evidence: {
        eventSeqs: [7],
        artifactIds: [],
        judge: null,
        trajectory: null,
        text: null,
        jsonMatch: { unit: 'items', matched: 1, total: 2, mismatches: ['[1]'] },
      },
    });
    expect(reads).toMatchObject({
      sentence: 'trajectory_match: calls read_file at least once',
      error: { message: 'trajectory_match is scored from Phase 3', detail: null },
    });
    expect(check!.evidence.artifactIds).toEqual([seed.artifactIds.summary]);
    expect(run.outcomeNotice).toEqual({
      kind: 'error',
      title: 'Scorer error: trajectory_match is scored from Phase 3',
      detail: "Key reads_fixture · the agent's output is stored · Re-score runs only the scorers",
      request: null,
      key: 'reads_fixture',
    });
  });

  it('draws the timeline from the recorded events and the connection log', () => {
    const { events } = run.timeline;
    expect(run.timeline).toMatchObject({ live: false, totalEvents: events.length });
    expect(events.map((e) => [e.kind, e.title])).toEqual([
      ['platform', 'init'],
      ['refused', 'Refused by sandbox'],
      ['network', 'Model call'],
      ['tool', 'get_invoice'],
      ['tool', 'terminal'],
      ['text', 'text'],
      ['final', 'final response'],
      ['platform', 'collected'],
    ]);
    expect(events[1]!.origin).toBe('hermes-background');
    expect(events[2]!.network).toMatchObject({
      tokensIn: 1000,
      tokensOut: 21,
      forwardedTo: 'mock-model:8090',
    });
    expect(events[3]!.server).toBe('invoice-db');
    expect(events[4]!.refusal).toEqual({
      host: 'example.com',
      port: 443,
      reason: 'not on the allowlist',
    });
    expect(events[0]!.atMs).toBe(300);
  });

  it('shows the final text with the parsed block, its fences and the hidden reference', () => {
    const final = run.finalResponse!;
    expect(final).toMatchObject({
      text: RECORDED_FINAL,
      extraction: 'found',
      parsed: { total: 1042 },
      parseError: null,
      reference: { duplicates: [['INV-1042', 'INV-1107']] },
    });
    expect(final.text.slice(final.extracted!.start, final.extracted!.end)).toBe('{"total": 1042}');
    expect(final.text.slice(final.fence!.start, final.fence!.end)).toBe(
      '```json\n{"total": 1042}\n```',
    );
  });

  it('lists the artifacts by path with origin, previews and the skipped file', () => {
    const { items, note, agentWroteNothing } = run.artifacts;
    expect(items.map((a) => [a.path, a.origin, a.skippedReason])).toEqual([
      ['workspace/dump.bin', 'agent', 'too_large'],
      ['workspace/invoices.csv', 'fixture_unchanged', null],
      ['workspace/report.html', 'agent', null],
      ['workspace/summary.csv', 'agent', null],
    ]);
    expect(items[0]!.sha256).toBeNull();
    expect(items[3]!.preview).toEqual({
      columns: ['vendor', 'outstanding'],
      rows: [
        ['Brightline', '6215.00'],
        ['Kestrel', '1486.65'],
      ],
      totalRows: 2,
    });
    expect(items[2]!.preview).toBeNull();
    expect(note).toBe('1 file over 25 MB listed without content');
    expect(agentWroteNothing).toBe(false);
  });

  it('shows the launch record with the run token masked and secrets as names', () => {
    const record = run.launchRecord!;
    expect(record.container).toMatchObject({
      image: TRIAL_IMAGE,
      digest: `sha256:${'7a'.repeat(32)}`,
      hermes: 'hermes-agent v0.22.4 @ 4d04303',
      network: 'hermes-evals-trial-1',
      user: '10000:10000',
      imageFilesystem: 'read-only',
      limits: { memory: '1.5 GB', cpus: 1, processes: 1024, tmp: '512 MB' },
      mounts: [
        { name: 'home', target: '/opt/data' },
        { name: 'workspace', target: '/workspace' },
      ],
      diskCap: { bytes: 2 * 1024 ** 3, files: 50_000 },
      worker: { name: 'worker-1', exitCode: 0 },
      skills: [{ name: 'invoice-method', version: '1.0.0' }],
    });
    expect(record.command).toBe(
      [
        'hermes chat --query-file /opt/data/task.txt --oneshot --format stream-json \\',
        '  --provider custom -m mock/scripted \\',
        `  --base-url http://egress:8080/v1 --api-key ${RUN_TOKEN_PLACEHOLDER} \\`,
        '  -t file,terminal,invoice-db --max-turns 20 --yolo --in /workspace',
      ].join('\n'),
    );
    expect(record.configYaml).toContain('INVOICE_DB_URL: <from env INVOICE_DB_URL>');
    expect(record.configYaml).not.toContain('${');
    expect(record.container.mcpServers).toEqual([
      {
        name: 'invoice-db',
        version: 1,
        transport: 'stdio',
        definition:
          'mcp_servers:\n  invoice-db:\n    command: invoice-db-mcp\n    env:\n      INVOICE_DB_URL: <from env INVOICE_DB_URL>',
      },
    ]);
    expect(record.configNote).toMatch(/readable by the agent/);
    expect(JSON.stringify(run)).not.toContain(LEAKED_TOKEN);
  });

  it('links the same task and repetition under the candidate', () => {
    expect(run.counterpart).toEqual({
      runId: seed.cell('dup_invoices/with-skill/1'),
      configuration: 'with-skill',
      status: 'scored',
      unavailableReason: null,
    });
    expect(run.needs).toEqual({ provider: 'custom', judgeKeys: [], judgeProvider: null });
  });
});

describe('scored runs with nothing to grade or a broken scorer', () => {
  it('explains an ungradable answer and highlights nothing', async () => {
    const run = await detail('dup_invoices/baseline/2');
    expect(run.outcomeNotice).toMatchObject({
      kind: 'ungradable',
      title: 'no fenced JSON block found in final response',
      key: 'answer',
      request: null,
    });
    expect(run.finalResponse).toMatchObject({
      extraction: 'missing',
      extracted: null,
      fence: null,
      parsed: null,
    });
    expect(run.primary).toEqual({ key: 'answer', status: 'ungradable' });
  });

  it("names the primary key's scorer error before any other", async () => {
    const run = await detail('dup_invoices/baseline/3');
    expect(run.outcomeNotice).toEqual({
      kind: 'error',
      title: 'Scorer error: the scorer failed: boom',
      detail: "Key answer · the agent's output is stored · Re-score runs only the scorers",
      request: 'at jsonMatch (json-match.ts:12:3)',
      key: 'answer',
    });
    expect(run.finalResponse?.parsed).toEqual({ duplicates: [] });
  });
});

describe('execution errors', () => {
  it('provider: the reason, the stderr tail and the full log length', async () => {
    const run = await detail('dup_invoices/baseline/4');
    expect(run.executionError).toEqual({
      category: 'provider',
      reason: 'Provider said: Connection error.',
      meta: 'attempt 1 stopped at 22 s',
      explanation: expect.stringMatching(/retried once automatically/),
      stderrTail: {
        lines: [
          'POST http://egress:8080/v1/chat/completions → 502',
          'hermes: provider error; exit 1',
        ],
        totalLines: 57,
      },
      exitCode: 1,
    });
    expect(run.scores).toEqual([]);
    expect(run.outcomeNotice).toBeNull();
    expect(run.timeline.events[0]).toMatchObject({ kind: 'final', error: true });
    expect(run.finalResponse).toMatchObject({ extraction: 'missing' });
    expect(run.counterpart).toMatchObject({ status: 'execution_error', unavailableReason: null });
  });

  it('timeout: both attempts, the budget after the override, the open tool call', async () => {
    const run = await detail('dup_invoices/baseline/5');
    expect(run.attempts.map((a) => [a.number, a.trigger, a.status, a.category])).toEqual([
      [1, 'initial', 'execution_error', 'timeout'],
      [2, 'auto_retry', 'execution_error', 'timeout'],
    ]);
    expect(run).toMatchObject({
      attemptCount: 2,
      shownAttempt: 2,
      durationS: 190,
      durationIsBudget: true,
    });
    expect(run.executionError).toMatchObject({
      reason: 'No final response within the 120 s time budget.',
      meta: 'stopped at 190 s',
      exitCode: 137,
      stderrTail: { totalLines: 2 },
    });
    expect(run.timeline.events.map((e) => [e.title, e.running])).toEqual([
      ['terminal', true],
      ['killed', false],
    ]);
  });

  it('setup, worker_lost and other each read as their row of plan 8.4', async () => {
    expect((await detail('dup_invoices/with-skill/2')).executionError).toMatchObject({
      category: 'setup',
      reason: 'invoice-db failed to start',
      meta: 'exit 3',
      stderrTail: { lines: ['Error: INVOICE_DB_URL is not set', 'hermes: exit 3'], totalLines: 2 },
    });
    const lost = await detail('dup_invoices/with-skill/3');
    expect(lost.executionError).toMatchObject({
      category: 'worker_lost',
      reason: 'The worker stopped heartbeating while this run was in flight.',
      meta: 'last heartbeat 2026-10-24T15:31:04.000Z',
    });
    expect(lost.timeline.events.map((e) => e.title)).toEqual(['text', 'worker lost']);
    expect(lost.artifacts).toEqual({
      items: [],
      note: 'not collected · the worker was lost before it could collect the workspace',
      agentWroteNothing: false,
    });
    expect((await detail('dup_invoices/with-skill/4')).executionError).toMatchObject({
      category: 'other',
      reason: 'disk limit passed: workspace 2.0 GB, 1,318 files',
      explanation: expect.stringContaining('2 GB and 50,000 files'),
    });
  });
});

describe('runs in flight, cancelled or not started', () => {
  it('running: live elapsed time and turn, the open call, nothing collected yet', async () => {
    const run = await detail('dup_invoices/with-skill/5');
    expect(run.status).toBe('running');
    expect(run.live!.elapsedS).toBeGreaterThanOrEqual(29);
    expect(run.live!.turn).toBe(1);
    expect(run.timeline.live).toBe(true);
    expect(run.timeline.events.at(-1)).toMatchObject({
      title: 'terminal',
      running: true,
      summary: 'head invoices.csv',
    });
    expect(run).toMatchObject({
      durationS: null,
      finishedAt: null,
      tokens: null,
      costUsd: null,
      finalResponse: null,
    });
    expect(run.artifacts).toEqual({
      items: [],
      note: 'collected when the run ends',
      agentWroteNothing: false,
    });
    expect(run.attempts[0]).toMatchObject({ status: 'running', durationS: null });
  });

  it('cancelled by the user: when, for how long, and what was written before it', async () => {
    const run = await detail('total_due/baseline/1');
    expect(run.cancelled).toMatchObject({ by: 'user', ranForS: 31 });
    expect(run.artifacts.note).toBe('partial · written before the cancel');
    expect(run.artifacts.items.map((a) => a.path)).toEqual(['workspace/summary.csv']);
    expect(run.timeline.events.map((e) => e.title)).toEqual(['write_file', 'cancelled']);
    expect(run.finalResponse).toBeNull();
  });

  it('scored on a retry: both attempts, the scored one marked', async () => {
    const run = await detail('total_due/baseline/2');
    expect(run.attempts.map((a) => [a.number, a.status])).toEqual([
      [1, 'execution_error'],
      [2, 'scored'],
    ]);
    expect(run).toMatchObject({
      shownAttempt: 2,
      costUsd: 0.0125,
      primary: { key: 'total', status: 'passed' },
    });
    expect(run.scores[0]).toMatchObject({
      sentence: 'numeric_tolerance on total_due, within ±0.01 of the reference',
      expected: { summary: '1042', detail: null },
    });
    expect(run.outcomeNotice).toMatchObject({ kind: 'error', key: 'method' });
    expect(run.needs).toEqual({
      provider: 'custom',
      judgeKeys: ['method'],
      judgeProvider: 'custom',
    });
  });

  it('queued: no attempt, the configured limits after the override', async () => {
    const run = await detail('total_due/baseline/3');
    expect(run).toMatchObject({
      status: 'queued',
      attemptCount: 0,
      shownAttempt: 0,
      attempts: [],
      startedAt: null,
      limits: { maxTurns: 20, budgetS: 120 },
      launchRecord: null,
      finalResponse: null,
      timeline: { events: [], live: false, totalEvents: 0 },
    });
  });

  it('queued for a retry: the previous attempt listed, but not as the run’s outcome', async () => {
    const run = await detail('total_due/baseline/4');
    expect(run).toMatchObject({
      status: 'queued',
      attemptCount: 1,
      shownAttempt: 1,
      startedAt: null,
      durationS: null,
      executionError: null,
    });
    expect(run.attempts).toEqual([
      expect.objectContaining({ status: 'execution_error', category: 'provider' }),
    ]);
  });

  it('executed, not scored yet: the extraction scoring will find, no scores', async () => {
    const run = await detail('total_due/with-skill/1');
    expect(run.finalResponse).toMatchObject({ extraction: 'found', parsed: { total_due: 1041.5 } });
    expect(run).toMatchObject({
      scores: [],
      primary: { key: 'total', status: null },
      durationS: 40,
    });
    expect(run.counterpart).toEqual({
      runId: seed.cell('total_due/baseline/1'),
      configuration: 'baseline',
      status: 'cancelled',
      unavailableReason: 'Counterpart run was cancelled',
    });
  });

  it('answers 404 for an unknown run', async () => {
    await expect(views.detail('run_nope')).rejects.toMatchObject({
      response: { statusCode: 404, message: 'run run_nope not found' },
    });
  });
});

// Last: it changes the experiment the other tests read.
it("says the experiment's cancel stopped a run when the run was cancelled with it", async () => {
  await t.db
    .update(experiments)
    .set({ cancelledAt: new Date('2026-10-24T15:00:00.000Z') })
    .where(eq(experiments.id, seed.experimentId));
  expect((await detail('total_due/baseline/1')).cancelled?.by).toBe('experiment');
});
