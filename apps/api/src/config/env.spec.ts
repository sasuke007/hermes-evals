import { describe, expect, it } from 'vitest';
import { isReservedEnvName } from '@hermes-evals/shared';
import { EnvSchema } from './env.js';

describe('EnvSchema', () => {
  it('has only keys no MCP definition may reference, so a new setting never becomes a trial secret', () => {
    // A stdio env name is copied from the worker's environment into the trial
    // container (plan 5.3). Add a new key to WORKER_SETTING_ENV_NAMES or under
    // a reserved prefix in packages/shared/src/env-names.ts.
    const exposed = Object.keys(EnvSchema.shape).filter((key) => !isReservedEnvName(key));
    expect(exposed).toEqual([]);
  });
});
