/**
 * pg-boss queues and the settings each one is created with.
 *
 * Jobs are wake-up tokens, not the source of truth. A job carries ids only,
 * never prompts, traces or secrets; the handler re-reads the rows and acts
 * only when they are in the state the job expects. Every retry the platform
 * performs is a new job for a new attempt, so pg-boss never re-runs Hermes.
 */
import type { Queue } from 'pg-boss';
import type { AttemptTrigger } from '@hermes-evals/shared';

export const QUEUES = {
  executeRun: 'execute-run',
  evaluateRun: 'evaluate-run',
  evaluateRunDead: 'evaluate-run-dead',
  testMcpServer: 'test-mcp-server',
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

/** Start one MCP server definition in a throwaway Hermes home and list its tools. */
export interface TestMcpServerJob {
  mcpServerVersionId: string;
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
    // Key: mcpServerVersionId, so one test per definition at a time.
    name: QUEUES.testMcpServer,
    options: { policy: 'exclusive', retryLimit: 0, expireInSeconds: 300, deleteAfterSeconds: DAY },
  },
];

/** Singleton key of an execute-run job: one live token per run attempt. */
export const executeRunKey = (runId: string, attempt: number): string => `${runId}:${attempt}`;
