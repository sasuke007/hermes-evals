import { readFile } from 'node:fs/promises';
import { HERMES_REVISION } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { WorkerSandboxSchema } from '../../database/schema/worker-sandbox.js';
import type { SelfTestCheck } from '../../sandbox/self-test.js';
import {
  presentEnvNames,
  SANDBOX_UNAVAILABLE_ERROR,
  SELF_TEST_CHECK_IDS,
  SELF_TEST_NOT_RUN_ERROR,
  selfTestCheckId,
  workerSandboxReport,
} from './presence-report.js';

describe('presentEnvNames', () => {
  it('lists the sorted referenceable names that hold a value, never a value', () => {
    const env: NodeJS.ProcessEnv = {
      INVOICE_DB_URL: 'postgres://user:hunter2@db/invoices',
      NOUS_API_KEY: 'sk-nous',
      PATH: '/usr/bin',
      EMPTY: '',
      lower_case: 'x',
      'WITH-DASH': 'x',
      '9STARTS_WITH_DIGIT': 'x',
    };
    const names = presentEnvNames(env);
    expect(names).toEqual(['INVOICE_DB_URL', 'NOUS_API_KEY', 'PATH']);
    expect(JSON.stringify(names)).not.toContain('hunter2');
  });
});

describe('self-test check ids', () => {
  it('cover every check the self-test can report, each with its own id', async () => {
    // The names are literals in self-test.ts: a renamed or added check must get its id here.
    const source = await readFile(new URL('../../sandbox/self-test.ts', import.meta.url), 'utf8');
    const names = [
      ...source.matchAll(/\bcheck\(\s*'([^']+)'/g),
      ...source.matchAll(/\bname: '([^']+)',\s*ok:/g),
    ].map((m) => m[1]!);
    expect(names.length).toBe(16);
    expect(names.filter((name) => !(name in SELF_TEST_CHECK_IDS))).toEqual([]);
    const ids = Object.values(SELF_TEST_CHECK_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('fall back to a slug of an unknown name', () => {
    expect(selfTestCheckId('has no default route')).toBe('no-default-route');
    expect(selfTestCheckId('Egress keeps IPv6 out!')).toBe('egress-keeps-ipv6-out');
    expect(selfTestCheckId('…')).toBe('check');
  });
});

describe('workerSandboxReport', () => {
  const checks: SelfTestCheck[] = [
    { name: 'runs as uid 10000', ok: true, detail: 'uid 10000' },
    { name: 'has no default route', ok: false, detail: 'a default route exists' },
  ];
  const base = {
    checks,
    checkedAt: new Date('2026-10-24T09:00:00.000Z'),
    image: 'hermes-evals/trial:v0.22.4-4d04303',
    revision: HERMES_REVISION,
  };

  it('maps a self-test into the workers.sandbox shape, in order', () => {
    const report = workerSandboxReport({
      ...base,
      state: 'failed',
      imageDigest: `sha256:${'a'.repeat(64)}`,
    });
    expect(report).toEqual({
      state: 'failed',
      checks: [
        { id: 'unprivileged-user', name: 'runs as uid 10000', passed: true, detail: 'uid 10000' },
        {
          id: 'no-default-route',
          name: 'has no default route',
          passed: false,
          detail: 'a default route exists',
        },
      ],
      checked_at: '2026-10-24T09:00:00.000Z',
      image: 'hermes-evals/trial:v0.22.4-4d04303',
      revision: HERMES_REVISION,
      image_digest: `sha256:${'a'.repeat(64)}`,
      trigger: 'worker start',
    });
    expect(WorkerSandboxSchema.parse(report)).toEqual(report);
  });

  it('records why there are no checks when the sandbox is unavailable or the test could not run', () => {
    const unavailable = workerSandboxReport({ ...base, state: 'unavailable' });
    expect(unavailable).toMatchObject({ state: 'unavailable', checks: [] });
    expect(unavailable?.error).toBe(SANDBOX_UNAVAILABLE_ERROR);
    expect(unavailable).not.toHaveProperty('image_digest');
    const notRun = workerSandboxReport({ ...base, checks: [], state: 'failed' });
    expect(notRun?.error).toBe(SELF_TEST_NOT_RUN_ERROR);
    const isolated = workerSandboxReport({ ...base, state: 'isolated' });
    expect(isolated).not.toHaveProperty('error');
    for (const report of [unavailable, notRun, isolated]) WorkerSandboxSchema.parse(report);
  });

  it('is null when no self-test ran', () => {
    expect(workerSandboxReport({ ...base, state: 'unverified' })).toBeNull();
  });
});
