/**
 * The result every scorer returns (plan 9.2), and the helpers that keep the
 * database's score rules true by construction: `passed` and `failed` carry a
 * score from 0 to 1, `error` and `ungradable` carry none
 * (scores_score_status_ck). The caller adds the key, the type and the scorer
 * version when it writes the row.
 */
import type { JsonValue, ScoreEvidence, ScoreStatus } from '@hermes-evals/shared';

export interface ScorerResult {
  status: ScoreStatus;
  /** 0 to 1 when passed or failed; null when the check broke or nothing was gradable. */
  score: number | null;
  /** One line a person reads beside the status, e.g. `|observed − expected| = 0.00`. */
  comment: string;
  /** A short rendering of the observed value, when the scorer has one worth showing. */
  value?: string;
  expected?: JsonValue;
  observed?: JsonValue;
  evidence?: ScoreEvidence;
}

/** Optional parts of a result, shared by the constructors below. */
export type ResultDetail = Pick<ScorerResult, 'value' | 'expected' | 'observed' | 'evidence'>;

/** `passed` when `passed` is true, else `failed`, with the score the scorer computed. */
export function graded(
  passed: boolean,
  score: number,
  comment: string,
  detail: ResultDetail = {},
): ScorerResult {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new RangeError(`score ${score} is outside 0 to 1`);
  }
  return { status: passed ? 'passed' : 'failed', score, comment, ...detail };
}

/** A pass/fail check with no partial credit: score 1 or 0. */
export const binary = (passed: boolean, comment: string, detail: ResultDetail = {}) =>
  graded(passed, passed ? 1 : 0, comment, detail);

/** Nothing could be graded, e.g. no fenced JSON block. Never a zero. */
export function ungradable(comment: string, detail: ResultDetail = {}): ScorerResult {
  return { status: 'ungradable', score: null, comment, ...detail };
}

/**
 * The check itself broke: a reference without the value, a verifier that
 * printed no result line, a scorer that threw. Never a zero, so a broken
 * check cannot count against the agent.
 */
export function scorerError(
  message: string,
  detail: string | null = null,
  extra: ResultDetail = {},
): ScorerResult {
  return {
    status: 'error',
    score: null,
    comment: message,
    ...extra,
    evidence: { ...extra.evidence, error: { message, detail } },
  };
}

/** The message of anything thrown, and the stack line that says where. */
export function describeThrown(err: unknown): { message: string; detail: string | null } {
  if (err instanceof Error) {
    const where = err.stack?.split('\n')[1]?.trim() ?? null;
    return { message: err.message || err.name, detail: where };
  }
  return { message: String(err), detail: null };
}

/** Runs a synchronous scorer; anything it throws becomes an `error` result (plan 9.2). */
export function guarded(run: () => ScorerResult): ScorerResult {
  try {
    return run();
  } catch (err) {
    const { message, detail } = describeThrown(err);
    return scorerError(`the scorer failed: ${message}`, detail);
  }
}

/** The asynchronous form of `guarded`. */
export async function guardedAsync(run: () => Promise<ScorerResult>): Promise<ScorerResult> {
  try {
    return await run();
  } catch (err) {
    const { message, detail } = describeThrown(err);
    return scorerError(`the scorer failed: ${message}`, detail);
  }
}
