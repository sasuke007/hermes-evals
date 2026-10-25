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

/** The mean over tasks of (candidate rate − baseline rate), tasks with a rate on both sides. */
function meanTaskDelta(
  rate: (task: string, config: ConfigName) => number | null,
  baseline: ConfigName,
  candidate: ConfigName,
): number | null {
  const deltas = TASK_KEYS.flatMap((task) => {
    const b = rate(task, baseline);
    const c = rate(task, candidate);
    return b === null || c === null ? [] : [c - b];
  });
  return deltas.length ? round(deltas.reduce((a, d) => a + d, 0) / deltas.length, 3) : null;
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
 * tasks of the kept runs' differences. The fixtures have no bootstrap, so
 * the kept runs' interval keeps the main interval's width around their own
 * Δ; without statistics the kept runs fail the gate too.
 */
function sensitivityOf(
  seed: ExperimentSeed,
  runs: RunSeed[],
  candidate: ConfigName,
  key: string,
  statistics: ComparisonView['statistics'],
): SensitivityView | null {
  const status = (r: RunSeed) => selectedKeyStatus(seed, r, key);
  const kept = (list: RunSeed[]) =>
    tally(
      seed,
      list.filter(
        (r) => r.status === 'scored' && status(r) !== 'ungradable' && status(r) !== 'error',
      ),
      key,
    );
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
  const delta = meanTaskDelta(
    (task, config) => kept(runs.filter((r) => r.taskKey === task && r.config === config)).rate,
    seed.baseline,
    candidate,
  );
  const half = statistics ? (statistics.hi - statistics.lo) / 2 : null;
  const bound = (x: number) => round(Math.min(1, Math.max(-1, x)), 3);
  const lo = delta !== null && half !== null ? bound(delta - half) : null;
  const hi = delta !== null && half !== null ? bound(delta + half) : null;
  const verdict: SensitivityView['verdict'] =
    lo === null || hi === null
      ? 'not_computable'
      : statistics?.provisional
        ? 'provisional'
        : lo > 0
          ? 'better'
          : hi < 0
            ? 'worse'
            : 'inconclusive';
  return {
    excludedBaseline: b.excluded,
    excludedCandidate: c.excluded,
    baseline: b.rate,
    candidate: c.rate,
    delta,
    lo,
    hi,
    verdict,
    verdictChanges: statistics !== null && verdict !== statistics.verdict,
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

  // Pooled over the counted runs of each side, graded by the selected key as the grid is.
  const ofSide = (config: ConfigName, task?: string) =>
    runs.filter((r) => r.config === config && (task === undefined || r.taskKey === task));
  const base = rate3(keyRate(seed, ofSide(seed.baseline), key));
  const cand = rate3(keyRate(seed, ofSide(candidate), key));
  const observed = meanTaskDelta(
    (task, config) => keyRate(seed, ofSide(config, task), key).rate,
    seed.baseline,
    candidate,
  );

  const total = runs.length;
  // nothing_scored: no run of the two configurations counts yet (an execution error counts).
  const pair = runs.filter((r) => r.config === seed.baseline || r.config === candidate);
  const nothingCounted = counted(pair).length === 0;
  let statistics: ComparisonView['statistics'] = null;
  let statisticsUnavailable: ComparisonView['statisticsUnavailable'] = null;
  const enough = TASK_KEYS.every((task) =>
    [seed.baseline, candidate].every((config) => counted(ofSide(config, task)).length >= 2),
  );
  if (!multiRep) {
    statisticsUnavailable = {
      reason: 'single_repetition',
      message: `No interval with 1 repetition. Pass rates: ${seed.baseline} ${base.rate?.toFixed(2) ?? '—'}, ${candidate} ${cand.rate?.toFixed(2) ?? '—'} on ${TASK_KEYS.length} tasks. Run at least 2 repetitions for a verdict.`,
    };
  } else if (nothingCounted) {
    statisticsUnavailable = {
      reason: 'nothing_scored',
      message: `0 of ${pair.length} runs scored. Rows fill in as runs are scored; the statistics panel appears once every task has at least 2 scored repetitions per configuration.`,
    };
  } else if (!enough) {
    statisticsUnavailable = {
      reason: 'not_enough_runs',
      message:
        'The statistics panel appears once every task has at least 2 scored repetitions per configuration.',
    };
  } else {
    // The design shows the primary key's interval. Under another key the
    // observed Δ is computed, but the interval is a stand-in (Δ ± 0.11): the
    // fixtures have no bootstrap, and the API's differs (Skill vs no skill
    // under any_failed: [+0.100, +0.350]).
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
      multiRep && !nothingCounted ? sensitivityOf(seed, runs, candidate, key, statistics) : null,
    progress: { scored: counts.scored, total },
  };
}
