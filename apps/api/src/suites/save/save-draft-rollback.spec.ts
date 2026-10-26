/**
 * A save that fails after it began to move folders (plan 4.6 step 4): the
 * record of the staging folder failing once the folders were swapped, and
 * the second rename itself failing. Either way the live folder is back
 * where it was, nothing is left under a `.draft-` name, no version is
 * recorded and the draft is kept, released for edits again.
 */
import { rename } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { suites } from '../../database/schema/index.js';
import { SaveWorld, type Snapshot } from './save-world.support-spec.js';
import { asideName, stagingName, SuitesDir } from './suites-dir.js';

const failures = vi.hoisted(() => ({ persist: false }));

vi.mock('../loader/persist.js', async (original) => {
  const actual = await original<typeof import('../loader/persist.js')>();
  return {
    ...actual,
    persistSuite: (...args: Parameters<typeof actual.persistSuite>) => {
      if (failures.persist) return Promise.reject(new Error('the record failed'));
      return actual.persistSuite(...args);
    },
  };
});

vi.setConfig({ testTimeout: 120_000 });

let world: SaveWorld;

beforeEach(async () => {
  world = await SaveWorld.create();
  await world.load('complete');
  await world.open('complete');
  await world.writer.write('complete', undefined, async (ctx) => {
    const task = ctx.task('numeric');
    await ctx.change(task, { prompt: `${task.prompt ?? ''}\nRound to cents.\n` });
  });
});

afterEach(async () => {
  failures.persist = false;
  vi.restoreAllMocks();
  await world.close();
});

const versions = () => world.t.db.select().from(suites).where(eq(suites.sourcePath, 'complete'));

const isStaging = (name: string) => name.startsWith('.draft-') && !name.endsWith('-old');

/** Spies on the save's renames, failing the one `fail` picks; returns each rename made, as `from → to`. */
async function watchMoves(fail: (from: string, to: string) => void): Promise<{
  moves: string[];
  staging: string;
  aside: string;
}> {
  const draft = await world.draft('complete');
  const moves: string[] = [];
  vi.spyOn(SuitesDir.prototype, 'move').mockImplementation(async function (
    this: SuitesDir,
    from: string,
    to: string,
  ) {
    fail(from, to);
    // What SuitesDir.move does, without the spy.
    await rename(this.folder(from), this.folder(to));
    moves.push(`${from} → ${to}`);
  });
  return { moves, staging: stagingName(draft.id), aside: asideName(draft.id) };
}

async function expectNothingChanged(before: Snapshot): Promise<void> {
  const after = await world.snapshot();
  expect(after).toEqual(before);
  expect(Object.keys(after).some((p) => p.startsWith('.draft-'))).toBe(false);
  expect(await versions()).toHaveLength(1);
  expect((await world.draft('complete')).saveStartedAt).toBeNull();
}

it('puts the live folder back when recording the swapped folder fails', async () => {
  const before = await world.snapshot();
  const { moves, staging, aside } = await watchMoves((from, to) => {
    // Once staging is in place, the record that follows fails.
    if (isStaging(from) && to === 'complete') failures.persist = true;
  });
  await expect(world.save('complete')).rejects.toThrow('the record failed');
  expect(moves).toEqual([
    `complete → ${aside}`,
    `${staging} → complete`,
    `complete → ${staging}`,
    `${aside} → complete`,
  ]);
  await expectNothingChanged(before);
});

it('puts the live folder back when moving the staging folder into place fails', async () => {
  const before = await world.snapshot();
  const { moves, aside } = await watchMoves((from, to) => {
    if (isStaging(from) && to === 'complete') throw new Error('EXDEV: the rename failed');
  });
  await expect(world.save('complete')).rejects.toThrow('EXDEV: the rename failed');
  expect(moves).toEqual([`complete → ${aside}`, `${aside} → complete`]);
  await expectNothingChanged(before);
});
