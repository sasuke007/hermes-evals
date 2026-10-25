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
