/**
 * The verdicts the experiment views show (plan 10.3, UI_FLOWS 14.2): the
 * Overview's VerdictCards (ExperimentDetail.verdicts), the list's verdict
 * chips (ExperimentListRow.verdicts) and the live `experiment` event's.
 *
 * Once an experiment has completed, a candidate's verdict is its last
 * verdict history entry, and the entries before it are the card's
 * "Updated … · previously …". While it runs, the figures so far, computed
 * like the comparison's and marked `provisional`; a verdict that cannot be
 * computed whatever else runs (one repetition, nothing scored) says so at
 * once. A completed experiment whose history lacks a candidate (completed
 * before verdict entries were recorded) shows that candidate's figures as
 * they stand, as final.
 *
 * Numbers are rounded as the comparison rounds them: three decimals.
 */
import type {
  ExperimentConfigRef,
  ExperimentListVerdict,
  ExperimentStatus,
  VerdictEntry,
  VerdictHistoryEntry,
  VerdictState,
  VerdictSummary,
} from '@hermes-evals/shared';
import {
  DEFAULT_CONFIDENCE,
  DEFAULT_RESAMPLES,
  type StatsResult,
} from '../../statistics/contracts.js';
import { isCompleteEntry, lastEntries, type VerdictFigures } from '../comparison/verdicts.js';
import type { ConfigFacts } from './facts.js';
import { round3 } from './numbers.js';

const nullable3 = (x: number | null | undefined): number | null =>
  x === null || x === undefined ? null : Math.min(1, Math.max(-1, round3(x)));

const historyEntry = (entry: VerdictEntry): VerdictHistoryEntry => ({
  at: entry.at,
  cause: entry.cause,
  note: entry.note ?? null,
  delta: nullable3(entry.delta),
  lo: nullable3(entry.lo),
  hi: nullable3(entry.hi),
  verdict: entry.verdict,
});

/** The candidate's entries, oldest first. */
const historyOf = (history: readonly VerdictEntry[], candidateVersionId: string) =>
  history.filter((e) => e.candidate_version_id === candidateVersionId).map(historyEntry);

/** True when a completed experiment's history lacks a full entry for some candidate. */
export function needsFigures(e: {
  status: ExperimentStatus;
  candidateVersionIds: readonly string[];
  verdictHistory: readonly VerdictEntry[];
}): boolean {
  if (e.status !== 'completed') return false;
  const last = lastEntries(e.verdictHistory);
  return e.candidateVersionIds.some((id) => {
    const entry = last.get(id);
    return entry === undefined || !isCompleteEntry(entry);
  });
}

interface SummaryContext {
  status: ExperimentStatus;
  baseline: ExperimentConfigRef;
  history: readonly VerdictEntry[];
}

function summaryOfEntry(
  ctx: SummaryContext,
  candidate: ExperimentConfigRef,
  entry: VerdictEntry,
): VerdictSummary | null {
  if (!isCompleteEntry(entry)) return null;
  return {
    baseline: ctx.baseline,
    candidate,
    verdict: entry.verdict,
    scoreKey: entry.key,
    delta: nullable3(entry.delta),
    lo: nullable3(entry.lo),
    hi: nullable3(entry.hi),
    passRates: {
      baseline: nullable3(entry.pass_rates.baseline),
      candidate: nullable3(entry.pass_rates.candidate),
    },
    passCounts: entry.pass_counts,
    taskCounts: entry.task_counts,
    method: { name: 'paired_bootstrap', resamples: entry.resamples, confidence: entry.confidence },
    reason: entry.reason,
    history: historyOf(ctx.history, candidate.versionId),
  };
}

/**
 * A summary from statistics computed now: final for a completed experiment
 * with no entry, else provisional (a running, paused or failed one, which
 * Retry failed runs can resume). One repetition, fewer than 3 tasks, or
 * nothing scored yet, is not computable at once, as the design's card says;
 * too few runs so far is provisional, since the runs still to come may
 * fill the gate.
 */
function summaryOfStats(
  ctx: SummaryContext,
  candidate: ExperimentConfigRef,
  stats: StatsResult,
): VerdictSummary {
  const final = ctx.status === 'completed';
  let verdict: VerdictState;
  if (stats.computable) {
    verdict = final && stats.verdict !== 'provisional' ? stats.verdict : 'provisional';
  } else {
    verdict = final || stats.reason !== 'not_enough_runs' ? 'not_computable' : 'provisional';
  }
  return {
    baseline: ctx.baseline,
    candidate,
    verdict,
    scoreKey: 'primary',
    delta:
      !stats.computable && stats.reason === 'single_repetition'
        ? null
        : nullable3(stats.observedDelta),
    lo: stats.computable ? nullable3(stats.lo) : null,
    hi: stats.computable ? nullable3(stats.hi) : null,
    passRates: {
      baseline: nullable3(stats.baseline.rate),
      candidate: nullable3(stats.candidate.rate),
    },
    passCounts: {
      baseline: { passed: stats.baseline.passed, counted: stats.baseline.counted },
      candidate: { passed: stats.candidate.passed, counted: stats.candidate.counted },
    },
    taskCounts: stats.taskCounts,
    method: {
      name: 'paired_bootstrap',
      resamples: stats.computable ? stats.resamples : DEFAULT_RESAMPLES,
      confidence: stats.computable ? stats.confidence : DEFAULT_CONFIDENCE,
    },
    reason: verdict === 'not_computable' && !stats.computable ? stats.reason : null,
    history: historyOf(ctx.history, candidate.versionId),
  };
}

export interface VerdictsInput {
  status: ExperimentStatus;
  verdictHistory: readonly VerdictEntry[];
  /** The baseline, then the candidates (views/snapshot.ts experimentConfigs). */
  configs: readonly ConfigFacts[];
  /** The figures at the current results; needed unless every candidate has a completed entry. */
  figures: VerdictFigures | null;
}

/** ExperimentDetail.verdicts: one per candidate, in candidate order. */
export function verdictSummaries(input: VerdictsInput): VerdictSummary[] {
  const [baseline, ...candidates] = input.configs.map((c) => c.ref);
  if (!baseline) return [];
  const ctx: SummaryContext = { status: input.status, baseline, history: input.verdictHistory };
  const last = lastEntries(input.verdictHistory);
  return candidates.flatMap((candidate) => {
    const entry = input.status === 'completed' ? last.get(candidate.versionId) : undefined;
    const recorded = entry ? summaryOfEntry(ctx, candidate, entry) : null;
    if (recorded) return [recorded];
    const stats = input.figures?.byCandidate.get(candidate.versionId);
    return stats ? [summaryOfStats(ctx, candidate, stats)] : [];
  });
}

/**
 * ExperimentListRow.verdicts and the live event's: each candidate's final
 * verdict once completed, else none.
 */
export function listVerdicts(input: VerdictsInput): ExperimentListVerdict[] {
  if (input.status !== 'completed') return [];
  return verdictSummaries(input).map((s) => ({
    candidate: s.candidate.name,
    candidateVersionId: s.candidate.versionId,
    verdict: s.verdict,
    delta: s.delta,
    lo: s.lo,
    hi: s.hi,
    reason: s.reason,
  }));
}

/** When the newest verdict entry was appended; null before the first. */
export const verdictUpdatedAt = (history: readonly VerdictEntry[]): string | null =>
  history.at(-1)?.at ?? null;
