/**
 * Request and reply over pg-boss, for the few API calls that wait for the
 * worker to answer: POST /suites/reload (load-suites) and MCP "Test start"
 * (test-mcp-server).
 *
 * The reply is the job's output. pg-boss stores a work handler's return value
 * as the output of the job it completes (when the handler took one job, as
 * every handler here does): an object is stored as is, any other value as
 * `{ value }`, and undefined or null as null. A handler that throws fails the
 * job, and the output is then the serialised error ({ name, message, stack }).
 * Callers parse the output with the shared zod schema for that reply.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { QueueName } from './queues.js';

/** States a job can end in. */
export type SettledJobState = 'completed' | 'failed' | 'cancelled';

export interface JobOutcome {
  jobId: string;
  state: SettledJobState;
  /** The handler's return value (completed) or the failure (failed); null when there is none. */
  output: unknown;
}

export interface SendAndWaitOptions {
  /** The job's singleton key; the queues here are `exclusive`, one live job per key. */
  singletonKey: string;
  /** How long to wait for the job to settle, measured from the call. */
  timeoutMs: number;
  /** How often to look at the job. Default 250 ms. */
  pollMs?: number;
  /**
   * Whether a request may join a live job that is already active. Default
   * true: an MCP test of the same definition gives the same answer whenever
   * it started. False for loads: an active load may have read the files
   * before this request, so it is waited out and a new job sent; a job still
   * created has read nothing, so it is joined either way.
   */
  joinActive?: boolean;
}

/**
 * The job did not settle in time. It may still be live and finish later; a
 * repeated request with the same key waits on the same job. (It may also be
 * the job of a worker that died, which pg-boss fails once its heartbeat lapses.)
 */
export class JobWaitTimeout extends Error {
  constructor(
    readonly queue: QueueName,
    readonly jobId: string,
    readonly timeoutMs: number,
  ) {
    super(`${queue} job ${jobId} did not finish within ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'JobWaitTimeout';
  }
}

/** The job is no longer in the queue (pg-boss deleted it). */
export class JobGone extends Error {
  constructor(
    readonly queue: QueueName,
    readonly jobId: string,
  ) {
    super(`${queue} job ${jobId} no longer exists`);
    this.name = 'JobGone';
  }
}

const LIVE: ReadonlySet<string> = new Set(['created', 'retry', 'active']);
const SETTLED: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
const PAGE = 500;
/**
 * A live job can settle between a refused send and the lookup; then the send
 * is tried again, until the deadline but at least this many times.
 */
const MIN_SEND_TRIES = 3;

/**
 * Sends a job and waits until it settles. When a live job already holds the
 * singleton key (send returns null under the exclusive policy), waits on that
 * job instead, so two identical requests share one piece of work.
 * Throws JobWaitTimeout when `timeoutMs` passes first.
 *
 * Check that a worker is connected (findLiveWorker) before calling: with no
 * worker the job stays created until the timeout.
 */
export async function sendAndWait(
  boss: PgBoss,
  queue: QueueName,
  data: object,
  options: SendAndWaitOptions,
): Promise<JobOutcome> {
  const deadline = Date.now() + options.timeoutMs;
  const jobId = await sendOrJoin(boss, queue, data, options.singletonKey, {
    joinActive: options.joinActive,
    deadline,
    pollMs: options.pollMs,
    reportedTimeoutMs: options.timeoutMs,
  });
  return waitForJob(boss, queue, jobId, {
    timeoutMs: Math.max(0, deadline - Date.now()),
    pollMs: options.pollMs,
    reportedTimeoutMs: options.timeoutMs,
  });
}

export interface SendOrJoinOptions {
  /** See SendAndWaitOptions.joinActive. Default true. */
  joinActive?: boolean;
  /** Epoch ms after which waiting for an active job gives up (JobWaitTimeout). */
  deadline?: number;
  pollMs?: number;
  /** The timeout a JobWaitTimeout reports. */
  reportedTimeoutMs?: number;
}

/**
 * Sends the job, or returns the id of the live job that holds its key. With
 * joinActive false, a live job that is already active (or retrying) is
 * waited out first and the send tried again, so the id returned is of a job
 * that had not started when this was called. Concurrent callers converge on
 * one new job: the exclusive key lets one send through and the others join it
 * while it is still created.
 */
export async function sendOrJoin(
  boss: PgBoss,
  queue: QueueName,
  data: object,
  singletonKey: string,
  options: SendOrJoinOptions = {},
): Promise<string> {
  const joinActive = options.joinActive ?? true;
  const deadline = options.deadline ?? Date.now();
  for (let tries = 0; tries < MIN_SEND_TRIES || Date.now() < deadline; tries++) {
    const id = await boss.send(queue, data, { singletonKey });
    if (id) return id;
    const live = await findLiveJob(boss, queue, singletonKey);
    if (!live) continue;
    if (joinActive || live.state === 'created') return live.id;
    try {
      await waitForJob(boss, queue, live.id, {
        timeoutMs: Math.max(0, deadline - Date.now()),
        pollMs: options.pollMs,
        reportedTimeoutMs: options.reportedTimeoutMs,
      });
    } catch (err) {
      // Deleted meanwhile: the key is free, so send again.
      if (!(err instanceof JobGone)) throw err;
    }
  }
  throw new Error(`could not send a ${queue} job for ${singletonKey} or find the live one`);
}

/** The newest job of `queue` with `singletonKey` that is created, retrying or active, or null. */
export async function findLiveJob(
  boss: PgBoss,
  queue: QueueName,
  singletonKey: string,
): Promise<JobWithMetadata<unknown> | null> {
  let live: JobWithMetadata<unknown> | null = null;
  let after: string | undefined;
  // findJobs lists oldest first, settled jobs included until pg-boss deletes them.
  for (;;) {
    const page = await boss.findJobs<unknown>(queue, { key: singletonKey, limit: PAGE, after });
    for (const job of page) if (LIVE.has(job.state)) live = job;
    if (page.length < PAGE) return live;
    after = page.at(-1)!.id;
  }
}

/** Polls one job until it settles. Throws JobWaitTimeout, or JobGone if the job was deleted. */
export async function waitForJob(
  boss: PgBoss,
  queue: QueueName,
  jobId: string,
  options: { timeoutMs: number; pollMs?: number; reportedTimeoutMs?: number },
): Promise<JobOutcome> {
  const deadline = Date.now() + options.timeoutMs;
  const pollMs = options.pollMs ?? 250;
  for (;;) {
    const [job] = await boss.findJobs<unknown>(queue, { id: jobId });
    if (!job) throw new JobGone(queue, jobId);
    if (SETTLED.has(job.state)) {
      return { jobId, state: job.state as SettledJobState, output: job.output ?? null };
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new JobWaitTimeout(queue, jobId, options.reportedTimeoutMs ?? options.timeoutMs);
    }
    await sleep(Math.min(pollMs, left));
  }
}
