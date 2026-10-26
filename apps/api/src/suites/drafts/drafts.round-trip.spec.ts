/**
 * The round trip of plan 4.6 (V5), on copies of the five committed suites:
 * each folder is loaded by the real loader, opened as a draft from the
 * database (no disk read), and the draft's files are byte for byte the
 * files on disk; suite.yaml written from the unedited draft is the file
 * itself; the folder written back from the draft reloads `unchanged`. And
 * on every task of the five suites, a form edit of one field rewrites one
 * line of task.yaml and nothing else, comments and key order kept.
 */
import { cp, mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SuiteReloadResultSchema, type SuiteDraftView } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { SUITES_DIR } from '../../../test/invoices-v1/support.js';
import { MAX_LOAD_SELF_CHECK_SECONDS } from '../../queue/queues.js';
import { silentLogger } from '../../resources/skills/testing.helper-spec.js';
import { BlobStore } from '../../storage/blob-store.js';
import type { StorageService } from '../../storage/storage.service.js';
import { SuiteLoader } from '../loader/suite-loader.js';
import { folderFiles } from './draft-folder.js';
import { draftByFolder, folderOf, loadDraft } from './draft-store.js';
import { SuiteDraftsService } from './drafts.service.js';
import { renderSuiteYaml } from './suite-yaml.js';
import { applyForm, formOf } from './task-form.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const SUITES = ['invoices-v1', 'knowledge-v1', 'mcp-v1', 'memory-v1', 'tools-v1'];

let t: TestDatabase;
let root: string;
let suitesDir: string;
let store: BlobStore;
let loader: SuiteLoader;
let service: SuiteDraftsService;
const views = new Map<string, SuiteDraftView>();

/** Every file under `dir`, relative, sorted. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await filesUnder(dir, rel)));
    else out.push(rel);
  }
  return out.sort();
}

beforeAll(async () => {
  t = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'drafts-round-trip-'));
  suitesDir = join(root, 'suites');
  // Copies: the committed suites are never written.
  for (const name of SUITES)
    await cp(join(SUITES_DIR, name), join(suitesDir, name), { recursive: true });
  store = new BlobStore(join(root, 'data'));
  loader = new SuiteLoader({ db: t.db, blobs: store, suitesDir, logger: silentLogger });
  const loaded = SuiteReloadResultSchema.parse(
    await loader.loadAll({ selfCheckBudgetS: MAX_LOAD_SELF_CHECK_SECONDS }),
  );
  expect(loaded.suites.map((s) => [s.name, s.outcome])).toEqual(SUITES.map((n) => [n, 'created']));
  service = new SuiteDraftsService(t.db, store as unknown as StorageService);
  for (const name of SUITES) {
    const { created, view } = await service.open(name);
    expect(created).toBe(true);
    views.set(name, view);
  }
});

afterAll(async () => {
  await t?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe.each(SUITES)('%s, loaded into a draft', (name) => {
  it('has no change, and every task is unchanged and without a problem', () => {
    const view = views.get(name)!;
    expect(view.changes).toEqual([]);
    expect(view.problems).toEqual([]);
    for (const task of view.tasks) {
      expect(task.state, task.key).toBe('unchanged');
      expect(task.readiness, task.key).not.toBe('problems');
    }
  });

  it('holds every file of the folder byte for byte', async () => {
    const draft = (await draftByFolder(t.db, name))!;
    const stored = await loadDraft(t.db, draft);
    for (const task of stored.tasks) {
      const folder = folderOf(stored, task);
      const files = folderFiles(folder);
      const taskDir = join(suitesDir, name, task.key);
      expect(files.map((f) => f.path).sort(), task.key).toEqual(await filesUnder(taskDir));
      for (const file of files) {
        const bytes =
          file.text !== null ? Buffer.from(file.text, 'utf8') : await store.read(file.ref.sha256);
        expect(
          bytes.equals(await readFile(join(taskDir, file.path))),
          `${task.key}/${file.path}`,
        ).toBe(true);
      }
    }
  });

  it('writes suite.yaml unchanged when nothing changed', async () => {
    const view = views.get(name)!;
    const source = await readFile(join(suitesDir, name, 'suite.yaml'), 'utf8');
    const written = renderSuiteYaml(source, {
      name: view.name,
      versionLabel: view.versionLabel,
      description: view.description,
      tasks: view.tasks.map((t) => t.key),
    });
    expect(written).toBe(source);
  });

  it('reloads unchanged when the folder is written back from the draft', async () => {
    const draft = (await draftByFolder(t.db, name))!;
    const stored = await loadDraft(t.db, draft);
    const dir = join(suitesDir, name);
    const source = await readFile(join(dir, 'suite.yaml'), 'utf8');
    for (const entry of await readdir(dir))
      await rm(join(dir, entry), { recursive: true, force: true });
    const view = views.get(name)!;
    await writeFile(
      join(dir, 'suite.yaml'),
      renderSuiteYaml(source, {
        name: view.name,
        versionLabel: view.versionLabel,
        description: view.description,
        tasks: view.tasks.map((t) => t.key),
      }),
    );
    for (const task of stored.tasks) {
      for (const file of folderFiles(folderOf(stored, task))) {
        const target = join(dir, task.key, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          file.text !== null ? Buffer.from(file.text, 'utf8') : await store.read(file.ref.sha256),
        );
      }
    }
    const reloaded = SuiteReloadResultSchema.parse(await loader.loadOne(name));
    expect(reloaded.suites[0]).toMatchObject({ name, outcome: 'unchanged', versionNumber: 1 });
  });

  it('rewrites one line of task.yaml for a form edit of one field, on every task', async () => {
    const draft = (await draftByFolder(t.db, name))!;
    const stored = await loadDraft(t.db, draft);
    for (const task of stored.tasks) {
      const text = task.taskYaml!;
      const read = formOf(text);
      expect(read.lock, task.key).toBeNull();
      const form = read.form!;
      for (const edited of [
        { ...form, maxTurns: (form.maxTurns ?? 20) + 1 },
        { ...form, summary: `${form.summary} (edited)` },
      ]) {
        const out = applyForm(text, edited);
        const before = text.split('\n');
        const after = out.split('\n');
        expect(after.length, task.key).toBe(before.length);
        const differing = before.filter((line, i) => line !== after[i]);
        expect(differing, task.key).toHaveLength(1);
        expect(formOf(out).form, task.key).toEqual(edited);
      }
      expect(applyForm(text, form), task.key).toBe(text);
    }
  });
});
