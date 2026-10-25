/**
 * classifyAttempt on a model call refused with a 429 (plan 8.4): a
 * provider's rate limit is `provider`, which the lifecycle retries once
 * automatically; egress's own 429 past the attempt's token cap is `other`,
 * never retried, because a retry would stop at the same cap after spending
 * as much again. runner.spec.ts has the rest of the table end to end.
 */
import { describe, expect, it } from 'vitest';
import { classifyAttempt, type AttemptObservation } from './classify.js';

/**
 * The `error` of Hermes 4d04303's `result` when egress refused a call at the
 * cap, as the live check recorded it on the Compose stack (egress's message
 * from apps/egress/src/upstream.ts tokenCapRefusal, after `HTTP 429: `).
 */
const TOKEN_CAP_FAILURE =
  'HTTP 429: This attempt reached its token cap of 1000 tokens (3789 used; MODEL_TOKEN_CAP_PER_ATTEMPT)';

function observation(error: string, text = ''): AttemptObservation {
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
    runBudgetS: 120,
    deadlineGraceS: 60,
    memoryMiB: 2048,
  };
}

describe('a 429 from the model gateway', () => {
  it('is `other` when egress stopped the attempt at its token cap', () => {
    const outcome = classifyAttempt(observation(TOKEN_CAP_FAILURE));
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'other' });
    expect(outcome.errorMessage).toBe(
      `The model gateway stopped the run at its token cap: ${TOKEN_CAP_FAILURE}`,
    );
  });

  it('is `other` for the cap even when Hermes printed partial text', () => {
    const outcome = classifyAttempt(observation(TOKEN_CAP_FAILURE, 'The total is'));
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'other' });
  });

  it('knows the cap by its error code too', () => {
    const outcome = classifyAttempt(
      observation('Error code: 429 - {"error": {"code": "token_cap_reached"}}'),
    );
    expect(outcome.category).toBe('other');
  });

  it('stays `provider` for a provider rate limit', () => {
    const outcome = classifyAttempt(
      observation('HTTP 429: Rate limit reached for requests per minute. Try again in 20s.'),
    );
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'provider' });
    expect(outcome.errorMessage).toMatch(/^The provider failed: HTTP 429: Rate limit/);
  });
});
