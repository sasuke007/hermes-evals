/**
 * The seam between the attempt lifecycle and the attempt runner (plan 8).
 *
 * The lifecycle owns the database: it claims a run (plan 8.1), resolves
 * everything the trial needs into an AttemptPlan, and implements the
 * AttemptSink the runner writes through. The runner owns the sandbox: it
 * materialises the trial (plan 5.4), registers the attempt with egress,
 * starts the container through docker-guard, streams its output into the
 * sink, classifies the exit (plan 8.4), collects the workspace (plan 8.5) and
 * returns an AttemptOutcome. The lifecycle then finishes the attempt in one
 * transaction.
 *
 * The split keeps each side testable without the other: the full e2e drives
 * the real lifecycle with a fake runner or a fake engine, and the runner's
 * tests use an in-memory sink.
 *
 * Database rules the lifecycle works with (0001 and 0004 triggers):
 * - Every write to a running attempt is fenced: `WHERE id = $a AND
 *   lease_token = $t AND status = 'running' AND lease_revoked_at IS NULL`.
 *   Zero rows means the lease is lost: throw LeaseLostError.
 * - The heartbeat's lease renewal must also filter `lease_revoked_at IS
 *   NULL`. attempts_guard refuses any change to a revoked attempt other than
 *   ending it, so one revoked row in the renewal fails the whole statement.
 * - The run_events and artifacts insert triggers take FOR SHARE on the
 *   attempt row. In the finish transaction, lock the experiment, then the
 *   run, then the attempt, BEFORE inserting the final events and artifacts:
 *   inserting first takes the attempt lock ahead of the experiment and can
 *   deadlock with recovery, which locks in the documented order.
 * - Events and artifacts are refused once the attempt has finished, and on a
 *   revoked attempt (except recovery's own `worker_lost` and `cancelled`
 *   platform events, migration 0004).
 */
import type {
  ArtifactOrigin,
  ArtifactRoot,
  ArtifactSkipReason,
  ExecutionErrorCategory,
  LaunchRecord,
  McpServerInput,
  McpTransport,
  Provider,
  RunEventPayload,
  RunEventType,
  SkillLoadingMode,
  Tokens,
} from '@hermes-evals/shared';
import type { EgressUsage } from '../sandbox/egress-client.js';

/** A file the runner copies into the workspace before the trial starts. */
export interface PlannedFixture {
  /**
   * Path relative to the workspace, e.g. `invoices.csv`: the task file's path
   * with its leading `fixtures/` removed. Relative, no `..` segment.
   */
  path: string;
  /** Blob to copy from DATA_DIR/blobs; the runner re-checks the hash after copying. */
  sha256: string;
  size: number;
}

/**
 * A memory file the task seeds the trial home with (Phase 6 P1): a task file
 * of kind `home_seed`, copied before launch, hash re-checked, only when the
 * configuration's memory is on (Phase 8 G9, materialise.ts). Planned in
 * every arm, so the launch record can list the seeds memory off left out.
 */
export interface PlannedHomeSeed {
  /**
   * Path relative to the home, e.g. `memories/MEMORY.md`: the task file's
   * path with its leading `home/` removed (homeSeedTarget in
   * @hermes-evals/shared). One of the two HOME_SEED_PATHS targets.
   */
  path: string;
  /** Blob to copy from DATA_DIR/blobs; the runner re-checks the hash after copying. */
  sha256: string;
  size: number;
}

/** A skill the configuration version uses, copied to home/skills/<name>/ from DATA_DIR/skills/<contentHash>/. */
export interface PlannedSkill {
  id: string;
  name: string;
  version: string;
  contentHash: string;
}

/** A document the configuration version attaches, copied to workspace/docs/<filename> from its blob. */
export interface PlannedDocument {
  id: string;
  filename: string;
  sha256: string;
}

/** An MCP server version the configuration version uses (plan 5.3). */
export interface PlannedMcpServer {
  /** mcp_server_versions.id. */
  versionId: string;
  /** The `-t` alias and the config.yaml key; also the `/mcp/<name>` gateway route for http. */
  name: string;
  version: number;
  transport: McpTransport;
  /**
   * The definition as stored: names only, never a value. hermesMcpEntry
   * (resources/mcp/hermes-config.ts) turns it into the config.yaml entry. The
   * runner calls refusedEnvNames before any env value of it enters a trial.
   */
  definition: McpServerInput;
  definitionHash: string;
}

/**
 * Everything the runner needs for one attempt, resolved from the database by
 * the lifecycle in (or right after) the claim transaction. The runner reads
 * nothing else from the database.
 */
export interface AttemptPlan {
  experimentId: string;
  runId: string;
  attemptId: string;
  /** 1-based; equal to the execute-run job's `attempt` and attempts.number. */
  attemptNumber: number;
  /**
   * The attempt token (newAttemptToken(), sandbox/egress-client.ts). The
   * trial authenticates to egress with it: proxy credentials, the model
   * gateway's API key, and the MCP gateway's bearer (providers-map.ts). It
   * never appears in any file in the home, the launch record or a log; the
   * launch record shows it as a placeholder. It dies when the runner removes
   * the attempt from egress.
   */
  token: string;
  /** The slot network this trial has to itself (one of the worker's TRIAL_SLOTS). */
  slot: string;
  /**
   * Worker-side absolute paths under TRIALS_DIR. `root` is
   * TRIALS_DIR/<attemptId>; `home` and `workspace` are its two subdirectories,
   * mounted at /opt/data and /workspace. launch.json and stderr.log stay in
   * `root`, outside the trial's view.
   */
  paths: { root: string; home: string; workspace: string };
  task: {
    id: string;
    key: string;
    /** Written to home/task.txt verbatim. */
    prompt: string;
    fixtures: PlannedFixture[];
    /**
     * Copied into home/memories/ before launch when memory is on, sorted by
     * path; empty when the task has none.
     */
    homeSeeds: PlannedHomeSeed[];
  };
  limits: {
    /** The configuration version's max_turns. */
    maxTurns: number;
    /**
     * The run's time budget in seconds (execution/budget.ts): the
     * configuration version's time_budget_s, replaced by the experiment's
     * time_budget_override_s when set. Goes to config.yaml as
     * agent.run_budget_seconds; the runner adds the grace and the stop
     * timeout to get the deadline.
     */
    runBudgetS: number;
  };
  configuration: {
    /** configuration_versions.id. */
    versionId: string;
    /** The configuration's name, for logs and the launch record. */
    name: string;
    version: number;
    model: string;
    provider: Provider;
    /** Set for `custom` (the CHECK requires it): egress forwards there for this attempt. */
    baseUrl: string | null;
    /** Sorted Hermes toolsets; the runner appends one `-t` entry per MCP server name. */
    toolsets: string[];
    memoryEnabled: boolean;
    skills: PlannedSkill[];
    /**
     * Phase 6 P5: `preload` passes `-s <name>` per skill; `on_demand` passes
     * no `-s` and appends `skills` to the `-t` list once. Both copy the
     * skills into home/skills/. Always `preload` when `skills` is empty.
     */
    skillLoading: SkillLoadingMode;
    documents: PlannedDocument[];
    mcpServers: PlannedMcpServer[];
  };
  /**
   * The experiment's frozen Hermes version, and the revision this worker's
   * trial image runs, which the plan checked equals the frozen one.
   */
  hermes: { version: string; revision: string };
}

/** One event as the runner hands it to the sink. The sink assigns the seq. */
export interface AttemptEventInput {
  /** Epoch milliseconds: the event's own `timestamp`, or receipt time for platform events. */
  ts: number;
  type: RunEventType;
  /** Parsed with RunEventPayloadSchema; `payload.type` equals `type` (run_events CHECK). */
  payload: RunEventPayload;
}

/**
 * The runner's only way to write. Implemented by the lifecycle. Every method
 * is fenced on the attempt's lease and throws LeaseLostError when the lease
 * is gone (revoked by recovery, or the attempt already finished); the runner
 * then stops the container and rethrows it.
 */
export interface AttemptSink {
  /** Writes attempts.launch_record, once, before the container is created. */
  recordLaunch(record: LaunchRecord): Promise<void>;
  /**
   * Writes attempts.sandbox_id (the container id) and sandbox_host_id (the
   * Docker daemon id), once, right after create and before start, so recovery
   * can find and stop the container if this worker dies.
   */
  recordContainer(containerId: string, hostId: string): Promise<void>;
  /**
   * Appends events with gap-free seq numbers (1, 2, 3, ... per attempt) in
   * one statement. The runner batches: 50 events or every 500 ms (plan 8.3).
   * An empty list is a no-op that still checks the lease.
   */
  appendEvents(events: readonly AttemptEventInput[]): Promise<void>;
  /**
   * Whether Cancel has set runs.cancel_requested_at for this run. The runner
   * polls it about once a second; on true it stops the container and returns
   * status `cancelled`.
   */
  cancelRequested(): Promise<boolean>;
}

/**
 * A file found after the container was removed (plan 8.5): in the workspace,
 * or in the home's `memories/`, collected before the home is deleted
 * (Phase 6 P2).
 */
export interface AttemptArtifact {
  /** The directory it was collected from; artifacts.root. */
  root: ArtifactRoot;
  /**
   * Relative to its root: `summary.csv` or `docs/policy.pdf` in the
   * workspace, `memories/MEMORY.md` in the home.
   */
  path: string;
  origin: ArtifactOrigin;
  size: number;
  /**
   * Blob the runner already wrote to DATA_DIR/blobs; the lifecycle inserts
   * the blobs row (ON CONFLICT DO NOTHING) with the artifact. Null when skipped.
   */
  sha256: string | null;
  /** Set exactly when sha256 is null (artifacts_content_ck). */
  skippedReason: ArtifactSkipReason | null;
}

/**
 * How the attempt ended, as the runner classified it (plan 8.4). The
 * lifecycle writes it in the finish transaction: the final events and
 * artifacts first, then the attempt, then (when executed) the run, the
 * generation-1 evaluation and its evaluate-run job, then reconcile.
 */
export interface AttemptOutcome {
  status: 'executed' | 'execution_error' | 'cancelled';
  /** Set exactly when status is execution_error. */
  category: ExecutionErrorCategory | null;
  /** Readable reason for an execution error; never holds a secret value. */
  errorMessage: string | null;
  /** The container's exit code; null when it never started. */
  exitCode: number | null;
  /** The `result` event's text: the answer. Required when status is executed. */
  finalText: string | null;
  /** From the `result` event (plan 8.3: system/init carries an empty one). */
  sessionId: string | null;
  /**
   * resultTokens(result event) (stream-json.ts); null when Hermes sent no
   * result. The finish bills billableTokens(tokens, egressUsage) instead
   * (pricing.ts), which falls back on egress's own count.
   */
  tokens: Tokens | null;
  durationMs: number | null;
  /** Last 40 lines of stderr with every MCP value the worker passed replaced by `<from env NAME>`. */
  stderrTail: string | null;
  /** How many secret values were replaced in events, final text and stderr. */
  redactions: number;
  /**
   * Platform events written in the finish transaction, after everything the
   * runner already appended: `network` entries from egress's connection log,
   * `killed`, `cancelled`, `collected`, and the synthesised `result` on a
   * timeout. The sink numbers them after the streamed events.
   */
  finalEvents: AttemptEventInput[];
  artifacts: AttemptArtifact[];
  /** What egress counted for the attempt when it was removed; null if egress had lost it. */
  egressUsage: EgressUsage | null;
}

/**
 * Runs one attempt end to end. It never throws for anything the agent or
 * the trial did: those are outcomes. It throws only:
 * - LeaseLostError, from the sink or because the lifecycle aborted the
 *   signal with one (the heartbeat found the lease gone);
 * - WorkerShutdownError, when the lifecycle aborted the signal with one
 *   because the worker is stopping.
 * In both cases it has stopped and removed the container and removed the
 * attempt from egress before it throws. It leaves the trial directories for
 * the caller: recovery's finalise deletes the home once it has confirmed the
 * container gone, and retention deletes the rest.
 */
export interface AttemptRunner {
  run(plan: AttemptPlan, sink: AttemptSink, signal: AbortSignal): Promise<AttemptOutcome>;
}

/** The attempt's lease is gone: another worker or recovery owns what happens next. */
export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';

  constructor(
    readonly attemptId: string,
    message = `attempt ${attemptId} lost its lease`,
  ) {
    super(message);
  }
}

/**
 * The abort reason the lifecycle passes when the worker shuts down
 * (`controller.abort(new WorkerShutdownError())`). The runner stops the
 * container and rethrows it; recovery later ends the attempt as
 * `worker_lost` and requeues the run.
 */
export class WorkerShutdownError extends Error {
  override readonly name = 'WorkerShutdownError';
  readonly reason = 'shutdown' as const;

  constructor(message = 'the worker is shutting down') {
    super(message);
  }
}
