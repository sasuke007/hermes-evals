import { HERMES_REVISION, SandboxStatusSchema, WorkerSchema } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import type { WorkerSandbox } from '../database/schema/worker-sandbox.js';
import { SANDBOX_UNAVAILABLE_ERROR } from '../worker/presence/presence-report.js';
import {
  hermesRevisionLabel,
  SELFTEST_COMMAND,
  sandboxView,
  UNKNOWN_DIGEST,
  workerView,
} from './views.js';

const REPORT: WorkerSandbox = {
  state: 'isolated',
  checks: [
    { id: 'unprivileged-user', name: 'runs as uid 10000', passed: true, detail: 'uid 10000' },
    { id: 'no-default-route', name: 'has no default route', passed: true, detail: 'none' },
  ],
  checked_at: '2026-10-24T09:00:00.000Z',
  image: 'hermes-evals/trial:v0.22.4-4d04303',
  revision: HERMES_REVISION,
  image_digest: `sha256:${'7'.repeat(64)}`,
  trigger: 'worker start',
};

describe('workerView', () => {
  const row = {
    id: '01K8ZQ7M3V5X9C2B4N6P8R0T1W',
    lastHeartbeatAt: new Date('2026-10-24T09:00:03.000Z'),
    concurrency: 3,
    slots: 4,
    inFlight: 2,
    sandbox: REPORT,
    online: true,
  };

  it('shows an online worker with its slots in use of its slot count, and its sandbox proof', () => {
    const view = workerView(row);
    expect(view).toEqual({
      id: row.id,
      status: 'online',
      lastHeartbeatAt: '2026-10-24T09:00:03.000Z',
      concurrency: 3,
      effectiveConcurrency: 3,
      slotsInUse: 2,
      slotsTotal: 4,
      sandboxProven: true,
    });
    WorkerSchema.parse(view);
  });

  it('reports the trials it really runs at once: its concurrency, at most one per slot', () => {
    const runsAtOnce = (concurrency: number, slots: number | null) =>
      WorkerSchema.parse(workerView({ ...row, concurrency, slots })).effectiveConcurrency;
    expect(runsAtOnce(6, 4)).toBe(4);
    expect(runsAtOnce(4, 4)).toBe(4);
    expect(runsAtOnce(2, 4)).toBe(2);
    // A worker whose slots are all missing still takes one job (and defers it).
    expect(runsAtOnce(3, 0)).toBe(1);
    // A row written before workers reported their slots.
    expect(runsAtOnce(6, null)).toBe(6);
    // Offline, it shows no slots but keeps what it ran.
    expect(workerView({ ...row, concurrency: 6, online: false })).toMatchObject({
      concurrency: 6,
      effectiveConcurrency: 4,
      slotsTotal: null,
    });
  });

  it('shows no slots for an offline worker, nor a total for a row that never reported one', () => {
    expect(workerView({ ...row, online: false })).toMatchObject({
      status: 'offline',
      slotsInUse: null,
      slotsTotal: null,
    });
    expect(workerView({ ...row, slots: null })).toMatchObject({ slotsInUse: 2, slotsTotal: null });
  });

  it('is not proven for a failed, unavailable or missing report, and offline when not online', () => {
    expect(workerView({ ...row, sandbox: { ...REPORT, state: 'failed' } }).sandboxProven).toBe(
      false,
    );
    expect(workerView({ ...row, sandbox: null }).sandboxProven).toBe(false);
    expect(workerView({ ...row, online: false }).status).toBe('offline');
  });
});

describe('sandboxView', () => {
  it('shows the report with the revision label, digest and self-test command', () => {
    const view = sandboxView('0.22.4', REPORT);
    expect(view).toEqual({
      proven: true,
      checks: REPORT.checks,
      checkedAt: '2026-10-24T09:00:00.000Z',
      trigger: 'worker start',
      revision: 'hermes-agent v0.22.4 @ 4d04303',
      image: 'hermes-evals/trial:v0.22.4-4d04303',
      digest: `sha256:${'7'.repeat(64)}`,
      selftestCommand: SELFTEST_COMMAND,
    });
    SandboxStatusSchema.parse(view);
    expect(hermesRevisionLabel('0.22.4', HERMES_REVISION)).toBe('hermes-agent v0.22.4 @ 4d04303');
  });

  it('is not proven when a check failed', () => {
    const failed: WorkerSandbox = {
      ...REPORT,
      state: 'failed',
      checks: [REPORT.checks[0]!, { ...REPORT.checks[1]!, passed: false, detail: 'a route' }],
    };
    const view = sandboxView('0.22.4', failed);
    expect(view.proven).toBe(false);
    expect(view.checks.map((c) => c.passed)).toEqual([true, false]);
  });

  it('turns a report without checks into one failed check that says why', () => {
    const { image_digest: _digest, ...rest } = REPORT;
    const unavailable = sandboxView('0.22.4', {
      ...rest,
      state: 'unavailable',
      checks: [],
      error: SANDBOX_UNAVAILABLE_ERROR,
    });
    expect(unavailable).toMatchObject({ proven: false, digest: UNKNOWN_DIGEST });
    expect(unavailable.checks).toEqual([
      {
        id: 'sandbox-reachable',
        name: 'docker-guard and egress are reachable',
        passed: false,
        detail: SANDBOX_UNAVAILABLE_ERROR,
      },
    ]);
    const notRun = sandboxView('0.22.4', { ...REPORT, state: 'failed', checks: [] });
    expect(notRun.checks).toEqual([
      {
        id: 'self-test-ran',
        name: 'the isolation self-test ran',
        passed: false,
        detail: 'did not run',
      },
    ]);
    for (const view of [unavailable, notRun]) SandboxStatusSchema.parse(view);
  });
});
