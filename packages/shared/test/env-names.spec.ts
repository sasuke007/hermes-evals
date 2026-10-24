import { describe, expect, it } from 'vitest';
import {
  isReservedEnvName,
  PROVIDER_KEY_ENV_NAMES,
  WORKER_RESERVED_ENV_NAMES,
} from '../src/env-names.js';

describe('isReservedEnvName', () => {
  it('reserves the platform trial variables, the provider keys and the worker settings', () => {
    for (const name of [
      'HOME',
      'PATH',
      'HTTPS_PROXY',
      'DATABASE_URL',
      'CORS_ORIGIN',
      ...PROVIDER_KEY_ENV_NAMES,
    ]) {
      expect(isReservedEnvName(name), name).toBe(true);
    }
    expect(WORKER_RESERVED_ENV_NAMES.has('OPENROUTER_API_KEY')).toBe(true);
  });

  it('reserves whole namespaces by prefix', () => {
    for (const name of [
      'DOCKER_SOCKET',
      'EGRESS_ADMIN_SOCKET',
      'TRIAL_SLOTS',
      'HERMES_ANYTHING',
      'NODE_OPTIONS',
      'PGPASSWORD',
      'NOUS_HOST_PROXY',
      'OPENROUTER_BASE_URL',
      'OPENAI_ORG',
      'ANTHROPIC_BASE_URL',
    ]) {
      expect(isReservedEnvName(name), name).toBe(true);
    }
  });

  it('leaves the names definitions use alone', () => {
    for (const name of ['INVOICE_DB_URL', 'INVOICE_DB_PATH', 'VENDOR_API_TOKEN', 'MY_HOME']) {
      expect(isReservedEnvName(name), name).toBe(false);
    }
  });
});
