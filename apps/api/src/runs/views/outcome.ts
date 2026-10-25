/**
 * The inspector's Outcome section (UI_FLOWS 18): the score rows of the run's
 * current evaluation with their expected and observed values, the notice
 * above them when a key was ungradable or its scorer broke, and the error
 * banner that replaces them when execution failed (plan 8.4).
 */
import type {
  ExecutionErrorView,
  JsonValue,
  OutcomeNotice,
  ScoreRowView,
  ScoreEvidence,
  VerificationEntry,
} from '@hermes-evals/shared';
import { DEFAULT_LIMITS } from '../../sandbox/trial-spec.js';
import { DEFAULT_DISK_LIMIT } from '../../sandbox/trial-files.js';
import { verificationSentence } from '../../suites/views/sentences.js';
import { formatNumber } from '../../suites/views/format.js';
import type { AttemptRecord, ScoreRecord, WorkerRecord } from './rows.js';

/** Characters of an expected or observed summary before it is cut and the detail shows it all. */
const VALUE_SUMMARY_MAX = 48;
/** List items an expected or observed detail shows, one per line. */
const VALUE_DETAIL_ITEMS = 50;
/** Lines of stderr the banner shows (attempts.stderr_tail keeps 40). */
export const STDERR_TAIL_LINES = 40;

/** JSON on one line, spaced as people write it: {"duplicates": [["INV-0988", "INV-1131"]]}. */
export function inlineJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${inlineJson(v)}`)
      .join(', ')}}`;
  }
  return typeof value === 'number' ? formatNumber(value) : JSON.stringify(value);
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** An expected or observed value as a short summary and, when that does not say it all, the detail. */
export function valueSummary(
  value: JsonValue | null | undefined,
): { summary: string; detail: string | null } | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const shown = value.slice(0, VALUE_DETAIL_ITEMS).map(inlineJson);
    if (value.length > VALUE_DETAIL_ITEMS)
      shown.push(`… ${value.length - VALUE_DETAIL_ITEMS} more`);
    return {
      summary: plural(value.length, 'item'),
      detail: value.length ? shown.join('\n') : '[]',
    };
  }
  const text = inlineJson(value);
  if (text.length <= VALUE_SUMMARY_MAX) return { summary: text, detail: null };
  const summary =
    typeof value === 'object'
      ? plural(Object.keys(value).length, 'key')
      : `${text.slice(0, VALUE_SUMMARY_MAX - 1)}…`;
  return { summary, detail: text };
}

/** VerificationSentence in its compact form: the pass threshold is left to the score itself. */
export function compactSentence(entry: VerificationEntry, answerPath: string | undefined): string {
  return verificationSentence(entry, answerPath).replace(/, pass at [\d.]+$/, '');
}

const evidenceView = (evidence: ScoreEvidence): ScoreRowView['evidence'] => ({
  eventSeqs: (evidence.event_seqs ?? []).filter((n) => Number.isSafeInteger(n) && n >= 1),
  artifactIds: [...(evidence.artifact_ids ?? [])],
});

/** One score row, with the sentence of the task's entry for its key. */
export function scoreRowView(
  score: ScoreRecord,
  entry: VerificationEntry | undefined,
  answerPath: string | undefined,
): ScoreRowView {
  return {
    key: score.key,
    type: score.type,
    primary: score.isPrimary,
    sentence: entry ? compactSentence(entry, answerPath) : score.type,
    status: score.status,
    score: score.score,
    expected: valueSummary(score.expected),
    observed: valueSummary(score.observed),
    comment: score.comment,
    error:
      score.status === 'error'
        ? (score.evidence.error ?? { message: score.comment, detail: null })
        : null,
    evidence: evidenceView(score.evidence),
  };
}

/** The current evaluation's scores in the task's verification order. */
export function scoreRows(
  scores: readonly ScoreRecord[],
  verification: readonly VerificationEntry[],
  answerPath: string | undefined,
): ScoreRowView[] {
  const order = new Map(verification.map((v, i) => [v.key, i]));
  return [...scores]
    .sort(
      (a, b) =>
        (order.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.key) ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key),
    )
    .map((s) =>
      scoreRowView(
        s,
        verification.find((v) => v.key === s.key),
        answerPath,
      ),
    );
}

/**
 * The banner above the score rows: an ungradable key first (it explains the
 * answer), else a key whose scorer broke; the primary key's when it is one.
 */
export function outcomeNotice(rows: readonly ScoreRowView[]): OutcomeNotice | null {
  const pick = (status: ScoreRowView['status']) =>
    rows.find((r) => r.status === status && r.primary) ?? rows.find((r) => r.status === status);
  const ungradable = pick('ungradable');
  if (ungradable) {
    return {
      kind: 'ungradable',
      title: ungradable.comment || 'nothing could be extracted from the final response',
      detail: `Key ${ungradable.key} had nothing to grade. See Final response for the whole text the agent returned.`,
      request: null,
      key: ungradable.key,
    };
  }
  const error = pick('error');
  if (error) {
    return {
      kind: 'error',
      title: `Scorer error: ${error.error?.message ?? error.comment}`,
      detail: `Key ${error.key} · the agent's output is stored · Re-score runs only the scorers`,
      request: error.error?.detail ?? null,
      key: error.key,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Execution errors (plan 8.4)
// ---------------------------------------------------------------------------

const GIB = 1024 ** 3;

/** The last lines of a stderr tail; a trailing newline adds no line. */
export function stderrLines(tail: string | null): string[] {
  if (!tail) return [];
  const lines = tail.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-STDERR_TAIL_LINES);
}

const clipMessage = (text: string) => (text.length > 300 ? `${text.slice(0, 299)}…` : text);

export interface ExecutionErrorInput {
  attempt: Pick<
    AttemptRecord,
    'number' | 'errorCategory' | 'errorMessage' | 'exitCode' | 'durationMs' | 'stderrTail'
  >;
  /** The run's time budget after the experiment's override. */
  budgetS: number;
  /** The worker that ran the attempt, for worker_lost. */
  worker: Pick<WorkerRecord, 'lastHeartbeatAt'> | null;
  /** Lines in the full stderr.log, when the worker reported them. */
  stderrTotalLines: number | null;
}

/** The ErrorBanner of an attempt that ended in execution_error, worded per category. */
export function executionErrorView(input: ExecutionErrorInput): ExecutionErrorView {
  const { attempt, budgetS } = input;
  const category = attempt.errorCategory ?? 'other';
  const message = attempt.errorMessage ? clipMessage(attempt.errorMessage) : null;
  const ranS = attempt.durationMs === null ? null : Math.round(attempt.durationMs / 1000);
  const lines = stderrLines(attempt.stderrTail);
  const base = {
    category,
    stderrTail: { lines, totalLines: Math.max(lines.length, input.stderrTotalLines ?? 0) },
    exitCode: attempt.exitCode,
  };
  switch (category) {
    case 'timeout':
      return {
        ...base,
        reason: `No final response within the ${budgetS} s time budget.`,
        meta: ranS === null ? null : `stopped at ${ranS} s`,
        explanation: [
          message,
          'The worker stopped the container at the deadline (the budget plus a grace period): SIGTERM, then SIGKILL after 10 s. A timeout is retried once automatically; one that stops at the same step again will likely time out on a further retry.',
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'provider':
      return {
        ...base,
        reason: message ?? 'The model provider failed during the run.',
        meta: ranS === null ? null : `attempt ${attempt.number} stopped at ${ranS} s`,
        explanation:
          'The provider refused or failed a model call (authentication, rate limit, server error or connection). A provider error is retried once automatically; if it repeats, check Model access on the System page.',
      };
    case 'setup':
      return {
        ...base,
        reason: message ?? 'The trial could not start.',
        meta: attempt.exitCode === null ? null : `exit ${attempt.exitCode}`,
        explanation:
          'The container failed to start, Hermes failed before it began, an MCP server failed to start, or Hermes asked for input (exit 3). Setup errors are not retried automatically: fix the cause, then Retry.',
      };
    case 'worker_lost':
      return {
        ...base,
        reason: 'The worker stopped heartbeating while this run was in flight.',
        meta: input.worker ? `last heartbeat ${input.worker.lastHeartbeatAt.toISOString()}` : null,
        explanation: [
          message,
          'Recovery confirmed the trial container was gone and ended the attempt. A lost run is retried by recovery up to 3 attempts; after that, Retry it once a worker is connected.',
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'other':
      return {
        ...base,
        reason: message ?? 'The run ended without a result.',
        meta: ranS === null ? null : `after ${ranS} s`,
        explanation: otherExplanation(message),
      };
  }
}

function otherExplanation(message: string | null): string {
  if (message && /disk/i.test(message)) {
    return `The disk cap is ${DEFAULT_DISK_LIMIT.maxBytes / GIB} GB and ${DEFAULT_DISK_LIMIT.maxEntries.toLocaleString('en-US')} files per run; the worker stops a trial that passes either.`;
  }
  if (message && /(out of memory|oom|memory)/i.test(message)) {
    return `The container passed its ${DEFAULT_LIMITS.memoryMiB / 1024} GB memory limit and was killed.`;
  }
  return 'This error is not retried automatically. The stderr tail and the timeline show where the run stopped.';
}
