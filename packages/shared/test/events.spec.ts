import { describe, expect, it } from 'vitest';
import {
  EXPERIMENT_EVENT_TYPES,
  ExperimentEventSchema,
  SystemEventSchema,
  WorkerSchema,
  type ExperimentEvent,
} from '../src/contracts/index.js';

const AT = '2026-10-23T15:23:42.000Z';

const COUNTS = {
  queued: 28,
  running: 3,
  executed: 0,
  scoring: 1,
  scored: 87,
  execution_error: 1,
  cancelled: 0,
};

const EVENTS: ExperimentEvent[] = [
  {
    type: 'run',
    at: AT,
    runId: 'run_01JB7X4K2M',
    status: 'scored',
    attempt: 1,
    primaryScore: { key: 'answer', status: 'passed', score: 1 },
    finishedAt: AT,
    generation: 2,
    rescorePending: false,
  },
  {
    type: 'run',
    at: AT,
    runId: 'run_01JB7X4K2N',
    status: 'queued',
    attempt: 0,
    primaryScore: null,
    finishedAt: null,
    generation: null,
    rescorePending: false,
  },
  {
    type: 'counts',
    at: AT,
    counts: COUNTS,
    doneRuns: 87,
    spend: {
      spentUsd: 1.21,
      ceilingUsd: 2,
      projectedTotalUsd: 1.66,
      remainingEstimateUsd: 0.45,
      unpricedAttempts: 0,
    },
  },
  {
    type: 'experiment',
    at: AT,
    status: 'paused',
    pauseReason: 'provider_disconnected',
    failure: null,
    verdicts: [],
    verdictUpdatedAt: null,
  },
  {
    type: 'experiment',
    at: AT,
    status: 'failed',
    pauseReason: null,
    verdicts: [],
    verdictUpdatedAt: null,
    failure: {
      at: AT,
      threshold: 14,
      category: 'setup',
      message: 'invoice-db failed to start',
      stderrFirstLine: 'Error: INVOICE_DB_URL is not set',
      identicalIn: 14,
      fix: { label: 'check Secrets', to: '/resources/secrets' },
      runId: 'run_01JB7X4K2M',
    },
  },
  {
    type: 'feed',
    at: AT,
    entry: {
      runId: 'run_01JB7X4K2M',
      finishedAt: AT,
      taskKey: 'per_vendor',
      configuration: 'with-mcp',
      repetition: 4,
      result: 'execution_error',
      durationS: 300,
    },
  },
];

/** A completed experiment whose verdict a re-score recomputed: still completed, a newer entry. */
const VERDICT_UPDATED: ExperimentEvent = {
  type: 'experiment',
  at: AT,
  status: 'completed',
  pauseReason: null,
  failure: null,
  verdicts: [
    {
      candidate: 'with-skill',
      candidateVersionId: 'cfgv_with_skill',
      verdict: 'better',
      delta: 0.217,
      lo: 0.117,
      hi: 0.333,
      reason: null,
    },
  ],
  verdictUpdatedAt: '2026-10-23T14:21:16.000Z',
};

describe('ExperimentEventSchema', () => {
  it('accepts each kind of event the experiment stream sends', () => {
    for (const event of [...EVENTS, VERDICT_UPDATED]) {
      expect(ExperimentEventSchema.parse(event)).toEqual(event);
    }
    expect(new Set(EVENTS.map((e) => e.type))).toEqual(new Set(EXPERIMENT_EVENT_TYPES));
  });

  it('refuses an unknown type, a missing at and a status without its reason', () => {
    const [run, , , paused] = EVENTS;
    expect(ExperimentEventSchema.safeParse({ ...run, type: 'score' }).success).toBe(false);
    const { at: _, ...noAt } = run!;
    expect(ExperimentEventSchema.safeParse(noAt).success).toBe(false);
    expect(ExperimentEventSchema.safeParse({ ...run, attempt: -1 }).success).toBe(false);
    expect(ExperimentEventSchema.safeParse({ ...paused, pauseReason: null }).success).toBe(false);
    expect(
      ExperimentEventSchema.safeParse({ ...paused, status: 'running', pauseReason: null }).success,
    ).toBe(true);
    expect(
      ExperimentEventSchema.safeParse({ ...paused, status: 'failed', pauseReason: null }).success,
    ).toBe(false);
    const { cancelled: __, ...partial } = COUNTS;
    expect(ExperimentEventSchema.safeParse({ ...EVENTS[2], counts: partial }).success).toBe(false);
  });

  it('carries the generation and a pending re-score on a run event (Phase 3 question 3)', () => {
    const [scored] = EVENTS;
    const pending = { ...scored!, rescorePending: true };
    expect(ExperimentEventSchema.parse(pending)).toEqual(pending);
    for (const change of [
      { generation: 0 },
      { generation: 1.5 },
      { rescorePending: 'yes' },
      { generation: undefined },
      { rescorePending: undefined },
    ]) {
      expect(ExperimentEventSchema.safeParse({ ...scored, ...change }).success).toBe(false);
    }
  });

  it("carries the verdicts on an experiment event, with the newest entry's time", () => {
    expect(ExperimentEventSchema.parse(VERDICT_UPDATED)).toEqual(VERDICT_UPDATED);
    const [chip] = (VERDICT_UPDATED as { verdicts: object[] }).verdicts;
    for (const change of [
      { verdicts: undefined },
      { verdictUpdatedAt: undefined },
      { verdicts: [{ ...chip, verdict: 'improved' }] },
      { verdicts: [{ ...chip, lo: -1.5 }] },
      // A retry reopened it: no final verdict while it runs.
      { status: 'running' },
    ]) {
      expect(ExperimentEventSchema.safeParse({ ...VERDICT_UPDATED, ...change }).success).toBe(
        false,
      );
    }
  });
});

describe('SystemEventSchema', () => {
  it('carries the running summary', () => {
    const event = {
      type: 'summary',
      at: AT,
      summary: {
        running: { count: 0, scored: 0, total: 0, experiments: [] },
        workers: [
          {
            id: 'worker-1',
            status: 'online',
            lastHeartbeatAt: AT,
            concurrency: 6,
            effectiveConcurrency: 4,
            slotsInUse: 0,
            slotsTotal: 4,
            sandboxProven: true,
          },
        ],
        queuedRuns: 0,
      },
    };
    expect(SystemEventSchema.parse(event)).toEqual(event);
    expect(SystemEventSchema.safeParse({ ...event, type: 'workers' }).success).toBe(false);
    expect(SystemEventSchema.safeParse({ ...event, summary: {} }).success).toBe(false);
  });

  it("reports each worker's effective concurrency (Phase 3 question 15)", () => {
    const worker = {
      id: 'worker-1',
      status: 'online',
      lastHeartbeatAt: AT,
      concurrency: 6,
      effectiveConcurrency: 4,
      slotsInUse: 2,
      slotsTotal: 4,
      sandboxProven: true,
    };
    expect(WorkerSchema.parse(worker)).toEqual(worker);
    const { effectiveConcurrency: _, ...without } = worker;
    for (const bad of [without, { ...worker, effectiveConcurrency: 0 }]) {
      expect(WorkerSchema.safeParse(bad).success).toBe(false);
    }
  });
});
