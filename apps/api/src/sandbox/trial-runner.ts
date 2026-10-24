/**
 * Runs one trial container to completion. Stopping the container is the only
 * reliable way to end a Hermes run: the agent loop lives in a gateway daemon
 * that survives its client, and stopping the container ends every process in
 * its PID namespace.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineClient } from './engine-client.js';
import { FrameDecoder, LineSplitter } from './streams.js';
import { DEFAULT_DISK_LIMIT, measureTrialDisk, type DiskLimit } from './trial-files.js';
import { trialContainerBody, type TrialSpec } from './trial-spec.js';

export interface TrialOutcome {
  containerId: string;
  exitCode: number;
  oomKilled: boolean;
  /**
   * Why the container stopped: on its own, at the deadline, on cancel, for
   * writing too much to disk, or for printing too much output.
   */
  stopReason: 'exited' | 'deadline' | 'cancelled' | 'disk_limit' | 'output_limit';
  /** Which cap was passed, when stopReason is disk_limit or output_limit. */
  limitDetail?: string;
  /** Set when the output stream failed, so events may be missing. */
  logError?: string;
  durationMs: number;
}

export interface RunTrialOptions {
  engine: EngineClient;
  spec: TrialSpec;
  /** Wall-clock budget from start, after which the container is stopped. */
  deadlineMs: number;
  onStdoutLine: (line: string) => void;
  onStderr: (chunk: Buffer) => void;
  /** Called with the container id after create and before start, to record it. */
  onCreated?: (containerId: string) => void | Promise<void>;
  /** Aborting stops the container (cancel, lost lease, worker shutdown). */
  signal?: AbortSignal;
  /** Seconds between SIGTERM and SIGKILL. */
  stopGraceSeconds?: number;
  /**
   * Stops the trial when its home and workspace pass a size or file-count cap.
   * The trials volume is shared, so one runaway trial must not fill the disk
   * other trials and Postgres use. Polled, so a fast writer can overshoot by
   * what it writes in one interval.
   */
  diskLimit?: DiskLimit;
  /**
   * Stops the trial when its stdout and stderr together pass `maxBytes`, and
   * forwards nothing past it. The output is decoded in the worker's memory,
   * and what runs in the container is arbitrary code that can write to its
   * streams at pipe speed; without a cap it could exhaust the worker's heap.
   */
  outputLimit?: { maxBytes: number };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stops and removes every container left for a run, and confirms none is left.
 * A replacement attempt must not start while an earlier trial of the same run
 * could still be running: a missing heartbeat does not prove it stopped.
 */
export async function clearRun(
  engine: EngineClient,
  runId: string,
  timeoutMs = 60_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let removed = 0;
  for (;;) {
    const left = await engine.list([`hermes-evals.run=${runId}`]);
    if (left.length === 0) return removed;
    if (Date.now() > deadline)
      throw new Error(`containers of run ${runId} are still present after ${timeoutMs} ms`);
    for (const container of left) {
      await engine.kill(container.Id);
      await engine.remove(container.Id);
      removed += 1;
    }
    await sleep(250);
  }
}

/**
 * The first slot network with no live trial on it. A slot is a trial's private
 * network: two trials on one slot could reach each other. The worker's own
 * slot allocation (Phase 2) replaces this for experiments; development commands use it.
 */
export async function freeSlot(engine: EngineClient, slots: string[]): Promise<string> {
  const live = (await engine.list(['hermes-evals.role=trial'])).filter(
    (c) => c.State !== 'exited' && c.State !== 'dead',
  );
  const busy = new Set(live.map((c) => c.HostConfig?.NetworkMode));
  const slot = slots.find((s) => !busy.has(s));
  if (!slot) throw new Error(`every trial slot is in use (${slots.join(', ')})`);
  return slot;
}

/** Creates the attempt's home and workspace. Fails if they exist: every attempt starts fresh. */
export async function prepareTrialDirs(
  trialsDir: string,
  attemptId: string,
): Promise<{ root: string; home: string; workspace: string }> {
  const root = join(trialsDir, attemptId);
  await mkdir(root, { mode: 0o755 });
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home, { mode: 0o755 });
  await mkdir(workspace, { mode: 0o755 });
  return { root, home, workspace };
}

/** Deletes an attempt's directory tree (home and workspace); used after probes and by retention. */
export async function removeTrialDirs(trialsDir: string, attemptId: string): Promise<void> {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(attemptId))
    throw new Error(`not an attempt id: ${attemptId}`);
  await rm(join(trialsDir, attemptId), { recursive: true, force: true });
}

export async function runTrial(options: RunTrialOptions): Promise<TrialOutcome> {
  const { engine, spec } = options;
  const grace = options.stopGraceSeconds ?? 10;
  await clearRun(engine, spec.runId);
  const containerId = await engine.createContainer(spec.name, trialContainerBody(spec));
  try {
    await options.onCreated?.(containerId);
    // The wait must be in place before start, so a container that exits at once is not missed.
    const { registered, exited } = engine.waitForExit(containerId);
    await registered;
    await engine.start(containerId);
    const started = Date.now();

    // Every stop condition is armed before anything else is awaited: the deadline and the
    // watchdog must not depend on the container producing output.
    let stopReason: TrialOutcome['stopReason'] = 'exited';
    const stop = (reason: TrialOutcome['stopReason']) => {
      if (stopReason === 'exited') stopReason = reason;
      // A runaway writer gets no grace period: every second of it is more disk or memory.
      if (reason === 'disk_limit' || reason === 'output_limit')
        void engine.kill(containerId).catch(() => {});
      else void engine.stop(containerId, grace).catch(() => engine.kill(containerId));
    };
    const timer = setTimeout(() => stop('deadline'), options.deadlineMs);
    const onAbort = () => stop('cancelled');
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let finished = false;
    let limitDetail: string | undefined;
    let watchTimer: NodeJS.Timeout | undefined;
    const limit = options.diskLimit;
    const watch = () => {
      if (!limit) return;
      watchTimer = setTimeout(async () => {
        const usage = await measureTrialDisk(limit).catch(() => null);
        if (finished) return;
        if (usage?.exceeded) {
          limitDetail = usage.exceeded;
          stop('disk_limit');
        } else {
          watch();
        }
      }, limit.intervalMs ?? DEFAULT_DISK_LIMIT.intervalMs);
    };
    watch();

    const lines = new LineSplitter(options.onStdoutLine);
    const maxOutput = options.outputLimit?.maxBytes;
    let outputBytes = 0;
    let overOutput = false;
    /** Counts a stream's bytes against the output cap; past it, forwards nothing more. */
    const counted =
      (forward: (chunk: Buffer) => void) =>
      (chunk: Buffer): void => {
        if (maxOutput === undefined) return forward(chunk);
        if (overOutput) return;
        const room = maxOutput - outputBytes;
        if (chunk.length <= room) {
          outputBytes += chunk.length;
          return forward(chunk);
        }
        if (room > 0) forward(chunk.subarray(0, room));
        outputBytes = maxOutput;
        overOutput = true;
        limitDetail = `stdout and stderr passed ${maxOutput} bytes`;
        stop('output_limit');
      };
    const frames = new FrameDecoder(
      counted((chunk) => lines.push(chunk)),
      counted(options.onStderr),
    );
    const logs = engine.logs(containerId);
    const drained = logs.then(async (stream) => {
      for await (const chunk of stream) frames.push(chunk as Buffer);
      lines.end();
    });
    let logError: string | undefined;
    drained.catch((err: Error) => (logError = err.message));

    let exitCode: number;
    try {
      ({ StatusCode: exitCode } = await exited);
    } finally {
      finished = true;
      clearTimeout(timer);
      clearTimeout(watchTimer);
      options.signal?.removeEventListener('abort', onAbort);
    }
    // Logs end shortly after exit; do not wait forever on a stuck stream.
    await Promise.race([
      drained.catch(() => {}),
      sleep(5000).then(async () => (await logs.catch(() => null))?.destroy()),
    ]);
    const state = (await engine.inspect(containerId)).State;
    return {
      containerId,
      exitCode,
      oomKilled: state.OOMKilled,
      stopReason,
      ...(limitDetail ? { limitDetail } : {}),
      ...(logError ? { logError } : {}),
      durationMs: Date.now() - started,
    };
  } finally {
    await engine.remove(containerId);
  }
}
