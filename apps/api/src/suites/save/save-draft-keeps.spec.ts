/**
 * What a save keeps of the folder on disk (plan 4.6 step 2, V1's "hand edits
 * keep working"), on PGlite with the real loader: every entry no version
 * stores is the author's and survives an edit of its task, a restore of an
 * older version, an unrelated edit and a folder made by hand; the draft
 * decides only the files it holds and the files the base version stored.
 */
import { cp, lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DraftSaveResultSchema } from '@hermes-evals/shared';
import { MAX_SUITE_FILE_BYTES } from '../loader/limits.js';
import { DraftTasksService } from '../drafts/draft-tasks.service.js';
import { loadDraft } from '../drafts/draft-store.js';
import { draftBase } from '../drafts/draft-writer.js';
import type { StorageService } from '../../storage/storage.service.js';
import { baseFilesOf, baseKeysOf } from './conflict.js';
import { rebaseDraft } from './rebase.js';
import { SaveWorld } from './save-world.support-spec.js';
import { buildStaging } from './stage.js';
import { stagingName, SuitesDir } from './suites-dir.js';

vi.setConfig({ testTimeout: 120_000 });

let world: SaveWorld;

beforeEach(async () => {
  world = await SaveWorld.create();
});

afterEach(async () => {
  await world.close();
});

const onDisk = (path: string) => join(world.suitesDir, 'complete', path);
const exists = async (path: string) => (await lstat(path).catch(() => null)) !== null;

const saved = (output: Awaited<ReturnType<SaveWorld['save']>>) => {
  if (output.kind !== 'saved') throw new Error(`not saved: ${JSON.stringify(output)}`);
  return DraftSaveResultSchema.parse(output.result);
};

async function change(
  key: string,
  edit: (task: { prompt: string | null; taskYaml: string | null }) => object,
): Promise<void> {
  await world.writer.write('complete', undefined, async (ctx) => {
    const task = ctx.task(key);
    await ctx.change(task, edit(task));
  });
}

const editPrompt = (key: string) =>
  change(key, (task) => ({ prompt: `${task.prompt ?? ''}\nRound to cents.\n` }));

describe('an edited task', () => {
  it("keeps the author's files under fixtures/ and expected/ that the loader never stored", async () => {
    await writeFile(onDisk('numeric/fixtures/.gitkeep'), '');
    await writeFile(onDisk('summary_file/expected/.notes'), 'keep me\n');
    await writeFile(onDisk('numeric/fixtures/big.bin'), Buffer.alloc(MAX_SUITE_FILE_BYTES + 1, 1));
    await writeFile(join(world.root, 'shared.csv'), 'a,b\n');
    await symlink(join(world.root, 'shared.csv'), onDisk('numeric/fixtures/shared.csv'));
    await mkdir(onDisk('numeric/scratch'));
    await world.load('complete');
    await world.open('complete');
    await editPrompt('numeric');
    await editPrompt('summary_file');

    const result = saved(await world.save('complete'));
    expect(result.changes.changed).toEqual(['numeric', 'summary_file']);
    expect(await readFile(onDisk('numeric/fixtures/.gitkeep'), 'utf8')).toBe('');
    expect(await readFile(onDisk('summary_file/expected/.notes'), 'utf8')).toBe('keep me\n');
    expect((await lstat(onDisk('numeric/fixtures/big.bin'))).size).toBe(MAX_SUITE_FILE_BYTES + 1);
    expect(await readlink(onDisk('numeric/fixtures/shared.csv'))).toBe(
      join(world.root, 'shared.csv'),
    );
    expect((await lstat(onDisk('numeric/scratch'))).isDirectory()).toBe(true);
    // The link still makes the task invalid, as on disk.
    expect(result.invalid.map((t) => t.key)).toEqual(['numeric']);
  });

  it('keeps a file by hand in a folder the draft then names as the expected workspace', async () => {
    await mkdir(onDisk('numeric/solution'));
    await writeFile(onDisk('numeric/solution/out.csv'), 'total\n10.5\n');
    await world.load('complete');
    await world.open('complete');
    await change('numeric', (task) => ({
      taskYaml: `${task.taskYaml}self_check:\n  expected_workspace: solution\n`,
    }));
    saved(await world.save('complete'));
    expect(await readFile(onDisk('numeric/solution/out.csv'), 'utf8')).toBe('total\n10.5\n');
  });

  it('does not bring back a fixture the draft removed or moved', async () => {
    await world.load('complete');
    await world.open('complete');
    await world.writer.write('complete', undefined, async (ctx) => {
      const task = ctx.task('summary_file');
      const files = (ctx.stored.files.get(task.id) ?? []).map((f) =>
        f.path === 'fixtures/invoices.csv' ? { ...f, path: 'fixtures/data/invoices.csv' } : f,
      );
      await ctx.change(task, { files });
      const numeric = ctx.task('numeric');
      const kept = (ctx.stored.files.get(numeric.id) ?? []).filter((f) => f.kind !== 'fixture');
      await ctx.change(numeric, { files: kept });
    });
    saved(await world.save('complete'));
    expect(await exists(onDisk('summary_file/fixtures/invoices.csv'))).toBe(false);
    expect(await exists(onDisk('summary_file/fixtures/data/invoices.csv'))).toBe(true);
    expect(await exists(onDisk('numeric/fixtures/amounts.csv'))).toBe(false);
  });

  it('keeps a prompt.md that is not UTF-8, which the draft holds no text for', async () => {
    const latin1 = Buffer.from('Caf\xe9 totals. Reply with ```json\n', 'latin1');
    await writeFile(onDisk('numeric/prompt.md'), latin1);
    await world.load('complete');
    await world.open('complete');
    await change('numeric', (task) => {
      expect(task.prompt).toBeNull();
      return { taskYaml: `${task.taskYaml}# reviewed\n` };
    });
    saved(await world.save('complete'));
    expect(await readFile(onDisk('numeric/prompt.md'))).toEqual(latin1);
    expect(await readFile(onDisk('numeric/task.yaml'), 'utf8')).toMatch(/# reviewed\n$/);
  });
});

describe('a restored task', () => {
  it("takes the older version's files and keeps the author's notes beside them", async () => {
    await world.load('complete');
    const v1Prompt = await readFile(onDisk('numeric/prompt.md'), 'utf8');
    await writeFile(onDisk('numeric/prompt.md'), 'v2 prompt. Reply with ```json\n');
    await writeFile(onDisk('numeric/fixtures/extra.csv'), 'id\n1\n');
    await writeFile(onDisk('numeric/NOTES.md'), 'author notes, never loaded\n');
    expect((await world.load('complete')).versionNumber).toBe(2);
    await world.open('complete');
    const tasks = new DraftTasksService(world.t.db, world.store as unknown as StorageService);
    await tasks.create('complete', { kind: 'restore', key: 'numeric', suiteVersion: 1 });

    const result = saved(await world.save('complete'));
    expect(result).toMatchObject({ outcome: 'reverted', suite: { versionNumber: 1 } });
    expect(await readFile(onDisk('numeric/prompt.md'), 'utf8')).toBe(v1Prompt);
    expect(await exists(onDisk('numeric/fixtures/extra.csv'))).toBe(false);
    expect(await readFile(onDisk('numeric/NOTES.md'), 'utf8')).toBe('author notes, never loaded\n');
  });
});

describe('an unrelated edit', () => {
  it('keeps a task folder that is a link as the link it is', async () => {
    await cp(onDisk('exact'), join(world.root, 'exact-elsewhere'), { recursive: true });
    await symlink(join(world.root, 'exact-elsewhere'), onDisk('linked'));
    await world.load('complete');
    await world.open('complete');
    await editPrompt('numeric');
    const result = saved(await world.save('complete'));
    expect(result.invalid.map((t) => t.key)).toEqual(['linked']);
    expect(await readlink(onDisk('linked'))).toBe(join(world.root, 'exact-elsewhere'));
  });
});

describe('a folder made by hand that no version recorded', () => {
  async function makeFolder(): Promise<void> {
    await mkdir(onDisk('new_task_wip/fixtures_draft'), { recursive: true });
    await writeFile(onDisk('new_task_wip/NOTES.md'), 'ideas for the next task\n');
    await writeFile(onDisk('new_task_wip/fixtures_draft/data.csv'), 'a,b\n1,2\n');
  }

  it('is a change on disk: the save loads it and answers disk_changed, deleting nothing', async () => {
    await world.load('complete');
    await world.open('complete');
    await editPrompt('numeric');
    await makeFolder();
    const before = await world.snapshot();

    const output = await world.save('complete');
    if (output.kind !== 'conflict') throw new Error(JSON.stringify(output));
    expect(output.conflict).toMatchObject({
      cause: 'disk_changed',
      current: { versionNumber: 2 },
      diskChanges: { added: ['new_task_wip'] },
    });
    expect(await world.snapshot()).toEqual(before);

    await rebaseDraft(world.t.db, world.store, 'complete', { onto: 2, choices: [] });
    const result = saved(await world.save('complete'));
    expect(result.changes.changed).toEqual(['numeric']);
    expect(await readFile(onDisk('new_task_wip/NOTES.md'), 'utf8')).toBe(
      'ideas for the next task\n',
    );
    expect(await exists(onDisk('new_task_wip/fixtures_draft/data.csv'))).toBe(true);
  });

  it('is copied into the staging folder, as every root entry the draft does not decide', async () => {
    await world.load('complete');
    await world.open('complete');
    await editPrompt('numeric');
    await world.writer.write('complete', undefined, async (ctx) => {
      await ctx.change(ctx.task('exact'), { removed: true });
      await ctx.change(ctx.task('json_unordered'), { key: 'json_bag' });
    });
    await makeFolder();
    await writeFile(onDisk('json_unordered/NOTES.md'), 'follows the rename\n');

    const draft = await world.draft('complete');
    const stored = await loadDraft(world.t.db, draft);
    const based = await draftBase(world.t.db, draft);
    const dir = await SuitesDir.open(world.suitesDir);
    await buildStaging({
      dir,
      staging: stagingName(draft.id),
      live: 'complete',
      stored,
      baseKeys: baseKeysOf(based, stored),
      baseFiles: await baseFilesOf(world.t.db, based.tasks, stored),
      suiteYaml: 'name: complete\n',
      blobs: world.store,
    });
    const staged = Object.keys(await world.snapshot(dir.folder(stagingName(draft.id))));
    expect(staged).toContain('new_task_wip/NOTES.md');
    expect(staged).toContain('new_task_wip/fixtures_draft/data.csv');
    expect(staged).toContain('json_bag/task.yaml');
    expect(staged).toContain('json_bag/NOTES.md');
    expect(staged.some((p) => p.startsWith('json_unordered/'))).toBe(false);
    expect(staged.some((p) => p.startsWith('exact/'))).toBe(false);
  });
});
