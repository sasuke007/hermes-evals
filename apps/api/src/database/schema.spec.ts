import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VerdictEntry } from '@hermes-evals/shared';
import {
  createTestDatabase,
  rejection,
  SQLSTATE,
  type TestDatabase,
} from '../../test/support/database.js';
import {
  blob,
  finishAttempt,
  runningClaim,
  seedExperiment,
  sha,
  startAttempt,
} from '../../test/support/seed.js';
import {
  compareMigrations,
  MIGRATIONS_FOLDER,
  migrationsInSync,
  readMigrations,
} from './migrator.js';
import { toJsonb } from './schema/_columns.js';
import {
  artifacts,
  attempts,
  configurationVersions,
  configurations,
  documents,
  evaluations,
  experiments,
  mcpServerVersions,
  mcpServers,
  runEvents,
  runs,
  scores,
  skills,
  suiteSources,
  suites,
  taskFiles,
  tasks,
} from './schema/index.js';

const TABLES = [
  'artifacts',
  'attempts',
  'blobs',
  'configuration_versions',
  'configurations',
  'documents',
  'evaluations',
  'experiments',
  'mcp_server_versions',
  'mcp_servers',
  'run_events',
  'runs',
  'scores',
  'skills',
  'suite_sources',
  'suites',
  'task_files',
  'tasks',
  'workers',
];

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
});

afterEach(async () => {
  await t.close();
});

/** Inserts an unfrozen configuration version and returns its id. */
async function draftVersion(
  name: string,
  overrides: Partial<typeof configurationVersions.$inferInsert> = {},
): Promise<string> {
  return t.db.transaction(async (tx) => {
    const [configuration] = await tx.insert(configurations).values({ name }).returning();
    const [version] = await tx
      .insert(configurationVersions)
      .values({
        configurationId: configuration!.id,
        version: 1,
        model: 'openai/gpt-6.1-sol',
        provider: 'nous',
        maxTurns: 20,
        timeBudgetS: 300,
        configHash: sha(name),
        ...overrides,
      })
      .returning();
    return version!.id;
  });
}

/** Inserts a stdio MCP definition, creating the server identity on first use. */
async function stdioServer(name: string, version = 1): Promise<string> {
  return t.db.transaction(async (tx) => {
    await tx.insert(mcpServers).values({ name, latestVersion: version }).onConflictDoNothing();
    const [server] = await tx.select().from(mcpServers).where(eq(mcpServers.name, name));
    const [definition] = await tx
      .insert(mcpServerVersions)
      .values({
        mcpServerId: server!.id,
        version,
        transport: 'stdio',
        command: 'node',
        args: ['examples/invoice-db-mcp.js'],
        envNames: ['INVOICE_DB_URL'],
        definitionHash: sha(`${name} v${version}`),
      })
      .returning();
    await tx
      .update(mcpServers)
      .set({ latestVersion: version })
      .where(eq(mcpServers.id, server!.id));
    return definition!.id;
  });
}

describe('migrations', () => {
  it('apply every migration on a fresh database and create all tables', async () => {
    const recorded = await t.pg.query<{ hash: string }>(
      'select hash from drizzle.__drizzle_migrations order by id',
    );
    const report = compareMigrations(
      readMigrations(),
      recorded.rows.map((r) => r.hash),
    );
    expect(migrationsInSync(report)).toBe(true);
    expect(readMigrations().map((m) => m.tag)).toEqual([
      '0000_init',
      '0001_integrity_triggers',
      '0002_phase1_definitions',
      '0003_phase1_worker_slots',
      '0004_phase2_execution',
      '0005_phase2_review',
      '0006_phase3_scoring',
    ]);
    const tables = await t.pg.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(TABLES);
  });

  it('contain literal values, never bind placeholders', () => {
    for (const file of readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql'))) {
      const text = readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8');
      expect(text, file).not.toMatch(/\$\d+/);
    }
  });

  it('are compared with the database by hash, not only by count', () => {
    const files = [
      { tag: '0000_init', hash: 'a' },
      { tag: '0001_triggers', hash: 'b' },
    ];
    expect(compareMigrations(files, ['a', 'b'])).toEqual({
      available: 2,
      applied: 2,
      mismatch: null,
    });
    expect(compareMigrations(files, ['a', 'x']).mismatch).toBe('0001_triggers');
    expect(migrationsInSync(compareMigrations(files, ['a']))).toBe(false);
    expect(migrationsInSync(compareMigrations(files, ['a', 'b', 'c']))).toBe(false);
  });
});

describe('column types', () => {
  it('round-trip through Drizzle with the types the code expects', async () => {
    const seed = await seedExperiment(t.db);
    const attemptId = await startAttempt(t.db, seed.runs[0]!.id, seed.worker.id);
    await t.db.insert(runEvents).values({
      attemptId,
      seq: 1,
      ts: 1_792_774_882_086,
      type: 'platform',
      payload: { type: 'platform', subtype: 'started' },
    });
    await finishAttempt(t.db, seed.runs[0]!.id, attemptId);

    const [task] = await t.db.select().from(tasks).where(eq(tasks.id, seed.task.id));
    // A JSON string that looks like a number stays a string.
    expect(task!.reference).toBe('1042');
    expect(task!.limits).toEqual({
      max_turns: 20,
      run_budget_seconds: 300,
      toolsets_needed: ['file'],
    });

    const [experiment] = await t.db.select().from(experiments);
    expect(experiment!.spendCeilingUsd).toBe(5);
    expect(experiment!.taskIds).toEqual([seed.task.id]);
    expect(experiment!.verdictHistory).toEqual([]);
    expect(experiment!.createdAt).toBeInstanceOf(Date);

    const [attempt] = await t.db.select().from(attempts).where(eq(attempts.id, attemptId));
    expect(attempt!.costUsd).toBe(0.0045);
    expect(attempt!.tokens?.total).toBe(1500);

    const [event] = await t.db.select().from(runEvents);
    expect(event!.ts).toBe(1_792_774_882_086);
    expect(event!.payload).toEqual({ type: 'platform', subtype: 'started' });

    const [file] = await t.db.select().from(taskFiles);
    expect(file!.size).toBe(2048);
  });

  it('store JSON null and no value differently, and read both back as null', async () => {
    const seed = await seedExperiment(t.db);
    const run = seed.runs[0]!;
    const attemptId = await startAttempt(t.db, run.id, seed.worker.id);
    await finishAttempt(t.db, run.id, attemptId);
    const [evaluation] = await t.db
      .insert(evaluations)
      .values({
        runId: run.id,
        attemptId,
        cause: 'initial',
        generation: 1,
        ...runningClaim(),
      })
      .returning();
    const base = {
      evaluationId: evaluation!.id,
      type: 'json_match' as const,
      status: 'failed' as const,
      score: 0,
      comment: 'mismatch',
      scorerVersion: 1,
    };
    await t.db.insert(scores).values([
      { ...base, key: 'answered_null', isPrimary: true, expected: 'abc', observed: toJsonb(null) },
      { ...base, key: 'no_value', observed: null },
    ]);
    const typed = await t.pg.query<{ key: string; observed: string | null }>(
      'select key, jsonb_typeof(observed) as observed from scores order by key',
    );
    expect(typed.rows).toEqual([
      { key: 'answered_null', observed: 'null' },
      { key: 'no_value', observed: null },
    ]);
    const read = await t.db
      .select({ key: scores.key, observed: scores.observed, expected: scores.expected })
      .from(scores)
      .orderBy(scores.key);
    expect(read).toEqual([
      { key: 'answered_null', observed: null, expected: 'abc' },
      { key: 'no_value', observed: null, expected: null },
    ]);
  });

  it('make agent text storable: NUL and lone surrogates become U+FFFD', async () => {
    const seed = await seedExperiment(t.db);
    const run = seed.runs[0]!;
    const attemptId = await startAttempt(t.db, run.id, seed.worker.id);
    const nasty = 'a\u0000b\uD83Dc';
    await t.db.insert(runEvents).values({
      attemptId,
      seq: 1,
      ts: 1,
      type: 'tool_result',
      payload: { type: 'tool_result', name: 'terminal', output: nasty, [`k${nasty}`]: 1 },
    });
    await t.db.update(attempts).set({ stderrTail: nasty }).where(eq(attempts.id, attemptId));
    const [event] = await t.db.select().from(runEvents);
    expect((event!.payload as Record<string, unknown>).output).toBe('a�b�c');
    expect(Object.keys(event!.payload)).toContain('ka�b�c');
    const [attempt] = await t.db.select().from(attempts);
    expect(attempt!.stderrTail).toBe('a�b�c');
  });
});

describe('constraints', () => {
  it('reject values outside a vocabulary', async () => {
    const seed = await seedExperiment(t.db);
    const error = await rejection(
      t.db.insert(taskFiles).values({
        taskId: seed.task.id,
        path: 'README.md',
        kind: 'readme' as unknown as 'fixture', // deliberately outside the vocabulary
        sha256: sha('readme'),
        size: 1,
      }),
    );
    expect(error.code).toBe(SQLSTATE.checkViolation);
    expect(error.message).toMatch(/task_files_kind_ck/);
  });

  it('keep the run matrix unique', async () => {
    const seed = await seedExperiment(t.db);
    const run = seed.runs[0]!;
    const error = await rejection(
      t.db.insert(runs).values({
        experimentId: run.experimentId,
        taskId: run.taskId,
        configurationVersionId: run.configurationVersionId,
        repetition: run.repetition,
      }),
    );
    expect(error.code).toBe(SQLSTATE.uniqueViolation);
  });

  it('number attempts once per run, one running at a time, attempt 1 initial', async () => {
    const seed = await seedExperiment(t.db);
    const run = seed.runs[0]!;
    await startAttempt(t.db, run.id, seed.worker.id);
    const attempt = (number: number, trigger: 'initial' | 'user_retry', trialPath: string) => ({
      runId: run.id,
      number,
      trigger,
      status: 'running' as const,
      workerId: seed.worker.id,
      trialPath,
    });
    const duplicate = await rejection(
      t.db.insert(attempts).values(attempt(1, 'initial', 'trials/x')),
    );
    expect(duplicate.code).toBe(SQLSTATE.uniqueViolation);
    const wrongTrigger = await rejection(
      t.db.insert(attempts).values(attempt(2, 'initial', 'trials/x')),
    );
    expect(wrongTrigger.message).toMatch(/attempts_initial_ck/);
    const firstNotInitial = await rejection(
      t.db.insert(attempts).values(attempt(1, 'user_retry', 'trials/y')),
    );
    expect(firstNotInitial.code).toBe(SQLSTATE.checkViolation);
    const secondRunning = await rejection(
      t.db.insert(attempts).values(attempt(2, 'user_retry', 'trials/x')),
    );
    expect(secondRunning.message).toMatch(/attempts_one_running_uq/);
  });

  it('keep run status, attempt pointer and finish time consistent', async () => {
    const seed = await seedExperiment(t.db);
    const run = seed.runs[0]!;
    const other = seed.runs[1]!;
    const noAttempt = await rejection(
      t.db.update(runs).set({ status: 'running' }).where(eq(runs.id, run.id)),
    );
    expect(noAttempt.message).toMatch(/runs_attempt_present_ck/);
    const countWithoutPointer = await rejection(
      t.db.update(runs).set({ attemptCount: 1 }).where(eq(runs.id, run.id)),
    );
    expect(countWithoutPointer.message).toMatch(/runs_attempt_pointer_ck/);
    const notFinished = await rejection(
      t.db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, run.id)),
    );
    expect(notFinished.message).toMatch(/runs_finished_ck/);

    const attemptId = await startAttempt(t.db, run.id, seed.worker.id);
    const borrowed = await rejection(
      t.db
        .update(runs)
        .set({ status: 'running', attemptCount: 1, currentAttemptId: attemptId })
        .where(eq(runs.id, other.id)),
    );
    expect(borrowed.code).toBe(SQLSTATE.foreignKeyViolation);
  });

  it('require the matching shape for each MCP transport', async () => {
    const error = await rejection(
      t.db.transaction(async (tx) => {
        const [server] = await tx.insert(mcpServers).values({ name: 'invoice-db' }).returning();
        await tx.insert(mcpServerVersions).values({
          mcpServerId: server!.id,
          version: 1,
          transport: 'http',
          command: 'node',
          url: 'https://mcp.example.com/',
          definitionHash: sha('def'),
        });
      }),
    );
    expect(error.message).toMatch(/mcp_server_versions_shape_ck/);
  });

  it('refuse credentials embedded in a provider base URL', async () => {
    const error = await rejection(
      draftVersion('custom', {
        provider: 'custom',
        baseUrl: 'https://user:secret@llm.example.com/v1',
      }),
    );
    expect(error.message).toMatch(/configuration_versions_base_url_ck/);
    await draftVersion('custom-ok', { provider: 'custom', baseUrl: 'https://llm.example.com/v1' });
  });

  it('reject an evaluation whose attempt belongs to another run', async () => {
    const seed = await seedExperiment(t.db);
    const attemptId = await startAttempt(t.db, seed.runs[0]!.id, seed.worker.id);
    await finishAttempt(t.db, seed.runs[0]!.id, attemptId);
    const error = await rejection(
      t.db
        .insert(evaluations)
        .values({ runId: seed.runs[1]!.id, attemptId, cause: 'initial', generation: 1 }),
    );
    expect(error.code).toBe(SQLSTATE.foreignKeyViolation);
  });

  it('require the event payload type to match the event type, and to exist', async () => {
    const seed = await seedExperiment(t.db);
    const attemptId = await startAttempt(t.db, seed.runs[0]!.id, seed.worker.id);
    const event = (payload: unknown) =>
      t.db.insert(runEvents).values({
        attemptId,
        seq: 1,
        ts: 1,
        type: 'text',
        payload: payload as { type: 'text'; text: string },
      });
    expect((await rejection(event({ type: 'tool_use', name: 'read_file' }))).message).toMatch(
      /run_events_payload_type_ck/,
    );
    expect((await rejection(event({ text: 'no type' }))).message).toMatch(
      /run_events_payload_type_ck/,
    );
  });

  it('reject NaN costs and a verdict history that is not an array', async () => {
    const seed = await seedExperiment(t.db);
    const attemptId = await startAttempt(t.db, seed.runs[0]!.id, seed.worker.id);
    const nan = await rejection(
      t.pg.query(`update attempts set cost_usd = 'NaN' where id = $1`, [attemptId]),
    );
    expect(nan.message).toMatch(/attempts_cost_ck/);
    // On insert the table check refuses it; on update the experiments trigger does.
    const { id: _id, createdAt: _createdAt, ...copy } = seed.experiment;
    const notArray = await rejection(
      t.db.insert(experiments).values({ ...copy, verdictHistory: sql`'{}'::jsonb` }),
    );
    expect(notArray.message).toMatch(/experiments_verdict_history_ck/);
    const notArrayLater = await rejection(
      t.pg.query(`update experiments set verdict_history = '{}'::jsonb where id = $1`, [
        seed.experiment.id,
      ]),
    );
    expect(notArrayLater.code).toBe(SQLSTATE.restrictViolation);
  });

  it('keep suite source outcomes consistent and release the name of a vanished directory', async () => {
    const seed = await seedExperiment(t.db);
    const errorWithoutDetail = await rejection(
      t.db.insert(suiteSources).values({ path: 'broken', lastOutcome: 'error' }),
    );
    expect(errorWithoutDetail.message).toMatch(/suite_sources_error_ck/);
    const createdWithoutSuite = await rejection(
      t.db.insert(suiteSources).values({ path: 'new', lastOutcome: 'created' }),
    );
    expect(createdWithoutSuite.message).toMatch(/suite_sources_current_ck/);
    const otherDirectory = await rejection(
      t.db.insert(suiteSources).values({
        path: 'elsewhere',
        currentSuiteId: seed.suite.id,
        lastOutcome: 'unchanged',
      }),
    );
    expect(otherDirectory.code).toBe(SQLSTATE.foreignKeyViolation);

    // Renaming invoices-v1/ to invoices/: the old directory goes missing and frees the name.
    await t.db
      .update(suiteSources)
      .set({ lastOutcome: 'missing' })
      .where(eq(suiteSources.path, 'invoices-v1'));
    await t.db
      .insert(suiteSources)
      .values({ path: 'invoices', name: 'invoices-v1', lastOutcome: 'missing' });
  });
});

describe('integrity triggers', () => {
  it('freeze evidence once an attempt finishes', async () => {
    const seed = await seedExperiment(t.db);
    const run = seed.runs[0]!;
    const attemptId = await startAttempt(t.db, run.id, seed.worker.id);
    await t.db.insert(runEvents).values({
      attemptId,
      seq: 1,
      ts: 1,
      type: 'text',
      payload: { type: 'text', text: 'Reading invoices.csv' },
    });
    await t.db.insert(artifacts).values({
      attemptId,
      path: 'summary.csv',
      origin: 'agent',
      size: 10,
      sha256: await blob(t.db, 'summary'),
    });

    const editEvent = await rejection(
      t.db.update(runEvents).set({ ts: 2 }).where(eq(runEvents.attemptId, attemptId)),
    );
    expect(editEvent.code).toBe(SQLSTATE.restrictViolation);
    const deleteEvent = await rejection(
      t.db.delete(runEvents).where(eq(runEvents.attemptId, attemptId)),
    );
    expect(deleteEvent.code).toBe(SQLSTATE.restrictViolation);

    await finishAttempt(t.db, run.id, attemptId);

    const lateEvent = await rejection(
      t.db.insert(runEvents).values({
        attemptId,
        seq: 2,
        ts: 2,
        type: 'platform',
        payload: { type: 'platform', subtype: 'collected' },
      }),
    );
    expect(lateEvent.code).toBe(SQLSTATE.restrictViolation);
    const lateArtifact = await rejection(
      t.db.insert(artifacts).values({
        attemptId,
        path: 'late.txt',
        origin: 'agent',
        size: 1,
        sha256: await blob(t.db, 'late'),
      }),
    );
    expect(lateArtifact.code).toBe(SQLSTATE.restrictViolation);
    const editAttempt = await rejection(
      t.db.update(attempts).set({ finalText: 'rewritten' }).where(eq(attempts.id, attemptId)),
    );
    expect(editAttempt.code).toBe(SQLSTATE.restrictViolation);
    const deleteAttempt = await rejection(t.db.delete(attempts).where(eq(attempts.id, attemptId)));
    expect(deleteAttempt.code).toBe(SQLSTATE.restrictViolation);
    const deleteArtifact = await rejection(
      t.db.delete(artifacts).where(eq(artifacts.attemptId, attemptId)),
    );
    expect(deleteArtifact.code).toBe(SQLSTATE.restrictViolation);
  });

  it('allow a launch record to be written once', async () => {
    const seed = await seedExperiment(t.db);
    const attemptId = await startAttempt(t.db, seed.runs[0]!.id, seed.worker.id);
    const record = {
      argv: ['hermes', 'chat'],
      cwd: '/trial/workspace',
      env: { HERMES_HOME: '/trial/home', HOME: '/trial/home', PATH: '/usr/bin' },
      secret_env_names: [],
      config_path: '/trial/home/config.yaml',
      config_yaml: 'model: {}',
      skills: [],
      mcp_servers: [],
      inputs: [],
      limits: { max_turns: 20, run_budget_seconds: 300, deadline_seconds: 370 },
      hermes: { version: '0.22.4', revision: '4d04303' },
    };
    await t.db.update(attempts).set({ launchRecord: record }).where(eq(attempts.id, attemptId));
    const rewrite = await rejection(
      t.db
        .update(attempts)
        .set({ launchRecord: { ...record, argv: ['other'] } })
        .where(eq(attempts.id, attemptId)),
    );
    expect(rewrite.code).toBe(SQLSTATE.restrictViolation);
  });

  it('let unfrozen configuration versions change and refuse frozen ones', async () => {
    const versionId = await draftVersion('draft');
    const where = eq(configurationVersions.id, versionId);
    await t.db
      .update(configurationVersions)
      .set({ maxTurns: 30, configHash: sha('b') })
      .where(where);
    await t.db.update(configurationVersions).set({ frozenAt: new Date() }).where(where);
    const edit = await rejection(
      t.db.update(configurationVersions).set({ maxTurns: 40 }).where(where),
    );
    expect(edit.code).toBe(SQLSTATE.restrictViolation);
    const remove = await rejection(t.db.delete(configurationVersions).where(where));
    expect(remove.code).toBe(SQLSTATE.restrictViolation);
  });

  it('check resource ids on configuration versions and freeze the MCP definitions they use', async () => {
    const missingSkill = await rejection(
      draftVersion('ghost', { skillIds: ['01NOSUCHSKILL0000000000000'] }),
    );
    expect(missingSkill.code).toBe(SQLSTATE.foreignKeyViolation);

    const v1 = await stdioServer('invoice-db', 1);
    const v2 = await stdioServer('invoice-db', 2);
    const twoVersions = await rejection(draftVersion('both', { mcpServerVersionIds: [v1, v2] }));
    expect(twoVersions.code).toBe(SQLSTATE.restrictViolation);

    await draftVersion('with-mcp', { mcpServerVersionIds: [v1] });
    const [definition] = await t.db
      .select()
      .from(mcpServerVersions)
      .where(eq(mcpServerVersions.id, v1));
    expect(definition!.frozenAt).toBeInstanceOf(Date);
  });

  it('let a frozen MCP definition record test results but not change', async () => {
    const definitionId = await stdioServer('invoice-db');
    await draftVersion('uses-it', { mcpServerVersionIds: [definitionId] });
    const where = eq(mcpServerVersions.id, definitionId);
    await t.db
      .update(mcpServerVersions)
      .set({ lastTest: { status: 'running', job_id: 'j1', requested_at: '2026-10-23T10:00:00Z' } })
      .where(where);
    const edit = await rejection(
      t.db.update(mcpServerVersions).set({ command: 'python3' }).where(where),
    );
    expect(edit.code).toBe(SQLSTATE.restrictViolation);
    const remove = await rejection(t.db.delete(mcpServerVersions).where(where));
    expect(remove.code).toBe(SQLSTATE.restrictViolation);
  });

  it('launch experiments only on frozen versions and valid tasks of their suite row', async () => {
    const seed = await seedExperiment(t.db);
    const draftId = await draftVersion('unfrozen');
    const launch = (overrides: Partial<typeof experiments.$inferInsert>) =>
      t.db.insert(experiments).values({
        name: 'second',
        suiteId: seed.suite.id,
        taskIds: [seed.task.id],
        baselineVersionId: seed.baselineVersionId,
        candidateVersionIds: [seed.candidateVersionId],
        repetitions: 1,
        concurrency: 1,
        hermesVersion: '0.22.4',
        hermesRevision: seed.experiment.hermesRevision,
        priceTable: seed.experiment.priceTable,
        ...overrides,
      });
    expect((await rejection(launch({ candidateVersionIds: [draftId] }))).code).toBe(
      SQLSTATE.restrictViolation,
    );
    expect((await rejection(launch({ taskIds: ['01NOSUCHTASK00000000000000'] }))).code).toBe(
      SQLSTATE.restrictViolation,
    );

    // A run outside the experiment's matrix is refused.
    const outside = await rejection(
      t.db.insert(runs).values({
        experimentId: seed.experiment.id,
        taskId: seed.task.id,
        configurationVersionId: seed.baselineVersionId,
        repetition: 3,
      }),
    );
    expect(outside.code).toBe(SQLSTATE.restrictViolation);
  });

  it('freeze what an experiment tests and keep its verdict history append-only', async () => {
    const seed = await seedExperiment(t.db);
    const where = eq(experiments.id, seed.experiment.id);
    for (const change of [{ repetitions: 5 }, { timeBudgetOverrideS: 60 }]) {
      const frozen = await rejection(t.db.update(experiments).set(change).where(where));
      expect(frozen.code).toBe(SQLSTATE.restrictViolation);
    }

    const entry: VerdictEntry = {
      at: '2026-10-23T11:00:00.000Z',
      cause: 'initial',
      candidate_version_id: seed.candidateVersionId,
      key: 'answer',
      delta: 0.217,
      lo: 0.117,
      hi: 0.333,
      verdict: 'better',
      reason: null,
    };
    await t.db
      .update(experiments)
      .set({
        verdictHistory: sql`${experiments.verdictHistory} || ${JSON.stringify([entry])}::jsonb`,
      })
      .where(where);
    const rewritten = await rejection(
      t.db.update(experiments).set({ verdictHistory: [] }).where(where),
    );
    expect(rewritten.code).toBe(SQLSTATE.restrictViolation);

    await t.db
      .update(experiments)
      .set({ status: 'paused', pauseReason: 'user', pausedAt: new Date() })
      .where(where);
    const pausedWithoutReason = await rejection(
      t.db.update(experiments).set({ pauseReason: null, pausedAt: null }).where(where),
    );
    expect(pausedWithoutReason.message).toMatch(/experiments_paused_ck/);
    const remove = await rejection(t.db.delete(experiments).where(where));
    expect(remove.code).toBe(SQLSTATE.restrictViolation);
  });

  it('grade only executed attempts, accept scores only while running, supersede once', async () => {
    const seed = await seedExperiment(t.db);
    const run = seed.runs[0]!;
    const attemptId = await startAttempt(t.db, run.id, seed.worker.id);
    const tooEarly = await rejection(
      t.db
        .insert(evaluations)
        .values({ runId: run.id, attemptId, cause: 'initial', generation: 1 }),
    );
    expect(tooEarly.code).toBe(SQLSTATE.restrictViolation);
    await finishAttempt(t.db, run.id, attemptId);

    const score = (evaluationId: string, key = 'answer', isPrimary = true) => ({
      evaluationId,
      key,
      type: 'json_match' as const,
      status: 'passed' as const,
      isPrimary,
      score: 1,
      comment: 'matches',
      scorerVersion: 1,
    });

    const [first] = await t.db
      .insert(evaluations)
      .values({ runId: run.id, attemptId, cause: 'initial', generation: 1 })
      .returning();
    const whileQueued = await rejection(t.db.insert(scores).values(score(first!.id)));
    expect(whileQueued.code).toBe(SQLSTATE.restrictViolation);

    const secondInFlight = await rejection(
      t.db
        .insert(evaluations)
        .values({ runId: run.id, attemptId, cause: 'rescore', generation: 2 }),
    );
    expect(secondInFlight.code).toBe(SQLSTATE.uniqueViolation);

    const byId = (id: string) => eq(evaluations.id, id);
    await t.db.update(evaluations).set(runningClaim()).where(byId(first!.id));
    await t.db.insert(scores).values(score(first!.id));
    const twoPrimaries = await rejection(t.db.insert(scores).values(score(first!.id, 'method')));
    expect(twoPrimaries.code).toBe(SQLSTATE.uniqueViolation);
    await t.db
      .update(evaluations)
      .set({
        status: 'completed',
        finishedAt: new Date(),
        answer: { status: 'found', block_count: 1, start: 14, end: 32, value: { duplicates: [] } },
      })
      .where(byId(first!.id));
    const afterCompletion = await rejection(
      t.db.insert(scores).values(score(first!.id, 'late', false)),
    );
    expect(afterCompletion.code).toBe(SQLSTATE.restrictViolation);
    const editScore = await rejection(t.db.update(scores).set({ comment: 'changed' }));
    expect(editScore.code).toBe(SQLSTATE.restrictViolation);

    // Re-score: the new evaluation becomes current only after the old one is superseded.
    const [second] = await t.db
      .insert(evaluations)
      .values({
        runId: run.id,
        attemptId,
        cause: 'rescore',
        generation: 2,
        ...runningClaim(),
      })
      .returning();
    await t.db.insert(scores).values(score(second!.id));
    const twoCurrent = await rejection(
      t.db
        .update(evaluations)
        .set({ status: 'completed', finishedAt: new Date() })
        .where(byId(second!.id)),
    );
    expect(twoCurrent.code).toBe(SQLSTATE.uniqueViolation);
    await t.db.transaction(async (tx) => {
      await tx.update(evaluations).set({ supersededAt: new Date() }).where(byId(first!.id));
      await tx
        .update(evaluations)
        .set({ status: 'completed', finishedAt: new Date() })
        .where(byId(second!.id));
    });
    const supersedeAgain = await rejection(
      t.db.update(evaluations).set({ supersededAt: new Date() }).where(byId(first!.id)),
    );
    expect(supersedeAgain.code).toBe(SQLSTATE.restrictViolation);
    const removeEvaluation = await rejection(t.db.delete(evaluations).where(byId(first!.id)));
    expect(removeEvaluation.code).toBe(SQLSTATE.restrictViolation);

    const current = await t.db
      .select({ id: evaluations.id })
      .from(evaluations)
      .where(
        and(
          eq(evaluations.runId, run.id),
          eq(evaluations.status, 'completed'),
          sql`${evaluations.supersededAt} is null`,
        ),
      );
    expect(current).toEqual([{ id: second!.id }]);
  });

  it('keep loaded suites, tasks, task files, skills and documents unchanged', async () => {
    const seed = await seedExperiment(t.db);
    const [skill] = await t.db
      .insert(skills)
      .values({
        name: 'invoice-method',
        version: '1.0.0',
        description: 'Method for invoice reconciliation',
        contentHash: sha('skill'),
        fileCount: 3,
        sizeBytes: 4096,
      })
      .returning();
    const [document] = await t.db
      .insert(documents)
      .values({
        filename: 'policy.pdf',
        mime: 'application/pdf',
        size: 10,
        sha256: await blob(t.db, 'pdf'),
      })
      .returning();
    const edits = [
      t.db.update(suites).set({ name: 'renamed' }).where(eq(suites.id, seed.suite.id)),
      t.db.update(tasks).set({ summary: 'changed' }).where(eq(tasks.id, seed.task.id)),
      t.db.update(taskFiles).set({ size: 1 }).where(eq(taskFiles.taskId, seed.task.id)),
      t.db.update(skills).set({ description: 'changed' }).where(eq(skills.id, skill!.id)),
      t.db.update(documents).set({ mime: 'text/plain' }).where(eq(documents.id, document!.id)),
      t.db.update(runs).set({ repetition: 9 }).where(eq(runs.id, seed.runs[0]!.id)),
      t.db.delete(runs).where(eq(runs.id, seed.runs[0]!.id)),
      t.db.delete(tasks).where(eq(tasks.id, seed.task.id)),
    ];
    for (const edit of edits) {
      expect((await rejection(edit)).code).toBe(SQLSTATE.restrictViolation);
    }
  });
});

describe('lifecycle', () => {
  it('walks recovery, retry, scoring, cancel, failure, retry-failed, pause and completion', async () => {
    const s = await seedExperiment(t.db);
    const run = s.runs[0]!;
    const a1 = await startAttempt(t.db, run.id, s.worker.id);

    // Worker-lost recovery: final platform event first, then the attempt ends and the run requeues.
    await t.db.transaction(async (tx) => {
      await tx.insert(runEvents).values({
        attemptId: a1,
        seq: 1,
        ts: Date.now(),
        type: 'platform',
        payload: { type: 'platform', subtype: 'worker_lost' },
      });
      await tx
        .update(attempts)
        .set({
          status: 'execution_error',
          errorCategory: 'worker_lost',
          errorMessage: 'worker lost',
          finishedAt: new Date(),
        })
        .where(eq(attempts.id, a1));
      await tx.update(runs).set({ status: 'queued' }).where(eq(runs.id, run.id));
    });

    // Attempt 2, created by recovery, executes.
    const a2 = await t.db.transaction(async (tx) => {
      const [a] = await tx
        .insert(attempts)
        .values({
          runId: run.id,
          number: 2,
          trigger: 'recovery',
          status: 'running',
          workerId: s.worker.id,
          trialPath: `trials/${run.id}/a2`,
        })
        .returning();
      await tx
        .update(runs)
        .set({ status: 'running', attemptCount: 2, currentAttemptId: a!.id })
        .where(and(eq(runs.id, run.id), eq(runs.status, 'queued')));
      return a!.id;
    });
    await finishAttempt(t.db, run.id, a2);

    // The initial evaluation scores it.
    const [evaluation] = await t.db
      .insert(evaluations)
      .values({ runId: run.id, attemptId: a2, cause: 'initial', generation: 1 })
      .returning();
    await t.db.update(runs).set({ status: 'scoring' }).where(eq(runs.id, run.id));
    await t.db.update(evaluations).set(runningClaim()).where(eq(evaluations.id, evaluation!.id));
    await t.db.transaction(async (tx) => {
      await tx.insert(scores).values({
        evaluationId: evaluation!.id,
        key: 'answer',
        type: 'json_match',
        status: 'passed',
        isPrimary: true,
        score: 1,
        comment: 'matches',
        scorerVersion: 1,
      });
      await tx
        .update(evaluations)
        .set({ status: 'completed', finishedAt: new Date() })
        .where(eq(evaluations.id, evaluation!.id));
      await tx
        .update(runs)
        .set({ status: 'scored', finishedAt: new Date() })
        .where(eq(runs.id, run.id));
    });

    // The other runs are cancelled; the experiment fails, is retried, paused, resumed, completed.
    await t.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(runs.experimentId, s.experiment.id), eq(runs.status, 'queued')));
    const ex = eq(experiments.id, s.experiment.id);
    await t.db
      .update(experiments)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        failure: {
          at: new Date().toISOString(),
          threshold: 14,
          category: 'setup',
          exit_code: 1,
          message: 'invoice-db failed to start',
          stderr_first_line: null,
          attempt_id: a1,
          run_id: run.id,
        },
      })
      .where(ex);
    await t.db
      .update(experiments)
      .set({ status: 'running', finishedAt: null, failure: null, consecutiveExecutionErrors: 0 })
      .where(ex);
    await t.db
      .update(experiments)
      .set({ status: 'paused', pauseReason: 'spend_ceiling', pausedAt: new Date() })
      .where(ex);
    await t.db
      .update(experiments)
      .set({ status: 'running', pauseReason: null, pausedAt: null, spendCeilingUsd: 10 })
      .where(ex);
    await t.db
      .update(experiments)
      .set({
        status: 'completed',
        finishedAt: new Date(),
        verdictHistory: sql`${experiments.verdictHistory} || '[{"cause":"initial"}]'::jsonb`,
      })
      .where(ex);
    await t.db
      .update(experiments)
      .set({
        verdictHistory: sql`${experiments.verdictHistory} || '[{"cause":"rescore"}]'::jsonb`,
      })
      .where(ex);

    const [experiment] = await t.db.select().from(experiments);
    expect(experiment!.status).toBe('completed');
    expect(experiment!.verdictHistory).toHaveLength(2);
  });
});
