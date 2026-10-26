/**
 * Comparison fixtures (GET /experiments/:id/comparison): the task grid of one
 * candidate against the baseline, the statistics panel, secondary metrics and
 * the sensitivity figure, all derived from the experiment matrices.
 *
 * The statistics are the API's (./statistics.ts): pass rates, per-task
 * differences and the observed Δ are computed from the runs, under the
 * selected key, and the 95% interval is the statistics module's for those
 * differences (Δ +0.217, [+0.117, +0.333] for Skill vs no skill, as the
 * design shows), for the figure without broken runs too.
 *
 * Scenarios handled here (see scenarios.ts): through the matrices, notably
 * nothing-scored, single-rep and multi-candidate.
 */
import type { ExecutionErrorCategory } from '@hermes-evals/shared';
import type { ConfigName } from './configurations';
import type {
  ComparisonFilter,
  ComparisonQuery,
  ComparisonRow,
  ComparisonView,
  RepetitionCell,
  SecondaryMetricsRow,
  SensitivityView,
} from '@/api/types/experiments';
import {
  aggregatesFor,
  configRef,
  countRuns,
  counted,
  type ExperimentSeed,
  type RunSeed,
  runsOf,
  selectedKeyStatus,
} from './experiments';
import { CONFIG_VERSIONS } from './configurations';
import {
  enoughRuns,
  gateOf,
  intervalOf,
  isProvisional,
  meanDelta,
  notComputableMessage,
  type TaskCounts,
  verdictOf,
} from './statistics';
import { round, TASK_KEYS } from './suites';

/** The primary score comment of each failed task, as the grid tooltips show it. */
export const FAILURE_COMMENTS: Record<string, string> = {
  overdue_list: 'expected 6 invoice ids, got 5; missed INV-1127 due 30 Sep',
  dup_invoices: 'expected 2 duplicate pairs, got 1; missed INV-0988 / INV-1131',
  vat_split: 'reduced-rate band off by €41.20',
  credit_notes: 'credit note CN-0331 not applied to INV-1088',
  currency_mix: 'total €38,912.40, expected €38,955.10; used the wrong USD rate',
  late_fees: 'fee for INV-1031 computed on gross, expected net',
  disputed: 'disputed INV-1119 included in the payable total',
  partial_pay: 'partial payment on INV-1066 counted twice',
  total_due: 'total €48,026.40, expected €48,213.65; disputed invoices left out',
  missing_po: 'expected "INV-1011, INV-1076, INV-1140", got "INV-1011, INV-1140"',
  per_vendor: 'Orbis Facilities missing from the per-vendor totals',
  summary_file: 'summary.csv has 4 rows; expected 5, one per vendor',
};

/** The comment the dup_invoices sample run carries (the inspector board's run). */
export const SAMPLE_RUN_COMMENT =
  'expected 2 duplicate pairs, got 0; agent compared invoice numbers only';

/** The tooltip line of each execution-error category: the web's label for it. */
export const EXECUTION_ERROR_COMMENTS: Record<ExecutionErrorCategory, string> = {
  timeout: 'execution_error · timeout: no final response within 300 s',
  setup: 'execution_error · setup: invoice-db failed to start',
  provider: 'execution_error · provider: Nous Portal login lapsed during the run',
  worker_lost: 'execution_error · worker_lost: the worker stopped heartbeating',
  limit: 'execution_error · limit: stopped at the 2,000,000-token cap per attempt',
  other: 'execution_error · other: the run passed the 2 GB disk limit',
};

/** The tooltip comment of a run: its primary score comment or its execution error. */
export function runComment(run: RunSeed): string | null {
  if (run.status === 'execution_error') {
    return EXECUTION_ERROR_COMMENTS[run.category ?? 'other'];
  }
  if (run.status !== 'scored') return null;
  if (run.primaryStatus === 'passed') return 'answer matched the reference';
  if (run.primaryStatus === 'ungradable') return 'no fenced JSON block found in final response';
  if (run.primaryStatus === 'error') return 'scorer error: llm_judge could not reach the provider';
  if (run.taskKey === 'dup_invoices' && run.config === 'baseline' && run.repetition === 3) {
    return SAMPLE_RUN_COMMENT;
  }
  return FAILURE_COMMENTS[run.taskKey] ?? null;
}

function cellOf(seed: ExperimentSeed, run: RunSeed, key: string): RepetitionCell {
  return {
    runId: run.id,
    repetition: run.repetition,
    runStatus: run.status,
    scoreStatus: selectedKeyStatus(seed, run, key),
    attempt: Math.max(run.attempts, 1),
    durationS: run.status === 'queued' || run.status === 'running' ? null : run.durationS,
    comment: runComment(run),
  };
}

/** Passed over `runs` by the selected key; the rate unrounded, null when there are none. */
function tally(seed: ExperimentSeed, runs: RunSeed[], key: string) {
  const passed = runs.filter((r) => selectedKeyStatus(seed, r, key) === 'passed').length;
  return { passed, counted: runs.length, rate: runs.length ? passed / runs.length : null };
}

/** Pass rate of the selected key over counted runs (scored + execution_error). */
const keyRate = (seed: ExperimentSeed, runs: RunSeed[], key: string) =>
  tally(seed, counted(runs), key);

const rate3 = <T extends { rate: number | null }>(t: T): T => ({
  ...t,
  rate: t.rate === null ? null : round(t.rate, 3),
});

/** A scored run whose selected key neither errored nor was ungradable: what the sensitivity figure keeps. */
const answered = (seed: ExperimentSeed, key: string) => (r: RunSeed) =>
  r.status === 'scored' &&
  selectedKeyStatus(seed, r, key) !== 'ungradable' &&
  selectedKeyStatus(seed, r, key) !== 'error';

/**
 * Each task's difference (candidate rate − baseline rate) over the runs
 * `pick` keeps of each side, unrounded and in task order, null where a side
 * has none; and how many runs each side kept.
 */
export function pairFigures(
  seed: ExperimentSeed,
  runs: RunSeed[],
  candidate: ConfigName,
  key: string,
  pick: (runs: RunSeed[]) => RunSeed[] = counted,
): { deltas: (number | null)[]; counts: TaskCounts[] } {
  const side = (config: ConfigName, task: string) =>
    pick(runs.filter((r) => r.config === config && r.taskKey === task));
  const deltas: (number | null)[] = [];
  const counts: TaskCounts[] = [];
  for (const taskKey of TASK_KEYS) {
    const b = tally(seed, side(seed.baseline, taskKey), key);
    const c = tally(seed, side(candidate, taskKey), key);
    deltas.push(b.rate === null || c.rate === null ? null : c.rate - b.rate);
    counts.push({ taskKey, baseline: b.counted, candidate: c.counted });
  }
  return { deltas, counts };
}

/** A candidate's chip: provisional while it runs, else its verdict on the primary key. */
export function chipVerdictOf(
  seed: ExperimentSeed,
  runs: RunSeed[],
  candidate: ConfigName,
): ComparisonView['candidates'][number]['verdict'] {
  if (isProvisional(seed.status)) return 'provisional';
  const { deltas, counts } = pairFigures(seed, runs, candidate, 'primary');
  if (gateOf(seed.repetitions, counts) !== null) return 'not_computable';
  const { lo, hi } = intervalOf(seed.id, deltas);
  return verdictOf(lo, hi, false);
}

/** The Overview's aggregates, with the ungradable count by the selected key, as the API counts it. */
function secondaryRows(
  seed: ExperimentSeed,
  runs: RunSeed[],
  configs: ConfigName[],
  key: string,
): SecondaryMetricsRow[] {
  const aggregates = aggregatesFor(seed, runs);
  return configs.flatMap((c) => {
    const a = aggregates.find((x) => x.configuration.name === c);
    if (!a) return [];
    return [
      {
        configuration: a.configuration,
        medianDurationS: a.medianDurationS,
        meanTokens: a.meanTokens,
        costUsd: a.costUsd,
        executionErrors: a.executionErrors,
        executionErrorCategories: a.executionErrorCategories,
        ungradable: runs.filter(
          (r) => r.config === c && selectedKeyStatus(seed, r, key) === 'ungradable',
        ).length,
      },
    ];
  });
}

/**
 * The figure without broken runs, graded by the selected key: execution
 * errors and runs whose selected key is `error` or `ungradable` are left
 * out, and Δ is the same difference as the observed one, the mean over
 * tasks of the kept runs' differences. Its interval is the module's for the
 * kept runs' differences, under the same gate (./statistics.ts).
 */
function sensitivityOf(
  seed: ExperimentSeed,
  runs: RunSeed[],
  candidate: ConfigName,
  key: string,
  statistics: ComparisonView['statistics'],
): SensitivityView | null {
  const status = (r: RunSeed) => selectedKeyStatus(seed, r, key);
  const keep = (list: RunSeed[]) => list.filter(answered(seed, key));
  const kept = (list: RunSeed[]) => tally(seed, keep(list), key);
  const side = (config: ConfigName) => {
    const mine = runs.filter((r) => r.config === config);
    return {
      excluded: {
        executionErrors: mine.filter((r) => r.status === 'execution_error').length,
        ungradable: mine.filter((r) => status(r) === 'ungradable').length,
        error: mine.filter((r) => status(r) === 'error').length,
      },
      rate: rate3(kept(mine)),
    };
  };
  const b = side(seed.baseline);
  const c = side(candidate);
  if (![b, c].some((s) => Object.values(s.excluded).some((n) => n > 0))) return null;
  const { deltas, counts } = pairFigures(seed, runs, candidate, key, keep);
  const interval = enoughRuns(counts) ? intervalOf(seed.id, deltas) : null;
  const verdict = interval
    ? verdictOf(interval.lo, interval.hi, isProvisional(seed.status))
    : 'not_computable';
  return {
    excludedBaseline: b.excluded,
    excludedCandidate: c.excluded,
    baseline: b.rate,
    candidate: c.rate,
    delta: meanDelta(deltas),
    lo: interval?.lo ?? null,
    hi: interval?.hi ?? null,
    verdict,
    verdictChanges: verdict !== (statistics?.verdict ?? 'not_computable'),
  };
}

function sortRows(rows: ComparisonRow[], withDelta: boolean): ComparisonRow[] {
  if (!withDelta) return rows;
  return [...rows].sort(
    (a, b) =>
      (b.delta ?? -9) - (a.delta ?? -9) ||
      (a.passBaseline ?? 0) - (b.passBaseline ?? 0) ||
      a.taskKey.localeCompare(b.taskKey),
  );
}

/** The comparison of one candidate against the baseline. */
export function comparisonFixture(
  seed: ExperimentSeed,
  query: ComparisonQuery = {},
): ComparisonView {
  const runs = runsOf(seed);
  const candidate =
    seed.candidates.find(
      (c) => CONFIG_VERSIONS[c].versionId === query.candidate || c === query.candidate,
    ) ??
    seed.candidates[0] ??
    seed.baseline;
  const key = query.key ?? 'primary';
  const filter: ComparisonFilter = query.filter ?? 'all';
  const multiRep = seed.repetitions > 1;
  const counts = countRuns(runs);
  const provisional = isProvisional(seed.status);

  const allRows: ComparisonRow[] = TASK_KEYS.map((task) => {
    const mine = (config: ConfigName) =>
      runs
        .filter((r) => r.taskKey === task && r.config === config)
        .sort((a, b) => a.repetition - b.repetition);
    const b = mine(seed.baseline);
    const c = mine(candidate);
    const rb = keyRate(seed, b, key);
    const rc = keyRate(seed, c, key);
    // The change follows the unrounded Δ, as the API's does.
    const exact = multiRep && rb.rate !== null && rc.rate !== null ? rc.rate - rb.rate : null;
    return {
      taskKey: task,
      taskVersion: 1,
      baseline: b.map((r) => cellOf(seed, r, key)),
      candidate: c.map((r) => cellOf(seed, r, key)),
      passBaseline: rb.rate === null ? null : round(rb.rate, 2),
      passCandidate: rc.rate === null ? null : round(rc.rate, 2),
      delta: exact === null ? null : round(exact, 2),
      change:
        exact === null ? null : exact > 0 ? 'improved' : exact < 0 ? 'regressed' : 'unchanged',
    };
  });

  const filterCounts: Record<ComparisonFilter, number> = {
    all: allRows.length,
    improved: allRows.filter((r) => r.change === 'improved').length,
    regressed: allRows.filter((r) => r.change === 'regressed').length,
    unchanged: allRows.filter((r) => r.change === 'unchanged').length,
  };
  const rows = sortRows(
    filter === 'all' ? allRows : allRows.filter((r) => r.change === filter),
    multiRep,
  );

  // Pooled over the counted runs of each side, graded by the selected key as the grid is.
  const ofSide = (config: ConfigName, task?: string) =>
    runs.filter((r) => r.config === config && (task === undefined || r.taskKey === task));
  const base = rate3(keyRate(seed, ofSide(seed.baseline), key));
  const cand = rate3(keyRate(seed, ofSide(candidate), key));

  // The statistics module's gate, sentences and interval (./statistics.ts).
  const pair = runs.filter((r) => r.config === seed.baseline || r.config === candidate);
  const { deltas, counts: taskCounts } = pairFigures(seed, runs, candidate, key);
  const reason = gateOf(seed.repetitions, taskCounts);
  let statistics: ComparisonView['statistics'] = null;
  let statisticsUnavailable: ComparisonView['statisticsUnavailable'] = null;
  if (reason !== null) {
    statisticsUnavailable = {
      reason,
      message: notComputableMessage(reason, {
        provisional,
        labels: { baseline: seed.baseline, candidate },
        rates: { baseline: base.rate, candidate: cand.rate },
        tasks: taskCounts,
        total: pair.length,
      }),
    };
  } else {
    const { lo, hi } = intervalOf(seed.id, deltas);
    statistics = {
      observedDelta: meanDelta(deltas) ?? 0,
      lo,
      hi,
      resamples: 10000,
      confidence: 0.95,
      verdict: verdictOf(lo, hi, provisional),
      provisional,
    };
  }

  const secondary = secondaryRows(seed, runs, [seed.baseline, candidate], key);
  const sb = secondary[0];
  const sc = secondary[1];
  const secondaryDifference =
    sb && sc
      ? {
          medianDurationS:
            sb.medianDurationS !== null && sc.medianDurationS !== null
              ? round(sc.medianDurationS - sb.medianDurationS, 1)
              : null,
          meanTokensPct:
            sb.meanTokens && sc.meanTokens !== null
              ? Math.round(((sc.meanTokens - sb.meanTokens) / sb.meanTokens) * 100)
              : null,
          costUsd:
            sb.costUsd !== null && sc.costUsd !== null ? round(sc.costUsd - sb.costUsd, 2) : null,
          executionErrors: sc.executionErrors - sb.executionErrors,
          ungradable: sc.ungradable - sb.ungradable,
        }
      : null;

  return {
    experimentId: seed.id,
    experimentStatus: seed.status,
    provisional,
    repetitions: seed.repetitions,
    baseline: configRef(seed, seed.baseline),
    candidate: configRef(seed, candidate),
    candidates: seed.candidates.map((c) => ({
      configuration: configRef(seed, c),
      // As the API answers: provisional while running (Phase 5 #20), whatever the board drew.
      verdict: chipVerdictOf(seed, runs, c),
    })),
    scoreKey: key,
    scoreKeyOptions: [
      { value: 'primary', label: 'Primary key per task' },
      { value: 'answer', label: `answer (all ${TASK_KEYS.length} tasks)` },
      { value: 'any_failed', label: 'Any key failed' },
    ],
    filter,
    filterCounts,
    rows,
    passRates: { baseline: base.rate, candidate: cand.rate },
    passCounts: {
      baseline: { passed: base.passed, counted: base.counted },
      candidate: { passed: cand.passed, counted: cand.counted },
    },
    statistics,
    statisticsUnavailable,
    secondary,
    secondaryDifference,
    // None beside single_repetition or nothing_scored: there is no main figure to set it beside.
    sensitivity:
      reason === 'single_repetition' || reason === 'nothing_scored'
        ? null
        : sensitivityOf(seed, runs, candidate, key, statistics),
    progress: { scored: counts.scored, total: runs.length },
  };
}
