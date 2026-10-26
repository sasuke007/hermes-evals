/**
 * A save is durable as well as atomic (Phase 5b question 4, settled for
 * Phase 7): SuitesDir.syncTree fsyncs every file and folder of the staging
 * folder, and the save calls it before the swap and fsyncs SUITES_DIR after
 * the renames. A save that moves nothing syncs nothing.
 */
import { chmod, mkdir, open, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { SaveWorld } from './save-world.support-spec.js';
import { stagingName, SuitesDir } from './suites-dir.js';

vi.setConfig({ testTimeout: 120_000 });

let world: SaveWorld;

beforeEach(async () => {
  world = await SaveWorld.create();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await world.close();
});

describe('SuitesDir.syncTree', () => {
  it('fsyncs every file and folder of a folder under SUITES_DIR, and leaves links be', async () => {
    const dir = await SuitesDir.open(world.suitesDir);
    const root = dir.folder('.draft-01J9ZQ4S6V8W0X2Y4Z6A8B0C2D');
    await mkdir(join(root, 'task/fixtures/empty'), { recursive: true });
    await writeFile(join(root, 'suite.yaml'), 'name: x\n');
    await writeFile(join(root, 'task/prompt.md'), 'Say hi.\n');
    await writeFile(join(root, 'task/fixtures/a.csv'), 'a\n');
    await symlink('a.csv', join(root, 'task/fixtures/link.csv'));
    // Each fsync itself, on the prototype every FileHandle shares (it still does its work).
    const probe = await open(join(root, 'suite.yaml'), 'r');
    const handles = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const sync = vi.spyOn(handles, 'sync');
    // 3 files and 4 folders (the root, task, fixtures, empty); the link is not opened.
    expect(await dir.syncTree('.draft-01J9ZQ4S6V8W0X2Y4Z6A8B0C2D')).toBe(7);
    expect(sync).toHaveBeenCalledTimes(7);
    // An author's file the worker may not open is copied as it was and let be.
    await chmod(join(root, 'task/fixtures/a.csv'), 0o000);
    expect(await dir.syncTree('.draft-01J9ZQ4S6V8W0X2Y4Z6A8B0C2D')).toBe(6);
    await chmod(join(root, 'task/fixtures/a.csv'), 0o644);
    await expect(dir.syncTree('../outside')).rejects.toThrow(/refusing to write outside/);
  });
});

describe('a save', () => {
  /** Spies on the save's fsyncs and renames (each still does its work); `calls()` lists them in order. */
  function watch(): { calls: () => string[] } {
    const spies = [
      ['syncTree', vi.spyOn(SuitesDir.prototype, 'syncTree')],
      ['syncRoot', vi.spyOn(SuitesDir.prototype, 'syncRoot')],
      ['move', vi.spyOn(SuitesDir.prototype, 'move')],
    ] as const;
    return {
      calls: () =>
        spies
          .flatMap(([name, spy]) =>
            spy.mock.calls.map((args, i): [number, string] => [
              spy.mock.invocationCallOrder[i]!,
              [name, args.join(' → ')].filter(Boolean).join(' '),
            ]),
          )
          .sort((a, b) => a[0] - b[0])
          .map(([, call]) => call),
    };
  }

  it('fsyncs the staging folder before the swap and SUITES_DIR after it', async () => {
    await world.load('complete');
    await world.open('complete');
    await world.writer.write('complete', undefined, async (ctx) => {
      const task = ctx.task('numeric');
      await ctx.change(task, { prompt: `${task.prompt ?? ''}\nRound to cents.\n` });
    });
    const staging = stagingName((await world.draft('complete')).id);
    const { calls } = watch();
    expect(await world.save('complete')).toMatchObject({ kind: 'saved' });
    expect(calls()).toEqual([
      `syncTree ${staging}`,
      `move complete → ${staging}-old`,
      `move ${staging} → complete`,
      'syncRoot',
    ]);
  });

  it('syncs nothing when the staging folder is the live one', async () => {
    await world.load('complete');
    await world.open('complete');
    const { calls } = watch();
    expect(await world.save('complete')).toMatchObject({ kind: 'saved' });
    expect(calls()).toEqual([]);
  });
});
