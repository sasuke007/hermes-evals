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

  it('refuse an unknown provider, a custom judge without a base URL, and a silly cap', () => {
    for (const [raw, message] of [
      [{ JUDGE_PROVIDER: 'gemini' }, /JUDGE_PROVIDER/],
      [{ JUDGE_PROVIDER: 'custom', JUDGE_MODEL: 'm' }, /JUDGE_BASE_URL: is required/],
      [{ JUDGE_PROVIDER: 'custom', JUDGE_BASE_URL: 'http://u:p@x/v1' }, /JUDGE_BASE_URL/],
      [{ JUDGE_PROVIDER: 'nous', JUDGE_BASE_URL: 'mock-model:8090' }, /JUDGE_BASE_URL/],
      [{ JUDGE_MODEL: 'x'.repeat(201) }, /JUDGE_MODEL/],
      [{ MODEL_TOKEN_CAP_PER_ATTEMPT: '0' }, /MODEL_TOKEN_CAP_PER_ATTEMPT/],
      [{ MODEL_TOKEN_CAP_PER_ATTEMPT: '1500.5' }, /MODEL_TOKEN_CAP_PER_ATTEMPT/],
    ] as const) {
      expect(() => validateEnv(raw), JSON.stringify(raw)).toThrow(message);
    }
  });
});

describe('Phase 8 settings', () => {
  // Compose gives the api and the worker the mock judge's three settings
  // unless the shell or .env sets them (docker-compose.yml x-judge-settings).
  const composeDefaults = {
    JUDGE_PROVIDER: 'custom',
    JUDGE_MODEL: 'mock/scripted',
    JUDGE_BASE_URL: 'http://mock-model:8090/v1',
  };

  it("read Compose's defaults as the mock judge", () => {
    expect(validateEnv(composeDefaults)).toMatchObject(composeDefaults);
  });

  it('ignore the base URL beside any provider but custom, so a real judge in .env starts', () => {
    // `JUDGE_PROVIDER=nous` and `JUDGE_MODEL=...` in .env; Compose still passes the mock's base URL.
    const real = validateEnv({
      ...composeDefaults,
      JUDGE_PROVIDER: 'nous',
      JUDGE_MODEL: 'openai/gpt-6.1-sol',
    });
    expect([real.JUDGE_PROVIDER, real.JUDGE_MODEL, real.JUDGE_BASE_URL]).toEqual([
      'nous',
      'openai/gpt-6.1-sol',
      undefined,
    ]);
    // scripts/phase3-smoke.sh recreates the api with JUDGE_PROVIDER=openrouter and an empty base URL.
    expect(
      validateEnv({ ...composeDefaults, JUDGE_PROVIDER: 'openrouter' }).JUDGE_BASE_URL,
    ).toBeUndefined();
    // A provider left unset is nous (resolveJudgeModel), so the base URL is ignored there too.
    expect(validateEnv({ JUDGE_BASE_URL: 'http://x:1/v1' }).JUDGE_BASE_URL).toBeUndefined();
  });

  it("read the mock's model name as unset beside a real provider: JUDGE_PROVIDER=openrouter alone", () => {
    // .env sets the provider and its key but no JUDGE_MODEL, as Phase 6 and 7 allowed: Compose
    // still passes mock/scripted, which OpenRouter would answer with an error on every judge
    // call. Unset, a launch with an llm_judge check that names no model is refused (409).
    const env = validateEnv({ ...composeDefaults, JUDGE_PROVIDER: 'openrouter' });
    expect([env.JUDGE_PROVIDER, env.JUDGE_MODEL, env.JUDGE_BASE_URL]).toEqual([
      'openrouter',
      undefined,
      undefined,
    ]);
    // The same for nous, for a provider left unset (nous), and with spaces around the name.
    expect(validateEnv({ ...composeDefaults, JUDGE_PROVIDER: 'nous' }).JUDGE_MODEL).toBeUndefined();
    expect(validateEnv({ JUDGE_MODEL: 'mock/scripted' }).JUDGE_MODEL).toBeUndefined();
    expect(
      validateEnv({ JUDGE_PROVIDER: 'openai', JUDGE_MODEL: ' mock/scripted ' }).JUDGE_MODEL,
    ).toBeUndefined();
    // Any other model is kept.
    expect(
      validateEnv({ JUDGE_PROVIDER: 'openrouter', JUDGE_MODEL: 'openai/gpt-6.1-sol' }).JUDGE_MODEL,
    ).toBe('openai/gpt-6.1-sol');
  });

  it("keep the mock's model name for custom with a real base URL alone: the pages flag it", () => {
    // `JUDGE_PROVIDER=custom` and `JUDGE_BASE_URL=https://…` in .env, no JUDGE_MODEL. A mock
    // reached at another host answers mock/scripted, so it is kept (judge-view.ts mockModelName).
    const env = validateEnv({ ...composeDefaults, JUDGE_BASE_URL: 'https://judge.example.com/v1' });
    expect([env.JUDGE_PROVIDER, env.JUDGE_MODEL, env.JUDGE_BASE_URL]).toEqual([
      'custom',
      'mock/scripted',
      'https://judge.example.com/v1',
    ]);
  });

  it('seed the samples from ./samples by default, and turn the seed off with false or 0', () => {
    const env = validateEnv({});
    expect([env.SEED_SAMPLES, env.SAMPLES_DIR]).toEqual([true, './samples']);
    for (const [value, seed] of [
      ['', true],
      ['true', true],
      ['1', true],
      [' TRUE ', true],
      ['false', false],
      ['0', false],
    ] as const) {
      expect(validateEnv({ SEED_SAMPLES: value }).SEED_SAMPLES, value).toBe(seed);
    }
    expect(() => validateEnv({ SEED_SAMPLES: 'maybe' })).toThrow(/SEED_SAMPLES/);
  });
});
