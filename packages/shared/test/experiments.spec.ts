import { describe, expect, it } from 'vitest';
import {
  ComparisonQuerySchema,
  EstimateQuerySchema,
  ExperimentActionResultSchema,
  ExperimentDetailSchema,
  ExperimentListRowSchema,
  LaunchExperimentInputSchema,
  NewExperimentDraftSchema,
  NewExperimentOptionsSchema,
  ResumeExperimentInputSchema,
  RunCountsSchema,
  type ExperimentConfigRef,
  type ExperimentDetail,
  type ExperimentListRow,
  type LaunchExperimentInput,
  type NewExperimentOptions,
  type RunCounts,
} from '../src/contracts/index.js';

const hash = (c: string) => c.repeat(64);

/** Shapes as the web fixtures build them (apps/web/src/fixtures/experiments.ts). */
const SUITE = {
  suiteId: 'suite_01JAX7S1V1',
  name: 'invoices-v1',
  versionNumber: 1,
  versionLabel: '2026.10',
  contentHash: hash('3'),
};

const ref = (name: string, role: 'baseline' | 'candidate'): ExperimentConfigRef => ({
  configurationId: `cfg_${name}`,
  versionId: `cfgv_${name}`,
  name,
  version: 1,
  role,
  model: 'openai/gpt-6.1-sol',
  provider: 'nous',
});
const BASELINE = ref('baseline', 'baseline');
const WITH_SKILL = ref('with-skill', 'candidate');

const COUNTS: RunCounts = {
  queued: 28,
  running: 3,
  executed: 0,
  scoring: 1,
  scored: 87,
  execution_error: 1,
  cancelled: 0,
};

const SPEND = {
  spentUsd: 1.21,
  ceilingUsd: 2,
  projectedTotalUsd: 1.66,
  remainingEstimateUsd: 0.45,
  unpricedAttempts: 0,
};

const ROW: ExperimentListRow = {
  id: 'exp_01JBFMCPVB',
  name: 'MCP vs baseline, invoices-v1',
  status: 'running',
  pauseReason: null,
  statusReason: null,
  suite: SUITE,
  baseline: BASELINE,
  candidates: [WITH_SKILL],
  repetitions: 5,
  totalRuns: 120,
  doneRuns: 87,
  counts: COUNTS,
  verdicts: [],
  createdAt: '2026-10-23T14:52:30',
  costUsd: 1.21,
};

const DETAIL: ExperimentDetail = {
  id: ROW.id,
  name: ROW.name,
  description: 'Does giving the agent the invoice-db MCP server improve accuracy?',
  status: 'running',
  pauseReason: null,
  pausedAt: null,
  createdAt: ROW.createdAt,
  finishedAt: null,
  cancelledAt: null,
  elapsedS: 1872,
  remainingEstimateS: 600,
  lastEventAt: '2026-10-23T15:23:42',
  suite: {
    ...SUITE,
    path: './suites/invoices-v1',
    taskCount: 12,
    tasks: [{ key: 'total_due', version: 1 }],
    newerVersion: null,
  },
  baseline: BASELINE,
  candidates: [WITH_SKILL],
  differences: [
    {
      field: 'skills',
      candidate: 'with-skill',
      baselineValue: '—',
      candidateValue: 'invoice-method@1.0.0',
      hash: hash('d'),
    },
  ],
  hermes: { package: 'hermes-agent', version: 'v0.22.4', revision: '4d04303' },
  scoreKey: 'primary',
  repetitions: 5,
  concurrency: 3,
  timeBudgetOverrideS: null,
  totalRuns: 120,
  counts: COUNTS,
  spend: SPEND,
  perConfiguration: [
    { configuration: BASELINE, total: 60, counts: COUNTS, passed: 30, provisionalPassRate: 0.682 },
  ],
  feed: [
    {
      runId: 'run_01JB7X4K2M',
      finishedAt: '2026-10-23T15:23:41',
      taskKey: 'per_vendor',
      configuration: 'with-skill',
      repetition: 4,
      result: 'passed',
      durationS: 44,
    },
  ],
  verdicts: [
    {
      baseline: BASELINE,
      candidate: WITH_SKILL,
      verdict: 'provisional',
      scoreKey: 'primary',
      delta: 0.068,
      lo: -0.061,
      hi: 0.197,
      passRates: { baseline: 0.633, candidate: 0.85 },
      passCounts: { baseline: { passed: 38, counted: 60 }, candidate: { passed: 51, counted: 60 } },
      taskCounts: { improved: 8, regressed: 0, unchanged: 4 },
      method: { name: 'paired_bootstrap', resamples: 10000, confidence: 0.95 },
      reason: null,
      history: [],
    },
  ],
  aggregates: [
    {
      configuration: BASELINE,
      runs: 60,
      passRate: 0.633,
      meanScore: 0.671,
      medianDurationS: 48,
      meanTokens: 14200,
      costUsd: 0.71,
      executionErrors: 1,
      executionErrorCategories: ['timeout'],
      ungradable: 2,
    },
  ],
  failure: null,
  worker: { connected: true, lastHeartbeatAt: '2026-10-23T15:23:40', workerLostRuns: 0 },
};

const LAUNCH: LaunchExperimentInput = {
  name: 'Skill vs no skill, invoices-v1',
  description: '',
  suiteId: SUITE.suiteId,
  taskKeys: ['total_due', 'dup_invoices'],
  baselineVersionId: BASELINE.versionId,
  candidateVersionIds: [WITH_SKILL.versionId],
  repetitions: 5,
  concurrency: 3,
  spendCeilingUsd: null,
  timeBudgetOverrideS: null,
  expectedConfigHashes: { [BASELINE.versionId]: hash('b'), [WITH_SKILL.versionId]: hash('e') },
};

/** Issue paths of a failed parse, joined with dots. */
function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  expect(result.success).toBe(false);
  return result.error!.issues.map((i) => i.path.join('.'));
}

describe('experiment view models', () => {
  it('accept the list row and detail the web fixtures build', () => {
    expect(ExperimentListRowSchema.parse(ROW)).toEqual(ROW);
    expect(ExperimentDetailSchema.parse(DETAIL)).toEqual(DETAIL);
    const failure = {
      at: '2026-10-23T14:33:41',
      threshold: 14,
      category: 'setup' as const,
      message: 'invoice-db failed to start',
      stderrFirstLine: 'Error: INVOICE_DB_URL is not set',
      identicalIn: 14,
      fix: { label: 'check Secrets', to: '/resources/secrets' },
      runId: 'run_01JBFMCPFT01',
    };
    const failed = { ...DETAIL, status: 'failed', finishedAt: failure.at, failure };
    expect(ExperimentDetailSchema.safeParse(failed).success).toBe(true);
    const paused = { pauseReason: 'provider_disconnected', pausedAt: '2026-10-23T15:08:00' };
    expect(
      ExperimentDetailSchema.safeParse({ ...DETAIL, status: 'paused', ...paused }).success,
    ).toBe(true);
    expect(ExperimentActionResultSchema.parse({ id: ROW.id, status: 'paused' })).toBeTruthy();
  });

  it('carry every run status in the counts', () => {
    const { cancelled: _, ...missing } = COUNTS;
    expect(issuePaths(RunCountsSchema.safeParse(missing))).toEqual(['cancelled']);
    expect(RunCountsSchema.safeParse({ ...COUNTS, waiting: 0 }).success).toBe(false);
    expect(RunCountsSchema.safeParse({ ...COUNTS, queued: -1 }).success).toBe(false);
  });

  it('hold the status columns to the CHECK rules', () => {
    expect(issuePaths(ExperimentListRowSchema.safeParse({ ...ROW, status: 'paused' }))).toEqual([
      'pauseReason',
    ]);
    expect(
      issuePaths(ExperimentListRowSchema.safeParse({ ...ROW, pauseReason: 'spend_ceiling' })),
    ).toEqual(['pauseReason']);
    expect(
      issuePaths(ExperimentDetailSchema.safeParse({ ...DETAIL, status: 'completed' })),
    ).toEqual(['finishedAt']);
    const failed = { ...DETAIL, status: 'failed', finishedAt: '2026-10-23T15:30:00' };
    expect(issuePaths(ExperimentDetailSchema.safeParse(failed))).toEqual(['failure']);
    const pausedAt = { ...DETAIL, pausedAt: '2026-10-23T15:08:00' };
    expect(issuePaths(ExperimentDetailSchema.safeParse(pausedAt))).toEqual(['pausedAt']);
    // Cancel leaves an experiment running while in-flight runs finish, then completed.
    const cancelling = { ...DETAIL, cancelledAt: '2026-10-23T15:20:00' };
    expect(ExperimentDetailSchema.safeParse(cancelling).success).toBe(true);
    const pausedCancel = {
      ...cancelling,
      status: 'paused',
      pauseReason: 'user',
      pausedAt: '2026-10-23T15:08:00',
    };
    expect(issuePaths(ExperimentDetailSchema.safeParse(pausedCancel))).toEqual(['cancelledAt']);
  });

  it('list final verdicts only once completed', () => {
    const chip = {
      candidate: 'with-skill',
      candidateVersionId: WITH_SKILL.versionId,
      verdict: 'better' as const,
      delta: 0.217,
      lo: 0.117,
      hi: 0.333,
      reason: null,
    };
    const completed = { ...ROW, status: 'completed' as const, verdicts: [chip] };
    expect(ExperimentListRowSchema.parse(completed)).toEqual(completed);
    // A chip with no verdict says why, for "No interval (1 rep)".
    const why = {
      ...chip,
      verdict: 'not_computable' as const,
      lo: null,
      hi: null,
      reason: 'single_repetition' as const,
    };
    expect(ExperimentListRowSchema.parse({ ...completed, verdicts: [why] }).verdicts).toEqual([
      why,
    ]);
    expect(
      issuePaths(
        ExperimentListRowSchema.safeParse({
          ...completed,
          verdicts: [{ ...chip, reason: 'unknown' }],
        }),
      ),
    ).toEqual(['verdicts.0.reason']);
    expect(ExperimentListRowSchema.safeParse({ ...completed, verdicts: [] }).success).toBe(true);
    for (const status of ['running', 'failed'] as const) {
      expect(issuePaths(ExperimentListRowSchema.safeParse({ ...completed, status }))).toEqual([
        'verdicts',
      ]);
    }
    const reason = {
      ...DETAIL.verdicts[0]!,
      verdict: 'not_computable',
      reason: 'single_repetition',
    };
    expect(ExperimentDetailSchema.safeParse({ ...DETAIL, verdicts: [reason] }).success).toBe(true);
    const unknown = { ...reason, reason: 'one_rep' };
    expect(
      issuePaths(ExperimentDetailSchema.safeParse({ ...DETAIL, verdicts: [unknown] })),
    ).toEqual(['verdicts.0.reason']);
  });

  it('refuse rates, deltas and money out of range', () => {
    const bad: [Partial<ExperimentDetail>, string][] = [
      [{ spend: { ...SPEND, spentUsd: -0.01 } }, 'spend.spentUsd'],
      [{ spend: { ...SPEND, ceilingUsd: 0 } }, 'spend.ceilingUsd'],
      [{ verdicts: [{ ...DETAIL.verdicts[0]!, delta: 1.2 }] }, 'verdicts.0.delta'],
      [
        { verdicts: [{ ...DETAIL.verdicts[0]!, verdict: 'better!' as 'better' }] },
        'verdicts.0.verdict',
      ],
      [{ aggregates: [{ ...DETAIL.aggregates[0]!, passRate: 1.5 }] }, 'aggregates.0.passRate'],
      [{ differences: [{ ...DETAIL.differences[0]!, hash: '3f9c2a1' }] }, 'differences.0.hash'],
      [{ candidates: [] }, 'candidates'],
    ];
    for (const [change, path] of bad) {
      expect(issuePaths(ExperimentDetailSchema.safeParse({ ...DETAIL, ...change }))).toEqual([
        path,
      ]);
    }
  });
});

describe('LaunchExperimentInputSchema', () => {
  it('accepts the New experiment body and trims the name', () => {
    expect(LaunchExperimentInputSchema.parse(LAUNCH)).toEqual(LAUNCH);
    const padded = LaunchExperimentInputSchema.parse({ ...LAUNCH, name: '  quick check  ' });
    expect(padded.name).toBe('quick check');
    const limits = { spendCeilingUsd: 10_000, timeBudgetOverrideS: 30, repetitions: 1 };
    expect(LaunchExperimentInputSchema.safeParse({ ...LAUNCH, ...limits }).success).toBe(true);
    const upper = {
      spendCeilingUsd: 0.01,
      timeBudgetOverrideS: 3600,
      repetitions: 20,
      concurrency: 16,
    };
    expect(LaunchExperimentInputSchema.safeParse({ ...LAUNCH, ...upper }).success).toBe(true);
  });

  it('refuses each field out of its rule', () => {
    const bad: [Partial<Record<keyof LaunchExperimentInput, unknown>>, string][] = [
      [{ name: '   ' }, 'name'],
      [{ name: 'x'.repeat(121) }, 'name'],
      [{ description: 'x'.repeat(2001) }, 'description'],
      [{ suiteId: '' }, 'suiteId'],
      [{ taskKeys: [] }, 'taskKeys'],
      [{ taskKeys: ['total_due', 'total_due'] }, 'taskKeys'],
      [{ taskKeys: [''] }, 'taskKeys.0'],
      [{ baselineVersionId: '' }, 'baselineVersionId'],
      [{ candidateVersionIds: [] }, 'candidateVersionIds'],
      [{ repetitions: 0 }, 'repetitions'],
      [{ repetitions: 21 }, 'repetitions'],
      [{ repetitions: 2.5 }, 'repetitions'],
      [{ concurrency: 0 }, 'concurrency'],
      [{ concurrency: 17 }, 'concurrency'],
      [{ spendCeilingUsd: 0 }, 'spendCeilingUsd'],
      [{ spendCeilingUsd: 0.001 }, 'spendCeilingUsd'],
      [{ spendCeilingUsd: 10_000.01 }, 'spendCeilingUsd'],
      [{ timeBudgetOverrideS: 29 }, 'timeBudgetOverrideS'],
      [{ timeBudgetOverrideS: 3601 }, 'timeBudgetOverrideS'],
      [{ timeBudgetOverrideS: 60.5 }, 'timeBudgetOverrideS'],
    ];
    for (const [change, path] of bad) {
      const result = LaunchExperimentInputSchema.safeParse({ ...LAUNCH, ...change });
      expect(issuePaths(result), JSON.stringify(change)).toEqual([path]);
    }
    for (const key of Object.keys(LAUNCH)) {
      const { [key]: _, ...without } = LAUNCH as Record<string, unknown>;
      expect(LaunchExperimentInputSchema.safeParse(without).success, key).toBe(false);
    }
  });

  it('refuses candidates that repeat or include the baseline', () => {
    const twice = { ...LAUNCH, candidateVersionIds: [WITH_SKILL.versionId, WITH_SKILL.versionId] };
    expect(issuePaths(LaunchExperimentInputSchema.safeParse(twice))).toEqual([
      'candidateVersionIds',
    ]);
    const self = { ...LAUNCH, candidateVersionIds: [WITH_SKILL.versionId, BASELINE.versionId] };
    expect(issuePaths(LaunchExperimentInputSchema.safeParse(self))).toEqual([
      'candidateVersionIds',
    ]);
  });

  it('wants the hashes of exactly the baseline and the candidates', () => {
    const { [WITH_SKILL.versionId]: _, ...missing } = LAUNCH.expectedConfigHashes;
    const extra = { ...LAUNCH.expectedConfigHashes, cfgv_other: hash('c') };
    for (const expectedConfigHashes of [missing, extra]) {
      const result = LaunchExperimentInputSchema.safeParse({ ...LAUNCH, expectedConfigHashes });
      expect(issuePaths(result)).toEqual(['expectedConfigHashes']);
    }
    const short = { ...LAUNCH.expectedConfigHashes, [BASELINE.versionId]: 'b5d03f7' };
    const result = LaunchExperimentInputSchema.safeParse({
      ...LAUNCH,
      expectedConfigHashes: short,
    });
    expect(issuePaths(result)).toEqual([`expectedConfigHashes.${BASELINE.versionId}`]);
  });
});

describe('ResumeExperimentInputSchema', () => {
  it('takes an optional higher ceiling and nothing else', () => {
    expect(ResumeExperimentInputSchema.parse({})).toEqual({});
    expect(ResumeExperimentInputSchema.parse({ spendCeilingUsd: 3 })).toEqual({
      spendCeilingUsd: 3,
    });
    for (const body of [{ spendCeilingUsd: 0 }, { spendCeilingUsd: null }, { force: true }]) {
      expect(ResumeExperimentInputSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('EstimateQuerySchema', () => {
  const QUERY = {
    suite: SUITE.suiteId,
    versions: 'cfgv_a,cfgv_b',
    tasks: '12',
    repetitions: '5',
    concurrency: '3',
  };

  it('parses the query string to the EstimateQuery the web passes', () => {
    expect(EstimateQuerySchema.parse(QUERY)).toEqual({
      suiteId: SUITE.suiteId,
      versionIds: ['cfgv_a', 'cfgv_b'],
      taskCount: 12,
      repetitions: 5,
      concurrency: 3,
    });
  });

  it('refuses missing, repeated and out-of-range values', () => {
    const bad: [Record<string, string | undefined>, string][] = [
      [{ suite: undefined }, 'suite'],
      [{ versions: undefined }, 'versions'],
      [{ versions: ',' }, 'versions'],
      [{ versions: 'cfgv_a,cfgv_a' }, 'versions'],
      [{ tasks: '0' }, 'tasks'],
      [{ tasks: 'twelve' }, 'tasks'],
      [{ repetitions: '21' }, 'repetitions'],
      [{ concurrency: '0' }, 'concurrency'],
      [{ concurrency: '1.5' }, 'concurrency'],
    ];
    for (const [change, path] of bad) {
      const result = EstimateQuerySchema.safeParse({ ...QUERY, ...change });
      expect(issuePaths(result), JSON.stringify(change)).toEqual([path]);
    }
  });
});

describe('ComparisonQuerySchema', () => {
  it('accepts the comparison query and refuses an unknown filter', () => {
    const query = { candidate: 'cfgv_b', key: 'answer', filter: 'regressed' };
    expect(ComparisonQuerySchema.parse(query)).toEqual(query);
    expect(ComparisonQuerySchema.parse({})).toEqual({});
    expect(issuePaths(ComparisonQuerySchema.safeParse({ filter: 'better' }))).toEqual(['filter']);
    expect(issuePaths(ComparisonQuerySchema.safeParse({ key: '' }))).toEqual(['key']);
  });
});

describe('New experiment options and drafts', () => {
  const OPTIONS: NewExperimentOptions = {
    suites: [
      {
        ...SUITE,
        path: './suites/invoices-v1',
        selfCheckAt: '2026-10-22T09:41:12',
        taskCount: 12,
        validCount: 11,
        budgetS: 300,
        tasks: [
          {
            key: 'late_fees',
            version: 2,
            summary: 'Late fees per the policy terms',
            verificationCount: 2,
            valid: false,
            invalidReason: 'verifier_script check_late_fees.py printed no result line',
            hasLlmJudge: false,
          },
        ],
      },
    ],
    configurations: [
      {
        configurationId: BASELINE.configurationId,
        versionId: BASELINE.versionId,
        name: 'baseline',
        version: 1,
        configHash: hash('b'),
        model: 'openai/gpt-6.1-sol',
        provider: 'nous',
        mockModel: false,
        memoryEnabled: false,
        skills: [],
        skillLoading: 'preload',
        mcpServers: ['invoice-db (stdio)'],
        missingSecrets: [],
        estimates: {
          [SUITE.suiteId]: {
            seconds: 48,
            costUsd: null,
            tokens: 14200,
            basis: 'history',
            pastRuns: 192,
          },
        },
      },
    ],
    defaults: { repetitions: 5, concurrency: 3 },
    maxConcurrency: 0,
    workerCount: 0,
    priceTable: [
      { model: 'openai/gpt-6.1-sol', inputPer1M: 0.6, outputPer1M: 2.4, checkedAt: '2026-10-20' },
    ],
    judge: { provider: 'nous', model: 'openai/gpt-6.1-sol', mock: false, mockModelName: false },
  };

  it('accept the options and refuse a short config hash', () => {
    expect(NewExperimentOptionsSchema.parse(OPTIONS)).toEqual(OPTIONS);
    const config = { ...OPTIONS.configurations[0]!, configHash: 'b5d03f7' };
    const result = NewExperimentOptionsSchema.safeParse({ ...OPTIONS, configurations: [config] });
    expect(issuePaths(result)).toEqual(['configurations.0.configHash']);
  });

  it('keep a draft unchecked: Duplicate may leave no task selected', () => {
    const { expectedConfigHashes: _, ...values } = LAUNCH;
    const draft = {
      sourceExperimentId: 'exp_01JBB7SVNS',
      values: { ...values, taskKeys: [] },
      changes: {
        suiteVersionFrom: 1,
        suiteVersionTo: 2,
        changedTasks: ['total_due'],
        removedTasks: [],
        invalidTasks: [{ key: 'late_fees', reason: 'self-check failed' }],
      },
    };
    expect(NewExperimentDraftSchema.parse(draft)).toEqual(draft);
  });
});
