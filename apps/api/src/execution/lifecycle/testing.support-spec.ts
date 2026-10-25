/**
 * What the lifecycle tests build on: an experiment seeded the way launch
 * stores it (provider custom against the scripted mock model, every run
 * queued), a workers row, a fake AttemptRunner that follows the runner's
 * contract, a queue that records what the lifecycle sends (PGlite has no
 * pg-boss schema), and short settings. Works on PGlite and node-postgres.
 * Test-only: the name ends in `spec.ts` so the build leaves it out, but not
 * in `.spec.ts`, so vitest does not run it.
 */
import { eq, sql } from 'drizzle-orm';
import type { PriceTable, SelfCheck, Tokens, VerificationEntry } from '@hermes-evals/shared';
import { blob, HERMES_REVISION, sha } from '../../../test/support/seed.js';
import {
  attempts,
  configurations,
  configurationVersions,
  experiments,
  mcpServers,
  mcpServerVersions,
  runs,
  suiteSources,
  suites,
  taskFiles,
  tasks,
  workers,
} from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import type { QueueName } from '../../queue/queues.js';
import {
  LeaseLostError,
  WorkerShutdownError,
  type AttemptEventInput,
  type AttemptOutcome,
  type AttemptPlan,
  type AttemptRunner,
  type AttemptSink,
} from '../contracts.js';
import { claimRun } from './claim.js';
import {
  DEFAULT_LIFECYCLE_SETTINGS,
  type ClaimedAttempt,
  type LifecycleLogger,
  type LifecycleQueue,
  type LifecycleSettings,
} from './types.js';

export { HERMES_REVISION, sha };

export const MOCK_MODEL = 'mock/scripted';
export const MOCK_BASE_URL = 'http://mock-model:8090/v1';
/** Priced at $1 per 1,000 input tokens, so tests can reach a spend ceiling with small numbers. */
export const PRICED_MODEL = 'mock/priced';

export const PRICE_TABLE: PriceTable = {
  sha256: sha('prices'),
  loaded_at: '2026-10-24T09:00:00.000Z',
  models: {
    [MOCK_MODEL]: { input_per_1m: 0, output_per_1m: 0, checked_at: '2026-10-24' },
    [PRICED_MODEL]: { input_per_1m: 1000, output_per_1m: 0, checked_at: '2026-10-24' },
  },
};

const SELF_CHECK: SelfCheck = {
  status: 'passed',
  ran_at: '2026-10-24T09:00:00.000Z',
  duration_ms: 5,
  results: [],
};

const VERIFICATION: VerificationEntry[] = [
  { key: 'answer', type: 'json_match', primary: true, params: { path: 'total' } },
];

export interface LifecycleSeedOptions {
  tasks?: number;
  repetitions?: number;
  concurrency?: number;
  spendCeilingUsd?: number | null;
  model?: string;
  /** Default 300. */
  timeBudgetS?: number;
  timeBudgetOverrideS?: number | null;
  /** MCP server version ids the candidate configuration uses. */
  candidateMcpServerVersionIds?: string[];
}

export interface LifecycleSeed {
  experimentId: string;
  /** In matrix order: task, configuration, repetition. */
  runIds: string[];
  taskIds: string[];
  baselineVersionId: string;
  candidateVersionId: string;
}

/** A frozen configuration version, created with its configuration as the configuration service does. */
export async function seedVersion(
  db: AppDb,
  name: string,
  options: { model: string; timeBudgetS: number; mcpServerVersionIds?: string[] },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [configuration] = await tx.insert(configurations).values({ name }).returning();
    const [version] = await tx
      .insert(configurationVersions)
      .values({
        configurationId: configuration!.id,
        version: 1,
        model: options.model,
        provider: 'custom',
        baseUrl: MOCK_BASE_URL,
        toolsets: ['terminal', 'file'],
        maxTurns: 20,
        timeBudgetS: options.timeBudgetS,
        mcpServerVersionIds: options.mcpServerVersionIds ?? [],
        configHash: sha(`config ${name}`),
        frozenAt: new Date(),
      })
      .returning({ id: configurationVersions.id });
    return version!.id;
  });
}

/** A stdio MCP server version whose env names are given as is (a reserved one is refused at setup). */
export async function seedStdioMcpServer(
  db: AppDb,
  name: string,
  envNames: string[],
): Promise<string> {
  return db.transaction(async (tx) => {
    const [server] = await tx.insert(mcpServers).values({ name }).returning();
    const [version] = await tx
      .insert(mcpServerVersions)
      .values({
        mcpServerId: server!.id,
        version: 1,
        transport: 'stdio',
        command: 'python3',
        args: ['-m', 'invoice_db'],
        envNames,
        definitionHash: sha(`mcp ${name}`),
      })
      .returning({ id: mcpServerVersions.id });
    return version!.id;
  });
}

let suiteSeq = 0;

/** Suite, tasks with one fixture each, baseline and candidate, and the experiment with every run queued. */
export async function seedLifecycle(
  db: AppDb,
  options: LifecycleSeedOptions = {},
): Promise<LifecycleSeed> {
  const taskCount = options.tasks ?? 1;
  const repetitions = options.repetitions ?? 1;
  const model = options.model ?? MOCK_MODEL;
  const timeBudgetS = options.timeBudgetS ?? 300;
  const path = `suite-${process.pid}-${++suiteSeq}`;
  const [suite] = await db
    .insert(suites)
    .values({
      sourcePath: path,
      versionNumber: 1,
      name: path,
      versionLabel: '1',
      contentHash: sha(`${path} content`),
      checkHash: sha(`${path} checks`),
      taskCount,
      validCount: taskCount,
    })
    .returning();
  await db.insert(suiteSources).values({
    path,
    name: path,
    currentSuiteId: suite!.id,
    lastOutcome: 'created',
  });
  const taskIds: string[] = [];
  for (let i = 0; i < taskCount; i += 1) {
    const key = `task_${i + 1}`;
    const [task] = await db
      .insert(tasks)
      .values({
        suiteId: suite!.id,
        key,
        versionNumber: 1,
        introducedInSuiteId: suite!.id,
        position: i,
        summary: `Task ${i + 1}`,
        prompt: `Total the invoices of task ${i + 1}. Reply with a fenced JSON block.`,
        limits: { max_turns: 20, run_budget_seconds: timeBudgetS, toolsets_needed: ['file'] },
        reference: { total: 1042 },
        verification: VERIFICATION,
        selfCheck: SELF_CHECK,
        valid: true,
        contentHash: sha(`${path} ${key}`),
      })
      .returning({ id: tasks.id });
    await db.insert(taskFiles).values({
      taskId: task!.id,
      path: 'fixtures/invoices.csv',
      kind: 'fixture',
      sha256: await blob(db, `invoices of ${key}`),
      size: Buffer.byteLength(`invoices of ${key}`),
    });
    taskIds.push(task!.id);
  }
  const baselineVersionId = await seedVersion(db, `${path}-baseline`, { model, timeBudgetS });
  const candidateVersionId = await seedVersion(db, `${path}-candidate`, {
    model,
    timeBudgetS,
    mcpServerVersionIds: options.candidateMcpServerVersionIds,
  });
  const [experiment] = await db
    .insert(experiments)
    .values({
      name: `Lifecycle ${path}`,
      suiteId: suite!.id,
      taskIds,
      baselineVersionId,
      candidateVersionIds: [candidateVersionId],
      repetitions,
      concurrency: options.concurrency ?? 3,
      spendCeilingUsd: options.spendCeilingUsd ?? null,
      timeBudgetOverrideS: options.timeBudgetOverrideS ?? null,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      priceTable: PRICE_TABLE,
    })
    .returning({ id: experiments.id });
  const matrix = taskIds.flatMap((taskId) =>
    [baselineVersionId, candidateVersionId].flatMap((configurationVersionId) =>
      Array.from({ length: repetitions }, (_, r) => ({
        experimentId: experiment!.id,
        taskId,
        configurationVersionId,
        repetition: r + 1,
      })),
    ),
  );
  const runRows = await db.insert(runs).values(matrix).returning({ id: runs.id });
  return {
    experimentId: experiment!.id,
    runIds: runRows.map((row) => row.id),
    taskIds,
    baselineVersionId,
    candidateVersionId,
  };
}

/** A live workers row, as presence inserts it. */
export async function seedWorker(db: AppDb, hostname = 'worker-1'): Promise<string> {
  const [worker] = await db
    .insert(workers)
    .values({
      hostname,
      concurrency: 3,
      slots: 4,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      toolsets: ['file', 'terminal'],
    })
    .returning({ id: workers.id });
  return worker!.id;
}

export const runRow = async (db: AppDb, runId: string) =>
  (await db.select().from(runs).where(eq(runs.id, runId)))[0]!;

export const experimentRow = async (db: AppDb, experimentId: string) =>
  (await db.select().from(experiments).where(eq(experiments.id, experimentId)))[0]!;

export const attemptsOf = (db: AppDb, runId: string) =>
  db.select().from(attempts).where(eq(attempts.runId, runId)).orderBy(attempts.number);

export const workerInFlight = async (db: AppDb, workerId: string) =>
  (await db.select({ n: workers.inFlight }).from(workers).where(eq(workers.id, workerId)))[0]!.n;

/** Claims attempt `attempt` of a queued run the way the handler does; throws unless it was claimed. */
export async function claimAttempt(
  db: AppDb,
  runId: string,
  workerId: string,
  options: { attempt?: number; hostId?: string; queue?: LifecycleQueue } = {},
): Promise<ClaimedAttempt> {
  const attempt = options.attempt ?? 1;
  const outcome = await db.transaction((tx) =>
    claimRun(tx, {
      job: {
        id: 'job',
        data: { runId, attempt, trigger: attempt === 1 ? 'initial' : 'user_retry' },
      },
      workerId,
      hostId: options.hostId ?? 'FAKE:DAEMON',
      hermesRevision: HERMES_REVISION,
      readiness: { ready: true, status: 'configured', reason: null },
      queue: options.queue ?? new RecordingQueue(),
      settings: { leaseSeconds: 60, admissionDelayS: { min: 1, max: 1 } },
    }),
  );
  if (outcome.kind !== 'claimed') throw new Error(`run ${runId} was not claimed: ${outcome.kind}`);
  return outcome.attempt;
}

/** Sets lease_expires_at in the past, as a worker that stopped renewing leaves it. */
export async function expireLease(db: AppDb, attemptId: string): Promise<void> {
  await db
    .update(attempts)
    .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
    .where(eq(attempts.id, attemptId));
}

// ---------------------------------------------------------------- outcomes

export const TOKENS: Tokens = {
  input: 1000,
  output: 200,
  total: 1200,
  cache_read: 0,
  cache_write: 0,
};

const baseOutcome = (): AttemptOutcome => ({
  status: 'executed',
  category: null,
  errorMessage: null,
  exitCode: 0,
  finalText: 'Done.\n```json\n{"total": 1042}\n```',
  sessionId: 'session-1',
  tokens: TOKENS,
  durationMs: 4200,
  stderrTail: null,
  redactions: 0,
  finalEvents: [],
  artifacts: [],
  egressUsage: null,
});

export const outcomes = {
  executed: (extra: Partial<AttemptOutcome> = {}): AttemptOutcome => ({
    ...baseOutcome(),
    ...extra,
  }),
  error: (
    category: NonNullable<AttemptOutcome['category']>,
    extra: Partial<AttemptOutcome> = {},
  ): AttemptOutcome => ({
    ...baseOutcome(),
    status: 'execution_error',
    category,
    errorMessage: `failed: ${category}`,
    exitCode: 1,
    finalText: null,
    stderrTail: `Error: ${category} went wrong\nmore detail`,
    ...extra,
  }),
  cancelled: (extra: Partial<AttemptOutcome> = {}): AttemptOutcome => ({
    ...baseOutcome(),
    status: 'cancelled',
    exitCode: 143,
    finalText: null,
    tokens: null,
    ...extra,
  }),
};

/** A collected platform event, as the runner writes at the end. */
export const collectedEvent = (ts = Date.now()): AttemptEventInput => ({
  ts,
  type: 'platform',
  payload: { type: 'platform', subtype: 'collected', files: 1 },
});

export const textEvent = (text: string, ts = Date.now()): AttemptEventInput => ({
  ts,
  type: 'text',
  payload: { type: 'text', text },
});

// ---------------------------------------------------------------- runner

export interface FakeRunContext {
  plan: AttemptPlan;
  sink: AttemptSink;
  signal: AbortSignal;
  /** 1 for the first run() call of this runner. */
  call: number;
}

const isHandBack = (reason: unknown): boolean =>
  reason instanceof LeaseLostError || reason instanceof WorkerShutdownError;

/**
 * Waits until the signal aborts, then does what the real runner does: a lost
 * lease or shutdown is thrown, anything else (a cancel) ends as cancelled.
 */
export function untilAborted(signal: AbortSignal): Promise<AttemptOutcome> {
  return new Promise((resolve, reject) => {
    const settle = () => {
      if (isHandBack(signal.reason)) reject(signal.reason as Error);
      else resolve(outcomes.cancelled());
    };
    if (signal.aborted) settle();
    else signal.addEventListener('abort', settle, { once: true });
  });
}

/**
 * An AttemptRunner that follows the contract (throws only a hand-back
 * reason) and does what the script says. The default executes at once.
 */
export class FakeRunner implements AttemptRunner {
  readonly plans: AttemptPlan[] = [];
  /** run() calls in progress now, and the most at once. */
  running = 0;
  maxRunning = 0;

  constructor(
    private readonly script: (ctx: FakeRunContext) => Promise<AttemptOutcome> = async () =>
      outcomes.executed(),
  ) {}

  async run(plan: AttemptPlan, sink: AttemptSink, signal: AbortSignal): Promise<AttemptOutcome> {
    if (signal.aborted && isHandBack(signal.reason)) throw signal.reason;
    this.plans.push(plan);
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      return await this.script({ plan, sink, signal, call: this.plans.length });
    } finally {
      this.running -= 1;
    }
  }
}

// ---------------------------------------------------------------- queue, logger, settings

export interface QueueCall {
  op: 'defer' | 'send' | 'sendMany';
  queue: QueueName;
  data: object;
  singletonKey: string;
  startAfterSeconds?: number;
}

/** A LifecycleQueue that records each call; send always creates a job. */
export class RecordingQueue implements LifecycleQueue {
  readonly calls: QueueCall[] = [];
  private seq = 0;

  defer(
    _tx: AppTx,
    job: { id: string; data: object },
    options: { singletonKey: string; startAfterSeconds: number },
  ): Promise<void> {
    this.calls.push({ op: 'defer', queue: 'execute-run', data: job.data, ...options });
    return Promise.resolve();
  }

  send(
    _tx: AppTx,
    queue: QueueName,
    data: object,
    options: { singletonKey: string; startAfterSeconds?: number },
  ): Promise<string | null> {
    this.calls.push({ op: 'send', queue, data, ...options });
    return Promise.resolve(`job-${++this.seq}`);
  }

  sendMany(
    _tx: AppTx,
    queue: QueueName,
    jobs: ReadonlyArray<{ data: object; singletonKey: string }>,
  ): Promise<number> {
    for (const job of jobs) this.calls.push({ op: 'sendMany', queue, ...job });
    return Promise.resolve(jobs.length);
  }

  of(op: QueueCall['op'], queue?: QueueName): QueueCall[] {
    return this.calls.filter(
      (call) => call.op === op && (queue === undefined || call.queue === queue),
    );
  }
}

/** A logger that keeps what it was told, for the odd assertion. */
export function memoryLogger(): LifecycleLogger & {
  lines: Array<{ level: string; msg: string; obj: object }>;
} {
  const lines: Array<{ level: string; msg: string; obj: object }> = [];
  const at = (level: string) => (obj: object, msg: string) => lines.push({ level, msg, obj });
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

export const FAST_SETTINGS: LifecycleSettings = {
  ...DEFAULT_LIFECYCLE_SETTINGS,
  leaseSeconds: 30,
  heartbeatIntervalMs: 200,
  cancelPollIntervalMs: 100,
  admissionDelayS: { min: 1, max: 1 },
  autoRetryDelayS: 1,
  pollingIntervalSeconds: 0.5,
  finishRetryDelaysMs: [10, 10],
  finishRetryWindowMs: 200,
  stopTimeoutMs: 5_000,
  recoveryIntervalMs: 60_000,
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `check` resolves a value other than undefined, or fails after `timeoutMs`. */
export async function waitFor<T>(
  check: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(100);
  }
}
