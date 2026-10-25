/**
 * classifyAttempt on a refused model call (plan 8.4): a provider's 429 is
 * `provider`, which the lifecycle retries once automatically; egress's own
 * refusal past the attempt's token cap is `limit` (Phase 3 question 8),
 * never retried, because a retry would stop at the same cap after spending
 * as much again. Since Phase 4 question 8 egress answers the cap with a 402
 * Hermes does not retry, and the run is known to be capped from egress's
 * connection log, not from the status. runner.spec.ts has the rest of the
 * table end to end.
 */
import { describe, expect, it } from 'vitest';
import { autoRetries } from '../lifecycle/finish.js';
import { queuedRunTrigger } from '../../experiments/commands/jobs.js';
import { classifyAttempt, tokenCapRefusalOf, type AttemptObservation } from './classify.js';

/**
 * The `error` of Hermes 4d04303's `result` when egress refused a call at the
 * cap, as the live check recorded it on the Compose stack (egress's message
 * from apps/egress/src/upstream.ts tokenCapRefusal, after `HTTP 429: `).
 */
const TOKEN_CAP_FAILURE =
  'HTTP 429: This attempt reached its token cap of 1000 tokens (3789 used; MODEL_TOKEN_CAP_PER_ATTEMPT)';

function observation(
  error: string,
  text = '',
  tokenCapRefusal: string | null = null,
): AttemptObservation {
  return {
    trial: {
      containerId: 'c-1',
      exitCode: 1,
      oomKilled: false,
      stopReason: 'exited',
      durationMs: 15_000,
    },
    setupError: null,
    engineError: null,
    cancelled: false,
    result: { type: 'result', exit_code: 1, error, text },
    sawInit: true,
    stderrTail: null,
    mcpStartFailures: [],
    tokenCapRefusal,
    runBudgetS: 120,
    deadlineGraceS: 60,
    memoryMiB: 2048,
  };
}

describe('a 429 from the model gateway', () => {
  it('is `limit` when egress stopped the attempt at its token cap', () => {
    const outcome = classifyAttempt(observation(TOKEN_CAP_FAILURE));
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'limit' });
    expect(outcome.errorMessage).toBe(
      `The model gateway stopped the run at its token cap: ${TOKEN_CAP_FAILURE}`,
    );
  });

  it('is `limit` for the cap even when Hermes printed partial text', () => {
    const outcome = classifyAttempt(observation(TOKEN_CAP_FAILURE, 'The total is'));
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'limit' });
  });

  it('knows the cap by its error code too', () => {
    const outcome = classifyAttempt(
      observation('Error code: 429 - {"error": {"code": "token_cap_reached"}}'),
    );
    expect(outcome.category).toBe('limit');
  });

  it('stays `provider` for a provider rate limit', () => {
    const outcome = classifyAttempt(
      observation('HTTP 429: Rate limit reached for requests per minute. Try again in 20s.'),
    );
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'provider' });
    expect(outcome.errorMessage).toMatch(/^The provider failed: HTTP 429: Rate limit/);
  });
});

describe("egress's log of a call refused at the token cap", () => {
  /** Hermes's terminal `error` for egress's 402: billing copy, not the cap's words. */
  const BILLING_FAILURE = 'HTTP 402: Payment required. Check credits / billing.';

  it('reads the first refusal at the cap, and nothing else', () => {
    const at = '2026-10-25T10:00:00.000Z';
    expect(
      tokenCapRefusalOf([
        {
          at,
          kind: 'connect',
          host: 'portal.nousresearch.com',
          decision: 'denied',
          reason: 'not allowed',
        },
        { at, kind: 'model', decision: 'denied', reason: 'too many model calls in flight' },
        { at, kind: 'model', decision: 'allowed', status: 200 },
        {
          at,
          kind: 'model',
          decision: 'denied',
          status: 402,
          reason: 'token cap reached: 1043 of 1000 tokens used',
        },
        {
          at,
          kind: 'model',
          decision: 'denied',
          status: 402,
          reason: 'token cap reached: 1043 of 1000 tokens used',
        },
      ]),
    ).toBe('1043 of 1000 tokens used');
    expect(tokenCapRefusalOf([{ at, kind: 'model', decision: 'allowed', status: 429 }])).toBeNull();
    expect(tokenCapRefusalOf([])).toBeNull();
  });

  it('makes the run `limit` whatever status Hermes saw', () => {
    const outcome = classifyAttempt(observation(BILLING_FAILURE, '', '1043 of 1000 tokens used'));
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'limit' });
    expect(outcome.errorMessage).toBe(
      'The model gateway stopped the run at its token cap: 1043 of 1000 tokens used.',
    );
    // The billing copy alone, without the log, is not a provider failure the lifecycle retries.
    expect(classifyAttempt(observation(BILLING_FAILURE)).category).not.toBe('limit');
  });

  it('makes it `limit` when Hermes left no result, or partial text', () => {
    const none = { ...observation('', '', '1043 of 1000 tokens used'), result: null };
    expect(classifyAttempt(none)).toMatchObject({ status: 'execution_error', category: 'limit' });
    const partial = observation(BILLING_FAILURE, 'The total is', '1043 of 1000 tokens used');
    expect(classifyAttempt(partial).category).toBe('limit');
  });

  it('keeps the answer of a turn that finished cleanly before a later call was refused', () => {
    const clean = {
      ...observation('', '```json\n{"total": 1}\n```', '1043 of 1000 tokens used'),
      result: { type: 'result', exit_code: 0, text: '```json\n{"total": 1}\n```' },
    };
    expect(classifyAttempt(clean)).toMatchObject({ status: 'executed', category: null });
  });
});

describe('a run stopped at the token cap', () => {
  it('is never retried automatically, on attempt 1 or later', () => {
    expect(autoRetries('limit', 1, false)).toBe(false);
    expect(autoRetries('limit', 2, false)).toBe(false);
    // The rate limit beside it still is, once.
    expect(autoRetries('provider', 1, false)).toBe(true);
  });

  it('is re-sent as a user retry, never as the automatic one', () => {
    expect(queuedRunTrigger({ number: 1, errorCategory: 'limit' })).toBe('user_retry');
  });
});
