/**
 * Builds what the evaluation specs grade: a task with any verification list
 * and its files stored as blobs, an experiment of that one task under a
 * baseline and a candidate, and executed attempts with collected artifacts.
 * Works on PGlite and on Postgres 17 (any AppDb). Not a spec itself.
 */
import { eq } from 'drizzle-orm';
import { vi } from 'vitest';
import type {
  ArtifactOrigin,
  ArtifactRoot,
  ArtifactSkipReason,
  JsonValue,
  RunEventPayload,
  SelfCheck,
  TaskFileKind,
  VerificationEntry,
} from '@hermes-evals/shared';
import { HERMES_REVISION, sha, startAttempt } from '../../test/support/seed.js';
import {
  artifacts,
  attempts,
  configurationVersions,
  configurations,
  evaluations,
  experiments,
  runEvents,
  runs,
  suites,
  taskFiles,
  tasks,
  workers,
} from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import type { ReconcileResult } from '../experiments/reconcile.js';
import type { BlobRef, BlobStore } from '../storage/blob-store.js';
import type { EvaluationLogger } from './evaluate-run.handler.js';

export interface ScenarioTask {
  verification: VerificationEntry[];
  reference: JsonValue;
  /** Files of the task folder, e.g. `verify/check.py` of kind verifier. */
  files?: Array<{ path: string; kind: TaskFileKind; content: string }>;
}

export interface Scenario {
  experimentId: string;
  taskId: string;
  workerId: string;
  /** Baseline repetitions first, then the candidate's. */
  runIds: string[];
}

export const logger = (): EvaluationLogger =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as EvaluationLogger;

/** A reconcile stand-in that records the experiments it was called for. */
export function recordingReconcile() {
  const calls: string[] = [];
  return {
    calls,
    reconcile: async (_tx: unknown, experimentId: string): Promise<ReconcileResult> => {
      calls.push(experimentId);
      return 'unchanged';
    },
  };
}

/** Writes `content` to the blob store and registers its row, as the loader and collection do. */
export async function storeBlob(db: AppDb, store: BlobStore, content: string): Promise<BlobRef> {
  const ref = await store.putBuffer(Buffer.from(content));
  await store.recordBlob(db, ref);
  return ref;
}

const SELF_CHECK: SelfCheck = { status: 'passed', ran_at: null, duration_ms: null, results: [] };

/** One valid task under a frozen baseline and candidate, `repetitions` runs each, all queued. */
export async function seedScenario(
  db: AppDb,
  store: BlobStore,
  task: ScenarioTask,
  repetitions = 1,
): Promise<Scenario> {
  const label = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [suite] = await db
    .insert(suites)
    .values({
      sourcePath: `eval-${label}`,
      versionNumber: 1,
      name: `eval-${label}`,
      versionLabel: '1',
      contentHash: sha(`suite ${label}`),
      checkHash: sha(`checks ${label}`),
      taskCount: 1,
      validCount: 1,
    })
    .returning();
  const [taskRow] = await db
    .insert(tasks)
    .values({
      suiteId: suite!.id,
      key: 'invoice_total',
      versionNumber: 1,
      introducedInSuiteId: suite!.id,
      position: 0,
      summary: 'Total the invoices',
      prompt: 'Reply with a fenced JSON block.',
      limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file'] },
      reference: task.reference,
      verification: task.verification,
      selfCheck: SELF_CHECK,
      valid: true,
      contentHash: sha(`task ${label}`),
    })
    .returning();
  for (const file of task.files ?? []) {
    const ref = await storeBlob(db, store, file.content);
    await db.insert(taskFiles).values({
      taskId: taskRow!.id,
      path: file.path,
      kind: file.kind,
      sha256: ref.sha256,
      size: ref.size,
    });
  }

  const versionIds: string[] = [];
  for (const name of ['baseline', 'candidate']) {
    const version = await db.transaction(async (tx) => {
      const [configuration] = await tx
        .insert(configurations)
        .values({ name: `${name}-${label}` })
        .returning();
      const [created] = await tx
        .insert(configurationVersions)
        .values({
          configurationId: configuration!.id,
          version: 1,
          model: 'mock/scripted',
          provider: 'custom',
          baseUrl: 'http://mock-model:8090/v1',
          toolsets: ['file'],
          maxTurns: 20,
          timeBudgetS: 300,
          configHash: sha(`config ${name} ${label}`),
          frozenAt: new Date(),
        })
        .returning();
      return created!;
    });
    versionIds.push(version.id);
  }
  const [baselineVersionId, candidateVersionId] = versionIds as [string, string];

  const [worker] = await db
    .insert(workers)
    .values({
      hostname: `worker-${label}`,
      concurrency: 2,
      slots: 2,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      toolsets: ['file'],
      envNames: ['PATH'],
    })
    .returning();
  const [experiment] = await db
    .insert(experiments)
    .values({
      name: `Evaluation ${label}`,
      suiteId: suite!.id,
      taskIds: [taskRow!.id],
      baselineVersionId,
      candidateVersionIds: [candidateVersionId],
      repetitions,
      concurrency: 2,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      priceTable: { sha256: sha('prices'), loaded_at: '2026-10-24T09:00:00.000Z', models: {} },
    })
    .returning();
  const runRows = await db
    .insert(runs)
    .values(
      versionIds.flatMap((configurationVersionId) =>
        Array.from({ length: repetitions }, (_, i) => ({
          experimentId: experiment!.id,
          taskId: taskRow!.id,
          configurationVersionId,
          repetition: i + 1,
        })),
      ),
    )
    .returning({ id: runs.id });
  return {
    experimentId: experiment!.id,
    taskId: taskRow!.id,
    workerId: worker!.id,
    runIds: runRows.map((r) => r.id),
  };
}

export interface AttemptEvidence {
  finalText: string | null;
  /** Files with content, as collection stores them: in the workspace unless `root` says home. */
  files?: Array<{ path: string; content: string; origin?: ArtifactOrigin; root?: ArtifactRoot }>;
  /**
   * Files recorded without content: in the workspace unless `root` says home,
   * skipped as too large unless `reason` says the collection budget ran out.
   */
  skipped?: Array<{
    path: string;
    size: number;
    root?: ArtifactRoot;
    reason?: ArtifactSkipReason;
  }>;
  /** Stored events, numbered 1, 2, 3... in this order. */
  events?: RunEventPayload[];
}

/**
 * Runs a queued run's attempt to `executed` with the given evidence and
 * inserts its first evaluation, queued. The finish transaction of the
 * execution pipeline does the same (plan 8.4).
 */
export async function executeRun(
  db: AppDb,
  store: BlobStore,
  scenario: Scenario,
  runId: string,
  evidence: AttemptEvidence,
): Promise<{ attemptId: string; evaluationId: string }> {
  const attemptId = await startAttempt(db, runId, scenario.workerId);
  for (const file of evidence.files ?? []) {
    const ref = await storeBlob(db, store, file.content);
    await db.insert(artifacts).values({
      attemptId,
      root: file.root ?? 'workspace',
      path: file.path,
      origin: file.origin ?? 'agent',
      size: ref.size,
      sha256: ref.sha256,
    });
  }
  const events = evidence.events ?? [];
  if (events.length > 0) {
    await db.insert(runEvents).values(
      events.map((payload, i) => ({
        attemptId,
        seq: i + 1,
        ts: 1_792_800_000_000 + i,
        type: payload.type,
        payload,
      })),
    );
  }
  for (const file of evidence.skipped ?? []) {
    await db.insert(artifacts).values({
      attemptId,
      root: file.root ?? 'workspace',
      path: file.path,
      origin: 'agent',
      size: file.size,
      sha256: null,
      skippedReason: file.reason ?? 'too_large',
    });
  }
  return db.transaction(async (tx) => {
    await tx
      .update(attempts)
      .set({
        status: 'executed',
        finishedAt: new Date(),
        exitCode: 0,
        finalText: evidence.finalText ?? '',
        durationMs: 1000,
      })
      .where(eq(attempts.id, attemptId));
    await tx.update(runs).set({ status: 'executed' }).where(eq(runs.id, runId));
    const [evaluation] = await tx
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'initial', generation: 1 })
      .returning({ id: evaluations.id });
    return { attemptId, evaluationId: evaluation!.id };
  });
}

/** The blob name of `content`. */
export const sha256Of = (content: string): string => sha(content);

/** The answer as a final response carries it. */
export const fenced = (value: unknown, before = 'Here is the answer.'): string =>
  `${before}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
