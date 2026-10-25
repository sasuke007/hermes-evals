/**
 * The platform events the lifecycle writes in the finish transaction, after
 * every streamed event (plan 8.4): egress's connection log, then why the
 * container was stopped (`killed`, `cancelled`), the `result` the platform
 * synthesises when the deadline left Hermes without one, and `collected`.
 */
import type { TrialOutcome } from '../../sandbox/trial-runner.js';
import type { AttemptEventInput } from '../contracts.js';
import type { Classification } from './classify.js';

export interface FinalEventsInput {
  network: readonly AttemptEventInput[];
  trial: TrialOutcome | null;
  classification: Classification;
  /** Whether Hermes printed a `result` of its own. */
  hermesResult: boolean;
  /** Events the batcher dropped because its queue was full (they were never stored). */
  droppedEvents?: number;
  collected: AttemptEventInput | null;
  stopGraceS: number;
  now: number;
}

const KILL_REASONS = new Set<TrialOutcome['stopReason']>([
  'deadline',
  'disk_limit',
  'output_limit',
]);

export function finalEvents(input: FinalEventsInput): AttemptEventInput[] {
  const { trial, classification, now } = input;
  const events: AttemptEventInput[] = [...input.network];
  if (trial && KILL_REASONS.has(trial.stopReason)) {
    events.push({
      ts: now,
      type: 'platform',
      payload: {
        type: 'platform',
        subtype: 'killed',
        reason: trial.stopReason,
        ...(trial.limitDetail ? { detail: trial.limitDetail } : {}),
        // What was read past a cap and never stored, so the timeline says it is incomplete.
        ...(trial.droppedLines ? { dropped_lines: trial.droppedLines } : {}),
        ...(input.droppedEvents ? { dropped_events: input.droppedEvents } : {}),
        ...(trial.stopError ? { stop_error: trial.stopError } : {}),
        // Runaway writers get no grace (trial-runner.ts).
        signal:
          trial.stopReason === 'deadline'
            ? `SIGTERM, then SIGKILL after ${input.stopGraceS} s`
            : 'SIGKILL',
        exit_code: trial.exitCode,
        after_ms: trial.durationMs,
      },
    });
  } else if (trial?.oomKilled) {
    events.push({
      ts: now,
      type: 'platform',
      payload: {
        type: 'platform',
        subtype: 'killed',
        reason: 'oom',
        signal: 'SIGKILL',
        exit_code: trial.exitCode,
        after_ms: trial.durationMs,
      },
    });
  }
  if (classification.status === 'cancelled') {
    events.push({
      ts: now,
      type: 'platform',
      payload: {
        type: 'platform',
        subtype: 'cancelled',
        container_started: trial !== null,
        ...(trial ? { exit_code: trial.exitCode, after_ms: trial.durationMs } : {}),
      },
    });
  }
  if (classification.category === 'timeout' && !input.hermesResult) {
    events.push({
      ts: now,
      type: 'result',
      payload: {
        type: 'result',
        synthesized: true,
        exit_code: null,
        text: '',
        error: classification.errorMessage ?? 'timeout',
        duration_ms: trial?.durationMs ?? null,
      },
    });
  }
  if (input.collected) events.push(input.collected);
  return events;
}
