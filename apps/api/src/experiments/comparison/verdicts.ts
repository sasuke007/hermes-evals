/**
 * Each candidate's verdict on the primary key (plan 10.2 and 7.4): the
 * figures the experiment views show while an experiment runs, the chips of
 * the comparison's candidate select, and the verdict entries reconcile
 * appends to the history once it settles. One rule everywhere: the same
 * results, the same seed (the experiment id's), the same interval.
 */
import {
  type ExperimentStatus,
  type VerdictCause,
  type VerdictEntry,
  type VerdictState,
} from '@hermes-evals/shared';
import { computeComparisonStats, seedFromExperimentId } from '../../statistics/compute.js';
import {
  DEFAULT_CONFIDENCE,
  DEFAULT_RESAMPLES,
  type StatsResult,
} from '../../statistics/contracts.js';
import type { AppDb } from '../../database/types.js';
import { comparisonInputsOf, isProvisional } from './inputs.js';
import { READ_ONLY_SNAPSHOT, loadExperimentResults, type ExperimentResults } from './results.js';

/** Each candidate's statistics on the primary key, from one read of the results. */
export interface VerdictFigures {
  resultsRevision: number;
  status: ExperimentStatus;
  /** By candidate version id, in candidate order. */
  byCandidate: Map<string, StatsResult>;
}

/**
 * The statistics of every candidate on the primary key. `final` computes
 * them as a settled experiment's (never provisional), as reconcile does
 * while it completes one.
 */
export function verdictFiguresOf(
  results: ExperimentResults,
  options: { final?: boolean } = {},
): VerdictFigures {
  const seed = seedFromExperimentId(results.id);
  const byCandidate = new Map<string, StatsResult>();
  for (const candidate of results.candidateVersionIds) {
    const inputs = comparisonInputsOf(results, candidate, { kind: 'primary' });
    const input = options.final ? { ...inputs.stats, provisional: false } : inputs.stats;
    byCandidate.set(candidate, computeComparisonStats(input, { seed }));
  }
  return { resultsRevision: results.resultsRevision, status: results.status, byCandidate };
}

/**
 * Every candidate's figures on the primary key at the experiment's current
 * results, uncached, in their own read-only snapshot; null for an unknown
 * experiment. For callers without the ComparisonService and its cache (the
 * configuration views).
 */
export function readVerdictFigures(
  db: AppDb,
  experimentId: string,
): Promise<VerdictFigures | null> {
  return db.transaction(async (tx) => {
    const results = await loadExperimentResults(tx, experimentId);
    return results && verdictFiguresOf(results);
  }, READ_ONLY_SNAPSHOT);
}

/**
 * A candidate's chip: provisional while the experiment runs, is paused or
 * has failed, else its verdict or not computable.
 */
export function chipVerdict(stats: StatsResult, status: ExperimentStatus): VerdictState {
  if (isProvisional(status)) return 'provisional';
  return stats.computable ? stats.verdict : 'not_computable';
}

/** What a verdict entry records besides its numbers. */
export interface VerdictEntryMeta {
  at: string;
  cause: VerdictCause;
  note: string | null;
  candidateVersionId: string;
  resultsRevision: number;
}

/**
 * The entry reconcile appends for one candidate, from statistics computed
 * as final. The observed difference is kept when the gate fails, except
 * with one repetition, where there is no Δ (as the comparison shows it);
 * the interval only exists when computable.
 */
export function verdictEntryOf(stats: StatsResult, meta: VerdictEntryMeta): VerdictEntry {
  const verdict = stats.computable ? stats.verdict : 'not_computable';
  if (verdict === 'provisional') {
    throw new Error('a verdict entry is computed from final statistics, never provisional ones');
  }
  return {
    at: meta.at,
    cause: meta.cause,
    candidate_version_id: meta.candidateVersionId,
    key: 'primary',
    delta: !stats.computable && stats.reason === 'single_repetition' ? null : stats.observedDelta,
    lo: stats.computable ? stats.lo : null,
    hi: stats.computable ? stats.hi : null,
    verdict,
    reason: stats.computable ? null : stats.reason,
    note: meta.note,
    results_revision: meta.resultsRevision,
    pass_rates: { baseline: stats.baseline.rate, candidate: stats.candidate.rate },
    pass_counts: {
      baseline: { passed: stats.baseline.passed, counted: stats.baseline.counted },
      candidate: { passed: stats.candidate.passed, counted: stats.candidate.counted },
    },
    task_counts: stats.taskCounts,
    resamples: stats.computable ? stats.resamples : DEFAULT_RESAMPLES,
    confidence: stats.computable ? stats.confidence : DEFAULT_CONFIDENCE,
  };
}

/** The last entry of each candidate in a history (append order), by candidate version id. */
export function lastEntries(history: readonly VerdictEntry[]): Map<string, VerdictEntry> {
  const out = new Map<string, VerdictEntry>();
  for (const entry of history) out.set(entry.candidate_version_id, entry);
  return out;
}

/** An entry carries every figure the views read back (all Phase 4 entries do). */
export function isCompleteEntry(
  entry: VerdictEntry,
): entry is VerdictEntry &
  Required<
    Pick<VerdictEntry, 'pass_rates' | 'pass_counts' | 'task_counts' | 'resamples' | 'confidence'>
  > {
  return (
    entry.pass_rates !== undefined &&
    entry.pass_counts !== undefined &&
    entry.task_counts !== undefined &&
    entry.resamples !== undefined &&
    entry.confidence !== undefined
  );
}
