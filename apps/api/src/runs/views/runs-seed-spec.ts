/**
 * An experiment whose runs sit in every state the Runs tab and the inspector
 * draw, written row by row the way the worker writes them (attempt, events,
 * artifacts, then the finish; evaluation, scores, then the publish), so the
 * 0001 and 0004 triggers check every step. Artifact bytes go to a real blob
 * store in a temp directory.
 *
 *   2 tasks (dup_invoices, total_due) x baseline, with-skill x 5 repetitions
 *
 * Test-only: the name ends in `spec.ts` so the build leaves it out, but not
 * in `.spec.ts`, so vitest does not run it as a test file.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { ArtifactOrigin, RunEventPayload } from '@hermes-evals/shared';
import { HERMES_REVISION, runningClaim, sha } from '../../../test/support/seed.js';
import type { TestDb } from '../../../test/support/database.js';
import {
  artifacts,
  attempts,
  configurationVersions,
  configurations,
  evaluations,
  experiments,
  runEvents,
  runs,
  scores,
  suiteSources,
  suites,
  taskFiles,
  tasks,
  workers,
} from '../../database/schema/index.js';
import { extractAnswer } from '../../scoring/extraction.js';
import { BlobStore } from '../../storage/blob-store.js';
import type { EventRecord } from './rows.js';
import {
  DUP_VERIFICATION,
  DUP_YAML,
  INVOICES_CSV,
  LEAKED_TOKEN,
  MOCK_BASE_URL,
  TOTAL_VERIFICATION,
  TRIAL_IMAGE,
  launchRecord,
  type AttemptEnd,
  type RunCell,
  type ScoreSeed,
} from './run-fixtures-spec.js';

export async function seedRunStates(db: TestDb) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-run-views-'));
  const store = new BlobStore(dataDir);
  const blob = async (content: string) => {
    const ref = await store.putBuffer(Buffer.from(content));
    await store.recordBlob(db, ref);
    return ref.sha256;
  };

  const [suite] = await db
    .insert(suites)
    .values({
      sourcePath: 'invoices-v1',
      versionNumber: 1,
      name: 'invoices-v1',
      versionLabel: '1.0',
      contentHash: sha('suite'),
      checkHash: sha('checks'),
      taskCount: 2,
      validCount: 2,
    })
    .returning();
  await db.insert(suiteSources).values({
    path: 'invoices-v1',
    name: 'invoices-v1',
    currentSuiteId: suite!.id,
    lastOutcome: 'created',
  });
  const selfCheck = { status: 'passed' as const, ran_at: null, duration_ms: null, results: [] };
  const limits = { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file'] };
  const taskRows = await db
    .insert(tasks)
    .values([
      {
        suiteId: suite!.id,
        key: 'dup_invoices',
        versionNumber: 2,
        introducedInSuiteId: suite!.id,
        position: 0,
        summary: 'Find invoices billed twice',
        prompt: 'Find duplicates.',
        limits,
        reference: { duplicates: [['INV-1042', 'INV-1107']] },
        verification: DUP_VERIFICATION,
        taskYaml: DUP_YAML,
        selfCheck,
        valid: true,
        contentHash: sha('dup'),
      },
      {
        suiteId: suite!.id,
        key: 'total_due',
        versionNumber: 1,
        introducedInSuiteId: suite!.id,
        position: 1,
        summary: 'Total amount still due',
        prompt: 'Sum what is due.',
        limits,
        reference: { total_due: 1042 },
        verification: TOTAL_VERIFICATION,
        taskYaml: null,
        selfCheck,
        valid: true,
        contentHash: sha('total'),
      },
    ])
    .returning();
  const [dup, total] = taskRows as [(typeof taskRows)[0], (typeof taskRows)[0]];
  const fixtureSha = await blob(INVOICES_CSV);
  await db.insert(taskFiles).values({
    taskId: dup.id,
    path: 'fixtures/invoices.csv',
    kind: 'fixture',
    sha256: fixtureSha,
    size: INVOICES_CSV.length,
  });

  const versionIds: string[] = [];
  for (const name of ['baseline', 'with-skill']) {
    const id = await db.transaction(async (tx) => {
      const [configuration] = await tx.insert(configurations).values({ name }).returning();
      const [version] = await tx
        .insert(configurationVersions)
        .values({
          configurationId: configuration!.id,
          version: 1,
          model: 'mock/scripted',
          provider: 'custom',
          baseUrl: MOCK_BASE_URL,
          toolsets: ['file', 'terminal'],
          maxTurns: 20,
          timeBudgetS: 300,
          configHash: sha(`config ${name}`),
          frozenAt: new Date(),
        })
        .returning();
      return version!.id;
    });
    versionIds.push(id);
  }
  const [baselineId, candidateId] = versionIds as [string, string];

  const [worker] = await db
    .insert(workers)
    .values({
      hostname: 'worker-1',
      concurrency: 3,
      slots: 4,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      lastHeartbeatAt: new Date('2026-10-24T15:31:04.000Z'),
      sandbox: {
        state: 'isolated',
        checks: [],
        checked_at: '2026-10-24T09:00:00.000Z',
        image: TRIAL_IMAGE,
        revision: HERMES_REVISION,
        image_digest: `sha256:${'7a'.repeat(32)}`,
      },
    })
    .returning();

  const [experiment] = await db
    .insert(experiments)
    .values({
      name: 'Skill vs no skill',
      suiteId: suite!.id,
      taskIds: [dup.id, total.id],
      baselineVersionId: baselineId,
      candidateVersionIds: [candidateId],
      repetitions: 5,
      concurrency: 2,
      timeBudgetOverrideS: 120,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      priceTable: { sha256: sha('prices'), loaded_at: '2026-10-24T09:00:00.000Z', models: {} },
    })
    .returning();
  const cells = new Map<RunCell, string>();
  for (const task of [dup, total]) {
    for (const [config, versionId] of [
      ['baseline', baselineId],
      ['with-skill', candidateId],
    ] as const) {
      for (let rep = 1; rep <= 5; rep++) {
        const [run] = await db
          .insert(runs)
          .values({
            experimentId: experiment!.id,
            taskId: task.id,
            configurationVersionId: versionId,
            repetition: rep,
          })
          .returning();
        cells.set(`${task.key as 'dup_invoices' | 'total_due'}/${config}/${rep}`, run!.id);
      }
    }
  }

  const cell = (name: RunCell) => {
    const id = cells.get(name);
    if (!id) throw new Error(`no run ${name}`);
    return id;
  };

  /** Claims the run the way the worker does: a running attempt and the run pointing at it. */
  const start = async (
    name: RunCell,
    number = 1,
    startedAt = new Date('2026-10-24T15:30:00.000Z'),
  ) => {
    const runId = cell(name);
    return db.transaction(async (tx) => {
      const [attempt] = await tx
        .insert(attempts)
        .values({
          runId,
          number,
          trigger: number === 1 ? 'initial' : 'auto_retry',
          status: 'running',
          workerId: worker!.id,
          startedAt,
          trialPath: `trials/${runId}/a${number}`,
          launchRecord: launchRecord(fixtureSha, number === 1 ? LEAKED_TOKEN : '<attempt token>'),
        })
        .returning({ id: attempts.id });
      await tx
        .update(runs)
        .set({
          status: 'running',
          attemptCount: number,
          currentAttemptId: attempt!.id,
          finishedAt: null,
        })
        .where(eq(runs.id, runId));
      return attempt!.id;
    });
  };

  const addEvents = async (attemptId: string, list: readonly EventRecord[]) => {
    if (list.length === 0) return;
    await db.insert(runEvents).values(
      list.map((e) => ({
        attemptId,
        seq: e.seq,
        ts: e.ts,
        type: e.type,
        payload: e.payload as RunEventPayload,
      })),
    );
  };

  const addArtifact = async (
    attemptId: string,
    path: string,
    content: string | null,
    origin: ArtifactOrigin,
  ) => {
    const sha256 = content === null ? null : await blob(content);
    const [row] = await db
      .insert(artifacts)
      .values({
        attemptId,
        path,
        origin,
        size: content === null ? 30 * 1024 * 1024 : Buffer.byteLength(content),
        sha256,
        skippedReason: content === null ? 'too_large' : null,
      })
      .returning({ id: artifacts.id });
    return row!.id;
  };

  /** Ends the attempt, and the run with it unless it was executed (scoring comes next). */
  const end = async (name: RunCell, attemptId: string, e: AttemptEnd) => {
    const [row] = await db
      .select({ startedAt: attempts.startedAt })
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    const durationMs = e.durationMs ?? 40_000;
    const finishedAt = new Date(row!.startedAt.getTime() + durationMs);
    await db.transaction(async (tx) => {
      await tx
        .update(attempts)
        .set({
          status: e.status,
          finishedAt,
          durationMs,
          exitCode: e.exitCode ?? (e.status === 'executed' ? 0 : null),
          errorCategory: e.category ?? null,
          errorMessage: e.message ?? null,
          finalText: e.finalText ?? null,
          tokens: e.tokens ?? null,
          costUsd: e.costUsd ?? null,
          stderrTail: e.stderrTail ?? null,
        })
        .where(eq(attempts.id, attemptId));
      await tx
        .update(runs)
        .set(
          e.status === 'executed'
            ? { status: 'executed' }
            : e.status === 'cancelled'
              ? {
                  status: 'cancelled',
                  finishedAt,
                  cancelRequestedAt: new Date(finishedAt.getTime() - 1000),
                }
              : { status: 'execution_error', finishedAt },
        )
        .where(eq(runs.id, cell(name)));
    });
  };

  /** Recovery's path: revoke the lease, say so in the timeline, end the attempt as worker_lost. */
  const loseWorker = async (name: RunCell, attemptId: string, seq = 1) => {
    await db.update(attempts).set({ leaseRevokedAt: new Date() }).where(eq(attempts.id, attemptId));
    await addEvents(attemptId, [
      {
        seq,
        ts: Date.now(),
        type: 'platform',
        payload: { type: 'platform', subtype: 'worker_lost' },
      },
    ]);
    await db.transaction(async (tx) => {
      await tx
        .update(attempts)
        .set({
          status: 'execution_error',
          errorCategory: 'worker_lost',
          finishedAt: new Date(),
          stderrTail: 'recovery: lease expired',
        })
        .where(eq(attempts.id, attemptId));
      await tx
        .update(runs)
        .set({ status: 'execution_error', finishedAt: new Date() })
        .where(eq(runs.id, cell(name)));
    });
  };

  /** An execution_error run back to queued, as a retry leaves it before the next claim. */
  const requeue = (name: RunCell) =>
    db
      .update(runs)
      .set({ status: 'queued', finishedAt: null })
      .where(and(eq(runs.id, cell(name)), eq(runs.status, 'execution_error')));

  /** Scores the executed attempt and publishes, as evaluate-run does. */
  const score = async (
    name: RunCell,
    attemptId: string,
    finalText: string,
    list: readonly ScoreSeed[],
  ) => {
    const runId = cell(name);
    await db.transaction(async (tx) => {
      const [evaluation] = await tx
        .insert(evaluations)
        .values({ runId, attemptId, cause: 'initial', generation: 1, ...runningClaim() })
        .returning({ id: evaluations.id });
      await tx.insert(scores).values(
        list.map((s) => ({
          evaluationId: evaluation!.id,
          key: s.key,
          type: s.type,
          status: s.status,
          isPrimary: s.primary ?? false,
          score: s.score ?? (s.status === 'passed' ? 1 : s.status === 'failed' ? 0 : null),
          comment: s.comment,
          expected: (s.expected ?? null) as never,
          observed: (s.observed ?? null) as never,
          evidence: s.evidence ?? {},
          scorerVersion: 1,
        })),
      );
      await tx
        .update(evaluations)
        .set({ status: 'completed', finishedAt: new Date(), answer: extractAnswer(finalText) })
        .where(eq(evaluations.id, evaluation!.id));
      await tx
        .update(runs)
        .set({ status: 'scored', finishedAt: new Date() })
        .where(eq(runs.id, runId));
    });
  };

  return {
    store,
    dispose: () => rm(dataDir, { recursive: true, force: true }),
    experimentId: experiment!.id,
    suiteId: suite!.id,
    baselineId,
    candidateId,
    workerId: worker!.id,
    fixtureSha,
    cell,
    start,
    addEvents,
    addArtifact,
    end,
    loseWorker,
    requeue,
    score,
  };
}

export type SeededRunStates = Awaited<ReturnType<typeof seedRunStates>>;
