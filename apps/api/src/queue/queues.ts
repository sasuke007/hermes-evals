/**
 * pg-boss queues and the settings each one is created with.
 *
 * Jobs are wake-up tokens, not the source of truth. A job carries ids only,
 * never prompts, traces or secrets; the handler re-reads the rows and acts
 * only when they are in the state the job expects. Every retry the platform
 * performs is a new job for a new attempt, so pg-boss never re-runs Hermes.
 */
import { createHash } from 'node:crypto';
import type { Queue } from 'pg-boss';
import type { AttemptTrigger, McpServerInput } from '@hermes-evals/shared';

export const QUEUES = {
  executeRun: 'execute-run',
  evaluateRun: 'evaluate-run',
  evaluateRunDead: 'evaluate-run-dead',
  testMcpServer: 'test-mcp-server',
  loadSuites: 'load-suites',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Launch one attempt of one run. */
export interface ExecuteRunJob {
  runId: string;
  /** The attempt number this job creates: the run's attempt_count + 1 when sent. */
  attempt: number;
  trigger: AttemptTrigger;
}

/** Run every scorer of a task over one evaluation's attempt. */
export interface EvaluateRunJob {
  evaluationId: string;
}

/**
 * Start one MCP server definition in a throwaway trial container and list its
 * tools. `saved` tests a stored version and records the result on its
 * last_test; it carries the definition hash the request saw, because an
 * unfrozen version can be rewritten in place and the job must test what was
 * asked for (the handler refuses a version whose hash has moved on).
 * `unsaved` tests what the form holds before it is saved, and only returns the
 * result as the job output. A definition holds variable names, never values,
 * so it may travel in a job.
 */
export type TestMcpServerJob =
  | { kind: 'saved'; mcpServerVersionId: string; definitionHash: string }
  | { kind: 'unsaved'; definition: McpServerInput };

/**
 * Load suites from SUITES_DIR in the worker, which runs verifier self-checks
 * (user code) outside any trial. `path` is one directory relative to
 * SUITES_DIR, or null for every directory. The output is the SuiteReloadResult
 * the API returns from POST /suites/reload.
 */
export interface LoadSuitesJob {
  path: string | null;
}

/** Longest run budget a task or configuration may set, in seconds. */
export const MAX_RUN_BUDGET_SECONDS = 3600;

/**
 * How long an execute-run job may stay active before pg-boss gives up on it.
 * It must outlast the slowest legitimate attempt, or pg-boss would fail the
 * job while Hermes is still running: the budget, 60 s grace, 10 s before
 * SIGKILL, then trial build and artifact collection.
 */
export const EXECUTE_RUN_EXPIRE_SECONDS = MAX_RUN_BUDGET_SECONDS + 60 + 10 + 530;

const DAY = 86_400;

export interface QueueDefinition {
  name: QueueName;
  options: Omit<Queue, 'name'>;
}

/**
 * Created in this order at startup, so a dead-letter queue exists before the
 * queue that points at it.
 *
 * `exclusive` allows one job per singleton key in created, retry or active
 * state, so sending the same token twice is a no-op (send returns null).
 * The flip side: a handler cannot re-send its own key while its job is
 * active. To put a job back for later, use deferJob, which completes the
 * active job and sends the delayed copy in one transaction.
 * Policy and partitioning cannot change after a queue exists; every other
 * option is re-applied on each start.
 */
export const QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: QUEUES.evaluateRunDead,
    // Its handler records error scores so the run can finish; it must not give
    // up on the first transient failure.
    options: {
      policy: 'standard',
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 300,
      expireInSeconds: 300,
      deleteAfterSeconds: 30 * DAY,
    },
  },
  {
    // Key: `${runId}:${attempt}`. retryLimit 0: a failed or expired job is
    // never re-delivered; the platform decides whether to create attempt n+1.
    // Heartbeats let pg-boss notice a dead worker's job in about a minute.
    // Jobs pg-boss gives up on (heartbeat loss, expiry, shutdown) are
    // re-created by the worker's periodic reconciler, which re-sends every
    // queued run of a running experiment; the exclusive key makes that a
    // no-op for runs whose job is still live.
    name: QUEUES.executeRun,
    options: {
      policy: 'exclusive',
      retryLimit: 0,
      expireInSeconds: EXECUTE_RUN_EXPIRE_SECONDS,
      heartbeatSeconds: 30,
      deleteAfterSeconds: 7 * DAY,
    },
  },
  {
    // Key: evaluationId. Scoring reads stored evidence only, so retrying it is
    // safe as long as the handler writes the whole score set and completes the
    // evaluation in one transaction. After the last retry the job moves to the
    // dead-letter queue, whose handler records error scores so the run finishes.
    name: QUEUES.evaluateRun,
    options: {
      policy: 'exclusive',
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 300,
      expireInSeconds: 1800,
      heartbeatSeconds: 30,
      deadLetter: QUEUES.evaluateRunDead,
      deleteAfterSeconds: 7 * DAY,
    },
  },
  {
    // Key: testMcpServerKey, so one test per definition (version and content)
    // at a time; a second request for the same definition waits on the live
    // one (sendAndWait). Heartbeats let pg-boss fail a dead worker's job in
    // about a minute instead of at the 300 s expiry; the worker's start-up
    // reconciler then clears the `running` record it left (stale-mcp-tests.ts).
    name: QUEUES.testMcpServer,
    options: {
      policy: 'exclusive',
      retryLimit: 0,
      expireInSeconds: 300,
      heartbeatSeconds: 30,
      deleteAfterSeconds: DAY,
    },
  },
  {
    // Key: loadSuitesKey. A reload joins a live job only while it is still
    // created (it has read nothing yet); one that is already active is waited
    // out and a new pass sent, so the result covers files as they are now
    // (sendAndWait, joinActive false). retryLimit 0: the user retries a failed
    // reload. 900 s covers a full pass whose verifiers each take up to 30 s;
    // heartbeats free the key soon after a worker dies mid-load.
    name: QUEUES.loadSuites,
    options: {
      policy: 'exclusive',
      retryLimit: 0,
      expireInSeconds: 900,
      heartbeatSeconds: 30,
      deleteAfterSeconds: DAY,
    },
  },
];

/** Singleton key of an execute-run job: one live token per run attempt. */
export const executeRunKey = (runId: string, attempt: number): string => `${runId}:${attempt}`;

/** Singleton key of a load-suites job: the directory, or `*` for all of them. */
export const loadSuitesKey = (job: LoadSuitesJob): string => job.path ?? '*';

/**
 * Singleton key of a test-mcp-server job: `<version id>:<definition hash>`
 * for a saved version, so a click after an in-place edit gets its own job
 * while a second click on the same definition joins the live one; for an
 * unsaved definition `unsaved:` and the sha256 of its canonical JSON, so the
 * same form contents share one test however their keys are ordered.
 */
export const testMcpServerKey = (job: TestMcpServerJob): string =>
  job.kind === 'saved'
    ? `${job.mcpServerVersionId}:${job.definitionHash}`
    : `unsaved:${createHash('sha256').update(canonicalJson(job.definition)).digest('hex')}`;

/** JSON with object keys sorted at every level; array order is kept. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );
}
