import { describe, expect, it } from 'vitest';
import {
  EXPERIMENT_EVENT_TYPES,
  ExperimentEventSchema,
  SystemEventSchema,
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
  },
  {
    type: 'run',
    at: AT,
    runId: 'run_01JB7X4K2N',
    status: 'queued',
    attempt: 0,
    primaryScore: null,
    finishedAt: null,
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
  },
  {
    type: 'experiment',
    at: AT,
    status: 'failed',
    pauseReason: null,
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

describe('ExperimentEventSchema', () => {
  it('accepts each kind of event the experiment stream sends', () => {
    for (const event of EVENTS) expect(ExperimentEventSchema.parse(event)).toEqual(event);
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
            concurrency: 3,
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
});
