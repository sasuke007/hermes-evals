import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { HERMES_REVISION } from '../../test/support/seed.js';
import { workers } from '../database/schema/index.js';
import { findLiveWorker } from './live-worker.js';

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
});

afterEach(async () => {
  await t.close();
});

const ago = (ms: number) => new Date(Date.now() - ms);

const worker = (hostname: string, row: Partial<typeof workers.$inferInsert>) =>
  t.db.insert(workers).values({
    hostname,
    concurrency: 3,
    hermesVersion: '0.22.4',
    hermesRevision: HERMES_REVISION,
    ...row,
  });

describe('findLiveWorker', () => {
  it('is null with no worker, or only stopped and silent ones', async () => {
    expect(await findLiveWorker(t.db)).toBeNull();
    await worker('stopped', {
      startedAt: ago(5_000),
      lastHeartbeatAt: ago(1_000),
      stoppedAt: ago(500),
    });
    await worker('silent', { startedAt: ago(300_000), lastHeartbeatAt: ago(120_000) });
    expect(await findLiveWorker(t.db)).toBeNull();
  });

  it('returns the most recently started worker with a fresh heartbeat', async () => {
    await worker('older', { startedAt: ago(600_000), lastHeartbeatAt: ago(2_000) });
    await worker('newer', { startedAt: ago(60_000), lastHeartbeatAt: ago(5_000) });
    await worker('restarted-silent', { startedAt: ago(1_000), lastHeartbeatAt: ago(90_000) });
    expect((await findLiveWorker(t.db))?.hostname).toBe('newer');
    // A tighter window leaves only the worker that heartbeated 2 s ago.
    expect((await findLiveWorker(t.db, 3_000))?.hostname).toBe('older');
    expect(await findLiveWorker(t.db, 1_000)).toBeNull();
  });
});
