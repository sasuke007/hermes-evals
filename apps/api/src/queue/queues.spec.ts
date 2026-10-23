/**
 * The queue contract the rest of the platform relies on, checked against
 * pg-boss itself running on an in-process Postgres (PGlite).
 */
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { fromDrizzle, fromPglite, PgBoss } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deferJob } from './defer.js';
import { ensureQueues } from './queue.service.js';
import { EXECUTE_RUN_EXPIRE_SECONDS, executeRunKey, QUEUES, type ExecuteRunJob } from './queues.js';

let pg: PGlite;
let db: PgliteDatabase;
let boss: PgBoss;

beforeEach(async () => {
  pg = new PGlite();
  db = drizzle(pg);
  boss = new PgBoss({
    db: fromPglite(pg),
    backend: 'pglite',
    schema: 'pgboss',
    supervise: false,
    schedule: false,
  });
  boss.on('error', () => {});
  await boss.start();
});

afterEach(async () => {
  await boss.stop({ graceful: false, timeout: 1000 });
  await pg.close();
});

const job = (runId: string, attempt: number): ExecuteRunJob => ({
  runId,
  attempt,
  trigger: attempt === 1 ? 'initial' : 'auto_retry',
});

describe('ensureQueues', () => {
  it('creates every queue with its policy and settings', async () => {
    await ensureQueues(boss);

    const execute = await boss.getQueue(QUEUES.executeRun);
    expect(execute).toMatchObject({
      policy: 'exclusive',
      retryLimit: 0,
      expireInSeconds: EXECUTE_RUN_EXPIRE_SECONDS,
      heartbeatSeconds: 30,
    });
    // Longer than the slowest attempt: 3600 s budget + 60 s grace + 10 s kill.
    expect(EXECUTE_RUN_EXPIRE_SECONDS).toBeGreaterThan(3600 + 60 + 10);

    const evaluate = await boss.getQueue(QUEUES.evaluateRun);
    expect(evaluate).toMatchObject({
      policy: 'exclusive',
      retryLimit: 2,
      deadLetter: QUEUES.evaluateRunDead,
    });
    expect(await boss.getQueue(QUEUES.evaluateRunDead)).toMatchObject({ policy: 'standard' });
    expect(await boss.getQueue(QUEUES.testMcpServer)).toMatchObject({ policy: 'exclusive' });
  });

  it('re-applies settings to queues that already exist', async () => {
    await ensureQueues(boss);
    await boss.updateQueue(QUEUES.executeRun, { expireInSeconds: 60 });
    await ensureQueues(boss);
    expect((await boss.getQueue(QUEUES.executeRun))?.expireInSeconds).toBe(
      EXECUTE_RUN_EXPIRE_SECONDS,
    );
  });

  it('refuses to start when an existing queue has another policy', async () => {
    await boss.createQueue(QUEUES.evaluateRunDead, { policy: 'standard' });
    await boss.createQueue(QUEUES.executeRun, { policy: 'standard' });
    await expect(ensureQueues(boss)).rejects.toThrow(/policy standard, expected exclusive/);
  });
});

describe('execute-run jobs', () => {
  it('hold one live job per run attempt', async () => {
    await ensureQueues(boss);
    const key = executeRunKey('run_1', 1);

    const first = await boss.send(QUEUES.executeRun, job('run_1', 1), { singletonKey: key });
    const duplicate = await boss.send(QUEUES.executeRun, job('run_1', 1), { singletonKey: key });
    const nextAttempt = await boss.send(QUEUES.executeRun, job('run_1', 2), {
      singletonKey: executeRunKey('run_1', 2),
    });
    expect(first).toBeTruthy();
    expect(duplicate).toBeNull();
    expect(nextAttempt).toBeTruthy();

    // While a worker holds the job the key stays taken; once it settles, it is free.
    const [claimed] = await boss.fetch<ExecuteRunJob>(QUEUES.executeRun);
    expect(claimed?.id).toBe(first);
    const whileActive = await boss.send(QUEUES.executeRun, job('run_1', 1), { singletonKey: key });
    expect(whileActive).toBeNull();
    await boss.complete(QUEUES.executeRun, claimed!.id);
    const afterCompletion = await boss.send(QUEUES.executeRun, job('run_1', 1), {
      singletonKey: key,
    });
    expect(afterCompletion).toBeTruthy();
  });

  it('commit with the transaction that sends them, and vanish when it rolls back', async () => {
    await ensureQueues(boss);
    await db.execute(sql`create table runs (id text primary key)`);

    let committed: string | null = null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`insert into runs values ('run_a')`);
      committed = await boss.send(QUEUES.executeRun, job('run_a', 1), {
        singletonKey: executeRunKey('run_a', 1),
        db: fromDrizzle(tx, sql),
      });
    });

    let rolledBack: string | null = null;
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`insert into runs values ('run_b')`);
        rolledBack = await boss.send(QUEUES.executeRun, job('run_b', 1), {
          singletonKey: executeRunKey('run_b', 1),
          db: fromDrizzle(tx, sql),
        });
        throw new Error('launch failed after enqueue');
      }),
    ).rejects.toThrow('launch failed after enqueue');

    expect(await boss.getJobById(QUEUES.executeRun, committed!)).not.toBeNull();
    expect(rolledBack).toBeTruthy();
    expect(await boss.getJobById(QUEUES.executeRun, rolledBack!)).toBeNull();
    const rows = await db.execute<{ id: string }>(sql`select id from runs order by id`);
    expect(rows.rows.map((r) => r.id)).toEqual(['run_a']);
  });

  // PGlite serialises queries, so this checks hand-out, not lock contention;
  // concurrent claiming is covered against real Postgres in the e2e suite.
  it('hand each job to exactly one of several batched fetches', async () => {
    await ensureQueues(boss);
    for (let i = 1; i <= 5; i++) {
      await boss.send(QUEUES.executeRun, job(`run_${i}`, 1), {
        singletonKey: executeRunKey(`run_${i}`, 1),
      });
    }
    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        boss.fetch<ExecuteRunJob>(QUEUES.executeRun, { batchSize: 2 }),
      ),
    );
    const claimed = claims.flat().map((j) => j.data.runId);
    expect(claimed).toHaveLength(5);
    expect(new Set(claimed).size).toBe(5);
  });

  it('can be put back for later from inside their own handler without being lost', async () => {
    await ensureQueues(boss);
    const key = executeRunKey('run_p', 1);
    await boss.send(QUEUES.executeRun, job('run_p', 1), { singletonKey: key });
    const [active] = await boss.fetch<ExecuteRunJob>(QUEUES.executeRun);

    // A plain re-send of the same key while the job is active is refused...
    expect(await boss.send(QUEUES.executeRun, active!.data, { singletonKey: key })).toBeNull();

    // ...so deferJob completes it and sends the delayed copy in one transaction.
    const deferredId = await db.transaction((tx) =>
      deferJob(boss, tx, QUEUES.executeRun, active!, { singletonKey: key, startAfterSeconds: 15 }),
    );
    expect((await boss.getJobById(QUEUES.executeRun, active!.id))?.state).toBe('completed');
    const deferred = await boss.getJobById<ExecuteRunJob>(QUEUES.executeRun, deferredId);
    expect(deferred?.state).toBe('created');
    expect(deferred?.data).toEqual(active!.data);
    expect(deferred!.startAfter.getTime()).toBeGreaterThan(Date.now() + 10_000);
    // Not fetchable before its start time.
    expect(await boss.fetch(QUEUES.executeRun)).toEqual([]);
  });
});
