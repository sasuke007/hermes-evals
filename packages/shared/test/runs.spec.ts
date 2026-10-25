import { describe, expect, it } from 'vitest';
import {
  BulkRescoreResultSchema,
  BulkRunActionInputSchema,
  BulkRunActionResultSchema,
  RescoreRunResultSchema,
  RunActionResultSchema,
  RunDetailSchema,
  RunEvaluationViewSchema,
  RunEventsPageSchema,
  RunEventsQuerySchema,
  RunListQuerySchema,
  RunListResultSchema,
  TimelineEventSchema,
  type RunDetail,
  type RunRow,
  type TimelineEvent,
} from '../src/contracts/index.js';

const hash = (c: string) => c.repeat(64);

const CONFIG = {
  configurationId: 'cfg_baseline',
  versionId: 'cfgv_baseline',
  name: 'baseline',
  version: 1,
  role: 'baseline' as const,
  model: 'openai/gpt-6.1-sol',
  provider: 'nous' as const,
};

const NEEDS = { provider: 'nous' as const, judgeKeys: ['method'], judgeProvider: 'nous' as const };

/** Shapes as the web fixtures build them (apps/web/src/fixtures/runs.ts and inspector.ts). */
const ROW: RunRow = {
  id: 'run_01JB7X4K2M',
  experimentId: 'exp_01JBB7SVNS',
  taskKey: 'dup_invoices',
  taskVersion: 1,
  configuration: CONFIG,
  repetition: 3,
  attempts: 1,
  status: 'scored',
  primaryScore: { key: 'answer', status: 'failed', score: 0 },
  executionErrorCategory: null,
  durationS: 52,
  tokens: { input: 11400, output: 1900, total: 13300 },
  costUsd: 0.011,
  finishedAt: '2026-10-22T10:21:07',
  needs: NEEDS,
  generation: 1,
  rescorePending: false,
};

const MODEL_CALL: TimelineEvent = {
  seq: 2,
  kind: 'network',
  origin: 'agent',
  atMs: 1300,
  title: 'Model call',
  server: null,
  summary: 'openai/gpt-6.1-sol · 200 · 3,610 tokens (3,200 in / 410 out)',
  durationMs: 2900,
  error: false,
  running: false,
  input: null,
  output: null,
  outputChars: null,
  truncated: false,
  text: 'POST http://egress:8080/v1/chat/completions → 200, forwarded to Nous Portal.',
  network: {
    kind: 'model',
    decision: 'allowed',
    method: 'POST',
    url: 'http://egress:8080/v1/chat/completions',
    host: null,
    port: null,
    server: null,
    status: 200,
    reason: null,
    model: 'openai/gpt-6.1-sol',
    tokensIn: 3200,
    tokensOut: 410,
    forwardedTo: 'Nous Portal',
  },
  refusal: null,
};

const REFUSED: TimelineEvent = {
  ...MODEL_CALL,
  seq: 1,
  kind: 'refused',
  origin: 'hermes-background',
  atMs: 600,
  title: 'Refused by sandbox',
  summary: 'inference-api.nousresearch.com:443',
  durationMs: null,
  network: {
    kind: 'connect',
    decision: 'denied',
    method: null,
    url: null,
    host: 'inference-api.nousresearch.com',
    port: 443,
    server: null,
    status: null,
    reason: 'not on the allowlist',
    model: null,
    tokensIn: null,
    tokensOut: null,
    forwardedTo: null,
  },
  refusal: { host: 'inference-api.nousresearch.com', port: 443, reason: 'not on the allowlist' },
};

const DETAIL: RunDetail = {
  id: ROW.id,
  experimentId: ROW.experimentId,
  experimentName: 'Skill vs no skill, invoices-v1',
  suite: {
    suiteId: 'suite_01JAX7S1V1',
    name: 'invoices-v1',
    versionNumber: 1,
    versionLabel: null,
    contentHash: hash('3'),
  },
  task: { key: 'dup_invoices', version: 1, summary: 'Find duplicate invoices' },
  configuration: CONFIG,
  repetition: 3,
  status: 'scored',
  attemptCount: 1,
  shownAttempt: 1,
  attempts: [
    {
      number: 1,
      trigger: 'initial',
      status: 'scored',
      category: null,
      startedAt: '2026-10-22T10:20:15',
      durationS: 52,
      exitCode: 0,
      countsAgainstRun: true,
    },
  ],
  primary: { key: 'answer', status: 'failed' },
  startedAt: '2026-10-22T10:20:15',
  finishedAt: '2026-10-22T10:21:07',
  durationS: 52,
  durationIsBudget: false,
  tokens: ROW.tokens,
  costUsd: 0.011,
  limits: { maxTurns: 20, budgetS: 300 },
  live: null,
  cancelled: null,
  executionError: null,
  outcomeNotice: null,
  evaluation: { generation: 1, pending: null, lastFailure: null },
  scores: [
    {
      key: 'answer',
      type: 'json_match',
      primary: true,
      sentence: 'json_match on duplicates, unordered',
      status: 'failed',
      score: 0,
      expected: { summary: '2 pairs', detail: '[INV-1042, INV-1107]' },
      observed: { summary: '0 pairs', detail: '[]' },
      comment: 'expected 2 duplicate pairs, got 0',
      error: null,
      evidence: { eventSeqs: [9], artifactIds: [] },
    },
  ],
  timeline: { events: [REFUSED, MODEL_CALL], live: false, totalEvents: 2 },
  finalResponse: {
    text: 'Done.\n```json\n{"duplicates": []}\n```',
    extracted: { start: 14, end: 32 },
    fence: { start: 6, end: 36 },
    extraction: 'found',
    parsed: { duplicates: [] },
    parseError: null,
    reference: { duplicates: [['INV-1042', 'INV-1107']] },
    referenceNote: null,
  },
  artifacts: {
    items: [
      {
        id: 'art_01',
        path: 'workspace/invoices.csv',
        origin: 'fixture_unchanged',
        sizeBytes: 4210,
        sha256: hash('a'),
        skippedReason: null,
        preview: { columns: ['invoice_no'], rows: [['INV-0981']], totalRows: 48 },
      },
    ],
    note: null,
    agentWroteNothing: true,
  },
  launchRecord: {
    container: {
      image: 'nousresearch/hermes-agent:v0.22.4',
      digest: 'sha256:7a6920…',
      hermes: 'hermes-agent v0.22.4 @ 4d04303',
      network: 'hermes-evals-trial-1',
      user: '10000',
      imageFilesystem: 'read-only',
      limits: { memory: '1.5 GB', cpus: 1, processes: 1024, tmp: '512 MB' },
      mounts: [{ name: 'home', target: '/opt/data' }],
      diskCap: { bytes: 2 * 1024 ** 3, files: 50000 },
      worker: { name: 'worker-1', startedAt: '2026-10-22T10:20:15', exitCode: 0 },
      skills: [],
      mcpServers: [],
    },
    command: 'hermes chat … --api-key ‹run token, revoked›',
    commandNote: null,
    configPath: '/opt/data/config.yaml',
    configYaml: 'model:\n  default: openai/gpt-6.1-sol',
    configNote: null,
  },
  counterpart: {
    runId: 'run_01JB7X4K3P',
    configuration: 'with-skill',
    status: 'scored',
    unavailableReason: null,
  },
  needs: NEEDS,
};

/** Issue paths of a failed parse, joined with dots. */
function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  expect(result.success).toBe(false);
  return result.error!.issues.map((i) => i.path.join('.'));
}

describe('run view models', () => {
  it('accept the row, the detail and an events page the web fixtures build', () => {
    const list = {
      rows: [ROW],
      matched: 1,
      summary: { total: 1, passed: 0, failed: 1, error: 0, ungradable: 0, executionErrors: 0 },
    };
    expect(RunListResultSchema.parse(list)).toEqual(list);
    expect(RunDetailSchema.parse(DETAIL)).toEqual(DETAIL);
    const queued = { ...DETAIL, status: 'queued', attemptCount: 0, shownAttempt: 0, attempts: [] };
    expect(RunDetailSchema.safeParse({ ...queued, launchRecord: null }).success).toBe(true);
    const page = { events: [MODEL_CALL], lastSeq: 2, live: false };
    expect(RunEventsPageSchema.parse(page)).toEqual(page);
    expect(RunEventsPageSchema.parse({ events: [], lastSeq: 0, live: true })).toBeTruthy();
  });

  it('refuse values out of range', () => {
    const bad: [Partial<TimelineEvent>, string][] = [
      [{ seq: 0 }, 'seq'],
      [{ kind: 'mcp' as TimelineEvent['kind'] }, 'kind'],
      [{ atMs: -1 }, 'atMs'],
      [{ network: { ...MODEL_CALL.network!, status: 42 } }, 'network.status'],
      [{ refusal: { host: 'example.com', port: 0, reason: 'x' } }, 'refusal.port'],
    ];
    for (const [change, path] of bad) {
      expect(issuePaths(TimelineEventSchema.safeParse({ ...MODEL_CALL, ...change }))).toEqual([
        path,
      ]);
    }
    const span = { ...DETAIL.finalResponse!, extracted: { start: 32, end: 14 } };
    expect(issuePaths(RunDetailSchema.safeParse({ ...DETAIL, finalResponse: span }))).toEqual([
      'finalResponse.extracted.end',
    ]);
    const tail = {
      ...DETAIL,
      executionError: {
        category: 'timeout',
        reason: 'No final response within the 300 s time budget.',
        meta: null,
        explanation: null,
        stderrTail: { lines: Array.from({ length: 41 }, () => 'line'), totalLines: 41 },
        exitCode: 124,
      },
    };
    expect(issuePaths(RunDetailSchema.safeParse(tail))).toEqual([
      'executionError.stderrTail.lines',
    ]);
  });
});

describe('RunListQuerySchema', () => {
  it('parses the query the web sends to the page filters', () => {
    expect(RunListQuerySchema.parse({})).toEqual({});
    expect(
      RunListQuerySchema.parse({
        config: 'with-skill',
        task: 'total_due',
        status: 'scored',
        score_status: 'ungradable',
        exec_error: '1',
        ungradable: 'true',
        sort: 'duration',
        dir: 'asc',
      }),
    ).toEqual({
      configuration: 'with-skill',
      task: 'total_due',
      status: 'scored',
      scoreStatus: 'ungradable',
      hasExecutionError: true,
      ungradable: true,
      sort: 'duration',
      dir: 'asc',
    });
    expect(RunListQuerySchema.parse({ exec_error: 'false', ungradable: '0' })).toEqual({
      hasExecutionError: false,
      ungradable: false,
    });
    expect(RunListQuerySchema.parse({ config: 'all', task: 'all' })).toEqual({});
  });

  it('refuses unknown statuses, sorts and flags', () => {
    const bad: [Record<string, string>, string][] = [
      [{ status: 'done' }, 'status'],
      [{ score_status: 'pass' }, 'score_status'],
      [{ exec_error: 'yes' }, 'exec_error'],
      [{ ungradable: '' }, 'ungradable'],
      [{ sort: 'name' }, 'sort'],
      [{ dir: 'up' }, 'dir'],
      [{ config: '' }, 'config'],
    ];
    for (const [query, path] of bad) {
      expect(issuePaths(RunListQuerySchema.safeParse(query)), JSON.stringify(query)).toEqual([
        path,
      ]);
    }
  });
});

describe('BulkRunActionInputSchema', () => {
  it('takes 1 to 500 distinct run ids and nothing else', () => {
    const runIds = Array.from({ length: 500 }, (_, i) => `run_${i}`);
    expect(BulkRunActionInputSchema.parse({ runIds })).toEqual({ runIds });
    const bad: unknown[] = [
      {},
      { runIds: [] },
      { runIds: [...runIds, 'run_500'] },
      { runIds: ['run_1', 'run_1'] },
      { runIds: [''] },
      { runIds: ['run_1'], all: true },
    ];
    for (const body of bad) {
      expect(BulkRunActionInputSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('RunEventsQuerySchema', () => {
  it('reads after as a sequence number, 0 by default', () => {
    expect(RunEventsQuerySchema.parse({})).toEqual({ after: 0 });
    expect(RunEventsQuerySchema.parse({ after: '17' })).toEqual({ after: 17 });
    for (const after of ['-1', '1.5', 'last']) {
      expect(issuePaths(RunEventsQuerySchema.safeParse({ after }))).toEqual(['after']);
    }
  });
});

describe('timeline network rows (Phase 2 question 4)', () => {
  const blank = { ...MODEL_CALL, kind: 'tool' as const, network: null };
  const entry = MODEL_CALL.network!;

  it('describe every kind of connection log entry, with what the log does not record as null', () => {
    const mcp: TimelineEvent = {
      ...MODEL_CALL,
      title: 'MCP call',
      network: {
        ...entry,
        kind: 'mcp',
        method: 'POST',
        url: 'http://egress:8080/mcp/vendor',
        host: 'mcp.example.com',
        server: 'vendor',
        model: null,
        tokensIn: null,
        tokensOut: null,
        forwardedTo: null,
      },
    };
    const http: TimelineEvent = {
      ...MODEL_CALL,
      title: 'HTTP request',
      network: {
        ...REFUSED.network!,
        kind: 'http',
        decision: 'allowed',
        status: 301,
        reason: null,
      },
    };
    const unanswered: TimelineEvent = {
      ...MODEL_CALL,
      network: { ...entry, status: null, tokensIn: null, tokensOut: null },
    };
    for (const event of [MODEL_CALL, REFUSED, mcp, http, unanswered, blank]) {
      expect(TimelineEventSchema.parse(event)).toEqual(event);
    }
  });

  it('is set exactly on network and refused rows', () => {
    expect(issuePaths(TimelineEventSchema.safeParse({ ...MODEL_CALL, network: null }))).toEqual([
      'network',
    ]);
    expect(issuePaths(TimelineEventSchema.safeParse({ ...REFUSED, network: null }))).toEqual([
      'network',
    ]);
    expect(issuePaths(TimelineEventSchema.safeParse({ ...blank, network: entry }))).toEqual([
      'network',
    ]);
  });

  it('refuses unknown kinds and decisions, and a missing field', () => {
    const bad: [unknown, string][] = [
      [{ ...entry, kind: 'dns' }, 'network.kind'],
      [{ ...entry, decision: 'maybe' }, 'network.decision'],
      [{ ...entry, port: 0 }, 'network.port'],
      [{ ...entry, tokensIn: -1 }, 'network.tokensIn'],
      [{ ...entry, forwardedTo: undefined }, 'network.forwardedTo'],
    ];
    for (const [network, path] of bad) {
      expect(issuePaths(TimelineEventSchema.safeParse({ ...MODEL_CALL, network })), path).toEqual([
        path,
      ]);
    }
  });
});

describe('re-score contracts (plan 9.4)', () => {
  const pending = {
    evaluationId: 'eval_01JBC',
    generation: 2,
    status: 'queued' as const,
    cause: 'rescore' as const,
    requestedAt: '2026-10-25T10:00:00.000Z',
  };

  it('show the current generation and a pending or failed re-score', () => {
    for (const view of [
      { generation: null, pending: null, lastFailure: null },
      {
        generation: null,
        pending: { ...pending, generation: 1, cause: 'initial' },
        lastFailure: null,
      },
      { generation: 1, pending, lastFailure: null },
      {
        generation: 1,
        pending: null,
        lastFailure: {
          generation: 2,
          error: 'grading failed after 3 tries',
          finishedAt: pending.requestedAt,
        },
      },
    ]) {
      expect(RunEvaluationViewSchema.parse(view)).toEqual(view);
    }
    const row = { ...ROW, generation: 1, rescorePending: true };
    const list = {
      rows: [row],
      matched: 1,
      summary: { total: 1, passed: 0, failed: 1, error: 0, ungradable: 0, executionErrors: 0 },
    };
    expect(RunListResultSchema.parse(list)).toEqual(list);
    const detail = { ...DETAIL, evaluation: { generation: 1, pending, lastFailure: null } };
    expect(RunDetailSchema.parse(detail)).toEqual(detail);
  });

  it('refuse a generation below 1, an unknown status, and a missing field', () => {
    const bad: [unknown, string][] = [
      [{ generation: 0, pending: null, lastFailure: null }, 'generation'],
      [
        { generation: 1, pending: { ...pending, status: 'completed' }, lastFailure: null },
        'pending.status',
      ],
      [
        { generation: 1, pending: { ...pending, cause: 'manual' }, lastFailure: null },
        'pending.cause',
      ],
      [{ generation: 1, pending: null }, 'lastFailure'],
    ];
    for (const [view, path] of bad) {
      expect(issuePaths(RunEvaluationViewSchema.safeParse(view)), path).toEqual([path]);
    }
    expect(issuePaths(RunDetailSchema.safeParse({ ...DETAIL, evaluation: undefined }))).toEqual([
      'evaluation',
    ]);
    const { rescorePending: _, ...row } = ROW;
    expect(
      issuePaths(
        RunListResultSchema.safeParse({
          rows: [row],
          matched: 1,
          summary: { total: 1, passed: 0, failed: 1, error: 0, ungradable: 0, executionErrors: 0 },
        }),
      ),
    ).toEqual(['rows.0.rescorePending']);
  });

  it('answers a single re-score as a run action with its evaluation, joined or new', () => {
    const fresh = {
      runId: ROW.id,
      status: 'scored',
      attempt: null,
      evaluation: pending,
      joinedPending: false,
    };
    const joined = { ...fresh, evaluation: { ...pending, status: 'running' }, joinedPending: true };
    for (const result of [fresh, joined]) {
      expect(RescoreRunResultSchema.parse(result)).toEqual(result);
      // The inspector's action handling reads it as any run action.
      expect(RunActionResultSchema.safeParse(result).success).toBe(true);
    }
    const bad: [unknown, string][] = [
      [{ ...fresh, status: 'scoring' }, 'status'],
      [{ ...fresh, attempt: 2 }, 'attempt'],
      [{ ...fresh, evaluation: { ...pending, cause: 'initial' } }, 'evaluation.cause'],
      [{ ...fresh, evaluation: { ...pending, generation: 0 } }, 'evaluation.generation'],
      [{ ...fresh, joinedPending: undefined }, 'joinedPending'],
    ];
    for (const [result, path] of bad) {
      expect(issuePaths(RescoreRunResultSchema.safeParse(result)), path).toEqual([path]);
    }
  });

  it('answers a bulk re-score per run, like bulk retry, with each accepted run’s evaluation', () => {
    const result = {
      action: 'rescore',
      enqueued: ['run_a', 'run_b'],
      refused: [{ runId: 'run_c', reason: 'run is execution_error, not scored' }],
      evaluations: [
        {
          runId: 'run_a',
          evaluationId: 'eval_a',
          generation: 2,
          status: 'queued',
          joinedPending: false,
        },
        {
          runId: 'run_b',
          evaluationId: 'eval_b',
          generation: 3,
          status: 'running',
          joinedPending: true,
        },
      ],
    };
    expect(BulkRescoreResultSchema.parse(result)).toEqual(result);
    expect(BulkRunActionResultSchema.safeParse(result).success).toBe(true);
    const empty = { action: 'rescore', enqueued: [], refused: result.refused, evaluations: [] };
    expect(BulkRescoreResultSchema.parse(empty)).toEqual(empty);

    const bad: [unknown, string][] = [
      [{ ...result, action: 'retry' }, 'action'],
      [{ ...result, evaluations: result.evaluations.slice(0, 1) }, 'evaluations'],
      [{ ...result, evaluations: [...result.evaluations].reverse() }, 'evaluations'],
      [{ ...result, refused: [{ runId: 'run_c' }] }, 'refused.0.reason'],
    ];
    for (const [body, path] of bad) {
      expect(issuePaths(BulkRescoreResultSchema.safeParse(body)), path).toEqual([path]);
    }
  });
});
