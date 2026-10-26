/**
 * The draft jobs in the worker, on PGlite with a draft of a fixture suite:
 * the self-check of one task on its files written to scratch (the same
 * content hash the API computed in memory), a task with load errors, a task
 * gone meanwhile, a verifier that cannot run, and the handlers' wiring.
 */
import { and, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { suiteDraftTasks } from '../../database/schema/index.js';
import { QUEUES } from '../../queue/queues.js';
import { useVerifierRunner, VerifierUnavailable } from '../../scoring/verifier-runner.js';
import { SaveWorld, quietLogger } from '../../suites/save/save-world.support-spec.js';
import {
  handleSaveSuiteDraftJob,
  handleSelfCheckDraftJob,
  registerDraftJobHandlers,
} from './draft-jobs.js';

vi.setConfig({ testTimeout: 120_000 });

let world: SaveWorld;

beforeEach(async () => {
  world = await SaveWorld.create();
  await world.load('complete');
  await world.open('complete');
});

afterEach(async () => {
  useVerifierRunner(null);
  await world.close();
});

const deps = () => ({
  db: world.t.db,
  blobs: world.store,
  suitesDir: world.suitesDir,
  logger: quietLogger,
});

async function draftTask(key: string) {
  const draft = await world.draft('complete');
  const [row] = await world.t.db
    .select()
    .from(suiteDraftTasks)
    .where(and(eq(suiteDraftTasks.draftId, draft.id), eq(suiteDraftTasks.key, key)));
  return row!;
}

describe('self-check-draft', () => {
  it("runs the loader's self-check on the task's files and returns it with the task's content hash", async () => {
    const task = await draftTask('summary_file');
    const output = await handleSelfCheckDraftJob(
      { draftTaskId: task.id, contentHash: task.contentHash },
      deps(),
    );
    if (output.kind !== 'checked') throw new Error(JSON.stringify(output));
    // Written to disk and hashed by the loader, the folder is what the API analysed in memory.
    expect(output.record.content_hash).toBe(task.contentHash);
    expect(output.record).toMatchObject({ status: 'passed', ran_at: expect.any(String) });
    expect(output.record.results.map((r) => [r.key, r.expect ?? 'pass', r.status])).toEqual([
      ['summary_csv', 'pass', 'passed'],
      ['summary_csv', 'fail', 'failed'],
      ['totals', 'pass', 'passed'],
      ['totals', 'fail', 'failed'],
    ]);
  });

  it('runs nothing for a task with load errors, and answers gone for a task deleted meanwhile', async () => {
    await world.writer.write('complete', undefined, async (ctx) => {
      await ctx.change(ctx.task('numeric'), { reference: '{ not json' });
    });
    const task = await draftTask('numeric');
    const output = await handleSelfCheckDraftJob({ draftTaskId: task.id, contentHash: '' }, deps());
    expect(output).toMatchObject({ kind: 'checked', record: { status: 'skipped', ran_at: null } });
    expect(await handleSelfCheckDraftJob({ draftTaskId: 'nope', contentHash: '' }, deps())).toEqual(
      { kind: 'gone' },
    );
  });

  it('answers unavailable when a verifier cannot be run at all', async () => {
    useVerifierRunner({ run: () => Promise.reject(new VerifierUnavailable('guard is down')) });
    const task = await draftTask('answer_verifier');
    expect(
      await handleSelfCheckDraftJob({ draftTaskId: task.id, contentHash: '' }, deps()),
    ).toEqual({ kind: 'unavailable', message: 'guard is down' });
  });
});

describe('the handlers', () => {
  it('refuse job data they do not understand', async () => {
    await expect(handleSelfCheckDraftJob({ draftTaskId: 3 }, deps())).rejects.toThrow();
    await expect(
      handleSaveSuiteDraftJob({ draftId: 'x', claim: 'yesterday' }, deps()),
    ).rejects.toThrow();
  });

  it('save a claimed draft and report it', async () => {
    const job = await world.claim('complete');
    expect(await handleSaveSuiteDraftJob(job, deps())).toMatchObject({
      kind: 'saved',
      result: { outcome: 'unchanged' },
    });
  });

  it('consume both queues, saves one at a time', async () => {
    const work = vi.fn(async (queue: string) => `worker:${queue}`);
    const ids = await registerDraftJobHandlers({ work } as unknown as PgBoss, deps());
    expect(ids).toEqual([`worker:${QUEUES.selfCheckDraft}`, `worker:${QUEUES.saveSuiteDraft}`]);
    expect(work).toHaveBeenCalledWith(
      QUEUES.saveSuiteDraft,
      { batchSize: 1, localConcurrency: 1 },
      expect.any(Function),
    );
  });
});
