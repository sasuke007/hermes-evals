/**
 * sendAndWait against pg-boss on a real Postgres 17 server: a worker's return
 * value comes back as the reply, identical requests share one live job, and
 * a timeout leaves the job running for the next request to join.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureQueues } from './queue.service.js';
import { QUEUES, testMcpServerKey, type LoadSuitesJob, type TestMcpServerJob } from './queues.js';
import { findLiveJob, JobWaitTimeout, sendAndWait, sendOrJoin } from './send-and-wait.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

/** A promise the test resolves by hand, to hold a handler while the job is active. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe.skipIf(!SERVER_URL)('sendAndWait on Postgres 17', () => {
  const database = `hermes_evals_queue_e2e_${process.pid}`;
  let boss: PgBoss;

  const admin = async (statement: string) => {
    const client = new pg.Client({ connectionString: SERVER_URL });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    await admin(`drop database if exists ${database}`);
    await admin(`create database ${database}`);
    const url = new URL(SERVER_URL!);
    url.pathname = `/${database}`;
    boss = new PgBoss({
      connectionString: url.toString(),
      schema: 'pgboss',
      supervise: false,
      schedule: false,
    });
    boss.on('error', () => {});
    await boss.start();
    await ensureQueues(boss);
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false, timeout: 1000 });
    await admin(`drop database if exists ${database} with (force)`);
  });

  const work = <T>(queue: string, handler: (data: T) => Promise<unknown>) =>
    boss.work<T>(queue, { pollingIntervalSeconds: 0.5 }, async ([job]) =>
      job ? handler(job.data) : undefined,
    );

  it('returns what the handler returned as the job output', async () => {
    await work<LoadSuitesJob>(QUEUES.loadSuites, async (data) => ({
      reloaded: data.path ?? 'all',
    }));
    try {
      const all = await sendAndWait(
        boss,
        QUEUES.loadSuites,
        { path: null } satisfies LoadSuitesJob,
        {
          singletonKey: '*',
          timeoutMs: 15_000,
          pollMs: 100,
        },
      );
      expect(all).toMatchObject({ state: 'completed', output: { reloaded: 'all' } });
      // The key is free once the job settles, so the next request is a new job.
      const again = await sendAndWait(
        boss,
        QUEUES.loadSuites,
        { path: null },
        {
          singletonKey: '*',
          timeoutMs: 15_000,
          pollMs: 100,
        },
      );
      expect(again.jobId).not.toBe(all.jobId);
    } finally {
      await boss.offWork(QUEUES.loadSuites);
    }
  });

  it('wraps a return value that is not an object as { value }', async () => {
    await work<LoadSuitesJob>(QUEUES.loadSuites, async () => 3);
    try {
      const outcome = await sendAndWait(
        boss,
        QUEUES.loadSuites,
        { path: 'invoices-v1' },
        {
          singletonKey: 'invoices-v1',
          timeoutMs: 15_000,
          pollMs: 100,
        },
      );
      expect(outcome).toMatchObject({ state: 'completed', output: { value: 3 } });
    } finally {
      await boss.offWork(QUEUES.loadSuites);
    }
  });

  it('lets a second identical request wait on the live job instead of sending another', async () => {
    const held = gate();
    const started = gate();
    let calls = 0;
    await work<LoadSuitesJob>(QUEUES.loadSuites, async () => {
      calls++;
      started.open();
      await held.opened;
      return { calls };
    });
    try {
      const options = { singletonKey: 'shared', timeoutMs: 15_000, pollMs: 100 };
      const first = sendAndWait(boss, QUEUES.loadSuites, { path: 'shared' }, options);
      await started.opened;
      const second = sendAndWait(boss, QUEUES.loadSuites, { path: 'shared' }, options);
      // Give the second request time to find the live job before it settles.
      await new Promise((resolve) => setTimeout(resolve, 300));
      held.open();
      const [a, b] = await Promise.all([first, second]);
      expect(b.jobId).toBe(a.jobId);
      expect(a).toMatchObject({ state: 'completed', output: { calls: 1 } });
      expect(b.output).toEqual(a.output);
      expect(calls).toBe(1);
    } finally {
      await boss.offWork(QUEUES.loadSuites);
    }
  });

  it('with joinActive false, joins a created job but waits out an active one and sends anew', async () => {
    // No worker yet: the first job stays created, and a second request joins it.
    const created = await sendOrJoin(boss, QUEUES.loadSuites, { path: 'fresh' }, 'fresh', {
      joinActive: false,
    });
    expect(
      await sendOrJoin(boss, QUEUES.loadSuites, { path: 'fresh' }, 'fresh', { joinActive: false }),
    ).toBe(created);

    const held = gate();
    const started = gate();
    const events: string[] = [];
    let calls = 0;
    const options = { singletonKey: 'fresh', timeoutMs: 15_000, pollMs: 100, joinActive: false };
    // Joins the created job before any worker can take it.
    const first = sendAndWait(boss, QUEUES.loadSuites, { path: 'fresh' }, options);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await work<LoadSuitesJob>(QUEUES.loadSuites, async () => {
      const call = ++calls;
      events.push(`start ${call}`);
      if (call === 1) {
        started.open();
        await held.opened;
      }
      events.push(`end ${call}`);
      return { call };
    });
    try {
      await started.opened;
      // Sent while the job is active: it may have read the files already.
      const second = sendAndWait(boss, QUEUES.loadSuites, { path: 'fresh' }, options);
      await new Promise((resolve) => setTimeout(resolve, 300));
      held.open();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toMatchObject({ jobId: created, state: 'completed', output: { call: 1 } });
      expect(b.jobId).not.toBe(a.jobId);
      expect(b).toMatchObject({ state: 'completed', output: { call: 2 } });
      expect(events).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    } finally {
      held.open();
      await boss.offWork(QUEUES.loadSuites);
    }
  });

  it('reports a handler that throws as failed, with its message', async () => {
    await work<LoadSuitesJob>(QUEUES.loadSuites, async () => {
      throw new Error('suites directory is not readable');
    });
    try {
      const outcome = await sendAndWait(
        boss,
        QUEUES.loadSuites,
        { path: 'broken' },
        {
          singletonKey: 'broken',
          timeoutMs: 15_000,
          pollMs: 100,
        },
      );
      expect(outcome.state).toBe('failed');
      expect(outcome.output).toMatchObject({ message: 'suites directory is not readable' });
    } finally {
      await boss.offWork(QUEUES.loadSuites);
    }
  });

  it('times out while the job stays live, and the next request joins that same job', async () => {
    const job: TestMcpServerJob = {
      kind: 'saved',
      mcpServerVersionId: '01JTIMEOUT000000000000000',
      definitionHash: 'a'.repeat(64),
    };
    const options = { singletonKey: testMcpServerKey(job), timeoutMs: 400, pollMs: 100 };
    // No worker on test-mcp-server yet: the job stays created.
    const timedOut = await sendAndWait(boss, QUEUES.testMcpServer, job, options).catch(
      (err: unknown) => err,
    );
    expect(timedOut).toBeInstanceOf(JobWaitTimeout);
    const { jobId } = timedOut as JobWaitTimeout;
    expect((await findLiveJob(boss, QUEUES.testMcpServer, options.singletonKey))?.id).toBe(jobId);

    // A worker that holds the job until the test lets go: an instant handler
    // could finish it before the next request looks, which would then start a new job.
    const held = gate();
    await work<TestMcpServerJob>(QUEUES.testMcpServer, async () => {
      await held.opened;
      return { status: 'passed' };
    });
    try {
      while (
        (await findLiveJob(boss, QUEUES.testMcpServer, options.singletonKey))?.state !== 'active'
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const joined = sendAndWait(boss, QUEUES.testMcpServer, job, {
        ...options,
        timeoutMs: 15_000,
      });
      // Joining is sendAndWait's first query; the job cannot settle before the gate opens.
      await new Promise((resolve) => setTimeout(resolve, 300));
      held.open();
      expect(await joined).toMatchObject({
        jobId,
        state: 'completed',
        output: { status: 'passed' },
      });
    } finally {
      held.open();
      await boss.offWork(QUEUES.testMcpServer);
    }
  });

  it('reports a cancelled job as cancelled', async () => {
    const job: TestMcpServerJob = {
      kind: 'saved',
      mcpServerVersionId: '01JCANCEL0000000000000000',
      definitionHash: 'a'.repeat(64),
    };
    const singletonKey = testMcpServerKey(job);
    const waiting = sendAndWait(boss, QUEUES.testMcpServer, job, {
      singletonKey,
      timeoutMs: 15_000,
      pollMs: 100,
    });
    let live = null;
    while (!live) live = await findLiveJob(boss, QUEUES.testMcpServer, singletonKey);
    await boss.cancel(QUEUES.testMcpServer, live.id);
    expect(await waiting).toMatchObject({ jobId: live.id, state: 'cancelled' });
  });
});
