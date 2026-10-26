/**
 * Migration 0008 (Phase 6 platform additions, plan 18.2): the task file
 * kinds `home_seed` and `expected_home`, the artifact `root` with its unique
 * index (attempt_id, root, path) and the rules that tie origins and paths to
 * it, and the configuration versions' `skill_loading`. Checked on a fresh
 * database, and on one migrated by the Phase 5 build that already holds a
 * frozen configuration version and a collected artifact.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARTIFACT_ORIGINS,
  ARTIFACT_ROOTS,
  SKILL_LOADING_MODES,
  TASK_FILE_KINDS,
  type ArtifactOrigin,
  type ArtifactRoot,
} from '@hermes-evals/shared';
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
  configurations,
  configurationVersions,
  experiments,
  runs,
  skills,
  suites,
  taskFiles,
  tasks,
  workers,
} from './schema/index.js';

let t: TestDatabase | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** The values a CHECK lists, in order. */
async function checkValues(db: TestDatabase, name: string): Promise<string[]> {
  const { rows } = await db.pg.query<{ def: string }>(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname = '${name}'`,
  );
  return [...rows[0]!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** A running attempt of the seeded experiment, ready to take artifacts. */
async function runningAttempt(db: TestDb) {
  const seed = await seedExperiment(db);
  const attemptId = await startAttempt(db, seed.runs[0]!.id, seed.worker.id);
  return { seed, attemptId, sha256: await blob(db, 'remembered: reports in EUR') };
}

const artifact = (
  attemptId: string,
  sha256: string,
  root: ArtifactRoot | undefined,
  path: string,
  origin: ArtifactOrigin,
) => ({ attemptId, ...(root ? { root } : {}), path, origin, size: 26, sha256 });

describe('migration 0008 rules', () => {
  it('lists the new vocabularies in their CHECKs, in the shared order', async () => {
    t = await createTestDatabase();
    expect(await checkValues(t, 'task_files_kind_ck')).toEqual([...TASK_FILE_KINDS]);
    expect(await checkValues(t, 'artifacts_origin_ck')).toEqual([...ARTIFACT_ORIGINS]);
    expect(await checkValues(t, 'artifacts_root_ck')).toEqual([...ARTIFACT_ROOTS]);
    expect(await checkValues(t, 'configuration_versions_skill_loading_ck')).toEqual([
      ...SKILL_LOADING_MODES,
    ]);
  });

  it('stores home seeds and expected home files as task files, and nothing else new', async () => {
    t = await createTestDatabase();
    const seed = await seedExperiment(t.db);
    const files = [
      { path: 'home/memories/MEMORY.md', kind: 'home_seed' as const },
      { path: 'expected_home/memories/MEMORY.md', kind: 'expected_home' as const },
    ];
    for (const file of files) {
      await t.db.insert(taskFiles).values({
        taskId: seed.task.id,
        ...file,
        sha256: await blob(t.db, file.path),
        size: 40,
      });
    }
    const stored = await t.db
      .select({ kind: taskFiles.kind })
      .from(taskFiles)
      .where(eq(taskFiles.taskId, seed.task.id));
    expect(stored.map((f) => f.kind).sort()).toEqual(['expected_home', 'fixture', 'home_seed']);
    const unknown = await rejection(
      t.pg.query(
        `insert into task_files (task_id, path, kind, sha256, size)
         values ('${seed.task.id}', 'home/x', 'home', '${sha('x')}', 1)`,
      ),
    );
    expect(unknown.code).toBe(SQLSTATE.checkViolation);
  });

  it('keeps one artifact per root and path, the workspace by default', async () => {
    t = await createTestDatabase();
    const { attemptId, sha256 } = await runningAttempt(t.db);
    await t.db
      .insert(artifacts)
      .values([
        artifact(attemptId, sha256, undefined, 'memories/MEMORY.md', 'agent'),
        artifact(attemptId, sha256, 'home', 'memories/MEMORY.md', 'home_seed_modified'),
        artifact(attemptId, sha256, 'home', 'memories/USER.md', 'agent'),
      ]);
    const stored = await t.db
      .select({ root: artifacts.root, path: artifacts.path, origin: artifacts.origin })
      .from(artifacts)
      .where(eq(artifacts.attemptId, attemptId))
      .orderBy(artifacts.root, artifacts.path);
    expect(stored).toEqual([
      { root: 'home', path: 'memories/MEMORY.md', origin: 'home_seed_modified' },
      { root: 'home', path: 'memories/USER.md', origin: 'agent' },
      { root: 'workspace', path: 'memories/MEMORY.md', origin: 'agent' },
    ]);
    const twice = await rejection(
      t.db
        .insert(artifacts)
        .values(artifact(attemptId, sha256, 'home', 'memories/USER.md', 'home_seed_unchanged')),
    );
    expect(twice.code).toBe(SQLSTATE.uniqueViolation);
  });

  it('ties seed origins and memories/ to the home, inputs to the workspace', async () => {
    t = await createTestDatabase();
    const { attemptId, sha256 } = await runningAttempt(t.db);
    const refused: Array<[ArtifactRoot, string, ArtifactOrigin]> = [
      ['workspace', 'memories/MEMORY.md', 'home_seed_unchanged'],
      ['home', 'memories/MEMORY.md', 'fixture_unchanged'],
      ['home', 'memories/MEMORY.md', 'document_modified'],
      ['home', 'config.yaml', 'agent'],
      ['home', 'skills/invoice-method/SKILL.md', 'agent'],
    ];
    for (const [root, path, origin] of refused) {
      const error = await rejection(
        t.db.insert(artifacts).values(artifact(attemptId, sha256, root, path, origin)),
      );
      expect(error.code, `${root} ${path} ${origin}`).toBe(SQLSTATE.checkViolation);
    }
    const otherRoot = await rejection(
      t.pg.query(
        `insert into artifacts (id, attempt_id, root, path, origin, size, sha256)
         values ('${newId()}', '${attemptId}', 'trial', 'memories/a.md', 'agent', 1, '${sha256}')`,
      ),
    );
    expect(otherRoot.code).toBe(SQLSTATE.checkViolation);
  });

  it('stores skill loading, preload by default, and on demand only with a skill', async () => {
    t = await createTestDatabase();
    const db = t.db;
    const [skill] = await db
      .insert(skills)
      .values({
        name: 'invoice-method',
        version: '1.0.0',
        description: 'Method for invoice questions',
        contentHash: sha('invoice-method 1.0.0'),
        fileCount: 3,
        sizeBytes: 4096,
      })
      .returning();
    const create = (name: string, values: Partial<typeof configurationVersions.$inferInsert>) =>
      db.transaction(async (tx) => {
        const [configuration] = await tx.insert(configurations).values({ name }).returning();
        const [version] = await tx
          .insert(configurationVersions)
          .values({
            configurationId: configuration!.id,
            version: 1,
            model: 'mock/scripted',
            provider: 'nous',
            maxTurns: 20,
            timeBudgetS: 300,
            configHash: sha(name),
            ...values,
          })
          .returning();
        return version!;
      });
    expect((await create('plain', {})).skillLoading).toBe('preload');
    const onDemand = await create('on-demand', {
      skillIds: [skill!.id],
      skillLoading: 'on_demand',
    });
    expect(onDemand.skillLoading).toBe('on_demand');
    const noSkill = await rejection(create('nothing-to-find', { skillLoading: 'on_demand' }));
    expect(noSkill.code).toBe(SQLSTATE.checkViolation);
    const dropped = await rejection(
      db
        .update(configurationVersions)
        .set({ skillIds: [] })
        .where(eq(configurationVersions.id, onDemand.id)),
    );
    expect(dropped.code).toBe(SQLSTATE.checkViolation);

    // A frozen version keeps its mode: the 0001 guard covers the new column.
    await db
      .update(configurationVersions)
      .set({ frozenAt: new Date() })
      .where(eq(configurationVersions.id, onDemand.id));
    const changed = await rejection(
      db
        .update(configurationVersions)
        .set({ skillLoading: 'preload' })
        .where(eq(configurationVersions.id, onDemand.id)),
    );
    expect(changed.code).toBe(SQLSTATE.restrictViolation);
  });
});

/**
 * What the Phase 5 build stored, without the columns 0008 adds: tables 0008
 * leaves alone through Drizzle (no RETURNING, which would name the new
 * columns), configuration versions and artifacts as raw SQL.
 */
async function seedBeforePhase6(db: TestDb) {
  const ids = {
    suite: newId(),
    task: newId(),
    baseline: [newId(), newId()],
    candidate: [newId(), newId()],
    worker: newId(),
    experiment: newId(),
    run: newId(),
  };
  await db.insert(suites).values({
    id: ids.suite,
    sourcePath: 'invoices-v1',
    versionNumber: 1,
    name: 'invoices-v1',
    versionLabel: '1',
    contentHash: sha('suite'),
    checkHash: sha('checks'),
    taskCount: 1,
    validCount: 1,
  });
  await db.insert(tasks).values({
    id: ids.task,
    suiteId: ids.suite,
    key: 'summary_file',
    versionNumber: 1,
    introducedInSuiteId: ids.suite,
    position: 0,
    summary: 'Write summary.csv',
    prompt: 'Write summary.csv. Reply with a fenced JSON block.',
    limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file'] },
    reference: { rows: 5 },
    verification: [],
    selfCheck: { status: 'passed', ran_at: null, duration_ms: null, results: [] },
    valid: true,
    contentHash: sha('task'),
  });
  for (const [[configId, versionId], name] of [
    [ids.baseline, 'baseline'],
    [ids.candidate, 'with-skill'],
  ] as const) {
    await db.transaction(async (tx) => {
      await tx.insert(configurations).values({ id: configId, name });
      await tx.execute(sql`
        insert into configuration_versions
          (id, configuration_id, version, model, provider, max_turns, time_budget_s, config_hash, frozen_at)
        values (${versionId}, ${configId}, 1, 'openai/gpt-6.1-sol', 'nous', 20, 300, ${sha(name)}, now())`);
    });
  }
  await db.insert(workers).values({
    id: ids.worker,
    hostname: 'worker-1',
    concurrency: 1,
    slots: 1,
    hermesVersion: '0.22.4',
    hermesRevision: HERMES_REVISION,
  });
  await db.insert(experiments).values({
    id: ids.experiment,
    name: 'Before Phase 6',
    suiteId: ids.suite,
    taskIds: [ids.task],
    baselineVersionId: ids.baseline[1],
    candidateVersionIds: [ids.candidate[1]],
    repetitions: 1,
    concurrency: 1,
    spendCeilingUsd: 5,
    hermesVersion: '0.22.4',
    hermesRevision: HERMES_REVISION,
    priceTable: { sha256: sha('prices'), loaded_at: '2026-10-25T09:00:00.000Z', models: {} },
  });
  await db.insert(runs).values({
    id: ids.run,
    experimentId: ids.experiment,
    taskId: ids.task,
    configurationVersionId: ids.baseline[1],
    repetition: 1,
  });
  const attemptId = await startAttempt(db, ids.run, ids.worker);
  const content = await blob(db, 'vendor,outstanding\n');
  const artifactId = newId();
  await db.execute(sql`
    insert into artifacts (id, attempt_id, path, origin, size, sha256)
    values (${artifactId}, ${attemptId}, 'summary.csv', 'agent', 19, ${content})`);
  return { ...ids, attemptId, artifactId, content };
}

describe('migration 0008 on a Phase 5 database', () => {
  it(
    'reads every stored version as preload and every artifact as a workspace file',
    { timeout: 30_000 },
    async () => {
      const partial = await createTestDatabaseUpTo('0007_phase4_analysis');
      t = partial;
      const old = await seedBeforePhase6(partial.db);
      const before = await partial.pg.query<{ config_hash: string }>(
        `select config_hash from configuration_versions order by id`,
      );

      await partial.migrateRest();
      const db = partial.db;

      const versions = await db
        .select({
          id: configurationVersions.id,
          skillLoading: configurationVersions.skillLoading,
          configHash: configurationVersions.configHash,
        })
        .from(configurationVersions)
        .orderBy(configurationVersions.id);
      expect(versions.map((v) => v.skillLoading)).toEqual(['preload', 'preload']);
      // The migration rewrote nothing: the stored hashes are the ones Phase 5 wrote.
      expect(versions.map((v) => v.configHash)).toEqual(before.rows.map((r) => r.config_hash));
      const frozen = await rejection(
        db
          .update(configurationVersions)
          .set({ skillLoading: 'on_demand' })
          .where(eq(configurationVersions.id, old.baseline[1])),
      );
      expect(frozen.code).toBe(SQLSTATE.restrictViolation);

      const [kept] = await db.select().from(artifacts).where(eq(artifacts.id, old.artifactId));
      expect(kept).toMatchObject({ root: 'workspace', path: 'summary.csv', origin: 'agent' });
      const indexes = await partial.pg.query<{ indexname: string }>(
        `select indexname from pg_indexes where tablename = 'artifacts' and indexname like 'artifacts_attempt_%'`,
      );
      expect(indexes.rows.map((r) => r.indexname)).toEqual(['artifacts_attempt_root_path_uq']);

      // The attempt that was running when the build changed collects its memory files too.
      await db
        .insert(artifacts)
        .values([
          artifact(old.attemptId, old.content, 'home', 'memories/MEMORY.md', 'agent'),
          artifact(old.attemptId, old.content, 'workspace', 'memories/MEMORY.md', 'agent'),
        ]);
      const immutable = await rejection(
        db.update(artifacts).set({ root: 'home' }).where(eq(artifacts.id, old.artifactId)),
      );
      expect(immutable.code).toBe(SQLSTATE.restrictViolation);

      const disabled = await partial.pg.query(
        `select tgname from pg_trigger where not tgisinternal and tgenabled = 'D'`,
      );
      expect(disabled.rows).toEqual([]);
    },
  );
});
