/**
 * GET /runs/:id and the Runs tab while a re-score publishes between the
 * reads one view makes, on PGlite. The publish is slipped in just before a
 * chosen statement runs, by wrapping PGlite's query. Whichever statement it
 * lands before, the scores shown must be the generation the view names, and
 * a pending re-score is reported exactly while that older result is shown.
 *
 * The run is dup_invoices/with-skill/1 of run-states-spec.ts: generation 1
 * passed, generation 2 queued. Its publish here makes the primary `failed`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunDetailSchema, RunListResultSchema } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { publishQueuedRescore } from './evaluation-seed-spec.js';
import { viewsConfig } from './run-fixtures-spec.js';
import { dupScores, seedAllStates, type AllStates } from './run-states-spec.js';
import { evaluationStatesOfRun, primaryScores } from './run-views.queries.js';
import { RunViewsService } from './run-views.service.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const CELL = 'dup_invoices/with-skill/1' as const;

/** The evaluation states of one run, and of a whole experiment (run-views.queries.ts). */
const STATES_OF_RUN = /from "evaluations" where .* order by "evaluations"\."generation" asc/s;
const STATES_OF_EXPERIMENT =
  /order by "evaluations"\."run_id" asc, "evaluations"\."generation" asc/;
const SCORES = /from "scores"/;

let t: TestDatabase;
let seed: AllStates;
let views: RunViewsService;
let restore: (() => void) | null = null;

beforeEach(async () => {
  t = await createTestDatabase();
  seed = await seedAllStates(t.db);
  views = new RunViewsService(t.db, seed.store, viewsConfig());
});

afterEach(async () => {
  restore?.();
  restore = null;
  await t.close();
  await seed.dispose();
});

/** Publishes the queued generation 2, its primary `failed`. */
const publishGeneration2 = () =>
  publishQueuedRescore(
    t.db,
    seed.pendingRescore,
    'Done.\n```json\n{"duplicates": [["INV-1"]]}\n```',
    dupScores(
      { key: 'answer', type: 'json_match', primary: true, status: 'failed', comment: 'wrong' },
      { status: 'failed', comment: 'verifier printed score 0' },
    ),
  );

/** Publishes generation 2 once, just before the first statement whose SQL matches `when`. */
function publishBefore(when: RegExp): { fired: () => boolean } {
  const pg = t.pg;
  const original = pg.query.bind(pg);
  let fired = false;
  const wrapped = async (query: string, ...rest: unknown[]) => {
    if (!fired && when.test(query)) {
      fired = true;
      await publishGeneration2();
    }
    return (original as (q: string, ...r: unknown[]) => ReturnType<typeof original>)(
      query,
      ...rest,
    );
  };
  pg.query = wrapped as typeof pg.query;
  restore = () => {
    pg.query = original;
  };
  return { fired: () => fired };
}

const detail = async () => RunDetailSchema.parse(await views.detail(seed.cell(CELL)));

const row = async () =>
  RunListResultSchema.parse(await views.list(seed.experimentId, {})).rows.find(
    (r) => r.id === seed.cell(CELL),
  )!;

describe('GET /runs/:id while a re-score publishes', () => {
  it('published before the states are read: generation 2 and its scores, nothing pending', async () => {
    const race = publishBefore(STATES_OF_RUN);
    const run = await detail();
    expect(race.fired()).toBe(true);
    expect(run.evaluation).toMatchObject({ generation: 2, pending: null });
    expect(run.primary).toMatchObject({ key: 'answer', status: 'failed' });
    expect(run.scores.map((s) => s.status)).toEqual(['failed', 'error', 'failed']);
  });

  it('published after the states, before the scores: generation 1 and its scores, 2 pending', async () => {
    const race = publishBefore(SCORES);
    const run = await detail();
    expect(race.fired()).toBe(true);
    expect(run.evaluation).toMatchObject({
      generation: 1,
      pending: { evaluationId: seed.pendingRescore.id, generation: 2, cause: 'rescore' },
    });
    expect(run.primary).toMatchObject({ key: 'answer', status: 'passed' });
    expect(run.scores.map((s) => s.status)).toEqual(['passed', 'error', 'passed']);
  });
});

describe('the Runs tab while a re-score publishes', () => {
  it('published before the states are read: generation 2 and its primary score', async () => {
    const race = publishBefore(STATES_OF_EXPERIMENT);
    const shown = await row();
    expect(race.fired()).toBe(true);
    expect(shown).toMatchObject({
      generation: 2,
      rescorePending: false,
      primaryScore: { key: 'answer', status: 'failed', score: 0 },
    });
  });

  it('published after the states, before the scores: generation 1, its primary, re-score pending', async () => {
    const race = publishBefore(SCORES);
    const shown = await row();
    expect(race.fired()).toBe(true);
    expect(shown).toMatchObject({
      generation: 1,
      rescorePending: true,
      primaryScore: { key: 'answer', status: 'passed', score: 1 },
    });
  });
});

describe('primaryScores', () => {
  it('reads the primary of exactly the evaluations it is given, superseded or not', async () => {
    await publishGeneration2();
    const runId = seed.cell(CELL);
    const states = await evaluationStatesOfRun(t.db, runId);
    const [first, second] = states.map((s) => s.id);
    // Both generations keep their score rows; which one is read is the caller's choice.
    const of = async (ids: string[]) =>
      (await primaryScores(t.db, seed.experimentId, new Set(ids))).get(runId);
    expect(await of([first!])).toMatchObject({ key: 'answer', status: 'passed' });
    expect(await of([second!])).toMatchObject({ key: 'answer', status: 'failed' });
    expect(await of([])).toBeUndefined();
  });
});
