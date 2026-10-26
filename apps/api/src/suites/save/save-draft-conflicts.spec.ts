/**
 * The saves that do not save (plan 4.6 steps 1, 3 and 4, section 16): the
 * conflict check for a version that moved and for files edited on disk
 * without a reload, files edited by hand while the save runs, a staging
 * folder the loader refuses, a name another folder holds, and a verifier
 * that cannot run. Each leaves the folder on disk as it was and the draft
 * kept, released for edits again.
 */
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { DraftConflictSchema } from '@hermes-evals/shared';
import { suiteSources, suites } from '../../database/schema/index.js';
import {
  subprocessVerifierRunner,
  useVerifierRunner,
  VerifierUnavailable,
} from '../../scoring/verifier-runner.js';
import { saveSuiteDraft, type SaveDraftOutput } from './save-draft.js';
import { quietLogger, SaveWorld } from './save-world.support-spec.js';
import { SuitesDir, SuitesDirGuardError } from './suites-dir.js';

vi.setConfig({ testTimeout: 120_000 });

let world: SaveWorld;

beforeEach(async () => {
  world = await SaveWorld.create();
  await world.load('complete');
});

afterEach(async () => {
  useVerifierRunner(null);
  await world.close();
});

const versions = () => world.t.db.select().from(suites).where(eq(suites.sourcePath, 'complete'));

async function editPrompt(key: string, extra: string): Promise<void> {
  await world.writer.write('complete', undefined, async (ctx) => {
    const task = ctx.task(key);
    await ctx.change(task, { prompt: `${task.prompt ?? ''}${extra}` });
  });
}

const onDisk = (path: string) => join(world.suitesDir, 'complete', path);

describe('the conflict check', () => {
  it('answers version_moved when a reload created a newer version, and writes nothing', async () => {
    await world.open('complete');
    await editPrompt('numeric', '\nRound to cents.\n');
    await writeFile(onDisk('exact/prompt.md'), 'Edited on disk. Reply with ```json\n');
    expect((await world.load('complete')).versionNumber).toBe(2);
    const before = await world.snapshot();

    const output = await world.save('complete');
    if (output.kind !== 'conflict') throw new Error(JSON.stringify(output));
    expect(DraftConflictSchema.parse(output.conflict)).toMatchObject({
      cause: 'version_moved',
      baseVersion: 1,
      current: { versionNumber: 2 },
      diskChanges: { changed: ['exact'] },
      draftKeys: ['numeric'],
      overlap: [],
    });
    expect(await world.snapshot()).toEqual(before);
    expect(await versions()).toHaveLength(2);
    expect((await world.draft('complete')).saveStartedAt).toBeNull();
  });

  it('loads files edited on disk without a reload first, then answers disk_changed with that version', async () => {
    await world.open('complete');
    await editPrompt('exact', '\nMine.\n');
    await writeFile(onDisk('exact/prompt.md'), 'Theirs. Reply with ```json\n');
    const before = await world.snapshot();

    const output = await world.save('complete');
    if (output.kind !== 'conflict') throw new Error(JSON.stringify(output));
    expect(output.conflict).toMatchObject({
      cause: 'disk_changed',
      baseVersion: 1,
      current: { versionNumber: 2 },
      diskChanges: { changed: ['exact'] },
      draftKeys: ['exact'],
      overlap: ['exact'],
    });
    // The disk's files are now v2, recorded by the save; nothing on disk changed.
    const [source] = await world.t.db
      .select()
      .from(suiteSources)
      .where(eq(suiteSources.path, 'complete'));
    expect(source!.currentSuiteId).toBe(output.conflict.current.suiteId);
    expect(await world.snapshot()).toEqual(before);
    expect((await world.draft('complete')).baseSuiteId).not.toBe(output.conflict.current.suiteId);
  });
});

describe('files edited by hand while the save runs', () => {
  /**
   * Saves the draft, editing the folder by hand once staging is built: the
   * self-checks of the staging folder wait until the edit is written, so it
   * lands after the files were copied and before the swap.
   */
  async function saveWhileEditing(edit: () => Promise<void>): Promise<SaveDraftOutput> {
    let open!: () => void;
    const edited = new Promise<void>((resolve) => (open = resolve));
    useVerifierRunner({
      run: async (options) => {
        await edited;
        return subprocessVerifierRunner.run(options);
      },
    });
    let started = false;
    return saveSuiteDraft(await world.claim('complete'), {
      db: world.t.db,
      blobs: world.store,
      suitesDir: world.suitesDir,
      logger: quietLogger,
      progress: async (_id, _claim, progress) => {
        if (progress.step !== 'loading' || started) return;
        started = true;
        await edit();
        open();
      },
    });
  }

  it('loads an edit of a file the version stores and answers disk_changed, keeping it', async () => {
    await world.open('complete');
    await editPrompt('numeric', '\nRound to cents.\n');
    const output = await saveWhileEditing(() =>
      writeFile(onDisk('exact/prompt.md'), 'Edited by hand. Reply with ```json\n'),
    );
    if (output.kind !== 'conflict') throw new Error(JSON.stringify(output));
    expect(output.conflict).toMatchObject({
      cause: 'disk_changed',
      current: { versionNumber: 2 },
      diskChanges: { changed: ['exact'] },
      draftKeys: ['numeric'],
    });
    expect(await readFile(onDisk('exact/prompt.md'), 'utf8')).toBe(
      'Edited by hand. Reply with ```json\n',
    );
    expect(await readFile(onDisk('numeric/prompt.md'), 'utf8')).not.toContain('Round to cents.');
    expect(Object.keys(await world.snapshot()).some((p) => p.startsWith('.draft-'))).toBe(false);
    expect((await world.draft('complete')).saveStartedAt).toBeNull();
  });

  it('stops before the swap for an edit of a file no version stores, keeping it', async () => {
    await world.open('complete');
    await editPrompt('numeric', '\nRound to cents.\n');
    let before = {};
    const output = await saveWhileEditing(async () => {
      await writeFile(onDisk('README.md'), 'Written by hand during the save.\n');
      await writeFile(onDisk('exact/NOTES.md'), 'notes\n');
      before = await world.snapshot(onDisk('.'));
    });
    expect(output).toEqual({
      kind: 'not_saved',
      step: 'moving',
      error: expect.objectContaining({
        file: '.',
        message: './suites/complete changed on disk during the save; save again',
      }),
    });
    expect(await world.snapshot(onDisk('.'))).toEqual(before);
    expect(Object.keys(await world.snapshot()).some((p) => p.startsWith('.draft-'))).toBe(false);
    expect(await versions()).toHaveLength(1);
    expect((await world.draft('complete')).saveStartedAt).toBeNull();
  });
});

describe('a staging folder the loader refuses', () => {
  it('leaves disk untouched and keeps the draft, with the loader message, file and line', async () => {
    await world.open('complete');
    await world.writer.write('complete', undefined, async (ctx) => {
      await ctx.change(ctx.task('numeric'), { taskYaml: 'summary: [unclosed\nlimits: {}\n' });
    });
    const before = await world.snapshot();
    const output = await world.save('complete');
    expect(output).toMatchObject({
      kind: 'not_saved',
      step: 'loading',
      error: { file: 'numeric/task.yaml', line: expect.any(Number) },
    });
    expect(await world.snapshot()).toEqual(before);
    expect(await versions()).toHaveLength(1);
    const draft = await world.draft('complete');
    expect(draft.saveStartedAt).toBeNull();
    expect(draft.saveProgress).toBeNull();
  });

  it('refuses a name another folder holds', async () => {
    const other = join(world.suitesDir, 'other-dir');
    await cp(join(world.suitesDir, 'complete'), other, { recursive: true });
    const yaml = await readFile(join(other, 'suite.yaml'), 'utf8');
    await writeFile(join(other, 'suite.yaml'), yaml.replace('name: complete', 'name: zz-taken'));
    expect((await world.load('other-dir')).outcome).toBe('created');
    await world.open('zz-taken', 'complete');
    const output = await world.save('zz-taken');
    expect(output).toMatchObject({
      kind: 'not_saved',
      step: 'loading',
      error: {
        file: 'suite.yaml',
        message:
          'suite name zz-taken is already used by directory other-dir; give one of them another name',
      },
    });
    expect(Object.keys(await world.snapshot()).some((p) => p.startsWith('zz-taken/'))).toBe(false);
  });
});

describe('a verifier that cannot run', () => {
  it('saves nothing and answers unavailable', async () => {
    await world.open('complete');
    await editPrompt('numeric', '\n');
    useVerifierRunner({
      run: () => Promise.reject(new VerifierUnavailable('could not start the verifier container')),
    });
    const before = await world.snapshot();
    expect(await world.save('complete')).toEqual({
      kind: 'unavailable',
      message: 'could not start the verifier container',
    });
    expect(await world.snapshot()).toEqual(before);
    expect(await versions()).toHaveLength(1);
    expect((await world.draft('complete')).saveStartedAt).toBeNull();
  });
});

describe('the SUITES_DIR guard', () => {
  it('lets the save name only suite and staging folders directly under SUITES_DIR', async () => {
    const dir = await SuitesDir.open(world.suitesDir);
    expect(dir.folder('complete')).toBe(join(dir.root, 'complete'));
    expect(dir.folder('.draft-01K8ZQ7M3V5X9C2B4N6P8R0T1W')).toMatch(/\.draft-/);
    for (const name of ['..', '.', '', 'a/b', '../suites', '.git', '.draft-x', '/etc']) {
      expect(() => dir.folder(name), name).toThrow(SuitesDirGuardError);
    }
    expect(() => dir.inside(join(dir.root, '..', 'outside.txt'))).toThrow(SuitesDirGuardError);
    expect(() => dir.inside(join(dir.root, '.git', 'config'))).toThrow(SuitesDirGuardError);
    expect(dir.inside(join(dir.root, 'complete', 'numeric', 'x'))).toMatch(/numeric/);
  });
});
