/**
 * The longest a task's checks can take to score, from what they declare
 * (Phase 3 S8). The scoring pass runs its keys one after another inside one
 * evaluate-run job, and pg-boss fails that job at its expiry whatever its
 * heartbeats say, so the loader refuses a task whose worst case is above
 * MAX_SCORING_SECONDS and the job's expiry sits above that bound
 * (queue/queues.ts EVALUATE_RUN_EXPIRE_SECONDS).
 *
 * Per key:
 * - verifier_script: its `timeout_s`, after which the runner kills it;
 * - llm_judge: every try at its timeout, and the pause before the retry;
 * - every key: KEY_SETUP_SECONDS for what surrounds the scorer (rebuilding
 *   the workspace and verify/ folder from blobs, reading events or the
 *   rubric, the judge's registration round trips, renewing the claim).
 * Answer, file and trajectory checks are bounded by the setup allowance:
 * they compute over values already in memory or on local disk.
 */
import type { ScorerParams, ScorerType } from '@hermes-evals/shared';
import { MAX_SCORING_SECONDS } from '../queue/queues.js';
import { JUDGE_RETRIES, JUDGE_RETRY_DELAY_MS, JUDGE_TIMEOUT_MS } from './judge/contracts.js';

export { MAX_SCORING_SECONDS } from '../queue/queues.js';

/** What surrounds one key's scorer, whatever its type. */
export const KEY_SETUP_SECONDS = 10;

/** One llm_judge key at its worst: every try timed out, with the pause between. */
export const JUDGE_KEY_SECONDS = Math.ceil(
  (JUDGE_TIMEOUT_MS * (1 + JUDGE_RETRIES) + JUDGE_RETRY_DELAY_MS) / 1000,
);

/** A key as the loader holds it once its params parsed: defaults applied. */
export interface TimedKey {
  type: ScorerType;
  params: unknown;
}

/** The worst case of one key, in seconds. */
export function keyScoringSeconds(key: TimedKey): number {
  switch (key.type) {
    case 'verifier_script':
      return (key.params as ScorerParams<'verifier_script'>).timeout_s + KEY_SETUP_SECONDS;
    case 'llm_judge':
      return JUDGE_KEY_SECONDS + KEY_SETUP_SECONDS;
    default:
      return KEY_SETUP_SECONDS;
  }
}

/** The worst case of a whole pass: its keys run one after another. */
export const scoringSeconds = (keys: readonly TimedKey[]): number =>
  keys.reduce((sum, key) => sum + keyScoringSeconds(key), 0);

/** The load message for a task above the bound, or null when it fits. */
export function scoringTimeProblem(keys: readonly TimedKey[]): string | null {
  const total = scoringSeconds(keys);
  if (total <= MAX_SCORING_SECONDS) return null;
  return (
    `the checks may take up to ${total} s to score (verifier_script timeout_s and llm_judge ` +
    `calls, plus ${KEY_SETUP_SECONDS} s per key), above the ${MAX_SCORING_SECONDS} s one ` +
    `scoring pass may take; lower timeout_s or split the task`
  );
}
