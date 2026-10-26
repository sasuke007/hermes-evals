/**
 * Migration 0009 (Phase 5b suite authoring, plan 4.6): the draft tables and
 * their rules, the task root files, and the guard that lets a skill or
 * document be deleted only while no configuration version names it (Phase 5
 * section 6.1). Checked on a fresh database, and on one migrated by the
 * Phase 6 build that already holds a suite, an experiment and a frozen
 * configuration version using a skill and a document.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { DRAFT_FILE_KINDS, DRAFT_ORIGINS, DRAFT_TASK_STATES } from '@hermes-evals/shared';
import {
  createTestDatabase,
  createTestDatabaseUpTo,
  rejection,
  SQLSTATE,
  type TestDatabase,
  type TestDb,
} from '../../test/support/database.js';
import { blob, seedExperiment, sha } from '../../test/support/seed.js';
import { newId } from './ids.js';
import {
  blobs,
  configurations,
  documents,
  skills,
  suiteDraftFiles,
  suiteDrafts,
  suiteDraftTasks,
  suites,
  taskRootFiles,
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

type DraftValues = typeof suiteDrafts.$inferInsert;
type DraftTaskValues = typeof suiteDraftTasks.$inferInsert;

/** A draft of the seeded folder invoices-v1, on its v1. */
const editDraft = (baseSuiteId: string, values: Partial<DraftValues> = {}): DraftValues => ({
  sourcePath: 'invoices-v1',
  name: 'invoices-v1',
  origin: 'edit',
  baseSuiteId,
  versionLabel: '0.4',
  ...values,
});

async function draftWithTask(db: TestDb) {
  const seed = await seedExperiment(db);
  const [draft] = await db.insert(suiteDrafts).values(editDraft(seed.suite.id)).returning();
  const [task] = await db
    .insert(suiteDraftTasks)
    .values({
      draftId: draft!.id,
      key: 'dup_invoices',
      position: 0,
      state: 'changed',
      baseTaskId: seed.task.id,
      taskYaml: 'summary: Find invoices billed twice # edited\n',
      prompt: 'Find duplicates.\n',
      reference: '"1042"\n',
    })
    .returning();
  return { seed, draft: draft!, task: task! };
}

/** A configuration with one frozen version that names `skillIds` and `documentIds`. */
async function configurationUsing(
  db: TestDb,
  name: string,
  skillIds: string[],
  documentIds: string[],
) {
  await db.transaction(async (tx) => {
    const [configuration] = await tx.insert(configurations).values({ name }).returning();
    const array = (ids: string[]) => sql.raw(`'{${ids.join(',')}}'::text[]`);
    await tx.execute(sql`
      insert into configuration_versions
        (id, configuration_id, version, model, provider, max_turns, time_budget_s, config_hash,
         skill_ids, document_ids, frozen_at)
      values (${newId()}, ${configuration!.id}, 1, 'mock/scripted', 'nous', 20, 300, ${sha(name)},
        ${array(skillIds)}, ${array(documentIds)}, now())`);
  });
}

async function skillAndDocument(db: TestDb, label: string) {
  const [skill] = await db
    .insert(skills)
    .values({
      name: `skill-${label}`,
      version: '1.0.0',
      description: 'Method for invoice questions',
      contentHash: sha(`skill ${label}`),
      fileCount: 1,
      sizeBytes: 100,
    })
    .returning();
  const [document] = await db
    .insert(documents)
    .values({
      filename: `${label}.md`,
      mime: 'text/markdown',
      size: 10,
      sha256: await blob(db, `document ${label}`),
    })
    .returning();
  return { skillId: skill!.id, documentId: document!.id };
}

describe('migration 0009 rules', () => {
  it('lists the draft vocabularies in their CHECKs, in the shared order', async () => {
    t = await createTestDatabase();
    expect(await checkValues(t, 'suite_draft_tasks_state_ck')).toEqual([...DRAFT_TASK_STATES]);
    expect(await checkValues(t, 'suite_draft_files_kind_ck')).toEqual([...DRAFT_FILE_KINDS]);
    expect(await checkValues(t, 'suite_drafts_origin_ck')).toEqual([...DRAFT_ORIGINS]);
  });

  it('keeps one draft per folder, based on a version of that very folder', async () => {
    t = await createTestDatabase();
    const db = t.db;
    const seed = await seedExperiment(db);
    await db.insert(suiteDrafts).values(editDraft(seed.suite.id));
    const twice = await rejection(db.insert(suiteDrafts).values(editDraft(seed.suite.id)));
    expect(twice.code).toBe(SQLSTATE.uniqueViolation);
    const otherFolder = await rejection(
      db.insert(suiteDrafts).values(editDraft(seed.suite.id, { sourcePath: 'other-v1' })),
    );
    expect(otherFolder.code).toBe(SQLSTATE.foreignKeyViolation);

    const fresh = (values: Partial<DraftValues>) =>
      db.insert(suiteDrafts).values({
        sourcePath: 'vendor-statements-v1',
        name: 'vendor-statements-v1',
        origin: 'empty',
        versionLabel: '0.1',
        ...values,
      });
    const refused: Array<Partial<DraftValues>> = [
      { origin: 'edit' },
      { baseSuiteId: seed.suite.id },
      { origin: 'copy' },
      { copiedFromSuiteId: seed.suite.id },
      { scriptsTrustedAt: new Date() },
      { saveProgress: { startedAt: '2026-10-26T16:31:00Z', step: 'staging', selfChecks: null } },
      { sourcePath: 'Invoices v2', name: 'Invoices v2' },
      { revision: -1 },
    ];
    for (const values of refused) {
      const error = await rejection(fresh(values));
      expect(error.code, JSON.stringify(values)).toBe(SQLSTATE.checkViolation);
    }
    await fresh({ origin: 'copy', copiedFromSuiteId: seed.suite.id });
    const zip = { sourcePath: 'zip-v1', name: 'zip-v1', origin: 'zip' as const };
    await fresh({ ...zip, scriptsTrustedAt: new Date(), saveStartedAt: new Date() });
  });

  it('holds tasks with their state against the base', async () => {
    t = await createTestDatabase();
    const db = t.db;
    const { seed, draft } = await draftWithTask(db);
    const task = (values: Partial<DraftTaskValues>) =>
      db.insert(suiteDraftTasks).values({
        draftId: draft.id,
        key: 'overdue_count',
        position: 1,
        state: 'added',
        ...values,
      });
    for (const values of [
      { state: 'changed' as const },
      { state: 'unchanged' as const },
      { state: 'removed' as const },
      { state: 'restored' as const, baseTaskId: seed.task.id },
      { restoredFromTaskId: seed.task.id },
      { key: 'overdue count' },
      { position: -1 },
      { contentHash: 'abc' },
      { rubrics: sql`'[]'::jsonb` as unknown as Record<string, string> },
    ]) {
      const error = await rejection(task(values));
      expect(error.code, JSON.stringify(values)).toBe(SQLSTATE.checkViolation);
    }
    const duplicate = await rejection(task({ key: 'dup_invoices' }));
    expect(duplicate.code).toBe(SQLSTATE.uniqueViolation);
    const [restored] = await task({
      state: 'restored',
      key: 'total_due',
      restoredFromTaskId: seed.task.id,
      rubrics: { 'rubric.md': 'Grade the explanation.' },
      contentHash: sha('draft total_due'),
    }).returning();
    expect(restored).toMatchObject({
      revision: 0,
      rubrics: { 'rubric.md': 'Grade the explanation.' },
    });
  });

  it('names every other file by blob, its kind following its path', async () => {
    t = await createTestDatabase();
    const db = t.db;
    const { task } = await draftWithTask(db);
    const file = async (path: string, kind: (typeof DRAFT_FILE_KINDS)[number], content = path) =>
      db.insert(suiteDraftFiles).values({
        draftTaskId: task.id,
        path,
        kind,
        sha256: await blob(db, content),
        size: content.length,
      });
    await file('fixtures/invoices.csv', 'fixture');
    await file('verify/check.py', 'verifier');
    await file('home/memories/USER.md', 'home_seed');
    await file('expected/summary.csv', 'expected');
    await file('README.md', 'other');
    const refused: Array<[string, (typeof DRAFT_FILE_KINDS)[number]]> = [
      ['verify/notes.md', 'other'],
      ['scripts/check.py', 'verifier'],
      ['data/invoices.csv', 'fixture'],
      ['fixtures/b.csv', 'expected'],
      ['home/memories/MEMORY.md', 'other'],
      ['home/notes.md', 'home_seed'],
      ['../escape.csv', 'other'],
      ['/abs.csv', 'other'],
    ];
    for (const [path, kind] of refused) {
      const error = await rejection(file(path, kind));
      expect(error.code, `${kind} ${path}`).toBe(SQLSTATE.checkViolation);
    }
    const unknownBlob = await rejection(
      db.insert(suiteDraftFiles).values({
        draftTaskId: task.id,
        path: 'fixtures/x.csv',
        kind: 'fixture',
        sha256: sha('x'),
        size: 1,
      }),
    );
    expect(unknownBlob.code).toBe(SQLSTATE.foreignKeyViolation);
    const kept = await rejection(db.delete(blobs).where(eq(blobs.sha256, sha('README.md'))));
    expect(kept.code).toBe(SQLSTATE.foreignKeyViolation);
  });

  it('discards a draft with its tasks and files, and keeps the blobs', async () => {
    t = await createTestDatabase();
    const db = t.db;
    const { draft, task } = await draftWithTask(db);
    const sha256 = await blob(db, 'statements.csv');
    await db.insert(suiteDraftFiles).values({
      draftTaskId: task.id,
      path: 'fixtures/statements.csv',
      kind: 'fixture',
      sha256,
      size: 14,
    });
    await db.delete(suiteDrafts).where(eq(suiteDrafts.id, draft.id));
    expect(await db.select().from(suiteDraftTasks)).toEqual([]);
    expect(await db.select().from(suiteDraftFiles)).toEqual([]);
    expect(await db.select().from(blobs).where(eq(blobs.sha256, sha256))).toHaveLength(1);
  });

  it('stores a task version’s root files once', async () => {
    t = await createTestDatabase();
    const db = t.db;
    const seed = await seedExperiment(db);
    const text = '{ "duplicates": [["INV-1042", "INV-1107"]] }\n';
    await db.insert(taskRootFiles).values([
      { taskId: seed.task.id, path: 'reference.json', sha256: sha(text), size: text.length, text },
      { taskId: seed.task.id, path: 'prompt.md', sha256: sha('p'), size: 1, text: null },
    ]);
    const where = eq(taskRootFiles.taskId, seed.task.id);
    const changed = await rejection(db.update(taskRootFiles).set({ text: '{}' }).where(where));
    expect(changed.code).toBe(SQLSTATE.restrictViolation);
    const removed = await rejection(db.delete(taskRootFiles).where(where));
    expect(removed.code).toBe(SQLSTATE.restrictViolation);
    const other = await rejection(
      db.insert(taskRootFiles).values({
        taskId: seed.task.id,
        path: 'README.md' as 'prompt.md',
        sha256: sha('r'),
        size: 1,
      }),
    );
    expect(other.code).toBe(SQLSTATE.checkViolation);
  });

  it('deletes a skill or document only while no configuration version names it', async () => {
    t = await createTestDatabase();
    const db = t.db;
    const used = await skillAndDocument(db, 'used');
    const unused = await skillAndDocument(db, 'unused');
    await configurationUsing(db, 'with-skill', [used.skillId], [used.documentId]);
    const skill = await rejection(db.delete(skills).where(eq(skills.id, used.skillId)));
    expect(skill.code).toBe(SQLSTATE.foreignKeyViolation);
    expect(skill.message).toContain('is used by a configuration version');
    const document = await rejection(db.delete(documents).where(eq(documents.id, used.documentId)));
    expect(document.code).toBe(SQLSTATE.foreignKeyViolation);
    await db.delete(skills).where(eq(skills.id, unused.skillId));
    await db.delete(documents).where(eq(documents.id, unused.documentId));
    expect(await db.select({ id: skills.id }).from(skills)).toEqual([{ id: used.skillId }]);
    // The reference check of 0001 still refuses a version naming what is gone.
    const gone = await rejection(configurationUsing(db, 'stale', [unused.skillId], []));
    expect(gone.code).toBe(SQLSTATE.foreignKeyViolation);
  });
});

describe('migration 0009 on a Phase 6 database', () => {
  it(
    'adds the tables without touching a row, and guards the resources already in use',
    { timeout: 30_000 },
    async () => {
      const partial = await createTestDatabaseUpTo('0008_phase6_platform');
      t = partial;
      const seed = await seedExperiment(partial.db);
      const used = await skillAndDocument(partial.db, 'before');
      await configurationUsing(partial.db, 'phase6-skill', [used.skillId], [used.documentId]);
      const before = await partial.pg.query('select * from tasks order by id');

      await partial.migrateRest();
      const db = partial.db;

      expect((await partial.pg.query('select * from tasks order by id')).rows).toEqual(before.rows);
      expect(await db.select().from(taskRootFiles)).toEqual([]);
      const immutable = await rejection(
        db.update(suites).set({ versionLabel: '9' }).where(eq(suites.id, seed.suite.id)),
      );
      expect(immutable.code).toBe(SQLSTATE.restrictViolation);
      const skill = await rejection(db.delete(skills).where(eq(skills.id, used.skillId)));
      expect(skill.code).toBe(SQLSTATE.foreignKeyViolation);

      // The suite the older build loaded can be edited in a draft at once.
      await db.insert(suiteDrafts).values(editDraft(seed.suite.id));
      const disabled = await partial.pg.query(
        `select tgname from pg_trigger where not tgisinternal and tgenabled = 'D'`,
      );
      expect(disabled.rows).toEqual([]);
    },
  );
});
