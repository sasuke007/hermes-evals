import { describe, expect, it } from 'vitest';
import { isReservedEnvName } from '@hermes-evals/shared';
import { EnvSchema, validateEnv } from './env.js';

describe('EnvSchema', () => {
  it('has only keys no MCP definition may reference, so a new setting never becomes a trial secret', () => {
    // A stdio env name is copied from the worker's environment into the trial
    // container (plan 5.3). Add a new key to WORKER_SETTING_ENV_NAMES or under
    // a reserved prefix in packages/shared/src/env-names.ts.
    const exposed = Object.keys(EnvSchema.shape).filter((key) => !isReservedEnvName(key));
    expect(exposed).toEqual([]);
  });
});

describe('Phase 2 settings', () => {
  it('default to the values plan 7.3, 8.1, 8.5, 8.6 and 6.1 name', () => {
    const env = validateEnv({});
    expect({
      MAX_CONSECUTIVE_EXECUTION_ERRORS: env.MAX_CONSECUTIVE_EXECUTION_ERRORS,
      TRIAL_RETENTION_DAYS: env.TRIAL_RETENTION_DAYS,
      RECOVERY_INTERVAL_MS: env.RECOVERY_INTERVAL_MS,
      LEASE_SECONDS: env.LEASE_SECONDS,
      NOUS_LOGIN_URL: env.NOUS_LOGIN_URL,
    }).toEqual({
      MAX_CONSECUTIVE_EXECUTION_ERRORS: 14,
      TRIAL_RETENTION_DAYS: 7,
      RECOVERY_INTERVAL_MS: 15_000,
      LEASE_SECONDS: 60,
      NOUS_LOGIN_URL: 'http://nous-login:8650',
    });
  });

  it('refuse values that would break leases or recovery', () => {
    for (const raw of [
      { LEASE_SECONDS: '10' },
      { RECOVERY_INTERVAL_MS: '0' },
      { MAX_CONSECUTIVE_EXECUTION_ERRORS: '0' },
      { TRIAL_RETENTION_DAYS: '-1' },
      { NOUS_LOGIN_URL: 'nous-login' },
    ]) {
      expect(() => validateEnv(raw), JSON.stringify(raw)).toThrow(/Invalid environment/);
    }
    expect(validateEnv({ TRIAL_RETENTION_DAYS: '0' }).TRIAL_RETENTION_DAYS).toBe(0);
  });
});

describe('Phase 3 settings', () => {
  it('leave the judge unset and cap each attempt at 2,000,000 tokens by default', () => {
    const env = validateEnv({});
    expect({
      JUDGE_PROVIDER: env.JUDGE_PROVIDER,
      JUDGE_MODEL: env.JUDGE_MODEL,
      JUDGE_BASE_URL: env.JUDGE_BASE_URL,
      MODEL_TOKEN_CAP_PER_ATTEMPT: env.MODEL_TOKEN_CAP_PER_ATTEMPT,
    }).toEqual({
      JUDGE_PROVIDER: undefined,
      JUDGE_MODEL: undefined,
      JUDGE_BASE_URL: undefined,
      MODEL_TOKEN_CAP_PER_ATTEMPT: 2_000_000,
    });
  });

  it('read a judge on any provider, a custom one with its base URL, and empty values as unset', () => {
    expect(
      validateEnv({ JUDGE_PROVIDER: 'nous', JUDGE_MODEL: 'openai/gpt-6.1-sol' }),
    ).toMatchObject({ JUDGE_PROVIDER: 'nous', JUDGE_MODEL: 'openai/gpt-6.1-sol' });
    expect(
      validateEnv({
        JUDGE_PROVIDER: 'custom',
        JUDGE_MODEL: 'mock/scripted',
        JUDGE_BASE_URL: 'http://mock-model:8090/v1',
      }),
    ).toMatchObject({ JUDGE_PROVIDER: 'custom', JUDGE_BASE_URL: 'http://mock-model:8090/v1' });
    // A model alone is allowed: it runs on nous (resolveJudgeModel).
    expect(validateEnv({ JUDGE_MODEL: 'openai/gpt-6.1-sol' }).JUDGE_PROVIDER).toBeUndefined();
    const blank = validateEnv({ JUDGE_PROVIDER: '', JUDGE_MODEL: '', JUDGE_BASE_URL: '' });
    expect([blank.JUDGE_PROVIDER, blank.JUDGE_MODEL, blank.JUDGE_BASE_URL]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(validateEnv({ MODEL_TOKEN_CAP_PER_ATTEMPT: '50000' }).MODEL_TOKEN_CAP_PER_ATTEMPT).toBe(
      50_000,
    );
    // Compose passes `${MODEL_TOKEN_CAP_PER_ATTEMPT:-}`; empty means the default, as in egress.
    expect(validateEnv({ MODEL_TOKEN_CAP_PER_ATTEMPT: '' }).MODEL_TOKEN_CAP_PER_ATTEMPT).toBe(
      2_000_000,
    );
  });

  it('refuse an unknown provider, a base URL that does not match the provider, and a silly cap', () => {
    for (const [raw, message] of [
      [{ JUDGE_PROVIDER: 'gemini' }, /JUDGE_PROVIDER/],
      [{ JUDGE_PROVIDER: 'custom', JUDGE_MODEL: 'm' }, /JUDGE_BASE_URL: is required/],
      [{ JUDGE_PROVIDER: 'nous', JUDGE_BASE_URL: 'http://x:1/v1' }, /JUDGE_BASE_URL: is only used/],
      [{ JUDGE_PROVIDER: 'custom', JUDGE_BASE_URL: 'http://u:p@x/v1' }, /JUDGE_BASE_URL/],
      [{ JUDGE_MODEL: 'x'.repeat(201) }, /JUDGE_MODEL/],
      [{ MODEL_TOKEN_CAP_PER_ATTEMPT: '0' }, /MODEL_TOKEN_CAP_PER_ATTEMPT/],
      [{ MODEL_TOKEN_CAP_PER_ATTEMPT: '1500.5' }, /MODEL_TOKEN_CAP_PER_ATTEMPT/],
    ] as const) {
      expect(() => validateEnv(raw), JSON.stringify(raw)).toThrow(message);
    }
  });
});
