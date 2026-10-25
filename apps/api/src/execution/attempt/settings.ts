/**
 * The attempt runner's tunables, with the plan's values as defaults, and the
 * cross-check of Hermes's token counts against what egress counted.
 */
import type { Tokens } from '@hermes-evals/shared';
import type { EgressUsage } from '../../sandbox/egress-client.js';
import { DEFAULT_DISK_LIMIT } from '../../sandbox/trial-files.js';
import { DEFAULT_LIMITS, type TrialLimits } from '../../sandbox/trial-spec.js';

export interface AttemptRunnerSettings {
  /** Seconds after the run budget before the container is stopped. Plan 8.4: 60. */
  deadlineGraceS: number;
  /** Seconds between SIGTERM and SIGKILL. Plan 8.4: 10. */
  stopGraceS: number;
  /** Disk cap over home and workspace. Plan 8.2: 2 GiB and 50,000 files, polled every second. */
  disk: { maxBytes: number; maxEntries: number; intervalMs: number };
  /**
   * Cap on stdout and stderr together; past it the container is killed. Its
   * output is decoded in the worker's memory and every line becomes a stored
   * event, and whatever runs in the trial can write at pipe speed.
   */
  outputLimitBytes: number;
  /**
   * Cap on stdout lines, each of which becomes a stored event; past it the
   * container is killed as for output. Bytes alone do not bound events:
   * 60 MB of two-byte lines is 30 million of them. A Hermes run prints a few
   * hundred.
   */
  maxEvents: number;
  /**
   * Events the batcher may hold unwritten; past it the trial is killed as for
   * output. Above maxEvents, so only a sink that stopped draining reaches it.
   */
  maxQueuedEvents: number;
  /**
   * How long event writes may keep failing (a database restart) before the
   * attempt is handed back: under the lease, which the heartbeat cannot
   * renew meanwhile either.
   */
  sinkRetryMs: number;
  /** Container memory, CPU, process and /tmp limits (plan 8.2). */
  limits: TrialLimits;
  /** Events per sink write, and the longest an event waits. Plan 8.3: 50 and 500 ms. */
  flushEvents: number;
  flushIntervalMs: number;
  /** How often Cancel is polled from the sink (plan: about once a second). */
  cancelPollMs: number;
  /** Gateway token cap per attempt, passed to egress; no cap when unset. */
  maxTokens?: number;
}

export const DEFAULT_RUNNER_SETTINGS: Readonly<AttemptRunnerSettings> = Object.freeze({
  deadlineGraceS: 60,
  stopGraceS: 10,
  disk: {
    maxBytes: DEFAULT_DISK_LIMIT.maxBytes,
    maxEntries: DEFAULT_DISK_LIMIT.maxEntries,
    intervalMs: DEFAULT_DISK_LIMIT.intervalMs ?? 1000,
  },
  outputLimitBytes: 64 * 1024 * 1024,
  maxEvents: 20_000,
  maxQueuedEvents: 25_000,
  sinkRetryMs: 45_000,
  limits: DEFAULT_LIMITS,
  flushEvents: 50,
  flushIntervalMs: 500,
  cancelPollMs: 1000,
});

/**
 * The PATH the launch record shows when the worker was not told the trial
 * image's. The trial is never given a PATH; the image's own applies.
 */
export const IMAGE_DEFAULT_PATH = '<image default>';

/** Hermes's totals beside egress's, stored on the `collected` event. */
export interface TokenCheck {
  result_input: number | null;
  result_output: number | null;
  egress_calls: number;
  egress_prompt: number;
  egress_completion: number;
  /** Null when Hermes reported no tokens to compare. */
  agrees: boolean | null;
}

/**
 * Compares the `result` event's tokens with egress's usage for the attempt.
 * Hermes's `input` counts every prompt token, cached ones included, as
 * OpenAI-style `prompt_tokens` do (stream-json.ts resultTokens), so on the
 * gateway path the two should match. The result's figures stay the record;
 * a difference is only reported.
 */
export function tokenCheck(tokens: Tokens | null, usage: EgressUsage): TokenCheck {
  return {
    result_input: tokens?.input ?? null,
    result_output: tokens?.output ?? null,
    egress_calls: usage.calls,
    egress_prompt: usage.promptTokens,
    egress_completion: usage.completionTokens,
    agrees: tokens
      ? tokens.input === usage.promptTokens && tokens.output === usage.completionTokens
      : null,
  };
}
