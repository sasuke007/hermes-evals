/**
 * The imports through the drafts module itself (SuiteDraftsService as the
 * DraftImportPort) on PGlite: a zip of each committed suite, built here from
 * ./suites (read, never written), becomes a draft whose stored rows are the
 * original files byte for byte, its scripts trusted exactly when it has
 * some; and a CSV adds its rows to an open draft.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SuiteDraftViewSchema, TaskImportResultSchema } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { suiteDraftFiles, suiteDrafts, suiteDraftTasks } from '../../database/schema/index.js';
import {
  configOf,
  silentLogger,
  uploadedFile,
} from '../../resources/skills/testing.helper-spec.js';
import { BlobStore } from '../../storage/blob-store.js';
import type { StorageService } from '../../storage/storage.service.js';
import { walkSuiteDir } from '../loader/walk.js';
import { SUITE_WALK_LIMITS } from '../loader/limits.js';
import { SuiteDraftsService } from '../drafts/drafts.service.js';
import { draftTaskFolderOf, type DraftTaskFolder } from '../drafts/materialise.js';
import { SuiteImportService } from './suite-import.service.js';
import { SuiteImportStore } from './suite-import.store.js';
import { SuiteZipImports } from './suite-zip-imports.js';
import { buildZip, zipItemsOfFolder } from './zip-testing.helper-spec.js';

const SUITES_DIR = resolve(import.meta.dirname, '../../../../../suites');

let t: TestDatabase;
let work: string;
let storage: StorageService;
let zips: SuiteZipImports;
let drafts: SuiteDraftsService;
let imports: SuiteImportService;

beforeAll(async () => {
  t = await createTestDatabase();
  work = await mkdtemp(join(tmpdir(), 'import-to-draft-'));
  storage = new BlobStore(work) as unknown as StorageService;
  const store = new SuiteImportStore(storage, configOf({ SKILL_UPLOAD_TTL_S: 1800 }), silentLogger);
  zips = new SuiteZipImports(t.db, storage, store, silentLogger);
  drafts = new SuiteDraftsService(t.db, storage, zips);
  imports = new SuiteImportService(t.db, storage, zips, drafts, silentLogger);
}, 30_000);

afterAll(async () => {
  await t.close();
  await rm(work, { recursive: true, force: true });
});

/** The draft's tasks as stored: each row and its file rows, as one folder. */
async function storedFolders(draftId: string): Promise<DraftTaskFolder[]> {
  const rows = await t.db
    .select()
    .from(suiteDraftTasks)
    .where(eq(suiteDraftTasks.draftId, draftId))
    .orderBy(asc(suiteDraftTasks.position));
  const files = await t.db
    .select()
    .from(suiteDraftFiles)
    .where(
      inArray(
        suiteDraftFiles.draftTaskId,
        rows.map((r) => r.id),
      ),
    );
  return rows.map((row) =>
    draftTaskFolderOf(
      row,
      files.filter((f) => f.draftTaskId === row.id),
    ),
  );
}

/** A folder's files as bytes: texts as UTF-8, blob files from the store. */
async function bytesOf(task: DraftTaskFolder): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const texts = {
    'task.yaml': task.taskYaml,
    'prompt.md': task.prompt,
    'reference.json': task.reference,
  };
  for (const [path, text] of Object.entries({ ...texts, ...task.rubrics })) {
    if (text !== null) out.set(path, Buffer.from(text, 'utf8'));
  }
  for (const file of task.files) out.set(file.path, await storage.read(file.sha256));
  return out;
}

describe.each([
  ['invoices-v1', true],
  ['mcp-v1', false],
  ['memory-v1', true],
  ['knowledge-v1', false],
  ['tools-v1', true],
])('a zip of %s', (suite, hasScripts) => {
  it('becomes a draft whose stored files are the originals', async () => {
    const root = join(SUITES_DIR, suite);
    const zip = await buildZip(await zipItemsOfFolder(root, `${suite}/`));
    const validation = await zips.validate(await uploadedFile(storage, zip, `${suite}.zip`));
    expect(validation.outcome).toBe('valid');
    const name = `zz-smoke-${suite}`;
    const view = SuiteDraftViewSchema.parse(
      await imports.importZip({ token: validation.token!, name, trustScripts: hasScripts }),
    );
    expect(view).toMatchObject({ folder: name, origin: 'zip', base: null, nextVersion: 1 });

    const [draft] = await t.db.select().from(suiteDrafts).where(eq(suiteDrafts.id, view.id));
    expect(draft!.scriptsTrustedAt !== null).toBe(hasScripts);
    const stored = await storedFolders(view.id);
    const tree = await walkSuiteDir(root, SUITE_WALK_LIMITS);
    expect(stored.map((s) => s.key).sort()).toEqual(
      tree.entries
        .filter((e) => e.kind === 'dir' && !e.path.includes('/'))
        .map((e) => e.path)
        .sort(),
    );
    for (const task of stored) {
      const onDisk = tree.entries.filter(
        (e) => e.kind === 'file' && e.path.startsWith(`${task.key}/`),
      );
      const bytes = await bytesOf(task);
      expect([...bytes.keys()].sort()).toEqual(
        onDisk.map((e) => e.path.slice(task.key.length + 1)).sort(),
      );
      for (const entry of onDisk) {
        const original = await readFile(join(root, entry.path));
        expect(bytes.get(entry.path.slice(task.key.length + 1))!.equals(original), entry.path).toBe(
          true,
        );
      }
    }
  });
});

describe('tasks from a CSV into an open draft', () => {
  it('adds every row as an added task of the draft', async () => {
    const zip = await buildZip(await zipItemsOfFolder(join(SUITES_DIR, 'mcp-v1')));
    const validation = await zips.validate(await uploadedFile(storage, zip, 'mcp.zip'));
    await imports.importZip({
      token: validation.token!,
      name: 'zz-smoke-csv',
      trustScripts: false,
    });
    const csv = 'key,question,expected\nq_one,How many vendors?,3\nq_two,How many invoices?,12\n';
    const result = TaskImportResultSchema.parse(
      await imports.importTasks('zz-smoke-csv', {
        file: await uploadedFile(storage, csv, 'questions.csv'),
        workspace: [],
        settings: {
          mapping: [
            { column: 'key', use: 'task_key' },
            { column: 'question', use: 'prompt' },
            { column: 'expected', use: 'reference_value' },
          ],
          keyPrefix: null,
          answerPath: 'answer',
          workspace: { from: 'none' },
          checks: {
            from: 'new',
            checks: [{ key: 'answer', type: 'numeric_tolerance', primary: true, params: {} }],
          },
          limits: { maxTurns: 10, runBudgetSeconds: 120, toolsetsNeeded: ['file'] },
          appendAnswerInstructions: true,
          keyFixes: [],
        },
      }),
    );
    expect(result.added).toEqual(['q_one', 'q_two']);
    const rows = result.draft.tasks.filter((r) => result.added.includes(r.key));
    expect(rows.map((r) => [r.key, r.state])).toEqual([
      ['q_one', 'added'],
      ['q_two', 'added'],
    ]);
    const stored = (await storedFolders(result.draft.id)).find((s) => s.key === 'q_two')!;
    expect(stored.reference).toBe('{\n  "answer": 12\n}\n');
  });
});
