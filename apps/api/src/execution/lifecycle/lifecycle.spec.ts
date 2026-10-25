/**
 * startExecutionLifecycle on PGlite with a pg-boss stand-in that records how
 * the execute-run handler was registered: WORKER_CONCURRENCY is capped at
 * the number of TRIAL_SLOTS (Phase 2 follow-up 3), with the warning kept.
 * The handler's own behaviour is covered on Postgres 17 in
 * lifecycle.e2e-spec.ts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { FakeEngine } from '../../../test/support/fake-engine.js';
import { QUEUES } from '../../queue/queues.js';
import { startExecutionLifecycle, trialConcurrency, type ExecutionLifecycle } from './lifecycle.js';
import { sessionRecoveryLock } from './recovery-lock.js';
import {
  FakeRunner,
  FAST_SETTINGS,
  HERMES_REVISION,
  memoryLogger,
  RecordingQueue,
  seedWorker,
} from './testing.support-spec.js';

const HOST = 'FAKE:DAEMON';
const WARNING = 'WORKER_CONCURRENCY is above the number of TRIAL_SLOTS';

/** The pg-boss calls the lifecycle makes, recording each work() registration's options. */
function recordingBoss() {
  const work: Array<{ name: string; options: Record<string, unknown> }> = [];
  const boss = {
    work: (name: string, options: Record<string, unknown>) => {
      work.push({ name, options });
      return Promise.resolve(`work-${work.length}`);
    },
    offWork: () => Promise.resolve(),
  };
  return { boss: boss as unknown as PgBoss, work };
}

describe('trialConcurrency', () => {
  it('is WORKER_CONCURRENCY, at most one per slot and at least one', () => {
    expect(trialConcurrency(3, 4)).toBe(3);
    expect(trialConcurrency(4, 4)).toBe(4);
    expect(trialConcurrency(8, 4)).toBe(4);
    expect(trialConcurrency(3, 1)).toBe(1);
    expect(trialConcurrency(3, 0)).toBe(1);
  });
});

describe('startExecutionLifecycle', () => {
  let t: TestDatabase;
  let trialsDir: string;
  let lifecycles: ExecutionLifecycle[];

  beforeEach(async () => {
    t = await createTestDatabase();
    trialsDir = await mkdtemp(join(tmpdir(), 'hermes-evals-lifecycle-'));
    lifecycles = [];
  });
  afterEach(async () => {
    for (const lifecycle of lifecycles) await lifecycle.stop();
    await t.close();
    await rm(trialsDir, { recursive: true, force: true });
  });

  async function start(concurrency: number, trialSlots: string[], runner = new FakeRunner()) {
    const { boss, work } = recordingBoss();
    const logger = memoryLogger();
    const lifecycle = await startExecutionLifecycle({
      boss,
      db: t.db,
      runner,
      engine: new FakeEngine({ daemonId: HOST }),
      readiness: () => Promise.resolve({ ready: true, status: 'configured', reason: null }),
      workerId: await seedWorker(t.db),
      hostId: HOST,
      hermesRevision: HERMES_REVISION,
      trialsDir,
      trialSlots,
      recoveryLock: sessionRecoveryLock(t.db),
      logger,
      settings: { ...FAST_SETTINGS, concurrency },
      queue: new RecordingQueue(),
    });
    lifecycles.push(lifecycle);
    return { lifecycle, work, warnings: logger.lines.filter((l) => l.level === 'warn') };
  }

  it('takes WORKER_CONCURRENCY jobs at once when every one has a slot, and does not warn', async () => {
    const { work, warnings, lifecycle } = await start(3, [
      'trial-0',
      'trial-1',
      'trial-2',
      'trial-3',
    ]);
    expect(work).toEqual([
      { name: QUEUES.executeRun, options: expect.objectContaining({ localConcurrency: 3 }) },
    ]);
    expect(lifecycle.slots?.size).toBe(4);
    expect(warnings.filter((w) => w.msg.startsWith(WARNING))).toEqual([]);
  });

  it('caps the jobs taken at once at the number of slots, and still warns', async () => {
    const { work, warnings } = await start(6, ['trial-0', 'trial-1']);
    expect(work).toEqual([
      { name: QUEUES.executeRun, options: expect.objectContaining({ localConcurrency: 2 }) },
    ]);
    expect(warnings.filter((w) => w.msg.startsWith(WARNING))).toEqual([
      expect.objectContaining({ obj: { concurrency: 6, slots: 2, runsAtOnce: 2 } }),
    ]);
  });
});
