/**
 * Whole stderr logs for the run inspector's "Full log" (GET /runs/:id/attempts/:n/stderr,
 * Phase 5 section 6.1). A run's log ends with the tail its error banner shows; the lines
 * before it are generated, as many as the banner's "of N lines" says. Scenarios:
 * stderr-long (the disputed timeout's log is 3.3 MB, so only its last 1 MB is sent, marked
 * truncated) and stderr-missing (no log is stored for the attempt, which ended before the
 * worker kept full logs: 404).
 */
import { ATTEMPT_STDERR_MAX_BYTES } from '@hermes-evals/shared';
import type { AttemptStderr } from '@/api/types/runs';
import { runDetailFixture } from './inspector';

type Active = (name: string) => boolean;

/** Size the stderr-long scenario reports for the whole log: 3.3 MB, over the 1 MB bound. */
export const LONG_LOG_BYTES = 3_460_000;
/** Lines the stderr-long scenario reports for the whole log. */
export const LONG_LOG_LINES = 48_213;

const FILLER = [
  'hermes: model call → 200',
  'tool terminal: python3 reconcile.py --exclude-disputed (still running)',
  'hermes: waiting on tool process',
  'hermes: context 21,960 tokens',
];

/** `count` generated lines, numbered from `from`, for the part of a log before its tail. */
function filler(from: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    return `[step ${n}] ${FILLER[n % FILLER.length] ?? ''}`;
  });
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/** An attempt's whole stderr.log, or null when there is none (the API's 404). */
export function attemptStderrFixture(
  active: Active,
  runId: string,
  attempt: number,
): AttemptStderr | null {
  if (active('stderr-missing')) return null;
  const detail = runDetailFixture(active, runId);
  if (!detail || !detail.attempts.some((a) => a.number === attempt)) return null;
  const tail =
    detail.executionError && attempt === detail.shownAttempt
      ? detail.executionError.stderrTail
      : { lines: ['hermes: session ended'], totalLines: 1 };
  if (active('stderr-long') && tail.totalLines > tail.lines.length) {
    // Only the end is sent: a few thousand lines stand in for the last megabyte.
    const kept = 2_000;
    const lines = [...filler(LONG_LOG_LINES - kept, kept - tail.lines.length), ...tail.lines];
    return {
      runId,
      attempt,
      text: `${lines.join('\n')}\n`,
      sizeBytes: Math.max(LONG_LOG_BYTES, ATTEMPT_STDERR_MAX_BYTES + 1),
      totalLines: LONG_LOG_LINES,
      truncated: true,
    };
  }
  const total = Math.max(tail.totalLines, tail.lines.length);
  const lines = [...filler(1, total - tail.lines.length), ...tail.lines];
  const text = lines.length ? `${lines.join('\n')}\n` : '';
  return {
    runId,
    attempt,
    text,
    sizeBytes: bytesOf(text),
    totalLines: lines.length,
    truncated: false,
  };
}
