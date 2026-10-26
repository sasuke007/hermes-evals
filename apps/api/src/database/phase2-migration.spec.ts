/**
 * Migration 0004 (Phase 2 execution): the provider guard's pause reason, the
 * development host login on the workers row, and recovery's right to close
 * the event stream of an attempt whose lease it revoked. Checked on a fresh
 * database, and on one migrated by the Phase 1 build that already holds a
 * paused experiment, a worker and a revoked attempt.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { RunEventPayloadSchema, type RunEventPayload } from '@hermes-evals/shared';
import {
  createTestDatabase,
  createTestDatabaseUpTo,
  rejection,
  SQLSTATE,
  type TestDatabase,
  type TestDb,
} from '../../test/support/database.js';
import {
  blob,
  HERMES_REVISION,
  seedExperiment,
  sha,
  startAttempt,
} from '../../test/support/seed.js';
import { newId } from './ids.js';
import {
  artifacts,
  attempts,
  configurations,
  experiments,
  runEvents,
  runs,
  suites,
  tasks,
  workers,
} from './schema/index.js';

let t: TestDatabase | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

const event = (attemptId: string, seq: number, payload: RunEventPayload) => ({
  attemptId,
  seq,
  ts: 1_792_800_000_000 + seq,
  type: payload.type,
  payload: RunEventPayloadSchema.parse(payload),
});

const revoke = (db: TestDb, attemptId: string) =>
  db.update(attempts).set({ leaseRevokedAt: new Date() }).where(eq(attempts.id, attemptId));

describe('migration 0004 rules', () => {
  it('pauses for a disconnected provider, and still refuses an unknown reason', async () => {
    t = await createTestDatabase();
    const seed = await seedExperiment(t.db);
    const pause = (reason: string) =>
      t!.pg.query(
        `update experiments set status = 'paused', pause_reason = '${reason}', paused_at = now() where id = '${seed.experiment.id}'`,
      );
    await pause('provider_disconnected');
    expect((await rejection(pause('provider_gone'))).code).toBe(SQLSTATE.checkViolation);
  });

  it('records the host proxy as null or a complete answer', async () => {
    t = await createTestDatabase();
    const seed = await seedExperiment(t.db);
    await t.db
      .update(workers)
      .set({
        hostProxy: {
          target: 'host.lima.internal:8645',
          reachable: false,
          checked_at: '2026-10-24T10:00:00.000Z',
        },
      })
      .where(eq(workers.id, seed.worker.id));
    for (const value of [
      '{"reachable": true, "checked_at": "2026-10-24T10:00:00Z"}',
      '{"target": "h:1", "reachable": "yes", "checked_at": "2026-10-24T10:00:00Z"}',
      '{"target": "h:1", "reachable": true}',
      '[]',
    ]) {
      const refused = await rejection(
        t.pg.query(`update workers set host_proxy = '${value}' where id = '${seed.worker.id}'`),
      );
      expect(refused.code, value).toBe(SQLSTATE.checkViolation);
    }
    await t.db.update(workers).set({ hostProxy: null }).where(eq(workers.id, seed.worker.id));
  });

  it('stores network events while the attempt is owned', async () => {
    t = await createTestDatabase();
    const seed = await seedExperiment(t.db);
    const attemptId = await startAttempt(t.db, seed.runs[0]!.id, seed.worker.id);
    await t.db.insert(runEvents).values([
      event(attemptId, 1, {
        type: 'platform',
        subtype: 'network',
        kind: 'connect',
        host: 'inference-api.nousresearch.com',
        port: 443,
        decision: 'denied',
        reason: 'allowlist',
        background: true,
      }),
      event(attemptId, 2, {
        type: 'platform',
        subtype: 'network',
        kind: 'mcp',
        server: 'vendor',
        host: 'mcp.example.com',
        decision: 'allowed',
        status: 200,
        ms: 41,
        background: false,
      }),
    ]);
    const stored = await t.db.select().from(runEvents).where(eq(runEvents.attemptId, attemptId));
    expect(stored.map((row) => RunEventPayloadSchema.parse(row.payload))).toHaveLength(2);
  });

  it('lets recovery close a revoked attempt’s timeline, and nothing else in', async () => {
    t = await createTestDatabase();
    const seed = await seedExperiment(t.db);
    const attemptId = await startAttempt(t.db, seed.runs[0]!.id, seed.worker.id);
    await t.db.insert(runEvents).values(event(attemptId, 1, { type: 'text', text: 'working' }));
    await revoke(t.db, attemptId);

    // The old owner's output and every other subtype stay out.
    for (const [seq, payload] of [
      [2, { type: 'text', text: 'still running' }],
      [2, { type: 'platform', subtype: 'killed' }],
      [2, { type: 'platform', subtype: 'collected' }],
      [
        2,
        {
          type: 'platform',
          subtype: 'network',
          kind: 'model',
          decision: 'allowed',
          background: false,
        },
      ],
    ] as const) {
      const refused = await rejection(
        t.db.insert(runEvents).values(event(attemptId, seq, payload)),
      );
      expect(refused.code, payload.type).toBe(SQLSTATE.restrictViolation);
    }
    const artifact = await rejection(
      t.db.insert(artifacts).values({
        attemptId,
        path: 'late.csv',
        origin: 'agent',
        size: 1,
        sha256: await blob(t.db, 'late'),
      }),
    );
    expect(artifact.code).toBe(SQLSTATE.restrictViolation);

    // Recovery's own events, then the end of the attempt.
    await t.db
      .insert(runEvents)
      .values([
        event(attemptId, 2, { type: 'platform', subtype: 'worker_lost' }),
        event(attemptId, 3, { type: 'platform', subtype: 'cancelled' }),
      ]);
    await t.db
      .update(attempts)
      .set({
        status: 'execution_error',
        errorCategory: 'worker_lost',
        errorMessage: 'worker lost',
        finishedAt: new Date(),
      })
      .where(eq(attempts.id, attemptId));
    const finished = await rejection(
      t.db
        .insert(runEvents)
        .values(event(attemptId, 4, { type: 'platform', subtype: 'worker_lost' })),
    );
    expect(finished.code).toBe(SQLSTATE.restrictViolation);
  });
});

/** What the Phase 1 build stored: a paused experiment, a worker and a revoked attempt with one event. */
async function seedPhase1Rows(
  db: TestDatabase,
): Promise<{ experimentId: string; attemptId: string }> {
  // workers gains a column in 0004, so the Phase 1 row is written in SQL.
  await db.pg.exec(`
    insert into workers (id, hostname, concurrency, slots, hermes_version, hermes_revision)
      values ('W1', 'worker-1', 3, 4, '0.22.4', '${HERMES_REVISION}');
  `);
  const [suite] = await db.db
    .insert(suites)
    .values({
      sourcePath: 'invoices-v1',
      versionNumber: 1,
      name: 'invoices-v1',
      versionLabel: '1',
      contentHash: sha('suite'),
      checkHash: sha('checks'),
      taskCount: 1,
      validCount: 1,
    })
    .returning();
  const [task] = await db.db
    .insert(tasks)
    .values({
      suiteId: suite!.id,
      key: 'total_due',
      versionNumber: 1,
      introducedInSuiteId: suite!.id,
      position: 0,
      summary: 'Total due',
      prompt: 'Total. Reply with a fenced JSON block.',
      limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file'] },
      reference: { total: 1042 },
      verification: [{ key: 'total', type: 'numeric_tolerance', primary: true, params: {} }],
      selfCheck: { status: 'skipped', ran_at: null, duration_ms: null, results: [] },
      valid: true,
      contentHash: sha('task'),
    })
    .returning();
  // Raw SQL: the Drizzle table names columns later migrations add (skill_loading, 0008).
  const versionIds = await db.db.transaction(async (tx) => {
    const ids: string[] = [];
    for (const name of ['baseline', 'candidate']) {
      const [configuration] = await tx.insert(configurations).values({ name }).returning();
      const id = newId();
      await tx.execute(sql`
        insert into configuration_versions
          (id, configuration_id, version, model, provider, base_url, max_turns, time_budget_s, config_hash, frozen_at)
        values (${id}, ${configuration!.id}, 1, 'scripted', 'custom', 'http://mock-model:8090/v1',
          20, 300, ${sha(name)}, now())`);
      ids.push(id);
    }
    return ids;
  });
  const [experiment] = await db.db
    .insert(experiments)
    .values({
      name: 'Phase 1 leftover',
      suiteId: suite!.id,
      taskIds: [task!.id],
      baselineVersionId: versionIds[0]!,
      candidateVersionIds: [versionIds[1]!],
      repetitions: 1,
      concurrency: 1,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      priceTable: { sha256: sha('prices'), loaded_at: '2026-10-24T09:00:00.000Z', models: {} },
    })
    .returning();
  // Raw SQL: the Drizzle table names columns later migrations add (runs.next_trigger).
  const runId = newId();
  await db.pg.query(
    `insert into runs (id, experiment_id, task_id, configuration_version_id, repetition)
     values ($1, $2, $3, $4, 1)`,
    [runId, experiment!.id, task!.id, versionIds[0]!],
  );
  const attemptId = await startAttempt(db.db, runId, 'W1');
  await db.db.insert(runEvents).values(event(attemptId, 1, { type: 'text', text: 'working' }));
  await revoke(db.db, attemptId);
  await db.pg.query(
    `update experiments set status = 'paused', pause_reason = 'user', paused_at = now() where id = '${experiment!.id}'`,
  );
  return { experimentId: experiment!.id, attemptId };
}

describe('migration 0005 rules', () => {
  it('records the next attempt trigger of a queued run, and refuses an unknown one', async () => {
    t = await createTestDatabase();
    const seed = await seedExperiment(t.db);
    const [run] = await t.db.select().from(runs).where(eq(runs.experimentId, seed.experiment.id));
    expect(run!.nextTrigger).toBeNull();
    for (const trigger of ['initial', 'auto_retry', 'recovery', 'user_retry', 'retry_failed']) {
      await t.pg.query(`update runs set next_trigger = '${trigger}' where id = '${run!.id}'`);
    }
    const bad = t.pg.query(`update runs set next_trigger = 'whim' where id = '${run!.id}'`);
    expect((await rejection(bad)).code).toBe(SQLSTATE.checkViolation);
  });

  it('stores a file skipped for the collection budget, without content', async () => {
    t = await createTestDatabase();
    const seed = await seedExperiment(t.db);
    const [run] = await t.db.select().from(runs).where(eq(runs.experimentId, seed.experiment.id));
    const attemptId = await startAttempt(t.db, run!.id, seed.worker.id);
    await t.db.insert(artifacts).values({
      attemptId,
      path: 'f2',
      origin: 'agent',
      size: 25 * 1024 * 1024,
      sha256: null,
      skippedReason: 'over_budget',
    });
    const withContent = t.db.insert(artifacts).values({
      attemptId,
      path: 'f3',
      origin: 'agent',
      size: 1,
      sha256: await blob(t.db, 'x'),
      skippedReason: 'over_budget',
    });
    expect((await rejection(withContent)).code).toBe(SQLSTATE.checkViolation);
  });
});

describe('migration 0004 on a Phase 1 database', () => {
  it(
    'keeps every row, adds no value, and swaps only the run_events trigger',
    { timeout: 30_000 },
    async () => {
      const partial = await createTestDatabaseUpTo('0003_phase1_worker_slots');
      t = partial;
      const { experimentId, attemptId } = await seedPhase1Rows(partial);

      await partial.migrateRest();

      const [worker] = await partial.db.select().from(workers).where(eq(workers.id, 'W1'));
      expect(worker!.hostProxy).toBeNull();
      const [experiment] = await partial.db
        .select()
        .from(experiments)
        .where(eq(experiments.id, experimentId));
      expect(experiment!.pauseReason).toBe('user');
      await partial.db
        .update(experiments)
        .set({ pauseReason: 'provider_disconnected' })
        .where(eq(experiments.id, experimentId));

      const functions = await partial.pg.query<{ tgname: string; proname: string }>(
        `select t.tgname, p.proname from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgname in ('run_events_require_open_attempt', 'artifacts_require_open_attempt')
        order by 1`,
      );
      expect(functions.rows).toEqual([
        { tgname: 'artifacts_require_open_attempt', proname: 'hermes_require_open_attempt' },
        {
          tgname: 'run_events_require_open_attempt',
          proname: 'hermes_run_events_require_open_attempt',
        },
      ]);
      const disabled = await partial.pg.query(
        `select tgname from pg_trigger where not tgisinternal and tgenabled = 'D'`,
      );
      expect(disabled.rows).toEqual([]);

      // The attempt revoked before the upgrade: recovery may now close its timeline.
      const late = await rejection(
        partial.db.insert(runEvents).values(event(attemptId, 2, { type: 'text', text: 'late' })),
      );
      expect(late.code).toBe(SQLSTATE.restrictViolation);
      await partial.db
        .insert(runEvents)
        .values(event(attemptId, 2, { type: 'platform', subtype: 'worker_lost' }));
      const stored = await partial.db
        .select({ seq: runEvents.seq })
        .from(runEvents)
        .where(eq(runEvents.attemptId, attemptId));
      expect(stored.map((row) => row.seq).toSorted((a, b) => a - b)).toEqual([1, 2]);
    },
  );
});
