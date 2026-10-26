/**
 * Combine onto the newer version (board SA.12), on PGlite with the real
 * loader: the draft keeps its own edits, follows the disk elsewhere, takes
 * the side the user chose for a task both changed, gains the tasks the disk
 * added, drops a task both removed, and then saves as the version after.
 * Changes both sides agree on (both removed, or the same bytes) ask nothing,
 * and an upload refused for its size stays reported (Phase 5b question 11).
 */
import { cp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AUTHORING_LIMITS, type RebaseSuiteDraftRequest } from '@hermes-evals/shared';
import { loadDraft } from '../drafts/draft-store.js';
import { rebaseDraft } from './rebase.js';
import { SaveWorld } from './save-world.support-spec.js';

vi.setConfig({ testTimeout: 120_000 });

let world: SaveWorld;

beforeEach(async () => {
  world = await SaveWorld.create();
  await world.load('complete');
  await world.open('complete');
});

afterEach(async () => {
  await world.close();
});

const onDisk = (path: string) => join(world.suitesDir, 'complete', path);

async function editPrompt(key: string, extra: string): Promise<void> {
  await world.writer.write('complete', undefined, async (ctx) => {
    const task = ctx.task(key);
    await ctx.change(task, { prompt: `${task.prompt ?? ''}${extra}` });
  });
}

const rebase = (request: RebaseSuiteDraftRequest) =>
  rebaseDraft(world.t.db, world.store, 'complete', request);

async function states(): Promise<Record<string, string>> {
  const stored = await loadDraft(world.t.db, await world.draft('complete'));
  return Object.fromEntries(stored.tasks.map((t) => [t.key, t.state]));
}

/** The tasks whose readiness reports an upload refused for its size (file_limits). */
async function refusedIn(): Promise<string[]> {
  const stored = await loadDraft(world.t.db, await world.draft('complete'));
  return stored.tasks
    .filter((t) =>
      t.readiness?.rules.some((r) => r.rule === 'file_limits' && r.status === 'problem'),
    )
    .map((t) => t.key)
    .sort();
}

describe('rebaseDraft', () => {
  beforeEach(async () => {
    await editPrompt('exact', '\nMine.\n');
    await editPrompt('numeric', '\nAlso mine.\n');
    // On disk: exact changed too (the overlap), json_unordered changed, a task added.
    await writeFile(onDisk('exact/prompt.md'), 'Theirs. Reply with ```json\n');
    await writeFile(onDisk('json_unordered/prompt.md'), 'Edited on disk. Reply with ```json\n');
    await cp(onDisk('numeric'), onDisk('numeric_copy'), { recursive: true });
    expect((await world.load('complete')).versionNumber).toBe(2);
  });

  it('needs a side for every task both changed, and the version the user saw', async () => {
    await expect(rebase({ onto: 2, choices: [] })).rejects.toMatchObject({
      response: {
        statusCode: 400,
        message: 'Choose which version to keep of exact before combining.',
      },
    });
    await expect(
      rebase({ onto: 1, choices: [{ key: 'exact', keep: 'mine' }] }),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        conflict: { current: { versionNumber: 2 }, overlap: ['exact'] },
      },
    });
  });

  it('keeps mine where chosen, follows the disk elsewhere, and saves as v3', async () => {
    await rebase({ onto: 2, choices: [{ key: 'exact', keep: 'mine' }] });
    expect(await states()).toEqual({
      numeric: 'changed',
      json_unordered: 'unchanged',
      exact: 'changed',
      summary_file: 'unchanged',
      answer_verifier: 'unchanged',
      numeric_copy: 'unchanged',
    });
    const draft = await world.draft('complete');
    expect(draft.revision).toBeGreaterThan(0);
    const output = await world.save('complete');
    if (output.kind !== 'saved') throw new Error(JSON.stringify(output));
    expect(output.result).toMatchObject({
      outcome: 'created',
      suite: { versionNumber: 3 },
      changes: { changed: ['numeric', 'exact'], added: [], removed: [] },
    });
  });

  it("takes the disk's side when chosen", async () => {
    await rebase({ onto: 2, choices: [{ key: 'exact', keep: 'disk' }] });
    expect((await states()).exact).toBe('unchanged');
    expect((await states()).numeric).toBe('changed');
  });

  it('drops a task both sides removed', async () => {
    await world.writer.write('complete', undefined, async (ctx) => {
      await ctx.change(ctx.task('summary_file'), { removed: true });
    });
    await rm(onDisk('summary_file'), { recursive: true });
    const yaml = join(world.suitesDir, 'complete', 'suite.yaml');
    await writeFile(
      yaml,
      "name: complete\nversion_label: '1.0'\ndescription: Every scorer type, each proven by its self-check.\ntasks: [numeric, json_unordered, exact, answer_verifier]\n",
    );
    expect((await world.load('complete')).versionNumber).toBe(3);
    // Both removed it: the sides agree, so it is no part of the overlap (Phase 5b question 6).
    await expect(rebase({ onto: 2, choices: [] })).rejects.toMatchObject({
      response: { statusCode: 409, conflict: { overlap: ['exact'] } },
    });
    await rebase({ onto: 3, choices: [{ key: 'exact', keep: 'mine' }] });
    expect(await states()).not.toHaveProperty('summary_file');
  });

  it('keeps reporting an upload refused for its size, on a task it keeps and one that follows the disk', async () => {
    // Reported until the path holds a file, is deleted or the task is reverted: a Combine is none.
    const refusal = {
      path: 'fixtures/ledger-2025.parquet',
      kind: 'fixture' as const,
      sizeBytes: null,
      limitBytes: AUTHORING_LIMITS.suiteMaxFileBytes,
      refusedAt: new Date().toISOString(),
    };
    await world.writer.write('complete', undefined, async (ctx) => {
      for (const key of ['numeric', 'summary_file']) {
        await ctx.change(ctx.task(key), { refusedUploads: [refusal] });
      }
    });
    expect(await refusedIn()).toEqual(['numeric', 'summary_file']);
    await rebase({ onto: 2, choices: [{ key: 'exact', keep: 'mine' }] });
    expect(await states()).toMatchObject({ numeric: 'changed', summary_file: 'unchanged' });
    expect(await refusedIn()).toEqual(['numeric', 'summary_file']);
  });

  it('asks nothing of a task both sides changed to the same bytes', async () => {
    const stored = await loadDraft(world.t.db, await world.draft('complete'));
    const mine = stored.tasks.find((t) => t.key === 'numeric')!.prompt!;
    await writeFile(onDisk('numeric/prompt.md'), mine);
    expect((await world.load('complete')).versionNumber).toBe(3);
    await expect(rebase({ onto: 2, choices: [] })).rejects.toMatchObject({
      response: { statusCode: 409, conflict: { overlap: ['exact'] } },
    });
    await rebase({ onto: 3, choices: [{ key: 'exact', keep: 'mine' }] });
    expect((await states()).numeric).toBe('unchanged');
  });
});
