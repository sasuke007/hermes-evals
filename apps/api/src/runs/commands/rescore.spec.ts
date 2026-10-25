/**
 * Re-score over HTTP (plan 9.4, UI_FLOWS 17 and 18) on PGlite with a real
 * pg-boss and the real evaluate-run handler: only a scored run, a new
 * generation and its job in one transaction, double requests collapsing,
 * the judge's provider, the bulk form with its refusals, and what the dead
 * letter of a re-score leaves current.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  BulkRescoreResultSchema,
  RescoreRunResultSchema,
  RunDetailSchema,
  RunListResultSchema,
} from '@hermes-evals/shared';
import { experiments, runs } from '../../database/schema/index.js';
import { claimEvaluation } from '../../evaluation/claim.js';
import { handleEvaluateRunDeadJob } from '../../evaluation/dead-letter.js';
import {
  createCommandsApp,
  launched,
  type CommandsApp,
  type Launched,
} from '../../experiments/commands/commands-app.support-spec.js';
import {
  claimRun,
  experimentRow,
  finishRun,
  runsOf,
} from '../../experiments/commands/commands-seed.support-spec.js';
import { SCORER_VERSIONS } from '../../scoring/registry.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { viewsConfig } from '../views/run-fixtures-spec.js';
import { RunViewsService } from '../views/run-views.service.js';
import {
  evaluateRunJobKeys,
  evaluationsOf,
  executeRun,
  grade,
  launchedWithJudge,
  quietLogger,
  scoreRun,
  scoresOf,
  scratchStore,
} from './rescore-seed.support-spec.js';

let c: CommandsApp;
let x: Launched;
let store: BlobStore;
let disposeStore: () => Promise<void>;

beforeEach(async () => {
  c = await createCommandsApp();
  x = await launched(c);
  ({ store, dispose: disposeStore } = await scratchStore());
});

afterEach(async () => {
  await c.close();
  await disposeStore();
});

const refusal = (res: { body: unknown }) => ApiErrorBodySchema.parse(res.body).message;
const rescored = (res: { body: unknown }) => RescoreRunResultSchema.parse(res.body);
const views = () => new RunViewsService(c.t.db, store, viewsConfig({}));

describe('POST /api/runs/:id/rescore', () => {
  it('queues generation 2 with its job; the run stays scored on generation 1 until it publishes', async () => {
    const [run] = await runsOf(c.t.db, x.id);
    const first = await scoreRun(c, store, run!.id, x.workerId);
    const revision = (await experimentRow(c.t.db, x.id)).resultsRevision;

    const answer = rescored(await c.post(`/runs/${run!.id}/rescore`).expect(200));
    expect(answer).toMatchObject({
      runId: run!.id,
      status: 'scored',
      attempt: null,
      evaluation: { generation: 2, status: 'queued', cause: 'rescore' },
      joinedPending: false,
    });
    const created = answer.evaluation.evaluationId;
    expect(await evaluationsOf(c.t.db, run!.id)).toEqual([
      expect.objectContaining({ id: first.evaluationId, generation: 1, status: 'completed' }),
      expect.objectContaining({ id: created, generation: 2, status: 'queued', cause: 'rescore' }),
    ]);
    expect(await evaluateRunJobKeys(c)).toContain(created);
    const [stored] = await c.t.db.select().from(runs).where(eq(runs.id, run!.id));
    expect(stored!.status).toBe('scored');
    // Queueing changes no result, so the results revision stays.
    expect((await experimentRow(c.t.db, x.id)).resultsRevision).toBe(revision);

    const detail = RunDetailSchema.parse(await views().detail(run!.id));
    expect(detail.evaluation).toEqual({
      generation: 1,
      pending: answer.evaluation,
      lastFailure: null,
    });
    const row = RunListResultSchema.parse(await views().list(x.id, {})).rows.find(
      (r) => r.id === run!.id,
    );
    expect(row).toMatchObject({ status: 'scored', generation: 1, rescorePending: true });
  });

  it('answers a second request with the pending re-score instead of a second one', async () => {
    const [run] = await runsOf(c.t.db, x.id);
    await scoreRun(c, store, run!.id, x.workerId);
    const first = rescored(await c.post(`/runs/${run!.id}/rescore`).expect(200));
    const second = rescored(await c.post(`/runs/${run!.id}/rescore`).expect(200));
    expect(second).toEqual({ ...first, joinedPending: true });
    expect((await evaluationsOf(c.t.db, run!.id)).map((e) => e.generation)).toEqual([1, 2]);
    expect(
      (await evaluateRunJobKeys(c)).filter((k) => k === first.evaluation.evaluationId),
    ).toHaveLength(1);
    // Still collapsing once a worker has claimed it.
    expect(await claimEvaluation(c.t.db, first.evaluation.evaluationId)).not.toBeNull();
    const third = rescored(await c.post(`/runs/${run!.id}/rescore`).expect(200));
    expect(third).toMatchObject({
      joinedPending: true,
      evaluation: { evaluationId: first.evaluation.evaluationId, status: 'running' },
    });
  });

  it('publishes the new generation with the current scorer versions and supersedes the old', async () => {
    const [run] = await runsOf(c.t.db, x.id);
    const first = await scoreRun(c, store, run!.id, x.workerId);
    const revision = (await experimentRow(c.t.db, x.id)).resultsRevision;
    const { evaluation } = rescored(await c.post(`/runs/${run!.id}/rescore`).expect(200));

    expect(await grade(c.t.db, store, evaluation.evaluationId)).toBe('published');
    // A duplicate delivery after the publish changes nothing.
    expect(await grade(c.t.db, store, evaluation.evaluationId)).toBe('finished');
    const [old, fresh] = await evaluationsOf(c.t.db, run!.id);
    expect(old).toMatchObject({ id: first.evaluationId, status: 'completed' });
    expect(old!.supersededAt).toBeInstanceOf(Date);
    expect(fresh).toMatchObject({ generation: 2, status: 'completed', supersededAt: null });
    expect(await scoresOf(c.t.db, evaluation.evaluationId)).toEqual([
      { key: 'answer', status: 'passed', scorerVersion: SCORER_VERSIONS.exact_match },
    ]);
    const [stored] = await c.t.db.select().from(runs).where(eq(runs.id, run!.id));
    expect(stored!.status).toBe('scored');
    expect((await experimentRow(c.t.db, x.id)).resultsRevision).toBeGreaterThan(revision);
    expect(RunDetailSchema.parse(await views().detail(run!.id)).evaluation).toEqual({
      generation: 2,
      pending: null,
      lastFailure: null,
    });

    // And again: generation 3.
    const next = rescored(await c.post(`/runs/${run!.id}/rescore`).expect(200));
    expect(next.evaluation.generation).toBe(3);
  });

  it('refuses a run that is not scored, and 404s an unknown one, writing nothing', async () => {
    const [queued, executed, errored] = await runsOf(c.t.db, x.id);
    expect(refusal(await c.post(`/runs/${queued!.id}/rescore`).expect(409))).toBe(
      'run is queued, not scored',
    );
    await executeRun(c, executed!.id, x.workerId);
    expect(refusal(await c.post(`/runs/${executed!.id}/rescore`).expect(409))).toBe(
      'run is executed, not scored',
    );
    const attempt = await claimRun(c.t.db, errored!.id, x.workerId);
    await finishRun(c.t.db, errored!.id, attempt, { status: 'execution_error' });
    expect(refusal(await c.post(`/runs/${errored!.id}/rescore`).expect(409))).toBe(
      'run is execution_error, not scored',
    );
    expect(refusal(await c.post('/runs/run_gone/rescore').expect(404))).toBe(
      'run run_gone not found',
    );
    expect(await evaluationsOf(c.t.db, errored!.id)).toEqual([]);
    expect((await evaluationsOf(c.t.db, executed!.id)).map((e) => e.generation)).toEqual([1]);
  });

  it('re-scores a run of a completed experiment, which stays completed', async () => {
    const all = await runsOf(c.t.db, x.id);
    for (const run of all) await scoreRun(c, store, run.id, x.workerId);
    expect((await experimentRow(c.t.db, x.id)).status).toBe('completed');
    const { evaluation } = rescored(await c.post(`/runs/${all[0]!.id}/rescore`).expect(200));
    expect(await grade(c.t.db, store, evaluation.evaluationId)).toBe('published');
    const experiment = await experimentRow(c.t.db, x.id);
    expect(experiment.status).toBe('completed');
    // Reconcile moved the verdict revision up to the new results revision.
    expect(experiment.verdictRevision).toBe(experiment.resultsRevision);
  });
});

describe('the judge', () => {
  /** The scored run of the task with the llm_judge key. */
  async function judgedRun(): Promise<string> {
    await c.close();
    c = await createCommandsApp();
    x = await launchedWithJudge(c);
    const alpha = x.suite.taskIds.get('alpha')!;
    const run = (await runsOf(c.t.db, x.id)).find((r) => r.taskId !== alpha)!;
    await scoreRun(c, store, run.id, x.workerId);
    return run.id;
  }

  it("refuses while the judge's provider is not ready, then queues once it is", async () => {
    const runId = await judgedRun();
    c.nous.status = 'not_connected';
    expect(refusal(await c.post(`/runs/${runId}/rescore`).expect(409))).toBe(
      'Re-score needs Nous Portal for the method judge: Nous Portal is not connected.',
    );
    expect(await evaluationsOf(c.t.db, runId)).toHaveLength(1);
    c.nous.status = 'connected';
    expect(rescored(await c.post(`/runs/${runId}/rescore`).expect(200)).evaluation.generation).toBe(
      2,
    );
  });

  it('asks nothing of a task without llm_judge keys', async () => {
    const [run] = await runsOf(c.t.db, x.id);
    await scoreRun(c, store, run!.id, x.workerId);
    c.nous.status = 'not_connected';
    await c.post(`/runs/${run!.id}/rescore`).expect(200);
  });
});

describe('POST /api/experiments/:id/runs/rescore', () => {
  it('re-scores the scored runs, joins a pending one and refuses the others with their reason', async () => {
    const [a, b, executed, queued] = await runsOf(c.t.db, x.id);
    await scoreRun(c, store, a!.id, x.workerId);
    await scoreRun(c, store, b!.id, x.workerId);
    await executeRun(c, executed!.id, x.workerId);
    const pending = rescored(await c.post(`/runs/${b!.id}/rescore`).expect(200));

    const res = await c
      .post(`/experiments/${x.id}/runs/rescore`, {
        runIds: [queued!.id, b!.id, 'run_gone', a!.id, executed!.id],
      })
      .expect(200);
    const result = BulkRescoreResultSchema.parse(res.body);
    expect(result).toMatchObject({
      action: 'rescore',
      enqueued: [b!.id, a!.id],
      refused: [
        { runId: queued!.id, reason: 'run is queued, not scored' },
        { runId: 'run_gone', reason: 'run not found in this experiment' },
        { runId: executed!.id, reason: 'run is executed, not scored' },
      ],
    });
    expect(result.evaluations).toEqual([
      {
        runId: b!.id,
        evaluationId: pending.evaluation.evaluationId,
        generation: 2,
        status: 'queued',
        joinedPending: true,
      },
      {
        runId: a!.id,
        evaluationId: expect.any(String),
        generation: 2,
        status: 'queued',
        joinedPending: false,
      },
    ]);
    expect(await evaluateRunJobKeys(c)).toContain(result.evaluations[1]!.evaluationId);
  });

  it('refuses the judged runs while the judge is not ready, and validates the body', async () => {
    await c.close();
    c = await createCommandsApp();
    x = await launchedWithJudge(c);
    const ids: string[] = [];
    for (const run of await runsOf(c.t.db, x.id)) {
      await scoreRun(c, store, run.id, x.workerId);
      ids.push(run.id);
    }
    const alpha = x.suite.taskIds.get('alpha')!;
    const judged = (await runsOf(c.t.db, x.id)).filter((r) => r.taskId !== alpha);
    c.nous.status = 'not_connected';
    const result = BulkRescoreResultSchema.parse(
      (await c.post(`/experiments/${x.id}/runs/rescore`, { runIds: ids }).expect(200)).body,
    );
    expect(result.refused).toEqual(
      judged.map((r) => ({
        runId: r.id,
        reason: 'Re-score needs Nous Portal for the method judge: Nous Portal is not connected.',
      })),
    );
    expect(result.enqueued).toHaveLength(ids.length - judged.length);

    await c.post(`/experiments/${x.id}/runs/rescore`, { runIds: [] }).expect(400);
    await c.post(`/experiments/${x.id}/runs/rescore`, { runIds: [ids[0], ids[0]] }).expect(400);
    await c.post('/experiments/exp_gone/runs/rescore', { runIds: ids }).expect(404);
  });

  it("stays within its own experiment's runs", async () => {
    const [run] = await runsOf(c.t.db, x.id);
    await scoreRun(c, store, run!.id, x.workerId);
    const e = await experimentRow(c.t.db, x.id);
    const [other] = await c.t.db
      .insert(experiments)
      .values({
        name: 'other',
        suiteId: e.suiteId,
        taskIds: e.taskIds,
        baselineVersionId: e.baselineVersionId,
        candidateVersionIds: e.candidateVersionIds,
        repetitions: 1,
        concurrency: 1,
        hermesVersion: e.hermesVersion,
        hermesRevision: e.hermesRevision,
        priceTable: e.priceTable,
      })
      .returning({ id: experiments.id });
    const result = BulkRescoreResultSchema.parse(
      (await c.post(`/experiments/${other!.id}/runs/rescore`, { runIds: [run!.id] }).expect(200))
        .body,
    );
    expect(result.refused).toEqual([
      { runId: run!.id, reason: 'run not found in this experiment' },
    ]);
  });
});

describe('the dead letter of a re-score', () => {
  it('marks it failed and leaves the previous result current; a later re-score goes on', async () => {
    const [run] = await runsOf(c.t.db, x.id);
    const first = await scoreRun(c, store, run!.id, x.workerId);
    const { evaluation } = rescored(await c.post(`/runs/${run!.id}/rescore`).expect(200));
    const outcome = await handleEvaluateRunDeadJob(
      {
        data: { evaluationId: evaluation.evaluationId },
        sourceOutput: { message: 'verifier timed out' },
        sourceRetryCount: 2,
      },
      { db: c.t.db },
      quietLogger(),
    );
    expect(outcome).toBe('failed');
    expect(await evaluationsOf(c.t.db, run!.id)).toEqual([
      expect.objectContaining({ id: first.evaluationId, status: 'completed', supersededAt: null }),
      expect.objectContaining({
        generation: 2,
        status: 'failed',
        error: 'grading failed after 3 tries: verifier timed out',
      }),
    ]);
    const [stored] = await c.t.db.select().from(runs).where(eq(runs.id, run!.id));
    expect(stored!.status).toBe('scored');
    const detail = RunDetailSchema.parse(await views().detail(run!.id));
    expect(detail.evaluation).toEqual({
      generation: 1,
      pending: null,
      lastFailure: {
        generation: 2,
        error: 'grading failed after 3 tries: verifier timed out',
        finishedAt: expect.any(String),
      },
    });
    expect(detail.scores.map((s) => [s.key, s.status])).toEqual([['answer', 'passed']]);

    const again = rescored(await c.post(`/runs/${run!.id}/rescore`).expect(200));
    expect(again).toMatchObject({ joinedPending: false, evaluation: { generation: 3 } });
  });
});
