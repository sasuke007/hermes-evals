/**
 * The lease keeper on PGlite: one statement renews every held lease, a
 * lease missing from the result aborts its attempt with LeaseLostError, the
 * cancel watcher aborts with CancelRequestedError, and shutdown with
 * WorkerShutdownError.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { attempts, runs } from '../../database/schema/index.js';
import { LeaseLostError, WorkerShutdownError } from '../contracts.js';
import { LeaseKeeper } from './leases.js';
import { claimAttempt, memoryLogger, seedLifecycle, seedWorker } from './testing.support-spec.js';
import { CancelRequestedError } from './types.js';

describe('LeaseKeeper', () => {
  let t: TestDatabase;
  let workerId: string;
  let keeper: LeaseKeeper;

  beforeEach(async () => {
    t = await createTestDatabase();
    workerId = await seedWorker(t.db);
    keeper = new LeaseKeeper(
      t.db,
      workerId,
      { leaseSeconds: 45, heartbeatIntervalMs: 60_000, cancelPollIntervalMs: 60_000 },
      memoryLogger(),
    );
  });
  afterEach(async () => {
    await keeper.stop();
    await t.close();
  });

  const secondsLeft = async (attemptId: string) =>
    (
      await t.db
        .select({ s: sql<number>`extract(epoch from ${attempts.leaseExpiresAt} - now())::float8` })
        .from(attempts)
        .where(eq(attempts.id, attemptId))
    )[0]!.s;

  it('renews every held lease in one statement and aborts the ones it no longer finds', async () => {
    const seed = await seedLifecycle(t.db, { repetitions: 2 });
    const [a, b, c] = await Promise.all(
      seed.runIds.slice(0, 3).map((runId) => claimAttempt(t.db, runId, workerId)),
    );
    const signals = [a!, b!, c!].map((x) => keeper.hold(x.attemptId, x.leaseToken));
    await t.db
      .update(attempts)
      .set({ leaseExpiresAt: sql`now() + interval '5 seconds'` })
      .where(eq(attempts.workerId, workerId));
    // b is revoked by recovery; c's token was replaced by a forged one in memory.
    await t.db
      .update(attempts)
      .set({ leaseRevokedAt: sql`now()` })
      .where(eq(attempts.id, b!.attemptId));
    keeper.release(c!.attemptId);
    const forged = keeper.hold(c!.attemptId, crypto.randomUUID());

    const lost = await keeper.renew();

    expect(lost.sort()).toEqual([b!.attemptId, c!.attemptId].sort());
    expect(await secondsLeft(a!.attemptId)).toBeGreaterThan(40);
    expect(signals[0]!.aborted).toBe(false);
    expect(signals[1]!.reason).toBeInstanceOf(LeaseLostError);
    expect(forged.reason).toBeInstanceOf(LeaseLostError);
    expect(keeper.count).toBe(3);
  });

  it('aborts attempts whose run has a cancel request, once', async () => {
    const seed = await seedLifecycle(t.db);
    const [a, b] = await Promise.all(
      seed.runIds.map((runId) => claimAttempt(t.db, runId, workerId)),
    );
    const sa = keeper.hold(a!.attemptId, a!.leaseToken);
    const sb = keeper.hold(b!.attemptId, b!.leaseToken);
    await t.db
      .update(runs)
      .set({ cancelRequestedAt: sql`now()` })
      .where(eq(runs.id, a!.runId));
    expect(await keeper.pollCancels()).toEqual([a!.attemptId]);
    expect(sa.reason).toBeInstanceOf(CancelRequestedError);
    expect(sb.aborted).toBe(false);
    expect(await keeper.pollCancels()).toEqual([]);
  });

  it('aborts with LeaseLostError when recovery revokes a held attempt', async () => {
    const seed = await seedLifecycle(t.db);
    const a = await claimAttempt(t.db, seed.runIds[0]!, workerId);
    const signal = keeper.hold(a.attemptId, a.leaseToken);
    expect(keeper.revoked(a.attemptId)).toBe(true);
    expect(signal.reason).toBeInstanceOf(LeaseLostError);
    expect(keeper.revoked(a.attemptId)).toBe(false);
    expect(keeper.revoked('unknown')).toBe(false);
  });

  it('aborts every attempt on shutdown, and every one held after it', async () => {
    const seed = await seedLifecycle(t.db);
    const a = await claimAttempt(t.db, seed.runIds[0]!, workerId);
    const signal = keeper.hold(a.attemptId, a.leaseToken);
    keeper.shutdown();
    expect(signal.reason).toBeInstanceOf(WorkerShutdownError);
    expect(keeper.hold('late', 'token').reason).toBeInstanceOf(WorkerShutdownError);
  });

  it('queries nothing while it holds nothing, and survives a failing database', async () => {
    expect(await keeper.renew()).toEqual([]);
    expect(await keeper.pollCancels()).toEqual([]);
    const logger = memoryLogger();
    const broken = new LeaseKeeper(
      t.db,
      workerId,
      { leaseSeconds: 45, heartbeatIntervalMs: 60_000, cancelPollIntervalMs: 60_000 },
      logger,
    );
    // Not a uuid: the statement fails, and nothing is aborted.
    const signal = broken.hold('attempt', 'not-a-uuid');
    expect(await broken.renew()).toEqual([]);
    expect(signal.aborted).toBe(false);
    expect(logger.lines.map((l) => l.msg)).toContain(
      'lease renewal failed; retrying on the next heartbeat',
    );
  });
});
