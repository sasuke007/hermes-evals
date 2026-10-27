/**
 * Unfenced answers through the evaluation pipeline on PGlite (Phase 8 G5):
 * a final reply that is exactly one JSON object, without a ```json fence, is
 * graded like a fenced one, and a re-score of a run stored before the rule
 * extracts again from the stored text and applies it. Scorer versions stay
 * as they were. The extraction rule itself is covered in
 * scoring/extraction.spec.ts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExtractedAnswerSchema, FinalResponseViewSchema } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { evaluations, runs, scores } from '../database/schema/index.js';
import { finalResponseView } from '../runs/views/final-response.js';
import { extractionComment } from '../scoring/extraction.js';
import { SCORER_VERSIONS } from '../scoring/registry.js';
import { ungradable } from '../scoring/result.js';
import { BlobStore } from '../storage/blob-store.js';
import { claimEvaluation } from './claim.js';
import { handleEvaluateRunJob } from './evaluate-run.handler.js';
import { publishEvaluation } from './publish.js';
import type { ScoredEvaluation } from './score.js';
import {
  executeRun,
  logger,
  recordingReconcile,
  seedScenario,
  type ScenarioTask,
} from './support-spec.js';

const TASK: ScenarioTask = {
  reference: { total_due: 99760.52, currency: 'USD' },
  verification: [
    {
      key: 'total',
      type: 'numeric_tolerance',
      primary: true,
      params: { path: 'total_due', abs: 0.01 },
    },
    { key: 'currency', type: 'exact_match', primary: false, params: { path: 'currency' } },
  ],
};

/** What the real model replied: the right answer, without the fence. */
const UNFENCED_REPLY = '{\n  "total_due": 99760.52,\n  "currency": "USD"\n}\n';

let t: TestDatabase;
let dataDir: string;
let store: BlobStore;

beforeAll(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-unfenced-'));
  store = new BlobStore(dataDir);
});

afterAll(async () => {
  await t?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const scoresOf = async (evaluationId: string) => {
  const rows = await t.db
    .select()
    .from(scores)
    .where(eq(scores.evaluationId, evaluationId))
    .orderBy(asc(scores.key));
  return Object.fromEntries(rows.map((row) => [row.key, row]));
};

const evaluationRow = async (id: string) =>
  (await t.db.select().from(evaluations).where(eq(evaluations.id, id)))[0]!;

const UNFENCED_ANSWER = {
  status: 'found',
  block_count: 0,
  start: 0,
  end: UNFENCED_REPLY.trimEnd().length,
  value: { total_due: 99760.52, currency: 'USD' },
  unfenced: true,
};

describe('an unfenced answer in the evaluation pipeline', () => {
  it('grades a reply that is one JSON object and stores the extraction flagged unfenced', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const { evaluationId } = await executeRun(t.db, store, scenario, scenario.runIds[0]!, {
      finalText: UNFENCED_REPLY,
    });
    const deps = { db: t.db, store, reconcile: recordingReconcile().reconcile };
    expect(await handleEvaluateRunJob({ evaluationId }, deps, logger())).toEqual({
      evaluationId,
      outcome: 'published',
    });

    const byKey = await scoresOf(evaluationId);
    expect(byKey.total).toMatchObject({ status: 'passed', score: 1, isPrimary: true });
    expect(byKey.currency).toMatchObject({ status: 'passed', score: 1 });
    const stored = ExtractedAnswerSchema.parse((await evaluationRow(evaluationId)).answer);
    expect(stored).toEqual(UNFENCED_ANSWER);
  });

  it('applies the rule on a re-score of a run graded before it, with the same scorer versions', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { attemptId, evaluationId: firstId } = await executeRun(t.db, store, scenario, runId, {
      finalText: UNFENCED_REPLY,
    });
    const deps = { db: t.db, store, reconcile: recordingReconcile().reconcile };

    // Publish the first generation as Phase 7 graded this reply: no answer, every key ungradable.
    const claim = (await claimEvaluation(t.db, firstId))!;
    const missing = { status: 'missing', block_count: 0 } as const;
    const before: ScoredEvaluation = {
      answer: missing,
      scores: TASK.verification.map((entry) => ({
        key: entry.key,
        type: entry.type,
        isPrimary: entry.primary,
        scorerVersion: SCORER_VERSIONS[entry.type],
        result: ungradable(extractionComment(missing)),
      })),
    };
    expect(await publishEvaluation(t.db, claim, before, deps.reconcile)).toBe('published');
    expect((await scoresOf(firstId)).total).toMatchObject({
      status: 'ungradable',
      comment: 'no fenced JSON block found in final response',
    });

    // POST /runs/:id/rescore inserts the next generation over the same stored attempt.
    const [rescore] = await t.db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'rescore', generation: 2 })
      .returning({ id: evaluations.id });
    const result = await handleEvaluateRunJob({ evaluationId: rescore!.id }, deps, logger());
    expect(result.outcome).toBe('published');

    const after = await scoresOf(rescore!.id);
    expect(after.total).toMatchObject({ status: 'passed', score: 1 });
    expect(after.currency).toMatchObject({ status: 'passed', score: 1 });
    for (const row of Object.values(after)) {
      expect(row.scorerVersion).toBe(SCORER_VERSIONS[row.type]);
      expect(row.scorerVersion).toBe((await scoresOf(firstId))[row.key]!.scorerVersion);
    }
    const stored = ExtractedAnswerSchema.parse((await evaluationRow(rescore!.id)).answer);
    expect(stored).toEqual(UNFENCED_ANSWER);
    expect((await evaluationRow(firstId)).supersededAt).toBeInstanceOf(Date);
    expect((await t.db.select().from(runs).where(eq(runs.id, runId)))[0]!.status).toBe('scored');

    // The inspector shows the re-score's extraction: the trimmed reply, no fence, the note's flag.
    const view = FinalResponseViewSchema.parse(finalResponseView(UNFENCED_REPLY, stored, null));
    expect(view).toMatchObject({ extraction: 'found', unfenced: true, fence: null });
    expect(UNFENCED_REPLY.slice(view.extracted!.start, view.extracted!.end)).toBe(
      UNFENCED_REPLY.trim(),
    );
  });
});
