/**
 * Comparison fixtures (GET /experiments/:id/comparison): the task grid of one
 * candidate against the baseline, the statistics panel, secondary metrics and
 * the sensitivity figure, all derived from the experiment matrices.
 *
 * Statistics are the bootstrap results the design shows (Δ +0.217, 95%
 * interval [+0.117, +0.333] for Skill vs no skill); the observed Δ and pass
 * rates are computed from the runs and agree with them.
 *
 * Scenarios handled here (see scenarios.ts): through the matrices, notably
 * nothing-scored, single-rep and multi-candidate.
 */
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
  type ExperimentSeed,
  passRate,
  type RunSeed,
  runsOf,
  selectedKeyStatus,
} from './experiments';
import { CONFIG_VERSIONS } from './configurations';
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

const EXECUTION_ERROR_COMMENTS: Record<string, string> = {
  timeout: 'execution_error · timeout: no final response within 300 s',
  setup: 'execution_error · setup: invoice-db failed to start',
  provider: 'execution_error · provider: Nous Portal login lapsed during the run',
  worker_lost: 'execution_error · worker_lost: the worker stopped heartbeating',
  other: 'execution_error · other: the run passed the 2 GB disk limit',
};

/** The tooltip comment of a run: its primary score comment or its execution error. */
export function runComment(run: RunSeed): string | null {
  if (run.status === 'execution_error') {
    return EXECUTION_ERROR_COMMENTS[run.category ?? 'other'] ?? null;
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

/** Pass rate of the selected key over counted runs (scored + execution_error). */
function keyRate(seed: ExperimentSeed, runs: RunSeed[], key: string) {
  const counted = runs.filter((r) => r.status === 'scored' || r.status === 'execution_error');
  const passed = counted.filter((r) => selectedKeyStatus(seed, r, key) === 'passed').length;
  return {
    passed,
    counted: counted.length,
    rate: counted.length ? passed / counted.length : null,
  };
}

function secondaryRows(
  seed: ExperimentSeed,
  runs: RunSeed[],
  configs: ConfigName[],
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
        ungradable: a.ungradable,
      },
    ];
  });
}

function sensitivityOf(
  seed: ExperimentSeed,
  runs: RunSeed[],
  candidate: ConfigName,
  observedDelta: number | null,
): SensitivityView | null {
  const side = (config: ConfigName) => {
    const mine = runs.filter((r) => r.config === config);
    const executionErrors = mine.filter((r) => r.status === 'execution_error').length;
    const ungradable = mine.filter((r) => r.primaryStatus === 'ungradable').length;
    const error = mine.filter((r) => r.primaryStatus === 'error').length;
    const kept = mine.filter(
      (r) =>
        r.status === 'scored' && r.primaryStatus !== 'ungradable' && r.primaryStatus !== 'error',
    );
    const passed = kept.filter((r) => r.primaryStatus === 'passed').length;
    return {
      excluded: { executionErrors, ungradable, error },
      rate: {
        passed,
        counted: kept.length,
        rate: kept.length ? round(passed / kept.length, 3) : null,
      },
    };
  };
  const b = side(seed.baseline);
  const c = side(candidate);
  const excludedAny =
    b.excluded.executionErrors +
    b.excluded.ungradable +
    b.excluded.error +
    c.excluded.executionErrors +
    c.excluded.ungradable +
    c.excluded.error;
  if (!excludedAny) return null;
  const delta =
    b.rate.rate !== null && c.rate.rate !== null ? round(c.rate.rate - b.rate.rate, 3) : null;
  return {
    excludedBaseline: b.excluded,
    excludedCandidate: c.excluded,
    baseline: b.rate,
    candidate: c.rate,
    delta,
    verdictChanges:
      delta !== null && observedDelta !== null && Math.sign(delta) !== Math.sign(observedDelta),
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
  const provisional = seed.status === 'running' || seed.status === 'paused';

  const allRows: ComparisonRow[] = TASK_KEYS.map((task) => {
    const mine = (config: ConfigName) =>
      runs
        .filter((r) => r.taskKey === task && r.config === config)
        .sort((a, b) => a.repetition - b.repetition);
    const b = mine(seed.baseline);
    const c = mine(candidate);
    const rb = keyRate(seed, b, key);
    const rc = keyRate(seed, c, key);
    const delta =
      multiRep && rb.rate !== null && rc.rate !== null ? round(rc.rate - rb.rate, 2) : null;
    return {
      taskKey: task,
      taskVersion: 1,
      baseline: b.map((r) => cellOf(seed, r, key)),
      candidate: c.map((r) => cellOf(seed, r, key)),
      passBaseline: rb.rate === null ? null : round(rb.rate, 2),
      passCandidate: rc.rate === null ? null : round(rc.rate, 2),
      delta,
      change:
        delta === null ? null : delta > 0 ? 'improved' : delta < 0 ? 'regressed' : 'unchanged',
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

  const base = passRate(runs.filter((r) => r.config === seed.baseline));
  const cand = passRate(runs.filter((r) => r.config === candidate));
  const perTask = allRows.filter((r) => r.passBaseline !== null && r.passCandidate !== null);
  const observed = perTask.length
    ? round(
        perTask.reduce((a, r) => {
          const rb = keyRate(
            seed,
            runs.filter((x) => x.taskKey === r.taskKey && x.config === seed.baseline),
            key,
          );
          const rc = keyRate(
            seed,
            runs.filter((x) => x.taskKey === r.taskKey && x.config === candidate),
            key,
          );
          return a + ((rc.rate ?? 0) - (rb.rate ?? 0));
        }, 0) / perTask.length,
        3,
      )
    : null;

  const total = runs.length;
  let statistics: ComparisonView['statistics'] = null;
  let statisticsUnavailable: ComparisonView['statisticsUnavailable'] = null;
  const enough = TASK_KEYS.every((task) =>
    [seed.baseline, candidate].every(
      (config) =>
        runs.filter(
          (r) =>
            r.taskKey === task &&
            r.config === config &&
            (r.status === 'scored' || r.status === 'execution_error'),
        ).length >= 2,
    ),
  );
  if (!multiRep) {
    statisticsUnavailable = {
      reason: 'single_repetition',
      message: `No interval with 1 repetition. Pass rates: ${seed.baseline} ${base.rate?.toFixed(2) ?? '—'}, ${candidate} ${cand.rate?.toFixed(2) ?? '—'} on ${TASK_KEYS.length} tasks. Run at least 2 repetitions for a verdict.`,
    };
  } else if (!counts.scored) {
    statisticsUnavailable = {
      reason: 'nothing_scored',
      message: `0 of ${total} runs scored. Rows fill in as runs are scored; the statistics panel appears once every task has at least 2 scored repetitions per configuration.`,
    };
  } else if (!enough) {
    statisticsUnavailable = {
      reason: 'not_enough_runs',
      message:
        'The statistics panel appears once every task has at least 2 scored repetitions per configuration.',
    };
  } else {
    const stats = seed.stats[candidate];
    const delta = key === 'primary' && stats ? stats.delta : (observed ?? 0);
    const lo = key === 'primary' && stats ? stats.lo : round(delta - 0.11, 3);
    const hi = key === 'primary' && stats ? stats.hi : round(delta + 0.11, 3);
    statistics = {
      observedDelta: delta,
      lo,
      hi,
      resamples: 10000,
      confidence: 0.95,
      verdict: provisional ? 'provisional' : lo > 0 ? 'better' : hi < 0 ? 'worse' : 'inconclusive',
      provisional,
    };
  }

  const secondary = secondaryRows(seed, runs, [seed.baseline, candidate]);
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
      verdict:
        seed.candidateChips[c] ??
        (provisional
          ? 'provisional'
          : !multiRep
            ? 'not_computable'
            : (() => {
                const s = seed.stats[c];
                if (!s) return 'not_computable';
                return s.lo > 0 ? 'better' : s.hi < 0 ? 'worse' : 'inconclusive';
              })()),
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
    sensitivity:
      multiRep && counts.scored
        ? sensitivityOf(seed, runs, candidate, statistics?.observedDelta ?? observed)
        : null,
    progress: { scored: counts.scored, total },
  };
}
