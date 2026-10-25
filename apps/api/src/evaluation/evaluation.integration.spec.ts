/**
 * The evaluation pipeline on PGlite, with the real migrations and triggers:
 * every scorer type graded through the scorer context over stored evidence,
 * the answer rules of plan 9.1, and the claim, publish, supersede and
 * dead-letter rules of plan 9.4. Concurrency between deliveries is covered on
 * Postgres 17 in evaluation.e2e-spec.ts.
 */
import { mkdtemp, readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VerificationEntry } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { evaluations, experiments, runs, scores } from '../database/schema/index.js';
import { extractAnswer } from '../scoring/extraction.js';
import { SCORER_VERSIONS } from '../scoring/registry.js';
import { BlobStore } from '../storage/blob-store.js';
import { claimEvaluation } from './claim.js';
import { openScorerContext } from './context.js';
import { deadLetterReason, handleEvaluateRunDeadJob } from './dead-letter.js';
import { handleEvaluateRunJob } from './evaluate-run.handler.js';
import { loadEvidence } from './evidence.js';
import { publishEvaluation } from './publish.js';
import { scoreEvidence } from './score.js';
import {
  executeRun,
  fenced,
  logger,
  recordingReconcile,
  seedScenario,
  sha256Of,
  type ScenarioTask,
} from './support-spec.js';

const VERIFIER = `"""Checks the total and that the summary exists, then changes the workspace."""
import argparse
import json
import os

from helper import EXPECTED_TOTAL

parser = argparse.ArgumentParser()
parser.add_argument("--answer")
parser.add_argument("--workspace")
args = parser.parse_args()
with open(args.answer) as f:
    answer = json.load(f)
summary = os.path.join(args.workspace, "out", "summary.csv")
has_summary = os.path.isfile(summary)
if has_summary:
    # A verifier may change its workspace; the checks after it must not see that.
    os.remove(summary)
total_ok = isinstance(answer, dict) and abs(answer.get("total", 0) - EXPECTED_TOTAL) < 0.01
score = (0.5 if total_ok else 0.0) + (0.5 if has_summary else 0.0)
print(json.dumps({"score": score, "comment": f"total ok: {total_ok}, summary: {has_summary}"}))
`;

const VERIFICATION: VerificationEntry[] = [
  {
    key: 'answer',
    type: 'json_match',
    primary: true,
    params: { path: 'duplicates', unordered: true },
  },
  { key: 'total', type: 'numeric_tolerance', primary: false, params: { path: 'total', abs: 0.01 } },
  {
    key: 'vendor',
    type: 'exact_match',
    primary: false,
    params: { path: 'vendor', case_sensitive: false },
  },
  { key: 'script', type: 'verifier_script', primary: false, params: { script: 'check.py' } },
  {
    key: 'summary_file',
    type: 'file_check',
    primary: false,
    params: { path: 'out/summary.csv', format: 'csv', columns: ['vendor', 'total'], row_count: 2 },
  },
  { key: 'reads_fixture', type: 'trajectory_match', primary: false, params: { tool: 'read_file' } },
  { key: 'quality', type: 'llm_judge', primary: false, params: { rubric: 'rubric.md' } },
];

const TASK: ScenarioTask = {
  verification: VERIFICATION,
  reference: { duplicates: ['INV-1', 'INV-2'], total: 1042, vendor: 'Acme' },
  files: [
    { path: 'verify/check.py', kind: 'verifier', content: VERIFIER },
    { path: 'verify/helper.py', kind: 'verifier', content: 'EXPECTED_TOTAL = 1042\n' },
    { path: 'rubric.md', kind: 'rubric', content: 'Is the summary clear?\n' },
  ],
};

const SUMMARY = 'vendor,total\nAcme,1000\nGlobex,42\n';
const WORKSPACE = [
  {
    path: 'invoices.csv',
    content: 'id,vendor\nINV-1,Acme\n',
    origin: 'fixture_unchanged' as const,
  },
  { path: 'out/summary.csv', content: SUMMARY },
];
const GOOD_ANSWER = fenced({ duplicates: ['INV-2', 'INV-1'], total: 1042.004, vendor: ' acme ' });

let t: TestDatabase;
let dataDir: string;
let store: BlobStore;

beforeAll(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-evaluation-'));
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

const runRow = async (id: string) => (await t.db.select().from(runs).where(eq(runs.id, id)))[0]!;

const revision = async (experimentId: string) =>
  (await t.db.select().from(experiments).where(eq(experiments.id, experimentId)))[0]!
    .resultsRevision;

describe('scoring through the context', () => {
  it('grades every scorer type over stored evidence and publishes the set', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { evaluationId } = await executeRun(t.db, store, scenario, runId, {
      finalText: GOOD_ANSWER,
      files: WORKSPACE,
    });
    const before = await revision(scenario.experimentId);
    const { calls, reconcile } = recordingReconcile();

    const result = await handleEvaluateRunJob(
      { evaluationId },
      { db: t.db, store, reconcile },
      logger(),
    );
    expect(result).toEqual({ evaluationId, outcome: 'published' });

    const byKey = await scoresOf(evaluationId);
    expect(Object.keys(byKey).sort()).toEqual(VERIFICATION.map((v) => v.key).sort());
    expect(byKey.answer).toMatchObject({ status: 'passed', score: 1, isPrimary: true });
    expect(byKey.total).toMatchObject({ status: 'passed', score: 1, isPrimary: false });
    expect(byKey.vendor).toMatchObject({ status: 'passed', score: 1 });
    expect(byKey.script).toMatchObject({ status: 'passed', score: 1 });
    expect(byKey.script!.comment).toMatch(/total ok: True, summary: True/);
    expect(byKey.script!.evidence.script?.exit_code).toBe(0);
    // The verifier deleted out/summary.csv in its own copy; file_check still finds it.
    expect(byKey.summary_file).toMatchObject({ status: 'passed', score: 1 });
    const summaryArtifact = byKey.summary_file!.evidence.artifact_ids;
    expect(summaryArtifact).toHaveLength(1);
    // The attempt recorded no tool calls, so the trajectory check fails on its count.
    expect(byKey.reads_fixture).toMatchObject({ status: 'failed', score: 0 });
    expect(byKey.reads_fixture!.comment).toBe(
      'no call to read_file (no tool was called); needs at least 1',
    );
    // No judge client in these deps: the judge key is an error, never a zero.
    expect(byKey.quality).toMatchObject({ status: 'error', score: null });
    for (const row of Object.values(byKey)) {
      expect(row.scorerVersion).toBe(SCORER_VERSIONS[row.type]);
    }

    const evaluation = await evaluationRow(evaluationId);
    expect(evaluation).toMatchObject({ status: 'completed', error: null, supersededAt: null });
    expect(evaluation.answer).toMatchObject({ status: 'found', block_count: 1 });
    expect(evaluation.finishedAt).toBeInstanceOf(Date);
    const run = await runRow(runId);
    expect(run.status).toBe('scored');
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(await revision(scenario.experimentId)).toBeGreaterThan(before);
    expect(calls).toEqual([scenario.experimentId]);
    // Every scratch directory the context made is gone.
    expect(await readdir(store.tmpRoot)).toEqual([]);
  });

  it('makes answer keys ungradable without a JSON block, and still runs the file checks', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { evaluationId } = await executeRun(t.db, store, scenario, runId, {
      finalText: 'I wrote out/summary.csv but have no totals.',
      files: WORKSPACE,
    });
    await handleEvaluateRunJob(
      { evaluationId },
      { db: t.db, store, reconcile: recordingReconcile().reconcile },
      logger(),
    );
    const byKey = await scoresOf(evaluationId);
    for (const key of ['answer', 'total', 'vendor']) {
      expect(byKey[key]).toMatchObject({
        status: 'ungradable',
        score: null,
        comment: 'no fenced JSON block found in final response',
      });
    }
    // The verifier ran with JSON null: half the score, so failed rather than ungradable.
    expect(byKey.script).toMatchObject({ status: 'failed', score: 0.5 });
    expect(byKey.summary_file).toMatchObject({ status: 'passed' });
    expect((await evaluationRow(evaluationId)).answer).toEqual({
      status: 'missing',
      block_count: 0,
    });
    expect((await runRow(runId)).status).toBe('scored');
  });

  it('makes answer keys ungradable with the position of invalid JSON', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const { evaluationId } = await executeRun(t.db, store, scenario, scenario.runIds[0]!, {
      finalText: 'Answer:\n```json\n{"total": 1042,}\n```\n',
      files: WORKSPACE,
    });
    await handleEvaluateRunJob(
      { evaluationId },
      { db: t.db, store, reconcile: recordingReconcile().reconcile },
      logger(),
    );
    const byKey = await scoresOf(evaluationId);
    for (const key of ['answer', 'total', 'vendor']) {
      expect(byKey[key]!.status).toBe('ungradable');
      expect(byKey[key]!.comment).toMatch(/^invalid JSON at position \d+/);
    }
    expect((await evaluationRow(evaluationId)).answer).toMatchObject({ status: 'invalid' });
  });

  it('fails a wrong answer, and errors a check whose reference lacks the value', async () => {
    const task: ScenarioTask = {
      reference: { total: 1042 },
      verification: [
        { key: 'total', type: 'numeric_tolerance', primary: true, params: { path: 'total' } },
        { key: 'vendor', type: 'exact_match', primary: false, params: { path: 'vendor' } },
      ],
    };
    const scenario = await seedScenario(t.db, store, task);
    const { evaluationId } = await executeRun(t.db, store, scenario, scenario.runIds[0]!, {
      finalText: fenced({ total: 999, vendor: 'Acme' }),
    });
    await handleEvaluateRunJob(
      { evaluationId },
      { db: t.db, store, reconcile: recordingReconcile().reconcile },
      logger(),
    );
    const byKey = await scoresOf(evaluationId);
    expect(byKey.total).toMatchObject({
      status: 'failed',
      score: 0,
      expected: 1042,
      observed: 999,
    });
    expect(byKey.vendor).toMatchObject({ status: 'error', score: null });
    expect(byKey.vendor!.comment).toMatch(/reference has no value/);
  });

  it('reports a file stored without content as too large, and a missing one as absent', async () => {
    const task: ScenarioTask = {
      reference: {},
      verification: [
        {
          key: 'big',
          type: 'file_check',
          primary: true,
          params: { path: './out/big.csv', format: 'csv' },
        },
        { key: 'gone', type: 'file_check', primary: false, params: { path: 'out/none.txt' } },
      ],
    };
    const scenario = await seedScenario(t.db, store, task);
    const { evaluationId } = await executeRun(t.db, store, scenario, scenario.runIds[0]!, {
      finalText: 'done',
      skipped: [{ path: 'out/big.csv', size: 30 * 1024 * 1024 }],
    });
    await handleEvaluateRunJob(
      { evaluationId },
      { db: t.db, store, reconcile: recordingReconcile().reconcile },
      logger(),
    );
    const byKey = await scoresOf(evaluationId);
    expect(byKey.big).toMatchObject({ status: 'failed', score: 0 });
    expect(byKey.big!.comment).toMatch(/was not stored because it is larger than/);
    expect(byKey.big!.evidence.artifact_ids).toHaveLength(1);
    expect(byKey.gone).toMatchObject({ status: 'failed', comment: 'out/none.txt does not exist' });
  });

  it('errors the file-based keys when a stored file is missing from the blob store', async () => {
    const lost = 'a summary whose blob file goes missing\n';
    const task: ScenarioTask = {
      reference: {},
      verification: [
        { key: 'summary', type: 'file_check', primary: true, params: { path: 'lost.txt' } },
        { key: 'script', type: 'verifier_script', primary: false, params: { script: 'check.py' } },
      ],
      files: [{ path: 'verify/check.py', kind: 'verifier', content: VERIFIER }],
    };
    const scenario = await seedScenario(t.db, store, task);
    const { evaluationId } = await executeRun(t.db, store, scenario, scenario.runIds[0]!, {
      finalText: 'done',
      files: [{ path: 'lost.txt', content: lost }],
    });
    await unlink(store.path(sha256Of(lost)));
    await handleEvaluateRunJob(
      { evaluationId },
      { db: t.db, store, reconcile: recordingReconcile().reconcile },
      logger(),
    );
    const byKey = await scoresOf(evaluationId);
    expect(byKey.summary).toMatchObject({ status: 'error', score: null });
    expect(byKey.summary!.comment).toMatch(/^could not rebuild the workspace/);
    expect(byKey.script).toMatchObject({ status: 'error', score: null });
    expect(await readdir(store.tmpRoot)).toEqual([]);
  });
});

describe('claim and publish', () => {
  it('lets only the newest claim publish, and a redelivery after publishing do nothing', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { evaluationId } = await executeRun(t.db, store, scenario, runId, {
      finalText: GOOD_ANSWER,
      files: WORKSPACE,
    });
    const { reconcile } = recordingReconcile();

    const first = await claimEvaluation(t.db, evaluationId);
    expect(first).not.toBeNull();
    expect((await runRow(runId)).status).toBe('scoring');
    const second = await claimEvaluation(t.db, evaluationId);
    expect(second!.token).not.toBe(first!.token);

    const evidence = await loadEvidence(t.db, first!);
    const scored = (await scoreEvidence(evidence!, { db: t.db, store }))!;
    expect(await publishEvaluation(t.db, first!, scored, reconcile)).toBe('lost');
    expect(await scoresOf(evaluationId)).toEqual({});
    expect((await evaluationRow(evaluationId)).status).toBe('running');

    expect(await publishEvaluation(t.db, second!, scored, reconcile)).toBe('published');
    expect(Object.keys(await scoresOf(evaluationId))).toHaveLength(VERIFICATION.length);

    // A delivery after publishing finds nothing to claim.
    expect(await claimEvaluation(t.db, evaluationId)).toBeNull();
    const again = await handleEvaluateRunJob(
      { evaluationId },
      { db: t.db, store, reconcile },
      logger(),
    );
    expect(again.outcome).toBe('finished');
    expect(Object.keys(await scoresOf(evaluationId))).toHaveLength(VERIFICATION.length);
  });

  it('supersedes the previous result when a newer generation publishes', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { attemptId, evaluationId: firstId } = await executeRun(t.db, store, scenario, runId, {
      finalText: GOOD_ANSWER,
      files: WORKSPACE,
    });
    const deps = { db: t.db, store, reconcile: recordingReconcile().reconcile };
    await handleEvaluateRunJob({ evaluationId: firstId }, deps, logger());
    const scoredAt = (await runRow(runId)).finishedAt;

    const [rescore] = await t.db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'rescore', generation: 2 })
      .returning({ id: evaluations.id });
    const result = await handleEvaluateRunJob({ evaluationId: rescore!.id }, deps, logger());
    expect(result.outcome).toBe('published');

    expect((await evaluationRow(firstId)).supersededAt).toBeInstanceOf(Date);
    expect(await evaluationRow(rescore!.id)).toMatchObject({
      status: 'completed',
      supersededAt: null,
    });
    const current = await t.db
      .select({ id: evaluations.id })
      .from(evaluations)
      .where(
        and(
          eq(evaluations.runId, runId),
          eq(evaluations.status, 'completed'),
          isNull(evaluations.supersededAt),
        ),
      );
    expect(current).toEqual([{ id: rescore!.id }]);
    // The run stays scored with its first finish time; old scores stay readable.
    const run = await runRow(runId);
    expect(run.status).toBe('scored');
    expect(run.finishedAt).toEqual(scoredAt);
    expect(Object.keys(await scoresOf(firstId))).toHaveLength(VERIFICATION.length);
  });
});

describe('the dead letter', () => {
  const failedJob = (evaluationId: string) => ({
    data: { evaluationId },
    sourceOutput: {
      name: 'Error',
      message: 'boom\nsecond line',
      stack: 'Error: boom\n    at score (x.ts:1:1)',
    },
    sourceRetryCount: 2,
  });

  it('publishes one error score per key for a first evaluation, so the run is scored', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { evaluationId } = await executeRun(t.db, store, scenario, runId, {
      finalText: GOOD_ANSWER,
      files: WORKSPACE,
    });
    // The last delivery had claimed it and moved the run to scoring.
    await claimEvaluation(t.db, evaluationId);
    const { calls, reconcile } = recordingReconcile();

    const outcome = await handleEvaluateRunDeadJob(
      failedJob(evaluationId),
      { db: t.db, reconcile },
      logger(),
    );
    expect(outcome).toBe('error_scores');

    const byKey = await scoresOf(evaluationId);
    expect(Object.keys(byKey).sort()).toEqual(VERIFICATION.map((v) => v.key).sort());
    for (const row of Object.values(byKey)) {
      expect(row).toMatchObject({
        status: 'error',
        score: null,
        comment: 'grading failed after 3 tries: boom',
        evidence: {
          error: { message: 'grading failed after 3 tries: boom', detail: 'at score (x.ts:1:1)' },
        },
      });
    }
    expect(byKey.answer!.isPrimary).toBe(true);
    expect(await evaluationRow(evaluationId)).toMatchObject({
      status: 'completed',
      error: 'grading failed after 3 tries: boom',
      answer: { status: 'found' },
    });
    expect((await runRow(runId)).status).toBe('scored');
    expect(calls).toEqual([scenario.experimentId]);
  });

  it('reads the message of a job pg-boss expired', () => {
    expect(
      deadLetterReason({
        data: {},
        sourceOutput: { value: { message: 'job timed out' } },
        sourceRetryCount: 0,
      }),
    ).toEqual({ message: 'grading failed after 1 try: job timed out', detail: null });
  });

  it('publishes error scores for a first evaluation that was never claimed', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { evaluationId } = await executeRun(t.db, store, scenario, runId, {
      finalText: 'no answer',
    });
    const outcome = await handleEvaluateRunDeadJob(
      { data: { evaluationId }, sourceOutput: null, sourceRetryCount: null },
      { db: t.db, reconcile: recordingReconcile().reconcile },
      logger(),
    );
    expect(outcome).toBe('error_scores');
    const byKey = await scoresOf(evaluationId);
    expect(byKey.answer!.comment).toBe('grading failed on every try; the worker log has the error');
    expect((await runRow(runId)).status).toBe('scored');
  });

  it('marks a re-score failed and keeps the previous result current', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { attemptId, evaluationId: firstId } = await executeRun(t.db, store, scenario, runId, {
      finalText: GOOD_ANSWER,
      files: WORKSPACE,
    });
    const reconcile = recordingReconcile().reconcile;
    await handleEvaluateRunJob({ evaluationId: firstId }, { db: t.db, store, reconcile }, logger());
    const [rescore] = await t.db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'rescore', generation: 2 })
      .returning({ id: evaluations.id });

    const outcome = await handleEvaluateRunDeadJob(
      failedJob(rescore!.id),
      { db: t.db, reconcile },
      logger(),
    );
    expect(outcome).toBe('failed');
    const failed = await evaluationRow(rescore!.id);
    expect(failed).toMatchObject({ status: 'failed', error: 'grading failed after 3 tries: boom' });
    expect(failed.startedAt).toBeInstanceOf(Date);
    expect(failed.finishedAt).toBeInstanceOf(Date);
    expect(await scoresOf(rescore!.id)).toEqual({});
    expect(await evaluationRow(firstId)).toMatchObject({ status: 'completed', supersededAt: null });
    expect((await runRow(runId)).status).toBe('scored');
  });

  it('changes nothing for an evaluation that already finished, or one that does not exist', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const { evaluationId } = await executeRun(t.db, store, scenario, scenario.runIds[0]!, {
      finalText: GOOD_ANSWER,
      files: WORKSPACE,
    });
    const deps = { db: t.db, store, reconcile: recordingReconcile().reconcile };
    await handleEvaluateRunJob({ evaluationId }, deps, logger());
    const before = await scoresOf(evaluationId);
    expect(await handleEvaluateRunDeadJob(failedJob(evaluationId), deps, logger())).toBe(
      'finished',
    );
    expect(await scoresOf(evaluationId)).toEqual(before);
    expect(await handleEvaluateRunDeadJob(failedJob('nope'), deps, logger())).toBe('missing');
  });
});

describe('the scorer context', () => {
  it('reads events on demand and gives each verifier its own copy of the workspace', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { evaluationId, attemptId } = await executeRun(t.db, store, scenario, runId, {
      finalText: GOOD_ANSWER,
      files: WORKSPACE,
      events: [
        { type: 'tool_use', name: 'read_file', args: { path: 'invoices.csv' } },
        { type: 'tool_result', name: 'read_file' },
        { type: 'result', text: GOOD_ANSWER },
      ],
    });
    const evidence = await loadEvidence(t.db, { evaluationId, runId, attemptId });
    expect(evidence!.artifacts.map((a) => a.path)).toEqual(['invoices.csv', 'out/summary.csv']);
    expect(evidence!.verifierFiles.map((f) => f.path)).toEqual([
      'verify/check.py',
      'verify/helper.py',
    ]);
    const ctx = openScorerContext(evidence!, extractAnswer(GOOD_ANSWER), { db: t.db, store });
    try {
      expect((await ctx.events()).map((e) => [e.seq, e.type])).toEqual([
        [1, 'tool_use'],
        [2, 'tool_result'],
        [3, 'result'],
      ]);
      const shared = await ctx.workspace();
      expect(await ctx.workspace()).toBe(shared);
      expect(await readFile(join(shared, 'out', 'summary.csv'), 'utf8')).toBe(SUMMARY);

      const first = await ctx.verifierDirs();
      const second = await ctx.verifierDirs();
      expect(second.workspaceDir).not.toBe(first.workspaceDir);
      expect((await readdir(first.verifyDir)).sort()).toEqual(['check.py', 'helper.py']);
      expect(await readdir(first.scratchDir)).toEqual([]);
      expect(first.verifyDir.startsWith(`${first.workspaceDir}/`)).toBe(false);
      // A verifier's changes stay in its own copy.
      await unlink(join(first.workspaceDir, 'out', 'summary.csv'));
      expect(await readFile(join(second.workspaceDir, 'out', 'summary.csv'), 'utf8')).toBe(SUMMARY);
      expect(await readFile(join(shared, 'out', 'summary.csv'), 'utf8')).toBe(SUMMARY);
      await first.dispose();
      await expect(stat(first.workspaceDir)).rejects.toThrow();
    } finally {
      await ctx.close();
    }
    expect(await readdir(store.tmpRoot)).toEqual([]);
  });
});

describe('with the real reconcile', () => {
  it('completes the experiment once its last run is scored, error scores included', async () => {
    const scenario = await seedScenario(t.db, store, TASK);
    const [first, second] = scenario.runIds as [string, string];
    const a = await executeRun(t.db, store, scenario, first, {
      finalText: GOOD_ANSWER,
      files: WORKSPACE,
    });
    const b = await executeRun(t.db, store, scenario, second, { finalText: 'no answer' });
    const experiment = async () =>
      (await t.db.select().from(experiments).where(eq(experiments.id, scenario.experimentId)))[0]!;

    await handleEvaluateRunJob({ evaluationId: a.evaluationId }, { db: t.db, store }, logger());
    expect((await experiment()).status).toBe('running');

    await handleEvaluateRunDeadJob(
      {
        data: { evaluationId: b.evaluationId },
        sourceOutput: { message: 'boom' },
        sourceRetryCount: 2,
      },
      { db: t.db },
      logger(),
    );
    const done = await experiment();
    expect(done).toMatchObject({ status: 'completed', pauseReason: null });
    expect(done.verdictHistory).toEqual([
      expect.objectContaining({ cause: 'initial', results_revision: done.resultsRevision }),
    ]);
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(done.verdictRevision).toBe(done.resultsRevision);
  });
});
