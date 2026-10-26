/**
 * The run read API: the Runs tab, the run inspector, its live event pages,
 * and the artifacts' bytes and previews (plan 8.3, 8.5, 9.1 and 11,
 * UI_FLOWS 17 and 18). Read-only: nothing here writes a row or a file.
 *
 * Artifact contents come from the blob store by the hash the worker recorded
 * when it collected them, never from the trial's workspace, so what the
 * inspector shows is exactly what the scorers read.
 */
import type { ReadStream } from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AttemptStderr,
  RunDetail,
  RunEventsPage,
  RunFilters,
  RunListResult,
  TablePreview,
} from '@hermes-evals/shared';
import type { Env } from '../../config/env.js';
import { DB } from '../../database/db.provider.js';
import type { AppDb } from '../../database/types.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { StorageService } from '../../storage/storage.service.js';
import { notFound, serverError } from '../../suites/http-errors.js';
import { streamTablePreview, tablePreview, tabularFormatOf } from '../../suites/views/table.js';
import type { JudgeSettings } from '../../scoring/judge/contracts.js';
import { judgeSettingsFrom } from '../judge-needs.js';
import { hasInlinePreview } from './artifacts.js';
import { configOrder } from './config-ref.js';
import { currentEvaluationOf } from './evaluation-view.js';
import { counterpartVersionId, runDetailView, timelineContext } from './run-detail.js';
import { runList } from './run-list.js';
import {
  artifactOfRun,
  artifactsOf,
  attemptById,
  attemptsOf,
  configVersions,
  evaluationStatesOfExperiment,
  evaluationStatesOfRun,
  evaluationWithScores,
  eventsAfter,
  eventsOf,
  experimentById,
  latestAnswer,
  primaryScores,
  runById,
  runListRecords,
  suiteById,
  tasksByIds,
  toolEventsUpTo,
  twinRun,
  workerById,
} from './run-views.queries.js';
import type { ArtifactRecord, EventRecord } from './rows.js';
import { attemptIdOf, attemptStderrView, stderrLogRef } from './stderr-log.js';
import { buildTimeline, timelinePage } from './timeline.js';

/** Events one GET /runs/:id/events page is built from at most; the cursor continues from there. */
export const EVENTS_PAGE_LIMIT = 2_000;

/**
 * What rows built from `fresh` need from before them: the tool calls their
 * tool results answer (by call id, else by name), and every tool call when a
 * connection log entry arrived, since a refusal is drawn on whichever call
 * was running at its time.
 */
function contextNeeded(fresh: readonly EventRecord[]) {
  const callIds = new Set<string>();
  const names = new Set<string>();
  let all = false;
  for (const { type, payload } of fresh) {
    const p = payload as Record<string, unknown>;
    if (type === 'platform' && p['subtype'] === 'network') all = true;
    if (type !== 'tool_result') continue;
    if (typeof p['tool_call_id'] === 'string' && p['tool_call_id'] !== '') {
      callIds.add(p['tool_call_id']);
    } else {
      names.add(typeof p['name'] === 'string' ? p['name'] : 'tool');
    }
  }
  return { all, callIds: [...callIds], names: [...names] };
}

/** An artifact ready to stream: its row and the open blob. */
export interface ArtifactDownload {
  artifact: ArtifactRecord;
  stream: ReadStream;
}

@Injectable()
export class RunViewsService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    // Typed as the plain store so a test can hand in a BlobStore over a temp directory.
    @Inject(StorageService) private readonly storage: BlobStore,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  /** JUDGE_PROVIDER and JUDGE_MODEL as this process reads them: what Re-score needs (S3). */
  private get judge(): JudgeSettings {
    return judgeSettingsFrom(this.config);
  }

  /** GET /experiments/:id/runs */
  async list(experimentId: string, filters: RunFilters): Promise<RunListResult> {
    const experiment = await experimentById(this.db, experimentId);
    if (!experiment) throw notFound(`experiment ${experimentId}`);
    const [tasks, configs, runs, evaluations] = await Promise.all([
      tasksByIds(this.db, experiment.taskIds),
      configVersions(this.db, configOrder(experiment)),
      runListRecords(this.db, experiment.id),
      evaluationStatesOfExperiment(this.db, experiment.id),
    ]);
    // After the states, and for the evaluations they call current: one read decides both.
    const current = new Set<string>();
    for (const rows of evaluations.values()) {
      const id = currentEvaluationOf(rows)?.id;
      if (id) current.add(id);
    }
    const scores = await primaryScores(this.db, experiment.id, current);
    return runList(
      { experiment, tasks, configs, runs, primaryScores: scores, evaluations, judge: this.judge },
      filters,
    );
  }

  /** GET /runs/:id */
  async detail(runId: string): Promise<RunDetail> {
    const run = await runById(this.db, runId);
    if (!run) throw notFound(`run ${runId}`);
    const experiment = await experimentById(this.db, run.experimentId);
    if (!experiment) throw serverError(`run ${runId} names a missing experiment`);
    const twinVersion = counterpartVersionId(experiment, run.configurationVersionId);
    const [suite, [task], configs, attempts, evaluations, twin] = await Promise.all([
      suiteById(this.db, experiment.suiteId),
      tasksByIds(this.db, [run.taskId]),
      configVersions(this.db, configOrder(experiment)),
      attemptsOf(this.db, run.id),
      evaluationStatesOfRun(this.db, run.id),
      twinVersion ? twinRun(this.db, run, twinVersion) : Promise.resolve(null),
    ]);
    // The scores of the evaluation the states call current, so a re-score that
    // publishes meanwhile cannot pair one generation's scores with another's label.
    const currentId = currentEvaluationOf(evaluations)?.id;
    const evaluation = currentId ? await evaluationWithScores(this.db, currentId) : null;
    if (!suite || !task) throw serverError(`run ${runId} names a missing suite or task`);
    const shown = attempts.find((a) => a.id === run.currentAttemptId) ?? null;
    const [events, artifacts, worker, answer] = shown
      ? await Promise.all([
          eventsOf(this.db, shown.id),
          artifactsOf(this.db, shown.id),
          workerById(this.db, shown.workerId),
          evaluation?.record.answer ?? latestAnswer(this.db, shown.id),
        ])
      : [[], [], null, null];
    return runDetailView({
      run,
      experiment,
      suite,
      task,
      configs,
      attempts,
      worker,
      evaluation,
      evaluations,
      judge: this.judge,
      answer,
      events,
      artifacts,
      previews: await this.inlinePreviews(artifacts),
      counterpart: twinVersion ? { versionId: twinVersion, run: twin } : null,
      now: new Date(),
      fallbackImage: this.config.get('TRIAL_IMAGE', { infer: true }),
    });
  }

  /**
   * GET /runs/:id/events?after=: the shown attempt's timeline rows touched
   * after `after`. Polled every second while the inspector is open, so it
   * reads only the events after the cursor (at most `limit`, the cursor then
   * continuing from the last), plus the earlier tool events their rows join,
   * never the whole attempt: the rows are the ones a full rebuild would
   * send for that cursor.
   */
  async events(runId: string, after: number, limit = EVENTS_PAGE_LIMIT): Promise<RunEventsPage> {
    const run = await runById(this.db, runId);
    if (!run) throw notFound(`run ${runId}`);
    const shown = run.currentAttemptId ? await attemptById(this.db, run.currentAttemptId) : null;
    if (!shown) return { events: [], lastSeq: after, live: false };
    const [[config], fresh] = await Promise.all([
      configVersions(this.db, [run.configurationVersionId]),
      eventsAfter(this.db, shown.id, after, limit),
    ]);
    if (!config) throw serverError(`run ${runId} names a missing configuration version`);
    const context =
      fresh.length === 0
        ? []
        : await toolEventsUpTo(this.db, shown.id, after, contextNeeded(fresh));
    const rows = buildTimeline([...context, ...fresh], timelineContext(shown, config));
    return {
      ...timelinePage(rows, after, fresh.at(-1)?.seq ?? after),
      live: run.status === 'running' && shown.status === 'running',
    };
  }

  /** GET /runs/:id/artifacts/:artifactId/content: the stored bytes, opened for download. */
  async artifactContent(runId: string, artifactId: string): Promise<ArtifactDownload> {
    const artifact = await this.artifact(runId, artifactId);
    if (!artifact.sha256) {
      throw notFound(`content of artifact ${artifactId} (not stored: ${artifact.skippedReason})`);
    }
    await this.requireBlob(artifact.sha256, artifact.path);
    return { artifact, stream: this.storage.stream(artifact.sha256) };
  }

  /** GET /runs/:id/artifacts/:artifactId/preview: the first rows of a CSV or TSV, else null. */
  async artifactPreview(runId: string, artifactId: string): Promise<TablePreview | null> {
    const artifact = await this.artifact(runId, artifactId);
    const format = tabularFormatOf(artifact.path);
    if (!format || !artifact.sha256) return null;
    await this.requireBlob(artifact.sha256, artifact.path);
    return streamTablePreview(this.storage.stream(artifact.sha256), format);
  }

  /**
   * GET /runs/:id/attempts/:n/stderr: the attempt's stderr.log, as the worker
   * stored it redacted when the attempt ended (stderr-log.ts).
   */
  async stderr(runId: string, n: number): Promise<AttemptStderr> {
    const attemptId = await attemptIdOf(this.db, runId, n);
    if (!attemptId) {
      if (!(await runById(this.db, runId))) throw notFound(`run ${runId}`);
      throw notFound(`attempt ${n} of run ${runId}`);
    }
    const ref = await stderrLogRef(this.db, attemptId);
    if (!ref) throw notFound(`stderr.log of attempt ${n}`);
    let text: Buffer;
    try {
      text = await this.storage.read(ref.sha256);
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
      throw serverError(`stderr.log of attempt ${n} is missing from the blob store`);
    }
    return attemptStderrView({ runId, attempt: n, text: text.toString('utf8'), ref });
  }

  private async artifact(runId: string, artifactId: string): Promise<ArtifactRecord> {
    const artifact = await artifactOfRun(this.db, runId, artifactId);
    if (artifact) return artifact;
    if (!(await runById(this.db, runId))) throw notFound(`run ${runId}`);
    throw notFound(`artifact ${artifactId}`);
  }

  private async requireBlob(sha256: string, path: string): Promise<void> {
    if (!(await this.storage.exists(sha256))) {
      throw serverError(`artifact ${path} is missing from the blob store (sha256 ${sha256})`);
    }
  }

  /** Previews of the small CSV and TSV artifacts; a blob gone from disk just has none. */
  private async inlinePreviews(
    artifacts: readonly ArtifactRecord[],
  ): Promise<Map<string, TablePreview | null>> {
    const previews = new Map<string, TablePreview | null>();
    for (const artifact of artifacts) {
      const format = tabularFormatOf(artifact.path);
      if (!format || !artifact.sha256 || !hasInlinePreview(artifact)) continue;
      try {
        previews.set(artifact.id, tablePreview(await this.storage.read(artifact.sha256), format));
      } catch (err) {
        if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
        previews.set(artifact.id, null);
      }
    }
    return previews;
  }
}
