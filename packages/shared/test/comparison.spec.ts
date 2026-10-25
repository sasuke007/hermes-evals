/**
 * The comparison and verdict contracts Phase 4 answers with (plan 10,
 * UI_FLOWS 16): GET /experiments/:id/comparison, the not-computable reasons,
 * the sensitivity interval, and the verdict history entries reconcile
 * appends. Shapes as the web fixtures build them
 * (apps/web/src/fixtures/comparison.ts), with the design's numbers.
 */
import { describe, expect, it } from 'vitest';
import {
  ComparisonViewSchema,
  EXECUTION_ERROR_CATEGORIES,
  NOT_COMPUTABLE_REASONS,
  SCORE_KEY_ANY_FAILED,
  SCORE_KEY_PRIMARY,
  SecondaryMetricsRowSchema,
  SensitivityViewSchema,
  VerdictEntrySchema,
  type ComparisonView,
  type ExperimentConfigRef,
  type RepetitionCell,
  type SensitivityView,
  type VerdictEntry,
} from '../src/index.js';

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

const cell = (repetition: number, change: Partial<RepetitionCell> = {}): RepetitionCell => ({
  runId: `run_${repetition}`,
  repetition,
  runStatus: 'scored',
  scoreStatus: 'passed',
  attempt: 1,
  durationS: 48,
  comment: 'answer matched the reference',
  ...change,
});

const SENSITIVITY: SensitivityView = {
  excludedBaseline: { executionErrors: 1, ungradable: 2, error: 0 },
  excludedCandidate: { executionErrors: 0, ungradable: 0, error: 1 },
  baseline: { passed: 38, counted: 57, rate: 0.667 },
  candidate: { passed: 51, counted: 59, rate: 0.864 },
  delta: 0.197,
  lo: 0.1,
  hi: 0.3,
  verdict: 'better',
  verdictChanges: false,
};

/** Skill vs no skill, completed: 38 / 60 against 51 / 60, Δ +0.217 [+0.117, +0.333]. */
const VIEW: ComparisonView = {
  experimentId: 'exp_01JBB7SVNS',
  experimentStatus: 'completed',
  provisional: false,
  repetitions: 5,
  baseline: BASELINE,
  candidate: WITH_SKILL,
  candidates: [{ configuration: WITH_SKILL, verdict: 'better' }],
  scoreKey: SCORE_KEY_PRIMARY,
  scoreKeyOptions: [
    { value: SCORE_KEY_PRIMARY, label: 'Primary key per task' },
    { value: 'answer', label: 'answer (all 12 tasks)' },
    { value: SCORE_KEY_ANY_FAILED, label: 'Any key failed' },
  ],
  filter: 'all',
  filterCounts: { all: 12, improved: 8, regressed: 0, unchanged: 4 },
  rows: [
    {
      taskKey: 'overdue_list',
      taskVersion: 1,
      baseline: [1, 2, 3, 4, 5].map((r) =>
        cell(r, r % 2 === 0 ? { scoreStatus: 'failed', comment: 'expected 6 ids, got 5' } : {}),
      ),
      candidate: [1, 2, 3, 4, 5].map((r) => cell(r)),
      passBaseline: 0.6,
      passCandidate: 1,
      delta: 0.4,
      change: 'improved',
    },
  ],
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
  secondary: [
    {
      configuration: BASELINE,
      medianDurationS: 48,
      meanTokens: 14_200,
      costUsd: 0.71,
      executionErrors: 1,
      executionErrorCategories: ['timeout'],
      ungradable: 2,
    },
    {
      configuration: WITH_SKILL,
      medianDurationS: 61,
      meanTokens: 19_800,
      costUsd: 0.98,
      executionErrors: 0,
      executionErrorCategories: [],
      ungradable: 0,
    },
  ],
  secondaryDifference: {
    medianDurationS: 13,
    meanTokensPct: 39,
    costUsd: 0.27,
    executionErrors: -1,
    ungradable: -2,
  },
  sensitivity: SENSITIVITY,
  progress: { scored: 119, total: 120 },
};

/** Issue paths of a failed parse, joined with dots. */
function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  expect(result.success).toBe(false);
  return result.error!.issues.map((i) => i.path.join('.'));
}

describe('ComparisonViewSchema', () => {
  it("accepts the design's comparison, and a provisional one while running", () => {
    expect(ComparisonViewSchema.parse(VIEW)).toEqual(VIEW);
    const running = {
      ...VIEW,
      experimentStatus: 'running',
      provisional: true,
      statistics: { ...VIEW.statistics!, verdict: 'provisional', provisional: true },
      sensitivity: { ...SENSITIVITY, verdict: 'provisional' },
    };
    expect(ComparisonViewSchema.parse(running)).toEqual(running);
  });

  it('replaces the statistics with one of the three reasons, and its sentence', () => {
    expect(NOT_COMPUTABLE_REASONS).toEqual([
      'single_repetition',
      'not_enough_runs',
      'nothing_scored',
    ]);
    for (const reason of NOT_COMPUTABLE_REASONS) {
      const view = {
        ...VIEW,
        statistics: null,
        statisticsUnavailable: { reason, message: 'Run at least 2 repetitions for a verdict.' },
      };
      expect(ComparisonViewSchema.parse(view)).toEqual(view);
    }
    const unknown = {
      ...VIEW,
      statistics: null,
      statisticsUnavailable: { reason: 'too_few_tasks', message: 'x' },
    };
    expect(issuePaths(ComparisonViewSchema.safeParse(unknown))).toEqual([
      'statisticsUnavailable.reason',
    ]);
  });

  it('sets statisticsUnavailable exactly when there are no statistics', () => {
    const neither = { ...VIEW, statistics: null };
    expect(issuePaths(ComparisonViewSchema.safeParse(neither))).toEqual(['statisticsUnavailable']);
    const both = {
      ...VIEW,
      statisticsUnavailable: { reason: 'not_enough_runs', message: 'x' },
    };
    expect(issuePaths(ComparisonViewSchema.safeParse(both))).toEqual(['statisticsUnavailable']);
  });

  it('refuses rates, deltas and counts out of range', () => {
    const bad: [Partial<ComparisonView>, string][] = [
      [{ passRates: { baseline: 1.2, candidate: 0.85 } }, 'passRates.baseline'],
      [{ statistics: { ...VIEW.statistics!, lo: -1.5 } }, 'statistics.lo'],
      [{ statistics: { ...VIEW.statistics!, confidence: 1 } }, 'statistics.confidence'],
      [{ filterCounts: { all: 12, improved: 8, regressed: 0 } as never }, 'filterCounts.unchanged'],
      [{ rows: [{ ...VIEW.rows[0]!, change: 'better' as 'improved' }] }, 'rows.0.change'],
      [{ progress: { scored: -1, total: 120 } }, 'progress.scored'],
    ];
    for (const [change, path] of bad) {
      expect(issuePaths(ComparisonViewSchema.safeParse({ ...VIEW, ...change }))).toEqual([path]);
    }
  });
});

describe('SensitivityViewSchema', () => {
  it('carries the interval and verdict over the kept runs', () => {
    expect(SensitivityViewSchema.parse(SENSITIVITY)).toEqual(SENSITIVITY);
    // Kept runs that fail the 2-runs gate: no interval, not computable, so the verdict changes.
    const gated = {
      ...SENSITIVITY,
      lo: null,
      hi: null,
      verdict: 'not_computable',
      verdictChanges: true,
    };
    expect(SensitivityViewSchema.parse(gated)).toEqual(gated);
  });

  it('refuses a missing interval or verdict and bounds out of range', () => {
    const { lo: _, ...noLo } = SENSITIVITY;
    const { verdict: __, ...noVerdict } = SENSITIVITY;
    expect(issuePaths(SensitivityViewSchema.safeParse(noLo))).toEqual(['lo']);
    expect(issuePaths(SensitivityViewSchema.safeParse(noVerdict))).toEqual(['verdict']);
    expect(issuePaths(SensitivityViewSchema.safeParse({ ...SENSITIVITY, hi: 1.01 }))).toEqual([
      'hi',
    ]);
  });
});

describe('the limit category (Phase 3 question 8)', () => {
  it('is a category of its own, before the catch-all', () => {
    expect(EXECUTION_ERROR_CATEGORIES).toEqual([
      'provider',
      'timeout',
      'setup',
      'worker_lost',
      'limit',
      'other',
    ]);
    const row = { ...VIEW.secondary[0]!, executionErrorCategories: ['limit', 'other'] };
    expect(SecondaryMetricsRowSchema.parse(row)).toEqual(row);
  });
});

describe('VerdictEntrySchema', () => {
  const ENTRY: VerdictEntry = {
    at: '2026-10-22T10:51:20.000Z',
    cause: 'initial',
    candidate_version_id: 'cfgv_with-skill',
    key: 'primary',
    delta: 0.217,
    lo: 0.117,
    hi: 0.333,
    verdict: 'better',
    reason: null,
    note: null,
    results_revision: 141,
    pass_rates: { baseline: 0.633, candidate: 0.85 },
    pass_counts: { baseline: { passed: 38, counted: 60 }, candidate: { passed: 51, counted: 60 } },
    task_counts: { improved: 8, regressed: 0, unchanged: 4 },
    resamples: 10_000,
    confidence: 0.95,
  };

  it('keeps what a verdict was computed from', () => {
    expect(VerdictEntrySchema.parse(ENTRY)).toEqual(ENTRY);
    const retried = { ...ENTRY, at: '2026-10-23T14:21:16.000Z', cause: 'retry', note: '1 retry' };
    expect(VerdictEntrySchema.parse(retried)).toEqual(retried);
    const single: VerdictEntry = {
      ...ENTRY,
      delta: null,
      lo: null,
      hi: null,
      verdict: 'not_computable',
      reason: 'single_repetition',
    };
    expect(VerdictEntrySchema.parse(single)).toEqual(single);
  });

  it('still reads an entry with only the fields Phase 1 declared', () => {
    const minimal = {
      at: ENTRY.at,
      cause: 'rescore',
      candidate_version_id: ENTRY.candidate_version_id,
      key: 'answer',
      delta: 0.1,
      lo: -0.05,
      hi: 0.2,
      verdict: 'inconclusive',
      reason: null,
    };
    expect(VerdictEntrySchema.parse(minimal)).toEqual(minimal);
  });

  it('sets the reason exactly when not computable, and refuses unknown values', () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ verdict: 'not_computable' }, 'reason'],
      [{ reason: 'nothing_scored' }, 'reason'],
      [{ verdict: 'not_computable', reason: 'too_few' }, 'reason'],
      [{ verdict: 'provisional' }, 'verdict'],
      [{ cause: 'user_retry' }, 'cause'],
      [{ at: '2026-10-22T10:51:20' }, 'at'],
      [{ results_revision: -1 }, 'results_revision'],
      [{ pass_rates: { baseline: 1.5, candidate: 0.85 } }, 'pass_rates.baseline'],
      [{ task_counts: { improved: 8, regressed: 0 } }, 'task_counts.unchanged'],
      [{ confidence: 1 }, 'confidence'],
    ];
    for (const [change, path] of bad) {
      expect(issuePaths(VerdictEntrySchema.safeParse({ ...ENTRY, ...change })), path).toEqual([
        path,
      ]);
    }
  });
});
