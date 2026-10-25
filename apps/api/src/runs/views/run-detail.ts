/**
 * GET /runs/:id, the run inspector (UI_FLOWS 18): the header and attempts,
 * Outcome, Timeline, Final response, Artifacts and Launch record of one run,
 * all from its current attempt (runs.current_attempt_id) and that attempt's
 * current evaluation. A run waiting for a retry still points at its previous
 * attempt, so the inspector shows that attempt's evidence until the next
 * one starts.
 */
import type {
  AttemptView,
  CounterpartView,
  ExtractedAnswer,
  Provider,
  RunDetail,
  TablePreview,
} from '@hermes-evals/shared';
import { LaunchRecordSchema } from '@hermes-evals/shared';
import { effectiveBudgetS } from '../../execution/budget.js';
import { suiteRef } from '../../suites/views/suite-views.js';
import { answerPathOf } from '../../suites/views/yaml-slice.js';
import { artifactsView } from './artifacts.js';
import { experimentConfigRef, primaryKeyOf, runNeeds } from './config-ref.js';
import { finalResponseView } from './final-response.js';
import { launchRecordView } from './launch-record.js';
import { executionErrorView, outcomeNotice, scoreRows } from './outcome.js';
import { isMeasured, seconds, tokenCounts } from './run-list.js';
import type {
  ArtifactRecord,
  AttemptRecord,
  ConfigVersionRecord,
  EvaluationRecord,
  EventRecord,
  ExperimentRecord,
  RunRecord,
  ScoreRecord,
  SuiteRecord,
  TaskRecord,
  WorkerRecord,
} from './rows.js';
import { buildTimeline, turnsSoFar, type TimelineContext, type TimelineRow } from './timeline.js';
import { int, type Payload } from './timeline-rows.js';

/** Where the model gateway forwards each provider's calls, as the timeline names it. */
const UPSTREAM_NAMES: Record<Exclude<Provider, 'custom'>, string> = {
  nous: 'Nous Portal',
  'nous-api': 'Nous API',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

export function upstreamName(config: Pick<ConfigVersionRecord, 'provider' | 'baseUrl'>): string {
  if (config.provider !== 'custom') return UPSTREAM_NAMES[config.provider];
  try {
    return config.baseUrl ? new URL(config.baseUrl).host : 'the custom endpoint';
  } catch {
    return 'the custom endpoint';
  }
}

/** How the shown attempt's events are drawn: its start, its MCP servers and where its model calls went. */
export function timelineContext(
  attempt: Pick<AttemptRecord, 'startedAt' | 'launchRecord'>,
  config: Pick<ConfigVersionRecord, 'provider' | 'baseUrl'>,
): TimelineContext {
  const launched = LaunchRecordSchema.safeParse(attempt.launchRecord);
  return {
    startedAtMs: attempt.startedAt.getTime(),
    mcpServers: launched.success ? launched.data.mcp_servers.map((m) => m.name) : [],
    forwardedTo: upstreamName(config),
  };
}

/** The run, its experiment and everything the inspector draws, as read from the database. */
export interface RunDetailInput {
  run: RunRecord;
  experiment: ExperimentRecord;
  suite: SuiteRecord;
  task: TaskRecord;
  /** Every configuration version of the experiment (the run's own and its counterpart's). */
  configs: readonly ConfigVersionRecord[];
  /** Every attempt of the run. */
  attempts: readonly AttemptRecord[];
  /** The worker that ran the shown attempt. */
  worker: WorkerRecord | null;
  /** The current evaluation (completed, not superseded) and its scores. */
  evaluation: { record: EvaluationRecord; scores: readonly ScoreRecord[] } | null;
  /** The extraction to show: the current evaluation's, else the newest one stored for the attempt. */
  answer: ExtractedAnswer | null;
  /** The shown attempt's events, by seq. */
  events: readonly EventRecord[];
  artifacts: readonly ArtifactRecord[];
  /** Inline previews by artifact id (small CSV and TSV files). */
  previews: ReadonlyMap<string, TablePreview | null>;
  /** The same task and repetition under the other configuration; run null when there is none. */
  counterpart: { versionId: string; run: Pick<RunRecord, 'id' | 'status'> | null } | null;
  now: Date;
  /** The image to name when the worker reported none. */
  fallbackImage: string;
}

/** The configuration version the A/B jump goes to: baseline to the first candidate, a candidate to the baseline. */
export function counterpartVersionId(
  experiment: Pick<ExperimentRecord, 'baselineVersionId' | 'candidateVersionIds'>,
  versionId: string,
): string | null {
  return versionId === experiment.baselineVersionId
    ? (experiment.candidateVersionIds[0] ?? null)
    : experiment.baselineVersionId;
}

function counterpartView(
  counterpart: NonNullable<RunDetailInput['counterpart']>,
  configs: readonly ConfigVersionRecord[],
): CounterpartView {
  const name =
    configs.find((c) => c.versionId === counterpart.versionId)?.name ?? 'the other configuration';
  const twin = counterpart.run;
  if (!twin) {
    return {
      runId: null,
      configuration: name,
      status: null,
      unavailableReason: `${name} has no run of this task and repetition`,
    };
  }
  const finished = twin.status === 'scored' || twin.status === 'execution_error';
  return {
    runId: twin.id,
    configuration: name,
    status: twin.status,
    unavailableReason: finished
      ? null
      : twin.status === 'cancelled'
        ? 'Counterpart run was cancelled'
        : `Counterpart run is not scored yet (${twin.status})`,
  };
}

/** The run's time budget and turn cap: as launched, else the configuration's after the override. */
function limitsOf(
  config: ConfigVersionRecord,
  experiment: ExperimentRecord,
  launched: { max_turns: number; run_budget_seconds: number } | null,
): RunDetail['limits'] {
  if (launched && launched.max_turns > 0 && launched.run_budget_seconds > 0) {
    return { maxTurns: launched.max_turns, budgetS: launched.run_budget_seconds };
  }
  return {
    maxTurns: config.maxTurns,
    budgetS: effectiveBudgetS(config.timeBudgetS, experiment.timeBudgetOverrideS),
  };
}

/** The longest stderr.log the worker reported in a platform event (`stderr_lines`), if any. */
function stderrTotalLines(events: readonly EventRecord[]): number | null {
  let total: number | null = null;
  for (const e of events) {
    if (e.type !== 'platform') continue;
    const lines = int(e.payload as Payload, 'stderr_lines');
    if (lines !== undefined && lines >= 0) total = Math.max(total ?? 0, lines);
  }
  return total;
}

function attemptView(a: AttemptRecord, scoredAttemptId: string | null): AttemptView {
  return {
    number: a.number,
    trigger: a.trigger,
    status: a.id === scoredAttemptId ? 'scored' : a.status,
    category: a.errorCategory,
    startedAt: a.startedAt.toISOString(),
    durationS: a.status === 'running' ? null : seconds(a.durationMs),
    exitCode: a.exitCode,
    // Nothing records an attempt as not counting against the run: every attempt counts.
    countsAgainstRun: true,
  };
}

function cancelledView(input: RunDetailInput, shown: AttemptRecord | null): RunDetail['cancelled'] {
  const { run, experiment } = input;
  if (run.status !== 'cancelled' || !run.finishedAt) return null;
  const requested = run.cancelRequestedAt ?? run.finishedAt;
  const byExperiment =
    experiment.cancelledAt !== null && requested.getTime() >= experiment.cancelledAt.getTime();
  return {
    at: run.finishedAt.toISOString(),
    by: byExperiment ? 'experiment' : 'user',
    ranForS: seconds(shown?.durationMs ?? null) ?? 0,
  };
}

export function runDetailView(input: RunDetailInput): RunDetail {
  const { run, experiment, task } = input;
  const config = input.configs.find((c) => c.versionId === run.configurationVersionId);
  if (!config) throw new Error(`run ${run.id} uses a configuration outside its experiment`);
  const shown = input.attempts.find((a) => a.id === run.currentAttemptId) ?? null;
  const launched = shown ? LaunchRecordSchema.safeParse(shown.launchRecord) : null;
  const record = launched?.success ? launched.data : null;
  const limits = limitsOf(config, experiment, record?.limits ?? null);
  const measured = isMeasured(run.status, shown);

  const rows: TimelineRow[] = shown
    ? buildTimeline(input.events, timelineContext(shown, config))
    : [];
  const live = run.status === 'running' && shown?.status === 'running';

  const verification = task.verification;
  const scores = input.evaluation
    ? scoreRows(input.evaluation.scores, verification, answerPathOf(task.taskYaml))
    : [];

  return {
    id: run.id,
    experimentId: experiment.id,
    experimentName: experiment.name,
    suite: suiteRef(input.suite),
    task: { key: task.key, version: task.versionNumber, summary: task.summary ?? '' },
    configuration: experimentConfigRef(experiment, config),
    repetition: run.repetition,
    status: run.status,
    attemptCount: run.attemptCount,
    shownAttempt: shown?.number ?? 0,
    attempts: [...input.attempts]
      .sort((a, b) => a.number - b.number)
      .map((a) => attemptView(a, input.evaluation?.record.attemptId ?? null)),
    primary: {
      key: primaryKeyOf(verification),
      status: scores.find((s) => s.primary)?.status ?? null,
    },
    startedAt: shown && run.status !== 'queued' ? shown.startedAt.toISOString() : null,
    finishedAt:
      run.finishedAt?.toISOString() ??
      (measured ? (shown?.finishedAt?.toISOString() ?? null) : null),
    durationS: measured ? seconds(shown?.durationMs ?? null) : null,
    durationIsBudget: run.status === 'execution_error' && shown?.errorCategory === 'timeout',
    tokens: measured ? tokenCounts(shown?.tokens ?? null) : null,
    costUsd: measured ? (shown?.costUsd ?? null) : null,
    limits,
    live:
      live && shown
        ? {
            elapsedS: Math.max(0, (input.now.getTime() - shown.startedAt.getTime()) / 1000),
            turn: turnsSoFar(input.events),
          }
        : null,
    cancelled: cancelledView(input, shown),
    executionError:
      run.status === 'execution_error' && shown
        ? executionErrorView({
            attempt: shown,
            budgetS: limits.budgetS,
            worker: input.worker,
            stderrTotalLines: stderrTotalLines(input.events),
          })
        : null,
    outcomeNotice: outcomeNotice(scores),
    scores,
    timeline: { events: rows.map((r) => r.event), live, totalEvents: rows.length },
    finalResponse:
      shown?.finalText != null
        ? finalResponseView(shown.finalText, input.answer, task.reference)
        : null,
    artifacts: artifactsView(shown, input.artifacts, input.previews),
    launchRecord: shown
      ? launchRecordView({
          record: shown.launchRecord,
          attempt: shown,
          worker: input.worker,
          fallbackImage: input.fallbackImage,
        })
      : null,
    counterpart: input.counterpart ? counterpartView(input.counterpart, input.configs) : null,
    needs: runNeeds(config, verification),
  };
}
